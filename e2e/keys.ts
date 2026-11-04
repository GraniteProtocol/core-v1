import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha512 } from "@noble/hashes/sha512";
import { hmac } from "@noble/hashes/hmac";
import { getPublicKey } from "@noble/secp256k1";
import { getAddressFromPrivateKey } from "@stacks/transactions";
import { readFileSync } from "node:fs";

const HARDENED = 0x80000000;
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export type Account = { name: string; mnemonic: string; privateKey: string; address: string };

const toBigInt = (bytes: Uint8Array): bigint => BigInt("0x" + Buffer.from(bytes).toString("hex"));

const to32 = (value: bigint): Uint8Array => {
  const hex = value.toString(16).padStart(64, "0");
  return Uint8Array.from(Buffer.from(hex, "hex"));
};

export function deriveKey(mnemonic: string) {
  const seed = pbkdf2(sha512, mnemonic.normalize("NFKD"), "mnemonic", { c: 2048, dkLen: 64 });
  let I = hmac(sha512, "Bitcoin seed", seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  const path = [44 + HARDENED, 5757 + HARDENED, HARDENED, 0, 0];
  for (const index of path) {
    const hardened = index >= HARDENED;
    const data = hardened ? Uint8Array.from([0, ...key]) : getPublicKey(key, true);
    const idx = Uint8Array.from([
      (index >>> 24) & 0xff,
      (index >>> 16) & 0xff,
      (index >>> 8) & 0xff,
      index & 0xff,
    ]);
    I = hmac(sha512, chain, Uint8Array.from([...data, ...idx]));
    // BIP32 child key is IL + k_par mod n, not IL alone.
    key = to32((toBigInt(I.slice(0, 32)) + toBigInt(key)) % SECP256K1_ORDER);
    chain = I.slice(32);
  }
  // Stacks private keys carry the compressed-pubkey flag byte, as Devnet.toml lists them.
  const privateKey = Buffer.from(key).toString("hex") + "01";
  return { privateKey, address: getAddressFromPrivateKey(privateKey, "testnet") };
}

export function loadAccounts(path: string): Account[] {
  const text = readFileSync(path, "utf8");
  const out: Account[] = [];
  for (const m of text.matchAll(/\[accounts\.([a-z0-9_]+)\]\s*\n(?:[^[]*?\n)?\s*mnemonic\s*=\s*"([^"]+)"/g)) {
    const [, name, mnemonic] = m;
    out.push({ name, mnemonic, ...deriveKey(mnemonic) });
  }
  return out;
}
