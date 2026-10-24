import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { workDirPath } from "./devnet";

describe("chainstate path", () => {
  it("resolves a devnet directory under .cache, never as a bare name", () => {
    const name = "stacks-devnet-1234567890";
    expect(workDirPath(name)).toBe(join(".cache", name));
    // A bare name would resolve against the repo root where nothing exists, and rmSync would hide
    // the miss behind force: true.
    expect(workDirPath(name)).not.toBe(name);
  });
});
