# Rencana: Tanggal Kedaluwarsa di Menu Pengelola & Pengingat Akreditasi di Admin

Revisi 2, setelah grill. **Belum dikerjakan.**

## Pencabutan

Revisi 1 menyebut "39 jurnal sudah lewat" dan "26 tenggat enam bulannya terlampaui". **Kedua
angka itu salah**, dan salahnya justru karena bug yang revisi 1 tandai sendiri sebagai risiko
nomor nol lalu tetap dipakai untuk menghitung.

Nilai `TANGGAL EXPIRED` berbentuk `M/1/YYYY`. `bacaTanggalLonggar_` mengurai teks berpola itu
sebagai hari/bulan/tahun, sehingga tiap tanggal jatuh ke **Januari tahun yang sama** — selalu
lebih awal daripada yang sebenarnya, jadi kesalahannya selalu ke arah menakut-nakuti.

Dihitung ulang atas 68 baris bertanggal, per 7 September 2026:

| | dibaca benar (bulan/tanggal) | dibaca kode sekarang (hari/bulan) |
|---|---|---|
| Sudah lewat | **26** | 39 |
| Kritis ≤ 3 bulan | **17** | 0 |
| Dekat ≤ 6 bulan | **3** | 26 |

**13 jurnal akan diberi tahu akreditasinya sudah habis padahal belum.**

Satu lagi yang keliru di revisi 1: saya menulis 43 baris bertahun-saja "tidak akan masuk
kalender mana pun". Salah. `parseKedaluwarsaSk_` jatuh ke `masaBerlakuSk` dan menempatkannya di
keranjang memakai **31 Desember**, sehingga sisa umurnya dilebihkan sampai 11 bulan dan
kebanyakan mendarat di keranjang aman. Mereka ada di kalender, di tanggal yang salah — dan itu
lebih berbahaya daripada tidak ada sama sekali.

---

## Langkah 1 — perbaiki kolomnya (tanpa UI sama sekali)

1. Jalankan `cekTanggalExpired()`.
2. Tulis ulang kolom ke `yyyy-mm-dd`, dan pasang `setNumberFormat('@')` supaya Sheets tidak
   meng-coerce ulang.
3. Tambahkan cadangan tahun untuk `tanggalExpired` di `parseKedaluwarsaSk_`: sel berisi `2026`
   saat ini dibuang begitu saja dan diam-diam jatuh ke `masaBerlakuSk`.

Ini memperbaiki 13 salah klasifikasi untuk **semua** yang sudah memakai data itu hari ini,
termasuk tab Akreditasi yang sudah tayang. Nol perubahan tampilan, nol risiko.

---

## Langkah 2 — daftar rekonsiliasi di tab Akreditasi admin

Baca-saja, tanpa email, tanpa ubah skema. Isinya baris yang **tidak boleh dikirimi apa pun**
sebelum diperiksa manusia:

- **7 baris** direktori tertinggal: SK terbarunya berakhir lebih lambat daripada tanggal yang
  tercatat
- **18 baris** SK terbarunya tidak punya rentang volume terbaca
- **12 baris** tidak ada SK yang cocok sama sekali
- **6 baris** menyebut `Nomor SK` di barisnya sendiri yang justru berlaku sampai **setelah**
  tanggal kedaluwarsanya — termasuk EDUTECH, TEKMULOGI, dan Jurnal Ilmu Manajemen dan Bisnis

Total sekitar **30 dari 114 (26%) tidak terverifikasi**. WaPFi adalah contoh nyatanya, dan
sudah terbukti sekali.

Ini deliverable yang sebenarnya membuka jalan bagi semua langkah berikutnya, dan pekerjaannya
kira-kira satu sore.

---

## Langkah 3 — satu perhitungan, dua pembaca

Cacat yang harus diperbaiki sebelum tampilan apa pun ditambah:

**Admin dan pengelola berselisih tepat enam bulan.** `akrTenggatUlang` menghitung bulan menuju
**tenggat pengajuan** (kedaluwarsa − 6). `selisihBulan_` dan `AKR_BUCKET` menghitung bulan
menuju **kedaluwarsa**. Keduanya ditulis "N bulan". Untuk jurnal yang sama, pengelola membaca
"sisa 1 bulan" sementara admin membaca "Kedaluwarsa dalam 7 bulan · Pantau kesiapannya".

**Label kartu admin justru terbalik urgensinya.** "Kedaluwarsa ≤ 6 bulan → Masuk perencanaan"
padahal tenggat pengajuannya sudah lewat; "≤ 12 bulan → Pantau kesiapannya" padahal itulah
kelompok yang harus mengajukan sekarang.

*Perbaikan:* satu field baru `bulanKeTenggat = bulanTersisa - 6` di `parseKedaluwarsaSk_`,
dibaca kedua sisi. Sekalian tiga cacat kecil di `akrTenggatUlang`: `getMonth() - 6` meluber
untuk tanggal akhir bulan (2026-08-31 jadi 2026-03-03), `new Date('2026-06-01')` diurai sebagai
UTC lalu dibaca lokal, dan halaman tinjauan tidak punya cabang `lewat` sehingga menampilkan
"sisa −4 bulan".

---

## Langkah 4 — email permintaan data (template pertama yang dikirim)

**44 jurnal tidak punya tanggal yang bisa dipakai** (43 bertahun-saja + PEDAGOGIA). Itu kelompok
terbesar, dan revisi 1 hanya menaruhnya sebagai catatan kaki.

Isinya bukan pengingat melainkan permintaan: *sebutkan nomor SK dan masa berlakunya*. Tidak
butuh gerbang verifikasi, paling kecil risikonya, dan jawabannya justru memperbaiki data yang
menjadi tumpuan seluruh template lain. **Kirim ini lebih dulu.**

