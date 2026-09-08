# Rencana Pengingat Masa Berlaku Akreditasi — v3

Dokumen kerja. Tidak ada kode aplikasi yang diubah saat dokumen ini ditulis.
Semua klaim tentang kode menyebut `file:baris` dan sudah dibaca ulang pada commit `5220363`.

**Permintaan user:** menampilkan pengingat kapan masa akreditasi jurnal habis, dilengkapi
nomor SK-nya, untuk **pengelola**, **di dalam aplikasi**. Bukan email, bukan pemicu terjadwal.

---

## 0. Temuan verifikasi (dibaca ulang, bukan diterima mentah)

### 0.1 Yang sudah ada sekarang

| Hal | Lokasi | Catatan |
|---|---|---|
| `nomorSk` di FIELD_MAP | `Code.js:107` | alias `['Nomor SK']` |
| `nomorSk` dibaca | `Code.js:977` | di `bacaDataJurnal_` |
| `nomorSk` dikirim ke pengelola | `Code.js:6437` | di dalam `prefillAkreditasi_`, objek `jurnal` |
| `tglBerakhirIso` dikirim ke pengelola | `Code.js:6412, 6436` | hasil `parseKedaluwarsaSk_`, dipakai mengisi field tanggal |
| Kalimat statis "berlaku sampai … berdasarkan SK …" | `Pengelola.html:772–776` | menampilkan **`tanggalExpired` mentah**, bukan tanggal yang sudah diurai |
| Hitung mundur pengelola | `Pengelola.html:791–802` (alert), `Pengelola.html:1122–1123` (ringkasan) | dari computed `akrTenggatUlang`, `Pengelola.html:1826–1843` |
| Hitung mundur admin | `Code.js:5684–5718` `parseKedaluwarsaSk_`, dipakai `Code.js:5847`, tampil `Dashboard.html:549, 604, 1634` | |
| Ambang bucket | `Code.js:5640` `AKR_BUCKET = { kritis: 3, dekat: 6, pantau: 12 }` | dalam bulan **ke tanggal kedaluwarsa** |
| Diagnostik | `Code.js:7465–7509` `cekTanggalExpired()` | **belum pernah dijalankan user** |

Pengelola hanya menerima data ini lewat `getPersiapanAkreditasi` (`Code.js:6446`), yaitu
**hanya saat menu "Persiapan Akreditasi" dibuka**. `getSesiPengelola` (`Code.js:2007–2027`)
dan `getJournalDetailForEditor` (`Code.js:2029–2054`) tidak membawa satu pun field akreditasi.
Tidak ada menu "beranda" di Pengelola.html — navnya `sunting / doi / apc / terbitan / akreditasi`
(`Pengelola.html:1644` dst.).

### 0.2 Cacat 1 — `bacaTanggalLonggar_` membaca `M/1/YYYY` sebagai hari/bulan. BENAR, dan dampaknya terukur.

`Code.js:5669–5670`:

```js
m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
if (m) return tanggalSah_(+m[3], +m[2], +m[1]);   // (tahun, bulan=grup2, hari=grup1)
```

Jadi teks `"6/1/2026"` dibaca **6 Januari 2026**.

Bukti dari data repo (`sk-akreditasi/utama.csv`, 180 baris, snapshot direktori):

- 114 baris berstatus `SINTA 1–6`; 112 punya isi `TANGGAL EXPIRED`.
- 68 di antaranya berbentuk `d/d/yyyy`. **Komponen keduanya SELALU `1`** — himpunan nilai
  komponen kedua = `{'1'}`. Tidak ada satu pun baris dengan komponen pertama > 12.
- Kalau maksudnya `d/m/y`, artinya 68 dari 68 SK kebetulan berakhir di bulan **Januari**.
  Itu tidak masuk akal; bentuk sebenarnya **M/D/YYYY** (ekspor lokal Amerika), hari selalu 1.
- Dampak per hari ini (2026-09-09): dibaca `d/m/y` → **39 dari 68 dianggap sudah lewat**;
  dibaca `m/d/y` → **26 yang benar-benar lewat**. **Selisihnya tepat 13 jurnal** yang akan
  diberi tahu akreditasinya sudah habis padahal belum:

  Journal of Science Learning, EduBasic Journal, Journal of Mechanical Engineering Education,
  Historia, Jurnal Pedagogik Pendidikan Dasar, Journal of Computer Engineering Electronics
  and Information Technology, Indonesian Journal of Adult and Community Education, Edulib,
  Jurnal Tata Kelola Pendidikan (JTKP), Jurnal Kemaritiman, Jurnal EurekaMatika,
  Journal of Logistics and Supply Chain, Journal of Korean Applied Linguistics.

  Angka "~13" dari sesi sebelumnya **terverifikasi persis**.

