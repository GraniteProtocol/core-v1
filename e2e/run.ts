import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Chain, DevnetStallError } from "./chain.ts";
import { startDevnet, stopDevnet, type BootAttempt, type DevnetHandle } from "./devnet.ts";
import { loadAccounts } from "./keys.ts";
import type { Account } from "./keys.ts";
import { fundAccount, newAccount } from "./accounts.ts";
import { setup, BTC, ETH, STX, type Actors } from "./setup.ts";
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
  resetProbeUsers,
} from "./invariants.ts";
import { convertedPrice, resetToBaseline, setPrice } from "./prices.ts";
import { healthOf, positionOf } from "./reads.ts";

const DEBT_OPS = new Set(["borrow", "repay", "liquidate"]);
const MAX_RESTARTS = 20;
// A fuzz run where most ops abort (or an op type never succeeds) is not exercising the protocol.
const MIN_SUCCESS_RATIO = 0.5;
const MIN_OP_RATIO = 0.05;
const MIN_OP_ATTEMPTS = 5;
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
      // Pick a target that holds BTC collateral and is past the contract's liquidation block gap,
      // then scale all of its collateral prices so the whole position is 2% under water while its
      // collateral still exceeds debt + reward. That exercises liquidation without a socializing
      // write-off, whose second interest split would move the accounting gate past its residue.
      const height = await chain.blockHeight();
      let target = targets[op.args.target % targets.length];
      for (const candidate of targets) {
        const position = await positionOf(chain, candidate.address);
        if (!position) continue;
        const hasBtc = position.collaterals.some((collateral) => collateral.endsWith(".mock-btc"));
        if (!hasBtc || position.borrowedAmount === 0n) continue;
        if (BigInt(height) < position.borrowedBlock + 6n) continue;
        const health = await healthOf(chain, candidate.address);
        if (!health || health.currentDebt === 0n || health.totalLiquidLtv === 0n) continue;
        target = candidate;
        const numerator = health.currentDebt * 98n;
        const denominator = health.totalLiquidLtv * 100n;
        for (const collateral of position.collaterals) {
          const token = collateral.split(".").pop() ?? collateral;
          const dollars = convertedPrice(token) / 100_000_000n;
          const scaled = (dollars * numerator) / denominator;
          setPrice(token, scaled > 0n ? scaled : 1n);
        }
        break;
      }
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

/**
 * Only a contract error code is an acceptable fuzz outcome. Runtime errors surface as `(err none)`,
 * and a post-condition abort cannot legitimately occur with allow-mode and no post-conditions, so
 * both are harness failures, not expected aborts.
 */
function isExpectedContractAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /aborted \([^)]*\): \(err u\d+\)/.test(message);
}

type Session = {
  devnet: DevnetHandle;
  chain: Chain;
  actors: Actors;
  baseline: Awaited<ReturnType<typeof setup>>;
  timings: { bootMs: number; setupMs: number };
};

type RestartEvent = {
  at: string;
  phase: string;
  reason: string;
  sequence?: number;
  op?: string;
  driftAtRestart: string;
};

