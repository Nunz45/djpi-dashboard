# Audit Menu Persiapan Akreditasi (sisi Pengelola)

Tanggal: 6 September 2026. Cakupan: panel `menuAktif === 'akreditasi'` di `Pengelola.html`
dan seksi 28–29 `Code.js`. Metode: dua agen audit independen, lalu setiap temuan berkonsekuensi
saya periksa ulang langsung ke kode. Temuan yang tidak lolos pemeriksaan itu tidak masuk dokumen
ini; yang belum bisa saya buktikan diberi tanda **[belum terbukti]**.

---

## Status pengerjaan (6 September 2026)

Seluruh sepuluh butir di bagian G sudah dikerjakan. Rinciannya:

| # | Butir | Status |
|---|---|---|
| 1 | Reset panel antar-sesi + tolak nama jurnal yang tidak cocok di server | Selesai |
| 2 | Salinan lokal, sesi berakhir non-destruktif, simpan otomatis memeriksa `res.code` | Selesai |
| 3 | Deteksi konflik lewat cap waktu, plus `setNumberFormat('@')` pada kolom tanggal | Selesai |
| 4 | Level 0 untuk B.3 dan E.2 | Selesai |
| 5 | Kalkulator ambang peringkat | Selesai |
| 6 | Prefill E.1 berhenti meninggikan; penanda tidak lagi menyalahkan pengelola | Selesai |
| 7 | `cocokJurnal_` jadi pencocokan tepat; `cekPraAsesmen` mendeteksi kecocokan ganda | Selesai |
| 8 | Butir "perlu dicek" ikut ditampilkan dan tercetak | Selesai |
| 9 | Daftar kerja memuat Mutu Artikel dan diurutkan menurut selisih poin | Selesai |
| 10 | Lembar cetak menggantikan `window.print()` telanjang | Selesai |

Tiga hal yang ditemukan saat mengerjakan, di luar daftar audit:

- `@click="simpanPersiapanAkr"` mengirim objek `Event` sebagai argumen pertama. Begitu fungsi itu
  diberi parameter `paksa`, `Event` akan terbaca sebagai permintaan menimpa dan deteksi konflik
  terlewat tanpa ada yang memintanya. Ditutup di dua sisi: pemanggilan diubah jadi
  `simpanPersiapanAkr()` dan perbandingannya `paksa === true`.
- Cap waktu simpan ditulis ke sheet dengan detik tetapi dikirim ke klien tanpa detik. Perbandingan
  versi apa adanya akan menganggap setiap simpan sebagai konflik; disamakan ke menit lewat
  `capAkrNorm_`.
- Aturan cetak yang menyembunyikan `.card` secara umum membuat panel lain tercetak sebagai halaman
  kosong. Dipersempit ke kelas `layar-saja` pada empat spanduk milik panel akreditasi.

Yang **tidak** dikerjakan, dan alasannya:

- Kandidat hapus (langkah 3 jadi panel lipat, 16 centang biner Mutu Artikel, kolom persen, kode
  mati) belum disentuh. Semuanya mengubah bentuk data tersimpan atau alur enam langkah, jadi
  layak diputuskan terpisah.
- `cekAksesAdmin_()` masih perlu dijalankan dari editor Apps Script.

---

## Ringkasan

Menu ini kuat sebagai rubrik yang bisa dibaca dan dicari: teks 14 unsur Tata Kelola, 16 klausul
COPE, dan 16 butir Mutu Artikel lengkap, akurat, berbahasa Indonesia jelas, termasuk catatan
larangan yang di juknis terselip. Itu nilai nyata dan tidak ada duanya di UPI sekarang.

Sebagai alat persiapan, ia belum menjawab pertanyaan yang paling dibutuhkan pengelola, dan
menyimpan tiga cacat yang bisa merusak data.

---

## A. Cacat yang merusak data

### A1. Jawaban satu jurnal bisa tertulis ke baris jurnal lain

`keluar()` (`Pengelola.html:1657-1676`) mereset `token`, `namaJurnalAktif`, `tahap`, `emailInput`,
`pin`, `tokenPilih`, `daftarJurnalPilihan` — **tidak** mereset `persiapanAkr`, dan tidak ada blok
`watch:` di seluruh berkas (0 hasil grep). `bukaMenu` (`Pengelola.html:1704`) memuat ulang hanya
bila `!this.persiapanAkr.dimuat`, sedangkan `dimuat` masih `true`.

