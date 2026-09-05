# Rencana audit DJPI Dashboard

Disusun 5 September 2026. Draf awal digrill dua agen — satu reviewer adversarial, satu
spesialis platform Apps Script — lalu setiap klaim yang berkonsekuensi diverifikasi ulang
langsung ke kode. Temuan di bawah **sudah terbukti**, jadi auditor tidak perlu
menurunkannya lagi dari nol.

Draf pertama mengurutkan pekerjaan menurut intuisi web statis: waktu muat dulu, keamanan
terakhir. Grill membalik urutan itu, dan alasannya ada di bagian Metode.

---

## 1. Temuan yang sudah terbukti

Setiap baris di bawah sudah dicek ke kode. Kolom **Dampak** memakai tiga tingkat:
*genting* (salah sekarang, terlihat pengguna), *serius* (salah sekarang, belum terlihat),
*perbaikan* (tidak salah, tapi boros).

### Keamanan

| # | Temuan | Lokasi | Dampak |
|---|---|---|---|
| S1 | 21 dari 48 endpoint publik tidak memanggil `bacaToken_`. Enam di antaranya memang harus begitu (alur login dan logout). **Tiga belas sisanya fungsi pemeliharaan yang bisa dipanggil siapa pun di domain UPI lewat `google.script.run`.** | lihat daftar di bawah | genting |
| S2 | `cekPengirimanEmail` mengembalikan **seluruh alamat email admin** ke pemanggil | `Code.js:2317`, kebocoran di baris 2334 | genting |
| S3 | `hapusTriggerDoaj` bisa mematikan trigger verifikasi DOAJ harian secara permanen | `Code.js:4458` | genting |
| S4 | `pisahkanEissnPissn` dan `periksaAkurasiEissnPissn` melakukan **tulis massal ke Sheet1** | `Code.js:4545`, `4699` | genting |
| S5 | Token pengelola disimpan di `localStorage`, padahal komentar sistem di halaman admin menyatakan token tidak pernah menyentuh storage | `Pengelola.html:1542` vs `JavaScript.html:1` | serius |
| S6 | Jalur login lama `requestJournalPin` / `verifyJournalPin` sudah mati tetapi masih terekspos | `Code.js:1460`, `1495` | serius |

**Tiga belas endpoint pemeliharaan yang terekspos:** `bootstrapAdmin` (2243),
`cekPengirimanEmail` (2317), `cekKualitasData` (2425), `cekIntegritasData` (2453),
`pasangTriggerDoaj` (4449), `hapusTriggerDoaj` (4458), `pisahkanEissnPissn` (4545),
`periksaAkurasiEissnPissn` (4699), `siapkanKolomProfilDraft` (4868),
`buatSheetPraAsesmen` (5932), `cekPraAsesmen` (6061), ditambah `requestJournalPin` (1460)
dan `verifyJournalPin` (1495) yang sudah mati.

> **Dua jebakan saat memperbaiki ini.**
> `perbaruiVerifikasiDoaj` (`Code.js:4364`) **tidak boleh diganti nama.** Namanya dirujuk
> sebagai string handler trigger di `Code.js:4452` dan `4462`; mengganti namanya mematikan
> trigger harian tanpa pesan galat apa pun. Beri penjaga token di dalam fungsinya.
>
> `buatSesiDarurat` (`Code.js:2285`) **sudah aman** dan tidak perlu disentuh. Tokennya
> sengaja tidak dikembalikan ke pemanggil, hanya ditulis ke log eksekusi yang cuma bisa
> dibaca pemilik skrip.

### Akurasi

