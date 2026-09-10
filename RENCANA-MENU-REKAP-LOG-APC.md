# Pembaruan Rekap Log_APC oleh Admin DJPI

Revisi 3 — tabel Riwayat APC menjadi tampilan live sheet Log_APC yang bisa diubah langsung.

## Keputusan DJPI

| Keputusan | Akibatnya |
|---|---|
| Admin merekap jumlah transaksi dan total pemasukan APC secara manual dari data yang dimilikinya, kapan pun ada pemasukan | Tidak ada impor file; pencatatan per tanggal pemasukan |
| Tabel riwayat APC diganti tampilan live sheet Log_APC, diubah langsung di tabel | Kartu "Catat Pemasukan APC" dihapus |
| Setiap perubahan memunculkan log tanggal pembaruan | Kolom **Diperbarui** (tanggal, jam, pengubah) di tabel dan sheet |

## Cara kerja

**Membaca.** Tabel Riwayat APC membaca sheet Log_APC langsung setiap dimuat (saat tab dibuka, tombol
Muat ulang, atau Segarkan), tanpa cache. Admin kluster hanya melihat baris jurnal di klusternya.

**Mengubah.** Tombol **Ubah** di tiap baris membuka isian di tempat: tanggal pemasukan, jurnal,
edisi/keterangan, catatan, jumlah artikel/transaksi, dan total. Saat disimpan, server:

1. mencocokkan **sidik isi baris** dengan saat tabel dimuat — bila baris sudah diubah orang lain atau
   bergeser karena sisip/hapus manual di sheet, perubahan ditolak dan tabel dimuat ulang;
2. menulis hanya sel yang berubah, lalu mengisi `Diperbarui Pada` dan `Diperbarui Oleh`;
3. mencatat nilai lama → baru ke Log_Aktivitas (`UBAH_LOG_APC`), karena nilai lama di sheet tertimpa;
4. membersihkan cache rekap supaya kartu ringkasan ikut berubah.

**Menambah.** Tombol **Tambah baris** membuka baris isian di atas tabel. Entri disimpan dengan
`Sumber = ADMIN`; bila jurnal, tanggal, dan total yang sama sudah ada, admin diminta **Tetap simpan**.

**Kolom sheet.** Lima kolom ditambahkan otomatis di ujung Log_APC saat pertama kali dibutuhkan —
`Sumber`, `Tanggal Pemasukan`, `Catatan`, `Diperbarui Pada`, `Diperbarui Oleh`. Urutan kolom lama tidak
berubah, jadi laporan pengelola tetap tertulis sejajar.

**Akses.** Superadmin untuk semua jurnal; admin kluster hanya untuk jurnal di klusternya, termasuk saat
memindahkan baris ke jurnal lain.

## Asumsi

- **Satu transaksi VA = satu pembayaran APC artikel**, sehingga jumlah transaksi dan jumlah artikel
  berbayar memakai kolom yang sama.

## Tidak dikerjakan

- Hapus baris dari tabel — tidak diminta; baris yang keliru bisa diubah nilainya.
- Pembaruan otomatis tanpa memuat ulang — tabel dibaca ulang saat dibuka, Muat ulang, atau setelah
  menyimpan.
- Impor file dan sinkron otomatis dari bank.
