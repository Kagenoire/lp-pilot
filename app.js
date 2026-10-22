/* Pemandu LP: antarmuka. Data disimpan di perangkat (localStorage). Hanya membaca wallet. */
(function () {
'use strict';
const E = window.LPE, A = window.LPAPI;
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = E.nf, pct = E.pct, clamp = E.clamp;
const KEY = 'lpp.v1';

/* ---------- state ---------- */
function defState() {
  return {
    settings: { wallet: '', rpc: 'https://api.mainnet-beta.solana.com', mode: 'auto', appetite: 'seimbang', minTvl: 100000, cap: 1, autoTrain: true },
    learner: E.newLearner(), tracked: [], practice: [], lastScan: null, wallet: { bal: null, t: 0, open: [], closed: [], err: null }, sec: {}
  };
}
function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!j) return defState();
    const d = defState(), s = Object.assign(d, j);
    s.settings = Object.assign(defState().settings, j.settings || {});
    s.learner = E.fixLearner(j.learner);
    const oc = j.learner && j.learner.counts;
    if (j.learner && j.learner.mv !== E.MV && oc && (oc.sim + oc.bt + oc.real + (oc.prac || 0)) > 0) {
      s.notice = 'Cara hitung aplikasi diperbarui (semua hasil sekarang dalam SOL dan bentuk Curve, Spot, Bid-Ask dibedakan). Angka belajar lama tidak sebanding lagi, jadi hasil belajar direset. Catatan trade nyata dan posisi latihanmu tetap ada. Jalankan Latih otomatis dan Uji mundur lagi.';
    }
    s.practice = Array.isArray(j.practice) ? j.practice : [];
    s.tracked = Array.isArray(j.tracked) ? j.tracked : [];
    s.sec = j.sec && typeof j.sec === 'object' ? j.sec : {};
    s.wallet = Object.assign(defState().wallet, j.wallet || {});
    return s;
  } catch (e) { return defState(); }
}
let S = load(), saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { } }, 150); }
let scanRes = null;                // hasil pemindaian terakhir (di memori)
let busy = false, stopFlag = false;

/* ---------- util tampilan ---------- */
const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
const capital = () => (S.wallet.bal != null && S.wallet.bal > 0.05) ? S.wallet.bal : S.settings.cap;
const sol = x => nf(x, 2) + ' SOL';
const sg = x => (x > 0.0005 ? 'pos' : x < -0.0005 ? 'neg' : '');
function ago(t) {
  if (!t) return 'belum pernah';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'baru saja'; if (m < 60) return m + ' mnt lalu';
  const h = Math.round(m / 60); if (h < 48) return h + ' jam lalu';
  return Math.round(h / 24) + ' hari lalu';
}
const chip = l => '<span class="chip ' + l + '">' + E.LABEL[l] + '</span>';
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3800);
}
function setNet(ok, msg) { const d = $('net'); d.className = 'dot ' + (ok ? 'ok' : 'bad'); d.title = msg || ''; d.setAttribute('aria-label', ok ? 'Koneksi data baik' : 'Koneksi data bermasalah'); }
const tick = () => new Promise(r => setTimeout(r, 0));
async function pmap(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  async function w() { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, w));
  return out;
}
const numIn = id => { const el = $(id); if (!el) return NaN; return parseFloat(String(el.value).replace(',', '.')); };

/* ---------- grafik SVG ---------- */
function ladderSVG(pn) {
  const x0 = 12, x1 = 348, base = 104, maxH = 84;
  const lo = Math.min(-20, (pn.pl - 1) * 100 - 6), hi = Math.max(20, (pn.ph - 1) * 100 + 6);
  const X = v => x0 + (v - lo) / (hi - lo) * (x1 - x0);
  const n = 56, rl = (pn.pl - 1) * 100, rw = (pn.ph - pn.pl) * 100, bw = (x1 - x0) / (hi - lo) * rw / n;
  const wts = E.shapeW(pn.strat, n), wmax = Math.max.apply(null, wts);
  let o = '';
  for (let i = 0; i < n; i++) {
    const c = rl + (i + 0.5) / n * rw;
    const h = 0.05 + 0.95 * wts[i] / wmax;
    const hh = h * maxH;
    o += '<rect class="' + (c < 0 ? 'bl' : 'br') + '" x="' + X(rl + i * rw / n).toFixed(1) + '" y="' + (base - hh).toFixed(1) + '" width="' + Math.max(1, bw - 0.6).toFixed(1) + '" height="' + hh.toFixed(1) + '" rx="1"/>';
  }
  o += '<line class="base" x1="' + x0 + '" x2="' + x1 + '" y1="' + base + '" y2="' + base + '"/>';
  [-75, -50, -25, 0, 25, 50, 75, 100].forEach(v => { if (v >= lo + 4 && v <= hi - 4) o += '<text class="ax" x="' + X(v).toFixed(1) + '" y="120" text-anchor="middle">' + (v > 0 ? '+' : '') + v + '%</text>'; });
  const px = X(0), an = px > 300 ? 'end' : px < 60 ? 'start' : 'middle';
  o += '<line class="pline" x1="' + px.toFixed(1) + '" x2="' + px.toFixed(1) + '" y1="14" y2="' + base + '"/>';
  o += '<text class="axk" x="' + px.toFixed(1) + '" y="9" text-anchor="' + an + '">harga sekarang</text>';
  return '<svg viewBox="0 0 360 132" role="img" aria-label="Sebaran likuiditas per bin">' + o + '</svg>';
}
function histSVG(hist) {
  const x0 = 12, bw = 21, base = 118, maxH = 96, mx = Math.max.apply(null, hist) || 1;
  let o = '';
  hist.forEach((c, i) => {
    const center = -100 + i * 10 + 5, hh = c / mx * maxH;
    o += '<rect class="' + (center > 0 ? 'gb' : 'rb') + '" x="' + (x0 + i * bw + 1) + '" y="' + (base - hh).toFixed(1) + '" width="' + (bw - 2) + '" height="' + Math.max(0, hh).toFixed(1) + '" rx="2"/>';
  });
  o += '<line class="base" x1="' + x0 + '" x2="' + (x0 + 16 * bw) + '" y1="' + base + '" y2="' + base + '"/>';
  o += '<line class="pline" x1="' + (x0 + 10 * bw) + '" x2="' + (x0 + 10 * bw) + '" y1="8" y2="' + base + '"/>';
  [-100, -50, 0, 50].forEach(v => { o += '<text class="ax" x="' + (x0 + (v + 100) / 10 * bw) + '" y="134" text-anchor="middle">' + (v > 0 ? '+' : '') + v + '%</text>'; });
  return '<svg viewBox="0 0 360 150" role="img" aria-label="Sebaran hasil simulasi">' + o + '</svg>';
}
function lineSVG(vals, label) {
  if (vals.length < 3) return '<p class="note">Belum cukup data untuk grafik.</p>';
  const W = 360, H = 110, x0 = 8, x1 = 352, yt = 10, yb = 92;
  const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals), sp = (mx - mn) || 1;
  const X = i => x0 + i / (vals.length - 1) * (x1 - x0), Y = v => yb - (v - mn) / sp * (yb - yt);
  const pts = vals.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ');
  let o = '<polygon class="area" points="' + x0 + ',' + yb + ' ' + pts + ' ' + x1 + ',' + yb + '"/>';
  o += '<polyline class="ln" points="' + pts + '"/>';
  o += '<line class="base" x1="' + x0 + '" x2="' + x1 + '" y1="' + yb + '" y2="' + yb + '"/>';
  o += '<text class="ax" x="' + x0 + '" y="106">' + nf(mn * 100, 1) + '%</text><text class="ax" x="' + x1 + '" y="106" text-anchor="end">' + nf(mx * 100, 1) + '%</text>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label) + '">' + o + '</svg>';
}
function pathSVG(path, pl, ph) {
  const W = 360, H = 130, x0 = 8, x1 = 352, yt = 8, yb = 112;
  const mn = Math.min(Math.min.apply(null, path), pl) * 0.97, mx = Math.max(Math.max.apply(null, path), ph) * 1.03;
  const X = i => x0 + i / (path.length - 1) * (x1 - x0), Y = v => yb - (v - mn) / (mx - mn) * (yb - yt);
  let o = '<rect class="band" x="' + x0 + '" y="' + Y(ph).toFixed(1) + '" width="' + (x1 - x0) + '" height="' + Math.max(1, Y(pl) - Y(ph)).toFixed(1) + '"/>';
  o += '<polyline class="ln" points="' + path.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ') + '"/>';
  o += '<line class="base" x1="' + x0 + '" x2="' + x1 + '" y1="' + yb + '" y2="' + yb + '"/>';
  o += '<text class="ax" x="' + x0 + '" y="126">hari 0</text><text class="ax" x="' + x1 + '" y="126" text-anchor="end">hari 7</text>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Jalur harga selama 7 hari dan rentang posisi">' + o + '</svg>';
}

/* ---------- navigasi ---------- */
const TITLES = { home: 'Beranda', pools: 'Pilih pool', play: 'Playground', learn: 'Belajar', set: 'Pengaturan' };
let view = 'home';
function go(v) {
  view = v;
  document.querySelectorAll('[data-view]').forEach(s => { s.hidden = s.dataset.view !== v; });
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-current', String(b.dataset.v === v)));
  $('title').textContent = TITLES[v];
  window.scrollTo(0, 0);
}
function openSheet(title, html) {
  $('sheet-title').textContent = title; $('sheet-body').innerHTML = html; $('sheet').hidden = false;
  document.body.classList.add('lock');
  try { history.pushState({ sheet: 1 }, ''); } catch (e) { }
}
function closeSheet(fromPop) {
  if ($('sheet').hidden) return;
  $('sheet').hidden = true; document.body.classList.remove('lock');
  if (!fromPop) { try { if (history.state && history.state.sheet) history.back(); } catch (e) { } }
}
window.addEventListener('popstate', () => closeSheet(true));

