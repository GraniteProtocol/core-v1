import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  /** Scenarios the user has approved into the skill; proposals are diffed against this. */
  appliedScenarios: string[];
  /** What the last run saw, so drift is visible without treating it as applied. */
  lastSeenScenarios: string[];
  failures: string[];
  lastSeed?: number;
  lastRunAt?: string;
};

function readState(): State {
  if (!existsSync(STATE_PATH)) return { appliedScenarios: [], lastSeenScenarios: [], failures: [] };
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<State> & { scenarios?: string[] };
    return {
      // Older state recorded only what a run saw; treat it as applied to keep proposals stable.
      appliedScenarios: raw.appliedScenarios ?? raw.scenarios ?? [],
      lastSeenScenarios: raw.lastSeenScenarios ?? raw.scenarios ?? [],
      failures: raw.failures ?? [],
      lastSeed: raw.lastSeed,
      lastRunAt: raw.lastRunAt,
    };
  } catch {
    return { appliedScenarios: [], lastSeenScenarios: [], failures: [] };
  }
}

function writeState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
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
  const proposalPath = join(reportDir, "learn-proposal.diff");
  if (!existsSync(SKILL_PATH)) {
    const proposal = `Skill not present at ${SKILL_PATH}; no state recorded and no change proposed.`;
    writeFileSync(proposalPath, `${proposal}\n`);
    return { proposal, proposalPath, statePath: STATE_PATH };
  }

  const previous = readState();
  const applied = new Set(previous.appliedScenarios);
  const names = run.scenarios.map((scenario) => scenario.name);
  const newScenarios = names.filter((name) => !applied.has(name));
  const failures = run.scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => `${scenario.name}: ${scenario.failure}`);
  const fuzzFailure = run.fuzz.firstFailure ? [run.fuzz.firstFailure] : [];

  writeState({
    appliedScenarios: previous.appliedScenarios,
    lastSeenScenarios: names,
    failures,
    lastSeed: run.seed,
    lastRunAt: run.startedAt,
  });

  const notes: string[] = [];
  if (newScenarios.length > 0) {
    notes.push(`New scenarios this run (not yet applied to this skill): ${newScenarios.join(", ")}`);
  }
  for (const failure of failures) notes.push(`Failure worth pinning: ${failure}`);
  for (const failure of fuzzFailure) notes.push(`Fuzz failure: ${failure}`);

  let proposal: string;
  if (notes.length === 0) {
    proposal =
      "No new scenarios or failures since the last applied state; no skill change proposed.";
    writeFileSync(proposalPath, `${proposal}\n`);
    return { proposal, proposalPath, statePath: STATE_PATH };
  }

  const current = readFileSync(SKILL_PATH, "utf8");
  const proposed = withNotes(current, notes);
  const currentPath = join(reportDir, "skill-current.md");
  const proposedPath = join(reportDir, "skill-proposed.md");
  writeFileSync(currentPath, current);
  writeFileSync(proposedPath, proposed);
  const diff = spawnSync("diff", ["-u", currentPath, proposedPath], { encoding: "utf8", timeout: 10_000 });
  const text = diff.stdout?.trim() || "(no textual change)";
  writeFileSync(proposalPath, `${text}\n`);
  proposal = ["Proposed skill update (apply only on approval):", "", text].join("\n");
  if (newScenarios.length > 0) {
    proposal += `\n\nApplying it also means adding these to appliedScenarios in ${STATE_PATH}.`;
  }
  return { proposal, proposalPath, statePath: STATE_PATH };
}
