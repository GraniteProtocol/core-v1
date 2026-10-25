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
      fuzz: {
        sequences: 10,
        sequencesCompleted: 10,
        ops: 30,
        succeeded: 24,
        aborted: 6,
        failures: 0,
        perOp: { deposit: { attempts: 5, succeeded: 5, aborted: 0 } },
      },
      accounting: { drift: "1", debtOps: 12, maxStepDrift: "1", exactZero: false },
    });
    const md = readFileSync(paths.mdPath, "utf8");
    const json = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    expect(md).toContain("| happy | PASS |");
    expect(md).toContain("seed: 7");
    expect(json.seed).toBe(7);
    expect(json.scenarios[1].failure).toBe("expected err u120002");
    expect(md).toContain("accounting: gap=1");
    expect(md).toContain("warning: the accounting gap is non-zero");
  });
});