**Tapi ada syarat yang belum terverifikasi.** `Code.js:5660` memulangkan objek `Date` apa adanya:

```js
if (nilai instanceof Date && !isNaN(nilai.getTime())) return nilai;
```

CSV tidak bisa membedakan sel Date dari sel teks — ekspor CSV meratakan keduanya jadi `6/1/2026`.
Kalau sel di Sheet1 **bertipe Date**, cabang `Code.js:5660` menang dan **tidak ada bug sama sekali**.
Kalau bertipe **teks**, bug 13-jurnal itu nyata dan sudah tayang sekarang di dashboard admin.
Jawabannya persis yang dikeluarkan `cekTanggalExpired()` (`Code.js:7465`).
**Status: belum terverifikasi. Ini gerbang nomor satu.**

### 0.3 Cacat 2 — admin dan pengelola berselisih 6 bulan. BENAR.

- `Pengelola.html:1831`: `var tenggat = new Date(berakhir.getFullYear(), berakhir.getMonth() - 6, berakhir.getDate());`
  lalu `bulan` dihitung **ke `tenggat`**, ditulis "Sisa **N bulan**" (`Pengelola.html:799`).
- `Code.js:5693`: `hasil.bulanTersisa = selisihBulan_(sekarang, tgl)` dengan `tgl` = **tanggal
  kedaluwarsa**, ditulis "Kedaluwarsa dalam **N bulan**" (`Code.js:5712–5714`).

Untuk satu jurnal yang sama, admin bisa membaca "Kedaluwarsa dalam 8 bulan" (bucket `pantau`,
biru) sementara pengelola membaca "Sisa 2 bulan" (`mendesak`, merah). Keduanya benar menurut
definisinya masing-masing; yang salah adalah **labelnya sama-sama "bulan" tanpa menyebut
menuju apa**. Aritmetikanya sendiri identik (`Pengelola.html:1834` sama persis dengan
`selisihBulan_` di `Code.js:5643–5647`).

### 0.4 Cacat 3 — fallback `masaBerlakuSk` memakai 31 Desember. BENAR, dampaknya kecil di data sekarang.

`Code.js:5699–5706` mengambil tahun 4-digit **terbesar** dari `masaBerlakuSk` lalu
`new Date(hasil.tahun, 11, 31)`. Melebihkan sisa umur sampai 11 bulan.

Di `sk-akreditasi/utama.csv`, 112 dari 114 baris terakreditasi sudah punya `TANGGAL EXPIRED`,
jadi fallback ini hampir tidak pernah kena. Yang jatuh ke fallback: 2 baris kosong total, plus
1 baris rusak (`PEDAGOGIA`, isinya `"12/12022"` — tidak cocok regex mana pun di
`bacaTanggalLonggar_`, jadi null lalu fallback). Isi `MASA BERLAKU SK` sendiri berbentuk
`"Volume 10 Nomor 2 Tahun 2025 sampai Volume 15 Nomor 1 Tahun 2030"` — rentang volume,
bukan tanggal, persis seperti dugaan.

Catatan tambahan: `Code.js:6412` juga memakai fallback ini untuk **mengisi field tanggal
pengelola** (`tglIso = ked.tanggalIso || (ked.tahun + '-12-31')`). Jadi 31 Desember palsu itu
bukan cuma label admin — ia masuk sebagai nilai awal `<input type="date">` milik pengelola
(`Pengelola.html:770`), dan dari situ mengalir ke `akrTenggatUlang`.

### 0.5 Cacat 4 — meluber akhir bulan & `new Date('yyyy-mm-dd')` UTC. BENAR secara mekanis, tidak berdampak di data sekarang.

- `Pengelola.html:1831` `new Date(y, m-6, d)`: untuk 31 Agustus → `new Date(y, 1, 31)` → 3 Maret.
  Tapi seluruh tanggal di direktori berhari `1`, jadi tidak ada yang meluber **kecuali** pengelola
  mengetik sendiri tanggal 29–31. Risiko nyata tapi kecil; ralatnya sebaris.
- `Pengelola.html:1829` `new Date(a.tglBerakhirSk)` dengan string `"2026-06-01"` memang diurai
  sebagai UTC tengah malam. Di WIB (UTC+7) itu jadi 07:00 hari yang sama, sehingga
  `getMonth()`/`getDate()` tetap benar. Hanya salah di zona UTC-negatif. Sama untuk
  `tglPanjang` (`Pengelola.html:2643–2650`). **Bukan bug yang terlihat bagi user Indonesia.**

### 0.6 Kualitas data — diverifikasi dari `sk-akreditasi/`

Semua angka di bawah dihitung ulang dari `sk-akreditasi/utama.csv` + `sk-akreditasi/cek-silang.json`
di repo, bukan dari ingatan sesi lalu.