async function startSession(
  reportDir: string,
  deployer: Account,
  index: number,
  bootAttempts: BootAttempt[],
  onRetry?: (reason: string) => void,
  onHandle?: (handle: DevnetHandle) => void,
  attempts = 6,
): Promise<Session> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let devnet: DevnetHandle | null = null;
    let booting = true;
    const logName = index === 0 && attempt === 1 ? "devnet.log" : `devnet-${index + 1}-${attempt}.log`;
    try {
      const bootStarted = Date.now();
      devnet = await startDevnet(
        { logDir: reportDir, logName, contractTimeoutMs: 180_000 },
        onHandle,
      );
      const bootMs = Date.now() - bootStarted;
      bootAttempts.push({ attempt, logPath: devnet.logPath, ok: true });
      booting = false;
      const setupStarted = Date.now();
      const chain = new Chain(deployer.address);
      const actors = await bootstrapActors(chain, deployer);
      const baseline = await setup(chain, actors);
      return { devnet, chain, actors, baseline, timings: { bootMs, setupMs: Date.now() - setupStarted } };
    } catch (error) {
      lastError = error;
      const reason = error instanceof Error ? error.message : String(error);
      bootAttempts.push({ attempt, logPath: join(reportDir, logName), ok: false, reason });
      if (devnet) await stopDevnet(devnet);
      // A boot can also lose the race to register the PoX signer set; a fresh boot is the fix.
      const retryable = error instanceof DevnetStallError || booting;
      if (!retryable) throw error;
      console.log(`devnet boot or setup failed; retrying the boot (${attempt}/${attempts}): ${reason}`);
      onRetry?.(reason);
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
      ms: Date.now() - started,
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
      ms: Date.now() - started,
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
  const expectedScenarios = [happy, ...matrix].map((scenario) => scenario.name);
  let session: Session | null = null;
  let liveHandle: DevnetHandle | null = null;
  let restarts = 0;
  let phase = "startup";
  let runError: string | undefined;
  let reportWritten = false;
  let shuttingDown = false;
  const handleSignal = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received; tearing the devnet down`);
    void (async () => {
      const handle = liveHandle ?? session?.devnet;
      if (handle) await stopDevnet(handle);
      process.exit(1);
    })();
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  const restartLog: RestartEvent[] = [];
  const bootAttempts: BootAttempt[] = [];
  const scenarios: ScenarioResult[] = [];
  const fuzz = {
    sequences: FUZZ_SEQUENCES,
    sequencesCompleted: 0,
    ops: 0,
    succeeded: 0,
    aborted: 0,
    failures: 0,
    perOp: {} as Record<string, { attempts: number; succeeded: number; aborted: number }>,
    ms: 0,
    firstFailure: undefined as string | undefined,
  };

  const recordRestart = (restartPhase: string, reason: string, extra: { sequence?: number; op?: string } = {}): void => {
    restarts += 1;
    restartLog.push({
      at: new Date().toISOString(),
      phase: restartPhase,
      reason,
      ...extra,
      driftAtRestart: accountingStats().drift.toString(),
    });
    if (restarts > MAX_RESTARTS) {
      throw new Error(`devnet restarted ${restarts} times, above the cap of ${MAX_RESTARTS}; last reason: ${reason}`);
    }
    console.log(`devnet stall: ${reason}; restart ${restarts}/${MAX_RESTARTS} (${restartPhase})`);
  };

  const restart = async (
    reason: string,
    restartPhase: string,
    extra: { sequence?: number; op?: string } = {},
  ): Promise<void> => {
    if (!session) throw new Error("no devnet session to restart");
    recordRestart(restartPhase, reason, extra);
    await stopDevnet(session.devnet);
    liveHandle = null;
    session = await startSession(
      reportDir,
      deployer,
      restarts,
      bootAttempts,
      (retryReason) => recordRestart("boot", retryReason),
      (handle) => {
        liveHandle = handle;
      },
    );
    liveHandle = session.devnet;
    resetDriftBaseline();
    resetProbeUsers(session.actors);
    console.log("devnet restarted and set up");
  };

  const finalAccounting = () => {
    const accounting = accountingStats();
    return {
      drift: accounting.drift.toString(),
      debtOps: accounting.debtOps,
      maxStepDrift: accounting.maxStepDrift.toString(),
      exactZero: accounting.exactZero,
      rebaselines: restartLog.map((event) => ({ at: event.at, phase: event.phase, drift: event.driftAtRestart })),
    };
  };

  const buildReport = (errorMessage?: string) => {
    const accounting = finalAccounting();
    const passedScenarios = scenarios.filter((scenario) => scenario.passed).length;
    return {
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      seed,
      phase,
      error: errorMessage ?? null,
      expectedScenarios,
      scenarios,
      fuzz,
      devnetLog: session?.devnet.logPath ?? bootAttempts.find((attempt) => attempt.ok)?.logPath ?? null,
      devnetRestarts: restarts,
      restarts: restartLog,
      bootAttempts,
      timings: session
        ? {
            bootMs: session.timings.bootMs,
            setupMs: session.timings.setupMs,
            scenarios: scenarios.map((scenario) => ({ name: scenario.name, ms: scenario.ms ?? 0 })),
            matrixMs: scenarios.reduce((sum, scenario) => sum + (scenario.ms ?? 0), 0),
            fuzzMs: fuzz.ms,
            fuzzOps: fuzz.ops,
            perOpMs: fuzz.ops > 0 ? Math.round(fuzz.ms / fuzz.ops) : 0,
            totalMs: Date.now() - startedAt.getTime(),
          }
        : undefined,
      accounting,
      summary: {
        scenariosPassed: passedScenarios,
        scenariosExpected: expectedScenarios.length,
        fuzzSucceeded: fuzz.succeeded,
        fuzzAborted: fuzz.aborted,
        successRatio: fuzz.ops > 0 ? Number((fuzz.succeeded / fuzz.ops).toFixed(3)) : 0,
      },
    };
  };

  const writePartialReport = async (errorMessage: string): Promise<void> => {
    if (reportWritten) return;
    reportWritten = true;
    try {
      const paths = await writeReport(reportDir, buildReport(errorMessage));
      console.error(`partial report (phase ${phase}): ${paths.mdPath}`);
    } catch (reportError) {
      console.error(`could not write the partial report: ${reportError instanceof Error ? reportError.message : reportError}`);
    }
  };

  try {
    console.log(`report dir: ${reportDir}`);
    phase = "boot";
    session = await startSession(
      reportDir,
      deployer,
      0,
      bootAttempts,
      (retryReason) => recordRestart("boot", retryReason),
      (handle) => {
        liveHandle = handle;
      },
    );
    liveHandle = session.devnet;
    resetProbeUsers(session.actors);
    console.log(`devnet up: api=${session.devnet.apiUrl} pid=${session.devnet.pid}`);
    console.log("setup complete");

    phase = "matrix";
    // A restart inside the matrix resets the chain, and later scenarios rely on the liquidity the
    // earlier ones deposited. Re-run the whole matrix on the fresh chain, discarding the partial pass.
    let matrixDone = false;
    for (let matrixAttempt = 0; matrixAttempt < 2 && !matrixDone; matrixAttempt++) {
      scenarios.length = 0;
      let restartNeeded = false;
      for (const scenario of [happy, ...matrix]) {
        phase = `matrix:${scenario.name}`;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const result = await runScenario(session, scenario);
            scenarios.push(result);
            console.log(`  ${result.passed ? "PASS" : "FAIL"} ${result.name}${result.failure ? `: ${result.failure}` : ""}`);
            break;
          } catch (error) {
            if (error instanceof DevnetStallError && attempt < 2) {
              await restart(error.message, `matrix:${scenario.name}`);
              restartNeeded = true;
              break;
            }
            throw error;
          }
        }
        if (restartNeeded) break;
      }
      if (!restartNeeded) matrixDone = true;
    }
    if (!matrixDone) throw new Error("matrix could not complete after devnet restarts");

    console.log(`fuzz: ${FUZZ_SEQUENCES} sequences`);
    phase = "fuzz";
    const fuzzStarted = Date.now();
    let fuzzFailed = false;
    for (let index = 0; index < FUZZ_SEQUENCES && !fuzzFailed; index++) {
      const length = FUZZ_MIN_OPS + ((seed + index * 7919) % (FUZZ_MAX_OPS - FUZZ_MIN_OPS + 1));
      const ops = generate(seed + index, length);
      for (const op of ops) {
        fuzz.ops += 1;
        const stat = (fuzz.perOp[op.op] ??= { attempts: 0, succeeded: 0, aborted: 0 });
        stat.attempts += 1;
        let outcome: "succeeded" | "aborted" | "failed" = "failed";
        for (let attempt = 0; ; attempt++) {
          try {
            await executeOp(session.chain, session.actors, op);
            outcome = "succeeded";
            break;
          } catch (error) {
            if (error instanceof DevnetStallError && attempt < 2) {
              await restart(error.message, "fuzz", { sequence: index, op: JSON.stringify(op) });
              continue;
            }
            // Only a contract error code is an expected abort; anything else is a failure.
            if (isExpectedContractAbort(error)) {
              outcome = "aborted";
              break;
            }
            fuzz.failures += 1;
            fuzz.firstFailure = `sequence ${index} (seed ${seed + index}) op ${JSON.stringify(op)}: ${
              error instanceof Error ? error.message : String(error)
            }`;
            console.error(`fuzz failure: ${fuzz.firstFailure}`);
            fuzzFailed = true;
            break;
          }
        }
        if (fuzzFailed) break;
        if (outcome === "succeeded") {
          fuzz.succeeded += 1;
          stat.succeeded += 1;
        } else if (outcome === "aborted") {
          fuzz.aborted += 1;
          stat.aborted += 1;
        }
        const violations = failed(
          await checkInvariants(session.chain, DEBT_OPS.has(op.op) ? "debt" : "non-debt"),
        );
        if (violations.length > 0) {
          fuzz.failures += 1;
          fuzz.firstFailure = `sequence ${index} (seed ${seed + index}) op ${JSON.stringify(op)}: ${violations
            .map((violation) => `${violation.name}: ${violation.detail}`)
            .join("; ")}`;
          console.error(`fuzz failure: ${fuzz.firstFailure}`);
          fuzzFailed = true;
          break;
        }
      }
      if (!fuzzFailed) fuzz.sequencesCompleted = index + 1;
      if (index % 2 === 0) console.log(`  sequence ${index + 1}/${FUZZ_SEQUENCES} (${fuzz.ops} ops)`);
    }
    fuzz.ms = Date.now() - fuzzStarted;

    const summary = buildReport().summary;
    if (summary.successRatio < MIN_SUCCESS_RATIO) {
      fuzz.failures += 1;
      fuzz.firstFailure ??= `fuzz success ratio ${summary.successRatio} below ${MIN_SUCCESS_RATIO} (${fuzz.succeeded}/${fuzz.ops})`;
      console.error(`fuzz failure: ${fuzz.firstFailure}`);
    }
    for (const [opName, stat] of Object.entries(fuzz.perOp)) {
      if (stat.attempts >= MIN_OP_ATTEMPTS && stat.succeeded / stat.attempts < MIN_OP_RATIO) {
        fuzz.failures += 1;
        fuzz.firstFailure ??= `fuzz op ${opName} succeeded ${stat.succeeded}/${stat.attempts}, below ${MIN_OP_RATIO}`;
        console.error(`fuzz failure: ${fuzz.firstFailure}`);
      }
    }

    phase = "final";
    try {
      const finalViolations = failed(await checkInvariants(session.chain));
      if (finalViolations.length > 0) {
        fuzz.failures += 1;
        fuzz.firstFailure ??= `final invariants: ${finalViolations.map((v) => `${v.name}: ${v.detail}`).join("; ")}`;
        console.error(`fuzz failure: ${fuzz.firstFailure}`);
      }
    } catch (error) {
      fuzz.failures += 1;
      fuzz.firstFailure ??= `final invariants could not run: ${error instanceof Error ? error.message : error}`;
      console.error(`fuzz failure: ${fuzz.firstFailure}`);
    }

    const report = buildReport();
    const paths = await writeReport(reportDir, report);
    reportWritten = true;
    const covered =
      expectedScenarios.every((name) => scenarios.filter((scenario) => scenario.name === name).length === 1) &&
      scenarios.length === expectedScenarios.length;
    const scenariosOk =
      covered &&
      scenarios.every(
        (scenario) => scenario.passed && scenario.steps > 0 && (scenario.invariantFailures ?? []).length === 0,
      );
    const fuzzOk = fuzz.failures === 0 && fuzz.sequencesCompleted === FUZZ_SEQUENCES;
    const ok = scenariosOk && fuzzOk;
    const passed = scenarios.filter((scenario) => scenario.passed).length;
    console.log(
      `\nsummary: ${passed}/${expectedScenarios.length} scenarios passed, ${fuzz.succeeded}/${fuzz.ops} fuzz ops succeeded (${
        fuzz.aborted
      } expected aborts), seed ${seed}, ${(report.durationMs / 1000).toFixed(1)}s, ${ok ? "PASS" : "FAIL"}`,
    );
    if (!covered) console.log(`scenario coverage failed: recorded ${scenarios.map((s) => s.name).join(", ")}`);
    const timings = report.timings!;
    console.log(
      `timings: boot ${(timings.bootMs / 1000).toFixed(1)}s, setup ${(timings.setupMs / 1000).toFixed(1)}s, matrix ${(
        timings.matrixMs / 1000
      ).toFixed(1)}s, fuzz ${(timings.fuzzMs / 1000).toFixed(1)}s (${fuzz.ops} ops, ${timings.perOpMs}ms/op), total ${(
        timings.totalMs / 1000
      ).toFixed(1)}s`,
    );
    for (const scenario of timings.scenarios) {
      console.log(`  ${scenario.name}: ${(scenario.ms / 1000).toFixed(1)}s`);
    }
    console.log(
      `fuzz per op: ${Object.entries(fuzz.perOp)
        .map(([name, stat]) => `${name} ${stat.succeeded}/${stat.attempts}`)
        .join(", ")}`,
    );
    const accounting = report.accounting!;
    console.log(
      `accounting: gap=${accounting.drift} debt-ops=${accounting.debtOps} max-step=${accounting.maxStepDrift}`,
    );
    console.log(
      `devnet restarts: ${restarts} (frozen Stacks tip for 75s at a PoX reward-cycle boundary); boot attempts: ${bootAttempts.length}`,
    );
    for (const event of restartLog) {
      const where = event.sequence !== undefined ? ` sequence ${event.sequence}` : "";
      console.log(`  - [${event.phase}${where}] ${event.reason} (drift at restart ${event.driftAtRestart})`);
    }
    if (!accounting.exactZero) {
      console.log(
        "warning: the accounting gap is non-zero (integer rounding residue; see report.json accounting)",
      );
    }
    console.log(`report: ${paths.mdPath}`);
    const learn = await proposeLearnings(report, reportDir);
    console.log(learn.proposal);
    console.log(`learn: proposal at ${learn.proposalPath}; state at ${learn.statePath}`);
    return ok ? 0 : 1;
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
    console.error(`run failed in phase ${phase}: ${runError}`);
    return 1;
  } finally {
    if (session && !keep) await stopDevnet(session.devnet);
    liveHandle = null;
    if (session && keep) console.log(`devnet kept up (pid ${session.devnet.pid}); stop it with SIGTERM`);
    if (runError) await writePartialReport(runError);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
