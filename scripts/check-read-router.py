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
        candidates = glob.glob(".semla-sessions/*.jsonl")
        if not candidates:
            print("no session files in .semla-sessions/", file=sys.stderr)
            return 2
        path = max(candidates, key=os.path.getmtime)

    print(f"session: {path}")

    total = compressed = missed = 0
    saved_from = saved_to = 0

    with open(path, encoding="utf8") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") != "message":
                continue
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
    if not compressed:
        print("\nINCONCLUSIVE: nothing crossed a threshold. Read a bigger file.")
        return 3
    print("\nPASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
