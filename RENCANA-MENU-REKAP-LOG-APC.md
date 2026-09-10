# Menu Pembaruan Rekap Log_APC oleh Admin DJPI

Revisi 2 — disesuaikan dengan jawaban DJPI, lalu dikerjakan.

## Jawaban yang menentukan rancangan

| Pertanyaan | Jawaban | Akibatnya |
|---|---|---|
| Rekap apa yang diterima admin? | Admin merekap **jumlah transaksi** dan **total pemasukan APC** secara manual dari data yang dimilikinya | Tidak perlu impor file; cukup form input manual |
| Kapan dicatat? | Kapan pun ada pemasukan | Entri memakai **tanggal pemasukan**, tidak terikat edisi atau bulan |
| Impor/tempel untuk superadmin saja? | Tidak relevan lagi | Fitur tempel dihapus. Akses mengikuti pencatatan pencairan: superadmin, atau admin untuk jurnal di klusternya |

## Yang dibangun

**Kartu "Catat Pemasukan APC"** di tab Pemasukan APC: jurnal, tanggal pemasukan (maks. hari ini),
jumlah transaksi, total pemasukan, catatan. Ada langkah konfirmasi karena entri tidak bisa diubah.

**Koreksi.** Centang "Ini koreksi" lalu isi **selisihnya** (boleh negatif) beserta alasan minimal
10 karakter. Baris lama tidak disentuh, jadi jejak keuangan tetap utuh.

**Peringatan entri ganda.** Bila jurnal, tanggal, dan total yang sama sudah ada, server menolak sekali
dengan peringatan; admin menekan **Tetap simpan** bila memang transaksi berbeda.

**Penyimpanan di Log_APC.** Tiga kolom ditambahkan otomatis di ujung sheet — `Sumber`
(`ADMIN`/`KOREKSI`; kosong berarti laporan pengelola), `Tanggal Pemasukan`, `Catatan`. Urutan kolom
lama tidak berubah, jadi laporan pengelola tetap tertulis sejajar.

**Rekap.** Total dihitung bersih setelah koreksi. Riwayat menampilkan badge Admin/Koreksi dan
alasannya, memakai tanggal pemasukan, dan ekspornya memuat kolom Sumber & Catatan. Jurnal yang
pemasukannya menjadi nol setelah koreksi tidak dihitung "sudah menggunakan VA".

## Asumsi

- **Satu transaksi VA = satu pembayaran APC artikel.** Karena itu jumlah transaksi disimpan di kolom
  `Jumlah Artikel Berbayar` yang juga dipakai laporan pengelola. Bila satu transaksi bisa mencakup
  beberapa artikel, kolomnya perlu dipisah.

## Tidak dikerjakan

- Impor/tempel rekap — admin menginput manual.
- Edit atau hapus langsung baris Log_APC — memutus jejak keuangan.
- Sinkron otomatis dari bank — tidak ada akses API.
