# Ringkasan lintas artikel — pra-asesmen Tahap 3.2

6 artikel terbit dari enam jurnal UPI, diekstraksi 2026-09-04. Angka di bawah adalah hasil pembacaan otomatis lapisan teks PDF, bukan penilaian.

## Bandingan

| Artikel | Perlu perbaikan | Galley | Rujukan | Mutakhir ≤10 th | Ber-DOI | Gaya sitasi | Abstrak |
|---|---|---|---|---|---|---|---|
| IJAL | 5/16 | 5/9 | 41 | 72% | 29 | nama-tahun | 243 kata |
| IJOST | 9/16 | 5/9 | 56 | 100% | 5 | bernomor | 189 kata |
| IJOTIS | 8/16 | 5/9 | 27 | 96% | 25 | nama-tahun | 106 kata |
| PASSAGE | 10/16 | 5/9 | 21 | 30% | 11 | nama-tahun | 245 kata |
| Wafi | 5/16 | 5/9 | 40 | 100% | 2 | bernomor | 121 kata |
| curricula | 7/16 | 7/9 | 41 | 100% | 2 | nama-tahun | 192 kata |

## Unsur galley yang hilang (G.1)

| Unsur | Artikel yang tidak memuatnya |
|---|---|
| pernyataan penggunaan AI | 6/6 — IJAL, IJOST, IJOTIS, PASSAGE, Wafi, curricula |
| kontribusi penulis | 6/6 — IJAL, IJOST, IJOTIS, PASSAGE, Wafi, curricula |
| konflik kepentingan | 4/6 — IJAL, IJOTIS, PASSAGE, Wafi |
| pernyataan pendanaan | 4/6 — IJOST, IJOTIS, PASSAGE, Wafi |
| lisensi akses | 2/6 — IJAL, IJOST |

## Pola yang berulang

- Tidak ada satu pun dari 6 artikel yang memuat **pernyataan penggunaan AI, kontribusi penulis**. Penyebabnya ada di template galley jurnal, yang belum menyediakan blok Declaration. Satu perbaikan template menaikkan G.1 untuk seluruh artikel jurnal itu sekaligus.
- Jumlah rujukan: semua artikel memenuhi ambang minimal 15.
- Kemutakhiran pustaka di bawah 80%: IJAL (72%), PASSAGE (30%).
- Gaya sitasi terbagi: nama-tahun pada IJAL, IJOTIS, PASSAGE, curricula; bernomor pada IJOST, Wafi. Algoritma harus mengenali keduanya, karena pencocokan nama-tahun tidak berlaku pada daftar bernomor.

## Batas alat ini

- **F.9 cakupan keilmuan** dinilai pada tingkat jurnal, tidak bisa dihitung dari artikel tunggal.
- **G.7 tata letak** menuntut inspeksi visual PDF. Ekstraktor hanya membaca lapisan teks.
- **F.7 proporsi acuan primer** baru menghitung jumlah rujukan. Klasifikasi jenis sumber (jurnal, prosiding, buku, web) belum otomatis.
- **G.2 kota pada afiliasi** belum diperiksa.
- Pencocokan sitasi nama-tahun memakai surname penulis pertama dan tahun, sehingga nama majemuk atau urutan penulis yang terbalik bisa muncul sebagai ketidakcocokan palsu. Tiap temuan G.5 perlu dilihat satu per satu sebelum disampaikan ke penulis.
- Butir F.1 sampai F.6 dan G.6 dinilai dengan membaca isi artikel, bukan oleh ekstraktor.
