import { Cl } from "@stacks/transactions";
import type { Chain } from "./chain.ts";
import { collateralSettingsSane, COLLATERALS, expectedCaps, MARKET, type Actors } from "./setup.ts";
import { asOptional, asTuple, asUint, okUint } from "./values.ts";
import { convertedPrice } from "./prices.ts";
import { healthOf, positionOf } from "./reads.ts";

export type InvariantResult = { name: string; ok: boolean; detail: string };

const SCALING_FACTOR = 100_000_000n;
// Repay and liquidation split interest across lp/staked/protocol buckets with floor division, so a
// single debt operation can leave up to 2 units in open-interest that the cash received does not
// cover, plus 1 unit of share-conversion rounding. Real drift exceeds this quickly.
const ROUNDING_TOLERANCE = 3n;
const MAX_DEBT_STEP_DRIFT = 3n;

export type OpKind = "debt" | "non-debt";

export type AccountingStats = {
  drift: bigint;
  debtOps: number;
  maxStepDrift: bigint;
  exactZero: boolean;
};

let lastDrift: bigint | undefined;
let stats: AccountingStats = { drift: 0n, debtOps: 0, maxStepDrift: 0n, exactZero: true };

/** Resets the per-run accounting statistics; called once before a run. */
export function resetAccounting(): void {
  lastDrift = undefined;
  stats = { drift: 0n, debtOps: 0, maxStepDrift: 0n, exactZero: true };
}

export function accountingStats(): AccountingStats {
  return stats;
}

