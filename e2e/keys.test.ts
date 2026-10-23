import { describe, expect, it } from "vitest";
import { loadAccounts, deriveKey } from "./keys";

describe("keys", () => {
  it("derives a stable key and address from a mnemonic", () => {
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const a = deriveKey(mnemonic);
    const b = deriveKey(mnemonic);
    expect(a.address).toBe(b.address);
    expect(a.privateKey).toBe(b.privateKey);
    expect(a.address.startsWith("ST")).toBe(true);
  });

  it("parses every account in Devnet.toml", () => {
    const accounts = loadAccounts("settings/Devnet.toml");
    expect(accounts.map((a) => a.name)).toContain("deployer");
    expect(accounts.every((a) => a.address.startsWith("ST"))).toBe(true);
    // The deployer address documented in Devnet.toml; a wrong BIP32 child step lands elsewhere.
    expect(accounts.find((a) => a.name === "deployer")?.address).toBe(
      "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
    );
  });
});
