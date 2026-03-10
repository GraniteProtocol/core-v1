import { beforeEach, describe, expect, it } from "vitest";
import { Cl, ClarityType } from "@stacks/transactions";
import {
  init_pyth,
  set_pyth_time_delta,
  guardianSet,
  get_token_feed,
} from "../pyth";
import { pyth } from "../../contracts/pyth/unit-tests/pyth/helpers";
import { wormhole } from "../../contracts/pyth/unit-tests/wormhole/helpers";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const address1 = accounts.get("wallet_1")!;

/**
 * Returns the current simnet block time.
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
 * Helper to submit a raw price update to pyth storage with custom price/expo values.
 * Uses simnet-aligned timestamps.
 */
const set_raw_price = async (
  token: string,
  price: bigint,
  expo: number = -8,
  conf?: bigint
): Promise<bigint> => {
  const feed = get_token_feed(token);
  const publishTime = getSimnetBlockTime();
  let actualPricesUpdates = pyth.buildPriceUpdateBatch([
    [feed, { price, expo, publishTime, conf }],
  ]);
  let actualPricesUpdatesVaaPayload =
    pyth.buildAuwvVaaPayload(actualPricesUpdates);
  let payload = pyth.serializeAuwvVaaPayloadToBuffer(
    actualPricesUpdatesVaaPayload
  );
  let vaaBody = wormhole.buildValidVaaBodySpecs({
    payload,
    emitter: pyth.DefaultPricesDataSources[0],
  });
  let vaaHeader = wormhole.buildValidVaaHeader(guardianSet, vaaBody, {
    version: 1,
    guardianSetId: 1,
  });
  let vaa = wormhole.serializeVaaToBuffer(vaaHeader, vaaBody);
  let pnauHeader = pyth.buildPnauHeader();
  let pricesUpdatesToSubmit = [feed];
  let pnau = pyth.serializePnauToBuffer(pnauHeader, {
    vaa,
    pricesUpdates: actualPricesUpdates,
    pricesUpdatesToSubmit,
  });

  const res = simnet.callPublicFn(
    "pyth-adapter-v1",
    "update-pyth",
    [Cl.some(Cl.buffer(pnau))],
    deployer
  );
  expect(res.result).toHaveClarityType(ClarityType.ResponseOk);

  return publishTime;
};

/**
 * Helper to submit a price update with a custom publish time.
 */
const set_price_with_time = async (
  token: string,
  price: bigint,
  publishTime: bigint,
  expo: number = -8
): Promise<void> => {
  const feed = get_token_feed(token);
  let actualPricesUpdates = pyth.buildPriceUpdateBatch([
    [feed, { price, expo, publishTime }],
  ]);
  let actualPricesUpdatesVaaPayload =
    pyth.buildAuwvVaaPayload(actualPricesUpdates);
  let payload = pyth.serializeAuwvVaaPayloadToBuffer(
    actualPricesUpdatesVaaPayload
  );
  let vaaBody = wormhole.buildValidVaaBodySpecs({
    payload,
    emitter: pyth.DefaultPricesDataSources[0],
  });
  let vaaHeader = wormhole.buildValidVaaHeader(guardianSet, vaaBody, {
    version: 1,
    guardianSetId: 1,
  });
  let vaa = wormhole.serializeVaaToBuffer(vaaHeader, vaaBody);
  let pnauHeader = pyth.buildPnauHeader();
  let pricesUpdatesToSubmit = [feed];
  let pnau = pyth.serializePnauToBuffer(pnauHeader, {
    vaa,
    pricesUpdates: actualPricesUpdates,
    pricesUpdatesToSubmit,
  });

  const res = simnet.callPublicFn(
    "pyth-adapter-v1",
    "update-pyth",
    [Cl.some(Cl.buffer(pnau))],
    deployer
  );
  expect(res.result).toHaveClarityType(ClarityType.ResponseOk);
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
        Cl.buffer(feed),
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

  it("time-delta of 59 rejected", () => {
    const result = simnet.callPublicFn(
      "pyth-adapter-v1",
      "update-time-delta",
      [Cl.uint(59)],
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
      [Cl.uint(60)],
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
