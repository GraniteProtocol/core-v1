import { Cl } from "@stacks/transactions";
import type { Chain } from "./chain.ts";
import { collateralSettingsSane, COLLATERALS, MARKET } from "./setup.ts";
import { asTuple, asUint, okUint } from "./values.ts";

export type InvariantResult = { name: string; ok: boolean; detail: string };

const SCALING_FACTOR = 100_000_000n;

/**
 * The 89572 invariant: LP assets are backed exactly by cash on hand, outstanding debt and the
 * reserve balance, with no value created or lost between them.
 */
export function accountingHolds(params: {
  totalAssets: bigint;
  reserve: bigint;
  cash: bigint;
  debt: bigint;
}): InvariantResult {
  const expected = params.cash + params.debt + params.reserve;
  return {
    name: "accounting",
    ok: params.totalAssets === expected,
    detail: `total-assets=${params.totalAssets} cash=${params.cash} debt=${params.debt} reserve=${params.reserve} (cash+debt+reserve=${expected})`,
  };
}

async function capsFactors(chain: Chain): Promise<InvariantResult> {
  const cp = (name: string) => Cl.contractPrincipal(chain.deployer, name);
  const entries: Array<[string, bigint]> = [
    ["lp", asUint(await chain.read("withdrawal-caps-v1", "get-lp-cap-factor"))],
    ["debt", asUint(await chain.read("withdrawal-caps-v1", "get-debt-cap-factor"))],
  ];
  for (const token of COLLATERALS) {
    entries.push([token, asUint(await chain.read("withdrawal-caps-v1", "get-collateral-cap-factor", [cp(token)]))]);
  }
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

export async function checkInvariants(chain: Chain): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];

  const lp = asTuple(await chain.read("state-v1", "get-lp-params"));
  const reserve = asUint(await chain.read("state-v1", "get-reserve-balance"));
  const cash = okUint(await chain.read(MARKET, "get-balance", [Cl.contractPrincipal(chain.deployer, "state-v1")]));
  const debt = asTuple(await chain.read("state-v1", "get-debt-params"));
  results.push(
    accountingHolds({
      totalAssets: asUint(lp["total-assets"]),
      reserve,
      cash,
      debt: asUint(debt["open-interest"]),
    }),
  );

  const totalShares = asUint(lp["total-shares"]);
  results.push({
    name: "lp-shares",
    ok: totalShares > 0n || asUint(lp["total-assets"]) === 0n,
    detail: `total-assets=${asUint(lp["total-assets"])} total-shares=${totalShares}`,
  });

  results.push(await capsFactors(chain));
  results.push(await openInterestCoversPrincipal(chain));

  const configs = await collateralSettingsSane(chain);
  results.push({ name: "collateral-configs", ok: configs.ok, detail: configs.detail });

  return results;
}

export function failed(results: InvariantResult[]): InvariantResult[] {
  return results.filter((result) => !result.ok);
}
