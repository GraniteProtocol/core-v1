import { Cl } from "@stacks/transactions";
import type { Chain } from "./chain.ts";
import { COLLATERALS, expectedCaps, MARKET, type Actors } from "./setup.ts";
import { asOptional, asTuple, asUint, okUint } from "./values.ts";
import { healthOf, positionOf } from "./reads.ts";

export type InvariantResult = { name: string; ok: boolean; detail: string };

const SCALING_FACTOR = 100_000_000n;
// The split conserves its remainder, so only share rounding moves the surplus.
const ROUNDING_TOLERANCE = 2n;
const MAX_DEBT_STEP_DRIFT = 2n;

export type OpKind = "debt" | "non-debt";

export type AccountingStats = {
  drift: bigint;
  debtOps: number;
  maxStepDrift: bigint;
  exactZero: boolean;
  protocolOpenInterest: bigint;
  rawGap: bigint;
};

let lastDrift: bigint | undefined;
let stats: AccountingStats = {
  drift: 0n,
  debtOps: 0,
  maxStepDrift: 0n,
  exactZero: true,
  protocolOpenInterest: 0n,
  rawGap: 0n,
};

/** Resets the per-run accounting statistics; called once before a run. */
export function resetAccounting(): void {
  lastDrift = undefined;
  stats = {
    drift: 0n,
    debtOps: 0,
    maxStepDrift: 0n,
    exactZero: true,
    protocolOpenInterest: 0n,
    rawGap: 0n,
  };
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
 * Checks cash + (debt - protocol-open-interest) - reserve - totalAssets against the floor residue.
 * Uncollected protocol interest backs no claim until a repay collects it.
 */
export function accountingSurplus(params: {
  totalAssets: bigint;
  reserve: bigint;
  cash: bigint;
  debt: bigint;
  protocolOpenInterest: bigint;
}): bigint {
  // A bad-debt write-off receives debt already net of the protocol part, so it moves the surplus by zero.
  return params.cash + params.debt - params.protocolOpenInterest - params.reserve - params.totalAssets;
}

export function accountingHolds(
  params: {
    totalAssets: bigint;
    reserve: bigint;
    cash: bigint;
    debt: bigint;
    protocolOpenInterest: bigint;
  },
  maxDrift: bigint = ROUNDING_TOLERANCE,
): InvariantResult {
  const surplus = accountingSurplus(params);
  const rawGap = params.cash + params.debt - params.reserve - params.totalAssets;
  stats.protocolOpenInterest = params.protocolOpenInterest;
  stats.rawGap = rawGap;
  return {
    name: "accounting",
    ok: surplus >= 0n && surplus <= maxDrift,
    detail: `total-assets=${params.totalAssets} cash=${params.cash} debt=${params.debt} reserve=${params.reserve} protocol-open-interest=${params.protocolOpenInterest} surplus=${surplus} raw=${rawGap} allowed<=${maxDrift}`,
  };
}

/** Only a landed debt operation may move the surplus, upward, by at most MAX_DEBT_STEP_DRIFT. */
export function gateStepDrift(surplus: bigint, kind: OpKind, applied = true): InvariantResult {
  stats.drift = surplus;
  if (lastDrift === undefined) {
    lastDrift = surplus;
    return {
      name: "accounting-drift",
      ok: surplus === 0n,
      detail: `kind=${kind} surplus=${surplus} (baseline, must be 0)`,
    };
  }
  const delta = surplus - lastDrift;
  lastDrift = surplus;
  const isDebt = kind === "debt" && applied;
  if (isDebt) stats.debtOps += 1;
  if (abs(delta) > stats.maxStepDrift) stats.maxStepDrift = abs(delta);
  if (delta !== 0n) stats.exactZero = false;
  const allowed = isDebt ? MAX_DEBT_STEP_DRIFT : 0n;
  return {
    name: "accounting-drift",
    ok: delta >= 0n && delta <= allowed,
    detail: `kind=${kind} delta=${delta} surplus=${surplus} allowed=0..${allowed}`,
  };
}

// Round-robin over the run's actors so the expensive cross-checks cover every position over a run
// without adding their cost to every single step.
const probeUsers: string[] = [];
let probeIndex = 0;

// The de-listing scenario constructs the stuck state on purpose, so it suspends this check.
let exitabilitySuspended = false;

export function suspendExitability(value: boolean): void {
  exitabilitySuspended = value;
}

export function resetProbeUsers(actors: Actors): void {
  probeUsers.length = 0;
  probeUsers.push(...Object.values(actors).map((account) => account.address));
  probeIndex = 0;
}

/** Adds a scenario-created account so the position checks see it too. */
export function registerProbeUser(address: string): void {
  if (!probeUsers.includes(address)) probeUsers.push(address);
}

export type CapsSnapshot = {
  refillWindow: string;
  decayWindow: string;
  lp: { bucket: string; factor: string; max: string };
  debt: { bucket: string; factor: string; max: string };
  collateral: Record<string, { bucket: string; factor: string; max: string }>;
};

/** Final bucket/factor values for the run report. */
export async function capsSnapshot(chain: Chain): Promise<CapsSnapshot> {
  const stateContract = Cl.contractPrincipal(chain.deployer, "state-v1");
  const cp = (name: string) => Cl.contractPrincipal(chain.deployer, name);
  const [refill, decay, lpBucket, lpFactor, liquidity, debtBucket, debtFactor, borrowable, ...rest] =
    await Promise.all([
      chain.read("withdrawal-caps-v1", "get-refill-time-window"),
      chain.read("withdrawal-caps-v1", "get-decay-time-window"),
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
  const maxOf = (liquidityValue: bigint, factor: bigint): string =>
    factor === 0n ? "unlimited" : ((liquidityValue * factor) / SCALING_FACTOR).toString();
  const collateral: CapsSnapshot["collateral"] = {};
  COLLATERALS.forEach((token, index) => {
    const base = index * 3;
    const factor = asUint(rest[base + 1]);
    collateral[token] = {
      bucket: asUint(rest[base]).toString(),
      factor: factor.toString(),
      max: maxOf(okUint(rest[base + 2]), factor),
    };
  });
  const lpFactorValue = asUint(lpFactor);
  const debtFactorValue = asUint(debtFactor);
  return {
    refillWindow: asUint(refill).toString(),
    decayWindow: asUint(decay).toString(),
    lp: {
      bucket: asUint(lpBucket).toString(),
      factor: lpFactorValue.toString(),
      max: maxOf(okUint(liquidity), lpFactorValue),
    },
    debt: {
      bucket: asUint(debtBucket).toString(),
      factor: debtFactorValue.toString(),
      max: maxOf(asUint(borrowable), debtFactorValue),
    },
    collateral,
  };
}

async function debtHealth(chain: Chain): Promise<InvariantResult> {
  // account-health exceeds the devnet's call-read budget; the mirror's positive health stands in.
  if (probeUsers.length === 0) return { name: "position-health", ok: true, detail: "no probe users" };
  const user = probeUsers[probeIndex++ % probeUsers.length];
  const position = await positionOf(chain, user);
  if (!position || position.debtShares === 0n) {
    return { name: "position-health", ok: true, detail: `${user}: no debt` };
  }
  const health = await healthOf(chain, user);
  return {
    name: "position-health",
    ok: health !== null && health.positionHealth > 0n,
    detail: `${user}: health ${health?.positionHealth ?? "unreadable"}`,
  };
}

/**
 * A position must never be left in the documented stuck state: holding a de-listed collateral while
 * carrying debt is both unwithdrawable and unliquidatable.
 */
// Probing every account on every step costs ~29 position reads and dominates the per-op time. A
// rotating window still covers all of them over a handful of steps.
const PROBE_WINDOW = 4;

async function exitability(chain: Chain): Promise<InvariantResult> {
  const problems: string[] = [];
  const users =
    probeUsers.length <= PROBE_WINDOW
      ? probeUsers
      : Array.from({ length: PROBE_WINDOW }, (_, offset) => probeUsers[(probeIndex + offset) % probeUsers.length]);
  if (probeUsers.length > PROBE_WINDOW) probeIndex = (probeIndex + PROBE_WINDOW) % probeUsers.length;
  const positions = await Promise.all(users.map((user) => positionOf(chain, user)));
  const checks: Array<{ user: string; token: string }> = [];
  positions.forEach((position, index) => {
    if (!position || position.debtShares === 0n) return;
    for (const collateral of position.collaterals) {
      checks.push({ user: users[index], token: collateral.split(".").pop() ?? collateral });
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
  // A bucket is a withdrawal credit, not a liquidity measure, so only its windows are bounded here.
  const buckets = [
    `lp=${asUint(values[0])}`,
    `debt=${asUint(values[3])}`,
    ...COLLATERALS.map((token, index) => `${token}=${asUint(values[6 + index * 3])}`),
  ];
  return {
    name: "caps-buckets",
    ok: problems.length === 0,
    detail: `${problems.join("; ") || "windows in bounds"}; buckets ${buckets.join(" ")}`,
  };
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

export async function checkInvariants(
  chain: Chain,
  kind: OpKind = "non-debt",
  applied = true,
): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  const stateContract = Cl.contractPrincipal(chain.deployer, "state-v1");
  const [lpValue, reserveValue, cashValue, debtValue, interestValue, buckets, principal, health, exit] =
    await Promise.all([
      chain.read("state-v1", "get-lp-params"),
      chain.read("state-v1", "get-reserve-balance"),
      chain.read(MARKET, "get-balance", [stateContract]),
      chain.read("state-v1", "get-debt-params"),
      chain.read("state-v1", "get-open-interest"),
      capsBuckets(chain),
      openInterestCoversPrincipal(chain),
      debtHealth(chain),
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
  const protocolOpenInterest = asUint(asTuple(interestValue)["protocol-open-interest"]);
  // The cumulative ceiling is MAX_DEBT_STEP_DRIFT per landed debt operation; count it first.
  const step = gateStepDrift(
    cash + openInterest - protocolOpenInterest - reserve - totalAssets,
    kind,
    applied,
  );
  const maxDrift = MAX_DEBT_STEP_DRIFT * BigInt(Math.max(stats.debtOps, 1));
  results.push(
    accountingHolds({ totalAssets, reserve, cash, debt: openInterest, protocolOpenInterest }, maxDrift),
  );
  results.push(step);
  results.push(buckets);
  results.push(principal);
  results.push(health);
  results.push(exit);
  return results;
}

export function failed(results: InvariantResult[]): InvariantResult[] {
  return results.filter((result) => !result.ok);
}
