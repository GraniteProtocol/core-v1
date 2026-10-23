import { randomBytes } from "node:crypto";
import { getAddressFromPrivateKey } from "@stacks/transactions";
import type { Chain } from "./chain.ts";
import type { Account } from "./keys.ts";

/** A throwaway devnet account, funded for fees and collateral by the deployer. */
export function newAccount(name: string): Account {
  const privateKey = Buffer.from(randomBytes(32)).toString("hex") + "01";
  return { name, mnemonic: "", privateKey, address: getAddressFromPrivateKey(privateKey, "testnet") };
}

export const FUNDED_STX = 20_000_000_000n; // 20,000 STX: fees plus native-STX collateral

export async function fundAccount(chain: Chain, deployer: Account, account: Account): Promise<void> {
  await chain.transfer(deployer, account.address, FUNDED_STX);
}