/* ---------- BERANDA ---------- */
function renderHome() {
  const w = S.settings.wallet, ok = A.validAddr(w), c = S.learner.counts;
  let h = '';
  if (S.notice) h += '<div class="panel"><h3>Pembaruan</h3><p class="note">' + esc(S.notice) + '</p><button class="btn small" data-act="notice-ok">Mengerti</button></div>';
  if (!ok) {
    h += '<div class="panel"><h3>Hubungkan wallet</h3><p class="note">Tempel alamat publik walletmu. Aplikasi hanya membaca saldo dan posisi LP. Jangan pernah memasukkan seed phrase atau private key ke aplikasi apa pun.</p>' +
      '<label class="f"><span class="lab">Alamat wallet Solana</span><input id="wallet-in" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Alamat publik, 32 sampai 44 karakter"></label>' +
      '<button class="btn primary" data-act="wallet-save">Hubungkan</button><p class="hint">Tanpa wallet pun playground dan rekomendasi tetap jalan memakai modal dari Pengaturan.</p></div>';
  } else {
    const wl = S.wallet;
    h += '<div class="panel"><div class="row"><div><span class="k">Wallet</span><div class="num big2">' + esc(short(w)) + '</div></div><div class="right"><span class="k">Saldo SOL</span><div class="num big2">' + (wl.bal == null ? '-' : nf(wl.bal, 3)) + '</div></div></div>' +
      '<div class="row"><span class="hint">Terakhir disinkron ' + esc(ago(wl.t)) + '</span><button class="btn small" data-act="wallet-sync">Segarkan</button></div>' +
      (wl.err ? '<p class="alert">' + esc(wl.err) + '</p>' : '') + '</div>';
    h += '<h4>Posisi LP terbuka</h4>';
    if (!wl.open.length) h += '<p class="note">Tidak ada posisi terbuka yang terbaca. Kalau kamu sudah punya posisi, tekan Segarkan.</p>';
    else h += '<ul class="rows">' + wl.open.map(p => '<li class="fr2"><div><b>' + esc(p.name) + '</b><div class="hint">' + p.count + ' posisi' + (p.outOfRange ? ' · ' + p.outOfRange + ' di luar rentang' : '') + '</div></div><div class="right"><b class="num ' + sg(p.pnlPct) + '">' + nf(p.pnlPct, 1) + '%</b><div class="hint">fee belum diklaim $' + nf(p.unclaimed, 2) + '</div></div></li>').join('') + '</ul>';
  }
  const tr = S.tracked.slice().reverse();
  h += '<h4>Posisi yang dicatat aplikasi</h4>';
  if (!tr.length) h += '<p class="note">Belum ada. Dari halaman Pilih pool, tekan "Catat: saya buka posisi ini" setelah kamu membuka posisi di Meteora. Hasilnya nanti dipelajari otomatis.</p>';
  else h += '<ul class="rows">' + tr.map(t => {
    const st = t.status === 'closed' ? 'Selesai' : t.status === 'open' ? 'Terbuka' : 'Menunggu terdeteksi';
    return '<li class="fr3"><div class="row"><div><b>' + esc(t.name) + '</b><div class="hint">' + esc(E.STRATS[t.strat] ? E.STRATS[t.strat].name : t.strat) + ' · ' + sol(t.size) + ' · ' + esc(ago(t.openedAt)) + '</div></div>' +
      '<div class="right"><span class="pill ' + (t.status === 'closed' ? 'ok' : 'warn') + '">' + st + '</span>' + (t.real != null ? '<div class="num ' + sg(t.real) + '"><b>' + pct(t.real) + '</b></div>' : '') + '</div></div>' +
      (t.status !== 'closed' ? '<div class="row2"><input id="tc-' + t.id + '" type="text" inputmode="decimal" autocomplete="off" placeholder="Hasil akhir (%)" aria-label="Hasil akhir dalam persen"><button class="btn small" data-act="tracked-close" data-id="' + t.id + '">Catat hasil</button><button class="btn small ghost" data-act="tracked-del" data-id="' + t.id + '">Hapus</button></div>' : '') + '</li>';
  }).join('') + '</ul>';
  if (ok && S.wallet.closed.length) {
    const tot = S.wallet.closed.reduce((a, p) => a + p.pnlUsd, 0);
    h += '<h4>Riwayat 90 hari terakhir</h4><p class="note">' + S.wallet.closed.length + ' pool ditutup, total untung-rugi <b class="num ' + sg(tot) + '">$' + nf(tot, 2) + '</b>.</p>';
  }
  h += '<div class="panel"><h3>Pengalaman aplikasi</h3><div class="stats3"><div><span class="k">Playground</span><b class="num">' + c.sim + '</b></div><div><span class="k">Data nyata</span><b class="num">' + c.bt + '</b></div><div><span class="k">Latihan</span><b class="num">' + (c.prac || 0) + '</b></div><div><span class="k">Trade kamu</span><b class="num">' + c.real + '</b></div></div>' +
    '<p class="hint">' + (c.sim + c.bt + c.real === 0 ? 'Belum belajar apa-apa. Mulai dari tab Playground agar rekomendasi tidak murni tebakan.' : 'Detail ada di tab Belajar.') + '</p><button class="btn" data-act="how">Cara kerja aplikasi ini</button></div>';
  $('home-body').innerHTML = h;
}

async function syncWallet(quiet) {
  const w = S.settings.wallet;
  if (!A.validAddr(w)) return;
  const mode = S.settings.mode;
  const r = await Promise.allSettled([A.solBalance(w, S.settings.rpc), A.openPositions(w, mode), A.closedPositions(w, 90, mode)]);
  const errs = [];
  if (r[0].status === 'fulfilled') S.wallet.bal = r[0].value; else errs.push('Saldo: ' + r[0].reason.message);
  if (r[1].status === 'fulfilled') S.wallet.open = r[1].value.pools; else errs.push('Posisi: ' + r[1].reason.message);
  if (r[2].status === 'fulfilled') S.wallet.closed = r[2].value; else errs.push('Riwayat: ' + r[2].reason.message);
  S.wallet.t = Date.now(); S.wallet.err = errs.length ? errs.join(' | ') : null;
  setNet(errs.length < 3, errs.join(' | '));
  if (r[1].status === 'fulfilled' && r[2].status === 'fulfilled') reconcile();
  save(); renderHome();
  if (!quiet) toast(errs.length ? 'Sebagian data gagal dibaca. Lihat catatan di Beranda.' : 'Wallet disinkron.');
}
function reconcile() {
  S.tracked.forEach(t => {
    if (t.status === 'closed') return;
    const op = S.wallet.open.find(p => p.addr === t.addr);
    if (op) { t.status = 'open'; t.seen = true; t.lastPnlPct = op.pnlPct; return; }
    if (t.seen) {
      const c = S.wallet.closed.find(p => p.addr === t.addr && p.closedAt >= t.openedAt - 36e5);
      if (c) closeTracked(t, (c.pnlSolPct || c.pnlPct) / 100, 'wallet');
    }
  });
}
function closeTracked(t, real, src) {
  const pred = t.snap ? t.snap.predAdj : null;
  if (t.snap) E.learnReal(S.learner, t.snap, clamp(real, -1, 5));
  t.status = 'closed'; t.real = real; t.closedAt = Date.now(); t.src = src;
  save();
  toast('Dipelajari: ' + t.name + (pred != null ? ' · perkiraan ' + pct(pred) + ', nyata ' + pct(real) : ' · nyata ' + pct(real)));
}

/* ---------- PILIH POOL ---------- */
function renderPools() {
  const ap = S.settings.appetite, cap = capital();
  let h = '<p class="note">Aplikasi memindai pool Meteora yang likuid, mengecek keamanan token, mengevaluasi 9 strategi per pool dengan pengalamannya, lalu menyisakan yang layak.</p>';
  h += '<div class="chips sm" role="group" aria-label="Gaya">' + Object.keys(E.APP).map(k => '<button type="button" data-act="app" data-k="' + k + '" aria-pressed="' + (k === ap) + '">' + E.APP[k].name + '</button>').join('') + '</div>';
  h += '<p class="hint">Modal dipakai: <b class="num">' + sol(cap) + '</b> ' + (S.wallet.bal != null && S.wallet.bal > 0.05 ? '(saldo wallet)' : '(dari Pengaturan)') + '</p>';
  h += '<button class="btn primary" data-act="scan" id="scan-btn">' + (busy ? 'Sedang bekerja…' : 'Cari pool sekarang') + '</button><p class="hint" id="scan-status"></p>';
  const items = scanRes ? scanRes.items.map(r => compactOf(r.P, r.ev)) : (S.lastScan ? S.lastScan.items : []);
  const when = scanRes ? scanRes.t : (S.lastScan ? S.lastScan.t : 0);
  if (items.length) {
    const ok = items.filter(i => !i.skip), no = items.length - ok.length;
    h += '<h4>Hasil pemindaian ' + esc(ago(when)) + '</h4>';
    if (!ok.length) h += '<div class="panel"><h3>Tahan SOL dulu</h3><p class="note">Tidak ada pool yang perkiraan hasilnya mengalahkan risikonya. Itu hasil yang jujur: banyak pool terlihat menarik karena fee tinggi, tapi tidak menutup rugi harga atau rug. Daftar di bawah adalah yang paling mendekati.</p></div>';
    h += '<ul class="picks">' + (ok.length ? ok : items).slice(0, 12).map((i, k) => pickHTML(i, k, !ok.length)).join('') + '</ul>';
    if (no && ok.length) h += '<p class="hint">' + no + ' pool lain ditolak karena risiko terlalu tinggi atau perkiraan hasil tidak positif.</p>';
  }
  $('pools-body').innerHTML = h;
}
function compactOf(P, ev) {
  const b = ev.best;
  return { addr: P.addr, name: P.name, label: ev.label, p: ev.rk.p, skip: ev.skip, strat: b.strat, half: b.plan.half, alloc: b.plan.alloc, mean: b.mean, p10: b.p10, win: b.sim.pWin, score: b.score, tvl: P.s.tvl };
}
function pickHTML(i, k, weak) {
  const sname = E.STRATS[i.strat].name;
  const rng = i.strat === 'bidask' ? '-' + i.half + '% s/d 0%' : '±' + i.half + '%';
  return '<li><button class="pick" data-act="pick" data-addr="' + esc(i.addr) + '"><div class="pick-top"><span class="rank">' + (k + 1) + '</span><span class="pname">' + esc(i.name) + '</span>' + chip(i.label) + '</div>' +
    '<div class="pick-mid">' + (i.skip ? (weak ? 'Belum layak. ' : '') + 'Strategi terbaik: ' : 'Saran: ') + '<b>' + sname + ' ' + rng + '</b>' + (i.skip ? '' : ' · pasang <b class="num">' + sol(i.alloc) + '</b>') + '</div>' +
    '<div class="pick-stats"><span><i>Rata-rata 7 hari</i><b class="num ' + sg(i.mean) + '">' + pct(i.mean) + '</b></span><span><i>Skenario buruk</i><b class="num ' + sg(i.p10) + '">' + pct(i.p10, 0) + '</b></span><span><i>Peluang untung</i><b class="num">' + nf(i.win * 100, 0) + '%</b></span></div></button></li>';
}