Alur yang memicu: pengelola dua jurnal → masuk jurnal A → buka Akreditasi → keluar → masuk jurnal B
→ buka Akreditasi → yang tampil jawaban A. Sentuhan apa pun memicu simpan otomatis, yang mengirim
jawaban A dengan token B; server menulis ke baris B (`Code.js:6375`). Isian jurnal B tertimpa tanpa
peringatan dan tanpa riwayat versi untuk memulihkannya.

### A2. Sesi berakhir membuang seluruh isian

`simpanPersiapanAkr` menangani `code === 'SESSION_EXPIRED'` dengan memanggil `this.keluar()`
(`Pengelola.html:2292-2296`) — layar kembali ke login, tidak satu byte pun tersimpan, tidak ada
pesan bahwa isian sedang dibuang. Simpan otomatis lebih buruk: ia **tidak memeriksa `res.code`**
sama sekali, hanya menaruh kalimat abu-abu di baris status, sehingga bisa gagal diam-diam berkali
lipat selama sesi sudah mati. Tidak ada `beforeunload` (0 hasil grep) dan tidak ada penyalinan ke
`localStorage`, jadi 3 detik terakhir sebelum debounce selalu berisiko hilang.

### A3. Penulisan penuh-baris tanpa deteksi konflik

`Code.js:6375-6376` menulis seluruh 8 kolom dari state klien. `LockService` menyerialkan penulisan,
tidak mendeteksi konflik: tidak ada versi, etag, atau perbandingan `Terakhir Disimpan`. Dua tab, atau
admin mode atas nama yang menyimpan bersamaan, saling menimpa habis.

Dua cacat kecil di baris yang sama: kolom B "Email Pengelola" diisi `pelakuEdit_(muatan)`
(`Code.js:6371`), yang di mode atas nama mengembalikan kalimat `"admin@… (atas nama pengelola@…)"`
— setelah admin sekali menyimpan, kolom itu bukan email lagi. Dan batas 45.000 karakter
(`Code.js:6364-6366`) menolak seluruh simpanan tanpa menyebut field mana, sementara 23 input bukti
tidak punya satu pun `maxlength`.

---

## B. Formulir yang tidak bisa diselesaikan secara jujur

**B.3 dan E.2 tidak punya level 0.** `Code.js:5911-5918` memberi B.3 level 5, 3, 2, 1;
`Code.js:5989-5997` memberi E.2 level 6, 4, 3, 2, 1. Jurnal yang seluruh editornya dari satu
institusi, atau yang belum terindeks di mana pun, tidak punya opsi yang bisa dipilih. Akibatnya
berantai: `akrUnsurDinilai` tidak akan pernah 14, tanda ✓ langkah 4 tidak pernah tercapai, dan
daftar perbaikan menuduh mereka "belum diisi" selamanya.

**Kosong dihitung nol.** `akrTotalTataKelola` (`Pengelola.html:1501-1511`) menjumlahkan
`Number('') = 0`, jadi formulir yang belum disentuh dan formulir yang jujur bernilai nol
menghasilkan bilah progres yang sama.

**Langkah 3 bertanda `selesai: false` permanen** (`Pengelola.html:1483`) — jejak stepper tidak akan
pernah hijau seluruhnya. **Langkah 6 bertanda selesai** begitu simpan otomatis pertama jalan, jauh
sebelum ada tinjauan.

**`akrCopeTerpenuhi`** menghitung seluruh kunci objek `cope`, bukan hanya 16 kunci rubrik, sehingga
kunci sisa rubrik lama ikut mendorong persentase C.4 di atas kenyataan.

---

## C. Prefill yang menyalahkan pengelola

`akrTanda` membandingkan nilai sekarang dengan `asal` dan menampilkan badge "Diubah pengelola" bila
berbeda. E.1 diprefill dari jumlah sitasi Crossref/OpenAlex (`Code.js:6215-6228`) yang naik tiap
bulan. Begitu sitasi melewati ambang berikutnya, `asal['E.1']` bergerak sementara jawaban tersimpan
tetap — badge muncul pada field yang tidak pernah disentuh siapa pun.

Prefill E.1 itu sendiri meninggikan: ia menghitung sitasi **sepanjang waktu**, sedangkan rubrik
meminta 3 tahun terakhir. Kode mengakuinya sendiri di komentar, lalu tetap mengisi levelnya.
Peringatannya hanya kalimat abu-abu, dan prefill yang sudah terisi hampir tidak pernah diturunkan
orang.

