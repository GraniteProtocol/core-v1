import { mkdirSync } from "node:fs";
import { Chain } from "./chain.ts";
import { startDevnet, stopDevnet, type DevnetHandle } from "./devnet.ts";
import { loadAccounts } from "./keys.ts";
import type { Account } from "./keys.ts";
import { setup, BTC, ETH, MARKET, STX, type Actors } from "./setup.ts";
import { createContext, type Scenario } from "./scenario.ts";
import { happy } from "./scenarios/happy.ts";
import { matrix } from "./scenarios/matrix.ts";
import { FUZZ_MAX_OPS, FUZZ_MIN_OPS, FUZZ_SEQUENCES, generate, type Op } from "./fuzz.ts";
import { checkInvariants, failed } from "./invariants.ts";
import { resetToBaseline, setPrice } from "./prices.ts";
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

function loadActors(): Actors {
  const accounts = loadAccounts("settings/Devnet.toml");
  const byName = (name: string): Account => {
    const account = accounts.find((entry) => entry.name === name);
    if (!account) throw new Error(`missing devnet account: ${name}`);
    return account;
  };
  return {
    deployer: byName("deployer"),
    lp: byName("wallet_1"),
    safe: byName("wallet_2"),
    max: byName("wallet_3"),
    near: byName("wallet_4"),
    under: byName("wallet_5"),
    liquidator: byName("wallet_6"),
    staker: byName("wallet_7"),
    flash: byName("wallet_8"),
  };
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

async function runScenario(
  chain: Chain,
  actors: Actors,
  baseline: Awaited<ReturnType<typeof setup>>,
  scenario: Scenario,
): Promise<ScenarioResult> {
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
  const startedAt = new Date();
  const reportDir = `/tmp/local-e2e-${startedAt.getTime()}`;
  mkdirSync(reportDir, { recursive: true });

  const actors = loadActors();
  const chain = new Chain(actors.deployer.address);
  let devnet: DevnetHandle | null = null;
  let scenarios: ScenarioResult[] = [];
  const fuzz = { sequences: FUZZ_SEQUENCES, ops: 0, failures: 0, firstFailure: undefined as string | undefined };

  try {
    console.log(`report dir: ${reportDir}`);
    devnet = await startDevnet({ logDir: reportDir });
    console.log(`devnet up: api=${devnet.apiUrl} pid=${devnet.pid}`);

    const baseline = await setup(chain, actors);
    console.log("setup complete");

    const allScenarios = [happy, ...matrix];
    for (const scenario of allScenarios) {
      scenarios.push(await runScenario(chain, actors, baseline, scenario));
      const result = scenarios[scenarios.length - 1];
      console.log(`  ${result.passed ? "PASS" : "FAIL"} ${result.name}${result.failure ? `: ${result.failure}` : ""}`);
    }

    console.log(`fuzz: ${FUZZ_SEQUENCES} sequences`);
    for (let index = 0; index < FUZZ_SEQUENCES; index++) {
      const length = FUZZ_MIN_OPS + ((seed + index * 7919) % (FUZZ_MAX_OPS - FUZZ_MIN_OPS + 1));
      const ops = generate(seed + index, length);
      for (const op of ops) {
        fuzz.ops += 1;
        try {
          await executeOp(chain, actors, op);
        } catch (error) {
          if (!isContractAbort(error)) {
            fuzz.failures += 1;
            fuzz.firstFailure = `sequence ${index} (seed ${seed + index}) op ${JSON.stringify(op)}: ${
              error instanceof Error ? error.message : String(error)
            }`;
            break;
          }
        }
        const violations = failed(await checkInvariants(chain));
        if (violations.length > 0) {
          fuzz.failures += 1;
          fuzz.firstFailure = `sequence ${index} (seed ${seed + index}) op ${JSON.stringify(op)}: ${violations
            .map((violation) => `${violation.name}: ${violation.detail}`)
            .join("; ")}`;
          break;
        }
      }
      if (fuzz.failures > 0) break;
      if (index % 10 === 0) console.log(`  sequence ${index + 1}/${FUZZ_SEQUENCES} (${fuzz.ops} ops)`);
    }

    const finalViolations = failed(await checkInvariants(chain));
    if (finalViolations.length > 0 && fuzz.failures === 0) {
      fuzz.failures += 1;
      fuzz.firstFailure = `final invariants: ${finalViolations.map((v) => `${v.name}: ${v.detail}`).join("; ")}`;
    }

    const report = {
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      seed,
      scenarios,
      fuzz,
      devnetLog: devnet.logPath,
    };
    const paths = await writeReport(reportDir, report);
    const passed = scenarios.filter((scenario) => scenario.passed).length;
    const ok = passed === scenarios.length && fuzz.failures === 0;
    console.log(
      `\nsummary: ${passed}/${scenarios.length} scenarios passed, ${fuzz.ops} fuzz ops, seed ${seed}, ${
        (report.durationMs / 1000).toFixed(1)
      }s, ${ok ? "PASS" : "FAIL"}`,
    );
    console.log(`report: ${paths.mdPath}`);
    console.log(await proposeLearnings(report));
    return ok ? 0 : 1;
  } finally {
    if (devnet && !keep) await stopDevnet(devnet);
    if (devnet && keep) console.log(`devnet kept up (pid ${devnet.pid}); stop it with SIGTERM`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
