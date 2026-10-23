import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type ScenarioResult = {
  name: string;
  passed: boolean;
  failure?: string;
  steps: number;
  invariantFailures?: string[];
};

export type RunReport = {
  startedAt: string;
  durationMs: number;
  seed: number;
  scenarios: ScenarioResult[];
  fuzz: { sequences: number; ops: number; failures: number; firstFailure?: string };
  devnetLog?: string;
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
  if (report.devnetLog) lines.push(`- devnet log: ${report.devnetLog}`);
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
