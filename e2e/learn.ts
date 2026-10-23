import { existsSync, readFileSync } from "node:fs";
import type { RunReport } from "./report.ts";

const STATE_PATH = ".claude/skills/local-e2e/state.json";

type State = { scenarios: string[]; failures: string[]; lastSeed?: number };

function readState(): State {
  if (!existsSync(STATE_PATH)) return { scenarios: [], failures: [] };
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  } catch {
    return { scenarios: [], failures: [] };
  }
}

/**
 * Returns a concrete proposal for what this run learned. Writes nothing: the skill shows this to
 * the user and applies it only on approval.
 */
export async function proposeLearnings(run: RunReport): Promise<string> {
  const state = readState();
  const seen = new Set(state.scenarios);
  const added = run.scenarios.filter((scenario) => !seen.has(scenario.name)).map((scenario) => scenario.name);
  const failed = run.scenarios.filter((scenario) => !scenario.passed).map((scenario) => `${scenario.name}: ${scenario.failure}`);

  const lines: string[] = ["## local-e2e self-learning proposal", ""];
  if (added.length > 0) {
    lines.push("New scenarios to record in the skill state:", "", ...added.map((name) => `- ${name}`), "");
  } else {
    lines.push("No new scenarios since the last recorded run.", "");
  }
  if (failed.length > 0) {
    lines.push("Failures worth capturing as regression cases:", "", ...failed.map((line) => `- ${line}`), "");
  }
  if (run.fuzz.failures > 0 && run.fuzz.firstFailure) {
    lines.push("First fuzz failure:", "", "```", run.fuzz.firstFailure, "```", "");
  }
  lines.push(
    "Proposed edits (apply only with approval): update `.claude/skills/local-e2e/state.json` with the",
    "scenario names above and the seed of this run so the next run can tell what changed.",
  );
  return lines.join("\n");
}
