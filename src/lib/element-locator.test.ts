/**
 * `componentName` and `nameChainBetween` against fixture objects shaped like
 * real fibers, rather than a real React tree — the point of both functions is
 * reading `fiber.type`/`fiber.return` structurally, which a plain object
 * reproduces exactly, and this repository has no DOM/React test environment
 * to mount a real tree in anyway.
 *
 * The `$$typeof` symbols mirror the well-known, process-wide ones
 * `Symbol.for("react.memo")` / `Symbol.for("react.lazy")` register — the same
 * ones react's own dev build uses, and the reason component-name.ts references
 * them directly rather than importing from `react`.
 */
import { describe, expect, it } from "vitest";

import { componentName, nameChainBetween, type Fiber } from "./element-locator.ts";

function Plain() {}
Plain.displayName = undefined;

function NamedFunction() {}

const REACT_MEMO_TYPE = Symbol.for("react.memo");
const REACT_LAZY_TYPE = Symbol.for("react.lazy");

describe("componentName", () => {
  it("reads a plain function component's name", () => {
    const fiber: Fiber = { type: NamedFunction };
    expect(componentName(fiber)).toBe("NamedFunction");
  });

  it("prefers displayName over the function's own name", () => {
    function Inner() {}
    (Inner as { displayName?: string }).displayName = "PublicName";
    expect(componentName({ type: Inner })).toBe("PublicName");
  });

  it("reads a forwardRef component's name from its render function", () => {
    function render() {}
    (render as { displayName?: string }).displayName = "Field";
    const fiber: Fiber = { type: { render } };
    expect(componentName(fiber)).toBe("Field");
  });

  it("unwraps a memo-wrapped function component", () => {
    function Memoized() {}
    const fiber: Fiber = {
      type: { $$typeof: REACT_MEMO_TYPE, type: Memoized },
    };
    expect(componentName(fiber)).toBe("Memoized");
  });

  it("unwraps a memo-wrapped forwardRef component", () => {
    function render() {}
    (render as { displayName?: string }).displayName = "MemoField";
    const fiber: Fiber = {
      type: { $$typeof: REACT_MEMO_TYPE, type: { render } },
    };
    expect(componentName(fiber)).toBe("MemoField");
  });

  it("prefers memo's own displayName when it has one", () => {
    function Inner() {}
    const fiber: Fiber = {
      type: { $$typeof: REACT_MEMO_TYPE, displayName: "Outer", type: Inner },
    };
    expect(componentName(fiber)).toBe("Outer");
  });

  it("returns null for a lazy-wrapped component rather than throwing", () => {
    const fiber: Fiber = { type: { $$typeof: REACT_LAZY_TYPE } };
    expect(componentName(fiber)).toBeNull();
  });

  it("returns null for a host element with a string type", () => {
    expect(componentName({ type: "div" })).toBeNull();
  });

  it("returns null when there is no name at all", () => {
    const fns: Array<() => void> = [];
    fns.push(function () {});
    // Pushing an anonymous function expression into an array, rather than
    // assigning it to a const, is what keeps V8 from inferring a name for
    // it — an assigned anonymous function's `.name` is the binding's name.
    expect(componentName({ type: fns[0] })).toBeNull();
  });
});

describe("nameChainBetween", () => {
  it("collects names outermost-first, excluding the boundary", () => {
    function A() {}
    function B() {}
    function C() {}

    const boundary: Fiber = { type: A };
    const middle: Fiber = { return: boundary, type: B };
    const leaf: Fiber = { return: middle, type: C };

    expect(nameChainBetween(boundary, leaf)).toEqual(["B", "C"]);
  });

  it("skips a fiber componentName cannot classify, without breaking the chain", () => {
    function A() {}
    function C() {}

    const boundary: Fiber = { type: A };
    // A host element (string type) between the boundary and the leaf — a
    // <div> wrapping the component that was actually clicked.
    const host: Fiber = { return: boundary, type: "div" };
    const leaf: Fiber = { return: host, type: C };

    expect(nameChainBetween(boundary, leaf)).toEqual(["C"]);
  });

  it("returns an empty chain when to and from are the same fiber", () => {
    const boundary: Fiber = { type: () => null };
    expect(nameChainBetween(boundary, boundary)).toEqual([]);
  });
});
