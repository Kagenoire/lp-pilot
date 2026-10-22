/* Pemandu LP: mesin hitung. Tanpa DOM, bisa diuji di Node.
   Isi: matematika posisi (CLMM), penilaian risiko, simulasi, playground, uji mundur data nyata, pembelajaran. */
(function (root) {
'use strict';

/* ---------- util ---------- */
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sigm = z => 1 / (1 + Math.exp(-z));
const logit = p => Math.log(p / (1 - p));
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const nf = (x, d = 0) => Number(x).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUSD = v => v >= 1e9 ? '$' + nf(v / 1e9, 1) + ' M' : v >= 1e6 ? '$' + nf(v / 1e6, 1) + ' jt' : v >= 1e3 ? '$' + nf(v / 1e3, 0) + ' rb' : '$' + nf(v, 0);
const fmtPct = (x, d = 0, sign = false) => (sign && x > 0 ? '+' : '') + nf(x, d) + '%';
const pct = (x, d = 1) => fmtPct(x * 100, d, true);
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { let u = 0; while (u === 0) u = r(); const v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function hash(str) { let h = 2166136261 >>> 0; str = String(str); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/* ---------- konstanta ---------- */
const LABEL = { rendah: 'Rendah', sedang: 'Sedang', tinggi: 'Tinggi', hindari: 'Hindari' };
const ALLOC = { rendah: 1, sedang: 0.55, tinggi: 0.15, hindari: 0 };
const APP = {
  hati: { name: 'Hati-hati', lam: 0.35, allocMul: 0.8 },
  seimbang: { name: 'Seimbang', lam: 0.2, allocMul: 1 },
  berani: { name: 'Berani', lam: 0.1, allocMul: 1.25 }
};
const STRATS = {
  curve: { name: 'Curve', desc: 'Likuiditas menumpuk di sekitar harga sekarang. Fee paling besar saat harga tenang, tapi cepat keluar rentang kalau harga lari.' },
  spot: { name: 'Spot', desc: 'Likuiditas rata di seluruh rentang. Paling mudah dipahami dan paling toleran untuk pemula.' },
  bidask: { name: 'Bid-Ask', desc: 'Hanya sisi aset pasangan (SOL atau USDC), dipasang di bawah harga. Kamu membeli token pelan-pelan saat harga turun. Paling berisiko di token baru.' }
};
const WM = [0.7, 1, 1.4];
const ARMS = [];
Object.keys(STRATS).forEach(st => WM.forEach(w => ARMS.push([st, w])));
const WSRC = { sim: 0.15, bt: 0.25, prac: 0.3, real: 1 };      // bobot belajar per sumber
const EXITS = {
  rendah: ['Cek posisi sekali sehari dan ambil fee tiap 2 sampai 3 hari.', 'Geser atau tutup rentang kalau harga di luar rentang lebih dari 24 jam.', 'Tutup posisi kalau nilainya turun 15% dari modal yang dipasang.'],
  sedang: ['Cek posisi dua kali sehari dan ambil fee tiap hari.', 'Geser atau tutup rentang kalau harga di luar rentang lebih dari 12 jam.', 'Tutup posisi kalau nilainya turun 12%, atau TVL pool turun lebih dari 40%.'],
  tinggi: ['Cek tiap beberapa jam. Jangan ditinggal tidur.', 'Ambil fee setiap hari dan tarik modal awal begitu fee sudah menutupnya.', 'Tutup posisi kalau nilainya turun 20%, atau holder besar mulai menjual.'],
  hindari: ['Jangan setor SOL ke pool ini.', 'Cari pool dengan TVL lebih besar dan mint serta freeze authority sudah dicabut.', 'Kalau tetap mau belajar, pakai jumlah yang siap hangus dan jangan lebih dari 0,05 SOL.']
};
const FEAT_NAMES = ['TVL kecil', 'Token muda', 'Holder terpusat', 'Mint aktif atau belum dicek', 'Freeze aktif', 'Harga liar', 'Volume ramai dibanding TVL', 'Token mapan'];

/* ---------- matematika posisi: bin bertipe jumlah-tetap seperti DLMM ---------- */
const MV = 2;                 // versi model. Kalau berubah, pengalaman lama direset karena angkanya tidak sebanding.
const NB = 40;                // jumlah bin hitung (bukan jumlah bin asli di Meteora)
const SOL_SIGMA = 4.5;        // gerak harian SOL terhadap dolar (persen), dipakai kalau data SOL tidak tersedia
const SOL_RHO = 0.5;          // keterkaitan token alt dengan SOL
/* bobot modal per bin (naik harga). Jumlah = 1. */
function shapeW(strat, nb) {
  const w = new Array(nb);
  let t = 0;
  for (let i = 0; i < nb; i++) {
    if (strat === 'curve') { const u = (i + 0.5) / nb * 2 - 1; w[i] = 0.06 + (1 - Math.abs(u)); }
    else if (strat === 'bidask') { const d = (nb - i - 0.5) / nb; w[i] = 0.25 + d; }   // satu sisi di bawah harga: makin jauh makin tebal
    else w[i] = 1;
    t += w[i];
  }
  return w.map(x => x / t);
}
/* Posisi dimodelkan bin demi bin. Bin di atas harga awal berisi token, di bawah berisi aset pasangan.
   Nilai saat harga P (modal awal = 1): semua bin yang sudah dilewati naik berisi aset pasangan, sisanya berisi token. */
function makeVal(pl, ph, strat) {
  const nb = NB, lpl = Math.log(pl), D = (Math.log(ph) - lpl) / nb;
  const w = shapeW(strat || 'spot', nb);
  const pc = new Array(nb), c = new Array(nb), cum = new Array(nb + 1), tail = new Array(nb + 1);
  let xh = 0, yh = 0;
  for (let i = 0; i < nb; i++) {
    pc[i] = Math.exp(lpl + (i + 0.5) * D);
    c[i] = pc[i] > 1 ? w[i] * pc[i] : w[i];
    if (pc[i] > 1) xh += w[i]; else yh += w[i];            // xh: jumlah token (satuan harga 1), yh: aset pasangan
  }
  cum[0] = 0; for (let i = 0; i < nb; i++) cum[i + 1] = cum[i] + c[i];
  tail[nb] = 0; for (let i = nb - 1; i >= 0; i--) tail[i] = tail[i + 1] + c[i] / pc[i];
  const idxOf = lp => clamp(Math.floor((lp - lpl) / D - 0.5) + 1, 0, nb);
  const val = P => { const k = idxOf(Math.log(P)); return cum[k] + P * tail[k]; };
  const hodl = P => xh * P + yh;
  const binOf = lp => Math.floor((lp - lpl) / D);
  const multLn = lp => { const i = binOf(lp); return i < 0 || i >= nb ? 0 : w[i] * nb; };
  /* rata-rata kepadatan likuiditas di sepanjang pergerakan harga dari log-harga a ke b (0 di luar rentang) */
  const mavg = (a, b) => {
    if (a > b) { const t = a; a = b; b = t; }
    if (b - a < 1e-9) return multLn((a + b) / 2);
    const lo = Math.max(a, lpl), hi = Math.min(b, lpl + nb * D);
    if (hi <= lo) return 0;
    const i0 = clamp(Math.floor((lo - lpl) / D), 0, nb - 1), i1 = clamp(Math.floor((hi - lpl) / D - 1e-12), 0, nb - 1);
    let s = 0;
    for (let i = i0; i <= i1; i++) s += w[i] * nb * (Math.min(hi, lpl + (i + 1) * D) - Math.max(lo, lpl + i * D));
    return s / (b - a);
  };
  return { val, hodl, multLn, mavg, w, nb };
}
// nilai posisi relatif terhadap modal, diukur dalam aset pasangan (quote) atau aset utama (base)
const valueAt = (V, p, base) => base ? V.val(p) / p : V.val(p);
const hodlAt = (V, p, base) => base ? V.hodl(p) / p : V.hodl(p);

/* ---------- penilaian risiko berbasis aturan ---------- */
function assess(s) {
  const established = s.established != null ? s.established : (s.age >= 365 && s.tvl >= 1e6);
  const rows = []; let total = 0; const unknown = [];
  const add = (name, value, pts, note) => { rows.push({ name, value, pts, note, level: pts >= 15 ? 'bad' : pts >= 5 ? 'warn' : 'ok' }); total += pts; };
  let pts, note;
  if (s.tvl < 5e4) { pts = 25; note = 'Sangat tipis. Satu transaksi besar bisa menggeser harga.'; }
  else if (s.tvl < 2e5) { pts = 15; note = 'Tipis. Harga mudah bergerak.'; }
  else if (s.tvl < 1e6) { pts = 8; note = 'Cukup, tapi masih bisa tergeser transaksi besar.'; }
  else { pts = 0; note = 'Dalam. Fee lebih stabil.'; }
  add('TVL pool', fmtUSD(s.tvl), pts, note);
  const turn = s.vol / s.tvl;
  if (turn < 0.3) { pts = 10; note = 'Volume sepi dibanding TVL, fee kecil.'; }
  else if (turn > 30) { pts = 5; note = 'Terlalu ramai dibanding TVL, biasanya hype sesaat.'; }
  else { pts = 0; note = 'Volume cukup untuk menghasilkan fee.'; }
  add('Volume dibanding TVL', nf(turn, 1) + 'x per hari', pts, note);
  if (s.age < 1) { pts = 25; note = 'Baru lahir hari ini. Banyak rug terjadi di fase ini.'; }
  else if (s.age < 3) { pts = 18; note = 'Sangat baru.'; }
  else if (s.age < 14) { pts = 10; note = 'Masih baru.'; }
  else if (s.age < 60) { pts = 4; note = 'Cukup baru.'; }
  else { pts = 0; note = 'Sudah teruji waktu.'; }
  add('Umur pool', nf(s.age, s.age < 10 ? 1 : 0) + ' hari', pts, note);
  if (established) { pts = 0; note = 'Token mapan, tidak dihitung.'; add('10 holder terbesar', s.top10 == null ? '-' : nf(s.top10, 0) + '%', pts, note); }
  else if (s.top10 == null) { pts = 6; note = 'Belum diperiksa. Dianggap agak berisiko.'; unknown.push('top10'); add('10 holder terbesar', 'belum dicek', pts, note); }
  else {
    if (s.top10 > 60) { pts = 20; note = 'Segelintir dompet memegang mayoritas dan bisa dump.'; }
    else if (s.top10 > 40) { pts = 10; note = 'Terlalu terkonsentrasi.'; }
    else if (s.top10 > 25) { pts = 4; note = 'Agak terkonsentrasi.'; }
    else { pts = 0; note = 'Tersebar dengan baik.'; }
    add('10 holder terbesar', nf(s.top10, 0) + '%', pts, note);
  }
  if (s.mint === true) { pts = 0; note = 'Dev tidak bisa mencetak token baru.'; add('Mint authority', 'Dicabut', pts, note); }
  else if (established) { pts = 0; note = 'Wajar untuk token mapan.'; add('Mint authority', s.mint === false ? 'Aktif' : '-', pts, note); }
  else if (s.mint == null) { pts = 12; note = 'Belum diperiksa. Anggap berisiko sampai terbukti dicabut.'; unknown.push('mint'); add('Mint authority', 'belum dicek', pts, note); }
  else { pts = 25; note = 'Dev masih bisa mencetak token baru. Tanda rug yang klasik.'; add('Mint authority', 'Aktif', pts, note); }
  if (s.freeze === true) { pts = 0; note = 'Token di dompetmu tidak bisa dibekukan.'; add('Freeze authority', 'Dicabut', pts, note); }
  else if (established) { pts = 0; note = 'Stablecoin besar memang punya ini. Wajar.'; add('Freeze authority', s.freeze === false ? 'Aktif' : '-', pts, note); }
  else if (s.freeze == null) { pts = 8; note = 'Belum diperiksa.'; unknown.push('freeze'); add('Freeze authority', 'belum dicek', pts, note); }
  else { pts = 15; note = 'Dev bisa membekukan token di dompetmu.'; add('Freeze authority', 'Aktif', pts, note); }
  if (s.sigma > 30) { pts = 20; note = 'Harga bisa berayun sangat besar dalam sehari.'; }
  else if (s.sigma > 15) { pts = 12; note = 'Sangat liar.'; }
  else if (s.sigma > 6) { pts = 6; note = 'Cukup liar.'; }
  else { pts = 0; note = 'Relatif tenang.'; }
  add('Gerak harga harian', nf(s.sigma, 1) + '%', pts, note);
  total = Math.min(100, total);
  const hard = !established && (s.mint === false || s.freeze === false);
  const rugRule = clamp(Math.max(0.003 + 0.000031 * total * total, hard ? 0.35 : 0), 0.003, 0.6);
  return { rows, total, hard, established, rugRule, unknown };
}
function poolStats(s) {
  const y0 = s.y0 != null ? s.y0 : (s.tvl > 0 ? s.vol * s.fee / 100 / s.tvl : 0);
  return { y0: clamp(y0, 0, 5), turn: s.vol / s.tvl };
}
const labelOf = (p, hard) => (hard || p > 0.12) ? 'hindari' : p > 0.04 ? 'tinggi' : p > 0.01 ? 'sedang' : 'rendah';
const bucketOf = (label, sigma) => label + '|' + (sigma <= 5 ? 'L' : sigma <= 15 ? 'M' : 'H');

/* ---------- pembelajaran ---------- */
function newLearner() { return { mv: MV, w: new Array(FEAT_NAMES.length).fill(0), b: 0, arms: {}, counts: { sim: 0, bt: 0, real: 0, prac: 0, meme: 0 }, hist: [] }; }
function fixLearner(L) {
  if (!L || typeof L !== 'object') return newLearner();
  if (L.mv !== MV) return newLearner();          // model berubah, angka lama tidak sebanding
  const n = newLearner();
  L.w = Array.isArray(L.w) ? n.w.map((_, i) => (isFinite(L.w[i]) ? L.w[i] : 0)) : n.w;
  L.b = isFinite(L.b) ? L.b : 0;
  L.arms = L.arms && typeof L.arms === 'object' ? L.arms : {};
  L.counts = Object.assign({ sim: 0, bt: 0, real: 0, prac: 0, meme: 0 }, L.counts || {});
  L.hist = Array.isArray(L.hist) ? L.hist : [];
  return L;
}
function featVec(s, established) {
  const turn = s.vol / s.tvl;
  return [
    clamp((5.5 - Math.log10(Math.max(s.tvl, 1000))) / 1.5, -1.5, 1.5),
    clamp((1.5 - Math.log10(Math.max(s.age, 0) + 1)) / 1.2, -1.5, 1.5),
    clamp(((s.top10 == null ? 35 : s.top10) - 35) / 35, -1, 1.5),
    s.mint === false ? 1 : s.mint == null ? 0.4 : 0,
    s.freeze === false ? 1 : s.freeze == null ? 0.3 : 0,
    clamp((s.sigma - 10) / 20, -0.5, 2),
    clamp(Math.log10(turn + 0.01) / 2, -1, 1),
    established ? -1 : 0
  ];
}
function pSevere(s, a, L) {
  const x = featVec(s, a.established);
  let z = logit(clamp(a.rugRule, 0.001, 0.9)) + L.b;
  for (let i = 0; i < x.length; i++) z += L.w[i] * x[i];
  return { p: clamp(sigm(z), 0.001, 0.95), x };
}
function learnRisk(L, x, y, w, priorLogit) {
  const lr = 0.08, l2 = 0.02;
  let z = L.b + (priorLogit || 0); for (let i = 0; i < x.length; i++) z += L.w[i] * x[i];
  const p = sigm(z);
  const g = p - y;
  for (let i = 0; i < x.length; i++) L.w[i] = clamp(L.w[i] - lr * w * (g * x[i] + l2 * L.w[i]), -1.5, 1.5);
  L.b = clamp(L.b - lr * w * g, -1, 1);
}
const adjOf = (L, bucket, key) => { const a = L.arms[bucket + '|' + key]; return a ? a.sum / (a.n + 5) : 0; };
function learnArm(L, bucket, key, pred, real, w) {
  const k = bucket + '|' + key;
  const a = L.arms[k] || (L.arms[k] = { n: 0, sum: 0 });
  a.n += w; a.sum += w * clamp(real - pred, -0.5, 0.5);
}
function pushHist(L, h) { L.hist.push(h); if (L.hist.length > 600) L.hist.splice(0, L.hist.length - 600); }
function riskWeights(L) { return FEAT_NAMES.map((n, i) => ({ name: n, w: L.w[i] })); }

/* ---------- rencana posisi ---------- */
function planFor(s, label, strat, wm, cap, app, halfOv) {
  const sig = s.sigma;
  const defHalf = strat === 'bidask' ? clamp(Math.round(sig * Math.sqrt(7) * 2), 12, 60) : clamp(Math.round(sig * Math.sqrt(7) * 1.5), 6, 40);
  let half = halfOv != null ? Math.round(halfOv) : Math.round(defHalf * wm), pl, ph;
  if (strat === 'bidask') { half = clamp(half, 3, 90); pl = 1 - half / 100; ph = 1; }
  else { half = clamp(half, 2, 60); pl = 1 - half / 100; ph = 1 + half / 100; }
  const reserve0 = Math.min(0.1, cap * 0.2);
  const mul = (APP[app] || APP.seimbang).allocMul;
  const alloc = Math.floor(Math.max(0, cap - reserve0) * Math.min(1, ALLOC[label] * mul) * 100) / 100;
  const nBins = Math.log(ph / pl) / Math.log(1 + (s.binStep || 10) / 10000);
  return { strat, wm, key: strat + ':' + wm, half, pl, ph, alloc, reserve: cap - alloc, nBins: Math.round(nBins), positions: Math.max(1, Math.ceil(nBins / 70)) };
}
const concK = pn => clamp(30 / ((pn.ph - pn.pl) * 100), 0.6, 3);

/* ---------- simulasi model (dipakai untuk prediksi) ---------- */
function simulate(s, pn, pool, o) {
  o = o || {};
  const N = o.N || 1500, spd = 4, T = 7 * spd;
  const sd = s.sigma / 100 / Math.sqrt(spd);
  const drift = s.age < 3 ? -0.04 : s.age < 14 ? -0.02 : s.age < 60 ? -0.005 : 0;
  const mu = (-0.5 * Math.pow(s.sigma / 100, 2) + drift) / spd;
  const k = concK(pn);
  const dec = s.age < 3 ? 0.75 : s.age < 14 ? 0.85 : s.age < 60 ? 0.95 : 1;
  const V = makeVal(pn.pl, pn.ph, pn.strat);
  const base = s.measure === 'base';
  const usd = !!s.usdq;                                   // nilai dalam dolar, dikonversi ke SOL di akhir
  const sigS = (s.solSigma || SOL_SIGMA) / 100, sdS = sigS / Math.sqrt(spd), muS = -0.5 * sigS * sigS / spd, rho = SOL_RHO, rho2 = Math.sqrt(1 - rho * rho);
  const r = rng(o.seed || 20261022);
  const y0 = Math.min(pool.y0, 0.1);
  const rug = o.rug || 0;
  const net = new Array(N), hist = new Array(16).fill(0);
  let feeSum = 0, win = 0, loss20 = 0, sum = 0;
  for (let n = 0; n < N; n++) {
    let lp = 0, ls = 0, fee = 0;
    for (let t = 0; t < T; t++) {
      const m = r() < 0.05 ? 2.5 : 1;
      const z = gauss(r);
      lp += mu + sd * z * m;
      if (usd) ls += muS + sdS * (rho * z + rho2 * gauss(r));
      const p = Math.exp(lp);
      if (p >= pn.pl && p <= pn.ph) fee += y0 * Math.pow(dec, Math.floor(t / spd)) * k * V.multLn(lp) / spd;
    }
    let x = valueAt(V, Math.exp(lp), base) - 1 + fee;
    if (r() < rug) x = Math.min(x, -0.9);
    if (usd) x = (1 + x) / Math.exp(ls) - 1;
    net[n] = x; feeSum += fee; sum += x;
    if (x > 0) win++; if (x < -0.2) loss20++;
    hist[clamp(Math.floor((x * 100 + 100) / 10), 0, 15)]++;
  }
  const sorted = net.slice().sort((p, q) => p - q);
  const q = f => sorted[Math.floor(f * (N - 1))];
  const k5 = Math.max(1, Math.floor(N * 0.05));
  return { pWin: win / N, pLoss20: loss20 / N, p10: q(0.1), p50: q(0.5), p90: q(0.9), es5: avg(sorted.slice(0, k5)), mean: sum / N, hist, meanFee: feeSum / N, k, V, base };
}

/* ---------- evaluasi semua strategi untuk satu pool ---------- */
function evaluateArms(s, L, cfg) {
  cfg = cfg || {};
  const cap = cfg.cap || 1, app = cfg.appetite || 'seimbang', lam = (APP[app] || APP.seimbang).lam;
  const a = assess(s);
  const rk = pSevere(s, a, L);
  const label = labelOf(rk.p, a.hard);
  const pool = poolStats(s);
  const bucket = bucketOf(label, s.sigma);
  const seed = cfg.seed || (hash(s.addr || 'x') + 7);
  const arms = ARMS.map(([strat, wm]) => {
    const plan = planFor(s, label, strat, wm, cap, app);
    const sim = simulate(s, plan, pool, { N: cfg.N || 400, rug: rk.p, seed });
    const adj = adjOf(L, bucket, plan.key);
    const mean = sim.mean + adj, p10 = sim.p10 + adj;
    return { key: plan.key, strat, wm, plan, sim, adj, mean, p10, score: mean + lam * Math.min(0, p10) };
  }).sort((p, q) => q.score - p.score);
  const best = arms[0];
  const skip = label === 'hindari' || best.mean <= 0.003;
  return { a, rk, label, pool, bucket, arms, best, skip, cap, app, s };
}

/* ---------- playground: dunia buatan dengan "kebenaran tersembunyi" ---------- */
function genWorld(r, kind) {
  const U = (a, b) => a + (b - a) * r();
  const Lg = (a, b) => Math.exp(U(Math.log(a), Math.log(b)));
  const kinds = ['major', 'mid', 'mid', 'meme', 'meme', 'trap'];
  const k = kind || kinds[Math.floor(r() * kinds.length)];
  let w;
  if (k === 'major') w = { sigma: U(2, 5), tvl: Lg(2e6, 2e7), turn: U(0.4, 3), fee: U(0.03, 0.15), age: U(500, 2000), top10: U(5, 22), mint: true, freeze: true, hazard: 0.001, drift: 0, bin: 10, measure: 'base' };
  else if (k === 'mid') w = { sigma: U(5, 11), tvl: Lg(2e5, 2e6), turn: U(0.8, 6), fee: U(0.1, 0.35), age: U(60, 700), top10: U(20, 45), mint: r() < 0.95, freeze: r() < 0.9, hazard: 0.01, drift: U(-0.004, 0.004), bin: 20, measure: 'quote', usdq: r() < 0.5 };
  else if (k === 'meme') w = { sigma: U(14, 45), tvl: Lg(3e4, 4e5), turn: U(3, 40), fee: U(0.5, 3), age: U(0.2, 20), top10: U(30, 70), mint: r() < 0.8, freeze: r() < 0.7, hazard: 0.06, drift: U(-0.06, 0.01), bin: 80, measure: 'quote', usdq: r() < 0.5 };
  else w = { sigma: U(25, 60), tvl: Lg(2e4, 9e4), turn: U(20, 80), fee: U(1, 5), age: U(0.1, 4), top10: U(45, 85), mint: r() < 0.4, freeze: r() < 0.4, hazard: 0.3, drift: U(-0.1, -0.01), bin: 100, measure: 'quote', usdq: r() < 0.5 };
  const h = clamp(w.hazard + (w.mint ? 0 : 0.25) + (w.freeze ? 0 : 0.12) + Math.max(0, w.top10 - 40) / 100 * 0.3, 0, 0.9);
  const obs = {
    addr: 'sim' + Math.floor(r() * 1e9), tvl: w.tvl, vol: w.turn * w.tvl, fee: w.fee, y0: w.turn * w.fee / 100, binStep: w.bin,
    sigma: Math.max(0.5, w.sigma * Math.exp(0.25 * gauss(r))), age: w.age, top10: w.top10, mint: w.mint, freeze: w.freeze,
    established: k === 'major', measure: w.measure, usdq: !!w.usdq, solSigma: SOL_SIGMA
  };
  return { kind: k, obs, truth: { sigma: w.sigma, drift: w.drift, h, turn: w.turn, fee: w.fee } };
}
function truthPath(world, r, hours, hazScale) {
  hours = hours || 168;
  const T = world.truth, age = world.obs.age;
  const sdH = T.sigma / 100 / Math.sqrt(24);
  const dd = age < 3 ? 0.7 : age < 14 ? 0.88 : age < 60 ? 0.96 : 0.99;
  const rugAt = r() < T.h * (hazScale != null ? hazScale : 1) ? Math.floor(r() * hours) : -1;
  const usd = !!world.obs.usdq, sdS = SOL_SIGMA / 100 / Math.sqrt(24), rho2 = Math.sqrt(1 - SOL_RHO * SOL_RHO);
  let lp = 0, vs = 0, ls = 0;
  const path = [1], vm = [], solPath = [1];
  for (let t = 0; t < hours; t++) {
    vs = 0.9 * vs + 0.3 * gauss(r);
    const regime = Math.exp(0.35 * vs), z = gauss(r);
    const jump = r() < 0.004 * (T.sigma / 10) ? -(0.1 + 0.2 * r()) : 0;
    lp += -0.5 * Math.pow(sdH * regime, 2) + T.drift / 24 + sdH * regime * z + jump;
    if (usd) ls += -0.5 * sdS * sdS + sdS * (SOL_RHO * z + rho2 * gauss(r));
    solPath.push(Math.exp(ls));
    if (t === rugAt) lp += Math.log(0.05);
    const dead = rugAt >= 0 && t >= rugAt;
    path.push(Math.exp(lp));
    vm.push(dead ? 0.02 : (0.6 + 0.8 * Math.abs(z)) / 1.24 * regime * Math.pow(dd, t / 24));
  }
  return { path, vm, solPath, rugged: rugAt >= 0, solR: Math.exp(ls) };
}
function playOnPath(world, tp, plan, stop) {
  const T = world.truth, V = makeVal(plan.pl, plan.ph, plan.strat), k = concK(plan);
  const base = world.obs.measure === 'base', usd = !!world.obs.usdq;
  const y0 = T.turn * T.fee / 100;
  const dil = 1 / (1 + 3 * y0);
  let fee = 0;
  for (let t = 0; t < tp.vm.length; t++) {
    const p = tp.path[t + 1];
    if (p >= plan.pl && p <= plan.ph) fee += y0 / 24 * tp.vm[t] * k * dil * V.multLn(Math.log(p));
    if (stop != null) {                                     // stop rugi: keluar begitu nilai menyentuh batas (atau lebih buruk kalau harga melompat)
      const xt = valueAt(V, p, base) - 1 + fee;
      if (xt <= -stop) { const xs = Math.min(xt, -stop) - 0.01; return usd ? (1 + xs) / (tp.solPath ? tp.solPath[t + 1] : 1) - 1 : xs; }
    }
  }
  const x = valueAt(V, tp.path[tp.path.length - 1], base) - 1 + fee;
  return usd ? (1 + x) / (tp.solR || 1) - 1 : x;
}
function episode(L, r, o) {
  o = o || {};
  const world = genWorld(r, o.kind);
  const ev = evaluateArms(world.obs, L, { cap: o.cap || 1, appetite: o.appetite, N: o.N || 150, seed: o.seed || 1 + Math.floor(r() * 1e6) });
  const tp = truthPath(world, r, 168);
  const nets = ev.arms.map(a => playOnPath(world, tp, a.plan));
  const meanAll = avg(nets);
  const policy = ev.skip ? 0 : nets[0];
  const spotIdx = ev.arms.findIndex(a => a.key === 'spot:1');
  const severe = tp.rugged || nets[spotIdx] < -0.5;
  if (o.learn !== false) {
    ev.arms.forEach((a, j) => learnArm(L, ev.bucket, a.key, a.sim.mean, nets[j], WSRC.sim));
    learnRisk(L, ev.rk.x, severe ? 1 : 0, WSRC.sim * 0.5, logit(clamp(ev.a.rugRule, 0.001, 0.9)));
    L.counts.sim++;
    pushHist(L, { t: Date.now(), src: 'sim', pred: ev.skip ? 0 : ev.best.mean, real: policy, edge: policy - meanAll });
  }
  return { world, ev, tp, nets, policy, meanAll, severe, rugged: tp.rugged };
}
function trainSim(L, n, o) {
  o = o || {};
  const r = rng(o.seed || ((Date.now() ^ (Math.random() * 4294967296)) >>> 0));
  let pol = 0, all = 0, skipN = 0, rugN = 0, trapSkip = 0, trapN = 0;
  const res = [];
  for (let i = 0; i < n; i++) {
    const e = episode(L, r, { cap: o.cap, appetite: o.appetite, N: 120, seed: i + 1 });
    pol += e.policy; all += e.meanAll; if (e.ev.skip) skipN++; if (e.rugged) rugN++;
    if (e.world.kind === 'trap') { trapN++; if (e.ev.skip) trapSkip++; }
  }
  return { n, avgPolicy: pol / n, avgAll: all / n, edge: (pol - all) / n, skipN, rugN, trapN, trapSkip };
}

/* ---------- uji mundur dengan data nyata (candle 1 jam) ---------- */
function sigmaFromCandles(c) {
  if (!c || c.length < 12) return null;
  const r = [];
  for (let i = 1; i < c.length; i++) { if (c[i].close > 0 && c[i - 1].close > 0) r.push(Math.log(c[i].close / c[i - 1].close)); }
  if (r.length < 8) return null;
  const m = avg(r), v = avg(r.map(x => (x - m) * (x - m)));
  return Math.max(0.3, Math.sqrt(v) * Math.sqrt(24) * 100);
}
function realizeOnCandles(plan, win, p0, o) {
  const V = makeVal(plan.pl, plan.ph, plan.strat), k = concK(plan);
  const base = o.measure === 'base';
  let fee = 0;
  for (const c of win) {
    const ov = V.mavg(Math.log(c.low / p0), Math.log(c.high / p0));
    fee += c.volume * o.volScale * (o.feeEff / 100) / o.tvl * Math.min(1, 0.1 / Math.max(o.y0, 1e-9)) * k * ov;
  }
  const pEnd = win[win.length - 1].close / p0;
  const x = valueAt(V, pEnd, base) - 1 + fee;
  return o.solR ? (1 + x) / o.solR - 1 : x;
}
function backtestPool(P, candles, L, cfg) {
  cfg = cfg || {};
  const H = 168;
  if (!candles || candles.length < H + 24) return null;
  const i0 = candles.length - H;
  const pre = candles.slice(Math.max(0, i0 - 72), i0);
  const sig = sigmaFromCandles(pre) || P.s.sigma;
  const s = Object.assign({}, P.s, { sigma: sig, age: Math.max(0.1, P.s.age - 7), addr: P.s.addr });
  const win = candles.slice(i0);
  const p0 = candles[i0].open;
  // pool berpasangan dolar: hasil harus dihitung dalam SOL, jadi butuh harga SOL pada jendela yang sama
  let solR = null, noSol = false;
  if (s.usdq) {
    const sc = cfg.solCandles;
    if (sc && sc.length > 24) {
      const near = t => { let b = null, bd = 1e12; for (const c of sc) { const d = Math.abs(c.t - t); if (d < bd) { bd = d; b = c; } } return bd <= 7200 ? b : null; };
      const a = near(win[0].t), z = near(win[win.length - 1].t);
      if (a && z && a.open > 0) solR = z.close / a.open;
      const sp = sigmaFromCandles(sc.filter(c => c.t < win[0].t).slice(-72));
      if (sp) s.solSigma = sp;
    }
    if (!(solR > 0)) { solR = 1; noSol = true; }
  }
  const ev = evaluateArms(s, L, { cap: cfg.cap || 1, appetite: cfg.appetite, N: 300 });
  const last24 = candles.slice(-24).reduce((q, c) => q + c.volume, 0);
  const volScale = last24 > 0 && P.s.vol > 0 ? clamp(P.s.vol / last24, 0.2, 5) : 1;
  const feeEff = P.feeEff || P.s.fee;
  const nets = ev.arms.map(a => realizeOnCandles(a.plan, win, p0, { measure: s.measure, volScale, feeEff, tvl: P.s.tvl, y0: ev.pool.y0, solR }));
  const meanAll = avg(nets);
  const policy = ev.skip ? 0 : nets[0];
  const spotIdx = ev.arms.findIndex(a => a.key === 'spot:1');
  const severe = nets[spotIdx] < -0.5;
  if (cfg.learn !== false) {
    ev.arms.forEach((a, j) => learnArm(L, ev.bucket, a.key, a.sim.mean, nets[j], WSRC.bt));
    learnRisk(L, ev.rk.x, severe ? 1 : 0, WSRC.bt, logit(clamp(ev.a.rugRule, 0.001, 0.9)));
    L.counts.bt++;
    pushHist(L, { t: Date.now(), src: 'bt', pred: ev.skip ? 0 : ev.best.mean, real: policy, edge: policy - meanAll });
  }
  return { ev, nets, policy, meanAll, severe, p0, pEnd: win[win.length - 1].close / p0, solR, noSol };
}


/* ============================================================
   MODE MEMECOIN: horizon 12 jam atau 1 hari, langkah per jam, stop rugi, modal kecil
   ============================================================ */
const MEME_ARMS = [['bidask', 25], ['bidask', 45], ['bidask', 70], ['spot', 20], ['spot', 40], ['curve', 20], ['curve', 40]];
const MEME_FRAC = { rendah: 0.15, sedang: 0.10, tinggi: 0.06, hindari: 0 };   // bagian modal per posisi
const MEME_STOP = 0.25;                                                       // stop rugi
const MEME_MIN_GAIN = 0.02;                                                   // hasil rata-rata minimal supaya layak masuk
const memeHazard = (p7, H) => clamp(p7 * Math.pow(H / 168, 0.6), 0.002, 0.7);
const memeLabel = (pH, hard) => (hard || pH > 0.15) ? 'hindari' : pH > 0.07 ? 'tinggi' : 'sedang';   // memecoin tidak pernah berlabel Rendah
const memeDrift = age => age < 2 ? -0.0015 : age < 14 ? -0.0008 : -0.0003;    // per jam: meme cenderung turun
function memeKey(strat, half) { return strat + ':' + half; }
function memeBucket(H, label, sigma) { return 'm' + H + '|' + bucketOf(label, sigma); }

function simulateH(s, pn, pool, o) {
  o = o || {};
  const H = o.H || 24, N = o.N || 300, stop = o.stop != null ? o.stop : MEME_STOP;
  const sdH = s.sigma / 100 / Math.sqrt(24), drift = memeDrift(s.age);
  const tau = s.tau || (s.age < 2 ? 30 : s.age < 7 ? 60 : 120);
  const k = concK(pn), V = makeVal(pn.pl, pn.ph, pn.strat);
  const base = s.measure === 'base', usd = !!s.usdq;
  const sigS = (s.solSigma || SOL_SIGMA) / 100, sdS = sigS / Math.sqrt(24), muS = -0.5 * sigS * sigS / 24, rho2 = Math.sqrt(1 - SOL_RHO * SOL_RHO);
  const y0d = Math.min(pool.y0, 0.4), y0 = y0d / 24 / (1 + 3 * y0d);      // fee tinggi menarik LP lain, jadi bagianmu mengencer
  const pj = Math.min(0.05, 0.004 * (s.sigma / 10));
  const r = rng(o.seed || 20261022), rugP = o.rug || 0;
  const net = new Array(N), hist = new Array(16).fill(0);
  let sum = 0, win = 0, loss20 = 0, stopped = 0, feeSum = 0;
  for (let n = 0; n < N; n++) {
    const rugAt = r() < rugP ? Math.floor(r() * H) : -1;
    let lp = 0, ls = 0, fee = 0, vs = 0, x = 0, done = false;
    for (let t = 0; t < H; t++) {
      vs = 0.9 * vs + 0.3 * gauss(r);
      const regime = Math.exp(0.35 * vs), z = gauss(r);
      const jump = r() < pj ? -(0.1 + 0.2 * r()) : 0;
      lp += -0.5 * Math.pow(sdH * regime, 2) + drift + sdH * regime * z + jump;
      if (t === rugAt) lp += Math.log(0.05);
      if (usd) ls += muS + sdS * (SOL_RHO * z + rho2 * gauss(r));
      const p = Math.exp(lp), dead = rugAt >= 0 && t >= rugAt;
      if (!dead && p >= pn.pl && p <= pn.ph) fee += y0 * Math.exp(-(t + 0.5) / tau) * (0.6 + 0.8 * Math.abs(z)) / 1.24 * regime * k * V.multLn(lp);
      x = valueAt(V, p, base) - 1 + fee;
      if (usd) x = (1 + x) / Math.exp(ls) - 1;
      if (x <= -stop) { x = Math.min(x, -stop) - 0.01; done = true; stopped++; break; }
    }
    net[n] = x; sum += x; feeSum += fee;
    if (x > 0) win++; if (x < -0.2) loss20++;
    hist[clamp(Math.floor((x * 100 + 100) / 10), 0, 15)]++;
  }
  const sorted = net.slice().sort((p, q) => p - q), q = f => sorted[Math.floor(f * (N - 1))];
  const k5 = Math.max(1, Math.floor(N * 0.05));
  return { pWin: win / N, pLoss20: loss20 / N, pStop: stopped / N, p10: q(0.1), p50: q(0.5), p90: q(0.9), es5: avg(sorted.slice(0, k5)), mean: sum / N, hist, meanFee: feeSum / N, k };
}

function planMeme(s, label, strat, half, cap, app) {
  const pn = planFor(s, label, strat, 1, cap, app, half);
  const mul = (APP[app] || APP.seimbang).allocMul;
  pn.alloc = Math.floor(cap * Math.min(0.2, MEME_FRAC[label] * mul) * 100) / 100;
  pn.reserve = cap - pn.alloc;
  pn.key = memeKey(strat, pn.half);
  return pn;
}
function evaluateMeme(s, L, cfg) {
  cfg = cfg || {};
  const H = cfg.H || 24, cap = cfg.cap || 1, app = cfg.appetite || 'seimbang', lam = (APP[app] || APP.seimbang).lam;
  const a = assess(s), rk = pSevere(s, a, L);
  const pH = memeHazard(rk.p, H), label = memeLabel(pH, a.hard);
  const pool = poolStats(s), bucket = memeBucket(H, label, s.sigma);
  const seed = cfg.seed || (hash(s.addr || 'x') + 11);
  const arms = MEME_ARMS.map(([st, half]) => {
    const plan = planMeme(s, label, st, half, cap, app);
    const sim = simulateH(s, plan, pool, { H, N: cfg.N || 300, rug: pH, seed });
    const adj = adjOf(L, bucket, plan.key);
    const mean = sim.mean + adj, p10 = sim.p10 + adj, es5 = sim.es5 + adj;
    // memecoin: yang dihukum adalah rata-rata 5% skenario terburuk (ekor kiri), bukan hanya persentil ke-10
    return { key: plan.key, strat: st, half, plan, sim, adj, mean, p10, es5, score: mean + lam * Math.min(0, es5) };
  }).sort((p, q) => q.score - p.score);
  const best = arms[0];
  const skip = label === 'hindari' || best.mean <= MEME_MIN_GAIN;
  return { a, rk, pH, label, pool, bucket, arms, best, skip, cap, app, s, H, stop: MEME_STOP };
}
function episodeMeme(L, r, o) {
  o = o || {};
  const H = o.H || 24;
  const u = r();
  const world = genWorld(r, o.kind || (u < 0.5 ? 'meme' : u < 0.8 ? 'trap' : 'mid'));
  const ev = evaluateMeme(world.obs, L, { H, cap: o.cap || 1, appetite: o.appetite, N: o.N || 120, seed: o.seed });
  const tp = truthPath(world, r, H, Math.pow(H / 168, 0.6));
  const nets = ev.arms.map(a => playOnPath(world, tp, a.plan, ev.stop));
  const meanAll = avg(nets), policy = ev.skip ? 0 : nets[0];
  if (o.learn !== false) {
    ev.arms.forEach((a, j) => learnArm(L, ev.bucket, a.key, a.sim.mean, nets[j], WSRC.sim));
    L.counts.meme = (L.counts.meme || 0) + 1;
    pushHist(L, { t: Date.now(), src: 'meme', pred: ev.skip ? 0 : ev.best.mean, real: policy, edge: policy - meanAll });
  }
  return { world, ev, tp, nets, policy, meanAll, rugged: tp.rugged };
}
function trainMeme(L, n, o) {
  o = o || {};
  const r = rng(o.seed || ((Date.now() ^ (Math.random() * 4294967296)) >>> 0));
  let pol = 0, all = 0, skipN = 0, rugN = 0, trapSkip = 0, trapN = 0, stopN = 0;
  for (let i = 0; i < n; i++) {
    const e = episodeMeme(L, r, { H: o.H, cap: o.cap, appetite: o.appetite, N: 100, seed: i + 1 });
    pol += e.policy; all += e.meanAll; if (e.ev.skip) skipN++; if (e.rugged) rugN++;
    if (!e.ev.skip && e.policy <= -MEME_STOP) stopN++;
    if (e.world.kind === 'trap') { trapN++; if (e.ev.skip) trapSkip++; }
  }
  return { n, avgPolicy: pol / n, avgAll: all / n, edge: (pol - all) / n, skipN, rugN, trapN, trapSkip, stopN };
}
/* dari harga nyata: pakai H jam terakhir sebagai jendela uji, data sebelumnya untuk mengukur gerak harga */
function realizeMeme(plan, win, p0, o, stop) {
  const V = makeVal(plan.pl, plan.ph, plan.strat), k = concK(plan), base = o.measure === 'base';
  const conv = x => o.solR ? (1 + x) / o.solR - 1 : x;
  let fee = 0;
  for (const c of win) {
    fee += c.volume * o.volScale * (o.feeEff / 100) / o.tvl * Math.min(1, 0.4 / Math.max(o.y0, 1e-9)) / (1 + 3 * Math.min(o.y0, 0.4)) * k * V.mavg(Math.log(c.low / p0), Math.log(c.high / p0));
    const xl = valueAt(V, c.low / p0, base) - 1 + fee;
    if (xl <= -stop) { const xc = valueAt(V, c.close / p0, base) - 1 + fee; return conv(Math.min(xc, -stop) - 0.01); }
  }
  return conv(valueAt(V, win[win.length - 1].close / p0, base) - 1 + fee);
}
function backtestMeme(P, candles, L, cfg) {
  cfg = cfg || {};
  const H = cfg.H || 24;
  if (!candles || candles.length < H + 14) return null;
  const i0 = candles.length - H, pre = candles.slice(Math.max(0, i0 - 48), i0), win = candles.slice(i0);
  const sig = sigmaFromCandles(pre) || P.s.sigma;
  const s = Object.assign({}, P.s, { sigma: sig, age: Math.max(0.05, P.s.age - H / 24) });
  const p0 = candles[i0].open;
  let solR = null, noSol = false;
  if (s.usdq) {
    const sc = cfg.solCandles;
    if (sc && sc.length > 24) {
      const near = t => { let b = null, bd = 1e12; for (const c of sc) { const d = Math.abs(c.t - t); if (d < bd) { bd = d; b = c; } } return bd <= 7200 ? b : null; };
      const a = near(win[0].t), z = near(win[win.length - 1].t);
      if (a && z && a.open > 0) solR = z.close / a.open;
      const sp = sigmaFromCandles(sc.filter(c => c.t < win[0].t).slice(-72));
      if (sp) s.solSigma = sp;
    }
    if (!(solR > 0)) { solR = 1; noSol = true; }
  }
  const ev = evaluateMeme(s, L, { H, cap: cfg.cap || 1, appetite: cfg.appetite, N: 300 });
  const rec = candles.slice(-Math.min(24, candles.length)), avgH = rec.reduce((q, c) => q + c.volume, 0) / rec.length;
  const volScale = avgH > 0 && P.s.vol > 0 ? clamp(P.s.vol / 24 / avgH, 0.2, 5) : 1;
  const feeEff = P.feeEff || P.s.fee;
  const nets = ev.arms.map(a => realizeMeme(a.plan, win, p0, { measure: s.measure, volScale, feeEff, tvl: P.s.tvl, y0: ev.pool.y0, solR }, ev.stop));
  const meanAll = avg(nets), policy = ev.skip ? 0 : nets[0];
  if (cfg.learn !== false) {
    ev.arms.forEach((a, j) => learnArm(L, ev.bucket, a.key, a.sim.mean, nets[j], WSRC.bt));
    L.counts.bt++;
    pushHist(L, { t: Date.now(), src: 'bt', pred: ev.skip ? 0 : ev.best.mean, real: policy, edge: policy - meanAll });
  }
  return { ev, nets, policy, meanAll, p0, pEnd: win[win.length - 1].close / p0, solR, noSol, H };
}
function evalCustomMeme(s, L, strat, half, cfg) {
  cfg = cfg || {};
  const H = cfg.H || 24, ev = evaluateMeme(s, L, { H, cap: cfg.cap || 1, appetite: cfg.appetite, N: cfg.N || 400, seed: cfg.seed });
  const plan = planMeme(s, ev.label, strat, half, cfg.cap || 1, cfg.appetite || 'seimbang');
  const sim = simulateH(s, plan, ev.pool, { H, N: cfg.N || 400, rug: ev.pH, seed: cfg.seed || (hash(s.addr || 'x') + 11) });
  let near = null, bd = 1e9;
  ev.arms.forEach(a => { if (a.strat === strat) { const d = Math.abs(a.half - plan.half); if (d < bd) { bd = d; near = a; } } });
  const adj = near ? adjOf(L, ev.bucket, near.key) : 0;
  const snap = { bucket: ev.bucket, key: near ? near.key : plan.key, pred: sim.mean, predAdj: sim.mean + adj, x: ev.rk.x, priorLogit: logit(clamp(ev.a.rugRule, 0.001, 0.9)) };
  return { ev, plan, sim, mean: sim.mean + adj, p10: sim.p10 + adj, adj, snap };
}

/* ---------- belajar dari trade nyata ---------- */
function learnReal(L, snap, realNet) {
  // snap: {s, bucket, key, pred (sim.mean tanpa adj), x, priorLogit}
  learnArm(L, snap.bucket, snap.key, snap.pred, realNet, WSRC.real);
  learnRisk(L, snap.x, realNet < -0.5 ? 1 : 0, WSRC.real * 2, snap.priorLogit);
  L.counts.real++;
  pushHist(L, { t: Date.now(), src: 'real', pred: snap.predAdj != null ? snap.predAdj : snap.pred, real: realNet, edge: null });
}

/* ---------- latihan manual (mis. dari LP Army playground) ---------- */
const PRACTICE = {
  major: { label: 'Pool besar (mis. SOL-USDC)', s: { addr: 'prac-major', tvl: 4e6, vol: 6e6, fee: 0.1, y0: 0.0015, binStep: 10, sigma: 3.5, age: 1500, top10: 15, mint: true, freeze: true, established: true, measure: 'base' } },
  mid: { label: 'Token menengah', s: { addr: 'prac-mid', tvl: 6e5, vol: 1.8e6, fee: 0.2, y0: 0.006, binStep: 20, sigma: 6.5, age: 300, top10: 35, mint: true, freeze: true, measure: 'quote' } },
  meme: { label: 'Memecoin baru', s: { addr: 'prac-meme', tvl: 8e4, vol: 1.2e6, fee: 2, y0: 0.3, binStep: 100, sigma: 28, age: 2, top10: 55, mint: true, freeze: true, measure: 'quote' } }
};
function learnPractice(L, kind, strat, real, appetite) {
  const P = PRACTICE[kind]; if (!P || !STRATS[strat]) return null;
  const ev = evaluateArms(P.s, L, { cap: 1, appetite, N: 300 });
  const arm = ev.arms.find(a => a.key === strat + ':1'); if (!arm) return null;
  learnArm(L, ev.bucket, arm.key, arm.sim.mean, real, WSRC.prac);
  learnRisk(L, ev.rk.x, real < -0.5 ? 1 : 0, WSRC.prac, logit(clamp(ev.a.rugRule, 0.001, 0.9)));
  L.counts.prac = (L.counts.prac || 0) + 1;
  pushHist(L, { t: Date.now(), src: 'prac', pred: arm.mean, real, edge: null });
  return { pred: arm.sim.mean };
}

/* ---------- latihan per pool: pool, strategi, dan lebar rentang dipilih sendiri ---------- */
function evalCustom(s, L, strat, half, cfg) {
  cfg = cfg || {};
  const ev = evaluateArms(s, L, { cap: cfg.cap || 1, appetite: cfg.appetite, N: cfg.N || 400, seed: cfg.seed });
  const plan = planFor(s, ev.label, strat, 1, cfg.cap || 1, cfg.appetite, half);
  const seed = cfg.seed || (hash(s.addr || 'x') + 7);
  const sim = simulate(s, plan, ev.pool, { N: cfg.N || 400, rug: ev.rk.p, seed });
  let near = null, bd = 1e9;
  ev.arms.forEach(a => { if (a.strat === strat) { const d = Math.abs(a.plan.half - plan.half); if (d < bd) { bd = d; near = a; } } });
  const adj = near ? adjOf(L, ev.bucket, near.key) : 0;
  const snap = { bucket: ev.bucket, key: near.key, pred: sim.mean, predAdj: sim.mean + adj, x: ev.rk.x, priorLogit: logit(clamp(ev.a.rugRule, 0.001, 0.9)) };
  return { ev, plan, sim, mean: sim.mean + adj, p10: sim.p10 + adj, adj, snap };
}
function learnPracticeSnap(L, snap, real) {
  learnArm(L, snap.bucket, snap.key, snap.pred, real, WSRC.prac);
  learnRisk(L, snap.x, real < -0.5 ? 1 : 0, WSRC.prac, snap.priorLogit);
  L.counts.prac = (L.counts.prac || 0) + 1;
  pushHist(L, { t: Date.now(), src: 'prac', pred: snap.predAdj, real, edge: null });
}

const api = {
  clamp, avg, nf, fmtUSD, fmtPct, pct, rng, gauss, hash, sigm, logit,
  MV, NB, SOL_SIGMA, shapeW, evalCustom, learnPracticeSnap,
  MEME_ARMS, MEME_FRAC, MEME_STOP, MEME_MIN_GAIN, memeHazard, memeLabel, simulateH, planMeme, evaluateMeme, episodeMeme, trainMeme, backtestMeme, evalCustomMeme,
  LABEL, ALLOC, APP, STRATS, WM, ARMS, WSRC, EXITS, FEAT_NAMES,
  makeVal, valueAt, hodlAt, assess, poolStats, labelOf, bucketOf, planFor, concK, simulate, evaluateArms,
  newLearner, fixLearner, featVec, pSevere, learnRisk, learnArm, adjOf, riskWeights, learnReal,
  PRACTICE, learnPractice, genWorld, truthPath, playOnPath, episode, trainSim, sigmaFromCandles, realizeOnCandles, backtestPool
};
root.LPE = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