/* harga SOL sebagai acuan: hasil pool berpasangan dolar harus dikonversi ke SOL */
let solRef = null, solRefT = 0, solRefP = null;
function getSolRef(hint) {
  if (solRef && Date.now() - solRefT < 30 * 60000) return Promise.resolve(solRef);
  if (solRefP) return solRefP;
  solRefP = (async () => {
    try {
      let addr = S.solPool;
      if (!addr) {
        const list = hint || await A.fetchPools({ minTvl: S.settings.minTvl }, S.settings.mode);
        const c = list.filter(P => P.s.measure === 'base').sort((a, b) => b.s.tvl - a.s.tvl)[0];
        if (c) { addr = c.addr; S.solPool = addr; save(); }
      }
      if (!addr) return null;
      const cs = await A.fetchCandles(addr, 244, S.settings.mode);
      if (cs.length < 48) { S.solPool = null; return null; }
      solRef = { candles: cs, sigma: E.sigmaFromCandles(cs.slice(-72)) || E.SOL_SIGMA }; solRefT = Date.now();
      return solRef;
    } catch (e) { S.solPool = null; return null; } finally { solRefP = null; }
  })();
  return solRefP;
}
async function enrich(P, o) {
  o = o || {};
  if (o.candles !== false) {
    try {
      const rs = await Promise.all([A.fetchCandles(P.addr, o.hours || 72, S.settings.mode), P.s.usdq ? getSolRef() : null]);
      const c = rs[0], sr = rs[1];
      P.candles = c;
      const s = E.sigmaFromCandles(c.slice(-72));
      if (s) { P.s.sigma = s; P.sigmaOK = true; }
      if (sr) P.s.solSigma = sr.sigma; else if (P.s.usdq) P.noSol = true;
      // volume 24 jam sering lonjakan sesaat: campur dengan rata-rata 3 hari supaya fee tidak dilebih-lebihkan
      if (c.length >= 72 && !P._yAdj) {
        const l24 = c.slice(-24).reduce((q, x) => q + x.volume, 0), a3 = c.slice(-72).reduce((q, x) => q + x.volume, 0) / 3;
        if (l24 > 0 && a3 > 0) { P.volPersist = a3 / l24; P.s.y0 *= clamp(0.5 + 0.5 * P.volPersist, 0.5, 1.2); P._yAdj = true; }
      }
    } catch (e) { P.sigmaErr = e.message; }
  }
  if (o.sec !== false && !P.s.established) {
    const c = S.sec[P.tgt.mint];
    if (c && Date.now() - c.t < 12 * 36e5) { P.s.mint = c.mint; P.s.top10 = c.top10; }
    else {
      try {
        const r = await A.checkToken(P, S.settings.rpc);
        if (r.mint != null || r.top10 != null) { S.sec[P.tgt.mint] = { t: Date.now(), mint: r.mint, top10: r.top10 }; P.s.mint = r.mint; P.s.top10 = r.top10; }
        if (r.errors.length) P.secErr = r.errors.join('; ');
      } catch (e) { P.secErr = e.message; }
    }
  }
  return P;
}
function prelim(P) { const a = E.assess(P.s); return Math.min(P.s.y0, 0.1) * 7 * 0.7 - a.rugRule * 0.9 + (P.s.established ? 0.01 : 0); }
const evalP = P => E.evaluateArms(P.s, S.learner, { cap: capital(), appetite: S.settings.appetite, N: 400 });

async function doScan() {
  if (busy) return; busy = true; renderPools();
  const st = () => $('scan-status');
  try {
    st().textContent = 'Mengambil daftar pool dari Meteora…';
    let pools = await A.fetchPools({ minTvl: S.settings.minTvl }, S.settings.mode);
    setNet(true, 'Meteora OK');
    if (!pools.length) throw new Error('Daftar pool kosong. Turunkan batas TVL minimum di Pengaturan.');
    pools.forEach(P => { P._pre = prelim(P); });
    const byPre = pools.slice().sort((a, b) => b._pre - a._pre);
    const byTvl = pools.slice().sort((a, b) => b.s.tvl - a.s.tvl).slice(0, 6);
    const pick = new Map(); byPre.slice(0, 22).concat(byTvl).forEach(P => pick.set(P.addr, P));
    const list = Array.from(pick.values());
    st().textContent = 'Membaca pergerakan harga ' + list.length + ' pool…'; await tick();
    await pmap(list, 5, P => enrich(P, { sec: false }));
    st().textContent = 'Mengecek keamanan token lewat RPC…'; await tick();
    const secList = list.filter(P => !P.s.established).sort((a, b) => b._pre - a._pre).slice(0, 10);
    for (const P of secList) { await enrich(P, { candles: false }); await A.sleep(250); }
    st().textContent = 'Mengevaluasi strategi…'; await tick();
    const items = list.map(P => ({ P, ev: evalP(P) }));
    items.sort((a, b) => (a.ev.skip - b.ev.skip) || (b.ev.best.score - a.ev.best.score));
    scanRes = { t: Date.now(), items };
    S.lastScan = { t: scanRes.t, items: items.map(r => compactOf(r.P, r.ev)).slice(0, 20) };
    save(); busy = false; renderPools();
    const okN = items.filter(r => !r.ev.skip).length;
    $('scan-status').textContent = okN + ' dari ' + items.length + ' pool dinilai layak.';
    const warn = items.filter(r => r.P.sigmaErr).length;
    if (warn > items.length / 2) toast('Data harga banyak yang gagal dibaca. Gerak harga memakai perkiraan.');
  } catch (e) {
    busy = false; setNet(false, e.message); renderPools();
    $('scan-status').textContent = 'Gagal: ' + e.message;
    toast('Gagal memindai. Coba Tes koneksi di Pengaturan.');
  }
}

