# Rencana Pelengkapan Data Akreditasi — 4 Staf

Revisi 2, setelah digrill. Draf pertama punya tiga anggapan yang ternyata keliru; bagian
"Yang berubah setelah grill" di bawah menjelaskan mana saja.

Dua data yang hilang menahan dua jalur:

| Jalur | Data yang hilang | Tanpa itu |
|---|---|---|
| Reakreditasi (110 jurnal) | kapan tepatnya masa akreditasi berakhir | tenggat 6 bulan tidak terhitung, peringatan tidak pernah muncul |
| Akreditasi baru (63 jurnal) | apakah sudah terbit 3 tahun berturut-turut | tidak tahu jurnal mana yang sudah boleh diajukan |

---

## Yang berubah setelah grill

**1. SK tidak memuat bulan. SK memuat nomor volume.** Diktum kedua Kepdirjen berbunyi
*"berlaku selama 5 tahun mulai Volume, Nomor dan Tahun Terbitan sampai Volume, Nomor dan Tahun
terbitan"*, dan lampirannya menulis misalnya *"mulai Volume 1 Nomor 3 Tahun 2021 sampai Volume 6
Nomor 2 Tahun 2026"*. Tidak ada tanggal di sana. Draf pertama menyuruh empat orang mencari
sesuatu yang tidak ada di dokumennya.

**2. Portal ISSN tidak menampilkan tanggal registrasi untuk pengguna gratis.** Catatan bebasnya
hanya memuat judul, ISSN, negara, dan *last modified*. Tugas B versi draf pertama tidak bisa
dijalankan.

**3. Jangkarnya adalah volume akhir, bukan tanggal SK.** Contoh nyata: sebuah jurnal ber-SK
tanggal 15 Oktober 2024 dengan masa berlaku sampai Vol 6 No 6 Tahun 2026. Menghitung dari
tanggal SK memberi Oktober 2029 — meleset **35 bulan**. Karena `AKR_BUCKET` menandai "kritis"
di 3 bulan, kesalahan sebesar itu membuat peringatan menyala setelah akreditasinya hilang.

Satu hipotesis saya terbantah, dan itu kabar baik untuk kejelasan: **halaman profil SINTA tidak
menampilkan masa berlaku** — hanya peringkat dan riwayat tahun. Jadi Tugas A memang pekerjaan
nyata, bukan pencarian yang bisa dilewati.

Catatan kejujuran: temuan tentang SK, Portal ISSN, dan SINTA berasal dari penelusuran agen ke
sumber luar, lengkap dengan tautannya. Saya memverifikasi seluruh klaim yang menyangkut kode
kita sendiri, tetapi tidak bisa membuka situs-situs itu dari sini. Mohon dicek sekilas oleh staf
di menit pertama sebelum seluruh rencana digantungkan padanya.

---

## Langkah 0 — sebelum siapa pun ditugaskan (Anda, ~1 jam)

**0a. Jalankan `angkaPersiapanData()`** dari editor Apps Script. Sudah di HEAD. Ia melaporkan
berapa yang perlu dikerjakan, pecahannya per peringkat, dan sekarang juga:

**Baris gratis.** Menu Persiapan Akreditasi selama ini meminta pengelola mengoreksi tanggal SK
dan menyimpannya ke sheet `Persiapan_Akreditasi`. Koreksi itu tidak pernah mengalir balik ke
Sheet1. Pengelola memegang sertifikatnya, jadi jawaban mereka lebih tepercaya daripada direktori.
Fungsi ini mendaftar mana yang **gratis** (Sheet1 kosong, pengelola sudah isi) dan mana yang
**beda** (keduanya isi tapi tidak sama). Pakai yang gratis lebih dulu; tidak perlu dicari.

**0b. Unduh dan urai SK yang tersedia.** Ada arsip publik berpola
`ejournal.undip.ac.id/public/fileAccrDecree/{TAHUN}-{PERIODE}-Elektronik.pdf`. Menurut grill, 11
berkas menyala untuk 2019 I–IV, 2022 I–IV, 2023 I–II, dan 2024 I, dan isinya teks sungguhan —
bukan pindaian. Satu SK memuat seluruh peringkat sekaligus.

Uraikan dengan skrip, **cocokkan lewat e-ISSN, bukan nama jurnal.** Lampiran SK memuat kolom
EISSN, dan Sheet1 punya `eIssn` yang sudah divalidasi. Mencocokkan 8 digit menghilangkan seluruh
kelas kesalahan nama yang sudah tercatat di proyek ini. Pola yang diurai:
`mulai Volume (\d+) Nomor (\d+) Tahun (\d{4}) sampai Volume (\d+) Nomor (\d+) Tahun (\d{4})`.

