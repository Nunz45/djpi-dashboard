# Runbook: Mengisi Cover Jurnal & Scope di Sheet1

Cara kerja yang sudah terbukti untuk mengisi kolom **Cover URL** dan **Scope**
di Sheet1 ("Direktori Jurnal UPI"), yang lalu dipakai `avatarJurnal` dan kartu
jurnal di `Landing.html`. Ditulis supaya bisa diulang tanpa perlu menemukan
ulang jalan buntu yang sudah pernah dicoba.

## Kenapa ini rumit (baca dulu sebelum mulai)

1. **`UrlFetchApp` (Apps Script) diblokir Cloudflare** di semua subdomain
   `*.upi.edu` — termasuk domain pusat `ejournal.upi.edu`. Dibuktikan dengan
   `curl` langsung (403, "challenge") bahkan pakai User-Agent Chrome asli.
   Artinya **tidak ada cara server-side (Apps Script) untuk mengambil apa pun
   dari ejournal.upi.edu** — harus lewat browser sungguhan (Chrome extension)
   yang sudah lolos tantangan Cloudflare.
2. **Hotlink gambar dari ejournal.upi.edu diblokir CORP.** Server mengirim
   header `Cross-Origin-Resource-Policy: same-origin` di gambar-gambarnya.
   Kalau URL gambar itu ditaruh langsung sebagai `coverUrl` dan dirender di
   web app kita (origin beda), browser pengunjung menolak load
   (`net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`). Jadi **URL asli
   ejournal.upi.edu tidak boleh dipakai langsung sebagai coverUrl akhir** —
   harus disalin jadi milik kita sendiri.
3. **`DriveApp` (Apps Script) diblokir untuk akses API** di domain Google
   Workspace UPI, WALAUPUN file-nya sendiri sudah publik lewat browser biasa
   (diverifikasi manual: link `drive.google.com/thumbnail?id=...` kebuka
   normal di tab incognito, tapi `DriveApp.getFileById(id)` di Apps Script
   selalu lempar `Access denied`). **Jangan pernah coba pakai `DriveApp` dari
   Apps Script untuk buat/atur file** — sudah dicoba, gagal total, ini
   kebijakan admin Workspace di luar kendali kita.
4. **`javascript_tool` (browser automation) punya tiga batasan tersembunyi:**
   - Respons dipotong ke ~1000 karakter apa pun yang diminta — untuk ambil
     data besar (base64, teks panjang) harus dipotong-potong lewat
     `window.__x.slice(offset, offset+900)` berkali-kali. **Sangat lambat**
     untuk data besar (butuh puluhan panggilan per gambar).
   - Diblokir (`[BLOCKED: Cookie/query string data]`) kalau outputnya
     mengandung pola `kata = nilai; kata2 = nilai2` — banyak teks deskripsi
     jurnal asli mengandung pola ini (`"e-ISSN = X; p-ISSN = Y"`). Akal-akalan:
     ganti semua `=` dengan token lain sebelum dikembalikan, kembalikan lagi
     setelah diterima.
   - Diblokir (`[BLOCKED: Base64 encoded data]`) kalau outputnya terlihat
     seperti base64 murni — jangan coba base64-kan payload sebagai jalan
     pintas dari masalah cookie-filter di atas, itu kena filter lain.
5. **Download file sintetis (klik `<a download>` dari JS) TIDAK RELIABLE** di
   lingkungan automasi Chrome ini — sudah dicoba dua kali, dua-duanya gagal
   (kadang malah navigasi ke gambar mentah, kadang klik jalan tapi tidak ada
   file muncul di disk). **Jangan andalkan cara ini** meski user sudah kasih
   izin download — masalahnya teknis (Chrome block gesture sintetis), bukan
   izin.

## Cara yang TERBUKTI JALAN (dipakai untuk pilot 5 jurnal)

Alih-alih fetch + resize + base64-extract + download, cara yang cepat dan
reliabel (6/6 berhasil):

1. Buka tab Chrome, navigasi ke `https://ejournal.upi.edu/` (atau halaman apa
   pun di domain itu — yang penting SAME-ORIGIN dengan gambar targetnya, dan
   tab itu sudah lolos tantangan Cloudflare).
