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

export type FuzzStats = {
  sequences: number;
  sequencesCompleted: number;
  ops: number;
  succeeded: number;
  aborted: number;
  failures: number;
  perOp: Record<string, { attempts: number; succeeded: number; aborted: number }>;
  stakingWipedOut?: boolean;
  firstFailure?: string;
};

export type CapsReport = {
  refillWindow: string;
  decayWindow: string;
  lp: { bucket: string; factor: string; max: string };
  debt: { bucket: string; factor: string; max: string };
  collateral: Record<string, { bucket: string; factor: string; max: string }>;
};

export type RunReport = {
  startedAt: string;
  durationMs: number;
  seed: number;
  phase?: string;
  error?: string | null;
  expectedScenarios?: string[];
  scenarios: ScenarioResult[];
  fuzz: FuzzStats;
  devnetLog?: string | null;
  devnetRestarts?: number;
  bootAttempts?: Array<{ attempt: number; logPath: string; ok: boolean; reason?: string }>;
  summary?: {
    scenariosPassed: number;
    scenariosExpected: number;
    fuzzSucceeded: number;
    fuzzAborted: number;
    successRatio: number;
    successRatioExcludes?: string[];
  };
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
  caps?: CapsReport;
};

export async function writeReport(
  dir: string,
  report: RunReport,
): Promise<{ mdPath: string; jsonPath: string }> {
  const jsonPath = join(dir, "report.json");
  const mdPath = join(dir, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const expected = report.expectedScenarios ?? report.scenarios.map((scenario) => scenario.name);
  const passed = report.scenarios.filter((scenario) => scenario.passed).length;
  const failed = expected.length - passed;
  const seconds = (report.durationMs / 1000).toFixed(1);
  const ratio = report.fuzz.ops > 0 ? (report.fuzz.succeeded / report.fuzz.ops).toFixed(3) : "0";
  const lines: string[] = [
    "# local e2e report",
    "",
    `- started: ${report.startedAt}`,
    `- phase: ${report.phase ?? "complete"}`,
    `- runtime: ${seconds}s`,
    `- seed: ${report.seed}`,
    `- scenarios: ${passed} passed, ${failed} not passed of ${expected.length} expected`,
    `- fuzz: ${report.fuzz.sequencesCompleted}/${report.fuzz.sequences} sequences, ${report.fuzz.ops} ops (${report.fuzz.succeeded} succeeded, ${report.fuzz.aborted} expected aborts, ratio ${report.summary?.successRatio ?? ratio}${
      report.summary?.successRatioExcludes?.length ? ` excluding ${report.summary.successRatioExcludes.join("/")} (wiped staking)` : ""
    }), ${report.fuzz.failures} failures`,
  ];
  if (report.error) lines.push(`- error: ${report.error}`);
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
  if (report.bootAttempts) {
    lines.push(`- boot attempts: ${report.bootAttempts.length}`);
    for (const attempt of report.bootAttempts) {
      lines.push(
        `  - attempt ${attempt.attempt}: ${attempt.ok ? "used" : "failed"} ${attempt.logPath}${
          attempt.reason ? ` (${attempt.reason.split("\n")[0]})` : ""
        }`,
      );
    }
  }
  if (report.devnetRestarts) {
    lines.push(
      `- devnet restarts: ${report.devnetRestarts} (frozen Stacks tip for 75s at a PoX reward-cycle boundary; the documented clarinet workaround)`,
    );
    for (const event of report.restarts ?? []) {
      const where = event.sequence !== undefined ? ` sequence ${event.sequence}${event.op ? ` ${event.op}` : ""}` : "";
      lines.push(`  - ${event.at} [${event.phase}${where}] ${event.reason} (drift at restart: ${event.driftAtRestart})`);
    }
  }
  if (report.caps) {
    const c = report.caps;
    lines.push(
      `- caps: windows refill=${c.refillWindow} decay=${c.decayWindow}; lp bucket=${c.lp.bucket} factor=${c.lp.factor} max=${c.lp.max}; debt bucket=${c.debt.bucket} factor=${c.debt.factor} max=${c.debt.max}`,
    );
    for (const [token, value] of Object.entries(c.collateral)) {
      lines.push(`  - ${token}: bucket=${value.bucket} factor=${value.factor} max=${value.max}`);
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
  lines.push(
    "",
    "| op | attempts | succeeded | expected aborts |",
    "| --- | --- | --- | --- |",
  );
  for (const [name, stat] of Object.entries(report.fuzz.perOp)) {
    lines.push(`| ${name} | ${stat.attempts} | ${stat.succeeded} | ${stat.aborted} |`);
  }
  lines.push("", "| scenario | result | steps | failure |", "| --- | --- | --- | --- |");
  for (const scenario of report.scenarios) {
    const result = scenario.passed ? "PASS" : "FAIL";
    const failure = (scenario.failure ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${scenario.name} | ${result} | ${scenario.steps} | ${failure} |`);
  }
  if (report.fuzz.firstFailure) {
    lines.push("", "## first fuzz failure", "", report.fuzz.firstFailure);
  }
  lines.push("");
  writeFileSync(mdPath, lines.join("\n"));
  return { mdPath, jsonPath };
}