/* ---------- detail pool ---------- */
function planHTML(ev, arm) {
  const pn = arm.plan;
  return '<div class="plan"><div><h3>' + (ev.skip ? 'Jangan masuk dulu' : E.STRATS[arm.strat].name) + '</h3><p class="desc">' + esc(ev.skip ? 'Hitungan di bawah memakai strategi ' + E.STRATS[arm.strat].name + ' sebagai yang terbaik, tapi hasilnya belum layak.' : E.STRATS[arm.strat].desc) + '</p></div>' +
    ladderSVG(pn) + '<dl class="kv"><div><dt>Rentang harga</dt><dd>' + (arm.strat === 'bidask' ? '-' + pn.half + '% s/d 0%' : '-' + pn.half + '% s/d +' + pn.half + '%') + '</dd></div>' +
    '<div><dt>Perkiraan jumlah bin</dt><dd>≈ ' + nf(pn.nBins) + ' <small>(' + pn.positions + ' posisi)</small></dd></div>' +
    '<div><dt>Pasang</dt><dd>' + sol(pn.alloc) + '</dd></div><div><dt>Sisakan</dt><dd>' + sol(pn.reserve) + '</dd></div></dl></div>';
}
function detailHTML(P, ev) {
  const arm = ev.best, sim = arm.sim;
  let h = '<p class="hint">TVL ' + E.fmtUSD(P.s.tvl) + ' · volume 24 jam ' + E.fmtUSD(P.vol24) + ' · fee efektif ' + nf(P.feeEff, 2) + '% · bin step ' + P.s.binStep + ' · umur pool ' + nf(P.s.age, P.s.age < 10 ? 1 : 0) + ' hari</p>';
  h += '<div class="row"><div>' + chip(ev.label) + '</div><span class="num">Peluang kerugian parah 7 hari: <b>' + nf(ev.rk.p * 100, 1) + '%</b></span></div>';
  if (P.sigmaErr) h += '<p class="alert">Data harga gagal dibaca, gerak harga memakai perkiraan 12% per hari.</p>';
  if (P.s.usdq) h += '<p class="note">Pool ini berpasangan dolar (USDC/USDT), sedangkan modalmu SOL. Semua angka di bawah sudah dihitung dalam SOL, jadi ikut menghitung risiko harga SOL naik-turun terhadap dolar.' + (P.noSol ? ' Data harga SOL gagal dibaca, jadi gerak SOL memakai perkiraan standar.' : '') + '</p>';
  if (P.volPersist != null && P.volPersist < 0.8) h += '<p class="alert">Volume 24 jam terakhir jauh di atas rata-rata 3 hari (rata-rata 3 hari hanya ' + nf(P.volPersist * 100, 0) + '% dari 24 jam terakhir). Lonjakan seperti ini sering tidak bertahan. Perkiraan fee sudah dikurangi, tapi tetap hati-hati.</p>';
  if (ev.a.unknown.length) h += '<p class="alert">Belum terverifikasi: ' + esc(ev.a.unknown.map(u => u === 'top10' ? 'holder terbesar' : u === 'mint' ? 'mint authority' : 'freeze authority').join(', ')) + '. Dianggap berisiko. Cek manual di RugCheck.</p>';
  h += planHTML(ev, arm);
  h += '<h4>Aturan keluar (contoh)</h4><ul class="ex">' + E.EXITS[ev.label].map(t => '<li>' + esc(t) + '</li>').join('') + '</ul>';
  h += '<div class="win"><b class="num">' + nf(sim.pWin * 100, 0) + '%</b><span>peluang berakhir untung setelah fee dalam 7 hari</span></div>' + histSVG(sim.hist);
  h += '<dl class="kv"><div><dt>Rata-rata (sudah dikoreksi pengalaman)</dt><dd class="' + sg(arm.mean) + '">' + pct(arm.mean) + '</dd></div><div><dt>Skenario buruk (1 dari 10)</dt><dd class="' + sg(arm.p10) + '">' + pct(arm.p10) + '</dd></div><div><dt>Rugi lebih dari 20%</dt><dd>' + nf(sim.pLoss20 * 100, 0) + '%</dd></div><div><dt>Koreksi dari pengalaman</dt><dd class="' + sg(arm.adj) + '">' + pct(arm.adj) + '</dd></div></dl>';
  h += '<h4>Faktor risiko</h4><ul class="rows">' + ev.a.rows.map(r => '<li class="fr"><span class="fn">' + esc(r.name) + '</span><span class="fv">' + esc(r.value) + '</span><span class="pill ' + r.level + '">' + (r.level === 'ok' ? 'Aman' : r.level === 'warn' ? 'Waspada' : 'Bahaya') + '</span><span class="fnote">' + esc(r.note) + '</span></li>').join('') + '</ul>';
  h += '<h4>Peringkat strategi</h4><div class="tblwrap"><table><thead><tr><th>Strategi</th><th>Rata-rata</th><th>Buruk</th><th>Koreksi</th></tr></thead><tbody>' +
    ev.arms.slice(0, 5).map(a => '<tr><td>' + E.STRATS[a.strat].name + ' ' + (a.strat === 'bidask' ? '-' : '±') + a.plan.half + '%</td><td class="' + sg(a.mean) + '">' + pct(a.mean) + '</td><td class="' + sg(a.p10) + '">' + pct(a.p10, 0) + '</td><td>' + pct(a.adj) + '</td></tr>').join('') + '</tbody></table></div>';
  h += '<div class="actions">' +
    '<a class="btn" href="https://app.meteora.ag/dlmm/' + esc(P.addr) + '" target="_blank" rel="noopener">Buka di Meteora</a>' +
    '<button class="btn" data-act="bt-pool" data-addr="' + esc(P.addr) + '">Uji mundur 7 hari (data nyata)</button>' +
    (ev.skip ? '' : '<div class="trackbox"><label class="f"><span class="lab">Berapa SOL yang akan kamu pasang?</span><input id="track-size" type="text" inputmode="decimal" autocomplete="off" value="' + arm.plan.alloc + '"></label><button class="btn primary" data-act="track" data-addr="' + esc(P.addr) + '">Catat: saya buka posisi ini</button><p class="hint">Aplikasi tidak membuka posisi. Kamu membukanya di Meteora, lalu aplikasi memantau wallet dan belajar dari hasilnya.</p></div>') +
    '</div><div id="bt-out"></div>';
  return h;
}
let curDetail = null;
async function openPool(addr) {
  let rec = scanRes && scanRes.items.find(r => r.P.addr === addr);
  if (!rec) {
    openSheet('Memuat pool…', '<p class="note">Mengambil data terbaru.</p>');
    try {
      const P = await A.fetchPool(addr, S.settings.mode);
      if (!P) throw new Error('Pool tidak ditemukan.');
      await enrich(P);
      rec = { P, ev: evalP(P) };
    } catch (e) { $('sheet-body').innerHTML = '<p class="alert">' + esc(e.message) + '</p>'; return; }
  } else { rec.ev = evalP(rec.P); openSheet(rec.P.name, ''); }
  curDetail = rec;
  $('sheet-title').textContent = rec.P.name;
  $('sheet-body').innerHTML = detailHTML(rec.P, rec.ev);
}
function trackPool(addr) {
  if (!curDetail || curDetail.P.addr !== addr) return;
  const size = numIn('track-size');
  if (!(size > 0)) { toast('Isi jumlah SOL yang valid.'); return; }
  const { P, ev } = curDetail, arm = ev.best;
  S.tracked.push({
    id: 't' + Date.now().toString(36), addr: P.addr, name: P.name, openedAt: Date.now(), size, strat: arm.strat, half: arm.plan.half, status: 'planned',
    snap: { bucket: ev.bucket, key: arm.key, pred: arm.sim.mean, predAdj: arm.mean, x: ev.rk.x, priorLogit: E.logit(clamp(ev.a.rugRule, 0.001, 0.9)) }
  });
  save(); closeSheet(); renderHome(); toast('Dicatat. Buka posisinya di Meteora, lalu Segarkan di Beranda.');
}
async function backtestOne(addr) {
  const out = $('bt-out'); if (!out) return;
  out.innerHTML = '<p class="note">Mengambil data harga 10 hari terakhir…</p>';
  try {
    let rec = curDetail && curDetail.P.addr === addr ? curDetail : null;
    const P = rec.P;
    const rs = await Promise.all([A.fetchCandles(P.addr, 244, S.settings.mode), P.s.usdq ? getSolRef() : null]);
    const c = rs[0], sr = rs[1];
    const r = E.backtestPool(P, c, S.learner, { cap: capital(), appetite: S.settings.appetite, solCandles: sr && sr.candles });
    if (!r) { out.innerHTML = '<p class="alert">Data harga kurang dari 8 hari untuk pool ini.</p>'; return; }
    save();
    out.innerHTML = '<h4>Hasil uji mundur (7 hari terakhir, harga nyata)</h4><div class="tblwrap"><table><thead><tr><th>Strategi</th><th>Perkiraan</th><th>Nyata</th></tr></thead><tbody>' +
      r.ev.arms.map((a, j) => '<tr><td>' + E.STRATS[a.strat].name + ' ' + (a.strat === 'bidask' ? '-' : '±') + a.plan.half + '%</td><td>' + pct(a.sim.mean) + '</td><td class="' + sg(r.nets[j]) + '"><b>' + pct(r.nets[j]) + '</b></td></tr>').join('') + '</tbody></table></div>' +
      '<p class="hint">Harga akhir ' + pct(r.pEnd - 1) + ' dari harga awal.' + (P.s.usdq ? (r.noSol ? ' Harga SOL tidak terbaca, hasil ini belum memperhitungkan gerak SOL.' : ' Dalam jendela yang sama harga SOL berubah ' + pct(r.solR - 1) + ' terhadap dolar, dan itu sudah dihitung.') : '') + ' Fee dihitung dari volume per jam dan TVL sekarang, jadi ini perkiraan. Hasilnya sudah dipelajari.</p>';
    toast('Uji mundur selesai dan dipelajari.');
  } catch (e) { out.innerHTML = '<p class="alert">Gagal: ' + esc(e.message) + '</p>'; }
}