| Klaim sesi lalu | Hasil verifikasi |
|---|---|
| 180 baris direktori | **Benar** (180 baris; 114 berstatus SINTA 1–6) |
| ~68 punya TANGGAL EXPIRED | **Perlu diluruskan**: 112 punya isi; **68** berbentuk tanggal `d/d/yyyy`, **43** hanya berupa tahun (`2028`, `2029`, `2030`, `2026`), 1 rusak (`12/12022`) |
| ~43 hanya bertahun | **Benar** (27×`2028` + 12×`2029` + 3×`2030` + 1×`2026` = 43) |
| SK berlaku melewati tanggal kedaluwarsa | **Benar, 8 baris** di `utama.csv`: ASEAN Journal of Science and Engineering, PEDAGOGIA, **EDUTECH**, **TEKMULOGI**, Jurnal Kepelatihan Olahraga, **Jurnal Ilmu Manajemen dan Bisnis**, Jurnal Arsitektur ZONASI, Journal of Physical Education and Sport Pedagogy. Ketiga nama yang disebut user ada di daftar |
| ~12 tidak punya SK cocok | **Angkanya lebih besar**: **24** baris terakreditasi kolom `Nomor SK`-nya kosong di `utama.csv`. `cek-silang.json` mencatat 32 baris "e-ISSN kosong di Sheet1" dan 4 "Sheet1 menyebut SINTA n tetapi tidak ada di SK mana pun" |
| Direktori lebih baru daripada korpus SK (kasus WaPFi) | **Tidak terkonfirmasi pada data sekarang.** Baris WaPFi di `cek-silang.json` justru cocok sempurna (SK `355/DST/D.D1/HM.01.01/2026`, 2025 Periode III, berakhir 2030, `catatan` kosong). Yang tersisa: **24 baris** bercatatan "tahun berakhir beda: Sheet1 X vs SK Y". **Status: klaim WaPFi belum terverifikasi / kemungkinan sudah tertutup oleh `updateMasaBerlakuSk()`** |

**Peringatan pemakaian:** `utama.csv` adalah snapshot, bukan Sheet1 hidup. Ia berbeda dari
`utama-sebelum-update.csv` pada 79 baris `TANGGAL EXPIRED` dan 180 baris `Nomor SK`, jadi ia
memang pasca-pembaruan — tapi tidak ada jaminan ia sama dengan sheet hari ini.

### 0.7 Satu koreksi terhadap brief

Brief menyebut ambang peringkat "1 ≥90, 2 ≥70, 3 ≥65, 4 ≥60". **Kode dan memori proyek tidak
setuju.** `Code.js:6272` menuliskan:

```js
peringkat: [ { p: 1, min: 90 }, { p: 2, min: 80 }, { p: 3, min: 70 }, { p: 4, min: 60 } ]
```

dan `Code.js:6219–6220` mengonfirmasi `AKR_TATA_KELOLA_MAKS = 46`, `AKR_MUTU_ARTIKEL_MAKS = 54`
(bagian n = 46 + 54 memang benar). Memori `reference_akreditasi-2026-regulasi.md` juga menulis
1 (90–100) · 2 (80–<90) · 3 (70–<80) · 4 (60–<70). **Angka 70/65 di brief kemungkinan keliru.**
Karena tidak ada satu pun angka peringkat yang perlu muncul di teks pengingat, ini tidak
memblokir apa pun — tapi jangan sampai angka itu menular ke tempat lain.

---

## 1. RENCANA v1 (sebelum digrill)

Tujuan: mengubah kalimat statis `Pengelola.html:772–776` menjadi pengingat yang punya sisa
waktu, keadaan, dan nomor SK. **Nol perubahan di `Code.js`** — semua data yang dibutuhkan
(`tglBerakhirIso`, `nomorSk`, `tanggalExpired`, `masaBerlakuSk`) sudah dikirim `Code.js:6432–6442`.

**V1-A — `Pengelola.html`, satu computed baru `akrPengingat()`** (di sebelah `akrTenggatUlang`,
~`Pengelola.html:1826`):

- Sumber tanggal: `persiapanAkr.tglBerakhirSk` (nilai yang dilihat & bisa dikoreksi pengelola).
- Hitung `E` = tanggal SK berakhir, `T` = `E` − 6 bulan (tenggat pengajuan ulang),
  `B2` = `E` + 2 tahun (batas Akreditasi Ulang menurut Juknis III.A.2.2).
- Keluarkan `{ keadaan, tglE, tglT, tglB2, bulanKeT, bulanKeE, nomorSk, sumber }` dengan
  `keadaan` ∈ `lama | dekat | tenggatLewat | habis | habisLama | takAda`.

