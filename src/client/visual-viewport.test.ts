import { describe, expect, test } from "bun:test";
import { normalizeVisualViewport } from "./visual-viewport.ts";

describe("normalizeVisualViewport", () => {
  test("rounds browser geometry and clamps invalid values", () => {
    expect(
      normalizeVisualViewport({
        width: 390.4,
        height: 412.7,
        offsetTop: 17.2,
        offsetLeft: -5,
        scale: 1,
      }),
    ).toEqual({
      width: 390,
      height: 413,
      offsetTop: 17,
      offsetLeft: 0,
      scale: 1,
    });
  });
});