/* ---------- latihan di LP Army: pool, strategi, dan lebar dicatat, hasil dibandingkan dengan perkiraan ---------- */
function knownPools() {
  const m = new Map();
  if (scanRes) scanRes.items.forEach(r => m.set(r.P.addr, r.P.name));
  else if (S.lastScan) S.lastScan.items.forEach(i => m.set(i.addr, i.name));
  return Array.from(m.entries());
}
function practiceHTML() {
  const pl = knownPools();
  let h = '<div class="panel"><h3>Latihan di LP Army</h3><p class="note">Buka posisi latihan di LP Army, lalu catat di sini pool, strategi, dan lebar rentangnya. Aplikasi menghitung perkiraan untuk persis pilihan itu. Setelah minimal 5 hari (idealnya 7), kamu tutup posisinya dan masukkan hasilnya. Selisih perkiraan dan hasil nyata itulah yang dipelajari.</p>' +
    '<a class="btn" href="https://www.lparmy.com/playground" target="_blank" rel="noopener">Buka LP Army Playground</a>' +
    '<label class="f"><span class="lab">Pool (dari hasil pemindaian)</span><select id="pr-pool"><option value="">' + (pl.length ? 'Pilih pool' : 'Belum ada hasil pemindaian') + '</option>' + pl.map(x => '<option value="' + esc(x[0]) + '">' + esc(x[1]) + '</option>').join('') + '</select></label>' +
    '<label class="f"><span class="lab">Atau tempel alamat pool (dari alamat web Meteora)</span><input id="pr-addr" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Kosongkan kalau sudah memilih di atas"></label>' +
    '<div class="grid"><label class="f"><span class="lab">Strategi</span><select id="pr-strat">' + Object.keys(E.STRATS).map(k => '<option value="' + k + '">' + E.STRATS[k].name + '</option>').join('') + '</select></label>' +
    '<label class="f"><span class="lab">Lebar rentang (%)</span><input id="pr-half" type="text" inputmode="decimal" autocomplete="off" placeholder="mis. 6 untuk ±6%"></label></div>' +
    '<p class="hint">Curve dan Spot: isi setengah lebar (6 untuk -6% sampai +6%). Bid-Ask: isi berapa persen ke bawah (mis. 40 untuk -40% sampai 0%).</p>' +
    '<label class="f"><span class="lab">Sudah dibuka berapa jam yang lalu? (kosongkan kalau baru)</span><input id="pr-ago" type="text" inputmode="decimal" autocomplete="off" placeholder="mis. 12"></label>' +
    '<button class="btn primary" data-act="prac-start">Catat posisi latihan</button></div>';
  return h + '<div id="prac-lists">' + pracLists() + '</div>';
}
function pracLists() {
  const op = S.practice.filter(x => x.status === 'open'), dn = S.practice.filter(x => x.status === 'done').slice(-5).reverse();
  let h = '<h4>Posisi latihan berjalan</h4>';
  if (!op.length) h += '<p class="note">Belum ada.</p>';
  else h += '<ul class="rows">' + op.slice().reverse().map(x => {
    const d = (Date.now() - x.t0) / 864e5;
    return '<li class="fr3"><div class="row"><div><b>' + esc(x.name) + '</b><div class="hint">' + esc(E.STRATS[x.strat].name) + ' ' + (x.strat === 'bidask' ? '-' + x.half + '% s/d 0%' : '±' + x.half + '%') + ' · hari ke-' + nf(Math.floor(d) + 1, 0) + ' dari 7</div></div>' +
      '<div class="right"><div class="hint">perkiraan rata-rata</div><b class="num ' + sg(x.mean) + '">' + pct(x.mean) + '</b></div></div>' +
      '<div class="hint">Skenario buruk ' + pct(x.p10, 0) + ' · peluang untung ' + nf(x.win * 100, 0) + '%' + (d < 5 ? ' · tutup posisi di LP Army setelah hari ke-5' : '') + '</div>' +
      '<div class="row2"><input id="pc-' + x.id + '" type="text" inputmode="decimal" autocomplete="off" placeholder="Hasil akhir (%)" aria-label="Hasil akhir dalam persen"><button class="btn small" data-act="prac-close" data-id="' + x.id + '">Catat hasil</button><button class="btn small ghost" data-act="prac-del" data-id="' + x.id + '">Hapus</button></div></li>';
  }).join('') + '</ul>';
  if (dn.length) h += '<h4>Latihan selesai</h4><ul class="rows">' + dn.map(x => '<li class="fr2"><div><b>' + esc(x.name) + '</b><div class="hint">' + esc(E.STRATS[x.strat].name) + ' ' + (x.strat === 'bidask' ? '-' + x.half + '%' : '±' + x.half + '%') + ' · perkiraan ' + pct(x.mean) + '</div></div><div class="right"><b class="num ' + sg(x.real) + '">' + pct(x.real) + '</b><div class="hint">selisih ' + pct(x.real - x.mean) + '</div></div></li>').join('') + '</ul>';
  return h;
}

/* ---------- PLAYGROUND ---------- */
const KIND = { major: 'Pool besar', mid: 'Token menengah', meme: 'Memecoin', trap: 'Pool jebakan' };
function renderPlay() {
  const c = S.learner.counts;
  let h = '<p class="note">Tempat berlatih tanpa uang. Aplikasi mencoba ribuan posisi di dunia simulasi, lalu di pasar nyata lewat data harga 7 hari terakhir, dan memperbaiki penilaiannya. Hasil playground berbobot kecil. Trade nyatamu berbobot paling besar.</p>';
  h += '<p class="hint" id="auto-status">' + autoText() + '</p>';
  h += '<div class="panel"><h3>Latih otomatis</h3><p class="note">Setiap putaran: pool acak dengan sifat tersembunyi (termasuk rug), aplikasi memilih strategi, lalu 7 hari disimulasikan.</p>' +
    '<div class="chips sm" role="group" aria-label="Jumlah putaran"><button class="btn small" data-act="train" data-n="100">100 putaran</button><button class="btn small" data-act="train" data-n="300">300 putaran</button><button class="btn small" data-act="train" data-n="1000">1.000 putaran</button></div>' +
    '<div class="prog" id="train-prog" hidden><i id="train-bar"></i></div><button class="btn small ghost" data-act="train-stop" id="train-stop" hidden>Hentikan</button><div id="train-out"></div></div>';
  h += practiceHTML();
  h += '<div class="panel"><h3>Satu putaran, dijelaskan</h3><p class="note">Lihat satu contoh dari awal sampai akhir, lalu kebenaran tersembunyinya dibuka.</p><button class="btn" data-act="one">Mainkan 1 putaran</button><div id="one-out"></div></div>';
  h += '<div class="panel"><h3>Uji mundur data nyata</h3><p class="note">Mengambil pool nyata dan harga per jam 7 hari terakhir, lalu menghitung apa yang akan terjadi kalau semua strategi dipakai saat itu. Perlu koneksi ke Meteora.</p><button class="btn" data-act="bt-all">Uji mundur sampai 15 pool</button><div class="prog" id="bt-prog" hidden><i id="bt-bar"></i></div><div id="bt-all-out"></div>' +
    '<p class="hint">Catatan: pool yang sudah rug biasanya hilang dari daftar, jadi hasil ini sedikit terlalu optimis.</p></div>';
  h += '<p class="hint">Sampel dipelajari: playground ' + c.sim + ' · data nyata ' + c.bt + ' · latihan ' + (c.prac || 0) + ' · trade kamu ' + c.real + '.</p>';
  $('play-body').innerHTML = h;
}
async function doTrain(n) {
  if (busy) { toast('Masih ada proses berjalan.'); return; }
  busy = true; stopFlag = false;
  $('train-prog').hidden = false; $('train-stop').hidden = false; $('train-out').innerHTML = '';
  const chunk = 20; let done = 0, pol = 0, all = 0, skip = 0, rug = 0, trap = 0, trapSkip = 0;
  while (done < n && !stopFlag) {
    const m = Math.min(chunk, n - done);
    const r = E.trainSim(S.learner, m, { appetite: S.settings.appetite });
    pol += r.avgPolicy * m; all += r.avgAll * m; skip += r.skipN; rug += r.rugN; trap += r.trapN; trapSkip += r.trapSkip;
    done += m; $('train-bar').style.width = (done / n * 100) + '%';
    await tick();
  }
  busy = false; save();
  $('train-prog').hidden = true; $('train-stop').hidden = true;
  if (done > 0) {
    $('train-out').innerHTML = '<dl class="kv"><div><dt>Putaran selesai</dt><dd>' + done + '</dd></div><div><dt>Rata-rata strategi pilihan app</dt><dd class="' + sg(pol / done) + '">' + pct(pol / done) + '</dd></div><div><dt>Rata-rata strategi acak</dt><dd class="' + sg(all / done) + '">' + pct(all / done) + '</dd></div><div><dt>Pool ditolak app</dt><dd>' + skip + ' dari ' + done + '</dd></div><div><dt>Rug terjadi</dt><dd>' + rug + '</dd></div><div><dt>Jebakan dihindari</dt><dd>' + (trap ? trapSkip + ' dari ' + trap : '-') + '</dd></div></dl>' +
      '<p class="hint">Dunia simulasi dibuat oleh pembuat aplikasi, jadi ini melatih kebiasaan menolak pool berbahaya, belum membuktikan untung di pasar nyata.</p>';
  }
  renderHome(); toast(stopFlag ? 'Pelatihan dihentikan.' : 'Pelatihan selesai.');
}
function doOne() {
  const r = E.rng((Date.now() ^ (Math.random() * 4294967296)) >>> 0);
  const e = E.episode(S.learner, r, { cap: 1, appetite: S.settings.appetite, N: 300 });
  save();
  const ev = e.ev, s = e.world.obs, arm = ev.best;
  let h = '<div class="row"><b>' + KIND[e.world.kind] + '</b>' + chip(ev.label) + '</div>' +
    '<p class="hint">TVL ' + E.fmtUSD(s.tvl) + ' · volume ' + E.fmtUSD(s.vol) + '/hari · fee ' + nf(s.fee, 2) + '% · umur ' + nf(s.age, s.age < 10 ? 1 : 0) + ' hari · 10 holder ' + nf(s.top10, 0) + '% · mint ' + (s.mint ? 'dicabut' : 'aktif') + ' · freeze ' + (s.freeze ? 'dicabut' : 'aktif') + '</p>';
  h += '<p>' + (ev.skip ? 'Keputusan app: <b>tahan SOL</b>.' : 'Keputusan app: <b>' + E.STRATS[arm.strat].name + (arm.strat === 'bidask' ? ' -' : ' ±') + arm.plan.half + '%</b>, perkiraan rata-rata ' + pct(arm.mean) + '.') + '</p>';
  h += pathSVG(e.tp.path, arm.plan.pl, arm.plan.ph);
  h += '<p>Hasil 7 hari: <b class="num ' + sg(e.policy) + '">' + pct(e.policy) + '</b>' + (ev.skip ? ' (tidak ikut, dibanding jika ikut ' + pct(e.nets[0]) + ')' : '') + '</p>';
  h += '<p class="hint">Kebenaran tersembunyi: gerak harga sebenarnya ' + nf(e.world.truth.sigma, 1) + '% per hari, peluang rug ' + nf(e.world.truth.h * 100, 0) + '%, ' + (e.rugged ? '<b>rug benar terjadi</b>' : 'tidak ada rug') + '. Putaran ini sudah dipelajari.</p>';
  $('one-out').innerHTML = h; renderHome();
}
async function doBtAll() {
  if (busy) { toast('Masih ada proses berjalan.'); return; }
  busy = true; $('bt-prog').hidden = false; const out = $('bt-all-out'); out.innerHTML = '<p class="note">Mengambil daftar pool…</p>';
  try {
    let pools = scanRes ? scanRes.items.map(r => r.P) : await A.fetchPools({ minTvl: S.settings.minTvl }, S.settings.mode);
    pools = pools.filter(P => !P.s.established || P.s.tvl > 0).slice().sort((a, b) => b.vol24 - a.vol24).slice(0, 15);
    let done = 0, pol = 0, all = 0, used = 0, severe = 0, fail = 0;
    const sr = await getSolRef(pools);
    await pmap(pools, 3, async P => {
      try {
        const c = await A.fetchCandles(P.addr, 244, S.settings.mode);
        const r = E.backtestPool(P, c, S.learner, { cap: 1, appetite: S.settings.appetite, solCandles: sr && sr.candles });
        if (r) { used++; pol += r.policy; all += r.meanAll; if (r.severe) severe++; } else fail++;
      } catch (e) { fail++; }
      done++; $('bt-bar').style.width = (done / pools.length * 100) + '%';
    });
    busy = false; save(); $('bt-prog').hidden = true;
    if (!used) { out.innerHTML = '<p class="alert">Tidak ada pool dengan data harga cukup. Cek koneksi di Pengaturan.</p>'; return; }
    out.innerHTML = '<dl class="kv"><div><dt>Pool diuji</dt><dd>' + used + (fail ? ' <small>(' + fail + ' gagal)</small>' : '') + '</dd></div><div><dt>Rata-rata strategi pilihan app</dt><dd class="' + sg(pol / used) + '">' + pct(pol / used) + '</dd></div><div><dt>Rata-rata semua strategi</dt><dd class="' + sg(all / used) + '">' + pct(all / used) + '</dd></div><div><dt>Anjlok lebih dari 50%</dt><dd>' + severe + '</dd></div></dl><p class="hint">Sudah dipelajari. Angka ini hanya 7 hari terakhir, jangan dianggap pasti berulang.</p>';
    renderHome(); toast('Uji mundur selesai.');
  } catch (e) { busy = false; $('bt-prog').hidden = true; out.innerHTML = '<p class="alert">Gagal: ' + esc(e.message) + '</p>'; setNet(false, e.message); }
}