**V1-B — ganti blok `Pengelola.html:772–776` dan `791–802`** dengan satu blok pengingat berbasis
`akrPengingat`, memuat: tanggal berakhir (diformat `tglPanjang`, bukan string mentah `6/1/2026`),
nomor SK, sisa waktu, dan kalimat sesuai keadaan (§4).

**V1-C — perbaiki label ganda** di `Pengelola.html:799` dan `Pengelola.html:1123`: dari
"Sisa N bulan" menjadi "N bulan lagi sampai tenggat pengajuan".

Selesai. Tiga suntingan, satu file.

---

## 2. GRILL

### G1. Apa yang dilihat pengelola kalau datanya salah?

**Ini pembunuh rencana v1.** V1 mengambil tanggal dari `persiapanAkr.tglBerakhirSk`, yang diisi
server dari `tglBerakhirIso` (`Code.js:6412`), yang berasal dari `parseKedaluwarsaSk_`, yang
memanggil `bacaTanggalLonggar_`. Kalau sel Sheet1 bertipe teks (§0.2), maka **13 jurnal** akan
melihat pengingat yang menyatakan akreditasinya sudah habis berbulan-bulan padahal belum.
V1 tidak memperbaiki apa pun; ia **memperkeras** kalimat yang sekarang masih pasif menjadi
peringatan bernada mendesak. Membuat kesalahan lebih keras adalah kemunduran.

Konsekuensi: **fitur ini tidak boleh tayang sebelum `cekTanggalExpired()` dijalankan.**

### G2. Bisakah pengingat ini membuat pengelola mengambil keputusan yang merugikan?

Ya, empat jalur:

1. **Tanggal salah lebih awal (§0.2)** → pengelola menyimpulkan "sudah telat, percuma" →
   berhenti menyiapkan berkas. Kerugian permanen: begitu SK benar-benar habis tanpa pengajuan,
   Permendiktisaintek 9/2026 Pasal 13(6) tidak lagi memberi perpanjangan otomatis.
2. **Tanggal salah lebih akhir (fallback 31 Desember, §0.4)** → pengelola merasa punya waktu
   11 bulan lebih dari kenyataan → melewatkan tenggat 6 bulan.
3. **Menunda terbitan.** Ini bahaya khas. Pengelola yang membaca "status Anda akan tidak
   terakreditasi" bisa berpikir menahan nomor terbitan sampai SK baru keluar akan
   menyelamatkan nomor itu. Juknis III.B.7 menutup jalan itu: nomor yang seharusnya terbit
   selama status tidak terakreditasi tetap tidak terakreditasi walaupun penerbitannya ditunda.
   Menunda hanya menambah kerugian keberkalaan. **Teks pengingat wajib menyebut ini secara
   eksplisit**, kalau tidak fitur ini justru memicu keputusan merugikan.
4. **Menjanjikan pembukaan.** Pembukaan ARJUNA terakhir Periode III 2025; sepanjang 2026 belum
   ada pembukaan dan belum ada tanggal yang diumumkan. Pengingat yang berbunyi "ajukan sebelum
   tanggal X" tanpa ada gerbang yang terbuka membuat pengelola mencari sesuatu yang tidak ada,
   lalu berhenti percaya pada pengingat berikutnya.

### G3. Konsisten dengan yang dilihat admin?

Tidak, dan v1 memperparah (§0.3). Setelah v1, pengelola akan melihat dua angka bulan di layar
yang sama (satu dari `akrPengingat`, satu dari `akrTenggatUlang` di `Pengelola.html:1123`) di
samping angka ketiga yang dilihat admin di `Dashboard.html:604`. Tiga angka, satu jurnal,
semuanya berlabel "bulan". Solusinya bukan menambah angka keempat — melainkan **satu sumber,
dua anchor yang selalu disebut namanya**: "… bulan lagi sampai **tenggat pengajuan**" (T) vs
"… bulan lagi sampai **SK berakhir**" (E).

### G4. Ada tempat lain yang menampilkan hal serupa dan akan bertentangan?

Ada empat, semuanya sudah tayang:

| Tempat | File:baris | Risiko |
|---|---|---|
| Alert tenggat pengelola | `Pengelola.html:791–802` | menghitung ke T |
| Baris ringkasan pengelola | `Pengelola.html:1122–1123` | menghitung ke T, label "sisa" |
| Lembar cetak pengelola | `Pengelola.html:1271–1272` | hanya "SK berakhir <tanggal>" |
| Kalender + tabel darurat admin | `Dashboard.html:495–518, 549, 604, 1634` | menghitung ke E, label bucket |

Menambah blok kelima tanpa menyatukan empat yang lama adalah menambah kontradiksi. V1-B
menghapus dua; v1 tidak menyentuh lembar cetak — padahal lembar cetak itulah yang dibawa
pengelola ke rapat. **Lubang di v1.**

### G5. Apakah memperbaiki `bacaTanggalLonggar_` menimbulkan regresi di fitur lain?

