import { Cl, type ClarityValue } from "@stacks/transactions";
import type { Chain } from "./chain.ts";
import type { Account } from "./keys.ts";
import { convertedPrice, FEED_IDS, MIN_CONFIDENCE_RATIOS, setPrice } from "./prices.ts";
import { asOptional, asTuple, asUint, okUint } from "./values.ts";
import { TEST_PUBKEY } from "../tests/lazer.ts";

export type Actors = {
  deployer: Account;
  lp: Account;
  safe: Account;
  max: Account;
  near: Account;
  under: Account;
  liquidator: Account;
  staker: Account;
  flash: Account;
};

export const MARKET = "mock-usdc";
export const BTC = "mock-btc";
export const ETH = "mock-eth";
export const STX = "stx-sip010";
export const COLLATERALS = [BTC, ETH, STX];

export const MINIMUM_INITIAL_DEPOSIT = 1000n;
const MAX_UINT = (1n << 128n) - 1n;
const FAR_FUTURE = 100_000_000_000n;
const WIDE_STALENESS = 100_000_000_000_000n;

export type CollateralConfig = {
  maxLtv: bigint;
  liquidationLtv: bigint;
  liquidationPremium: bigint;
  decimals: bigint;
};

export type Snapshot = {
  balances: Record<string, Record<string, bigint>>;
  collaterals: Record<string, CollateralConfig>;
  caps: { refill: bigint; decay: bigint; collateral: Record<string, bigint> };
  lp: { totalAssets: bigint; totalShares: bigint };
  debt: { openInterest: bigint; totalDebtShares: bigint };
};

export const expectedCollateralConfigs = (): Record<string, CollateralConfig> => ({
  [BTC]: { maxLtv: 70_000_000n, liquidationLtv: 80_000_000n, liquidationPremium: 10_000_000n, decimals: 8n },
  [ETH]: { maxLtv: 50_000_000n, liquidationLtv: 70_000_000n, liquidationPremium: 10_000_000n, decimals: 8n },
  [STX]: { maxLtv: 50_000_000n, liquidationLtv: 70_000_000n, liquidationPremium: 10_000_000n, decimals: 6n },
});

// Short windows keep the caps scenarios inside the timed budget; the arithmetic is identical.
export const expectedCaps = (): { refill: bigint; decay: bigint; collateral: Record<string, bigint> } => ({
  refill: 8n,
  decay: 4n,
  collateral: { [BTC]: 80_000_000n, [ETH]: 50_000_000n, [STX]: 50_000_000n },
});

const principal = (address: string) => Cl.principal(address);
const contractPrincipal = (address: string, name: string) => Cl.contractPrincipal(address, name);

export async function mint(
  chain: Chain,
  deployer: Account,
  token: string,
  amount: bigint,
  to: string | ClarityValue,
): Promise<void> {
  await chain.call(deployer, token, "mint", [Cl.uint(amount), typeof to === "string" ? principal(to) : to]);
}

export async function balanceOf(chain: Chain, token: string, owner: string): Promise<bigint> {
  return okUint(await chain.read(token, "get-balance", [principal(owner)]));
}

export async function collateralSettingsIfConfigured(
  chain: Chain,
  token: string,
): Promise<CollateralConfig | null> {
  const stored = asOptional(await chain.read("state-v1", "get-collateral", [contractPrincipal(chain.deployer, token)]));
  if (!stored) return null;
  const tuple = asTuple(stored);
  return {
    maxLtv: asUint(tuple["max-ltv"]),
    liquidationLtv: asUint(tuple["liquidation-ltv"]),
    liquidationPremium: asUint(tuple["liquidation-premium"]),
    decimals: asUint(tuple.decimals),
  };
}

export async function collateralSettingsOf(chain: Chain, token: string): Promise<CollateralConfig> {
  const config = await collateralSettingsIfConfigured(chain, token);
  if (!config) throw new Error(`collateral not configured: ${token}`);
  return config;
}

export async function lpParams(chain: Chain): Promise<{ totalAssets: bigint; totalShares: bigint }> {
  const tuple = asTuple(await chain.read("state-v1", "get-lp-params"));
  return { totalAssets: asUint(tuple["total-assets"]), totalShares: asUint(tuple["total-shares"]) };
}

