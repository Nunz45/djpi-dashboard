# Audit UI/UX — kegunaan di HP dan keterbacaan warna

Disusun 5 September 2026. Draf awal saya digrill dua agen, lalu setiap klaim berkonsekuensi
diverifikasi ulang ke kode. **Grill membatalkan lima dari temuan draf saya dan menemukan tujuh
masalah yang lebih berat.** Yang paling serius ada di kode yang ditulis dalam sesi yang sama.

Berlaku untuk `Dashboard.html` (admin) dan `Pengelola.html`, CSS bersama di `Stylesheet.html`.

---

## 1. Koreksi atas draf pertama

Dicatat supaya kesalahan yang sama tidak diulang.

| Klaim draf | Kenyataan |
|---|---|
| "16 dari 72 target di bawah 44px" sebagai kegagalan | **44px adalah SC 2.5.5 Level AAA.** Level AA adalah SC 2.5.8, yaitu **24×24px**. Seluruh target yang saya tandai **lolos AA**. Menyajikannya sebagai kegagalan akan membuang waktu ke peningkatan AAA. |
| `--faint` gagal 2.52:1, `--gold` gagal 2.10:1 | Keduanya **tidak pernah dipakai sebagai warna teks**. `var(--faint)` muncul satu kali sebagai `color:` — ikon tutup `.x-btn` (`Stylesheet.html:194`). `var(--gold)` tidak pernah jadi `color:`, hanya latar `.btn-emas` dengan teks gelap yang kontrasnya aman. Empat baris tabel kontras saya mengukur pasangan yang tidak ada di markup. |
| Penyebab gulir mendatar di `@media(max-width:680px)` | Salah kutip. Baris 252 ada di dalam `@media(max-width:1000px)` (`Stylesheet.html:249`). Bug ini **juga menyerang tablet dan laptop kecil 681–1000px**, dan bukan satu baris — baris 250, 251, 252, 260, 261 semuanya kehilangan penjaga `minmax(0,…)`. |
| Kartu "Status migrasi OJS" penyebab gulir | Kartu itu korban. Penyebabnya kartu tetangga "Rekap per kluster" yang berisi tabel; karena kedua trek `1fr` berbagi ukuran, min-content tabel mendorong keduanya. |
| Tabel "menggulir di dalam kartu dan tidak memecahkan halaman" | Benar secara tata letak, **salah sebagai penilaian**. Tombol Aksi ada 376px di luar layar tanpa petunjuk apa pun, dan barisnya tidak bisa diketuk — jadi tidak ada jalan alternatif. |
| "Mode gelap secara umum lebih baik daripada terang" | Benar untuk token, **menyesatkan sebagai kesimpulan**. Mode gelap punya empat kegagalan warna hardcoded di rentang 1,00–2,21:1 yang tidak terlihat oleh perhitungan token. |

---

## 2. Temuan terverifikasi, urut menurut frekuensi × keparahan

### Genting

**U1 — Simpan otomatis akreditasi menelan galat dan membuang simpanan.**
`Pengelola.html` `simpanDiam()`. Dua cacat: `withFailureHandler` kosong sehingga kegagalan
jaringan tidak menghasilkan tanda apa pun di layar, dan indikator tetap menampilkan
"Tersimpan otomatis" dengan cap waktu lama — secara aktif membohongi pengguna. Lalu
`if (!a.dimuat || a.menyimpan) return;` **membuang** panggilan simpan yang jatuh saat simpan
lain sedang berjalan, tanpa menjadwalkannya ulang. Panggilan `google.script.run` rutin makan
1–3 detik, lebih lama di seluler. Dampaknya di alur 100 butir berjam-jam: "kemarin sudah
saya isi, sekarang kosong lagi."

**U2 — Baris paling kritis tidak terbaca sama sekali di mode gelap.**
`Stylesheet.html:166-168` memasang latar terang keras tanpa override gelap:

| Kelas | Kontras teks di mode gelap |
|---|---|
| `.row-alert-danger` | **1,00:1** |
| `.row-alert-warning` | **1,04:1** |
| `.row-alert` | **1,10:1** |

Dipasang oleh `kelasBaris()` justru pada jurnal berstatus kritis, dan pada seluruh tabel
darurat akreditasi (`Dashboard.html:544`). Di mode gelap, baris yang paling penting dibaca
admin adalah satu-satunya yang tidak bisa dibaca.

