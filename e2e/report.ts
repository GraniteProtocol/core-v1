import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type ScenarioResult = {
  name: string;
  passed: boolean;
  failure?: string;
  steps: number;
  ms?: number;
  invariantFailures?: string[];
};

export type RunReport = {
  startedAt: string;
  durationMs: number;
  seed: number;
  scenarios: ScenarioResult[];
  fuzz: { sequences: number; ops: number; failures: number; firstFailure?: string };
  devnetLog?: string;
  devnetRestarts?: number;
  timings?: {
    bootMs: number;
    setupMs: number;
    scenarios: Array<{ name: string; ms: number }>;
    matrixMs: number;
    fuzzMs: number;
    fuzzOps: number;
    perOpMs: number;
    totalMs: number;
  };
  restarts?: Array<{
    at: string;
    phase: string;
    reason: string;
    sequence?: number;
    op?: string;
    driftAtRestart: string;
  }>;
  accounting?: {
    drift: string;
    debtOps: number;
    maxStepDrift: string;
    exactZero: boolean;
    rebaselines?: Array<{ at: string; phase: string; drift: string }>;
  };
};

export async function writeReport(
  dir: string,
  report: RunReport,
): Promise<{ mdPath: string; jsonPath: string }> {
  const jsonPath = join(dir, "report.json");
  const mdPath = join(dir, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const passed = report.scenarios.filter((scenario) => scenario.passed).length;
  const failed = report.scenarios.length - passed;
  const seconds = (report.durationMs / 1000).toFixed(1);
  const lines: string[] = [
    "# local e2e report",
    "",
    `- started: ${report.startedAt}`,
    `- runtime: ${seconds}s`,
    `- seed: ${report.seed}`,
    `- scenarios: ${passed} passed, ${failed} failed`,
    `- fuzz: ${report.fuzz.sequences} sequences, ${report.fuzz.ops} ops, ${report.fuzz.failures} failures`,
  ];
  if (report.timings) {
    const t = report.timings;
    lines.push(
      `- timings: boot ${(t.bootMs / 1000).toFixed(1)}s, setup ${(t.setupMs / 1000).toFixed(1)}s, matrix ${(
        t.matrixMs / 1000
      ).toFixed(1)}s, fuzz ${(t.fuzzMs / 1000).toFixed(1)}s (${t.fuzzOps} ops, ${t.perOpMs}ms/op), total ${(
        t.totalMs / 1000
      ).toFixed(1)}s`,
    );
    lines.push("", "| scenario | ms |", "| --- | --- |");
    for (const scenario of t.scenarios) lines.push(`| ${scenario.name} | ${scenario.ms} |`);
    lines.push("");
  }
  if (report.devnetLog) lines.push(`- devnet log: ${report.devnetLog}`);
  if (report.devnetRestarts) {
    lines.push(
      `- devnet restarts: ${report.devnetRestarts} (frozen Stacks tip for 75s at a PoX reward-cycle boundary; the documented clarinet workaround)`,
    );
    for (const event of report.restarts ?? []) {
      const where = event.sequence !== undefined ? ` sequence ${event.sequence}${event.op ? ` ${event.op}` : ""}` : "";
      lines.push(`  - ${event.at} [${event.phase}${where}] ${event.reason} (drift at restart: ${event.driftAtRestart})`);
    }
  }
  if (report.accounting) {
    lines.push(
      `- accounting: gap=${report.accounting.drift}, debt-ops=${report.accounting.debtOps}, max-step=${report.accounting.maxStepDrift}`,
    );
    if (!report.accounting.exactZero) {
      lines.push(
        `- warning: the accounting gap is non-zero (integer rounding residue; it must not move outside debt operations)`,
      );
    }
  }
  lines.push("", "| scenario | result | failure |", "| --- | --- | --- |");
  for (const scenario of report.scenarios) {
    const result = scenario.passed ? "PASS" : "FAIL";
    const failure = (scenario.failure ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${scenario.name} | ${result} | ${failure} |`);
  }
  if (report.fuzz.firstFailure) {
    lines.push("", "## first fuzz failure", "", report.fuzz.firstFailure);
  }
  lines.push("");
  writeFileSync(mdPath, lines.join("\n"));
  return { mdPath, jsonPath };
}
