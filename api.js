/* Pemandu LP: akses data. Meteora (daftar pool, candle, portofolio) dan Solana RPC (mint authority, holder, saldo).
   Semua panggilan hanya membaca. Tidak ada private key. */
(function (root) {
'use strict';
const E = root.LPE || (typeof require !== 'undefined' ? require('./engine.js') : null);
const BASE = 'https://dlmm.datapi.meteora.ag';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTES = {}; QUOTES[SOL] = 'SOL'; QUOTES[USDC] = 'USDC'; QUOTES[USDT] = 'USDT';
const STABLE = {}; STABLE[USDC] = 1; STABLE[USDT] = 1;

let proxyOK = null; // null belum tahu, true proxy berhasil, false langsung berhasil
const num = v => { const x = typeof v === 'number' ? v : parseFloat(v); return isFinite(x) ? x : 0; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, timeout) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeout || 20000) : null;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: ctl ? ctl.signal : undefined });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally { if (t) clearTimeout(t); }
}
/* mode: 'auto' | 'direct' | 'proxy' */
async function meteora(path, mode) {
  const url = BASE + path;
  const viaProxy = () => getJSON('proxy.php?u=' + encodeURIComponent(url));
  if (mode === 'proxy' || proxyOK === true) return viaProxy();
  try {
    const j = await getJSON(url);
    proxyOK = false;
    return j;
  } catch (e) {
    if (mode === 'direct') throw e;
    if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) throw e; // salah permintaan, proxy tidak membantu
    try { const j = await viaProxy(); proxyOK = true; return j; }
    catch (e2) { throw new Error('Tidak bisa menghubungi Meteora (' + (e.message || 'jaringan') + '). Proxy server: ' + (e2.message || 'tidak tersedia')); }
  }
}
async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!r.ok) throw new Error('RPC HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('RPC: ' + (j.error.message || 'galat'));
  return j.result;
}

/* ---------- normalisasi pool ---------- */
function normPool(raw, now) {
  now = now || Date.now();
  if (!raw || !raw.token_x || !raw.token_y || !raw.pool_config) return null;
  const x = raw.token_x, y = raw.token_y;
  const tvl = num(raw.tvl), vol24 = num(raw.volume && raw.volume['24h']), fees24 = num(raw.fees && raw.fees['24h']);
  if (!(tvl > 0)) return null;
  const qx = !!QUOTES[x.address], qy = !!QUOTES[y.address];
  if (STABLE[x.address] && STABLE[y.address]) return null;               // stabil-stabil tidak dicakup model
  let side;
  if (qy && !qx) side = 'x'; else if (qx && !qy) side = 'y'; else side = num(x.market_cap) <= num(y.market_cap) ? 'x' : 'y';
  const tgt = side === 'x' ? x : y, oth = side === 'x' ? y : x;
  const established = !!tgt.is_verified && num(tgt.market_cap) >= 5e7 && num(tgt.holders) >= 20000;
  const feeBase = num(raw.pool_config.base_fee_pct);
  const feeEff = vol24 > 0 && fees24 > 0 ? fees24 / vol24 * 100 : feeBase;
  const ageDays = raw.created_at ? Math.max(0.05, (now - num(raw.created_at)) / 864e5) : 30;
  // SOL sebagai aset utama melawan stablecoin: ukur dalam SOL
  const measure = (x.address === SOL && STABLE[y.address]) ? 'base' : 'quote';
  const s = {
    addr: raw.address, tvl, vol: vol24, fee: feeEff, y0: fees24 / tvl, binStep: num(raw.pool_config.bin_step) || 10,
    sigma: 12, age: ageDays, top10: null, mint: null, freeze: tgt.freeze_authority_disabled === true ? true : tgt.freeze_authority_disabled === false ? false : null,
    established, measure
  };
  return {
    addr: raw.address, name: String(raw.name || (x.symbol + '-' + y.symbol)), s, feeEff, feeBase,
    tgt: { mint: tgt.address, symbol: tgt.symbol, holders: num(tgt.holders), mcap: num(tgt.market_cap), supply: num(tgt.total_supply), verified: !!tgt.is_verified },
    oth: { mint: oth.address, symbol: oth.symbol },
    reserves: [raw.reserve_x, raw.reserve_y].filter(Boolean),
    price: num(raw.current_price), launchpad: raw.launchpad || null, blacklisted: !!raw.is_blacklisted,
    fees24, vol24, feeTvl24: fees24 / tvl, tags: Array.isArray(raw.tags) ? raw.tags : []
  };
}
const q = o => Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');

