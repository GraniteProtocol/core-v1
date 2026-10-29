// Regenerates deployments/staging-usdcx-plan-v1.yaml for a deployer section named on the command line.
// Requires contracts/pyth-lazer/node_modules (@stacks/wallet-sdk, @scure, c32check) and clarinet on PATH.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SECTION = opt('account', 'staging-deployer');
const SETTINGS = path.resolve(opt('settings', path.join(REPO, 'settings/Mainnet.toml')));
const PLAN = path.resolve(opt('plan', path.join(REPO, 'deployments/staging-usdcx-plan-v1.yaml')));
const DERIVATION = "m/44'/5757'/0'/0/0";

const libRoot = [
  opt('deps', ''),
  path.join(REPO, 'contracts/pyth-lazer/package.json'),
  path.join(REPO, 'package.json'),
].filter(Boolean).find((p) => fs.existsSync(p));
if (!libRoot) throw new Error('no package.json found to resolve dependencies from');
const require = createRequire(libRoot);
const bip39 = require('@scure/bip39');
const bip32 = require('@scure/bip32');
const c32 = require('c32check');
const walletSdk = require('@stacks/wallet-sdk');

function accounts(file) {
  const out = {};
  let cur = null;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    const table = line.match(/^\[(.+)]$/);
    if (table) { cur = table[1]; out[cur] = {}; continue; }
    if (!cur) continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"(.*)"\s*$/);
    if (kv) out[cur][kv[1]] = kv[2];
  }
  return out;
}

const table = `accounts.${SECTION}`;
const all = accounts(SETTINGS);
const entry = all[table];
if (!entry) throw new Error(`[${table}] not found in ${SETTINGS}`);
if (!entry.mnemonic) throw new Error(`[${table}] has no mnemonic`);
const sharedWith = Object.entries(all)
  .filter(([name, cfg]) => name !== table && cfg.mnemonic === entry.mnemonic)
  .map(([name]) => name);
if (sharedWith.length) throw new Error(`[${table}] mnemonic is shared with ${sharedWith.join(', ')}`);

const english = require('@scure/bip39/wordlists/english.js');
const wordlist = english.wordlist || english.english || english;
if (!bip39.validateMnemonic(entry.mnemonic, wordlist)) {
  throw new Error(`[${table}] mnemonic is not a valid BIP39 phrase`);
}

if (entry.derivation && entry.derivation !== DERIVATION) {
  throw new Error(`[${table}] uses derivation ${entry.derivation}; this script only handles ${DERIVATION}`);
}
// Stacks addresses hash the compressed public key; deriving from the raw 32-byte key gives a different address.
const rootNode = bip32.HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(entry.mnemonic));
const derived = walletSdk.deriveAccount({
  rootNode,
  index: 0,
  salt: '',
  stxDerivationType: walletSdk.DerivationType.Wallet,
});
const { getAddressFromPrivateKey } = require('@stacks/transactions');
const address = getAddressFromPrivateKey(derived.stxPrivateKey, 'mainnet');

const [version, hash160] = c32.c32addressDecode(address);
if (version !== 22 || !/^[0-9a-f]{40}$/.test(hash160)) {
  throw new Error(`derived principal is not a mainnet single-sig address: ${address}`);
}
const expect = opt('expect', '');
if (expect && expect !== address) {
  throw new Error(`derived ${address} does not match --expect ${expect}`);
}

// The plan body is authored by hand; force the one ordering the market requires.
function capBeforeLpInitialize(text) {
  const lines = text.split('\n');
  const indent = (l) => l.length - l.trimStart().length;
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {8}- contract-call:$/.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== '' && indent(lines[end]) > 8) end++;
    const field = (name) => {
      const l = lines.slice(i, end).find((x) => x.trim().startsWith(`${name}:`));
      return l ? l.trim().slice(name.length + 1).trim() : '';
    };
    blocks.push({ start: i, end, lines: lines.slice(i, end), contractId: field('contract-id'), method: field('method') });
  }
  const lp = blocks.findIndex((b) => b.contractId.endsWith('.liquidity-provider-v1') && b.method === 'initialize');
  const cap = blocks.findIndex((b) => b.contractId.endsWith('.state-v1') && b.method === 'update-asset-cap');
  if (lp === -1) return { text, reordered: false };
  if (cap === -1) throw new Error('plan calls liquidity-provider-v1.initialize without state-v1.update-asset-cap');
  if (cap < lp) return { text, reordered: false };
  const a = blocks[lp], b = blocks[cap];
  const out = [
    ...lines.slice(0, a.start),
    ...b.lines,
    ...lines.slice(a.end, b.start),
    ...a.lines,
    ...lines.slice(b.end),
  ];
  return { text: out.join('\n'), reordered: true };
}

const text = fs.readFileSync(PLAN, 'utf8');
const senders = new Set([...text.matchAll(/expected-sender:\s*([SM][0-9A-Z]{20,})/g)].map((m) => m[1]));
if (senders.size !== 1) {
  throw new Error(`expected exactly one expected-sender in the plan, found ${senders.size}`);
}
const [oldAddress] = [...senders];
let rewritten = text.split(oldAddress).join(address);
const order = capBeforeLpInitialize(rewritten);
if (order.reordered) console.log('plan: moved state-v1.update-asset-cap before liquidity-provider-v1.initialize');
rewritten = order.text;
fs.writeFileSync(PLAN, rewritten);

const principals = new Set(
  [...rewritten.matchAll(/'?([SM][0-9A-Z]{20,}(?:\.[a-zA-Z0-9-]+)?)/g)].map((m) => m[1]),
);
const invalid = [];
for (const p of principals) {
  const [addr] = p.split('.');
  try {
    const [v, h] = c32.c32addressDecode(addr);
    if (!((v === 22 || v === 20) && /^[0-9a-f]{40}$/.test(h))) invalid.push(p);
  } catch {
    invalid.push(p);
  }
}
if (invalid.length) throw new Error(`invalid principals: ${invalid.join(', ')}`);

const senderCount = (rewritten.match(new RegExp(address, 'g')) || []).length;
if (senderCount < 40) throw new Error(`unexpected deployer occurrence count: ${senderCount}`);

if (!flag('skip-chain-check')) {
  const api = 'https://api.hiro.so';
  const account = await (await fetch(`${api}/v2/accounts/${address}`)).json();
  // A publish is an outbound tx, so a non-zero nonce means the address has already deployed or sent.
  if (Number(account.nonce) !== 0) throw new Error(`${address} has nonce ${account.nonce}; not fresh`);
  const balance = BigInt(account.balance || 0);
  console.log(`chain: nonce 0, balance ${balance} uSTX`);
  if (balance === 0n) console.log('warning: deployer is unfunded; fund it before applying the plan');
}

const check = execFileSync('clarinet', ['deployments', 'check', '-m', 'Clarinet.toml'], {
  cwd: REPO,
  encoding: 'utf8',
});
const line = check.split('\n').find((l) => l.includes(path.basename(PLAN)));
if (!line || !line.includes('successfully checked')) {
  throw new Error(`clarinet did not accept the plan:\n${line || check}`);
}

console.log(`account: ${table}`);
console.log(`address: ${address}`);
console.log(`plan: ${PLAN}`);
console.log(`clarinet: ${line.trim()}`);