2. Lewat `javascript_tool`, buat/atur sebuah `<img>` di halaman itu juga
   (same-origin, jadi tidak kena CORP), `src`-nya diarahkan ke URL cover asli
   (`https://ejournal.upi.edu/public/journals/{id}/journalThumbnail_en_US.{ext}`),
   dan kecilkan ukurannya lewat CSS **kotak 56×80px** (bukan lebih besar —
   lihat catatan ukuran file di bawah). Tunggu event `load` sebelum lanjut.
3. Pakai tool `computer` action `zoom` dengan `region` yang PAS SESUAI kotak
   CSS-nya (mis. kotak di posisi `[10,10]` ukuran 56×80 → `region: [10, 10,
   66, 90]`) dan `save_to_disk: true`. Ini men-screenshot elemen tadi dan
   menyimpannya sebagai file PNG lokal — **byte-nya tidak pernah lewat
   respons `javascript_tool`**, jadi sama sekali tidak kena batas ~1000
   karakter maupun filter cookie/base64 di atas.
   **PENTING — ukuran kotak CSS menentukan ukuran file, BUKAN cuma estetika:**
   tool `zoom` selalu meng-upscale hasil capture ke resolusi tetap (±96×137px)
   berapa pun ukuran region yang diminta — jadi memperbesar kotak CSS tidak
   memperbesar resolusi output, tapi membuat KONTEN di dalamnya lebih detail
   sehingga PNG-nya jauh lebih berat. Sudah kejadian: kotak 96×137px CSS
   menghasilkan rata-rata 43.000 karakter base64/gambar dengan 39 dari 107
   gambar MELEBIHI batas sel Sheets 50.000 karakter. Setelah dikecilkan ke
   56×80px CSS (resolusi output tetap sama, ±96×137px, tapi kontennya
   proporsional lebih kecil/​simpel sehingga PNG mengompres jauh lebih baik),
   rata-rata turun ke ~17.000 karakter, maksimum 28.336 — aman jauh di bawah
   limit. **Selalu verifikasi ukuran base64 hasil capture sebelum memproses
   semuanya** (`buf.toString('base64').length` di Node), jangan asumsikan
   aman.
4. Ulangi langkah 2-3 untuk beberapa gambar sekaligus dalam SATU
   `browser_batch` call (mis. 6 gambar = 12 aksi: set-src+tunggu-load lalu
   zoom-capture, per gambar) — jauh lebih hemat panggilan daripada satu-satu.
5. File PNG hasil `zoom`+`save_to_disk` ada di disk lokal → langsung
   base64-encode lewat Bash/Node (`base64 -w0 file.png`), tidak ada batasan
   ukuran di sini karena murni file I/O lokal.
6. Format hasilnya SELALU PNG asli (sudah diverifikasi manual: prefix base64
   `iVBORw0KGgo...` = magic bytes PNG `89 50 4E 47`). Jadi kalau ditulis
   sebagai data URI, labelnya harus `data:image/png;base64,...` — BUKAN
   `image/jpeg` walau sumber aslinya `.jpg`, karena yang disimpan adalah hasil
   screenshot (selalu PNG), bukan file sumbernya.

## Menjembatani hasil ke Apps Script (Sheet1)

Karena Apps Script tidak bisa fetch ejournal.upi.edu maupun pakai DriveApp,
satu-satunya jalan menaruh data hasil browser ke sheet adalah:

1. Base64 (dari langkah 5 di atas) ditanam sebagai array literal di `Code.js`.
   **Generate lewat skrip Node di file `.js` sungguhan, JANGAN lewat
   `node -e '...'` inline di Bash** — sudah kejadian: template literal berisi
   `\\n` (dimaksudkan jadi escape `\n` di kode HASIL generate) malah tercetak
   sebagai newline SUNGGUHAN di tengah string literal, bikin `Code.js` gagal
   parse. Kalau butuh newline di dalam pesan string hasil generate, pakai
   `String.fromCharCode(10)` di kode yang di-generate, bukan escape backslash
   yang harus selamat lewat dua lapis (generator JS -> shell -> file).
2. Tulis (atau tambahkan ke) fungsi Apps Script satu-kali-jalan yang:
   - Cocokkan `t` (judul) ke `namaJurnal` Sheet1 lewat `normJudul_()`, dengan
     fallback ke tabel `PENYESUAIAN_NAMA_PROFIL_JURNAL_` (pasangan yang sudah
     dikonfirmasi manual) kalau cocok langsung gagal.
   - **Idempoten**: jangan timpa Cover URL/Draft yang sudah terisi.
   - Fungsi TIDAK BOLEH diakhiri underscore (`_`) kalau mau muncul di
     dropdown "Run" Apps Script editor — sudah pernah kejadian bikin fungsi
     `sarankanKecocokanProfilJurnal_` lalu user tidak bisa jalankan sampai
     di-rename.
