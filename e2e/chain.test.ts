import { describe, expect, it } from "vitest";
import { nextNonce } from "./chain";

describe("nonce manager", () => {
  it("uses the chain nonce and never trusts a local value that runs ahead", () => {
    const n = new Map<string, number>();
    expect(nextNonce(n, "a", 0)).toBe(0);
    // The chain, not the cache, decides: a remembered value ahead of it is a gap that would hang.
    expect(nextNonce(n, "a", 0)).toBe(0);
    expect(nextNonce(n, "b", 5)).toBe(5);
    expect(nextNonce(n, "a", 2)).toBe(2);
  });
});
