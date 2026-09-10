# Rencana: Menu Pembaruan Rekap Log_APC untuk Admin DJPI

Status: **rencana, belum dikerjakan.** Tidak ada kode yang diubah untuk dokumen ini.

## Kondisi sekarang

- `Log_APC` hanya bertambah lewat `logApcEntry` (`Code.js`): panel **Lapor APC** di Pengelola dan
  tombol **Catat APC** di modal jurnal admin. Satu kirim = satu baris per edisi.
- Kolom yang dibaca `bacaLogApc_`: Timestamp, Email Pengelola, Nama Jurnal, Edisi Laporan,
  Jumlah Artikel Berbayar, Total Pemasukan APC (+ dua kolom honor/pengembangan lama yang kosong).
  Header dicocokkan lewat nama, jadi kolom baru aman ditambahkan **di ujung**.
- Append-only. Tidak ada edit, hapus, koreksi, maupun impor sekaligus.
- Kartu **Jurnal sudah menggunakan VA** kini sepenuhnya dihitung dari `Log_APC`. Artinya akurasi
  kartu itu setara dengan kelengkapan log: jurnal yang pemasukan VA-nya belum dilaporkan tidak
  terhitung.

## Yang dibutuhkan admin

1. Menambah entri yang tidak dilaporkan pengelola.
2. Memasukkan rekap sekaligus (mis. dari rekap VA keuangan) tanpa mengetik baris per baris.
3. Memperbaiki entri yang salah tanpa merusak jejak.

## Rancangan

### Prinsip

- **Tetap append-only.** Log ini catatan keuangan. Perbaikan dicatat sebagai baris **koreksi** yang
  merujuk baris asal, bukan menimpa atau menghapus. Pola yang sama dengan `Log_Pencairan_APC`.
- **Setiap baris punya ID.** Nomor baris tidak stabil (lihat catatan `cariBarisSheet_`), jadi koreksi
  harus merujuk ID, bukan posisi.

### Kolom baru di ujung Log_APC

| Kolom | Isi |
|---|---|
| `ID Entri` | `APC-yyyyMMdd-HHmmss-xxxxx`, dibuat server |
| `Sumber` | `PENGELOLA` · `ADMIN` · `IMPOR` · `KOREKSI` |
| `Merujuk ID` | hanya untuk `KOREKSI` |
| `Dicatat Oleh` | email admin (baris pengelola tetap memakai Email Pengelola) |
| `Catatan` | wajib untuk `KOREKSI` |

Baris lama tanpa ID dianggap `Sumber = PENGELOLA`; ID-nya dibuat saat pertama kali dikoreksi.

### Menu: panel "Perbarui rekap Log_APC" di tab Pemasukan APC

1. **Tambah entri.** Form: jurnal, edisi/periode, jumlah artikel, total, catatan. Memakai
   `logApcEntry` dengan `Sumber = ADMIN`.
2. **Impor rekap (tempel).** Admin menempel tabel dari spreadsheet (kolom: Nama Jurnal · Edisi/Periode ·
   Artikel · Total). Server mengurai lalu mengembalikan **pratinjau per baris** berstatus:
   `cocok` · `jurnal tidak dikenal` · `kemungkinan ganda` (jurnal + edisi + total sudah ada) ·
   `nilai tidak sah`. Admin mencentang baris yang disimpan, lalu satu kali simpan menulis semuanya
   dengan satu `ID batch` di Log_Aktivitas. Ganda hanya **diperingatkan**, tidak ditolak, karena dua
   edisi bisa bernilai sama.
3. **Koreksi.** Tombol **Koreksi** di tabel Riwayat Laporan APC. Admin mengisi nilai yang benar;
   server menulis baris `KOREKSI` berisi **selisih** (boleh negatif hanya untuk koreksi) dengan
   alasan wajib. Rekap menjumlah baris koreksi, dan riwayat menampilkannya dengan badge.

### Akses

- Tambah & koreksi: admin kluster untuk jurnal di klusternya (`bolehAksesKluster_` sudah ada).
- Impor rekap: superadmin saja.

## Urutan kerja

| Tahap | Isi | Catatan |
|---|---|---|
| 1 | Kolom baru + ID + Sumber; `bacaLogApc_` membacanya; migrasi header otomatis | tanpa UI |
| 2 | Tambah entri admin + koreksi dari tabel riwayat | paling berguna, risiko kecil |
| 3 | Impor tempel + pratinjau + deteksi ganda | terbesar; tunggu jawaban soal format rekap |

## Pertanyaan untuk Anda sebelum dikerjakan

1. **Rekap apa yang diterima admin?** File dari keuangan/DPPM per transaksi VA, per bulan, atau
   hanya laporan pengelola? Kalau per VA, impor sebaiknya mencocokkan jurnal lewat **Nomor VA**,
   bukan nama.
2. **Satuan rekap:** tetap per edisi seperti sekarang, atau per bulan transaksi?
3. **Impor hanya untuk superadmin?** (default rencana: ya)

## Tidak dikerjakan

- Edit atau hapus langsung baris Log_APC — memutus jejak keuangan.
- Sinkron otomatis dari bank — tidak ada akses API; impor tempel sudah menutup kebutuhan manual.
- Perubahan pada Log_Pencairan_APC — alurnya terpisah dan sudah append-only.
