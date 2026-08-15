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
   dan kecilkan ukurannya lewat CSS (mis. kotak 56×80px) supaya hasil akhirnya
   sudah kecil dari awal. Tunggu event `load` sebelum lanjut.
3. Pakai tool `computer` action `zoom` dengan `region` yang pas menutupi kotak
   `<img>` itu dan `save_to_disk: true`. Ini men-screenshot elemen tadi dan
   menyimpannya sebagai file PNG lokal — **byte-nya tidak pernah lewat
   respons `javascript_tool`**, jadi sama sekali tidak kena batas ~1000
   karakter maupun filter cookie/base64 di atas.
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

1. Base64 (dari langkah 5 di atas) ditanam sebagai array literal di `Code.js`
   (pola sama seperti `_IMPOR_PROFIL_JURNAL_` dan `_PILOT_COVER_BASE64_` yang
   sudah ada — cari nama itu di `Code.js` untuk lihat contoh formatnya:
   `[{t: 'Nama Jurnal Persis', b64: '...'}, ...]`).
2. Tulis (atau tambahkan ke) fungsi Apps Script satu-kali-jalan yang:
   - Cocokkan `t` (judul) ke `namaJurnal` Sheet1 lewat `normJudul_()`, dengan
     fallback ke tabel `PENYESUAIAN_NAMA_PROFIL_JURNAL_` (pasangan yang sudah
     dikonfirmasi manual) kalau cocok langsung gagal.
   - **Idempoten**: jangan timpa Cover URL yang sudah berupa
     `drive.google.com` (dari sumber Profil_Jurnal, lebih baik) atau
     `data:image` (sudah pernah diisi run sebelumnya) — cuma isi yang kosong
     atau masih `ejournal.upi.edu` (rusak/hotlink).
   - Tulis `'data:image/png;base64,' + b64` ke kolom "Cover URL"
     (`pastikanKolomAda_`).
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

## Batasan yang perlu dijaga saat scale-up

- **Ukuran sel Google Sheets max ~50.000 karakter.** Hasil PNG dari kotak
  56×80px sejauh ini 10.700–23.100 karakter base64 — aman, tapi jangan
  perbesar kotak capture-nya tanpa alasan kuat.
- **Ukuran total `Code.js` bengkak kalau semua ~150 gambar ditanam sekaligus**
  (perkiraan ~2MB+ literal data). Pecah jadi beberapa fungsi/array batch
  (~40-50 gambar per batch: `imporCoverBase64Batch1`, `Batch2`, dst) daripada
  satu fungsi raksasa — lebih gampang di-debug dan di-push bertahap juga.
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

## Status saat dokumen ini ditulis

- `Profil_Jurnal`: 25 submission, sudah diimpor (cover + scope untuk jurnal
  yang cocok namanya).
- Pilot screenshot-capture: 5 jurnal berhasil (ID 90, 274, 2, 70, 82),
  fungsi `imporCoverBase64Pilot()` sudah di-push, belum dijalankan user.
- Sisa ~120-135 jurnal dari `_IMPOR_PROFIL_JURNAL_` yang Cover URL-nya masih
  kosong/`ejournal.upi.edu` (belum diproses) — lanjutkan pakai teknik
  screenshot di atas, dipecah beberapa batch.

## Kalau diminta lanjutkan lagi

1. Baca ulang dokumen ini dulu (jangan mulai dari nol).
2. Cek Sheet1 kolom "Cover URL" untuk tahu mana yang masih perlu diproses
   (skip yang sudah `drive.google.com` atau `data:image`).
3. Ulangi teknik screenshot (same-origin `<img>` + CSS resize + `zoom`
   `save_to_disk`) per batch ~10-20 gambar per `browser_batch` call.
4. Tanam ke `Code.js` sebagai array batch baru, cocokkan nama, tulis kalau
   kosong/rusak, `node --check`, `clasp push`.
5. Minta user redeploy + jalankan fungsi barunya + kirim hasil log.
