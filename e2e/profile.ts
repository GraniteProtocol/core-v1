// Market configuration the suite runs against. A profile holds the production values read from a
// live market plus the named devnet-only overrides the local chain needs; the setup and the
// invariants consume the selected profile, so a second market is another object of this shape
// rather than a second runner. The scenario amounts are still derived from the profile's LTVs by
// hand, which is the work a second market owes.

export const MARKET = "mock-usdc";
export const BTC = "mock-btc";
export const ETH = "mock-eth";
export const STX = "stx-sip010";
export const COLLATERALS = [BTC, ETH, STX];

export type CollateralConfig = {
  maxLtv: bigint;
  liquidationLtv: bigint;
  liquidationPremium: bigint;
  decimals: bigint;
};

export type RewardParams = {
  slope1: bigint;
  slope2: bigint;
  kink: bigint;
  base: bigint;
};

export type CapWindows = { refill: bigint; decay: bigint };

export type CapConfig = {
  lp: bigint;
  debt: bigint;
  collateral: Record<string, bigint>;
  windows: CapWindows;
};

/** Devnet fixtures the production configuration cannot provide. These are never market pricing. */
export type TestOverrides = {
  assetCap: bigint;
  withdrawalFinalizationPeriod: bigint;
  capWindows: CapWindows;
  rewardParams: RewardParams;
  collateral: Record<string, CollateralConfig>;
  collateralCaps: Record<string, bigint>;
};

export type MarketProfile = {
  name: string;
  protocolReservePercentage: bigint;
  ir: { slope1: bigint; slope2: bigint; kink: bigint; base: bigint };
  reward: RewardParams;
  collateral: Record<string, CollateralConfig>;
  caps: CapConfig;
  withdrawalFinalizationPeriod: bigint;
  assetCap: bigint;
  test: TestOverrides;
};

/** Live USDCx parameters. mock-btc is the local stand-in for sBTC, the live collateral. */
export const USDCX: MarketProfile = {
  name: "USDCx",
  protocolReservePercentage: 25_000_000n,
  ir: {
    slope1: 40_000_000_000n,
    slope2: 3_100_000_000_000n,
    kink: 850_000_000_000n,
    base: 5_000_000_000n,
  },
  reward: { slope1: 0n, slope2: -1n, kink: 99_999_999n, base: 0n },
  collateral: {
    [BTC]: { maxLtv: 50_000_000n, liquidationLtv: 65_000_000n, liquidationPremium: 10_000_000n, decimals: 8n },
  },
  caps: {
    lp: 20_000_000n,
    debt: 20_000_000n,
    collateral: { [BTC]: 20_000_000n },
    windows: { refill: 36_000n, decay: 10_800n },
  },
  withdrawalFinalizationPeriod: 100n,
  assetCap: 20_000_000_000_000n,
  test: {
    // Live 20,000e8; actor funding is larger, and the cap is a safety limit rather than pricing.
    assetCap: (1n << 128n) - 1n,
    // Live 100 blocks; the unstake scenario has to finish inside a run.
    withdrawalFinalizationPeriod: 4n,
    // Live 36,000s/10,800s; the caps scenarios sample partial refill/decay mid-window and at the
    // endpoint, which needs second-scale windows. Applied only inside those scenarios.
    capWindows: { refill: 40n, decay: 20n },
    // Live rewards are zero (slope2 is one negative unit), so no staked interest would ever accrue.
    rewardParams: { slope1: -50_000_000n, slope2: -70_000_000n, kink: 70_000_000n, base: 30_000_000n },
    // Devnet-only collaterals with no live USDCx counterpart; the multi-collateral and liquidation
    // flows need a second and third asset.
    collateral: {
      [ETH]: { maxLtv: 50_000_000n, liquidationLtv: 70_000_000n, liquidationPremium: 10_000_000n, decimals: 8n },
      [STX]: { maxLtv: 50_000_000n, liquidationLtv: 70_000_000n, liquidationPremium: 10_000_000n, decimals: 6n },
    },
    collateralCaps: { [ETH]: 50_000_000n, [STX]: 50_000_000n },
  },
};

/** The market a run mirrors. A second market selects here and supplies its own scenario amounts. */
export const PROFILE: MarketProfile = USDCX;