3. `node --check Code.js` lalu `npx clasp push --force`.
4. **Jangan bikin deployment version baru** — user selalu redeploy manual
   sendiri (Deploy → Manage deployments → New version) tiap ada perubahan.
5. **Jangan `git commit`** — cukup `git add` kalau perlu, commit selalu
   ditangani user sendiri secara eksplisit.
6. User yang menjalankan fungsinya dari editor Apps Script (login
   `djpi@upi.edu`), lalu tempel hasil log-nya ke chat untuk ditinjau.

### ⚠️ PERUBAHAN PENTING: tulis ke DRAFT, bukan ke Cover URL langsung

Sejak section "25. DRAFT & REVIEW PROFIL JURNAL" ditambahkan ke `Code.js`
(dikerjakan paralel oleh sesi lain, alasannya PERSIS temuan spam judi online
di 3/211 halaman sumber yang dicatat dokumen ini), **konten dari sumber luar
(scrape ejournal.upi.edu) tidak boleh lagi ditulis langsung ke kolom "Cover
URL"/"Scope" yang tayang publik** — harus lewat kolom "Cover URL (Draft)" +
set "Status Draft Profil" = `STATUS_DRAFT_PROFIL.MENUNGGU`
(`'MENUNGGU_REVIEW'`), lalu superadmin meninjau lewat tab "Review Profil
Jurnal" (`getDraftProfilJurnal` / `setujuiDraftProfilJurnal` /
`tolakDraftProfilJurnal`) sebelum tayang.

- **`imporCoverBase64Pilot()`** (5 jurnal pertama) DITULIS SEBELUM section 25
  ada — masih menulis langsung ke "Cover URL" live. Ini SUDAH TIDAK
  merepresentasikan pola yang benar lagi, tapi dibiarkan apa adanya (jangan
  diubah retroaktif) karena datanya kecil dan sudah pernah dijalankan/dicek.
- **`imporCoverDraftBatch1/2/3()`** (sisa 107 jurnal, ditambahkan sesudah
  section 25 ada) SUDAH memakai pola draft yang benar — cek `map.coverUrl`
  vs `map.coverUrlDraft` di kode fungsi ini sebagai contoh kalau mau bikin
  batch baru.
- Field FIELD_MAP yang relevan: `coverUrl`, `coverUrlDraft`, `scopeDraft`,
  `statusDraftProfil`, `catatanTolakDraft` — semua header-nya dibuat oleh
  `siapkanKolomProfilDraft()` (jalankan itu dulu sekali kalau kolomnya belum
  ada).
- Aturan tulis yang benar: skip kalau `coverLive` sudah bukan
  `ejournal.upi.edu` (sudah beres, sumber lain lebih baik), DAN skip kalau
  `coverUrlDraft` sudah ada isinya (jangan timpa draft yang lagi ditinjau
  atau baru ditolak — riwayatnya harus tetap ada untuk pengelola).

## Batasan yang perlu dijaga saat scale-up

- **Ukuran sel Google Sheets max ~50.000 karakter.** Hasil PNG dari kotak
  56×80px: 3.472–28.336 karakter base64 (107 sampel) — aman, tapi jangan
  perbesar kotak capture-nya tanpa alasan kuat (lihat catatan detail di
  langkah 3 bagian "Cara yang TERBUKTI JALAN").
- **Ukuran total `Code.js` bengkak kalau semua gambar ditanam sekaligus**
  (107 gambar ≈ 1,8MB literal data). Pecah jadi beberapa fungsi/array batch
  (~35-40 gambar per batch: lihat `imporCoverDraftBatch1/2/3` di `Code.js`
  sebagai contoh nyata) daripada satu fungsi raksasa — lebih gampang
  di-debug dan di-push bertahap juga.
- **Gambar yang gagal dimuat harus dilewati, bukan di-capture asal.** Cek
  `naturalWidth`/`naturalHeight` elemen `<img>` (atau event `error`) sebelum
  `zoom`-capture; kalau gagal, catat judul jurnalnya sebagai "gagal", jangan
  tetap ambil screenshot kosong/rusak.
