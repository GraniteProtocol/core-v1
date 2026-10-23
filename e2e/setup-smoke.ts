import { Chain } from "./chain.ts";
import { startDevnet, stopDevnet } from "./devnet.ts";
import { loadAccounts } from "./keys.ts";
import { balanceOf, collateralSettingsOf, COLLATERALS, MARKET, setup } from "./setup.ts";
import type { Actors } from "./setup.ts";

const accounts = loadAccounts("settings/Devnet.toml");
const byName = (name: string) => {
  const account = accounts.find((a) => a.name === name);
  if (!account) throw new Error(`missing devnet account: ${name}`);
  return account;
};

const actors: Actors = {
  deployer: byName("deployer"),
  lp: byName("wallet_1"),
  safe: byName("wallet_2"),
  max: byName("wallet_3"),
  near: byName("wallet_4"),
  under: byName("wallet_5"),
  liquidator: byName("wallet_6"),
  staker: byName("wallet_7"),
  flash: byName("wallet_8"),
};

const handle = await startDevnet();
try {
  const chain = new Chain(actors.deployer.address);
  const baseline = await setup(chain, actors);
  console.log(`collaterals=${COLLATERALS.length}`);
  console.log(`refill=${baseline.caps.refill} decay=${baseline.caps.decay}`);
  for (const token of COLLATERALS) {
    const config = await collateralSettingsOf(chain, token);
    console.log(`${token} max-ltv=${config.maxLtv} liq-ltv=${config.liquidationLtv}`);
  }
  console.log(`lp usdc=${await balanceOf(chain, MARKET, actors.lp.address)}`);
  console.log(`safe btc=${await balanceOf(chain, "mock-btc", actors.safe.address)}`);
  console.log(`lp total-assets=${baseline.lp.totalAssets} shares=${baseline.lp.totalShares}`);
} finally {
  await stopDevnet(handle);
}