export async function debtParams(chain: Chain): Promise<{ openInterest: bigint; totalDebtShares: bigint }> {
  const tuple = asTuple(await chain.read("state-v1", "get-debt-params"));
  return { openInterest: asUint(tuple["open-interest"]), totalDebtShares: asUint(tuple["total-debt-shares"]) };
}

export async function snapshot(chain: Chain, actors: Actors): Promise<Snapshot> {
  const owners = Object.values(actors).map((a) => a.address);
  const balances: Record<string, Record<string, bigint>> = {};
  for (const token of [MARKET, BTC, ETH, STX]) {
    balances[token] = {};
    for (const owner of owners) balances[token][owner] = await balanceOf(chain, token, owner);
  }
  const collaterals: Record<string, CollateralConfig> = {};
  for (const token of COLLATERALS) collaterals[token] = await collateralSettingsOf(chain, token);
  return {
    balances,
    collaterals,
    caps: {
      refill: asUint(await chain.read("withdrawal-caps-v1", "get-refill-time-window")),
      decay: asUint(await chain.read("withdrawal-caps-v1", "get-decay-time-window")),
      collateral: {
        [BTC]: asUint(await chain.read("withdrawal-caps-v1", "get-collateral-cap-factor", [contractPrincipal(chain.deployer, BTC)])),
        [ETH]: asUint(await chain.read("withdrawal-caps-v1", "get-collateral-cap-factor", [contractPrincipal(chain.deployer, ETH)])),
        [STX]: asUint(await chain.read("withdrawal-caps-v1", "get-collateral-cap-factor", [contractPrincipal(chain.deployer, STX)])),
      },
    },
    lp: await lpParams(chain),
    debt: await debtParams(chain),
  };
}