**U3 — Field yang gagal validasi jadi tak terbaca di mode gelap.**
`Stylesheet.html:239` `.input-galat{background:#fdf6f6}` tanpa override gelap → **1,08:1**.
Dipakai di `Pengelola.html:221`, `:253`, `:407`, `Dashboard.html:1664`. Polanya kejam:
server menolak satu field, penandaannya membuat isi field itu tak terbaca — tepat pada field
yang harus diperbaiki.

**U4 — Setiap form memicu auto-zoom di iOS.**
`Stylesheet.html:153` `.input,.select{font-size:13px}` dan `:373` `.app-nav-cari input{12.5px}`.
Safari iOS otomatis memperbesar halaman setiap kali fokus masuk ke input di bawah 16px, dan
tidak mengecilkan lagi saat blur. Mengisi form APC tiga field berarti tiga lompatan zoom.
Di layar login efeknya makin aneh: field email 13px memicu zoom, field PIN 21px
(`Stylesheet.html:155`) tidak — jadi zoom masuk lalu keluar sendiri di tengah alur.

### Serius

**U5 — Gulir mendatar tak disengaja di ≤1000px.**
`Stylesheet.html:250, 251, 252, 260, 261` memakai `1fr` polos. `1fr` = `minmax(auto,1fr)`, dan
minimum `auto` adalah min-content, sehingga trek membengkak mengikuti isi terlebar. Aturan
dasarnya di `:85-87` sudah benar memakai `minmax(0,1fr)`. Terukur: `scrollWidth` 601px pada
`clientWidth` 390px di tab Ringkasan.

**U6 — Tombol Aksi tidak terjangkau di HP.**
Tabel Jurnal 738px di lebar konten 362px. Kolom Aksi selalu terakhir dan rata kanan, jadi
tombolnya ±376px di luar layar — lebih dari satu layar penuh — tanpa petunjuk visual. Baris
tidak bisa diketuk (`Dashboard.html:829` tanpa `@click`), jadi tombol itu satu-satunya jalan
masuk. Menggulir mendatar di tabel data **dikecualikan** oleh SC 1.4.10 Reflow, jadi ini
bukan pelanggaran WCAG — ini masalah keterjangkauan.

**U7 — Header tabel lengket tidak pernah berfungsi.**
`Stylesheet.html:160` `th{position:sticky;top:0}` berada di dalam `.tabel-bungkus{overflow-x:auto}`
(`:158`). `overflow-x:auto` menjadikan pembungkus itu scroll container untuk kedua sumbu, dan
karena tidak punya batas tinggi, tidak pernah ada guliran vertikal di dalamnya. Gulir 25 baris
di HP dan judul kolom hilang.

**U8 — Jenis input salah di form yang paling banyak diketik.**
`Pengelola.html:218-222` merender seluruh field generik sebagai `type="text"` polos, padahal
daftarnya (`:1196-1208`) berisi empat field URL, satu email, dan dua field angka. Di HP ini
berarti papan ketik alfabet untuk URL, plus autocapitalize yang mengapitalkan huruf pertama.
Menonjol karena wizard DOI di berkas yang sama justru sudah benar — `type="url"` (`:459`),
`inputmode="numeric"` (`:424`, `:428`), `autocomplete="one-time-code"` (`:101`).

**U9 — Override gelap Dashboard hanya lewat satu jalur.**
`Dashboard.html:1872-1874` menulis override untuk `:root[data-theme="dark"]` dan `body.dark`
saja, tanpa varian `@media (prefers-color-scheme: dark)` — tidak seperti `Stylesheet.html:316`
yang menyediakan keduanya. Karena tema bawaan adalah `auto` dan `terapkanTema()` menghapus
atribut `data-theme` pada mode itu, pengguna dengan HP bermode gelap sistem melihat ikon KPI
tetap terang. **Menguji dengan tombol toggle tidak akan memunculkan bug ini**, karena toggle
memasang `data-theme` yang justru mengaktifkan override-nya.

**U10 — Ikon KPI gagal di mode gelap, dua arah sekaligus.**
`Dashboard.html:1868` `.kpi-icon-w` latar hardcoded terang + warna ikon yang ikut menerang →
**2,03:1**. `:1869` `.kpi-icon-g` latar token yang ikut menggelap + warna ikon hardcoded gelap
→ **2,21:1**. Keduanya gagal SC 1.4.11 (3:1). `.kpi-icon-b` dan `.kpi-icon-ok` punya override,
jadi ini kelalaian bukan keputusan.

