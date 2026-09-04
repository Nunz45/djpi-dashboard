# Pra-asesmen Tahap 3.2 — Mutu Artikel

Perkakas lokal untuk membaca artikel yang sudah terbit dan menyusun laporan gap terhadap
rubrik Tahap 3.2 (Mutu Artikel) pada Kepdirjen 374/2026. Jalan di laptop memakai Python,
bukan di Google Apps Script.

Keluarannya **temuan dan saran, tanpa level atau skor**. Penilaian resmi tetap dilakukan
asesor ARJUNA yang membaca sampel artikel. Fakta terhitung — jumlah rujukan, unsur galley
yang terdeteksi, persentase pustaka mutakhir — tetap ditampilkan karena itu bukti yang bisa
dicek ulang, bukan penilaian.

---

## 1. Cara kerjanya

Rubrik Tahap 3.2 memuat 16 butir: F.1–F.9 (substansi) dan G.1–G.7 (gaya penulisan dan
penyuntingan). Ketiganya ditangani dengan cara berbeda.

```
PDF_Terbit/*.pdf
      │
      ▼
ekstrak_artikel.py          membaca lapisan teks PDF dengan pymupdf
      │                     tanpa AI, hasilnya sama tiap kali dijalankan
      ▼
bukti/artikel_<kode>.json   identitas, galley, penulis, struktur, rujukan,
      │                     sitasi, instrumen, abstrak, teks per bagian
      │
      │   penilaian/artikel_<kode>.json   ← ditulis manusia setelah membaca artikel
      │            │
      ▼            ▼
susun_laporan.py            menggabungkan keduanya jadi 16 butir
      │
      ├──▶ laporan/<kode>-pra-asesmen.md        laporan per artikel
      ├──▶ laporan/00-ringkasan-lintas-artikel.md
      └──▶ laporan/Pra_Asesmen_Artikel.tsv      ditempel ke Google Sheet
                    │
                    ▼
            sheet Pra_Asesmen_Artikel
                    │
                    ▼
            menu Persiapan Akreditasi, langkah 5
```

### Kenapa dibagi dua lapis

Sebagian butir bisa dihitung dari teks dan hasilnya pasti: jumlah rujukan itu angka, ada
tidaknya pernyataan konflik kepentingan itu ada atau tidak. Butir semacam ini dikerjakan
ekstraktor supaya konsisten dan bisa diaudit.

Sebagian lagi menuntut pembacaan isi: apakah abstrak benar-benar memuat temuan, apakah
pendahuluan menyatakan kesenjangan riset. Tidak ada regex yang bisa menjawab itu. Butir
semacam ini ditulis manusia ke `penilaian/`, dan skrip hanya merangkainya.

---

## 2. Logika per butir

### Butir yang dihitung ekstraktor

| Butir | Yang dihitung | Kapan berstatus perlu perbaikan |
|---|---|---|
| **G.1** Kelengkapan galley | 9 unsur: judul sirahan, lisensi, hak cipta, 4 tanggal riwayat naskah, DOI, pernyataan AI, kontribusi penulis, pendanaan, konflik kepentingan | Ada unsur yang tidak terdeteksi. Rubrik menargetkan 8–9 dari 9. |
| **G.2** Nama & afiliasi | Per penulis: jumlah kata pada nama, nama belakang disingkat satu huruf, ada gelar. Lalu afiliasi memuat institusi dan negara, serta e-mail korespondensi | Ada nama satu kata, nama belakang disingkat, gelar tercantum, e-mail korespondensi tidak ada, atau afiliasi tanpa negara |
| **G.3** Sistematika | Heading yang terbaca dicocokkan ke pola IMRaD: pendahuluan, metode, hasil, simpulan, daftar pustaka | Tidak lengkap → **perlu dicek**, bukan perlu perbaikan, karena heading tidak baku sering lolos deteksi |
| **G.4** Instrumen pendukung | Caption tabel dan gambar dihitung, lalu dicocokkan dengan nomor yang diacu di badan teks | Ada caption yang tidak pernah diacu di teks. Nol instrumen → perlu dicek |
| **G.5** Pengacuan pustaka | Dua jalur, lihat di bawah | Ada kunci yatim → **perlu dicek** untuk nama-tahun, **perlu perbaikan** untuk bernomor |
| **F.7** Nisbah acuan primer | Jumlah entri daftar pustaka | Kurang dari 15 entri. Kalau cukup, statusnya **perlu dicek** karena proporsi acuan primer tidak terbaca otomatis |
| **F.8** Kemutakhiran pustaka | Persentase rujukan terbit dalam 10 tahun terakhir | ≥80% baik · 40–79% perlu perbaikan · <40% perlu perbaikan dengan catatan tingkat terendah |

**G.5 punya dua jalur** karena keenam artikel contoh memakai dua gaya sitasi berbeda:

- *Nama-tahun* (IJAL, IJOTIS, PASSAGE, curricula). Kunci dibentuk dari nama belakang penulis
  pertama plus tahun, lalu dicocokkan dua arah: kunci di teks yang tak ada di daftar
  (yatim teks), dan entri daftar yang tak pernah dikutip (yatim daftar).