/* ---------- BELAJAR ---------- */
const SIGL = { L: 'harga tenang', M: 'harga sedang', H: 'harga liar' };
function renderLearn() {
  const L = S.learner, c = L.counts, wt = c.sim * E.WSRC.sim + c.bt * E.WSRC.bt + (c.prac || 0) * E.WSRC.prac + c.real * E.WSRC.real;
  const conf = wt < 8 ? 'masih sangat sedikit' : wt < 30 ? 'masih sedikit' : wt < 100 ? 'mulai berarti' : 'cukup banyak';
  let h = '<div class="panel"><h3>Seberapa banyak yang dipelajari</h3><div class="stats3"><div><span class="k">Playground</span><b class="num">' + c.sim + '</b></div><div><span class="k">Data nyata</span><b class="num">' + c.bt + '</b></div><div><span class="k">Latihan</span><b class="num">' + (c.prac || 0) + '</b></div><div><span class="k">Trade kamu</span><b class="num">' + c.real + '</b></div></div>' +
    '<p class="note">Bobot belajar total ' + nf(wt, 1) + ': ' + conf + '. Satu trade nyata berbobot ' + nf(E.WSRC.real / E.WSRC.sim, 0) + ' kali satu putaran playground.</p><button class="btn small" data-act="how">Cara kerja aplikasi ini</button></div>';
  const err = L.hist.filter(x => !(x.pred === 0 && x.real === 0)).map(x => Math.abs(x.real - x.pred));
  const roll = []; for (let i = 0; i < err.length; i++) { const a = err.slice(Math.max(0, i - 29), i + 1); roll.push(E.avg(a)); }
  h += '<h4>Selisih perkiraan dan hasil</h4>' + lineSVG(roll.slice(-200), 'Rata-rata selisih perkiraan dan hasil') + '<p class="hint">Rata-rata 30 sampel terakhir. Makin rendah makin akurat. Naik-turun wajar di awal.</p>';
  const ws = E.riskWeights(L);
  h += '<h4>Apa yang dianggap berbahaya</h4><ul class="rows">' + ws.map(x => '<li class="fr2"><span>' + esc(x.name) + '</span><span class="num ' + (x.w > 0.1 ? 'neg' : x.w < -0.1 ? 'pos' : '') + '">' + (x.w > 0 ? '+' : '') + nf(x.w, 2) + '</span></li>').join('') + '</ul>' +
    '<p class="hint">Positif berarti pengalaman menaikkan perkiraan risiko untuk faktor itu, negatif menurunkan. Mulai dari nol, yaitu aturan bawaan.</p>';
  const rows = Object.entries(L.arms).filter(([, v]) => v.n >= 1).sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  h += '<h4>Strategi menurut pengalaman</h4>';
  if (!rows.length) h += '<p class="note">Belum ada. Jalankan Latih otomatis di tab Playground.</p>';
  else h += '<div class="tblwrap"><table><thead><tr><th>Situasi</th><th>Strategi</th><th>Sampel</th><th>Koreksi</th></tr></thead><tbody>' + rows.map(([k, v]) => {
    const p = k.split('|'), arm = p[2].split(':'), adj = v.sum / (v.n + 5);
    return '<tr><td>' + esc(E.LABEL[p[0]] + ', ' + SIGL[p[1]]) + '</td><td>' + esc(E.STRATS[arm[0]].name) + ' ×' + nf(parseFloat(arm[1]), 1) + '</td><td>' + nf(v.n, 1) + '</td><td class="' + sg(adj) + '">' + pct(adj) + '</td></tr>';
  }).join('') + '</tbody></table></div><p class="hint">Koreksi positif berarti strategi itu ternyata lebih baik dari hitungan awal, negatif berarti lebih buruk. Ditambahkan ke perkiraan saat memberi saran.</p>';
  $('learn-body').innerHTML = h;
}

/* ---------- PENGATURAN ---------- */
function renderSet() {
  const s = S.settings;
  $('set-body').innerHTML =
    '<div class="panel"><h3>Wallet dan data</h3><label class="f"><span class="lab">Alamat wallet (hanya baca)</span><input id="s-wallet" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(s.wallet) + '"></label>' +
    '<label class="f"><span class="lab">Alamat RPC Solana</span><input id="s-rpc" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(s.rpc) + '"><span class="hint">RPC publik sering dibatasi. Kalau gagal, pakai RPC gratis dari Helius atau sejenisnya.</span></label>' +
    '<div class="f"><span class="lab">Cara memanggil Meteora</span><div class="seg" role="group">' + [['auto', 'Otomatis'], ['direct', 'Langsung'], ['proxy', 'Lewat server']].map(m => '<button type="button" data-act="mode" data-k="' + m[0] + '" aria-pressed="' + (s.mode === m[0]) + '">' + m[1] + '</button>').join('') + '</div><span class="hint">Otomatis mencoba langsung, lalu proxy.php di servermu kalau diblokir.</span></div></div>' +
    '<div class="panel"><h3>Modal dan gaya</h3><div class="grid"><label class="f"><span class="lab">Modal tanpa wallet (SOL)</span><input id="s-cap" type="text" inputmode="decimal" autocomplete="off" value="' + s.cap + '"></label><label class="f"><span class="lab">TVL minimum (USD)</span><input id="s-tvl" type="text" inputmode="decimal" autocomplete="off" value="' + s.minTvl + '"></label></div>' +
    '<div class="f"><span class="lab">Gaya</span><div class="seg" role="group">' + Object.keys(E.APP).map(k => '<button type="button" data-act="app" data-k="' + k + '" aria-pressed="' + (s.appetite === k) + '">' + E.APP[k].name + '</button>').join('') + '</div></div>' +
    '<div class="f"><span class="lab">Latih otomatis tiap aplikasi dibuka</span><div class="seg" role="group"><button type="button" data-act="auto" data-k="1" aria-pressed="' + (s.autoTrain !== false) + '">Ya</button><button type="button" data-act="auto" data-k="0" aria-pressed="' + (s.autoTrain === false) + '">Tidak</button></div><span class="hint">Maksimal sekali per 6 jam. Berjalan hanya saat aplikasi terbuka, bukan di latar belakang.</span></div>' +
    '<button class="btn primary" data-act="set-save">Simpan</button></div>' +
    '<div class="panel"><h3>Tes koneksi</h3><button class="btn" data-act="net-test">Tes Meteora dan RPC</button><div id="net-out"></div></div>' +
    '<div class="panel"><h3>Data di perangkat ini</h3><p class="note">Semua pembelajaran tersimpan di HP ini. Simpan cadangan sebelum menghapus data browser.</p>' +
    '<div class="actions"><button class="btn" data-act="export">Unduh cadangan</button><label class="btn filebtn">Pulihkan cadangan<input id="imp" type="file" accept="application/json" hidden></label>' +
    '<button class="btn danger" data-act="reset-learn" id="reset-learn">Reset hasil belajar</button><button class="btn danger" data-act="reset-all" id="reset-all">Hapus semua data</button></div></div>' +
    '<p class="hint">Pemandu LP ' + 'v1 · model sederhana, bukan saran keuangan. Hasil nyata bisa jauh berbeda, termasuk kehilangan seluruh modal.</p>';
}
async function netTest() {
  const o = $('net-out'); o.innerHTML = '<p class="note">Menguji…</p>';
  const rows = [];
  try { const j = await A.meteora('/pools?page=1&page_size=1', S.settings.mode); rows.push(['Meteora (daftar pool)', j && j.data && j.data.length ? 'ok' : 'warn', j && j.data ? 'terbaca' : 'respons kosong']); setNet(true, ''); }
  catch (e) { rows.push(['Meteora (daftar pool)', 'bad', e.message]); setNet(false, e.message); }
  try { await A.rpc(S.settings.rpc, 'getHealth', []); rows.push(['Solana RPC', 'ok', 'terhubung']); }
  catch (e) { rows.push(['Solana RPC', 'bad', e.message]); }
  o.innerHTML = '<ul class="rows">' + rows.map(r => '<li class="fr"><span class="fn">' + esc(r[0]) + '</span><span></span><span class="pill ' + (r[1] === 'ok' ? 'ok' : r[1]) + '">' + (r[1] === 'ok' ? 'Baik' : r[1] === 'warn' ? 'Cek' : 'Gagal') + '</span><span class="fnote">' + esc(r[2]) + '</span></li>').join('') + '</ul>';
}


