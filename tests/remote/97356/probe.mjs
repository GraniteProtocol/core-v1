import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";

const simnet = await initSimnet("./tests/remote/97356/Clarinet.toml", false, {
  trackCosts: false,
  trackCoverage: false,
});

const STAKING = "SP119QJ4NVE3RQP8RXJVW5EXAV3XD4CJZWRCEEAAR.staking-v1";
const STATE = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1";
const sender = "SP119QJ4NVE3RQP8RXJVW5EXAV3XD4CJZWRCEEAAR";

const read = (contract, fn, args = []) => {
  try {
    const res = simnet.callReadOnlyFn(contract, fn, args, sender);
    console.log(fn, JSON.stringify(res.result));
  } catch (e) {
    console.log(fn, "THREW:", e?.message ?? String(e));
  }
};

console.log("--- staking state ---");
read(STAKING, "get-active-staked-lp-tokens");
read(STAKING, "get-total-staked-lp-tokens");
read(STAKING, "is-staking-wiped-out");

console.log("--- state-v1 LP token ---");
read(STATE, "get-supply");
read(STATE, "get-balance", [Cl.principal(STAKING)]);