- *Bernomor* (IJOST, Wafi). Penanda `[12]` dicocokkan ke rentang 1..jumlah entri. Yang dicari:
  nomor melebihi jumlah entri, dan entri yang tidak pernah dikutip.

Pencocokan nama-tahun rawan positif palsu pada nama majemuk dan urutan penulis yang terbalik,
jadi statusnya sengaja **perlu dicek**, bukan perlu perbaikan.

### Butir yang ditulis manusia

`F.1` judul · `F.2` abstrak · `F.3` kata kunci · `F.4` kebaruan dan analisis kesenjangan ·
`F.5` analisis dan sintesis · `F.6` penyimpulan · `G.6` gaya penulisan dan kebahasaan.

Bentuk tiap entri di `penilaian/artikel_<kode>.json`:

```json
{
  "F.1": {
    "ada": "Judul: \"...\". Lugas, menyebut variabel dan lokasi riset.",
    "catatan": "Belum memuat temuan penting. Rubrik menempatkan judul yang memuat informasi temuan pada tingkat tertinggi.",
    "saran": "Pertimbangkan memasukkan inti temuan ke judul.",
    "keyakinan": "tinggi"
  }
}
```

Statusnya ditentukan dari kalimat `saran`: **saran yang diawali kata "Pertahankan" dianggap
sudah baik**, selain itu perlu perbaikan. Butir yang tidak ada di berkas penilaian keluar
sebagai "belum dinilai".

### Butir di luar jangkauan

| Butir | Alasan |
|---|---|
| **F.9** Cakupan keilmuan | Dihitung dari persentase artikel dalam satu terbitan yang sesuai fokus dan skop jurnal, jadi berlaku pada tingkat jurnal, bukan artikel tunggal |
| **G.7** Tata letak | Menuntut inspeksi visual PDF: tabel terpotong, gambar melar atau blur, konsistensi tipografi. Ekstraktor hanya membaca lapisan teks |

### Empat status

| Status di TSV | Label di dashboard | Arti |
|---|---|---|
| `baik` | Sesuai | Sudah memenuhi rubrik |
| `perlu perbaikan` | Perlu perbaikan | Ada temuan yang bisa ditindaklanjuti |
| `perlu dicek` | Periksa manual | Skrip tidak bisa memastikan, perlu dilihat orang |
| `di luar jangkauan` | Di luar pemeriksaan otomatis | F.9 dan G.7 |

---

## 3. Berkas

| Berkas / folder | Isi | Git |
|---|---|---|
| `ekstrak_artikel.py` | Ekstraktor deterministik dengan pymupdf, 696 baris. Tanpa AI. | dilacak |
| `susun_laporan.py` | Merangkai 16 butir jadi markdown dan TSV, 567 baris. | dilacak |
| `peta_jurnal.json` | Memetakan kode berkas PDF ke nama jurnal persis seperti di Sheet1. | dilacak |
| `penilaian/` | Penilaian manusia untuk 7 butir. Ditulis tangan, satu berkas per artikel. | dilacak |
| `laporan/` | Laporan per artikel, ringkasan lintas artikel, dan TSV. | dilacak |
| `bukti/` | Paket bukti hasil ekstraksi. Memuat teks penuh artikel, jadi diperlakukan sama seperti PDF-nya. | **diabaikan** |
| `../PDF_Terbit/` | PDF sumber. Artikel berhak cipta. | **diabaikan** |

`bukti/` dan `PDF_Terbit/` masuk `.gitignore` karena memuat teks utuh artikel berhak cipta.
Keduanya juga masuk `.claspignore` supaya tidak ikut ter-push ke Apps Script.

---

## 4. Menjalankan di laptop

### Sekali saja: pasang kebutuhan

Yang dibutuhkan hanya Python 3 dan satu paket. Diuji dengan Python 3.14.7 dan PyMuPDF 1.28.2.
Kedua skrip memakai sintaks Python lama saja, tanpa `match` atau anotasi tipe modern, jadi
versi 3 yang lebih tua kemungkinan besar jalan — tapi itu belum diuji.

```bash
python --version
pip install pymupdf
```

`susun_laporan.py` hanya memakai pustaka bawaan Python, tidak perlu dipasang apa pun.

### Tiap kali ada artikel baru

```bash
cd C:/Users/Asus/Documents/djpi-dashboard/mutu-artikel

# 1. taruh PDF di ../PDF_Terbit/, beri nama sesuai kode jurnal, misal IJOTIS.pdf

# 2. ekstraksi: PDF -> bukti/*.json
python ekstrak_artikel.py

# 3. daftarkan nama jurnalnya di peta_jurnal.json, persis seperti di Sheet1
#    "IJOTIS": "Indonesian Journal of Teaching in Science"

# 4. baca artikelnya, tulis 7 butir penilaian ke penilaian/artikel_IJOTIS.json

# 5. susun laporan: bukti + penilaian -> laporan/
python susun_laporan.py
```

