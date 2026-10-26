import { Cl, type ClarityValue } from "@stacks/transactions";
import type { Chain } from "./chain.ts";
import type { Account } from "./keys.ts";
import { convertedPrice, FEED_IDS, MIN_CONFIDENCE_RATIOS, setPrice } from "./prices.ts";
import { asOptional, asTuple, asUint, okUint } from "./values.ts";
import { TEST_PUBKEY } from "../tests/lazer.ts";
import {
  BTC,
  COLLATERALS,
  ETH,
  MARKET,
  PROFILE,
  STX,
  type CapWindows,
  type CollateralConfig,
} from "./profile.ts";

export { BTC, COLLATERALS, ETH, MARKET, PROFILE, STX };
export type { CapWindows, CollateralConfig };

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

export const MINIMUM_INITIAL_DEPOSIT = 1000n;
const FAR_FUTURE = 100_000_000_000n;
const WIDE_STALENESS = 100_000_000_000_000n;

export type Snapshot = {
  balances: Record<string, Record<string, bigint>>;
  collaterals: Record<string, CollateralConfig>;
  caps: { refill: bigint; decay: bigint; collateral: Record<string, bigint> };
  lp: { totalAssets: bigint; totalShares: bigint };
  debt: { openInterest: bigint; totalDebtShares: bigint };
};

export const expectedCollateralConfigs = (): Record<string, CollateralConfig> => ({
  ...PROFILE.collateral,
  ...PROFILE.test.collateral,
});

// The caps scenarios lower the windows to sample partial refill/decay; every other step expects the
// live windows. The expectation moves with the override so the invariant never reads a stale value.
let expectedWindows: CapWindows = { ...PROFILE.caps.windows };

export const expectedCaps = (): {
  refill: bigint;
  decay: bigint;
  lp: bigint;
  debt: bigint;
  collateral: Record<string, bigint>;
} => ({
  refill: expectedWindows.refill,
  decay: expectedWindows.decay,
  lp: PROFILE.caps.lp,
  debt: PROFILE.caps.debt,
  collateral: { ...PROFILE.caps.collateral, ...PROFILE.test.collateralCaps },
});

/** Sets the withdrawal-cap windows on chain and moves the invariant's expectation with them. */
export async function setCapWindows(chain: Chain, deployer: Account, windows: CapWindows): Promise<void> {
  await chain.call(deployer, "withdrawal-caps-v1", "set-refill-time-window", [Cl.uint(windows.refill)]);
  await chain.call(deployer, "withdrawal-caps-v1", "set-decay-time-window", [Cl.uint(windows.decay)]);
  expectedWindows = { ...windows };
}

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

  // 1. Live market economics first: every later deposit accrues interest through these modules.
  await call("state-v1", "set-protocol-reserve-percentage", [Cl.uint(PROFILE.protocolReservePercentage)]);
  await call("linear-kinked-ir-v1", "update-ir-params", [
    Cl.uint(PROFILE.ir.slope1),
    Cl.uint(PROFILE.ir.slope2),
    Cl.uint(PROFILE.ir.kink),
    Cl.uint(PROFILE.ir.base),
  ]);
  await call("staking-reward-v1", "update-reward-params", [
    Cl.int(PROFILE.reward.slope1),
    Cl.int(PROFILE.reward.slope2),
    Cl.uint(PROFILE.reward.kink),
    Cl.uint(PROFILE.reward.base),
  ]);
  // A zero minimum stake skips the deployer dust stake, which would need LP tokens it does not hold.
  await call("staking-v1", "initialize", [Cl.some(Cl.uint(0))]);
  // Live is 100 blocks; a short period keeps the unstake scenario inside a run while leaving room
  // for the early-finalize assertion (transactions between initiate and finalize cost a block or two).
  await call("staking-v1", "update-withdrawal-finalization-period", [Cl.uint(PROFILE.test.withdrawalFinalizationPeriod)]);
  // The test governance is initialized here because the staking scenario uses it to apply and
  // restore test reward params; the governance scenario drives the proposal lifecycle against it.
  // Governance-test resolves proposal membership through meta-governance, so that must be
  // initialized too.
  const testGovernance = Cl.list([Cl.some(Cl.principal(deployer)), Cl.none(), Cl.none(), Cl.none(), Cl.none()]);
  await call("meta-governance-v1", "initialize-governance", [testGovernance]);
  await call("governance-test", "initialize-governance", [testGovernance]);

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
  await call("state-v1", "update-asset-cap", [Cl.uint(PROFILE.test.assetCap)]);
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

  // 5. Withdrawal caps and their timing windows, at the live factors.
  const caps = expectedCaps();
  await call("withdrawal-caps-v1", "set-lp-cap", [Cl.uint(caps.lp)]);
  await call("withdrawal-caps-v1", "set-debt-cap", [Cl.uint(caps.debt)]);
  for (const [token, factor] of Object.entries(caps.collateral)) {
    await call("withdrawal-caps-v1", "set-collateral-cap", [cp(token), Cl.uint(factor)]);
  }
  await call("withdrawal-caps-v1", "set-refill-time-window", [Cl.uint(caps.refill)]);
  await call("withdrawal-caps-v1", "set-decay-time-window", [Cl.uint(caps.decay)]);

  // 6. Fund the actors from the mock tokens (the market token and both mock collaterals use 8 decimals).
  const usdc = 100_000_000n;
  await mint(chain, actors.deployer, MARKET, 4_000_000n * usdc, actors.lp.address);
  await mint(chain, actors.deployer, MARKET, 2_000_000n * usdc, actors.staker.address);
  await mint(chain, actors.deployer, MARKET, 1_000_000n * usdc, actors.liquidator.address);
  await mint(chain, actors.deployer, MARKET, 1_000_000n * usdc, deployer);
  await mint(chain, actors.deployer, MARKET, 100n * usdc, cp("mock-flash-loan-callback"));
  await mint(chain, actors.deployer, MARKET, 100_000n * usdc, cp("mock-liquidator-with-flash-loan"));
  for (const borrower of [actors.safe, actors.max, actors.near, actors.under]) {
    await mint(chain, actors.deployer, BTC, 100n * 100_000_000n, borrower.address);
    await mint(chain, actors.deployer, ETH, 1000n * 100_000_000n, borrower.address);
  }
  // The live cap factors are enabled, so the pool needs enough depth that a 20% debt bucket does
  // not throttle the matrix's borrows.
  await chain.call(actors.lp, "liquidity-provider-v1", "deposit", [
    Cl.uint(1_500_000n * usdc),
    Cl.principal(actors.lp.address),
  ]);
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