Ya, luas. `bacaTanggalLonggar_` dipanggil dari:

- `Code.js:5688` (`parseKedaluwarsaSk_`) → `Code.js:5847` → seluruh tab Akreditasi admin:
  KPI kalender (`Dashboard.html:495–510`), tabel darurat (`Dashboard.html:522–549`),
  jadwal (`Dashboard.html:604`), panel detail jurnal (`Dashboard.html:1634`).
- `Code.js:6412` → nilai awal field tanggal pengelola.
- `Code.js:6962`, `Code.js:7029` (`angkaPersiapanData`, laporan perencanaan kerja staf).

Membalik urutannya jadi bulan/hari akan **memperbaiki 68 baris ekspor Amerika** tetapi
**merusak setiap tanggal yang benar-benar diketik `dd/mm/yyyy`** oleh staf — dan `Code.js:7050`
justru mengiklankan `01/07/2027` sebagai format yang diterima, jadi entri d/m/y bukan hipotesis,
melainkan format yang dianjurkan sistem sendiri. Menebak arah berdasarkan "komponen mana yang
> 12" tetap ambigu untuk semua tanggal 1–12.

**Kesimpulan grill: jangan sentuh parser.** Yang bermasalah adalah **isi sel**, bukan pembacanya.
Perbaikannya di Sheet1 (normalkan ke `yyyy-mm-dd` atau ke sel Date sungguhan), dan itu pekerjaan
data milik user, bukan perubahan kode. Ini juga jalan yang paling kecil.

### G6. Apakah pengelola akan melihat pengingat ini sama sekali?

V1 menempatkannya di dalam **menu Persiapan Akreditasi, langkah 1**. Pengelola harus: masuk →
klik menu Akreditasi → menunggu `getPersiapanAkreditasi` → berada di langkah 1. Pengingat yang
hanya muncul di ruangan yang sudah dimasuki orang yang sudah sadar adalah pengingat yang tidak
mengingatkan. Tapi memindahkannya ke seluruh aplikasi menuntut `getSesiPengelola`
(`Code.js:2007`) membawa field akreditasi — perubahan server, di luar "sekecil mungkin".
**Ini keputusan user, bukan keputusan saya.**

### G7. Konflik SK vs tanggal (§0.6, 8 baris)

Untuk EDUTECH, TEKMULOGI, Jurnal Ilmu Manajemen dan Bisnis dan lima lainnya, nomor SK yang akan
ditampilkan berlaku sampai **setelah** tanggal kedaluwarsa di kolom yang sama. Kalimat "berlaku
sampai <tanggal> berdasarkan SK <nomor>" untuk baris-baris itu **menautkan dua fakta yang saling
membantah**, dan pengelolalah yang memegang sertifikat aslinya — ia akan tahu kita salah. Fitur
ini harus punya keadaan "tidak terverifikasi" yang jujur, bukan memaksa setiap baris masuk ke
salah satu keadaan pasti.

### G8. Urutan kerja yang aman?

Bukan "tulis kode dulu". Urutannya: **pastikan angkanya benar → satukan definisi → baru
perkeras kalimatnya.** Menaikkan volume sebelum menyetel nada adalah cara tercepat membuat
13 pengelola tidak percaya lagi pada sistem ini.

---

## 3. RENCANA v2 (revisi setelah grill)

### Tahap 0 — GERBANG: butuh user, sebelum satu baris pun ditulis

1. **Jalankan `cekTanggalExpired()`** dari editor Apps Script (`Code.js:7465`), tempel
   keluarannya. Ini menentukan:
   - **"Seluruh sel bertipe TANGGAL"** → tidak ada bug 13-jurnal, lanjut ke Tahap 1 langsung.
   - **"Sel bertipe teks: N"** → **hentikan fitur**, kerjakan Tahap 0b dulu.
2. **Tahap 0b (hanya bila sel teks):** normalkan kolom `TANGGAL EXPIRED` di Sheet1 ke
   `yyyy-mm-dd`, atau ubah tipe selnya menjadi Date. **Pekerjaan sheet, bukan kode.**
   Parser `bacaTanggalLonggar_` **tidak diubah** (alasan: G5).
   Sanity check setelahnya: jalankan `angkaPersiapanData()` (`Code.js:6947`) — jumlah
   "Tanggal lengkap, sudah bisa dipakai" harus tetap, dan sebaran tahunnya tidak boleh lagi
   menumpuk di Januari.

**Tidak ada langkah berikut yang boleh dijalankan sebelum Tahap 0 selesai.**

### Tahap 1 — Satukan definisi waktu (Pengelola.html saja, tanpa UI baru)

Tujuan: menghapus ambiguitas "N bulan" sebelum kalimat apa pun ditambahkan.