---

## Langkah 5 — tampilan di menu pengelola

**A2 — keadaan `habis`.** Bagian penting bukan kalimatnya melainkan pergantian syarat: jurnal
yang SK-nya sudah berakhir mengajukan **akreditasi baru** (`s2b`, terbit tiga tahun
berturut-turut), bukan reakreditasi (`s2u`, tiga nomor terbitan terakhir).

**A3 — satu baris ringkas di kepala panel**, terlihat di langkah mana pun.

**A1 — pilihan yang dipaksa, bukan lencana.** Revisi 1 mengusulkan lencana "Data DJPI
diperbarui". Itu terlalu lemah untuk sesuatu yang akibatnya tenggat terlewat, tetapi menimpa
begitu saja juga salah: datanya sendiri keliru untuk 13 jurnal hari ini dan tak terverifikasi
untuk 30. Yang benar tiga bagian:

1. Tampilkan kedua nilai berdampingan dengan dua tombol: **Pakai tanggal DJPI** dan
   **Punya saya benar**.
2. Pilihan "punya saya benar" tercatat dan muncul di daftar rekonsiliasi Langkah 2. Ketidak-
   cocokan yang dilaporkan pengelola adalah umpan rekonsiliasi termurah yang bisa didapat.
3. Selama keduanya berbeda, baris tenggat di kepala panel menampilkan **kedua** tanggal dan
   menolak memilih. Tenggat yang salah tapi terlihat yakin lebih buruk daripada yang terlihat
   ragu.

---

## Langkah 6 — pengingat akreditasi di admin

**Tiga template, bukan dua:**

| Kelompok | Jumlah | Yang harus dilakukan |
|---|---|---|
| Tenggat masih terbuka (6–12 bulan) | 10 | ajukan reakreditasi sekarang |
| Tenggat tertutup, SK masih berlaku (0–6 bulan) | 19 | ajukan segera, siap-siap ada jeda |
| Sudah habis dan terverifikasi | ≤26 dikurangi yang tersaring gerbang | **akreditasi baru**, bukan reakreditasi |

Template keempat, permintaan data, sudah dikirim di Langkah 4.

**Gerbang sebelum satu email pun keluar.** Empat syarat harus lolos: tanggalnya sel Date atau
ISO; barisnya punya `Nomor SK` dan SK itu tidak berlaku melampaui tanggal kedaluwarsanya; tidak
ada SK yang lebih baru untuk e-ISSN itu; dan seorang manusia sudah menandai barisnya
terverifikasi. Yang gagal masuk daftar rekonsiliasi, bukan daftar kirim.

**Penanda sudah dikirim: pakai `PropertiesService`, bukan kolom baru.** Pengingat terbitan sudah
memecahkan ini tanpa menyentuh Sheet1 — `kunciPengingat_` menyimpan kunci ber-hash. Menambah
kolom ke Sheet1 berarti mengubah skema sheet yang dibaca lima skrip di `sk-akreditasi/` dan
bisa bergeser oleh satu tempelan manual. Catatan: kuncinya di-hash dari **nama jurnal** yang
dinormalkan, jadi jurnal yang berganti nama akan kehilangan penandanya.

**Endpoint** meniru `kirimPengingatTerbitan` apa adanya: admin saja lewat token `session_`,
batas 40 per pengiriman, jurnal yang ditolak **dilaporkan** bukan dilewatkan diam-diam, catat
per jurnal. Urutan penulisan penandanya harus dipertahankan persis: `setProperty` **setelah**
`sendEmail` berhasil, supaya kehabisan kuota di tengah jalan aman dilanjutkan tanpa kirim ganda.

**Variabel yang belum ada dan butuh kode baru:** `{{nomorSk}}` — `FIELD_MAP` tidak punya
entrinya, nol kemunculan di `Code.js`, sehingga `bacaDataJurnal_` tidak pernah
mengeluarkannya walaupun kolomnya terisi di sheet. `{{tenggatPengajuan}}` juga hanya ada di
klien; ia harus datang dari perhitungan bersama Langkah 3 atau emailnya akan bertentangan
dengan panel yang ditautkannya.

**Tautan, bukan token.** Jangan menanam token `edit_` di email massal. Tautkan ke URL Pengelola
dan minta masuk memakai alamat email itu; alur PIN yang ada sudah menangani sisanya sekaligus
mengautentikasi ulang penerimanya.

---

## Yang tidak diotomatiskan

Email massal **tidak** dipasang di pemicu harian. Mengotomatiskan kiriman massal yang datanya
26% tak terverifikasi mengubah kesalahan yang bisa diperbaiki menjadi kesalahan yang berulang.

Yang boleh diotomatiskan: **ringkasan mingguan untuk DJPI sendiri** — daftar jurnal yang masuk
jendela pengajuan dan baris yang SK-nya bertentangan dengan direktori. Infrastruktur sama, satu
penerima, nol radius ledakan.

---

## Hal kecil yang tetap perlu

- 3 jurnal terakreditasi kolom `Email`-nya kosong; ditolak dan dilaporkan, bukan dilewatkan.
- Dua alamat memegang dua jurnal sekaligus, jadi nama jurnal wajib ada di subjek.
- Pengelola perlu tahu dirinya sudah dikirimi pengingat; tampilkan dari kunci yang sama.
- Tetap teks polos. Dari domain institusi ke penerima institusi, itu paling terkirim dan paling
  mudah dibaca.
- Batas 6 menit eksekusi memutus balasan sebelum daftar hasil sampai ke admin; beri ID batch
  pada catatan aktivitas supaya jalan yang terpotong bisa disusun ulang.