/* ---------- penjelasan cara kerja ---------- */
function howHTML() {
  return '' +
  '<p class="note">Halaman ini menjelaskan apa yang dihitung aplikasi, dari mana angkanya datang, dan apa yang tidak diketahuinya. Tujuannya supaya kamu bisa menilai sendiri kapan angkanya layak dipercaya.</p>' +
  '<h4>1. Alur satu pemindaian</h4><ul class="ex">' +
  '<li><b>Ambil pool.</b> Daftar pool Meteora dengan TVL dan volume yang cukup.</li>' +
  '<li><b>Baca harga.</b> Harga per jam 3 hari terakhir tiap pool, untuk mengukur seberapa liar harganya (gerak harian). Dari situ juga dicek apakah volume 24 jam terakhir hanya lonjakan dibanding rata-rata 3 hari. Kalau ya, perkiraan fee dikurangi.</li>' +
  '<li><b>Cek keamanan.</b> Untuk token yang belum mapan: mint authority, freeze authority, dan seberapa terpusat 10 holder terbesar (lewat RPC).</li>' +
  '<li><b>Nilai risiko.</b> Skor aturan (TVL, umur pool, holder, mint/freeze, gerak harga, volume) diubah menjadi peluang kerugian parah dalam 7 hari. Angka itu lalu dikoreksi dari pengalaman aplikasi.</li>' +
  '<li><b>Simulasi 9 strategi.</b> Curve, Spot, dan Bid-Ask, masing-masing dengan 3 lebar rentang. Tiap strategi dijalankan di ratusan jalur harga acak 7 hari.</li>' +
  '<li><b>Pilih atau tolak.</b> Strategi dengan skor terbaik (rata-rata hasil dikurangi hukuman untuk skenario buruk) menjadi saran. Kalau risikonya terlalu tinggi atau tidak ada yang rata-ratanya positif, aplikasinya bilang tahan SOL.</li></ul>' +
  '<h4>2. Cara aplikasi menghitung hasil satu posisi</h4><ul class="ex">' +
  '<li><b>Nilai posisi.</b> Dihitung bin demi bin seperti di Meteora. Kalau harga naik melewati sebuah bin, isinya berubah jadi aset pasangan. Kalau turun, jadi token. Inilah sumber rugi karena harga bergerak (impermanent loss).</li>' +
  '<li><b>Fee.</b> Dasarnya fee harian dibagi TVL pool. Fee itu dikali seberapa tebal likuiditasmu di harga saat itu dan seberapa sempit rentangmu. Kalau harga keluar dari rentang, fee nol.</li>' +
  '<li><b>Bentuk strategi.</b> Spot membagi modal rata. Curve menumpuk modal di tengah, jadi fee besar kalau harga tenang tapi hilang cepat kalau harga lari. Bid-Ask di aplikasi ini satu sisi di bawah harga: kamu membeli token pelan-pelan saat harga turun.</li>' +
  '<li><b>Semua hasil dalam SOL.</b> Modalmu SOL, jadi untung-rugi dinyatakan dalam SOL. Di pool berpasangan SOL, itu langsung. Di pool berpasangan USDC/USDT, hasil dolarnya dibagi perubahan harga SOL, jadi kalau SOL naik 10% saat kamu memegang USDC, itu dihitung sebagai rugi.</li></ul>' +
  '<h4>3. Cara membaca angka di kartu</h4><ul class="ex">' +
  '<li><b>Rendah / Sedang / Tinggi / Hindari.</b> Dari peluang kerugian parah (lebih dari separuh modal) dalam 7 hari. Rendah di bawah 1%, Sedang sampai 4%, Tinggi sampai 12%, Hindari di atasnya atau kalau ada tanda bahaya keras.</li>' +
  '<li><b>Rata-rata 7 hari.</b> Rata-rata hasil di semua jalur simulasi, sudah dikoreksi pengalaman. Ini bukan janji. Satu posisi nyata bisa jauh di atas atau di bawah.</li>' +
  '<li><b>Skenario buruk.</b> Hasil pada jalur terburuk ke-10 persen. Satu dari sepuluh kali, hasilnya sama buruk atau lebih buruk dari angka ini.</li>' +
  '<li><b>Peluang untung.</b> Bagian jalur simulasi yang berakhir di atas nol setelah fee.</li>' +
  '<li><b>Pasang / Sisakan.</b> Besar posisi mengikuti risiko: pool Rendah boleh hampir seluruh modal, Sedang sekitar separuh, Tinggi sedikit sekali. Selalu ada sisa untuk biaya transaksi.</li></ul>' +
  '<h4>4. Dari mana aplikasi belajar</h4><ul class="ex">' +
  '<li><b>Playground otomatis (bobot 0,15).</b> Dunia buatan dengan pool acak dan sifat tersembunyi, termasuk rug. Melatih kebiasaan menolak yang berbahaya. Dunianya dibuat pembuat aplikasi, jadi bukan bukti untung di pasar nyata.</li>' +
  '<li><b>Uji mundur data nyata (0,25).</b> Memainkan semua strategi pada harga nyata 7 hari terakhir. Memakai TVL dan volume sekarang, dan pool yang sudah rug biasanya sudah hilang dari daftar, jadi sedikit terlalu optimis.</li>' +
  '<li><b>Latihan LP Army (0,3).</b> Kamu mencatat pool, strategi, dan lebar. Setelah 5 sampai 7 hari kamu masukkan hasilnya, lalu aplikasi membandingkannya dengan perkiraannya.</li>' +
  '<li><b>Trade nyatamu (1,0).</b> Paling berat, karena inilah satu-satunya yang menyertakan biaya, selip harga, dan perilaku pool yang sebenarnya.</li></ul>' +
  '<p class="note">Yang dipelajari ada dua: koreksi untuk tiap strategi di tiap situasi (hasil sebenarnya lebih baik atau lebih buruk dari hitungan), dan bobot faktor risiko (mis. apakah TVL kecil ternyata lebih berbahaya dari dugaan awal). Semuanya terlihat di tab Belajar. Kalau cara hitung aplikasi diubah, hasil belajar lama direset karena angkanya tidak sebanding.</p>' +
  '<h4>5. Hal yang tidak diketahui aplikasi</h4><ul class="ex">' +
  '<li>Fee masa depan. Dipakai volume 24 jam dan 3 hari terakhir, dan volume bisa turun tajam.</li>' +
  '<li>Rug dalam hitungan jam, bocoran informasi, atau dompet pengembang yang mulai menjual. Aplikasi hanya melihat tanda-tandanya (mint, freeze, holder, umur).</li>' +
  '<li>Token yang punya penerbit atau pengelola, misalnya saham tokenisasi (NVDAx dan sejenisnya). Harganya mengikuti jam bursa dan penerbit bisa membekukan. Aplikasi memperlakukannya seperti token mapan biasa, jadi risikonya bisa lebih besar dari yang ditunjukkan.</li>' +
  '<li>Likuiditas LP lain di tiap bin. Fee dihitung secara rata-rata, bukan bin demi bin.</li>' +
  '<li>Biaya transaksi, selip saat swap, dan sewa akun posisi di Meteora.</li></ul>' +
  '<h4>6. Cara memakainya supaya kerugian kecil</h4><ul class="ex">' +
  '<li>Latihan dulu: Latih otomatis, Uji mundur, lalu beberapa posisi latihan di LP Army dengan pool dan lebar yang berbeda. Lihat apakah selisih perkiraan dan hasil mengecil.</li>' +
  '<li>Kalau pindah ke uang sungguhan, mulai dari 0,05 sampai 0,1 SOL di satu pool berlabel Rendah, dan jangan menambah sebelum 3 posisi berturut-turut selesai.</li>' +
  '<li>Jangan pasang uang yang tidak sanggup hilang. Skenario buruk di kartu itu bisa terjadi.</li>' +
  '<li>Patuhi aturan keluar di kartu. Tutup posisi saat batas rugi tercapai, jangan menunggu pulih.</li>' +
  '<li>Kalau aplikasi bilang tahan SOL, itu keputusan yang sah. Tidak masuk juga hasil.</li>' +
  '<li>Cek manual token yang belum terverifikasi di RugCheck sebelum menaruh uang, dan jangan pernah memasukkan seed phrase atau private key ke aplikasi apa pun.</li></ul>' +
  '<p class="hint">Aplikasi ini model sederhana, bukan saran keuangan. Hasil nyata bisa jauh berbeda, termasuk kehilangan seluruh modal.</p>';
}

