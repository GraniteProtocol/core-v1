// Market configuration the suite runs against. `LIVE` holds the USDCx production values read from
// mainnet (state-v1, the IR and reward modules, withdrawal-caps-v1 and the market API); the devnet
// mirrors them so a run exercises the economics a live market runs. Anything the local chain cannot
// mirror is a named TEST_ONLY override, applied at setup or only for the scenario that needs it.

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

/** Live USDCx market parameters. mock-btc is the local stand-in for sBTC, the live collateral. */
export const LIVE = {
  protocolReservePercentage: 25_000_000n,
  ir: {
    slope1: 40_000_000_000n,
    slope2: 3_100_000_000_000n,
    kink: 850_000_000_000n,
    base: 5_000_000_000n,
  } satisfies Record<string, bigint>,
  reward: { slope1: 0n, slope2: -1n, kink: 99_999_999n, base: 0n } satisfies RewardParams,
  collateral: {
    [BTC]: { maxLtv: 50_000_000n, liquidationLtv: 65_000_000n, liquidationPremium: 10_000_000n, decimals: 8n },
  } satisfies Record<string, CollateralConfig>,
  caps: {
    lp: 20_000_000n,
    debt: 20_000_000n,
    collateral: { [BTC]: 20_000_000n } satisfies Record<string, bigint>,
    windows: { refill: 36_000n, decay: 10_800n } satisfies CapWindows,
  },
  withdrawalFinalizationPeriod: 100n,
  assetCap: 20_000_000_000_000n,
} as const;

/**
 * Test-only overrides, each replacing a production value the devnet cannot carry. These are fixture
 * sizes and timings, never market pricing: the reward override only makes an otherwise-zero reward
 * path executable and is restored to `LIVE` inside the scenario that uses it.
 */
export const TEST_ONLY = {
  // Live 20,000e8; actor funding is larger, and the cap is a safety limit rather than market pricing.
  assetCap: (1n << 128n) - 1n,
  // Live 100 blocks; the unstake scenario has to finish inside a run.
  withdrawalFinalizationPeriod: 4n,
  // Live 36,000s/10,800s; the caps scenarios sample partial refill/decay mid-window and at the
  // endpoint, which needs second-scale windows. Applied only inside those scenarios.
  capWindows: { refill: 40n, decay: 20n } satisfies CapWindows,
  // Live rewards are zero (slope2 is one negative unit), so no staked interest would ever accrue.
  rewardParams: { slope1: -50_000_000n, slope2: -70_000_000n, kink: 70_000_000n, base: 30_000_000n } satisfies RewardParams,
  // Devnet-only collaterals with no live USDCx counterpart; the multi-collateral and liquidation
  // flows need a second and third asset.
  collateral: {
    [ETH]: { maxLtv: 50_000_000n, liquidationLtv: 70_000_000n, liquidationPremium: 10_000_000n, decimals: 8n },
    [STX]: { maxLtv: 50_000_000n, liquidationLtv: 70_000_000n, liquidationPremium: 10_000_000n, decimals: 6n },
  } satisfies Record<string, CollateralConfig>,
  collateralCaps: { [ETH]: 50_000_000n, [STX]: 50_000_000n } satisfies Record<string, bigint>,
} as const;
