import { Cl } from "@stacks/transactions";
import type { Chain } from "./chain.ts";
import { collateralSettingsSane, COLLATERALS, MARKET } from "./setup.ts";
import { asTuple, asUint, okUint } from "./values.ts";

export type InvariantResult = { name: string; ok: boolean; detail: string };

const SCALING_FACTOR = 100_000_000n;
// Repay and liquidation split interest across lp/staked/protocol buckets with floor division, so a
// single debt operation can leave up to 2 units in open-interest that the cash received does not
// cover, plus 1 unit of share-conversion rounding. Real drift exceeds this quickly.
const ROUNDING_TOLERANCE = 3n;

/**
 * The 89572 invariant: LP assets are backed by cash on hand, outstanding debt and the reserve
 * balance, up to the protocol's own integer rounding precision.
 */
export function accountingHolds(params: {
  totalAssets: bigint;
  reserve: bigint;
  cash: bigint;
  debt: bigint;
}): InvariantResult {
  const expected = params.cash + params.debt + params.reserve;
  const drift = expected - params.totalAssets;
  return {
    name: "accounting",
    ok: drift >= -ROUNDING_TOLERANCE && drift <= ROUNDING_TOLERANCE,
    detail: `total-assets=${params.totalAssets} cash=${params.cash} debt=${params.debt} reserve=${params.reserve} (cash+debt+reserve=${expected}, drift=${drift})`,
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

  // One parallel batch: the invariant set is unchanged, only the round-trips overlap.
  const stateContract = Cl.contractPrincipal(chain.deployer, "state-v1");
  const [lpValue, reserveValue, cashValue, debtValue, caps, interest, configs] = await Promise.all([
    chain.read("state-v1", "get-lp-params"),
    chain.read("state-v1", "get-reserve-balance"),
    chain.read(MARKET, "get-balance", [stateContract]),
    chain.read("state-v1", "get-debt-params"),
    capsFactors(chain),
    openInterestCoversPrincipal(chain),
    collateralSettingsSane(chain),
  ]);
  const lp = asTuple(lpValue);
  const reserve = asUint(reserveValue);
  const cash = okUint(cashValue);
  const debt = asTuple(debtValue);
  const totalAssets = asUint(lp["total-assets"]);
  const openInterest = asUint(debt["open-interest"]);
  const drift = cash + openInterest + reserve - totalAssets;
  // Negative drift means the protocol holds more value than its books claim; that is never rounding.
  // Positive drift is the floor-split residue and is bounded per operation by the delta check.
  results.push({
    name: "accounting",
    ok: drift >= -ROUNDING_TOLERANCE,
    detail: `total-assets=${totalAssets} cash=${cash} debt=${openInterest} reserve=${reserve} drift=${drift}`,
  });
  results.push(gateStepDrift(drift, kind));
  results.push(caps);
  results.push(interest);
  results.push({ name: "collateral-configs", ok: configs.ok, detail: configs.detail });

  return results;
}

export function failed(results: InvariantResult[]): InvariantResult[] {
  return results.filter((result) => !result.ok);
}

export type OpKind = "debt" | "non-debt";

export type AccountingStats = {
  drift: bigint;
  debtOps: number;
  maxStepDrift: bigint;
  exactZero: boolean;
};

const MAX_DEBT_STEP_DRIFT = 3n;

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
 * Outside debt operations the accumulated gap must not move at all; a debt operation may move it by
 * at most the protocol's integer rounding residue (3 units).
 */
function gateStepDrift(drift: bigint, kind: OpKind): InvariantResult {
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
