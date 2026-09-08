#!/usr/bin/env python3
"""Report whether read-router actually compressed anything in a session.

Reads a session JSONL and classifies every toolResult as compressed, missed
(over threshold but untouched), or irrelevant. Exits non-zero unless at least
one result was compressed and none were missed.

Why this exists rather than eyeballing the transcript: read-router fails open
by design, so a session where it never ran looks identical to one where it had
nothing to do. Both simply contain uncompressed results. The only way to tell
them apart is to count results that *crossed a threshold* and were left alone
anyway — which is what `missed` is, and what a grep for "Compressed:" cannot
tell you. That grep is also actively misleading in this repository: the string
appears in read-router's own source and tests, so reading a session that
happens to include those files reports hits that are not compressions.

Usage:
    python3 scripts/check-read-router.py [session.jsonl]

With no argument it picks the most recently modified file in .semla-sessions/.
Thresholds mirror the defaults in src/lib/pi/extensions/read-router.ts; pass
--lines/--chars if the session was run with non-default settings.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time

TAG = "[Compressed:"


def over_threshold(tool: str, lines: int, chars: int, max_lines: int, max_chars: int) -> bool:
    """Mirror of shouldCompress()'s per-tool policy, minus the exclusions."""
    if tool == "read":
        return lines > max_lines
    if tool == "bash":
        return chars > max_chars
    if tool in ("grep", "find"):
        return lines > 40
    if tool == "ls":
        return lines > 80
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("session", nargs="?")
    parser.add_argument("--lines", type=int, default=300)
    parser.add_argument("--chars", type=int, default=3000)
    args = parser.parse_args()

    path = args.session
    if not path:
        # `*.spans.jsonl` is a telemetry sidecar written alongside every
        # transcript, and it is *newer* than the transcript it belongs to. Left
        # in, it wins the mtime race, parses cleanly, contains no toolResults,
        # and reports INCONCLUSIVE — a real session read as an empty one.
        candidates = [
            candidate
            for candidate in glob.glob(".semla-sessions/*.jsonl")
            if not candidate.endswith(".spans.jsonl")
        ]
        # The current session is the worst possible choice and the most likely
        # one: it is being appended to as this runs, so it always wins the
        # mtime race. It is also the session that cannot test a newly added
        # extension, because extensions load once at session start — which is
        # exactly how this extension's original failure was first mistaken for
        # a bug in the extension rather than in the test setup.
        current = os.environ.get("PI_SESSION_ID")
        if current:
            candidates = [c for c in candidates if current not in c]
        if not candidates:
            print("no other session files in .semla-sessions/", file=sys.stderr)
            return 2
        candidates.sort(key=os.path.getmtime, reverse=True)
        path = candidates[0]
        # PI_SESSION_ID is only set *inside* an agent session, so a run from an
        # ordinary terminal cannot filter the live session out that way — and
        # the live session is the newest file. Show the alternatives and flag a
        # file still being written, so a wrong pick is visible rather than
        # reported as a result.
        age = time.time() - os.path.getmtime(path)
        if age < 120:
            print(
                f"warning: {path} was modified {int(age)}s ago and may be the "
                "live session. Extensions load at session start, so the session "
                "you are talking in cannot test a newly added one. Pass an "
                "explicit path if this is wrong."
            )
            for other in candidates[1:4]:
                print(f"  other recent: {other}")

    print(f"session: {path}")

    total = compressed = missed = 0
    messages = 0
    saved_from = saved_to = 0

    with open(path, encoding="utf8") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") != "message":
                continue
            messages += 1
            message = entry.get("message") or entry
            if message.get("role") != "toolResult":
                continue

            text = "".join(
                part.get("text", "")
                for part in (message.get("content") or [])
                if isinstance(part, dict) and part.get("type") == "text"
            )
            tool = message.get("toolName") or "?"
            lines = len(text.split("\n"))
            chars = len(text)
            total += 1

            # Only a result whose text *starts* with the tag is a compression.
            # A file containing the tag mid-body is source code, not output.
            is_compressed = text.startswith(TAG)
            if is_compressed:
                compressed += 1
                # "[Compressed: N chars → via read-router]"
                try:
                    original = int(text[len(TAG):text.index("chars")].strip())
                except ValueError:
                    original = 0
                saved_from += original
                saved_to += chars
                print(f"  {tool:6} {original:7} -> {chars:6} chars  COMPRESSED")
            elif over_threshold(tool, lines, chars, args.lines, args.chars):
                missed += 1
                print(f"  {tool:6} lines={lines:5} chars={chars:7}  MISSED")

    print(f"\ntoolResults={total} compressed={compressed} missed={missed}")
    if compressed:
        pct = round((1 - saved_to / saved_from) * 100) if saved_from else 0
        print(f"reduction: {saved_from} -> {saved_to} chars ({pct}%)")

    if missed:
        print("\nFAIL: results crossed a threshold and were not compressed.")
        return 1
    # A file with no messages at all is the wrong file, not a quiet session.
    # Distinguished from INCONCLUSIVE because the remedy is different: pass the
    # right path, rather than run a bigger prompt.
    if not messages:
        print(
            "\nWRONG FILE: no messages found. Pass a session transcript, "
            "not a .spans.jsonl sidecar or a .json summary."
        )
        return 2
    if not compressed:
        print("\nINCONCLUSIVE: nothing crossed a threshold. Read a bigger file.")
        return 3
    print("\nPASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
