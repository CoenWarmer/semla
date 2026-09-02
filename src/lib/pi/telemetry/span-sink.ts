/**
 * Where a session's spans are recorded.
 *
 * This is a `TelemetryContext` — pi's own interface — so the same object can be
 * handed to pi's `startHarnessSpan`/`startAiSpan` and to Semla's own
 * instrumentation, and the two produce one tree. `TelemetrySpan` extends
 * `TelemetryContext`, which is how nesting works: a child is started from its
 * parent rather than from an ambient context, so there is no async-local state
 * to get wrong.
 *
 * pi ships `InMemoryTelemetryContext`, and it is not enough here: it records
 * structure — id, parent, attributes, events, an end *sequence* — but no wall
 * time. A waterfall needs durations, so this records them.
 *
 * **It must never change what the program does.** A span that is dropped
 * because the cap was reached, or whose attributes are redacted, still runs its
 * callback and still propagates the result or the exception unchanged.
 * Telemetry that can alter a turn is worse than no telemetry, and this is the
 * property the tests are mostly about.
 *
 * Decisions this encodes, from docs/plans/agent-telemetry.md §8: sensitive
 * attributes are kept by default and dropping them is a switch (§8.1); there is
 * no cap by default, and the count is kept regardless so a run that ever hurts
 * arrives with the number already in it (§8.3).
 */

import { createHash } from "node:crypto";

import type {
  SpanAttributes,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetrySpan,
} from "@mariozechner/pi-agent-core";

/** A span as recorded, with the timing pi's in-memory context leaves out. */
export type RecordedSpan = {
  attributes: SpanAttributes;
  /** Null while the span is still open. */
  endTimeMs: number | null;
  events: readonly RecordedSpanEvent[];
  name: string;
  parentSpanId: string | null;
  spanId: string;
  startTimeMs: number;
  status: SpanStatus;
  traceId: string;
};

export type RecordedSpanEvent = {
  attributes: SpanAttributes;
  name: string;
  timeMs: number;
};

export type SpanSinkCounts = {
  /** Spans not recorded because the cap was reached. */
  dropped: number;
  /** Recorded but not yet ended — a live turn, or one that never closed. */
  open: number;
  recorded: number;
};

export type SpanSinkOptions = {
  /**
   * Attribute keys to drop when `sensitive` is "drop", as
   * `<span name>/<attribute>`. Build one with `sensitiveAttributeKeys`.
   */
  sensitiveKeys?: ReadonlySet<string>;
  /**
   * Ceiling on recorded spans. `Infinity` by default (§8.3) — present so a cap
   * is a config change rather than a redesign.
   */
  maxSpans?: number;
  /** Injectable so tests are not timing-dependent. */
  now?: () => number;
  /**
   * What to do with attributes the schema marks `sensitive`. "keep" today
   * (§8.1); prompts and tool arguments are recorded, and persisted traces
   * contain them.
   */
  sensitive?: "drop" | "keep";
};

/**
 * A span opened and closed explicitly, for instrumentation driven by paired
 * events rather than by wrapping a call.
 *
 * pi's `startSpan` scopes a span to a callback, which is right when the work is
 * a function. It cannot express the workflow subsystem's shape: a phase begins
 * at one callback and ends at another, an agent's start and end arrive
 * separately, and a run outlives the turn that started it. Contorting that into
 * a callback would mean holding a deferred promise open across events — a leak
 * waiting to happen — or editing the vendored `agent()` body, which has retries
 * and four exit paths.
 *
 * `close()` is idempotent, because paired events are only as reliable as the
 * code emitting them.
 */
export type OpenSpan = {
  addEvent: (name: string, attributes?: SpanAttributes) => void;
  /** Idempotent. */
  close: (status?: SpanStatus) => void;
  setAttributes: (attributes: SpanAttributes) => void;
  readonly spanId: string;
};

export type SpanSink = TelemetryContext & {
  readonly counts: SpanSinkCounts;
  /**
   * Open a span without scoping it to a call. The caller owns closing it; see
   * `OpenSpan`.
   */
  openSpan: (
    options: SpanOptions & { parentSpanId?: string | null },
  ) => OpenSpan;
  /** Snapshots in start order. Safe to serialise. */
  spans: () => readonly RecordedSpan[];
  readonly traceId: string;
};

const hex = (input: string, length: number): string =>
  createHash("sha256").update(input).digest("hex").slice(0, length);

/**
 * The trace id for a session, derived rather than random.
 *
 * A reload has to land on the same trace, and the session id is the only thing
 * both sides already agree on. 32 hex characters, which is what OTel and the
 * waterfall's `makeTraceId` both want.
 */
export const traceIdForSession = (sessionId: string): string =>
  hex(`semla.session:${sessionId}`, 32);

/**
 * Every attribute any of these schemas marks `sensitive`, as
 * `<span name>/<attribute>`.
 *
 * Pulled from the schemas rather than listed here so that pi adding a sensitive
 * attribute in a release is respected without a change on this side — which is
 * the whole reason the metadata is in the schema.
 */