| # | Temuan | Lokasi | Dampak |
|---|---|---|---|
| A1 | `var acuan = perTahun \|\| kapasitas` — ketika jumlah artikel per tahun kosong, `acuan` jatuh ke `kapasitas`, lalu `kapasitas >= Math.ceil(kapasitas * 0.8)` **selalu benar**. Butir "Volume artikel memadai" lulus otomatis justru ketika datanya hilang. | `Code.js:5176-5177` | genting |
| A2 | Butir berstatus "perlu dicek" — artinya data belum ada — diberi **setengah bobot**. Jurnal tanpa data sama sekali mendarat di skor sekitar 50/100, bukan 0. | `Code.js:5220` | genting |
| A3 | `cocokJurnal_` mencocokkan dengan `indexOf` dua arah, sehingga "Jurnal Pendidikan" cocok dengan "Jurnal Pendidikan Ekonomi". Fungsi ini menyaring temuan pra-asesmen per pengelola, jadi **pengelola jurnal bernama pendek melihat temuan artikel milik jurnal lain.** | `Code.js:6008-6012` | genting |
| A4 | `bersihkanCacheSitasi_` tidak pernah dipanggil dari mana pun. Data sitasi basi hingga satu jam, dan mengalir ke skor kesiapan akreditasi lewat `lekatkanAkreditasi_`. | `Code.js:936` | serius |
| A5 | `bersihkanCachePraAsesmen_` tidak pernah dipanggil. Setelah TSV ditempel, pengelola melihat data lama hingga 15 menit tanpa penjelasan. | `Code.js:6003` | serius |
| A6 | `MAX_VALUE_BYTES: 90000` membandingkan `String.length` (unit UTF-16) dengan batas Google yang dihitung **byte** (100 KB). Judul artikel dan scope berisi karakter multi-byte; bila lebih dari 11% karakter multi-byte, `put` gagal diam-diam dan cache selalu miss tanpa ada yang tahu. | `Code.js:64`, dipakai di 798, 1160, 1691, 1822, 3544, 3816, 4072, 4346, 5997 | serius |
| A7 | `catch (e) {}` kosong menyamarkan kegagalan baca sheet jadi jawaban negatif. Kalau sheet DOI rusak, `punyaDoi` diam-diam `false` dan pengelola melihat "belum ber-DOI". | `Code.js:5691-5706`, `5135` | serius |

**A1 dan A2 saling memperkuat, dan arah salahnya ke atas.** Skor yang terlalu tinggi
memberi rasa aman palsu kepada pengelola dan menyesatkan triase admin. Ini lebih berbahaya
daripada skor yang terlalu rendah.

### Performa

| # | Temuan | Lokasi | Dampak |
|---|---|---|---|
| P1 | `xlsx.full.min.js` dimuat sinkron di `<head>` Dashboard, dipakai **satu fungsi** | `Dashboard.html:15` → `JavaScript.html:535` | perbaikan |
| P2 | Tiga keluarga font, dua belas bobot, lewat **dua permintaan CSS render-blocking terpisah**. Archivo lima bobot padahal hanya di-scope ke `.app-shell`; `--font-body` global justru Inter. | `Dashboard.html:10` + `Stylesheet.html:4`, scope di `Stylesheet.html:352` | perbaikan |
| P3 | `Masuk.html` memuat Font Awesome penuh untuk **tiga ikon**, padahal halaman ini dilewati 100% pengguna | `Masuk.html:11`, ikon di 81, 87, 91 | perbaikan |
| P4 | Lima origin CDN harus di-handshake, hanya dua yang diberi `preconnect`, keduanya untuk font | `Dashboard.html:8-15` | perbaikan |
| P5 | Sheet `Usulan_DOI` dibaca penuh **dua kali** dalam hitungan detik pada tiap muat Dashboard, keduanya tanpa cache, padahal tujuh sheet lain punya lapisan cache | `Code.js:5124` dan `Code.js:3111` | perbaikan |
| P6 | `getDashboardDataForAdmin` mengembalikan array `journals` penuh **plus** sembilan agregat yang seluruhnya diturunkan dari array yang sama. Klien menerima data yang sama dua kali dalam bentuk berbeda. | `Code.js:1574-1587` | perbaikan |
| P7 | `setValue` per sel di dalam perulangan: sepuluh field satu baris = sepuluh round-trip | `Code.js:1982-1985`, `4936-4941` | perbaikan |
| P8 | `UrlFetchApp.fetch` serial di dalam loop, padahal `fetchAll` sudah dipakai di tempat lain pada berkas yang sama | `Code.js:4627-4640` vs `4403`, `4767` | perbaikan |