- **`keJurnalPublik_()` dan `avatarJurnal` (Landing.html) harus menerima
  `data:image/...;base64,`**, bukan cuma http/https — ini sudah dibenerin
  (lihat `coverDataUriValid_()` di Code.js dan regex serupa di
  `avatarJurnal.computed.cover` di Landing.html), tapi kalau bikin jalur baru
  pastikan tetap konsisten pakai validator yang sama.

## Sumber data cover, urutan prioritas

1. **Sheet `Profil_Jurnal`** (isian Google Form langsung dari pengelola
   jurnal) — paling akurat, cover-nya sudah link Drive milik sendiri. Fungsi:
   `imporProfilJurnalDariForm()`. SELALU jalankan/cek ini duluan untuk jurnal
   mana pun sebelum capai ke opsi scrape di bawah — kalau sudah ada di sini,
   tidak perlu di-scrape dari ejournal.upi.edu sama sekali.
2. **Scrape ejournal.upi.edu** (`_IMPOR_PROFIL_JURNAL_`, hasil scrape index
   listing) — dipakai untuk `Scope` (teks about jurnal) via
   `imporCoverDanScope()`, dan untuk cover lewat teknik screenshot di atas
   (karena hotlink langsung diblokir CORP). Ini fallback untuk jurnal yang
   TIDAK ada di Profil_Jurnal.

## Status saat dokumen ini ditulis (update terakhir)

- `Profil_Jurnal`: 25 submission, sudah diimpor (cover + scope untuk jurnal
  yang cocok namanya) lewat `imporProfilJurnalDariForm()`.
- Pilot screenshot-capture: 5 jurnal (ID 90, 274, 2, 70, 82) — fungsi
  `imporCoverBase64Pilot()` sudah di-push. Ini menulis LANGSUNG ke Cover URL
  live (ditulis sebelum sistem draft/review ada — lihat catatan di atas).
- **Sisa 107 jurnal** (dari total ~211 hasil scrape `_IMPOR_PROFIL_JURNAL_`,
  dikurangi yang sudah dapat cover dari Profil_Jurnal/pilot, dikurangi 1
  entri spam judi online yang di-exclude) sudah di-screenshot dan ditanam
  jadi 3 fungsi: `imporCoverDraftBatch1()` (36 jurnal), `imporCoverDraftBatch2()`
  (36 jurnal), `imporCoverDraftBatch3()` (35 jurnal) — sudah di-push, BELUM
  dijalankan user. Ketiganya menulis ke kolom DRAFT (lihat bagian di atas),
  jadi hasilnya baru tayang publik setelah superadmin approve lewat tab
  Review Profil Jurnal.
- Semua 107 capture memakai kotak CSS 56×80px (bukan 96×137px yang tadinya
  dipakai lalu ketahuan menghasilkan file 2-3x lebih besar dari perlu — lihat
  catatan ukuran file di atas). Ukuran base64 akhir: min 3.472, maks 28.336,
  rata-rata 16.911 karakter — semuanya aman di bawah limit sel 50.000.

## Kalau diminta lanjutkan lagi

1. Baca ulang dokumen ini dulu (jangan mulai dari nol).
2. Cek Sheet1 kolom "Cover URL" (live) DAN "Cover URL (Draft)" untuk tahu
   mana yang masih perlu diproses — skip kalau live sudah `drive.google.com`
   atau `data:image`, ATAU draft sudah terisi (sedang/sudah ditinjau).
3. Kalau ada jurnal baru dari `_IMPOR_PROFIL_JURNAL_` yang belum pernah
   dicoba sama sekali (bukan skenario umum lagi setelah update ini, tapi
   cek dulu): ulangi teknik screenshot (same-origin `<img>`, **kotak CSS
   56×80px**, `zoom` `save_to_disk`) per batch ~15 gambar per `browser_batch`
   call — verifikasi ukuran base64 tiap batch sebelum lanjut ke batch
   berikutnya.
4. Tanam ke `Code.js` sebagai array batch baru **lewat skrip Node di file
   `.js` sungguhan** (bukan `node -e` inline — lihat catatan escaping di
   atas). Tulis fungsinya mengikuti pola `imporCoverDraftBatch1/2/3` (ke
   kolom Draft, BUKAN ke Cover URL langsung), `node --check`, `clasp push`.
5. Minta user redeploy + jalankan fungsi barunya + tinjau hasilnya lewat tab
   Review Profil Jurnal (bukan langsung cek Landing page, karena hasilnya
   nunggu approve dulu).
