import { describe, expect, it } from "vitest";
import { generate } from "./fuzz";

describe("fuzz", () => {
  it("is deterministic for a seed and bounded", () => {
    expect(generate(42, 20)).toEqual(generate(42, 20));
    expect(generate(42, 20).length).toBe(20);
    expect(generate(42, 20).every((o) => o.op.length > 0)).toBe(true);
  });

  it("varies across seeds", () => {
    expect(generate(1, 20)).not.toEqual(generate(2, 20));
  });
});
