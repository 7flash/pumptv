import { describe, expect, test } from "bun:test";
import {
  createInvalidationQueue,
  createReactiveState,
  createSignal,
} from "./signals.ts";

describe("client signals", () => {
  test("signal notifies only on actual changes", () => {
    const signal = createSignal(1);
    const seen: number[] = [];
    signal.subscribe(({ value }) => seen.push(value));

    expect(signal.set(1)).toBe(false);
    expect(signal.set(2)).toBe(true);
    expect(signal.set((value) => value + 3)).toBe(true);
    expect(signal.get()).toBe(5);
    expect(seen).toEqual([2, 5]);
  });

  test("reactive state exposes property assignment as signals", () => {
    const reactive = createReactiveState({ open: false, count: 0 });
    const keys: string[] = [];
    reactive.subscribe(({ key }) => keys.push(String(key)));

    reactive.state.open = true;
    reactive.state.count = 2;
    reactive.state.count = 2;

    expect(reactive.state.open).toBe(true);
    expect(reactive.state.count).toBe(2);
    expect(keys).toEqual(["open", "count"]);
  });

  test("invalidation queue batches a burst into one flush", () => {
    const scheduled: Array<() => void> = [];
    const flushes: string[][] = [];
    const queue = createInvalidationQueue(
      (reasons) => flushes.push([...reasons]),
      (callback) => scheduled.push(callback),
    );

    queue.invalidate("a");
    queue.invalidate("b");
    queue.invalidate("a");

    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    expect(flushes).toEqual([["a", "b"]]);
  });
});