Status `'verifikasi'` pada s3 tidak menahan apa pun: tetap diprefill `'ya'` dan dihitung penuh
oleh gerbang "9 dari 9 syarat terpenuhi", baik di klien maupun server.

---

## D. Tahap 3.2 — bagian bernilai 54 poin

**22 dari 96 butir pra-asesmen disembunyikan secara bawaan.** `butirTampil`
(`Pengelola.html:2315-2318`) hanya merender status `'perlu perbaikan'`. Di TSV nyata: 44 perlu
perbaikan, 30 baik, 10 perlu dicek, 12 di luar jangkauan. Butir "perlu dicek" — yang justru menuntut
pemeriksaan manusia — tidak terlihat sampai pengelola menemukan sendiri kotak centangnya. Kotak itu
juga satu untuk semua artikel, dan aturan cetak menyembunyikannya.

**Untuk 101 jurnal tanpa data**, langkah 5 menyusut jadi 16 kotak centang biner yang menghasilkan
lencana "16 dari 16 sudah diperiksa" tanpa memuat satu pun temuan. Di halaman tinjauan, baris
"Belum ada artikel yang diperiksa" memakai kelas merah yang sama dengan syarat gagal — 101 pengelola
melihat defisit merah atas antrean kerja DJPI yang tidak bisa mereka tindaklanjuti.

**`cocokJurnal_` bocor, dan diagnostiknya buta.** Pencocokan `indexOf` dua arah membuat bentuk
pendek mewarisi temuan jurnal lain: `"Curricula"` → `"Curricula: Journal of Curriculum Development"`,
`"Passage"` → `"Passage: Journal of English Language and Literature"`,
`"Indonesian Journal of Science"` → `"Indonesian Journal of Science and Technology"`. Ketiganya
persis kunci yang dipakai `mutu-artikel/peta_jurnal.json`. `cekPraAsesmen` memakai
`jurnal.some(cocokJurnal_)`, jadi satu baris yang cocok ke tiga jurnal tetap dilaporkan "OK".

---

## E. Cetak

`cetakPersiapanAkr` adalah `window.print()` telanjang. Aturan print membuka keenam langkah dengan
benar, tetapi hasilnya belum bisa dipakai sebagai lampiran:

- Jawaban Tahap 1 ditandai hanya lewat warna latar tombol, dan level Tata Kelola terpilih hanya
  lewat `border-color` + `background`. Chrome mematikan background graphics secara bawaan, sehingga
  cetakan menampilkan "Ya / Belum" berdampingan tanpa penanda mana yang dipilih. `Persiapan
  akreditasi.pdf` di repositori adalah bukti keluaran ini.
- 22 butir pra-asesmen yang tersaring di level DOM tidak bisa dicetak sama sekali.
- Tidak ada cap waktu, tanggal cetak, atau identitas pencetak.
- Seluruh Tahap 2 baca-saja dan 16 paragraf rubrik Mutu Artikel ikut tercetak, sehingga jawaban
  pengelola tenggelam di antara salinan rubrik.

---

## F. Kebermanfaatan untuk persiapan akreditasi

Yang paling dibutuhkan justru yang paling tidak tersedia:

| Kebutuhan | Tersedia? |
|---|---|
| Perkiraan nilai akhir & peringkat | Tidak. Hanya Tata Kelola `/46` |
| Daftar kerja diurutkan menurut selisih poin | Tidak diurutkan, dan Mutu Artikel tidak masuk |
| Verifikasi klaim | Tidak ada. 13 dari 14 unsur murni klaim |
| Daftar dokumen & terbitan untuk diunggah ke ARJUNA | Tidak ada |
| Ekspor jawaban | Ada, tapi tidak merekam jawaban (lihat E) |
| Riwayat & pembagian tugas redaksi | Tidak ada. Satu baris, ditimpa tiap simpan |
| Teks rubrik resmi yang bisa dibaca | **Ada, dan ini kekuatan terbesarnya** |

### Soal menolak menyekor Mutu Artikel

Kode menolak mengonversi Tahap 3.2 ke nilai, dengan alasan 54 poin itu dinilai asesor lewat sampel
artikel. Alasannya benar. Tetapi akibatnya alat ini menghitung 46 poin lalu diam soal 54 poin yang
lebih besar, dan ARJUNA sendiri mewajibkan pengelola mengisi borang evaluasi diri numerik. Menolak
memberi angka tidak menghilangkan tebakan, hanya memindahkannya ke luar sistem.