**0c. Kirim satu surel ke seluruh pengelola.** SK mewajibkan tiap jurnal terakreditasi memajang
tanggal penetapan dan tanggal akhir masa berlakunya di lamannya sendiri. Minta tangkapan layar
sertifikat atau tautan halaman akreditasinya. Berjalan paralel, biayanya nol, dan bisa menutup
puluhan baris sebelum staf menyentuhnya.

**Setelah 0a–0c, barulah sisa pekerjaannya diketahui.** Itu yang dibagi, bukan 110 baris.

---

## Aturan yang dibekukan sebelum orang mengisi

**Jangkar.** Masa berlaku berakhir pada **terbitan volume/nomor/tahun akhir yang tercantum di
lampiran SK**. Tanggal SK dicatat hanya sebagai jejak dan tidak pernah dipakai menghitung
kedaluwarsa. Ini menutup `[PERLU KEPUTUSAN]` draf pertama.

**Yang dicatat staf bukan tanggal.** Staf mencatat apa yang benar-benar tertulis:

`Nama Jurnal · e-ISSN · Nomor SK · Tanggal SK · Vol Mulai · No Mulai · Tahun Mulai ·
Vol Akhir · No Akhir · Tahun Akhir · Tautan Sumber · Status Pencarian · Diisi Oleh · Tanggal Isi`

**Tanggalnya diturunkan skrip, bukan diketik.** `issuePerTahun_()` sudah ada di `Code.js:5603`
dan memetakan frekuensi terbit ke jumlah nomor per tahun. Bulan ≈ `12 × NoAkhir ÷ nomorPerTahun`,
dibulatkan ke tanggal 1. Kalau frekuensinya tidak terbaca, jatuh ke `YYYY-12-31` dan barisnya
ditandai `perkiraan`. Cara ini bisa diaudit dan dijalankan ulang; 110 bulan hasil ketikan tangan
tidak.

**Kolom `Status Pencarian` wajib terisi** dengan salah satu: `ketemu`, `tidak-ketemu`,
`sudah-lewat`, atau `konflik`. Baris kosong dihitung cacat, bukan "belum sempat".

---

## Tugas A — masa berlaku (sisa setelah Langkah 0)

Hanya untuk jurnal yang tidak terselesaikan oleh 0a–0c. Sumber SK yang tidak ada di arsip UNDIP
(2020, 2021, 2023 III–IV, dan 2024 II ke atas) dicari di cermin lain: situs LLDikti, laman
pengumuman ARJUNA, atau LPPM kampus lain yang menerbitkan ulang.

**Batasi waktu per baris.** Lewat 15 menit untuk satu jurnal, tandai `tidak-ketemu` dan lanjut.
Tanpa batas ini, satu orang akan menghabiskan sehari untuk tiga jurnal.

---

## Tugas B — kelayakan 63 jurnal

**Bukan usia e-ISSN.** Syarat `s2b` berbunyi *"terbit sekurang-kurangnya 3 tahun berturut-turut,
dihitung mundur dari tanggal pengajuan"*. Usia e-ISSN tidak menjawab **berturut-turut** maupun
**dihitung mundur dari pengajuan**. Jurnal ber-e-ISSN 2019 yang bolong di 2022 tetap gagal.

**Baca arsip OJS-nya.** Semua jurnal ada di satu instalasi:
`ejournal.upi.edu/index.php/<KODE>/issue/archive`. Satu halaman memperlihatkan seluruh terbitan
beserta volume, nomor, dan tahunnya. Menurut grill: 60–90 detik per jurnal, dan langsung
menjawab syarat yang sebenarnya — lebih cepat **sekaligus** lebih tepat daripada Portal ISSN.

Yang dicatat: `Tahun Terbitan Pertama · Tahun Terbitan Terakhir · Ada Tahun Bolong (ya/tidak +
daftar tahunnya) · Tautan Arsip`. e-ISSN dicatat hanya untuk jurnal yang di Sheet1 belum punya,
karena itu memang dibutuhkan syarat `s1` dan gratis diambil saat berkunjung.

Keluarannya berubah dari "usia e-ISSN" yang tak bisa ditindaklanjuti menjadi **antrean pengajuan
berperingkat**: mana yang sudah memenuhi syarat sekarang, mana yang kurang setahun lagi, dan mana
yang mati suri sehingga bukan kandidat sama sekali.

---

## Hari pertama: satu jam, bukan seluruh beban

| Jam | Siapa | Apa |
|---|---|---|
| 08.00 | Anda | Langkah 0a, umumkan angkanya |
| 08.30 | Anda | Langkah 0b dan 0c — sekarang sisa pekerjaannya diketahui |
| 08.30 | 4 staf | Uji coba berwaktu: masing-masing **10 baris**, dicatat menit per barisnya dan tiap keraguan yang muncul |
| 10.30 | semua | Tinjau 30 menit. Median menit × sisa baris = kalender sebenarnya. Bekukan aturan dari keraguan yang muncul |
| 11.00 | — | Baru beban kerja dibagi |

