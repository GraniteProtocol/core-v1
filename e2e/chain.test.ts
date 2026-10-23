import { describe, expect, it } from "vitest";
import { nextNonce } from "./chain";

describe("nonce manager", () => {
  it("increments per account and keeps accounts independent", () => {
    const n = new Map<string, number>();
    expect(nextNonce(n, "a", 0)).toBe(0);
    expect(nextNonce(n, "a", 0)).toBe(1);
    expect(nextNonce(n, "b", 5)).toBe(5);
  });

  it("resumes from the chain nonce when the chain is ahead of the cache", () => {
    const n = new Map<string, number>();
    expect(nextNonce(n, "a", 0)).toBe(0);
    // Reusing a cached 1 against chain nonce 99 would be rejected as a conflicting nonce.
    expect(nextNonce(n, "a", 99)).toBe(99);
  });
});
