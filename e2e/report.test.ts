import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReport } from "./report";

describe("report", () => {
  it("writes markdown and json with the run summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-e2e-report-"));
    const paths = await writeReport(dir, {
      startedAt: "2026-10-23T00:00:00.000Z",
      durationMs: 1234,
      seed: 7,
      scenarios: [
        { name: "happy", passed: true, steps: 3 },
        { name: "caps", passed: false, failure: "expected err u120002", steps: 5 },
      ],
      fuzz: { sequences: 200, ops: 6000, failures: 0 },
    });
    const md = readFileSync(paths.mdPath, "utf8");
    const json = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(md).toContain("| happy | PASS |");
    expect(md).toContain("seed: 7");
    expect(json.seed).toBe(7);
    expect(json.scenarios[1].failure).toBe("expected err u120002");
  });
});