/* ---------- aksi ---------- */
const ACT = {
  nav: b => go(b.dataset.v),
  'wallet-save': () => {
    const v = ($('wallet-in').value || '').trim();
    if (!A.validAddr(v)) { toast('Alamat tidak valid. Tempel alamat publik wallet Solana.'); return; }
    S.settings.wallet = v; S.wallet = defState().wallet; save(); renderHome(); renderPools(); syncWallet();
  },
  'wallet-sync': () => syncWallet(),
  scan: () => doScan(),
  pick: b => openPool(b.dataset.addr),
  track: b => trackPool(b.dataset.addr),
  'bt-pool': b => backtestOne(b.dataset.addr),
  'sheet-close': () => closeSheet(),
  app: b => { S.settings.appetite = b.dataset.k; save(); renderPools(); renderSet(); },
  mode: b => { S.settings.mode = b.dataset.k; save(); renderSet(); },
  train: b => doTrain(parseInt(b.dataset.n, 10)),
  'train-stop': () => { stopFlag = true; },
  one: () => doOne(),
  'bt-all': () => doBtAll(),
  'tracked-close': b => {
    const t = S.tracked.find(x => x.id === b.dataset.id); if (!t) return;
    const v = numIn('tc-' + t.id);
    if (!isFinite(v)) { toast('Isi hasil akhir dalam persen, mis. -12 atau 8,5.'); return; }
    closeTracked(t, v / 100, 'manual'); renderHome();
  },
  'prac-start': async b => {
    if (busy) { toast('Masih ada proses berjalan.'); return; }
    const addr = (($('pr-addr').value || '').trim()) || $('pr-pool').value;
    if (!A.validAddr(addr)) { toast('Pilih pool dari daftar, atau tempel alamat pool yang valid.'); return; }
    const half = numIn('pr-half');
    if (!(half >= 2 && half <= 90)) { toast('Isi lebar rentang antara 2 dan 90 (%).'); return; }
    const strat = $('pr-strat').value, ago = numIn('pr-ago');
    busy = true; b.disabled = true; b.textContent = 'Menghitung…';
    try {
      let P = scanRes && (scanRes.items.find(r => r.P.addr === addr) || {}).P;
      if (!P) { P = await A.fetchPool(addr, S.settings.mode); if (!P) throw new Error('Pool tidak ditemukan.'); await enrich(P); }
      const r = E.evalCustom(P.s, S.learner, strat, half, { cap: 1, appetite: S.settings.appetite });
      S.practice.push({
        id: 'p' + Date.now().toString(36), addr: P.addr, name: P.name, strat, half: r.plan.half, status: 'open',
        t0: Date.now() - (isFinite(ago) && ago > 0 ? Math.min(ago, 720) : 0) * 36e5,
        snap: r.snap, mean: r.mean, p10: r.p10, win: r.sim.pWin, label: r.ev.label
      });
      save(); busy = false; renderPlay();
      toast('Dicatat. Perkiraan aplikasi untuk ' + P.name + ': ' + pct(r.mean) + ' dalam 7 hari.');
    } catch (e) { busy = false; renderPlay(); toast('Gagal: ' + e.message); }
  },
  'prac-close': b => {
    const x = S.practice.find(q => q.id === b.dataset.id); if (!x) return;
    const v = numIn('pc-' + x.id);
    if (!isFinite(v) || v < -100 || v > 1000) { toast('Isi hasil akhir dalam persen antara -100 dan 1000.'); return; }
    const d = (Date.now() - x.t0) / 864e5;
    if (d < 5) { toast('Baru ' + nf(d, 1) + ' hari. Tunggu minimal 5 hari supaya sebanding dengan perkiraan 7 hari, atau hapus catatannya.'); return; }
    E.learnPracticeSnap(S.learner, x.snap, v / 100);
    x.status = 'done'; x.real = v / 100; x.closedAt = Date.now();
    save(); renderPlay(); renderHome();
    toast('Dipelajari. Perkiraan ' + pct(x.mean) + ', hasil latihanmu ' + pct(v / 100) + '.');
  },
  'prac-del': b => { S.practice = S.practice.filter(q => q.id !== b.dataset.id); save(); renderPlay(); },
  how: () => openSheet('Cara kerja aplikasi', howHTML()),
  'notice-ok': () => { delete S.notice; save(); renderHome(); },
  auto: b => { S.settings.autoTrain = b.dataset.k === '1'; save(); renderSet(); if (S.settings.autoTrain) autoLearn(); },
  'tracked-del': b => { S.tracked = S.tracked.filter(x => x.id !== b.dataset.id); save(); renderHome(); },
  'set-save': () => {
    const w = ($('s-wallet').value || '').trim(), rpc = ($('s-rpc').value || '').trim();
    if (w && !A.validAddr(w)) { toast('Alamat wallet tidak valid.'); return; }
    if (!/^https:\/\//.test(rpc)) { toast('Alamat RPC harus diawali https://'); return; }
    const cap = numIn('s-cap'), tvl = numIn('s-tvl');
    if (w !== S.settings.wallet) S.wallet = defState().wallet;
    S.settings.wallet = w; S.settings.rpc = rpc;
    if (cap > 0) S.settings.cap = cap; if (tvl >= 1000) S.settings.minTvl = tvl;
    save(); renderAll(); toast('Tersimpan.'); if (w) syncWallet(true);
  },
  'net-test': () => netTest(),
  export: () => {
    const blob = new Blob([JSON.stringify({ app: 'lp-pilot', v: 1, state: S }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pemandu-lp-cadangan.json'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  },
  'reset-learn': b => {
    if (b.dataset.arm !== '1') { b.dataset.arm = '1'; b.textContent = 'Yakin? Tekan sekali lagi'; setTimeout(() => { b.dataset.arm = ''; b.textContent = 'Reset hasil belajar'; }, 4000); return; }
    S.learner = E.newLearner(); save(); renderAll(); toast('Hasil belajar direset.');
  },
  'reset-all': b => {
    if (b.dataset.arm !== '1') { b.dataset.arm = '1'; b.textContent = 'Yakin? Tekan sekali lagi'; setTimeout(() => { b.dataset.arm = ''; b.textContent = 'Hapus semua data'; }, 4000); return; }
    S = defState(); scanRes = null; try { localStorage.removeItem(KEY); } catch (e) { } renderAll(); toast('Semua data dihapus.');
  }
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act],#nav button');
  if (!b) return;
  if (b.closest('#nav')) { ACT.nav(b); return; }
  const f = ACT[b.dataset.act]; if (f) f(b);
});
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'imp' && e.target.files && e.target.files[0]) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const j = JSON.parse(rd.result);
        if (!j || j.app !== 'lp-pilot' || !j.state) throw new Error('Bukan berkas cadangan Pemandu LP.');
        localStorage.setItem(KEY, JSON.stringify(j.state)); S = load(); renderAll(); toast('Cadangan dipulihkan.');
      } catch (err) { toast('Gagal memulihkan: ' + err.message); }
    };
    rd.readAsText(e.target.files[0]);
  }
});

/* ---------- pelatihan otomatis (hanya saat aplikasi terbuka) ---------- */
let autoBusy = false;
function autoText() {
  if (autoBusy) return 'Pelatihan otomatis sedang berjalan…';
  if (S.settings.autoTrain === false) return 'Pelatihan otomatis mati. Aktifkan di Pengaturan.';
  return S.autoT ? 'Pelatihan otomatis terakhir ' + ago(S.autoT) + '. Berikutnya saat aplikasi dibuka dan sudah lewat 6 jam.' : 'Pelatihan otomatis akan berjalan saat aplikasi dibuka.';
}
function setAutoStatus() { const el = $('auto-status'); if (el) el.textContent = autoText(); }
async function autoLearn() {
  if (autoBusy) return;
  if (busy) { setTimeout(autoLearn, 6000); return; }
  if (S.settings.autoTrain === false || Date.now() - (S.autoT || 0) < 6 * 36e5) return;
  autoBusy = true; setAutoStatus();
  try {
    for (let d = 0; d < 150; d += 25) { E.trainSim(S.learner, 25, { appetite: S.settings.appetite }); await tick(); }
    S.autoT = Date.now();
    if (Date.now() - (S.autoBt || 0) > 24 * 36e5) {   // uji mundur nyata maksimal sekali sehari agar jendela yang sama tidak dihitung berulang
      try {
        const base = scanRes ? scanRes.items.map(r => r.P) : await A.fetchPools({ minTvl: S.settings.minTvl }, S.settings.mode);
        const pools = base.slice().sort((a, b) => b.vol24 - a.vol24).slice(0, 8);
        let ok = 0;
        const sr = await getSolRef(base);
        await pmap(pools, 3, async P => { const c = await A.fetchCandles(P.addr, 244, S.settings.mode); if (E.backtestPool(P, c, S.learner, { cap: 1, appetite: S.settings.appetite, solCandles: sr && sr.candles })) ok++; });
        if (ok) S.autoBt = Date.now();
      } catch (e) { }
    }
    save();
  } finally { autoBusy = false; setAutoStatus(); renderHome(); if (view === 'learn') renderLearn(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(autoLearn, 800); });

function renderAll() { renderHome(); renderPools(); renderPlay(); renderLearn(); renderSet(); }
// render Belajar saat dibuka agar selalu terbaru
function refreshPracPools() {
  const el = $('pr-pool'); if (!el) return;
  const pl = knownPools(), cur = el.value;
  el.innerHTML = '<option value="">' + (pl.length ? 'Pilih pool' : 'Belum ada hasil pemindaian') + '</option>' + pl.map(x => '<option value="' + esc(x[0]) + '">' + esc(x[1]) + '</option>').join('');
  el.value = cur;
}
const _go = go; go = function (v) { _go(v); if (v === 'learn') renderLearn(); if (v === 'home') renderHome(); if (v === 'pools' && !busy) renderPools(); if (v === 'play') { refreshPracPools(); const pl = $('prac-lists'); if (pl) pl.innerHTML = pracLists(); } };

if ('serviceWorker' in navigator && location.protocol === 'https:') { navigator.serviceWorker.register('sw.js').catch(() => { }); }
renderAll(); go('home'); setTimeout(autoLearn, 1500);
if (A.validAddr(S.settings.wallet) && Date.now() - S.wallet.t > 5 * 60000) syncWallet(true);
})();
