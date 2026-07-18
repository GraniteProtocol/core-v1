import { beforeEach, describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  init_pyth,
  set_pyth_time_delta,
  set_raw_feed,
  build_price_update,
  get_token_feed_id,
  converted_price,
  getSimnetBlockTime,
} from "../pyth";
import { buildEvmUpdate, buildLazerPayload, PROP, OTHER_PRIVKEY } from "../lazer";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;

const btc = Cl.contractPrincipal(deployer, "mock-btc");
const eth = Cl.contractPrincipal(deployer, "mock-eth");
const usdc = Cl.contractPrincipal(deployer, "mock-usdc");

const register = (token: string) =>
  simnet.callPublicFn(
    "pyth-adapter-v1",
    "update-price-feed-id",
    [Cl.contractPrincipal(deployer, token), Cl.uint(get_token_feed_id(token)), Cl.uint(500)],
    deployer
  );

const verify = (tokens: any[], update?: Uint8Array) =>
  simnet.callPublicFn(
    "pyth-adapter-v1",
    "verify-and-get-prices",
    [Cl.buffer(update ?? build_price_update()), Cl.list(tokens)],
    deployer
  ).result;

// Build a single-feed blob with an explicit timestamp / signer for the timing + signature tests.
const build_at = (feedId: number, price: bigint, expo: number, tsMicros: bigint, privKey?: Uint8Array) =>
  buildEvmUpdate(
    buildLazerPayload({
      timestamp: tsMicros,
      channel: 1,
      feeds: [{ id: feedId, props: [[PROP.Price, price], [PROP.Exponent, BigInt(expo)], [PROP.PublisherCount, 1n]] }],
    }),
    privKey
  );

describe("pyth-adapter-v1 verify-and-get-prices", () => {
  beforeEach(() => {
    init_pyth(deployer);
    set_pyth_time_delta(7200, deployer);
    register("mock-btc");
  });

  it("valid update returns converted fixed-point prices in requested order", () => {
    set_raw_feed("mock-btc", 10000000000n, -8);
    expect(verify([btc])).toBeOk(Cl.list([Cl.uint(converted_price("mock-btc"))]));
  });

  it("returns prices positionally, matching the requested token order for 3+ tokens", () => {
    register("mock-eth");
    register("mock-usdc");
    set_raw_feed("mock-btc", 6000000000000n, -8);
    set_raw_feed("mock-eth", 300000000000n, -8);
    set_raw_feed("mock-usdc", 100000000n, -8);
    // request in a scrambled order; the returned list must align to it, not to feed-id or blob order
    expect(verify([eth, usdc, btc])).toBeOk(
      Cl.list([
        Cl.uint(converted_price("mock-eth")),
        Cl.uint(converted_price("mock-usdc")),
        Cl.uint(converted_price("mock-btc")),
      ])
    );
  });

  it("negative price rejected", () => {
    set_raw_feed("mock-btc", -100n, -8);
    expect(verify([btc])).toBeErr(Cl.uint(80005)); // ERR-INVALID-PRICE
  });

  it("zero price is dropped by the decoder, surfaces as a missing feed", () => {
    set_raw_feed("mock-btc", 0n, -8);
    expect(verify([btc])).toBeErr(Cl.uint(80008)); // ERR-MISSING-FEED
  });

  it("extreme positive exponent rejected", () => {
    set_raw_feed("mock-btc", 100n, 30);
    expect(verify([btc])).toBeErr(Cl.uint(80006)); // ERR-INVALID-EXPONENT
  });

  it("extreme negative exponent rejected", () => {
    set_raw_feed("mock-btc", 100n, -30);
    expect(verify([btc])).toBeErr(Cl.uint(80006)); // ERR-INVALID-EXPONENT
  });

  it("confidence within bound accepted", () => {
    set_raw_feed("mock-btc", 10000000000n, -8, 100000000n); // 1e8 <= 1e10 * 500 / 10000 = 5e8
    expect(verify([btc])).toBeOk(Cl.list([Cl.uint(converted_price("mock-btc"))]));
  });

  it("confidence above bound rejected", () => {
    set_raw_feed("mock-btc", 10000000000n, -8, 600000000n); // 6e8 > 5e8
    expect(verify([btc])).toBeErr(Cl.uint(80004)); // ERR-PRICE-CONFIDENCE-LOW
  });

  it("unsupported asset rejected", () => {
    set_raw_feed("mock-btc", 10000000000n, -8);
    expect(verify([eth])).toBeErr(Cl.uint(80001)); // ERR-UNSUPPORTED-ASSET (mock-eth not in map)
  });

  it("feed absent from the update rejected", () => {
    register("mock-eth"); // in the map, but the blob only carries btc
    set_raw_feed("mock-btc", 10000000000n, -8);
    expect(verify([eth])).toBeErr(Cl.uint(80008)); // ERR-MISSING-FEED
  });

  it("future timestamp rejected", () => {
    const future = (getSimnetBlockTime() + 3600n) * 1_000_000n;
    expect(verify([btc], build_at(get_token_feed_id("mock-btc"), 10000000000n, -8, future))).toBeErr(Cl.uint(80002)); // ERR-PYTH-PRICE-STALE
  });

  it("stale timestamp rejected", () => {
    set_pyth_time_delta(15, deployer);
    const stale = (getSimnetBlockTime() - 100n) * 1_000_000n;
    expect(verify([btc], build_at(get_token_feed_id("mock-btc"), 10000000000n, -8, stale))).toBeErr(Cl.uint(80002)); // ERR-PYTH-PRICE-STALE
  });

  it("untrusted signer rejected", () => {
    const now = getSimnetBlockTime() * 1_000_000n;
    const blob = build_at(get_token_feed_id("mock-btc"), 10000000000n, -8, now, OTHER_PRIVKEY);
    expect(verify([btc], blob)).toBeErr(Cl.uint(2105)); // decoder ERR_UNTRUSTED_SIGNER
  });
});

describe("pyth-adapter-v1 time-delta bounds", () => {
  beforeEach(() => {
    init_pyth(deployer);
  });

  it("time-delta below minimum rejected", () => {
    expect(simnet.callPublicFn("pyth-adapter-v1", "update-time-delta", [Cl.uint(0)], deployer).result).toBeErr(Cl.uint(80007));
  });

  it("time-delta one below minimum rejected", () => {
    expect(simnet.callPublicFn("pyth-adapter-v1", "update-time-delta", [Cl.uint(14)], deployer).result).toBeErr(Cl.uint(80007));
  });

  it("time-delta above maximum rejected", () => {
    expect(simnet.callPublicFn("pyth-adapter-v1", "update-time-delta", [Cl.uint(10000)], deployer).result).toBeErr(Cl.uint(80007));
  });

  it("time-delta at minimum accepted", () => {
    expect(simnet.callPublicFn("pyth-adapter-v1", "update-time-delta", [Cl.uint(15)], deployer).result).toBeOk(Cl.bool(true));
  });

  it("time-delta at maximum accepted", () => {
    expect(simnet.callPublicFn("pyth-adapter-v1", "update-time-delta", [Cl.uint(7200)], deployer).result).toBeOk(Cl.bool(true));
  });
});