export const sensitiveAttributeKeys = (
  schemas: readonly { spans: Record<string, unknown> }[],
): ReadonlySet<string> => {
  const keys = new Set<string>();

  for (const schema of schemas) {
    for (const [spanName, definition] of Object.entries(schema.spans)) {
      const span = definition as {
        endAttributes?: Record<string, { sensitive?: boolean }>;
        startAttributes?: Record<string, { sensitive?: boolean }>;
      };

      for (const group of [span.startAttributes, span.endAttributes]) {
        for (const [attribute, meta] of Object.entries(group ?? {})) {
          if (meta.sensitive) keys.add(`${spanName}/${attribute}`);
        }
      }
    }
  }

  return keys;
};

export const createSpanSink = (
  sessionId: string,
  options: SpanSinkOptions = {},
): SpanSink => {
  const {
    maxSpans = Number.POSITIVE_INFINITY,
    now = () => Date.now(),
    sensitive = "keep",
    sensitiveKeys = new Set<string>(),
  } = options;

  const traceId = traceIdForSession(sessionId);
  const recorded: RecordedSpan[] = [];
  const counts: SpanSinkCounts = { dropped: 0, open: 0, recorded: 0 };
  let sequence = 0;

  const filterAttributes = (
    spanName: string,
    attributes: SpanAttributes | undefined,
  ): SpanAttributes => {
    if (!attributes) return {};
    if (sensitive === "keep") return { ...attributes };

    const kept: SpanAttributes = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (!sensitiveKeys.has(`${spanName}/${key}`)) kept[key] = value;
    }
    return kept;
  };

  /**
   * The one primitive. Everything else is expressed in terms of it, so there
   * is a single place where recording, the cap and redaction happen.
   *
   * `record` is null for a span the cap refused. The returned handle still
   * works — its methods no-op — so a caller never has to ask whether the span
   * was kept.
   */
  const open = (
    parentSpanId: string | null,
    { attributes, name }: SpanOptions,
  ) => {
    const spanId = hex(`${traceId}:${sequence++}`, 16);
    const record: RecordedSpan | null =
      recorded.length < maxSpans
        ? {
            attributes: filterAttributes(name, attributes),
            endTimeMs: null,
            events: [],
            name,
            parentSpanId,
            spanId,
            startTimeMs: now(),
            status: { status: "ok" },
            traceId,
          }
        : null;

    if (record) {
      recorded.push(record);
      counts.recorded += 1;
      counts.open += 1;
    } else {
      // Counted even though it is not kept: the point of having no cap by
      // default is that if one is ever wanted, the number that justifies it is
      // already here.
      counts.dropped += 1;
    }

    const addEvent = (eventName: string, eventAttributes?: SpanAttributes) => {
      if (!record) return;
      record.events = [
        ...record.events,
        {
          attributes: filterAttributes(name, eventAttributes),
          name: eventName,
          timeMs: now(),
        },
      ];
    };

    const setAttributes = (next: SpanAttributes) => {
      if (!record) return;
      record.attributes = {
        ...record.attributes,
        ...filterAttributes(name, next),
      };
    };

    const setStatus = (status: SpanStatus) => {
      if (record) record.status = status;
    };

    const close = (status?: SpanStatus) => {
      if (status) setStatus(status);
      // Idempotent: a second close must not double-count `open` or move the
      // end time, because paired events are only as reliable as their emitter.
      if (!record || record.endTimeMs !== null) return;
      record.endTimeMs = now();
      counts.open -= 1;
    };

    return { addEvent, close, record, setAttributes, setStatus, spanId };
  };

  /**
   * The callback-scoped form pi uses. Children are started from the span, not
   * from ambient state, so a dropped span still parents its children by id.
   */
  const start = async <T>(
    parentSpanId: string | null,
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> => {
    const handle = open(parentSpanId, options);

    const span: TelemetrySpan = {
      addEvent: handle.addEvent,
      setAttributes: handle.setAttributes,
      setStatus: handle.setStatus,
      startSpan: (childOptions, childCallback) =>
        start(handle.spanId, childOptions, childCallback),
    };

    try {
      return await callback(span);
    } catch (error) {
      // Recorded, then rethrown untouched: a span must not swallow the failure
      // it is describing.
      if (handle.record && handle.record.status.status === "ok") {
        handle.setStatus({
          status: "error",
          error:
            error instanceof Error
              ? { message: error.message, name: error.name }
              : { message: String(error), name: "Error" },
        });
      }
      throw error;
    } finally {
      handle.close();
    }
  };

  return {
    counts,
    openSpan: ({ parentSpanId = null, ...spanOptions }) => {
      const { addEvent, close, setAttributes, spanId } = open(
        parentSpanId,
        spanOptions,
      );
      return { addEvent, close, setAttributes, spanId };
    },
    spans: () =>
      recorded.map((span) => ({ ...span, events: [...span.events] })),
    startSpan: (spanOptions, callback) => start(null, spanOptions, callback),
    traceId,
  };
};