**U11 — Cincin fokus praktis tak terlihat di mode terang.**
`Stylesheet.html:59` `:focus-visible{outline:3px solid rgba(212,175,55,.72)}`. Emas 72%
dikomposit: **1,70:1** di atas kartu putih, **1,61:1** di atas latar halaman. Gagal SC 1.4.11
yang meminta 3:1. Mode gelap lolos di 4,74:1. Memengaruhi seluruh navigasi keyboard di ketiga
halaman.

### Sedang

**U12 — Teks 10,5px dengan uppercase dan letter-spacing.**
`th` ×27, `badge` ×58, `kpi-label` ×21, `app-nav-grup` 9,5px, `app-nav-user-email` 10px.
Tidak ada kriteria WCAG tentang ukuran font minimum, jadi ini bukan kegagalan kepatuhan.
Tapi uppercase menghapus siluet ascender-descender yang dipakai mata mengenali kata, dan
mayoritas pengelola jurnal berusia 40+. Menghapus `text-transform:uppercase` pada `th` dan
`.kpi-label` berefek lebih besar daripada menaikkan ukurannya 1,5px.

**U13 — `.kpi-gold` 2,54:1 di mode gelap.** `Stylesheet.html:98` `color:#78590e` hardcoded.

**U14 — Stepper akreditasi menyembunyikan dua pertiga alurnya.**
`Pengelola.html:2343-2348`: di bawah 900px stepper jadi bilah mendatar `width:172px` per
langkah. Enam langkah × 172px = 1032px di dalam 362px — **hanya 2,1 langkah terlihat**, tanpa
gradien tepi atau indikator "3 dari 6". Ditambah `position:static`, bilahnya tergulir hilang
begitu pengguna mulai mengisi.

**U15 — `keAtas()` kemungkinan tidak berfungsi di HP.**
`Pengelola.html` memanggil `window.scrollTo` pada dokumen iframe yang sering tidak punya
guliran sendiri; yang bergulir adalah halaman induk. Berpindah langkah akreditasi di HP
kemungkinan tidak menggulir ke atas, jadi pengguna mendarat di tengah langkah berikutnya.
**Perlu diuji di perangkat nyata, belum saya buktikan.**

**U16 — Satu-satunya kegagalan SC 2.5.8 Level AA yang benar-benar ada.**
`Pengelola.html:2296` `.akr-cope-item` tanpa padding, `font-size:12px` → tinggi baris ±18,6px
di dalam `.akr-cope{gap:4px 16px}` (`:2293`). Jarak antar-pusat ≈22,6px, di bawah 24px. Draf
saya melewatkannya karena hanya mengukur tinggi elemen, tidak mengukur jarak antar-target.

**U17 — Ikon tutup modal 2,52:1** (`Stylesheet.html:194`), gagal SC 1.4.11.

**U18 — Modal tidak mengunci gulir halaman, tombol Back Android tidak ditangani.**
Empat overlay di `Dashboard.html`, tidak ada yang menyetel `overflow:hidden` pada `body`.
Esc ditangani, tapi itu perangkat desktop.

**U19 — Sidebar tertutup masih bisa difokuskan.**
`Stylesheet.html:426` hanya `transform:translateX(-100%)` tanpa `visibility:hidden` atau
`inert`. Pembaca layar menelusuri 11 item menu di luar layar sebelum sampai ke konten.

**U20 — CSS kartu-mobile adalah kode mati.**
`Stylesheet.html:174-180` dan `:263-264` mendefinisikan `.list-mobile`, `.desktop-table`,
`.mobile-journal-*`. **Nol pemakaian** di seluruh markup. Pola ini pernah dirancang lalu
ditinggalkan, dan sekarang menyesatkan siapa pun yang mengaudit dari CSS saja. Hapus, atau
hidupkan.

---

## 3. Alur mana yang benar-benar dipakai di HP

Anggaran perbaikan harus mengikuti ini, bukan diratakan.

**Realistis di HP:** Lapor APC (`Pengelola.html:516-548`, 3 field), Lapor Progres Terbitan
(`:591-620`), Akreditasi langkah 1, 2, dan 6 (keputusan tap bukan mengetik), Dashboard tab
Ringkasan, dan melihat badge hitungan di sidebar.