/** Funds actors and configures the market the way the spec describes. */
export async function setup(chain: Chain, actors: Actors): Promise<Snapshot> {
  const deployer = actors.deployer.address;
  const cp = (name: string) => contractPrincipal(chain.deployer, name);
  const call = (contract: string, fn: string, args: ClarityValue[], from: Account = actors.deployer) =>
    chain.call(from, contract, fn, args);

  // 1. Interest and reward modules first: initialize mints dust through a deposit, and every
  // deposit accrues interest through both modules.
  await call("linear-kinked-ir-v1", "update-ir-params", [
    Cl.uint(750_000_000_000),
    Cl.uint(1_500_000_000_000),
    Cl.uint(700_000_000_000),
    Cl.uint(300_000_000_000),
  ]);
  await call("staking-reward-v1", "update-reward-params", [
    Cl.int(-50_000_000),
    Cl.int(-70_000_000),
    Cl.uint(70_000_000),
    Cl.uint(30_000_000),
  ]);
  // A zero minimum stake skips the deployer dust stake, which would need LP tokens it does not hold.
  await call("staking-v1", "initialize", [Cl.some(Cl.uint(0))]);
  // 2 blocks instead of 100 keeps the unstake scenario short on the devnet.
  await call("staking-v1", "update-withdrawal-finalization-period", [Cl.uint(2)]);

  // 2. Allow the contracts that move assets through state-v1.
  for (const name of [
    "liquidity-provider-v1",
    "borrower-v1",
    "liquidator-v1",
    "staking-v1",
    "test-gifter",
    "flash-loan-v1",
  ]) {
    await call("state-v1", "set-allowed-contract", [cp(name)]);
  }
  await call("flash-loan-v1", "set-allowed-contract", [cp("mock-flash-loan-callback")]);
  await call("flash-loan-v1", "set-allowed-contract", [cp("mock-liquidator-with-flash-loan")]);

  // 3. Seed and initialize the LP.
  await call("state-v1", "update-asset-cap", [Cl.uint(MAX_UINT)]);
  await mint(chain, actors.deployer, MARKET, MINIMUM_INITIAL_DEPOSIT, deployer);
  await call("liquidity-provider-v1", "initialize", []);

  // 4. Collateral settings for the three collaterals.
  for (const [token, config] of Object.entries(expectedCollateralConfigs())) {
    await call("state-v1", "update-collateral-settings", [
      cp(token),
      Cl.uint(config.maxLtv),
      Cl.uint(config.liquidationLtv),
      Cl.uint(config.liquidationPremium),
      Cl.uint(config.decimals),
    ]);
  }

  // 5. Withdrawal caps and their timing windows.
  const caps = expectedCaps();
  for (const [token, factor] of Object.entries(caps.collateral)) {
    await call("withdrawal-caps-v1", "set-collateral-cap", [cp(token), Cl.uint(factor)]);
  }
  await call("withdrawal-caps-v1", "set-refill-time-window", [Cl.uint(caps.refill)]);
  await call("withdrawal-caps-v1", "set-decay-time-window", [Cl.uint(caps.decay)]);

  // 6. Fund the actors from the mock tokens (the market token and both mock collaterals use 8 decimals).
  const usdc = 100_000_000n;
  await mint(chain, actors.deployer, MARKET, 2_000_000n * usdc, actors.lp.address);
  await mint(chain, actors.deployer, MARKET, 2_000_000n * usdc, actors.staker.address);
  await mint(chain, actors.deployer, MARKET, 1_000_000n * usdc, actors.liquidator.address);
  await mint(chain, actors.deployer, MARKET, 1_000_000n * usdc, deployer);
  await mint(chain, actors.deployer, MARKET, 100n * usdc, cp("mock-flash-loan-callback"));
  await mint(chain, actors.deployer, MARKET, 100_000n * usdc, cp("mock-liquidator-with-flash-loan"));
  for (const borrower of [actors.safe, actors.max, actors.near, actors.under]) {
    await mint(chain, actors.deployer, BTC, 100n * 100_000_000n, borrower.address);
    await mint(chain, actors.deployer, ETH, 1000n * 100_000_000n, borrower.address);
  }
  // Seed the staker with LP tokens so stake/unstake fuzz ops can actually succeed.
  await chain.call(actors.staker, "liquidity-provider-v1", "deposit", [
    Cl.uint(10_000n * usdc),
    Cl.principal(actors.staker.address),
  ]);

  // 7. Prices and the Lazer oracle the adapter verifies against.
  setPrice(MARKET, 1n);
  setPrice(BTC, 60_000n);
  setPrice(ETH, 3_000n);
  setPrice(STX, 2n);

  await chain.call(actors.deployer, "pyth-lazer-oracle", "set-trusted-signers", [
    Cl.list([
      Cl.tuple({
        pubkey: Cl.buffer(TEST_PUBKEY),
        "expires-at": Cl.uint(FAR_FUTURE),
      }),
    ]),
  ]);
  await chain.call(actors.deployer, "pyth-lazer-oracle", "set-stale-price-threshold", [Cl.uint(WIDE_STALENESS)]);
  for (const token of [MARKET, BTC, ETH, STX]) {
    const { feedId, minConfidenceRatio } = feedConfig(token);
    await chain.call(actors.deployer, "pyth-adapter-v1", "update-price-feed-id", [
      cp(token),
      Cl.uint(feedId),
      Cl.uint(minConfidenceRatio),
    ]);
  }
  await chain.call(actors.deployer, "pyth-adapter-v1", "update-time-delta", [Cl.uint(300)]);

  // 8. Baseline snapshot.
  return snapshot(chain, actors);
}

function feedConfig(token: string): { feedId: number; minConfidenceRatio: number } {
  return { feedId: FEED_IDS[token], minConfidenceRatio: MIN_CONFIDENCE_RATIOS[token] };
}

export function priceOf(token: string): bigint {
  return convertedPrice(token);
}

/** Asserts the live collateral settings are internally valid; a de-listed collateral is skipped. */
export async function collateralSettingsSane(chain: Chain): Promise<{ ok: boolean; detail: string }> {
  const problems: string[] = [];
  const storedValues = await Promise.all(
    COLLATERALS.map((token) =>
      chain.read("state-v1", "get-collateral", [Cl.contractPrincipal(chain.deployer, token)]),
    ),
  );
  for (const [index, value] of storedValues.entries()) {
    const token = COLLATERALS[index];
    const stored = asOptional(value);
    if (!stored) continue;
    const config = asTuple(stored);
    const maxLtv = asUint(config["max-ltv"]);
    const liquidationLtv = asUint(config["liquidation-ltv"]);
    const premium = asUint(config["liquidation-premium"]);
    if (!(maxLtv < liquidationLtv)) problems.push(`${token}: max-ltv ${maxLtv} >= liquidation-ltv ${liquidationLtv}`);
    if (premium > 100_000_000n) problems.push(`${token}: premium ${premium} over 100%`);
  }
  return { ok: problems.length === 0, detail: problems.join("; ") || "valid" };
}
