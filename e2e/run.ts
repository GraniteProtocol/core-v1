import { mkdirSync } from "node:fs";
import { Chain, DevnetStallError } from "./chain.ts";
import { startDevnet, stopDevnet, type DevnetHandle } from "./devnet.ts";
import { loadAccounts } from "./keys.ts";
import type { Account } from "./keys.ts";
import { fundAccount, newAccount } from "./accounts.ts";
import { setup, BTC, ETH, MARKET, STX, type Actors } from "./setup.ts";
import { createContext, type Scenario } from "./scenario.ts";
import { happy } from "./scenarios/happy.ts";
import { matrix } from "./scenarios/matrix.ts";
import { FUZZ_MAX_OPS, FUZZ_MIN_OPS, FUZZ_SEQUENCES, generate, type Op } from "./fuzz.ts";
import {
  accountingStats,
  checkInvariants,
  failed,
  resetAccounting,
  resetDriftBaseline,
} from "./invariants.ts";
import { resetToBaseline, setPrice } from "./prices.ts";

const DEBT_OPS = new Set(["borrow", "repay", "liquidate"]);
const MAX_RESTARTS = 20;
import { Cl } from "@stacks/transactions";
import { writeReport, type ScenarioResult } from "./report.ts";
import { proposeLearnings } from "./learn.ts";
import {
  addCollateral,
  borrow,
  deposit,
  liquidate,
  removeCollateral,
  repay,
  stake,
  initiateUnstake,
  withdraw,
} from "./actors.ts";

const DEFAULT_SEED = 20_261_023;
const USDC = 100_000_000n;
const TOKENS = [BTC, ETH, STX];

function parseArgs(argv: string[]): { keep: boolean; seed: number } {
  const keep = argv.includes("--keep");
  const seedIndex = argv.indexOf("--seed");
  const seed = seedIndex >= 0 ? Number(argv[seedIndex + 1]) : DEFAULT_SEED;
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`invalid --seed value: ${argv[seedIndex + 1]}`);
  return { keep, seed };
}

const ACTOR_NAMES: Array<EnumeratedActor> = ["lp", "safe", "max", "near", "under", "liquidator", "staker", "flash"];
type EnumeratedActor = Exclude<keyof Actors, "deployer">;

function loadDeployer(): Account {
  const accounts = loadAccounts("settings/Devnet.toml");
  const deployer = accounts.find((entry) => entry.name === "deployer");
  if (!deployer) throw new Error("missing devnet deployer account");
  return deployer;
}

/**
 * Dedicated funded accounts rather than the devnet wallets: clarinet sends its own pox stacking
 * transactions from wallet_1..3, and sharing an account with those puts our transactions behind a
 * nonce we do not control.
 */
async function bootstrapActors(chain: Chain, deployer: Account): Promise<Actors> {
  const actors = { deployer } as Actors;
  for (const role of ACTOR_NAMES) {
    const account = newAccount(role);
    await fundAccount(chain, deployer, account);
    actors[role] = account;
  }
  return actors;
}

function fuzzAccount(actors: Actors, name: string): Account {
  const map: Record<string, Account> = {
    lp: actors.lp,
    safe: actors.safe,
    max: actors.max,
    near: actors.near,
    under: actors.under,
    liquidator: actors.liquidator,
    staker: actors.staker,
    deployer: actors.deployer,
  };
  const account = map[name];
  if (!account) throw new Error(`unknown fuzz actor: ${name}`);
  return account;
}