---

## 2. Batas platform yang mengubah kesimpulan

Empat fakta Apps Script yang membalik sebagian intuisi performa web biasa.

**Badan halaman tidak pernah bisa di-cache browser.** `HtmlOutput` tidak punya metode
untuk menyetel header HTTP sama sekali, jadi `doGet` dieksekusi ulang tiap kunjungan.
Hanya aset CDN yang bisa di-cache. Konsekuensinya: menghemat kilobyte CDN menolong
kunjungan pertama tiap browser, sedangkan waktu server dan ukuran payload menolong
**setiap** kunjungan selamanya. Itulah sebabnya P6 dan P5 berperingkat lebih tinggi
daripada P1 meski angka kilobyte-nya jauh lebih kecil.

**Plafon 30 eksekusi simultan berlaku bersama untuk seluruh audiens.** `appsscript.json`
memakai `executeAs: USER_DEPLOYING`, jadi semua pengunjung berjalan sebagai satu akun.
Tiga puluh satu orang yang membuka Dashboard bersamaan — misalnya saat rapat — akan
membuat sebagian gagal.

**`CacheService` dibatasi 100 KB per nilai dan 1.000 item.** Saat cap terlampaui, Google
membuang item yang paling dekat kedaluwarsa. Token sesi berbagi cache yang sama dengan
sampai 21 potongan payload jurnal, dan `SESSION_TTL` empat jam membuat sesi lama jadi
kandidat pertama yang dibuang. Ini menjelaskan gejala "sesi putus tiba-tiba" bila pernah
dilaporkan.

**Batas 6 menit per eksekusi.** Relevan untuk P8 dan untuk pengiriman email massal.

Yang **tidak berlaku** di sini dan harus dicoret dari pertimbangan mana pun: service
worker, header `Cache-Control`, code splitting sungguhan, dan kontrol kompresi. Yang
berlaku normal: `defer`, `async`, `preconnect`, `preload`.

---

## 3. Urutan pengerjaan

Nomor 0 wajib lebih dulu. Tanpa itu semua klaim perbaikan adalah tebakan.

**0 — Pasang pengukuran (setengah hari).**
Bungkus `gs()` di `JavaScript.html:3-8` dengan `performance.now()`. Baca durasi per
eksekusi di panel **Executions** konsol Apps Script — sudah tersedia tanpa menambah kode.
Catat rasio hit/miss `bacaCachePotong_` (`Code.js:778`); fungsi ini mengembalikan `null`
bila **satu potongan saja** hangus (`Code.js:791`), jadi rasio miss kemungkinan jauh lebih
tinggi dari dugaan.

**1 — Tutup tiga belas endpoint pemeliharaan (1 jam).**
Tambahkan akhiran `_` pada namanya. Fungsi berakhiran `_` tetap bisa dijalankan dari editor
Apps Script, jadi tidak ada alur kerja pemelihara yang hilang. Kecualikan
`perbaruiVerifikasiDoaj` — beri penjaga token di dalamnya. Hapus `requestJournalPin` dan
`verifyJournalPin` yang sudah mati.

**2 — Perbaiki A1, A2, A3 (2 jam).**
Ketiganya mengubah angka dan daftar yang dilihat pengelola hari ini. Untuk A2,
pertimbangkan melaporkan skor sebagai rentang minimum–maksimum alih-alih satu angka, agar
ketiadaan data terlihat sebagai ketidakpastian, bukan sebagai nilai tengah. Untuk A3, ganti
pencocokan substring dengan pencocokan persis setelah normalisasi.

**3 — `Masuk.html` dan `defer` (1 jam).**
Hapus Font Awesome dari `Masuk.html`, ganti tiga ikonnya dengan SVG inline. Tambahkan
`defer` pada skrip di `Dashboard.html:13-15` dan `Pengelola.html:44`. Pindahkan pemuatan
`xlsx` ke saat `unduhExcel` dipanggil — satu titik sentuh, aman.