/** Keeps the run statistics but re-baselines the drift after a devnet restart. */
export function resetDriftBaseline(): void {
  lastDrift = undefined;
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

/**
 * The protocol invariant is `total_assets + reserve == cash + outstanding_debt`, so the gap is
 * cash + debt - reserve - totalAssets. Downward movement means value appeared from nowhere.
 */
export function accountingHolds(params: {
  totalAssets: bigint;
  reserve: bigint;
  cash: bigint;
  debt: bigint;
}): InvariantResult {
  const drift = params.cash + params.debt - params.reserve - params.totalAssets;
  return {
    name: "accounting",
    ok: abs(drift) <= ROUNDING_TOLERANCE,
    detail: `total-assets=${params.totalAssets} cash=${params.cash} debt=${params.debt} reserve=${params.reserve} drift=${drift}`,
  };
}

/**
 * Outside debt operations the accumulated gap must not move at all; a debt operation may move it by
 * at most the protocol's integer rounding residue (3 units).
 */
export function gateStepDrift(drift: bigint, kind: OpKind): InvariantResult {
  stats.drift = drift;
  if (lastDrift === undefined) {
    lastDrift = drift;
    return { name: "accounting-drift", ok: true, detail: `kind=${kind} drift=${drift} (baseline)` };
  }
  const delta = drift - lastDrift;
  lastDrift = drift;
  if (kind === "debt") stats.debtOps += 1;
  if (abs(delta) > stats.maxStepDrift) stats.maxStepDrift = abs(delta);
  if (delta !== 0n) stats.exactZero = false;
  const allowed = kind === "debt" ? MAX_DEBT_STEP_DRIFT : 0n;
  return {
    name: "accounting-drift",
    ok: abs(delta) <= allowed,
    detail: `kind=${kind} delta=${delta} drift=${drift} allowed=${allowed}`,
  };
}

// Round-robin over the run's actors so the expensive cross-checks cover every position over a run
// without adding their cost to every single step.
const probeUsers: string[] = [];
let probeIndex = 0;

// The de-listing scenario deliberately constructs the documented stuck state and asserts it; the
// exitability invariant is the general rule that a run never leaves one behind.
let exitabilitySuspended = false;

export function suspendExitability(value: boolean): void {
  exitabilitySuspended = value;
}

export function resetProbeUsers(actors: Actors): void {
  probeUsers.length = 0;
  probeUsers.push(...Object.values(actors).map((account) => account.address));
  probeIndex = 0;
}

async function healthMirror(chain: Chain): Promise<InvariantResult> {
  if (probeUsers.length === 0) {
    return { name: "health-mirror", ok: true, detail: "no probe users" };
  }
  const user = probeUsers[probeIndex++ % probeUsers.length];
  const position = await positionOf(chain, user);
  if (!position) return { name: "health-mirror", ok: true, detail: `${user}: no position` };
  // The devnet's read-only budget is 200k read length; account-health costs ~212k for two
  // collaterals, so only single-collateral positions can be cross-checked on chain.
  if (position.collaterals.length !== 1) {
    return {
      name: "health-mirror",
      ok: true,
      detail: `${user}: skipped (${position.collaterals.length} collaterals exceed the read-only budget)`,
    };
  }
  const token = position.collaterals[0].split(".").pop() ?? position.collaterals[0];
  const mirror = await healthOf(chain, user);
  const onChain = asOptional(
    await chain.read("liquidator-v1", "account-health", [
      Cl.principal(user),
      Cl.uint(convertedPrice(MARKET)),
      Cl.list([Cl.uint(convertedPrice(token))]),
    ]),
  );
  if (!onChain || !mirror) return { name: "health-mirror", ok: true, detail: `${user}: no health` };
  const chainHealth = asUint(asTuple(onChain)["position-health"]);
  return {
    name: "health-mirror",
    ok: chainHealth === mirror.positionHealth,
    detail: `${user}: contract=${chainHealth} mirror=${mirror.positionHealth}`,
  };
}

/**
 * A position must never be left in the documented stuck state: holding a de-listed collateral while
 * carrying debt is both unwithdrawable and unliquidatable.
 */
async function exitability(chain: Chain): Promise<InvariantResult> {
  const problems: string[] = [];
  const positions = await Promise.all(probeUsers.map((user) => positionOf(chain, user)));
  const checks: Array<{ user: string; token: string }> = [];
  positions.forEach((position, index) => {
    if (!position || position.debtShares === 0n) return;
    for (const collateral of position.collaterals) {
      checks.push({ user: probeUsers[index], token: collateral.split(".").pop() ?? collateral });
    }
  });
  const configured = await Promise.all(
    checks.map((check) =>
      chain
        .read("state-v1", "get-collateral", [Cl.contractPrincipal(chain.deployer, check.token)])
        .then((value) => asOptional(value) !== null),
    ),
  );
  checks.forEach((check, index) => {
    if (!configured[index]) problems.push(`${check.user}: debt with de-listed collateral ${check.token}`);
  });
  return {
    name: "exitability",
    ok: problems.length === 0,
    detail: problems.join("; ") || "no stuck positions",
  };
}

async function capsFactors(chain: Chain): Promise<InvariantResult> {
  const cp = (name: string) => Cl.contractPrincipal(chain.deployer, name);
  const names = ["lp", "debt", ...COLLATERALS];
  const values = await Promise.all(
    names.map((name, index) =>
      index === 0
        ? chain.read("withdrawal-caps-v1", "get-lp-cap-factor")
        : index === 1
          ? chain.read("withdrawal-caps-v1", "get-debt-cap-factor")
          : chain.read("withdrawal-caps-v1", "get-collateral-cap-factor", [cp(name)]),
    ),
  );
  const entries: Array<[string, bigint]> = names.map((name, index) => [name, asUint(values[index])]);
  const bad = entries.filter(([, factor]) => factor < 0n || factor > SCALING_FACTOR);
  return {
    name: "caps-factors",
    ok: bad.length === 0,
    detail: bad.length === 0 ? entries.map(([k, v]) => `${k}=${v}`).join(" ") : `out of bounds: ${JSON.stringify(bad)}`,
  };
}

function bucketBounds(
  label: string,
  bucket: bigint,
  liquidity: bigint,
  factor: bigint,
): string | null {
  const max = factor === 0n ? liquidity : (liquidity * factor) / SCALING_FACTOR;
  // A deposit/repay is an inflow on top of the refilled max; nothing can exceed max + liquidity.
  if (bucket > max + liquidity) return `${label}: bucket ${bucket} above ${max + liquidity}`;
  return null;
}

async function capsBuckets(chain: Chain): Promise<InvariantResult> {
  const stateContract = Cl.contractPrincipal(chain.deployer, "state-v1");
  const cp = (name: string) => Cl.contractPrincipal(chain.deployer, name);
  const windows = await Promise.all([
    chain.read("withdrawal-caps-v1", "get-refill-time-window"),
    chain.read("withdrawal-caps-v1", "get-decay-time-window"),
  ]);
  const values = await Promise.all([
    chain.read("withdrawal-caps-v1", "get-lp-bucket"),
    chain.read("withdrawal-caps-v1", "get-lp-cap-factor"),
    chain.read(MARKET, "get-balance", [stateContract]),
    chain.read("withdrawal-caps-v1", "get-debt-bucket"),
    chain.read("withdrawal-caps-v1", "get-debt-cap-factor"),
    chain.read("state-v1", "get-borrowable-balance"),
    ...COLLATERALS.flatMap((token) => [
      chain.read("withdrawal-caps-v1", "get-collateral-bucket", [cp(token)]),
      chain.read("withdrawal-caps-v1", "get-collateral-cap-factor", [cp(token)]),
      chain.read(token, "get-balance", [stateContract]),
    ]),
  ]);
  const problems: string[] = [];
  const expected = expectedCaps();
  const refill = asUint(windows[0]);
  const decay = asUint(windows[1]);
  if (refill !== expected.refill) problems.push(`refill window ${refill} != ${expected.refill}`);
  if (decay !== expected.decay) problems.push(`decay window ${decay} != ${expected.decay}`);
  const lp = bucketBounds("lp", asUint(values[0]), okUint(values[2]), asUint(values[1]));
  if (lp) problems.push(lp);
  const debt = bucketBounds("debt", asUint(values[3]), asUint(values[5]), asUint(values[4]));
  if (debt) problems.push(debt);
  COLLATERALS.forEach((token, index) => {
    const base = 6 + index * 3;
    const problem = bucketBounds(token, asUint(values[base]), okUint(values[base + 2]), asUint(values[base + 1]));
    if (problem) problems.push(problem);
  });
  return { name: "caps-buckets", ok: problems.length === 0, detail: problems.join("; ") || "within bounds" };
}

async function openInterestCoversPrincipal(chain: Chain): Promise<InvariantResult> {
  const debt = asTuple(await chain.read("state-v1", "get-debt-params"));
  const openInterest = asUint(debt["open-interest"]);
  const borrowed = asTuple(
    await chain.read("state-v1", "get-borrow-repay-params", [Cl.principal(chain.deployer)]),
  );
  const totalBorrowed = asUint(borrowed["total-borrowed-amount"]);
  return {
    name: "open-interest-covers-principal",
    ok: openInterest >= totalBorrowed,
    detail: `open-interest=${openInterest} total-borrowed=${totalBorrowed}`,
  };
}

export async function checkInvariants(chain: Chain, kind: OpKind = "non-debt"): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  const stateContract = Cl.contractPrincipal(chain.deployer, "state-v1");
  const [lpValue, supplyValue, reserveValue, cashValue, debtValue, caps, buckets, interest, configs, health, exit] =
    await Promise.all([
      chain.read("state-v1", "get-lp-params"),
      chain.read("state-v1", "get-total-supply"),
      chain.read("state-v1", "get-reserve-balance"),
      chain.read(MARKET, "get-balance", [stateContract]),
      chain.read("state-v1", "get-debt-params"),
      capsFactors(chain),
      capsBuckets(chain),
      openInterestCoversPrincipal(chain),
      collateralSettingsSane(chain),
      healthMirror(chain),
      exitabilitySuspended
        ? Promise.resolve({
            name: "exitability",
            ok: true,
            detail: "suspended while the de-listing scenario constructs the stuck state",
          })
        : exitability(chain),
    ]);
  const lp = asTuple(lpValue);
  const reserve = asUint(reserveValue);
  const cash = okUint(cashValue);
  const debt = asTuple(debtValue);
  const totalAssets = asUint(lp["total-assets"]);
  const openInterest = asUint(debt["open-interest"]);
  // total_assets + reserve == cash + debt; the gap is cash + debt - reserve - total_assets.
  const drift = cash + openInterest - reserve - totalAssets;

  results.push({
    name: "accounting",
    ok: drift >= -ROUNDING_TOLERANCE,
    detail: `total-assets=${totalAssets} cash=${cash} debt=${openInterest} reserve=${reserve} drift=${drift}`,
  });
  results.push(gateStepDrift(drift, kind));
  const supply = okUint(supplyValue);
  const shares = asUint(lp["total-shares"]);
  results.push({
    name: "lp-shares",
    ok: supply === shares,
    detail: `total-supply=${supply} total-shares=${shares}`,
  });
  results.push(caps);
  results.push(buckets);
  results.push(interest);
  results.push({ name: "collateral-configs", ok: configs.ok, detail: configs.detail });
  results.push(health);
  results.push(exit);
  return results;
}

export function failed(results: InvariantResult[]): InvariantResult[] {
  return results.filter((result) => !result.ok);
}