async function executeOp(chain: Chain, actors: Actors, op: Op): Promise<void> {
  const actor = fuzzAccount(actors, op.actor);
  switch (op.op) {
    case "deposit":
      return void (await deposit(chain, actor, BigInt(op.args.amount) * USDC));
    case "withdraw":
      return void (await withdraw(chain, actors.lp, BigInt(op.args.amount) * USDC));
    case "addCollateral": {
      const token = TOKENS[op.args.token];
      const scale = token === STX ? 1_000_000n : 100_000_000n;
      return void (await addCollateral(chain, actor, token, BigInt(op.args.amount) * scale));
    }
    case "removeCollateral": {
      const token = TOKENS[op.args.token];
      const scale = token === STX ? 1_000_000n : 100_000_000n;
      return void (await removeCollateral(chain, actor, token, BigInt(op.args.amount) * scale));
    }
    case "borrow":
      return void (await borrow(chain, actor, BigInt(op.args.amount) * USDC));
    case "repay":
      return void (await repay(chain, actor, BigInt(op.args.amount) * USDC));
    case "liquidate": {
      const targets = [actors.safe, actors.max, actors.near, actors.under];
      const target = targets[op.args.target % targets.length];
      return void (await liquidate(chain, actors.liquidator, BTC, target.address, BigInt(op.args.amount) * USDC));
    }
    case "stake":
      return void (await stake(chain, actors.staker, BigInt(op.args.amount) * USDC));
    case "unstake":
      return void (await initiateUnstake(chain, actors.staker, BigInt(op.args.amount) * USDC));
    case "setPrice": {
      // The market token stays at $1; moving it would make the debt itself arbitrary.
      const token = [BTC, ETH, STX][op.args.token % 3];
      setPrice(token, BigInt(op.args.price));
      return;
    }
    case "governance":
      return void (await chain.call(actors.deployer, "withdrawal-caps-v1", "set-lp-cap", [
        Cl.uint(op.args.action === 0 ? 0n : 50_000_000n),
      ]));
    default:
      throw new Error(`unknown fuzz op ${op.op}`);
  }
}

/** A contract abort is an acceptable fuzz outcome; an infrastructure error is not. */
function isContractAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\(err u\d+\)/.test(message) || message.includes("abort_by_response") || message.includes("abort_by_post_condition");
}

type Session = {
  devnet: DevnetHandle;
  chain: Chain;
  actors: Actors;
  baseline: Awaited<ReturnType<typeof setup>>;
};

async function startSession(
  reportDir: string,
  deployer: Account,
  index: number,
  attempts = 4,
): Promise<Session> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const devnet = await startDevnet({
      logDir: reportDir,
      logName: index === 0 && attempt === 1 ? "devnet.log" : `devnet-${index + 1}-${attempt}.log`,
    });
    try {
      const chain = new Chain(deployer.address);
      const actors = await bootstrapActors(chain, deployer);
      const baseline = await setup(chain, actors);
      return { devnet, chain, actors, baseline };
    } catch (error) {
      lastError = error;
      await stopDevnet(devnet);
      if (!(error instanceof DevnetStallError)) throw error;
      console.log(`setup hit a frozen devnet; retrying the boot (${attempt}/${attempts})`);
    }
  }
  throw lastError;
}

