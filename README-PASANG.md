# Pemandu LP: cara pasang di HP Android

Aplikasi ini web app (PWA). Dibuka lewat Chrome, lalu dipasang ke layar utama. Tidak perlu APK.
Semua data belajar tersimpan di HP-mu, bukan di server.

## Pilih tempat menaruh (pilih satu)

### A. GitHub Pages (gratis, paling mudah)
1. Buat akun di github.com, lalu **New repository**. Nama bebas, mis. `lp-pilot`. Pilih **Public**.
2. Di repo: **Add file → Upload files**. Ekstrak zip ini di komputer atau HP, lalu seret SEMUA berkas ke sana (jangan bawa foldernya, hanya isinya). **Commit changes**.
3. **Settings → Pages**. Source: **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Simpan.
4. Tunggu 1 sampai 2 menit. Alamatnya: `https://NAMAKAMU.github.io/lp-pilot/`.
Catatan: `proxy.php` tidak jalan di GitHub Pages. Kalau nanti Tes koneksi menunjukkan Meteora diblokir, pakai opsi B.

### B. Subdomain di server aaPanel (domain topupindo.id)
Pakai subdomain terpisah, mis. `lp.topupindo.id`, jangan di dalam situs topup. Terpisah berarti data dan wallet tidak bercampur dengan situs pembayaranmu.
1. Di DNS domain, tambah record A untuk `lp` ke IP servermu.
2. aaPanel: **Website → Add site → lp.topupindo.id**. PHP versi apa saja (dipakai `proxy.php`).
3. **Site → SSL → Let's Encrypt**. HTTPS wajib.
4. Unggah zip ke Root directory situs, ekstrak. `index.html` harus sejajar dengan `app.js`.

## Pasang di Android
Buka alamatnya di Chrome → menu titik tiga → **Install app** (atau **Add to Home screen**).

## Pertama kali dipakai
1. **Atur → Tes koneksi.** Kedua baris harus "Baik".
   - Meteora gagal: pindah ke opsi B lalu pilih "Lewat server" di Atur.
   - RPC gagal: ganti alamat RPC dengan RPC gratis milikmu (Helius, QuickNode, dll). RPC publik Solana sering membatasi browser.
2. **Beranda:** tempel alamat publik wallet (hanya baca).
3. **Playground:** Latih otomatis, lalu Uji mundur data nyata.
4. **Pool → Cari pool sekarang.**

## Berlatih di LP Army
lparmy.com/playground adalah simulator tanpa uang asli. Berlatih di sana, lalu di tab **Playground** isi "Latihan di LP Army" (jenis pool, strategi, hasil %). Hasilnya dipelajari dengan bobot kecil.
LP dengan uang asli hanya di app.meteora.ag. Jangan sambungkan wallet ke situs lain.

## Pelatihan otomatis
Saat aplikasi dibuka, ia melatih diri 150 putaran di playground (maksimal sekali per 6 jam) dan, sekali sehari, menguji mundur beberapa pool nyata. Hanya berjalan saat aplikasi terbuka. Latihan terus-menerus saat HP mati butuh program di server.

## Yang perlu kamu tahu
- Aplikasi tidak pernah menyentuh private key dan tidak bisa membuka atau menutup posisi. Kamu mengeksekusi di Meteora.
- Bobot belajar: playground kecil, latihan LP Army kecil, uji mundur data nyata sedang, trade nyatamu paling besar. Hasil playground hanya sebaik simulatornya.
- Banyak hari aplikasi akan bilang "tahan SOL". Itu disengaja: LP sering tidak menutup risikonya.
- Belum diuji terhadap API Meteora asli. Cek lewat Tes koneksi.
- Ini bukan saran keuangan. Kamu bisa kehilangan seluruh modal.
