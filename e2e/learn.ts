import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunReport } from "./report.ts";

const STATE_PATH = ".claude/skills/local-e2e/state.json";
const SKILL_PATH = ".claude/skills/local-e2e/SKILL.md";
const NOTES_HEADER = "## Recorded run notes";

export type LearningProposal = {
  proposal: string;
  proposalPath: string;
  statePath: string;
};

type State = {
  scenarios: string[];
  failures: string[];
  lastSeed?: number;
  lastRunAt?: string;
};

function readState(): State {
  if (!existsSync(STATE_PATH)) return { scenarios: [], failures: [] };
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  } catch {
    return { scenarios: [], failures: [] };
  }
}

function writeState(state: State): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/** Appends the run's notes to the skill text; the caller shows the diff and applies nothing. */
function withNotes(current: string, notes: string[]): string {
  const existing = current.includes(NOTES_HEADER)
    ? current.slice(current.indexOf(NOTES_HEADER))
    : "";
  const already = new Set(existing.split("\n").map((line) => line.trim()));
  const additions = notes.filter((note) => !already.has(note.trim()));
  if (additions.length === 0) return current;
  const base = current.includes(NOTES_HEADER) ? current : `${current.trimEnd()}\n\n${NOTES_HEADER}\n`;
  return `${base}${additions.map((note) => `${note.startsWith("-") ? note : `- ${note}`}`).join("\n")}\n`;
}

/**
 * Records this run in the skill's local state and returns a concrete diff against SKILL.md for
 * anything it learned. It writes only the state file and the proposal under the report directory;
 * the skill files change only when the user approves the diff.
 */
export async function proposeLearnings(run: RunReport, reportDir: string): Promise<LearningProposal> {
  const previous = readState();
  const seen = new Set(previous.scenarios);
  const names = run.scenarios.map((scenario) => scenario.name);
  const newScenarios = names.filter((name) => !seen.has(name));
  const failures = run.scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => `${scenario.name}: ${scenario.failure}`);
  const fuzzFailure = run.fuzz.firstFailure ? [run.fuzz.firstFailure] : [];

  writeState({
    scenarios: names,
    failures,
    lastSeed: run.seed,
    lastRunAt: run.startedAt,
  });

  const notes: string[] = [];
  if (newScenarios.length > 0) notes.push(`New scenarios this run: ${newScenarios.join(", ")}`);
  for (const failure of failures) notes.push(`Failure worth pinning: ${failure}`);
  for (const failure of fuzzFailure) notes.push(`Fuzz failure: ${failure}`);

  const proposalPath = join(reportDir, "learn-proposal.diff");
  let proposal: string;
  if (notes.length === 0 || !existsSync(SKILL_PATH)) {
    proposal =
      "No new scenarios or failures since the last recorded run; no skill change proposed.";
    writeFileSync(proposalPath, `${proposal}\n`);
    return { proposal, proposalPath, statePath: STATE_PATH };
  }

  const current = readFileSync(SKILL_PATH, "utf8");
  const proposed = withNotes(current, notes);
  const currentPath = join(reportDir, "skill-current.md");
  const proposedPath = join(reportDir, "skill-proposed.md");
  writeFileSync(currentPath, current);
  writeFileSync(proposedPath, proposed);
  const diff = spawnSync("diff", ["-u", currentPath, proposedPath], { encoding: "utf8" });
  const text = diff.stdout?.trim() || "(no textual change)";
  writeFileSync(proposalPath, `${text}\n`);
  proposal = [
    "Proposed skill update (apply only on approval):",
    "",
    text,
  ].join("\n");
  return { proposal, proposalPath, statePath: STATE_PATH };
}