- **1.1** `Pengelola.html:1826–1843` — ganti `akrTenggatUlang` menjadi `akrPengingat` yang
  memulangkan **dua** angka bereksplisit nama: `bulanKeTenggat` dan `bulanKeBerakhir`, plus
  `tglTenggatIso`, `tglBerakhirIso`, `tglBatas2ThnIso`, dan `keadaan`. Pertahankan nama lama
  sebagai alias sementara supaya `Pengelola.html:1122` tidak pecah.
- **1.2** Perbaiki luberan akhir bulan (§0.5): setelah `new Date(y, m-6, d)`, kalau
  `hasil.getDate() !== d` mundurkan ke hari terakhir bulan target. Empat baris.
- **1.3** Ganti label di `Pengelola.html:799` dan `Pengelola.html:1123`: "Sisa N bulan" →
  "N bulan lagi sampai tenggat pengajuan". Ini sekaligus menghapus kontradiksi dengan
  `Dashboard.html:604` yang berbicara tentang kedaluwarsa, bukan tenggat.

Setelah Tahap 1, layar pengelola belum berubah isinya — hanya jadi tidak berdusta.

### Tahap 2 — Pengingat itu sendiri (inti permintaan user)

- **2.1** Hapus kalimat statis `Pengelola.html:772–776`. Isinya diserap Tahap 2.2, dan ia
  menampilkan `tanggalExpired` **mentah** (`"6/1/2026"`) yang tidak boleh dibaca manusia.
- **2.2** Ganti alert `Pengelola.html:791–802` dengan satu blok pengingat berbasis
  `akrPengingat.keadaan`, teksnya **verbatim dari §4**. Selalu memuat: tanggal berakhir
  terformat, **nomor SK**, jarak waktu bernama, dan satu kalimat tindakan.
- **2.3** Tambahkan nomor SK + tanggal berakhir ke kop lembar cetak `Pengelola.html:1271–1272`
  (satu baris) — supaya lembar yang dibawa ke rapat menyebut fakta yang sama (G4).
- **2.4** Keadaan `takAda` juga menyala ketika `persiapanAkr.jurnal.nomorSk` kosong (24 baris,
  §0.6) atau ketika sumber tanggalnya `tahun` saja (43 baris) — dalam kasus itu **jangan
  tampilkan hitungan bulan sama sekali**, hanya ajakan mengisi tanggal. Sinyalnya sudah
  tersedia: `Code.js:6412` memakai `ked.tanggalIso || (ked.tahun + '-12-31')`, jadi tambahkan
  **satu field** `sumberTanggal: ked.sumber` ke objek `jurnal` (`Code.js:6432–6442`).
  Itu satu-satunya perubahan `Code.js` di seluruh rencana ini.

### Tahap 3 — OPSIONAL, butuh keputusan user

Menampilkan pengingat di seluruh menu pengelola (bukan hanya menu Akreditasi), sebagai satu
baris tipis di bawah `<main class="app-isi">` (~`Pengelola.html:210`). Biayanya:
`getSesiPengelola` (`Code.js:2007–2027`) harus ikut membawa
`tanggalExpired`/`nomorSk`/`tglBerakhirIso` — artinya ia perlu memanggil `bacaDataJurnal_` yang
sekarang tidak dipanggilnya (biaya baca sheet di setiap muat halaman pengelola).

**Pertanyaan untuk user:** cukupkah pengingat berada di dalam menu Persiapan Akreditasi, atau
harus terlihat di setiap layar? Kalau jawabannya "cukup di menu itu", Tahap 3 dibuang.

### Ringkas urutan

| # | Langkah | File | Blokir? |
|---|---|---|---|
| 0 | Jalankan `cekTanggalExpired()` | — | **butuh user** |
| 0b | Normalkan kolom di Sheet1 (bila sel teks) | Sheet1 | **butuh user** |
| 1.1–1.3 | Satukan & beri nama angka bulan | `Pengelola.html` | — |
| 2.1–2.3 | Blok pengingat + kop cetak | `Pengelola.html` | butuh 0 & 1 |
| 2.4 | `sumberTanggal` | `Code.js:6432–6442` | — |
| 3 | Pengingat global | `Code.js` + `Pengelola.html` | **butuh keputusan user** |

---

## 4. TEKS PENGINGAT — VERBATIM

Aturan yang dipatuhi semua teks di bawah: tidak menyebut tanggal pembukaan ARJUNA (belum ada);
tidak menjanjikan perpanjangan otomatis (sudah dicabut Permendiktisaintek 9/2026 Pasal 13(6));
menyebut larangan menunda terbitan (Juknis III.B.7) di setiap keadaan yang berisiko memicunya;
tidak memakai tanda seru; tidak menyebut angka peringkat.

