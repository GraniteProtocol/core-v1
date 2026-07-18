import { expect } from "vitest";
import { Cl, ClarityType, ClarityValue, cvToString } from "@stacks/transactions";
import { buildEvmUpdate, buildLazerPayload, TEST_PUBKEY, PROP, FeedSpec } from "./lazer";
import { scalingFactor } from "./utils";

const PRICE_DECIMALS = 8;
const FAR_FUTURE = 100_000_000_000n; // signer expiry (seconds), effectively never
const WIDE_STALENESS = 100_000_000_000_000n; // oracle staleness floor; adapter time-delta is the real check
const DEPLOYER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

// Lazer numeric feed ids for the mock tokens (arbitrary but stable; must match the seeded map + blob).
const FEED_IDS: Record<string, number> = { btc: 1, eth: 2, usdc: 7 };

export const get_token_feed_id = (token: string): number => {
  if (token.includes("btc")) return FEED_IDS.btc;
  if (token.includes("eth")) return FEED_IDS.eth;
  if (token.includes("usdc")) return FEED_IDS.usdc;
  throw new Error("invalid token feed: " + token);
};

export const get_token_min_confidence_ratio = (token: string): number => {
  if (token.includes("btc")) return 500; // 5%
  if (token.includes("eth")) return 500; // 5%
  if (token.includes("usdc")) return 100; // 1%
  throw new Error("invalid token feed: " + token);
};

// Off-chain price registry. In the pull model prices are not stored on-chain; each price-consuming
// call carries a freshly signed blob built from this registry at the current block time.
type Entry = { price: bigint; expo: number; confidence?: bigint };
const registry = new Map<number, Entry>();

export const getSimnetBlockTime = (): bigint =>
  simnet.callReadOnlyFn("faucet", "get-block-time", [], DEPLOYER).result.value as bigint;

// Mirror of the adapter's convert-res: raw Lazer price -> fixed-point uint the adapter returns.
const convert_res = (price: bigint, expo: number): bigint => {
  if (expo >= 0) return price * 10n ** BigInt(expo + PRICE_DECIMALS);
  const diff = PRICE_DECIMALS - Math.abs(expo);
  if (diff === 0) return price;
  if (diff > 0) return price * 10n ** BigInt(diff);
  return price / 10n ** BigInt(Math.abs(diff));
};

export const converted_price = (token: string): bigint => {
  const e = registry.get(get_token_feed_id(token));
  if (!e) throw new Error("no price for " + token);
  return convert_res(e.price, e.expo);
};

export const init_pyth = (deployer: any) => {
  registry.clear();
  const signers = simnet.callPublicFn(
    "pyth-lazer-oracle",
    "set-trusted-signers",
    [Cl.list([Cl.tuple({ pubkey: Cl.buffer(TEST_PUBKEY), "expires-at": Cl.uint(FAR_FUTURE) })])],
    deployer
  );
  expect(signers.result).toBeOk(Cl.bool(true));
  const stale = simnet.callPublicFn(
    "pyth-lazer-oracle",
    "set-stale-price-threshold",
    [Cl.uint(WIDE_STALENESS)],
    deployer
  );
  expect(stale.result).toBeOk(Cl.bool(true));
};

export const set_pyth_time_delta = async (delta: number, deployer: any) => {
  const result = simnet.callPublicFn("pyth-adapter-v1", "update-time-delta", [Cl.uint(delta)], deployer);
  expect(result.result).toBeOk(Cl.bool(true));
};

export const set_initial_price = async (token: string, price: bigint, deployer: any): Promise<bigint> => {
  const res = simnet.callPublicFn(
    "pyth-adapter-v1",
    "update-price-feed-id",
    [Cl.contractPrincipal(deployer, token), Cl.uint(get_token_feed_id(token)), Cl.uint(get_token_min_confidence_ratio(token))],
    deployer
  );
  expect(res.result).toHaveClarityType(ClarityType.ResponseOk);
  return set_price(token, price, deployer);
};

export const set_price = async (token: string, price: bigint, deployer: any, expo: number = -8): Promise<bigint> => {
  registry.set(get_token_feed_id(token), { price: price * scalingFactor, expo });
  return getSimnetBlockTime();
};

export const set_price_without_scaling = async (token: string, price: bigint, deployer: any, expo: number = -8): Promise<bigint> => {
  registry.set(get_token_feed_id(token), { price, expo });
  return getSimnetBlockTime();
};

// Directly set a raw Lazer feed value (int price, exponent, optional confidence) for adapter edge tests.
export const set_raw_feed = (token: string, price: bigint, expo: number = -8, confidence?: bigint) => {
  registry.set(get_token_feed_id(token), { price, expo, confidence });
};

// Build a signed Lazer evm blob carrying every registered feed. `offsetSeconds` shifts the blob
// timestamp off the current block time (negative = stale, positive = future) for the timing tests.
export const build_price_update = (offsetSeconds: bigint = 0n): Uint8Array => {
  const timestamp = (getSimnetBlockTime() + offsetSeconds) * 1_000_000n; // seconds -> microseconds
  const feeds: FeedSpec[] = [...registry.entries()].map(([id, e]) => {
    const props: Array<[number, bigint | null]> = [
      [PROP.Price, e.price],
      [PROP.Exponent, BigInt(e.expo)],
      [PROP.PublisherCount, 1n],
    ];
    if (e.confidence !== undefined) props.push([PROP.Confidence, e.confidence]);
    return { id, props };
  });
  return buildEvmUpdate(buildLazerPayload({ timestamp, channel: 1, feeds }));
};

export const price_update_cv = (): ClarityValue => Cl.buffer(build_price_update());

// Converted market-asset price (mock-usdc) for injecting into read-only views.
export const market_price_cv = (): ClarityValue => Cl.uint(converted_price("mock-usdc"));

// Converted collateral prices aligned to a user's on-chain position collaterals, for read-only
// views. Reads the position so the injected list always matches the contract's collateral order.
export const collateral_prices_cv = (user: string, deployer: any): ClarityValue => {
  const pos: any = simnet.callReadOnlyFn("state-v1", "get-user-position", [Cl.principal(user)], deployer).result;
  // (optional {collaterals: (list principal), ...}); none -> no collaterals
  const collaterals: any[] = pos?.value?.value?.collaterals?.value ?? [];
  return Cl.list(
    collaterals.map((c) => Cl.uint(converted_price(cvToString(c).split(".").pop() as string)))
  );
};

// Explicit-order variant for callers that already know the collateral tokens (e.g. before a
// position is fully materialized).
export const collateral_prices_for = (tokens: string[]): ClarityValue =>
  Cl.list(tokens.map((t) => Cl.uint(converted_price(t))));