/** The configuration a run used, for the report: live values plus every named test-only override. */
export function profileSummary(): Record<string, string | string[]> {
  const collateral = Object.entries(expectedCollateralConfigs())
    .map(([token, config]) => {
      const source = token in PROFILE.collateral ? "live" : "test";
      return `${token}=${config.maxLtv}/${config.liquidationLtv}/${config.liquidationPremium}/${config.decimals} (${source})`;
    })
    .join(" ");
  return {
    market: "USDCx (live parameters)",
    protocolReservePercentage: PROFILE.protocolReservePercentage.toString(),
    irParams: `slope1=${PROFILE.ir.slope1} slope2=${PROFILE.ir.slope2} kink=${PROFILE.ir.kink} base=${PROFILE.ir.base}`,
    rewardParams: `slope1=${PROFILE.reward.slope1} slope2=${PROFILE.reward.slope2} kink=${PROFILE.reward.kink} base=${PROFILE.reward.base}`,
    collateral: `max-ltv/liquidation-ltv/premium/decimals: ${collateral}`,
    caps: `lp=${PROFILE.caps.lp} debt=${PROFILE.caps.debt} collateral=${JSON.stringify(expectedCaps().collateral)} windows=${PROFILE.caps.windows.refill}/${PROFILE.caps.windows.decay}`,
    testOverrides: [
      `asset cap ${PROFILE.test.assetCap} (live ${PROFILE.assetCap})`,
      `withdrawal finalization ${PROFILE.test.withdrawalFinalizationPeriod} blocks, from setup (live ${PROFILE.withdrawalFinalizationPeriod})`,
      `cap windows ${PROFILE.test.capWindows.refill}/${PROFILE.test.capWindows.decay}s while the caps scenarios sample them (live ${PROFILE.caps.windows.refill}/${PROFILE.caps.windows.decay}s)`,
      `staking reward params slope1=${PROFILE.test.rewardParams.slope1} slope2=${PROFILE.test.rewardParams.slope2} kink=${PROFILE.test.rewardParams.kink} base=${PROFILE.test.rewardParams.base} inside the staking scenario only, restored after (live rewards are zero)`,
      `mock-eth and stx-sip010 are devnet-only collaterals with no live USDCx counterpart; their settings and 50% collateral caps are test fixtures`,
    ],
  };
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