Notasi: `{E}` = tanggal SK berakhir (format panjang), `{T}` = tenggat pengajuan (E − 6 bulan),
`{B2}` = E + 2 tahun, `{SK}` = nomor SK, `{n}` = jumlah bulan.

---

**Keadaan A — masih lama** (hari ini lebih dari 6 bulan sebelum `{T}`)

> Akreditasi jurnal ini berlaku sampai **{E}**, berdasarkan SK **{SK}**.
> Pengajuan akreditasi ulang paling lambat **{T}**, yaitu enam bulan sebelum masa berlaku
> berakhir — **{n} bulan** lagi dari sekarang.
> Belum ada yang perlu dikerjakan hari ini. Bila tanggal atau nomor SK di atas berbeda dengan
> sertifikat yang Anda pegang, perbaiki tanggalnya di kolom berikut dan beri tahu DJPI.

---

**Keadaan B — mendekati tenggat** (0 ≤ jarak ke `{T}` ≤ 6 bulan)

> Akreditasi jurnal ini berlaku sampai **{E}**, berdasarkan SK **{SK}**.
> Batas pengajuan akreditasi ulang adalah **{T}** — tinggal **{n} bulan**.
> Berkas sebaiknya disiapkan mulai sekarang, karena pengajuan hanya dapat dikirim ketika
> ARJUNA membuka periode penerimaan. Pembukaan terakhir adalah Periode III 2025; sampai
> catatan ini ditulis, belum ada pembukaan berikutnya yang diumumkan. Yang bisa dikendalikan
> sekarang adalah kesiapan berkas, bukan waktu pembukaannya.
> Tetap terbitkan nomor sesuai jadwal. Menunda terbitan tidak menyelamatkan status nomor
> tersebut.

---

**Keadaan C — tenggat lewat, SK masih berlaku** (`{T}` < hari ini ≤ `{E}`)

> Akreditasi jurnal ini berlaku sampai **{E}**, berdasarkan SK **{SK}**.
> Batas enam bulan sebelum berakhir, yaitu **{T}**, sudah terlampaui **{n} bulan**.
> Masa berlaku SK masih berjalan, jadi status jurnal saat ini belum berubah. Namun ketentuan
> lama — akreditasi sebelumnya tetap berlaku sampai keputusan baru terbit — sudah dicabut.
> Bila tidak ada pengajuan sampai **{E}**, jurnal dinyatakan tidak terakreditasi terhitung
> sejak tanggal itu.
> Siapkan berkas sekarang dan ajukan pada kesempatan pembukaan ARJUNA yang terdekat.
> Tetap terbitkan nomor sesuai jadwal.

---

**Keadaan D — SK sudah berakhir, belum dua tahun** (`{E}` < hari ini ≤ `{B2}`)

> Masa berlaku akreditasi jurnal ini berakhir pada **{E}**, berdasarkan SK **{SK}**, yaitu
> **{n} bulan** lalu. Sejak tanggal tersebut status jurnal adalah tidak terakreditasi.
> Jalur pemulihannya masih terbuka. Selama belum lewat dua tahun sejak **{E}** — batasnya
> **{B2}** — pengajuan tetap ditempuh sebagai **Akreditasi Ulang** dengan tiga nomor terbitan
> terakhir, bukan sebagai akreditasi baru.
> Tetap terbitkan nomor sesuai jadwal. Nomor yang seharusnya terbit selama masa tidak
> terakreditasi akan tetap berstatus tidak terakreditasi walaupun penerbitannya ditunda,
> sedangkan menunda terbitan justru melemahkan keberkalaan yang akan dinilai.

---

**Keadaan E — SK berakhir lebih dari dua tahun** (hari ini > `{B2}`)

> Masa berlaku akreditasi jurnal ini berakhir pada **{E}**, berdasarkan SK **{SK}**, lebih dari
> dua tahun lalu. Jalur Akreditasi Ulang dengan tiga nomor terbitan terakhir sudah tertutup;
> pengajuan berikutnya ditempuh sebagai **Akreditasi Baru**, dengan persyaratan dan penilaian
> dari awal.
> Sebelum data ini dipakai untuk mengambil keputusan, cocokkan dulu dengan sertifikat yang Anda
> pegang. Jarak sejauh ini sering berarti catatan DJPI tertinggal, bukan jurnalnya yang lama
> tidak terakreditasi. Bila tanggal di atas keliru, perbaiki di kolom berikut.

---

**Keadaan F — data tidak ada atau tidak terverifikasi**

Dipakai bila: tanggal berakhir kosong; atau tanggalnya hanya berupa tahun; atau nomor SK kosong;
atau nomor SK menyebut masa berlaku yang berbeda dari tanggal di direktori.
**Tidak ada angka bulan yang ditampilkan dalam keadaan ini.**