**4 — Perbaiki invalidasi cache A4, A5, A6.**

**5 — Ramping­kan payload `getDashboardDataForAdmin` (P6) dan beri cache `Usulan_DOI` (P5).**

**6 — Batas eksekusi: P7, P8, dan uji konkurensi terhadap plafon 30 simultan.**

**7 — Aksesibilitas dan keadaan galat.** Tambahkan pesan untuk kondisi khas platform ini:
sesi tergusur, batas eksekusi simultan, kuota email habis.

---

## 4. Yang sengaja tidak dikerjakan

Empat hal ini muncul di draf awal dan **dicoret setelah digrill**. Alasannya dicatat supaya
tidak diusulkan lagi.

**Subset ikon Font Awesome inline.** Tiga puluh lima kelas ikon tersebar di enam berkas,
sebagian di dalam template string Vue. Satu yang terlewat menghasilkan kotak kosong tanpa
galat konsol, dan tidak ada test yang menangkapnya. Hematnya sekitar 15 KB gzip. Kalau
tetap ingin, ganti `all.min.css` dengan berkas subset `fa-solid` — nama kelasnya tidak
berubah sehingga tidak ada yang bisa pecah.

**Lazy-load Chart.js per tab.** `JavaScript.html:354` menggambar grafik bulanan di
`$nextTick` tepat setelah login, dan tab bawaan adalah `ringkasan` — jadi grafik **selalu**
digambar di layar pertama. Penghematannya nol pada jalur utama. Lebih buruk,
`terapkanTema()` (`JavaScript.html:379-382`) memanggil ulang `new Chart` di luar alur
pergantian tab, sehingga loader asinkron akan menghasilkan `Chart is not defined` yang
hanya muncul saat pengguna mengganti tema. Cukup `defer`.

**Menggabungkan endpoint yang dipanggil berurutan.** Panggilan itu memang sengaja lazy per
panel. Menggabungkannya memindahkan biaya ke muat pertama, berlawanan dengan tujuannya.
Yang perlu dikecilkan adalah **isi** satu respons besar, bukan jumlah panggilan.

**Audit aksesibilitas sebagai alur kerja tersendiri.** Penggunanya puluhan admin dan
pengelola internal, dan belum ada keluhan. Sisipkan pada pekerjaan UI berikutnya.

Di luar cakupan sejak awal dan tidak berubah: mengganti framework, menambah build step,
memindahkan data keluar dari Sheets.

---

## 5. Metode

**Cara mengukur yang sah.** Lighthouse dan panel Performance mengukur dokumen top-level,
yaitu shell `/exec`, bukan iframe tempat aplikasi sebenarnya hidup — skornya menyesatkan
dan **tidak boleh dipakai sebagai baseline**. Yang sah:

- Panel Network DevTools menampilkan semua permintaan termasuk di dalam iframe. Catat
  terpisah antara HTML dokumen iframe (tidak bisa di-cache, inilah yang penting) dan aset
  CDN (bisa di-cache, hanya membebani kunjungan pertama).
- `performance.getEntriesByType('resource')` dijalankan di konsol dengan konteks frame
  dipilih ke iframe aplikasi.
- Panel Executions Apps Script untuk durasi server, tanpa menambah kode.
- Ukur cache hit dan miss **terpisah**: sekali sesudah `bersihkanCacheJurnal_()`, sekali
  langsung sesudahnya. Angka tunggal tanpa keterangan hit/miss tidak bermakna.

**Cara menurunkan risiko.** Pemelihara tunggal, tanpa staging, tanpa test suite. Satu
perubahan per deploy; deploy gabungan membuat rollback jadi tebak-tebakan. `clasp push` ke
HEAD, verifikasi di `/dev`, baru `clasp deploy`.

**Bentuk keluaran.** Kerjakan perbaikannya, bukan laporannya. Bagian 1 dokumen ini sudah
menggantikan tahap "temukan"; yang tersisa adalah tahap "perbaiki". Setiap perbaikan
dicommit terpisah dengan pesan yang menyebut nomor temuan.