Keluaran langkah 5 kira-kira begini:

```
tulis IJOTIS-pra-asesmen.md (8/16 perlu perbaikan, 7/7 butir penilaian terisi)
tulis 00-ringkasan-lintas-artikel.md
tulis Pra_Asesmen_Artikel.tsv (96 baris temuan, siap ditempel ke sheet)
```

Langkah 4 boleh dilewati. Laporan tetap terbit, tujuh butir itu keluar sebagai
"belum dinilai", dan sembilan butir sisanya tetap terisi.

### PDF di folder lain

```bash
# Windows PowerShell
$env:DJPI_PDF_DIR = "D:\artikel-baru"; python ekstrak_artikel.py

# Git Bash / Linux / macOS
DJPI_PDF_DIR=/d/artikel-baru python ekstrak_artikel.py
```

### Memasukkan hasilnya ke dashboard

```powershell
# salin isi TSV tanpa baris header ke clipboard
$p = "C:\Users\Asus\Documents\djpi-dashboard\mutu-artikel\laporan\Pra_Asesmen_Artikel.tsv"
Get-Content -LiteralPath $p -Encoding UTF8 | Select-Object -Skip 1 | Set-Clipboard
```

1. Jalankan `buatSheetPraAsesmen()` dari editor Apps Script. Cukup sekali; fungsinya aman
   dipanggil berulang dan tidak menimpa sheet yang sudah ada.
2. Buka sheet `Pra_Asesmen_Artikel`, klik sel **A2**, tekan Ctrl+V. Google Sheets memecah
   kolom sendiri karena pemisahnya karakter tab.
3. Jalankan `cekPraAsesmen()`. Yang diharapkan: seluruh baris cocok ke jurnal di Sheet1.
   Baris yang ditandai `MISS` tidak akan pernah tampil ke pengelola — perbaiki
   `peta_jurnal.json` lalu susun ulang TSV.
4. Temuannya muncul di menu Persiapan Akreditasi, langkah 5 Tahap 3.2.

Saat menempel ulang, hapus dulu isi lama sheet mulai baris 2. Skrip menulis ulang seluruh
TSV tiap kali dijalankan, jadi menempel di bawah data lama akan menggandakan temuan.

---

## 5. Yang perlu diketahui sebelum mengubah

**Teks rubrik ada di dua tempat.** Sumbernya `Code.js` §28 `AKR_MUTU_ARTIKEL`. Kalimat di
`susun_laporan.py` menyalinnya. Kalau rubrik di Code.js berubah, teks di sini harus ikut.

**Daftar pustaka diambil dari heading referensi terakhir**, karena sebagian PDF punya kata
"REFERENCE" nyasar di tengah dokumen dan pemakaian heading pertama menghasilkan nol rujukan.

**Judul artikel dideteksi dari ukuran font**, bukan dari metadata PDF — metadata keenam
artikel contoh kosong semua — dan span yang berisi nama jurnal disaring lebih dulu supaya
banner jurnal tidak terbaca sebagai judul.

**Deteksi blok deklarasi dibatasi zona.** Pencarian pernyataan AI, pendanaan, dan konflik
kepentingan hanya berjalan dari heading simpulan sampai akhir dokumen. Tanpa batas itu,
frasa "artificial intelligence" di tinjauan pustaka terbaca sebagai pernyataan AI.
Pola CREdiT dicocokkan case-sensitive supaya kata "credit" biasa tidak ikut tertangkap.

**Angka dari ekstraktor perlu dicek silang.** Waktu pertama kali dijalankan, lebih dari
separuh temuan awal ternyata artefak ekstraksi, bukan masalah pada artikelnya: heading
`FINDINGS AND DISCUSSION` belum terdaftar sehingga IMRaD dilaporkan tidak lengkap, regex
caption menangkap kalimat "Table 1 displays..." sebagai caption, dan pemisah entri rujukan
memecah di tiap `Surname, X.` sehingga menangkap nama penulis terakhir. Semuanya sudah
diperbaiki, tapi kebiasaannya tetap berlaku: buka PDF-nya, cocokkan angkanya.

---

## 6. Batas yang berlaku sekarang

Akurasinya belum diukur. Belum ada skor acuan dari asesor atau penilaian pakar untuk
dibandingkan, jadi yang bisa dikatakan sekarang hanya bahwa keluarannya konsisten dan
angkanya sudah dicek silang ke PDF.

Lapisan penilaian manusia dikerjakan manual. Untuk produksi, lapisan itu bisa dijalankan
skrip lokal yang memanggil `api.anthropic.com` dengan API key sendiri, dengan bentuk
keluaran yang sama seperti berkas di `penilaian/`. Tidak ada API key di lingkungan ini
sekarang, dan pemanggilannya tetap di laptop, bukan di Apps Script.

Enam artikel contoh mewakili dua template tata letak dan dua gaya sitasi. Artikel dengan
template lain kemungkinan menemui pola heading atau caption yang belum dikenali, jadi
hasil ekstraksi pertama untuk jurnal baru sebaiknya selalu dicocokkan ke PDF-nya.