**Realistis desktop saja:** Sunting Data Jurnal (14 field teks + unggah cover), Akreditasi
Tahap 3.1 dan 3.2 (~100 keputusan satu sesi), Dashboard tab Jurnal (7 kolom × 25 baris),
Ekspor Excel dan Cetak PDF — keduanya tidak dapat diandalkan dari iframe sandbox di HP.

---

## 4. Urutan kerja

1. **U1 simpan otomatis** — jadwalkan ulang saat balapan, tampilkan galat di `.akr-nav-status`,
   jangan pertahankan cap waktu lama saat gagal. Sekitar 10 baris. Menghentikan satu-satunya
   jalur kehilangan data.
2. **U2, U3, U9, U10, U13 override gelap** — sekitar 15 baris, dan `Dashboard.html:1872-1874`
   dipindah agar mencakup jalur `prefers-color-scheme`.
3. **U4 font input 16px** di ≤680px — satu blok media, menghapus friksi dari setiap form.
4. **U5 `minmax(0,1fr)`** pada lima baris. Lalu buka ketiga halaman di 768px dan 1024px:
   rentang itu selama ini tidak pernah teruji karena bug ini menyembunyikannya.
5. **U6 dan U7 kolom Aksi lengket** + beri `.tabel-bungkus` batas tinggi agar `th` sticky
   benar-benar bekerja. Sekitar 12 baris CSS, tanpa perubahan markup.
6. **U12 ukuran teks** dan buang uppercase pada `th` serta `.kpi-label`.
   **Kerjakan setelah nomor 5** — menaikkan `th` sebelum tabel dibereskan melebarkan setiap
   tabel ±14%, dari 738px jadi ±840px.
7. Sisanya: U8 jenis input, U11 cincin fokus, U14 stepper, U16 jarak COPE, U18 kunci gulir
   modal, U19 `inert`, U20 hapus kode mati.

---

## 5. Yang dicoret

**Menaikkan seluruh target sentuh ke 44px.** Semuanya sudah lolos SC 2.5.8 Level AA (24px).
44px adalah Level AAA. Kalau tetap diinginkan sebagai standar internal, kerjakan terakhir dan
beri label jujur: peningkatan menuju AAA, bukan perbaikan kepatuhan. Kalau ada 20 menit sisa,
ubah tiga selector saja yang salah-tapnya benar-benar merugikan: tombol Keluar
(`Stylesheet.html:398`, 30px, destruktif), hamburger (`:415`, satu-satunya pintu ke navigasi
di HP), dan tutup modal (`:194`).

**Memperbaiki kontras `--faint` dan `--gold`.** Keduanya tidak pernah jadi warna teks. Yang
tersisa hanya `.x-btn` (U17), dan perbaikannya di selector, **bukan di token** — menyentuh
token merambat ke dua blok gelap kembar di `Stylesheet.html:280-330` dan `:299-344` yang
harus selalu diedit berpasangan.

**Mengubah delapan tabel Dashboard jadi kartu.** Mengubah `display` elemen tabel menghapus
semantik tabel implisit di Chrome dan Firefox, sehingga `role="table"/"row"/"cell"` jadi wajib.
Pola kolom lengket menyelesaikan masalah sebenarnya tanpa risiko itu. Pola kartu hanya layak
untuk dua tabel baca-saja di Pengelola (`:317-342` riwayat DOI, `:569-588` riwayat terbitan).

---

## 6. Standar yang dipakai

| Kriteria | Level | Ambang |
|---|---|---|
| SC 1.4.3 Contrast (Minimum) | AA | 4,5:1 teks biasa, 3:1 teks besar (≥24px, atau ≥18,5px bold) |
| SC 1.4.11 Non-text Contrast | AA | 3:1 untuk indikator fokus, batas dan status komponen |
| SC 2.5.8 Target Size (Minimum) | AA | 24×24px, dengan pengecualian inline, spacing, dan kontrol bawaan |
| SC 2.5.5 Target Size (Enhanced) | AAA | 44×44px |
| SC 1.4.10 Reflow | AA | 320px, **tabel data dikecualikan** |

Tidak ada kriteria WCAG tentang ukuran font minimum. Ambang 16px pada U4 berasal dari perilaku
WebKit, bukan dari WCAG.

**Catatan pengukuran.** Perhitungan kontras berbasis token tidak dapat melihat warna hardcoded,
dan di situlah empat kegagalan terparah berada. Audit warna berikutnya harus memindai nilai
heksadesimal literal di seluruh berkas, bukan hanya blok `:root`.