Perkiraan kasar dari grill, untuk dicek dengan uji coba: Tugas B sekitar 60–80 baris per orang
per hari, sehingga 63 jurnal kemungkinan **satu orang satu hari**. Tugas A sisa 20–30 baris per
orang per hari karena ragamnya besar.

Kalau uraian SK menyelesaikan 70 dari 110, seluruh pekerjaan ini sekitar dua hari untuk dua
orang, bukan seminggu untuk empat. Staf yang bebas dipindahkan ke Tugas B, yang sekalian
menjawab apakah 63 jurnal itu memang masih hidup.

---

## Pemeriksaan — sistematis, bukan uji petik 10%

Uji petik acak mencari kesalahan acak. Kesalahan yang mengancam data ini semuanya **sistematis**,
dan sampel 10% hanya akan mengulang kesalahannya sembilan kali.

- **Masa berlaku:** `Tahun Akhir − Tahun Mulai` harus 4 atau 5. Nilai lain berarti salah baca.
  Satu rumus, menangkap seluruh kesalahan rentang.
- **Peringkat:** peringkat di SK harus sama dengan `peringkatSinta` di Sheet1. Beda berarti salah
  jurnal atau Sheet1 kedaluwarsa — dua-duanya perlu diketahui.
- **Kunci gabung e-ISSN, bukan nama.** Menghapus seluruh kelas kesalahan nama secara struktural.
  Baris tanpa e-ISSN sah diperiksa 100%.
- **Urutan masuk akal:** volume akhir > volume mulai; tahun SK ≥ tahun terbitan mulai.
- **Kelengkapan, bukan sampel:** seluruh 110 harus berakhir di salah satu status. Kosong itu
  cacat. Uji petik tidak akan pernah menemukan baris yang terlewat.
- **Entri ganda hanya untuk sisa.** Sisa itu kecil dan justru bagian paling rawan. Dua orang
  mencatat `Tahun Akhir` dan `No Akhir` secara terpisah, rumus menandai bedanya.

Aturan draf pertama yang tetap dipakai: **tiap baris wajib punya tautan sumber; baris tanpa
sumber dihitung belum dikerjakan.**

---

## Memindahkan ke Sheet1

Tetap dikumpulkan di lembar terpisah, dipindahkan sekali jalan. Yang perlu ditambahkan:

1. **Format kolom dulu, baru tempel.** Jadikan kolom `TANGGAL EXPIRED` di Sheet1 berformat teks
   **sebelum** menempel, lalu tempel dengan Ctrl+Shift+V (nilai saja). Sheets meng-coerce string
   tanggal memakai zona waktu spreadsheet sementara pembacaan memakai `Asia/Jakarta`.
   `setNumberFormat('@')` di `Code.js:6464` hanya melindungi sheet `Persiapan_Akreditasi`, bukan
   Sheet1. Sekalian pastikan zona spreadsheet-nya `Asia/Jakarta` — belum pernah dicek.
2. **Ambil snapshot versi** lewat File → Version history sebelum menempel, supaya batalnya satu
   klik.
3. **Tempel di luar jam kerja.** Sheet1 dibaca aplikasi tiap permintaan.
4. **Skrip yang melaporkan baris tak cocok**, bukan manusia yang mencentang "sudah cocok".
5. **Jalankan `angkaPersiapanData()` lagi.** Angka "perlu dikerjakan" harus turun persis sebanyak
   baris yang diisi, dan sebaran tahun kedaluwarsanya harus masuk akal. Lonjakan di satu tahun
   berarti ada kesalahan jangkar yang lolos hitungan.

---

## Yang belum ditangani dan perlu keputusan Anda

- **Jurnal yang SK-nya sudah lewat.** Butuh antrean berbeda: itu pengajuan **baru**, bukan
  reakreditasi. Masa tunggunya pun berbeda tergantung sebab kehilangannya.
- **Izin akses.** Empat staf butuh hak Editor di lembar pengumpulan. Di Workspace berpembatasan
  ini bisa makan sehari tiket IT. Siapkan malam ini. Dan tetapkan sekarang: **staf tidak diberi
  akses Sheet1**, karena dibaca aplikasi secara langsung.
- **Kalau baris `beda` di Langkah 0a banyak:** mana yang menang, Sheet1 atau koreksi pengelola?
  Saya condong ke pengelola, karena merekalah yang memegang sertifikatnya — tetapi ini keputusan
  Anda, dan harus diputuskan sebelum penggabungan.
