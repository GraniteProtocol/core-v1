// Post-deploy verification for the new staging USDCx market at SP2N615.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const t = require('@stacks/transactions');

const API = 'https://api.hiro.so';
const D = 'SP2N615VZET7VD3DK3SCGPRXFSA9XSJW89KRC2Y30';
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const USDCX = 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx';
const MEMBERS = [
  'SPTXMEW26M54HX1ZXF6VN7QKK4XES1038ERD40T5',
  'SP3ZPYKVNAQK52YDSQKEHZ3MZQ5MFFZ52E0TH7TJ1',
  'SP3XD84X3PE79SHJAZCDW1V5E9EA8JSKRBPEKAEK7',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, opts = {}) {
  for (let i = 0; i < 8; i++) {
    await sleep(1200);
    const r = await fetch(url, opts);
    const text = await r.text();
    if (r.status === 429 || text.startsWith('Per-minute')) { await sleep(15000 * (i + 1)); continue; }
    try { return JSON.parse(text); } catch { return { _error: text.slice(0, 120) }; }
  }
  return { _error: 'rate-limited' };
}
async function call(contractId, fn, args = []) {
  const [dep, name] = contractId.split('.');
  const j = await request(`${API}/v2/contracts/call-read/${dep}/${name}/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: dep, arguments: args.map((a) => t.cvToHex(a)) }),
  });
  return j.okay ? t.cvToJSON(t.hexToCV(j.result)) : { error: j.cause };
}
async function mapEntry(contractId, map, key) {
  const [dep, name] = contractId.split('.');
  const j = await request(`${API}/v2/map_entry/${dep}/${name}/${map}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t.cvToHex(key)),
  });
  return j.data ? t.cvToJSON(t.hexToCV(j.data)) : { error: j };
}
async function dataVar(contractId, name) {
  const [dep, cname] = contractId.split('.');
  const j = await request(`${API}/v2/data_var/${dep}/${cname}/${name}`);
  return j.data ? t.cvToJSON(t.hexToCV(j.data)) : { error: j };
}
function val(x) {
  if (x && typeof x === 'object' && 'value' in x) return val(x.value);
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    const o = {};
    for (const [k, v] of Object.entries(x)) if (k !== 'type') o[k] = val(v);
    return o;
  }
  return x;
}

const results = [];
const canon = (x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])]))
  : x);
const check = (name, got, expected) => {
  const ok = JSON.stringify(canon(got)) === JSON.stringify(canon(expected));
  results.push({ name, ok, got, expected });
};

// 1. All 18 contracts exist at the new deployer and resolve their baked sources.
const contracts = ['constants-v1','constants-v2','math-v1','state-v1','linear-kinked-ir-v1','pyth-adapter-v1','staking-reward-v1','staking-v1','withdrawal-caps-v1','borrower-v1','trait-flash-loan-v1','flash-loan-v1','meta-governance-v1','governance-v1','linear-kinked-ir-utility','liquidator-v1','liquidity-provider-v1','utility'];
const missing = [];
for (const c of contracts) {
  const s = await request(`${API}/v2/contracts/source/${D}/${c}`);
  if (!s.source) missing.push(c);
}
check('all 18 contracts published', missing, []);

check('state-v1 governance', val(await call(`${D}.state-v1`, 'get-governance')), `${D}.governance-v1`);
check('market token decimals', val(await call(`${D}.constants-v1`, 'get-market-token-decimals')), '6');
check('sBTC collateral', val(await call(`${D}.state-v1`, 'get-collateral', [t.principalCV(SBTC)])), { 'max-ltv': '45000000', 'liquidation-ltv': '45000001', 'liquidation-premium': '10000000', decimals: '8' });
check('IR params', val(await call(`${D}.linear-kinked-ir-v1`, 'get-ir-params')), { 'base-ir': '3000000000000', 'ir-slope-1': '130000000000', 'utilization-kink': '700000000000', 'ir-slope-2': '2000000000000' });
check('asset cap', val(await call(`${D}.state-v1`, 'get-asset-cap')), '25000000000000');
check('protocol reserve', val(await call(`${D}.state-v1`, 'get-protocol-reserve-percentage')), '25000000');
check('refill window', val(await call(`${D}.withdrawal-caps-v1`, 'get-refill-time-window')), '36000');
check('decay window', val(await call(`${D}.withdrawal-caps-v1`, 'get-decay-time-window')), '10800');
check('lp cap', val(await call(`${D}.withdrawal-caps-v1`, 'get-lp-cap-factor')), '0');
check('debt cap', val(await call(`${D}.withdrawal-caps-v1`, 'get-debt-cap-factor')), '0');
check('sbtc cap', val(await call(`${D}.withdrawal-caps-v1`, 'get-collateral-cap-factor', [t.principalCV(SBTC)])), '0');
check('pyth time delta', val(await call(`${D}.pyth-adapter-v1`, 'get-pyth-time-delta')), '300');
check('pyth min delta', val(await call(`${D}.pyth-adapter-v1`, 'get-pyth-minimum-time-delta')), '15');
check('feed sbtc', val(await mapEntry(`${D}.pyth-adapter-v1`, 'price-feeds', t.principalCV(SBTC))), { 'feed-id': '1', 'max-confidence-ratio': '500' });
check('feed usdcx', val(await mapEntry(`${D}.pyth-adapter-v1`, 'price-feeds', t.principalCV(USDCX))), { 'feed-id': '7', 'max-confidence-ratio': '100' });
check('flash fee', val(await call(`${D}.flash-loan-v1`, 'get-fee')), '10');
check('flash allow-any', val(await dataVar(`${D}.flash-loan-v1`, 'allow-any')), true);
check('staking reward', val(await call(`${D}.staking-reward-v1`, 'get-reward-params')), { 'base-reward': '0', 'slope-1': '0', 'slope-2': '-1', 'staked-kink': '99999999' });
check('staking withdrawal period', val(await call(`${D}.staking-v1`, 'get-withdrawal-finalization-period')), '100');
check('meta count', val(await call(`${D}.meta-governance-v1`, 'governance-multisig-count')), '3');
for (const m of MEMBERS) check(`meta member ${m.slice(0, 8)}`, val(await call(`${D}.meta-governance-v1`, 'is-governance-member', [t.principalCV(m)])), true);
for (const m of MEMBERS) check(`guardian ${m.slice(0, 8)}`, val(await call(`${D}.governance-v1`, 'is-guardian', [t.principalCV(m)])), true);
for (const c of ['liquidity-provider-v1','borrower-v1','liquidator-v1','staking-v1','flash-loan-v1']) {
  check(`allowed ${c}`, val(await call(`${D}.state-v1`, 'is-allowed-contract', [t.principalCV(`${D}.${c}`)])), true);
}
for (const f of ['is-borrow-enabled','is-repay-enabled','is-add-collateral-enabled','is-remove-collateral-enabled','is-liquidation-enabled','is-interest-accrual-enabled','are-upgrades-enabled','is-deposit-asset-enabled','is-withdraw-asset-enabled','is-staking-enabled']) {
  check(`flag ${f}`, val(await call(`${D}.state-v1`, f)), true);
}
check('lp initialized (total supply = dust)', val(await call(`${D}.state-v1`, 'get-total-supply')), '1000');
check('utility market state ok', Boolean(val(await call(`${D}.utility`, 'get-market-state'))), true);
const caps = val(await call(`${D}.utility`, 'get-market-withdrawal-caps', [t.uintCV(0)]));
check('utility caps shape', Boolean(caps && caps.lp && caps.debt), true);

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, failed: failed.length, failures: failed }, null, 2));
