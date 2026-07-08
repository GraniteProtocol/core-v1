import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType } from "@stacks/transactions";
import { init_pyth, set_pyth_time_delta, get_token_feed, set_price_at } from "../pyth";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const address1 = accounts.get("wallet_1")!;

// Lazer publish-time is microseconds; the adapter divides by this for seconds.
const MICROS_PER_SECOND = 1_000_000n;

/**
 * Returns the current simnet block time (seconds).
 */
const getSimnetBlockTime = (): bigint => {
  const r = simnet.callReadOnlyFn(
    "faucet",
    "get-block-time",
    [],
    deployer
  );
  return r.result.value as bigint;
};

/**
 * Seeds a raw price into the storage mock at the current simnet block time.
 */
const set_raw_price = async (
  token: string,
  price: bigint,
  expo: number = -8,
  conf?: bigint
): Promise<bigint> => {
  const feed = get_token_feed(token);
  const publishTimeMicros = getSimnetBlockTime() * MICROS_PER_SECOND;
  set_price_at(feed, price, expo, publishTimeMicros, deployer, conf ?? 0n);
  return publishTimeMicros / MICROS_PER_SECOND;
};

/**
 * Seeds a price at a caller-supplied publish time. The value is SECONDS
 * (tests pass second-scale values like blockTime+3600); stored as microseconds.
 */
const set_price_with_time = async (
  token: string,
  price: bigint,
  publishTime: bigint,
  expo: number = -8
): Promise<void> => {
  const feed = get_token_feed(token);
  set_price_at(feed, price, expo, publishTime * MICROS_PER_SECOND, deployer);
};

describe("pyth-adapter-v1 oracle hardening tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);

    // Register BTC price feed
    const feed = get_token_feed("mock-btc");
    simnet.callPublicFn(
      "pyth-adapter-v1",
      "update-price-feed-id",
      [
        Cl.contractPrincipal(deployer, "mock-btc"),
        Cl.uint(feed),
        Cl.uint(500),
      ],
      deployer
    );
  });

  it("zero price rejected (H-1, M-15)", async () => {
    await set_raw_price("mock-btc", 0n);
    const result = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "read-price",
      [Cl.contractPrincipal(deployer, "mock-btc")],
      address1
    );
    expect(result.result).toBeErr(Cl.uint(80005)); // ERR-INVALID-PRICE
  });

  it("negative price rejected (H-9)", async () => {
    await set_raw_price("mock-btc", -100n);
    const result = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "read-price",
      [Cl.contractPrincipal(deployer, "mock-btc")],
      address1
    );
    expect(result.result).toBeErr(Cl.uint(80005)); // ERR-INVALID-PRICE
  });

  it("extreme positive exponent rejected (M-3)", async () => {
    await set_raw_price("mock-btc", 100n, 30);
    const result = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "read-price",
      [Cl.contractPrincipal(deployer, "mock-btc")],
      address1
    );
    expect(result.result).toBeErr(Cl.uint(80006)); // ERR-INVALID-EXPONENT
  });

  it("extreme negative exponent rejected (M-3)", async () => {
    await set_raw_price("mock-btc", 100n, -30);
    const result = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "read-price",
      [Cl.contractPrincipal(deployer, "mock-btc")],
      address1
    );
    expect(result.result).toBeErr(Cl.uint(80006)); // ERR-INVALID-EXPONENT
  });

  it("future timestamp rejected (M-2)", async () => {
    // Set a publish time far in the future (1 hour ahead of simnet block time)
    const blockTime = getSimnetBlockTime();
    const farFuture = blockTime + 3600n;
    await set_price_with_time("mock-btc", 100n, farFuture);
    const result = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "read-price",
      [Cl.contractPrincipal(deployer, "mock-btc")],
      address1
    );
    expect(result.result).toBeErr(Cl.uint(80002)); // ERR-PYTH-PRICE-STALE
  });

  it("valid price and exponent accepted", async () => {
    await set_raw_price("mock-btc", 10000000000n, -8);
    const result = simnet.callReadOnlyFn(
      "pyth-adapter-v1",
      "read-price",
      [Cl.contractPrincipal(deployer, "mock-btc")],
      address1
    );
    expect(result.result).toHaveClarityType(ClarityType.ResponseOk);
  });
});

describe("pyth-adapter-v1 time-delta bounds (M-1)", () => {
  beforeEach(() => {
    init_pyth(deployer);
  });

  it("time-delta below minimum rejected", () => {
    const result = simnet.callPublicFn(
      "pyth-adapter-v1",
      "update-time-delta",
      [Cl.uint(0)],
      deployer
    );
    expect(result.result).toBeErr(Cl.uint(80007)); // ERR-INVALID-TIME-DELTA
  });

  it("time-delta one below minimum rejected", () => {
    const result = simnet.callPublicFn(
      "pyth-adapter-v1",
      "update-time-delta",
      [Cl.uint(14)],
      deployer
    );
    expect(result.result).toBeErr(Cl.uint(80007)); // ERR-INVALID-TIME-DELTA
  });

  it("time-delta above maximum rejected", () => {
    const result = simnet.callPublicFn(
      "pyth-adapter-v1",
      "update-time-delta",
      [Cl.uint(10000)],
      deployer
    );
    expect(result.result).toBeErr(Cl.uint(80007)); // ERR-INVALID-TIME-DELTA
  });

  it("time-delta at minimum accepted", () => {
    const result = simnet.callPublicFn(
      "pyth-adapter-v1",
      "update-time-delta",
      [Cl.uint(15)],
      deployer
    );
    expect(result.result).toBeOk(Cl.bool(true));
  });

  it("time-delta at maximum accepted", () => {
    const result = simnet.callPublicFn(
      "pyth-adapter-v1",
      "update-time-delta",
      [Cl.uint(7200)],
      deployer
    );
    expect(result.result).toBeOk(Cl.bool(true));
  });
});
