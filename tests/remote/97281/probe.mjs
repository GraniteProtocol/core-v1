import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";

const simnet = await initSimnet("./tests/remote/97281/Clarinet.toml", false, {
  trackCosts: false,
  trackCoverage: false,
});

const ADAPTER = "SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT.pyth-adapter-v1";
const SBTC = Cl.contractPrincipal(
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
  "sbtc-token"
);
const sender = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

const makeVerified = (confidence) =>
  Cl.tuple({
    timestamp: Cl.uint(1785409948),
    feeds: Cl.list([
      Cl.tuple({
        "feed-id": Cl.uint(1),
        price: Cl.int(10000000000000n), // raw Lazer price, expo -8
        exponent: Cl.int(-8n),
        confidence,
      }),
    ]),
  });

const run = (label, confidence) => {
  try {
    const res = simnet.callPublicFn(
      ADAPTER,
      "prices-for",
      [makeVerified(confidence), Cl.list([SBTC])],
      sender
    );
    console.log(label, JSON.stringify(res.result, null, 2));
  } catch (e) {
    console.log(label, "THREW:", e?.message ?? String(e));
  }
};

run("ABSENT confidence:", Cl.none());
run("PRESENT 20% (2e12 > bound 5e11):", Cl.some(Cl.uint(2000000000000n)));
run("PRESENT 5% (5e11 == bound):", Cl.some(Cl.uint(500000000000n)));