Ada angka yang tidak perlu ditebak sama sekali. Kalau Tata Kelola 35,9 dari 46, maka Peringkat 2
(≥80) menuntut ≥44,1 dari 54 Mutu Artikel; Peringkat 3 (≥70) menuntut ≥34,1. Itu pengurangan, bukan
ramalan — dan justru pertanyaan yang membuat pengelola berhenti bertanya "berapa nilai saya" dan
mulai bertanya "apakah 44 dari 54 realistis untuk artikel saya?"

Bahan untuk menghitungnya sudah dikirim server dan menganggur: `rubrik.peringkat`
(`Code.js:6121-6123`) memuat ambang Peringkat 1–4, dan kata "peringkat" tidak muncul sekali pun di
`Pengelola.html` (0 hasil grep).

Sebaliknya, angka yang ditampilkan sekarang berisiko salah baca: "Kesiapan Tata Kelola 85%" berada
di rentang yang identik dengan skala nilai akreditasi 0–100, padahal 85% × 46 = 39,1 dari 100.

---

## G. Urutan pengerjaan yang saya usulkan

**Mendesak — data bisa rusak hari ini**

1. Reset `persiapanAkr` di `keluar()` dan `simpanSesi()`; sertakan `namaJurnal` di payload dan tolak
   di server bila tidak cocok (A1)
2. Salin isian ke `localStorage` tiap penjadwalan simpan; ganti `keluar()` pada SESSION_EXPIRED
   dengan spanduk non-destruktif; periksa `res.code` di simpan otomatis (A2)
3. Deteksi konflik lewat `terakhirDisimpan` yang dipegang klien (A3)

**Penting — angka dan klaim**

4. Tambah level 0 pada B.3 dan E.2; bedakan "kosong" dari "nol" (B)
5. Kalkulator ambang: Tata Kelola `x/46` mentah + nilai Mutu minimum per peringkat, memakai
   `rubrik.peringkat` yang sudah tersedia (F)
6. Perbaiki prefill E.1 agar memakai jendela 3 tahun, dan badge `akrTanda` agar tidak menyalahkan
   pengelola atas pergerakan data DJPI (C)
7. Perbaiki `cocokJurnal_` jadi pencocokan tepat lewat `peta_jurnal.json`, dan perbaiki
   `cekPraAsesmen` agar mendeteksi kecocokan ganda (D)

**Berguna**

8. Tampilkan keempat status pra-asesmen, bukan hanya "perlu perbaikan" (D)
9. Masukkan Mutu Artikel dan `tglBerakhirSk` kosong ke daftar perbaikan, urutkan menurut selisih
   poin (B, F)
10. Halaman ekspor yang memuat jawaban terpilih, bukti, dan daftar dokumen ARJUNA — menggantikan
    `window.print()` telanjang (E)

**Kandidat dihapus**

- Langkah 3 (Tahap 2 baca saja) jadi panel lipat di langkah 2 — sekarang memakan satu dari enam
  langkah dan tidak pernah bisa hijau
- 16 kotak centang biner Mutu Artikel, diganti catatan temuan
- Kolom `Kesiapan Tata Kelola (%)` sebagai persen; simpan `x/46` mentah
- Kode mati: `tersimpan.kesiapan`/`tersimpan.gerbang` yang dikirim tapi tidak dibaca,
  `artikel[].baik`/`perluDicek`/`tanggal` yang dihitung tapi tidak dirender, CSS `.akr-ringkas`
  tanpa elemen, `bersihkanCachePraAsesmen_` yang tidak pernah dipanggil

---

## Belum terbukti

- **Tanggal SK mundur satu hari per siklus simpan-muat.** `Code.js:6371` menulis string tanggal
  lewat `setValues`; Sheets meng-coerce memakai zona waktu spreadsheet, sedangkan pembacaan memakai
  `Asia/Jakarta`. Tidak ada `setNumberFormat('@')` di seluruh `Code.js`. Zona spreadsheet tidak
  dikunci di mana pun, jadi cacat ini nyata bila zonanya berbeda — saya belum bisa memeriksa
  setelan spreadsheetnya dari sini. Perbaikannya murah dan aman dilakukan tanpa menunggu bukti:
  pasang `setNumberFormat('@')` pada kolom D.
