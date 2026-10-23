import { Cl } from "@stacks/transactions";
import type { Chain } from "./chain.ts";
import { convertedPrice } from "./prices.ts";
import { collateralSettingsOf } from "./setup.ts";
import { asList, asOptional, asPrincipal, asTuple, asUint, okUint } from "./values.ts";

export type Position = {
  debtShares: bigint;
  collaterals: string[];
  borrowedAmount: bigint;
  borrowedBlock: bigint;
};

export const tokenName = (principal: string): string => principal.split(".").pop() ?? principal;

export async function positionOf(chain: Chain, user: string): Promise<Position | null> {
  const stored = asOptional(await chain.read("state-v1", "get-user-position", [Cl.principal(user)]));
  if (!stored) return null;
  const tuple = asTuple(stored);
  return {
    debtShares: asUint(tuple["debt-shares"]),
    collaterals: asList(tuple.collaterals).map(asPrincipal),
    borrowedAmount: asUint(tuple["borrowed-amount"]),
    borrowedBlock: asUint(tuple["borrowed-block"]),
  };
}

export async function userCollateral(chain: Chain, user: string, token: string): Promise<bigint> {
  const stored = asOptional(
    await chain.read("state-v1", "get-user-collateral", [
      Cl.principal(user),
      Cl.contractPrincipal(chain.deployer, token),
    ]),
  );
  if (!stored) return 0n;
  return asUint(asTuple(stored).amount);
}

export type Health = {
  positionHealth: bigint;
  totalLiquidLtv: bigint;
  currentDebt: bigint;
  currentDebtAdjusted: bigint;
  collaterals: string[];
};

const SCALING = 100_000_000n;

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  denominator === 0n ? numerator : (numerator + denominator - 1n) / denominator;

/**
 * Mirrors liquidator-v1.account-health. The devnet's read-only call budget (200k read length) is
 * below what that function costs for a multi-collateral position, so the harness computes it from
 * live state instead; liquidations themselves still run the contract's own check on chain.
 */
export async function healthOf(chain: Chain, user: string): Promise<Health | null> {
  const position = await positionOf(chain, user);
  if (!position) return null;

  const debt = asTuple(await chain.read("state-v1", "get-debt-params"));
  const openInterest = asUint(debt["open-interest"]);
  const totalDebtShares = asUint(debt["total-debt-shares"]);
  const currentDebt =
    totalDebtShares === 0n ? position.debtShares : ceilDiv(openInterest * position.debtShares, totalDebtShares);
  const marketPrice = convertedPrice("mock-usdc");
  const currentDebtAdjusted = ceilDiv(currentDebt * marketPrice, SCALING);

  let totalLiquidLtv = 0n;
  for (const token of position.collaterals) {
    const name = tokenName(token);
    const amount = await userCollateral(chain, user, name);
    const price = convertedPrice(name);
    let liquidationLtv = 0n;
    let decimals = 8n;
    try {
      const config = await collateralSettingsOf(chain, name);
      liquidationLtv = config.liquidationLtv;
      decimals = config.decimals;
    } catch {
      // A de-listed collateral contributes no liquidation value, exactly as the contract defaults it.
    }
    const rawValue = (amount * price) / SCALING;
    const fixedValue = decimals > 8n ? rawValue / 10n ** (decimals - 8n) : rawValue * 10n ** (8n - decimals);
    totalLiquidLtv += (fixedValue * liquidationLtv) / SCALING;
  }

  const positionHealth = currentDebtAdjusted > 0n ? (totalLiquidLtv * SCALING) / currentDebtAdjusted : SCALING;
  return { positionHealth, totalLiquidLtv, currentDebt, currentDebtAdjusted, collaterals: position.collaterals };
}

export async function lpBalance(chain: Chain, user: string): Promise<bigint> {
  return okUint(await chain.read("state-v1", "get-balance", [Cl.principal(user)]));
}

export async function stakedBalance(chain: Chain, user: string): Promise<bigint> {
  return okUint(await chain.read("staking-v1", "get-balance", [Cl.principal(user)]));
}

export async function totalStakedLpTokens(chain: Chain): Promise<bigint> {
  return asUint(await chain.read("staking-v1", "get-total-staked-lp-tokens"));
}

export async function reserveBalance(chain: Chain): Promise<bigint> {
  return asUint(await chain.read("state-v1", "get-reserve-balance"));
}

export async function tokenBalance(chain: Chain, token: string, owner: string): Promise<bigint> {
  return okUint(await chain.read(token, "get-balance", [Cl.principal(owner)]));
}