> Catatan DJPI belum memuat tanggal berakhirnya akreditasi jurnal ini secara pasti.
> {Varian 1 — hanya tahun:} Yang tercatat baru tahunnya, **{tahun}**, tanpa tanggal.
> {Varian 2 — SK tidak cocok:} Yang tercatat adalah **{E}** berdasarkan SK **{SK}**, tetapi
> keduanya belum cocok satu sama lain.
> {Varian 3 — kosong:} Belum ada tanggal maupun nomor SK yang tercatat.
>
> Karena itu hitung mundur tenggat pengajuan belum bisa ditampilkan. Sertifikat akreditasi yang
> Anda pegang adalah sumber yang paling tepercaya: isikan tanggal berakhirnya pada kolom
> berikut. Setelah terisi, tenggat pengajuan enam bulan sebelum tanggal itu akan muncul di sini.

---

## 5. YANG TIDAK DIKERJAKAN, DAN ALASANNYA

| Tidak dikerjakan | Alasan |
|---|---|
| **Email pengingat ke pengelola** | User tidak memintanya; ruang lingkupnya tampilan di dalam aplikasi. Infrastrukturnya pun sudah ada untuk hal lain (`kirimPengingatTerbitan`, `Code.js:2598`) sehingga tidak ada yang hilang dengan menundanya |
| **Pemicu terjadwal (time-based trigger)** | Pengingat ini dihitung saat halaman dibuka. Tidak ada yang perlu berjalan saat tidak ada orang melihat |
| **Sheet atau kolom baru** | Semua data sudah ada: `TANGGAL EXPIRED`, `MASA BERLAKU SK AKREDITASI`, `Nomor SK` (kolom AH), plus koreksi pengelola di sheet `Persiapan_Akreditasi` |
| **Mengubah `bacaTanggalLonggar_`** | G5: memperbaiki 68 ekspor Amerika akan merusak entri `dd/mm/yyyy` yang justru dianjurkan sistem sendiri (`Code.js:7050`). Yang rusak adalah isi sel, bukan pembacanya |
| **Mengubah `parseKedaluwarsaSk_` / `AKR_BUCKET`** | Keduanya menyetir tab Akreditasi admin yang sudah tayang (`Dashboard.html:495–604`). Mengubahnya demi satu blok teks pengelola adalah menukar risiko regresi dengan kenyamanan kosmetik |
| **Fallback 31 Desember (§0.4)** | Hanya menyentuh 3 baris pada data sekarang, dan sudah tertutup keadaan F yang menolak menampilkan hitungan bulan untuk sumber bertahun. Memperbaikinya berarti menyentuh `parseKedaluwarsaSk_` — lihat baris di atas |
| **Perbaikan `new Date('yyyy-mm-dd')` UTC** | §0.5: benar secara mekanis, tapi tidak menghasilkan tanggal yang salah di WIB. Memperbaikinya sekarang adalah perubahan tanpa perbedaan yang terlihat |
| **Menampilkan nilai n / peringkat di pengingat** | Tidak diminta, dan angka ambangnya sendiri masih berselisih antara brief dan `Code.js:6272` (§0.7). Menyalin angka yang belum pasti ke layar pengelola adalah cara membuat orang salah menghitung |
| **Menyelaraskan label bucket admin dengan pengelola** | Diperbaiki hanya di sisi pengelola (Tahap 1.3) dengan menyebut anchor-nya. Menyentuh `Dashboard.html` menambah permukaan tanpa diminta |
| **Menyinkronkan koreksi tanggal pengelola kembali ke Sheet1** | Sudah teridentifikasi sebagai peluang di `Code.js:7011–7040`, tapi itu fitur alir data terpisah, bukan bagian dari menampilkan pengingat |
| **Memperbaiki 8 baris konflik SK vs tanggal (§0.6)** | Pekerjaan data, bukan kode. Keadaan F menanganinya secara jujur di layar sampai datanya dibereskan |

---

## 6. YANG BELUM TERVERIFIKASI

1. **Tipe sel `TANGGAL EXPIRED` di Sheet1** — Date atau teks. Menentukan apakah bug 13-jurnal
   nyata. Dijawab oleh `cekTanggalExpired()`.
2. **Apakah `sk-akreditasi/utama.csv` masih sama dengan Sheet1 hari ini.** Seluruh angka di
   §0.6 berasal dari snapshot itu.
3. **Klaim "direktori lebih baru daripada korpus SK (kasus WaPFi)"** — tidak terkonfirmasi;
   baris WaPFi di `cek-silang.json` justru cocok sempurna.
4. **Apakah tanggal-1 pada seluruh 68 nilai `M/1/YYYY` memang tanggal sebenarnya** atau sekadar
   isian default. Kalau default, tanggal harinya tetap tidak dapat dipercaya walaupun bulannya
   sudah benar — keadaan F mungkin perlu cakupan lebih luas.
