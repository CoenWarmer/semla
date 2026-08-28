type StreamEvent = unknown;

interface SessionStream {
  buffer: StreamEvent[];
  subscribers: Set<(event: StreamEvent) => void>;
}

const streams = new Map<string, SessionStream>();

export const openSessionStream = (sessionId: string): void => {
  streams.set(sessionId, { buffer: [], subscribers: new Set() });
};

export const publishToSessionStream = (sessionId: string, event: StreamEvent): void => {
  const stream = streams.get(sessionId);
  if (!stream) return;
  stream.buffer.push(event);
  for (const sub of stream.subscribers) sub(event);
};

export const subscribeToSessionStream = (
  sessionId: string,
  onEvent: (event: StreamEvent) => void,
): { unsubscribe: () => void; isActive: boolean } => {
  const stream = streams.get(sessionId);
  if (!stream) return { unsubscribe: () => {}, isActive: false };
  for (const event of stream.buffer) onEvent(event);
  stream.subscribers.add(onEvent);
  return {
    unsubscribe: () => {
      stream.subscribers.delete(onEvent);
    },
    isActive: true,
  };
};

export const isSessionStreamActive = (sessionId: string): boolean =>
  streams.has(sessionId);

export const closeSessionStream = (sessionId: string): void => {
  streams.delete(sessionId);
};
