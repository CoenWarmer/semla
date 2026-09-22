import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { SessionMessagesResult } from "@/hooks/use-session-messages";
import { applyTurnEffects } from "@/lib/session/turn-stream-effects";
import type { TurnStreamEffect } from "@/lib/session/turn-stream-reducer";
import {
  sessionAgentConsoleKey,
  sessionLiveAccessesKey,
  sessionLiveToolCallsKey,
} from "@/lib/session/session-live-state";
import {
  SESSION_STATUS_KEY,
  sessionStatusKey,
  type SessionStatus,
  type SingleSessionStatus,
} from "@/lib/session/session-status";
import { sessionSpansKey } from "@/lib/trace/session-spans";

const sessionId = "s1";
const messagesKey = ["session-messages", sessionId, null] as const;

function dispatch(
  client: QueryClient,
  effects: TurnStreamEffect[],
  options?: { isReconnect?: boolean },
) {
  applyTurnEffects(client, sessionId, messagesKey, effects, options);
}

describe("applyTurnEffects", () => {
  it("appends the optimistic reconnect message only while reconnecting", () => {
    const client = new QueryClient();
    client.setQueryData<SessionMessagesResult>(messagesKey, {
      contextWindow: null,
      messages: [],
      toolCalls: [],
    });

    dispatch(
      client,
      [{ text: "hello from a live turn", type: "append-optimistic-user-message" }],
      { isReconnect: false },
    );
    expect(
      client.getQueryData<SessionMessagesResult>(messagesKey)?.messages,
    ).toEqual([]);

    dispatch(
      client,
      [{ text: "hello from a live turn", type: "append-optimistic-user-message" }],
      { isReconnect: true },
    );
    const messages =
      client.getQueryData<SessionMessagesResult>(messagesKey)?.messages;
    expect(messages).toHaveLength(1);
    expect(messages?.[0]?.text).toBe("hello from a live turn");
    expect(messages?.[0]?.role).toBe("user");
  });

  it("attaches wiki-recall content to the last user message", () => {
    const client = new QueryClient();
    client.setQueryData<SessionMessagesResult>(messagesKey, {
      contextWindow: null,
      messages: [
        { createdAt: "t", id: "m1", role: "user", text: "hi" },
      ],
      toolCalls: [],
    });

    dispatch(client, [{ content: "recalled page", type: "apply-wiki-recall" }]);

    const messages =
      client.getQueryData<SessionMessagesResult>(messagesKey)?.messages;
    expect(messages?.[0]?.wikiRecall).toBe("recalled page");
  });

  it("does nothing for wiki-recall when the last message is not from the user", () => {
    const client = new QueryClient();
    client.setQueryData<SessionMessagesResult>(messagesKey, {
      contextWindow: null,
      messages: [
        { createdAt: "t", id: "m1", role: "assistant", text: "hi" },
      ],
      toolCalls: [],
    });

    dispatch(client, [{ content: "recalled page", type: "apply-wiki-recall" }]);

    const messages =
      client.getQueryData<SessionMessagesResult>(messagesKey)?.messages;
    expect(messages?.[0]?.wikiRecall).toBeUndefined();
  });

  it("caches a live tool call under the session's key", () => {
    const client = new QueryClient();

    dispatch(client, [
      {
        event: {
          at: "2024-01-01T00:00:00.000Z",
          params: {},
          roundId: "round-1",
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-start",
        },
        type: "cache-live-tool-call",
      },
    ]);

    const calls = client.getQueryData(sessionLiveToolCallsKey(sessionId));
    expect(calls).toEqual([
      expect.objectContaining({ id: "call-1", name: "bash" }),
    ]);
  });

  it("pushes bash console entries under the session's console key", () => {
    const client = new QueryClient();

    dispatch(client, [
      {
        at: "2024-01-01T00:00:00.000Z",
        command: "ls -la",
        toolCallId: "call-1",
        type: "console-bash-start",
      },
    ]);
    dispatch(client, [
      {
        output: "file.txt\n",
        toolCallId: "call-1",
        type: "console-bash-output",
      },
    ]);
    dispatch(client, [
      {
        at: "2024-01-01T00:00:01.000Z",
        isError: false,
        toolCallId: "call-1",
        type: "console-bash-end",
      },
    ]);

    const entries = client.getQueryData(sessionAgentConsoleKey(sessionId));
    expect(entries).toEqual([
      expect.objectContaining({
        command: "ls -la",
        output: "file.txt\n",
        toolCallId: "call-1",
      }),
    ]);
  });

  it("merges spans into the session's spans cache, deduped by id", () => {
    const client = new QueryClient();

    dispatch(client, [
      {
        spans: [
          { name: "first", spanId: "sp-1", startedAt: 1 } as never,
        ],
        type: "cache-spans",
      },
    ]);
    dispatch(client, [
      {
        spans: [
          { name: "first-updated", spanId: "sp-1", startedAt: 1 } as never,
        ],
        type: "cache-spans",
      },
    ]);

    const spans = client.getQueryData(sessionSpansKey(sessionId)) as Array<{
      name: string;
      spanId: string;
    }>;
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("first-updated");
  });

  it("appends file accesses onto the session's live-access cache", () => {
    const client = new QueryClient();

    dispatch(client, [
      {
        accesses: [{ path: "a.ts" } as never],
        type: "cache-file-access",
      },
    ]);
    dispatch(client, [
      {
        accesses: [{ path: "b.ts" } as never],
        type: "cache-file-access",
      },
    ]);

    const accesses = client.getQueryData(
      sessionLiveAccessesKey(sessionId),
    ) as Array<{ path: string }>;
    expect(accesses.map((a) => a.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("writes isRunning to both the single-session cache and the list cache", () => {
    const client = new QueryClient();
    client.setQueryData<SingleSessionStatus>(sessionStatusKey(sessionId), {
      exists: true,
      isRunning: false,
    } as SingleSessionStatus);
    client.setQueryData<SessionStatus[]>(SESSION_STATUS_KEY, [
      { hasRun: true, id: sessionId, isRunning: false } as SessionStatus,
    ]);

    dispatch(client, [{ isRunning: true, type: "cache-session-status" }]);

    expect(
      client.getQueryData<SingleSessionStatus>(sessionStatusKey(sessionId))
        ?.isRunning,
    ).toBe(true);
    expect(
      client.getQueryData<SessionStatus[]>(SESSION_STATUS_KEY)?.[0]?.isRunning,
    ).toBe(true);
  });

  it("invalidates the session-status list on a title update", async () => {
    const client = new QueryClient();
    let calls = 0;
    client.setQueryDefaults(SESSION_STATUS_KEY, {
      queryFn: () => {
        calls++;
        return [];
      },
    });
    await client.prefetchQuery({ queryKey: SESSION_STATUS_KEY });
    expect(calls).toBe(1);

    dispatch(client, [{ title: "New title", type: "invalidate-title" }]);
    await client.getQueryCache().find({ queryKey: SESSION_STATUS_KEY })
      ?.fetch();

    expect(calls).toBe(2);
  });
});