async function runScenario(session: Session, scenario: Scenario): Promise<ScenarioResult> {
  const { chain, actors, baseline } = session;
  resetToBaseline();
  const context = createContext(chain, actors, baseline);
  const started = Date.now();
  try {
    await scenario.run(context);
    return {
      name: scenario.name,
      passed: true,
      steps: context.steps.length,
      invariantFailures: context.invariantFailures,
    };
  } catch (error) {
    // A frozen devnet is infrastructure, not a scenario failure: let main restart and retry.
    if (error instanceof DevnetStallError) throw error;
    const failure = error instanceof Error ? error.message : String(error);
    return {
      name: scenario.name,
      passed: false,
      failure,
      steps: context.steps.length,
      invariantFailures: context.invariantFailures,
    };
  } finally {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ${scenario.name}: ${seconds}s`);
  }
}

async function main(): Promise<number> {
  const { keep, seed } = parseArgs(process.argv.slice(2));
  resetAccounting();
  const startedAt = new Date();
  const reportDir = `/tmp/local-e2e-${startedAt.getTime()}`;
  mkdirSync(reportDir, { recursive: true });

  const deployer = loadDeployer();
  let session: Session | null = null;
  let restarts = 0;
  const scenarios: ScenarioResult[] = [];
  const fuzz = { sequences: FUZZ_SEQUENCES, ops: 0, failures: 0, firstFailure: undefined as string | undefined };

  const restart = async (reason: string): Promise<void> => {
    if (!session) throw new Error("no devnet session to restart");
    restarts += 1;
    if (restarts > MAX_RESTARTS) {
      throw new Error(`devnet stalled ${restarts} times, giving up (last: ${reason})`);
    }
    console.log(`devnet stall: ${reason}; restart ${restarts}/${MAX_RESTARTS}`);
    await stopDevnet(session.devnet);
    session = await startSession(reportDir, deployer, restarts);
    resetDriftBaseline();
    console.log("devnet restarted and set up");
  };

  try {
    console.log(`report dir: ${reportDir}`);
    session = await startSession(reportDir, deployer, 0);
    console.log(`devnet up: api=${session.devnet.apiUrl} pid=${session.devnet.pid}`);
    console.log("setup complete");

    const allScenarios = [happy, ...matrix];
    for (const scenario of allScenarios) {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await runScenario(session, scenario);
          scenarios.push(result);
          console.log(`  ${result.passed ? "PASS" : "FAIL"} ${result.name}${result.failure ? `: ${result.failure}` : ""}`);
          break;
        } catch (error) {
          if (error instanceof DevnetStallError && attempt < 2) {
            await restart(error.message);
            continue;
          }
          throw error;
        }
      }
    }

    console.log(`fuzz: ${FUZZ_SEQUENCES} sequences`);
    let fuzzFailed = false;
    for (let index = 0; index < FUZZ_SEQUENCES && !fuzzFailed; index++) {
      const length = FUZZ_MIN_OPS + ((seed + index * 7919) % (FUZZ_MAX_OPS - FUZZ_MIN_OPS + 1));
      const ops = generate(seed + index, length);
      for (const op of ops) {
        fuzz.ops += 1;
        for (let attempt = 0; ; attempt++) {
          try {
            await executeOp(session.chain, session.actors, op);
            break;
          } catch (error) {
            if (error instanceof DevnetStallError && attempt < 2) {
              await restart(error.message);
              continue;
            }
            // An aborted fuzz op is an expected outcome; its state change is nil.
            if (isContractAbort(error)) break;
            fuzz.failures += 1;
            fuzz.firstFailure = `sequence ${index} (seed ${seed + index}) op ${JSON.stringify(op)}: ${
              error instanceof Error ? error.message : String(error)
            }`;
            fuzzFailed = true;
            break;
          }
        }
        if (fuzzFailed) break;
        // An aborted fuzz op is an expected outcome; its state change is nil, so still verify.
        const violations = failed(
          await checkInvariants(session.chain, DEBT_OPS.has(op.op) ? "debt" : "non-debt"),
        );
        if (violations.length > 0) {
          fuzz.failures += 1;
          fuzz.firstFailure = `sequence ${index} (seed ${seed + index}) op ${JSON.stringify(op)}: ${violations
            .map((violation) => `${violation.name}: ${violation.detail}`)
            .join("; ")}`;
          fuzzFailed = true;
          break;
        }
      }
      if (index % 10 === 0) console.log(`  sequence ${index + 1}/${FUZZ_SEQUENCES} (${fuzz.ops} ops)`);
    }

    const finalViolations = failed(await checkInvariants(session.chain));
    if (finalViolations.length > 0 && fuzz.failures === 0) {
      fuzz.failures += 1;
      fuzz.firstFailure = `final invariants: ${finalViolations.map((v) => `${v.name}: ${v.detail}`).join("; ")}`;
    }

    const accounting = accountingStats();
    const report = {
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      seed,
      scenarios,
      fuzz,
      devnetLog: session.devnet.logPath,
      devnetRestarts: restarts,
      accounting: {
        drift: accounting.drift.toString(),
        debtOps: accounting.debtOps,
        maxStepDrift: accounting.maxStepDrift.toString(),
        exactZero: accounting.exactZero,
      },
    };
    const paths = await writeReport(reportDir, report);
    const passed = scenarios.filter((scenario) => scenario.passed).length;
    const ok = passed === scenarios.length && fuzz.failures === 0;
    console.log(
      `\nsummary: ${passed}/${scenarios.length} scenarios passed, ${fuzz.ops} fuzz ops, seed ${seed}, ${
        (report.durationMs / 1000).toFixed(1)
      }s, ${ok ? "PASS" : "FAIL"}`,
    );
    console.log(
      `accounting: gap=${accounting.drift} debt-ops=${accounting.debtOps} max-step=${accounting.maxStepDrift}`,
    );
    console.log(`devnet restarts: ${restarts}`);
    if (!accounting.exactZero) {
      console.log(
        "warning: the accounting gap is non-zero (integer rounding residue; see report.json accounting)",
      );
    }
    console.log(`report: ${paths.mdPath}`);
    console.log(await proposeLearnings(report));
    return ok ? 0 : 1;
  } finally {
    if (session && !keep) await stopDevnet(session.devnet);
    if (session && keep) console.log(`devnet kept up (pid ${session.devnet.pid}); stop it with SIGTERM`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
