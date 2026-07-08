import { expect } from "vitest";
import { Cl, ClarityType } from "@stacks/transactions";
import { scalingFactor } from "./utils";

// Lazer publish-time is microseconds; the adapter divides by this for its
// seconds-based staleness. Tests write publish-time = T * MICROS_PER_SECOND.
const MICROS_PER_SECOND = 1_000_000n;

// Monotonically increasing publish time (microseconds) so a later seed always
// reads as fresher than an earlier one.
let lastPublishTime = 0n;

/**
 * Returns the current simnet block time by reading the faucet helper.
 * Aligned with the simnet's internal clock, not wall-clock time.
 */
const getSimnetBlockTime = (): bigint => {
  const r = simnet.callReadOnlyFn(
    "faucet",
    "get-block-time",
    [],
    "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM"
  );
  return r.result.value as bigint;
};

export const init_pyth = (_sender: any) => {
  lastPublishTime = 0n;
};

export const get_token_feed = (token: string): bigint => {
  // Placeholder Lazer numeric feed ids; the real catalog ids come from Hiro at bake time.
  if (token.includes("btc")) return 1n;
  else if (token.includes("eth")) return 2n;
  else if (token.includes("usdc")) return 3n;
  else throw "invalid token feed";
};

export const get_token_min_confidence_ratio = (token: string) => {
  if (token.includes("btc")) return 500; // 5%
  else if (token.includes("eth")) return 500; // 5%
  else if (token.includes("usdc")) return 100; // 1%
  else throw "invalid token feed";
};

export const set_initial_price = async (
  token: string,
  price: bigint,
  deployer: any
): Promise<bigint> => {
  const feed = get_token_feed(token);
  const minConfidenceRatio = get_token_min_confidence_ratio(token);
  const res = simnet.callPublicFn(
    "pyth-adapter-v1",
    "update-price-feed-id",
    [Cl.contractPrincipal(deployer, token), Cl.uint(feed), Cl.uint(minConfidenceRatio)],
    deployer
  );
  expect(res.result).toHaveClarityType(ClarityType.ResponseOk);

  return set_price(token, price, deployer);
};

export const set_pyth_time_delta = async (delta: number, deployer: any) => {
  const result = simnet.callPublicFn(
    "pyth-adapter-v1",
    "update-time-delta",
    [Cl.uint(delta)],
    deployer
  );
  expect(result.result).toBeOk(Cl.bool(true));
};

/**
 * Publish time (microseconds) aligned with simnet block time, kept strictly
 * monotonic across seeds.
 */
const getPublishTimeMicros = (): bigint => {
  const blockTimeMicros = getSimnetBlockTime() * MICROS_PER_SECOND;
  const publishTime =
    blockTimeMicros > lastPublishTime ? blockTimeMicros : lastPublishTime + 1n;
  lastPublishTime = publishTime;
  return publishTime;
};

/**
 * Seeds a feed's price via the storage mock's public setter (the production read
 * path is `get-price`; this is the test-only way to populate it). Returns the
 * publish-time in SECONDS.
 */
export const set_price_at = (
  feed: bigint,
  price: bigint,
  expo: number,
  publishTimeMicros: bigint,
  deployer: any,
  conf: bigint = 0n
): bigint => {
  const res = simnet.callPublicFn(
    "pyth-lazer-storage",
    "set-price",
    [
      Cl.uint(feed),
      Cl.int(price),
      Cl.int(expo),
      Cl.uint(publishTimeMicros),
      Cl.some(Cl.uint(conf)),
    ],
    deployer
  );
  expect(res.result).toBeOk(Cl.bool(true));
  return publishTimeMicros / MICROS_PER_SECOND;
};

export const set_price = async (
  token: string,
  price: bigint,
  deployer: any,
  expo: number = -8,
  prevPublishTime?: bigint
): Promise<bigint> => {
  const feed = get_token_feed(token);
  return set_price_at(feed, price * scalingFactor, expo, getPublishTimeMicros(), deployer);
};

export const set_price_without_scaling = async (
  token: string,
  price: bigint,
  deployer: any,
  expo: number = -8,
  prevPublishTime?: bigint
): Promise<bigint> => {
  const feed = get_token_feed(token);
  return set_price_at(feed, price, expo, getPublishTimeMicros(), deployer);
};