async function fetchPools(opts, mode) {
  opts = opts || {};
  const minTvl = opts.minTvl || 100000;
  const lists = [
    { page: 1, page_size: 100, sort_by: 'fee_tvl_ratio_24h:desc', filter_by: 'tvl>=' + minTvl + '&&volume_24h>=50000&&is_blacklisted=false' },
    { page: 1, page_size: 60, sort_by: 'volume_24h:desc', filter_by: 'tvl>=' + Math.max(minTvl, 500000) + '&&is_blacklisted=false' }
  ];
  const out = new Map(); let lastErr = null;
  for (const p of lists) {
    let j;
    try { j = await meteora('/pools?' + q(p), mode); }
    catch (e) {
      lastErr = e;
      try { const p2 = Object.assign({}, p); delete p2.filter_by; j = await meteora('/pools?' + q(p2), mode); } catch (e2) { lastErr = e2; continue; }
    }
    (j.data || []).forEach(r => {
      const P = normPool(r);
      if (P && !P.blacklisted && P.s.tvl >= minTvl && P.vol24 >= 50000 && !out.has(P.addr)) out.set(P.addr, P);
    });
  }
  if (!out.size && lastErr) throw lastErr;
  return Array.from(out.values());
}
async function fetchPool(addr, mode) { return normPool(await meteora('/pools/' + encodeURIComponent(addr), mode)); }
/* API Meteora menolak rentang lebih dari sekitar 72 jam per permintaan (diuji 73 candle OK, 101 ditolak),
   jadi rentang panjang diambil per potongan 72 jam lalu disambung. */
async function fetchCandles(addr, hours, mode) {
  const end = Math.floor(Date.now() / 1000), CH = 72 * 3600;
  const spans = [];
  for (let e = end, left = hours * 3600; left > 0; e -= CH, left -= CH) spans.push([e - Math.min(CH, left), e]);
  const parts = await Promise.all(spans.map(sp => meteora('/pools/' + encodeURIComponent(addr) + '/ohlcv?' + q({ timeframe: '1h', start_time: sp[0], end_time: sp[1] }), mode)));
  const seen = new Map();
  parts.forEach(j => ((j && j.data) || []).forEach(c => {
    const t = num(c.timestamp);
    if (t > 0) seen.set(t, { t, open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close), volume: num(c.volume) });
  }));
  return Array.from(seen.values()).filter(c => c.open > 0 && c.close > 0 && c.high > 0 && c.low > 0).sort((a, b) => a.t - b.t);
}

/* ---------- keamanan token via RPC ---------- */
async function checkToken(P, rpcUrl) {
  const out = { mint: null, top10: null, errors: [] };
  try {
    const r = await rpc(rpcUrl, 'getAccountInfo', [P.tgt.mint, { encoding: 'jsonParsed' }]);
    const info = r && r.value && r.value.data && r.value.data.parsed && r.value.data.parsed.info;
    if (info) { out.mint = info.mintAuthority == null; out.freeze = info.freezeAuthority == null; }
  } catch (e) { out.errors.push(e.message); }
  try {
    const r = await rpc(rpcUrl, 'getTokenLargestAccounts', [P.tgt.mint]);
    const list = (r && r.value) || [];
    const skip = new Set(P.reserves);
    const rest = list.filter(a => !skip.has(a.address)).slice(0, 10);
    const sum = rest.reduce((t, a) => t + num(a.uiAmount != null ? a.uiAmount : a.uiAmountString), 0);
    if (P.tgt.supply > 0 && rest.length) out.top10 = Math.min(100, sum / P.tgt.supply * 100);
  } catch (e) { out.errors.push(e.message); }
  return out;
}
async function solBalance(addr, rpcUrl) {
  const r = await rpc(rpcUrl, 'getBalance', [addr]);
  return num(r && r.value) / 1e9;
}

/* ---------- portofolio wallet (baca saja) ---------- */
async function openPositions(wallet, mode) {
  const j = await meteora('/portfolio/open?' + q({ user: wallet, page: 1, page_size: 50 }), mode);
  return {
    solPrice: num(j.solPrice),
    pools: (j.pools || []).map(p => ({
      addr: p.poolAddress, name: (p.tokenX || '?') + '-' + (p.tokenY || '?'), deposit: num(p.totalDeposit), pnl: num(p.pnl), pnlPct: num(p.pnlPctChange),
      unclaimed: num(p.unclaimedFees), feeTvl24: num(p.feePerTvl24h), count: num(p.openPositionCount), outOfRange: num(p.positionsOutOfRange)
    }))
  };
}
async function closedPositions(wallet, days, mode) {
  const j = await meteora('/portfolio?' + q({ user: wallet, page: 1, page_size: 50, days_back: days || 90 }), mode);
  return (j.pools || []).map(p => {
    let ts = num(p.lastClosedAt); if (ts > 0 && ts < 1e12) ts *= 1000;
    return {
      addr: p.poolAddress, name: (p.tokenX || '?') + '-' + (p.tokenY || '?'), closedAt: ts, deposit: num(p.totalDeposit), withdrawal: num(p.totalWithdrawal), fee: num(p.totalFee),
      pnlUsd: num(p.pnlUsd), pnlPct: num(p.pnlPctChange), pnlSolPct: num(p.pnlSolPctChange)
    };
  });
}
const validAddr = a => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.trim());

root.LPAPI = { BASE, SOL, QUOTES, normPool, fetchPools, fetchPool, fetchCandles, checkToken, solBalance, openPositions, closedPositions, validAddr, meteora, rpc, sleep };
if (typeof module !== 'undefined' && module.exports) module.exports = root.LPAPI;
})(typeof window !== 'undefined' ? window : globalThis);
