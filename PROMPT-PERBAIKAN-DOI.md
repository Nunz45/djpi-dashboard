# Prompt Perbaikan — Usulan & Aktivasi DOI

Disusun 10 Sep 2026 dari pembacaan kode di `master` (14d8c67). Nomor baris merujuk ke commit itu.

---

## 1. Temuan verifikasi

| # | Lokasi kode | Kondisi sekarang | Penyebab |
|---|---|---|---|
| A1 | Header tabel `Dashboard.html:1257` (Jumlah DOI), `:1259` (Aksi). Sel `:1278`, `:1282`. CSS `Stylesheet.html:180`, `:182`, `:185` | Keduanya memakai `td-num`. **Sel** rata kanan, **header** rata kiri, jadi header dan isi tidak lurus | `.td-num{text-align:right}` (`Stylesheet.html:185`, spesifisitas 0,1,0) kalah oleh `table.tabel th{text-align:left}` (`:180`, 0,1,2). Aksi juga bukan angka, tetapi memakai `td-num`. Kolom sticky `table.tabel-aksi td:last-child` (`:348-350`, hanya di `@media(max-width:680px)` `:329`) tidak memakai `text-align`, jadi aman diubah |
| A2 | Filter `Dashboard.html:1210-1224` (grid-3, baru terisi 2). Computed `usulanDoiTersaring` `JavaScript.html:241-249` | Hanya filter cari dan status | Tanggal ajuan **ada**: `dibuat_pada` = `new Date()` saat simpan (`Code.js:3518,3523`). Diserialisasi `"yyyy-MM-dd'T'HH:mm:ss"` di zona skrip (`Code.js:3496-3497`), dengan `appsscript.json:2` = `Asia/Jakarta`. Bulan WIB = `substring(0,7)`. Ini **berbeda** dari `tanggal_publikasi`, yang diisi pengelola (`Pengelola.html:471`). Polanya sudah ada: `daftarBulanApc` `JavaScript.html:259-264` dan `labelBulanApc` `:581-584` |
| A3 | `XLSX` 0.18.5 sudah dimuat `Dashboard.html:15`. Helper `unduhExcel` `JavaScript.html:588`. Dipakai 9 tombol ekspor, mis. `Dashboard.html:800`, `:1008` | Tab DOI belum punya ekspor | Unduhan dari sisi klien lewat `XLSX.writeFile` terbukti jalan di iframe HtmlService karena tombol ekspor lain memakainya. Tidak perlu jalur Drive atau `ContentService`. CSV bisa lewat library yang sama (`bookType:'csv'`). PDF: panel admin **tidak punya** CSS cetak (tidak ada `@media print` di `Stylesheet.html`/`Dashboard.html`). Pola cetak ada di Pengelola: `window.print()` `Pengelola.html:3131-3134`, `.akr-cetak` `:3373-3390` |
| A4 | `Dashboard.html:1757` | `2026-09-10T00:00:00` | `simpanUsulanDoi` menulis string `'2026-09-10'` (`Code.js:3547`) lewat `appendRow`. Sheets mengubahnya menjadi sel Date, lalu `barisDoiKeObjek_` memformat semua Date sebagai `yyyy-MM-dd'T'HH:mm:ss` (`Code.js:3496-3497`). Bug sama ada di `diproses_pada` `Dashboard.html:1773`. Helper `tglPanjang` (`Pengelola.html:2851`) hanya ada di Pengelola dan memakai `new Date(iso)`. String tanggal-saja diurai sebagai UTC sehingga rawan geser hari di luar WIB. Panel admin belum punya formatter tanggal |
| A5 | `Dashboard.html:1758` | Panel detail menampilkan Penulis | `penulis` juga dipakai di form pengelola `Pengelola.html:482-485` (wajib untuk artikel, `:1783`), payload `:2351`, server `Code.js:3531,3667`, dan pencarian admin `JavaScript.html:246` + placeholder `Dashboard.html:1214`. **Hapus dari panel saja** |
| A6 | lihat §2 | — | — |
| B7 | Riwayat pengelola `Pengelola.html:339-371`. Kolom Aksi `:361-368` untuk non-editable hanya menampilkan "sudah diproses". Status `Code.js:3064-3071`. Transisi admin `ubahStatusUsulanDoi` `Code.js:3770-3859` | Tidak ada langkah pengelola setelah BERHASIL | Tidak ada kolom konfirmasi. Tidak ada daftar DOI yang tersimpan (lihat §2), jadi klarifikasi **harus berupa teks bebas**. Tidak ada pola email ke admin: semua `GmailApp.sendEmail` menuju pengelola atau PIN (`Code.js:1802,1953,2674,3253,3268,3982`). Pola kepemilikan yang ditiru: `Code.js:3646-3649` |

**Pemakaian `status === 'BERHASIL'` yang akan rusak kalau B7 dibuat sebagai status baru** (dasar keputusan §5.1):
- `bacaJurnalPunyaDoi_` `Code.js:5745`. Checklist akreditasi "DOI aktif" hanya menghitung `BERHASIL`. Jurnal yang sudah **mengonfirmasi aktif** justru akan dianggap tidak punya DOI.
- `kirimUlangReceiptDoi` `Code.js:3902`, baris receipt aktivasi `Dashboard.html:1785`, dan gate email `perluKonfirmasiBerhasilDoi` `JavaScript.html:278-280`.
- Blok email aktivasi `Code.js:3837-3842`. Kembali ke BERHASIL dari status lain akan mengirim ulang email dan menimpa `doi_aktif_pada`.
- Validasi dropdown sheet `Code.js:3091-3098` dengan `setAllowInvalid(false)`. Aturan ini hanya dipasang saat sheet **dibuat**, jadi sheet yang sudah ada tetap memakai daftar 6 status lama. Apakah `setValue` dari skrip ditolak untuk nilai baru: **belum terverifikasi**.
- Dropdown status admin `Dashboard.html:1799` berisi `DOI_STATUS` apa adanya (`Code.js:3738`). Status milik pengelola akan ikut bisa dipilih admin.
- Peta label/kelas ganda: `JavaScript.html:19-34` dan `Pengelola.html:2387-2403`.

---

## 2. Jawaban A6 — "Jumlah DOI diminta" vs "DOI diusulkan"

Keduanya **bukan konsep yang sama**:

- **Jumlah DOI diminta** = kolom `jumlah_doi`, **angka**. Pengelola mengisinya di wizard langkah 3 (`Pengelola.html:497-498`, "Jumlah DOI dibutuhkan"). Nilai ini wajib ≥1 (`Code.js:3194-3195`), disimpan `Code.js:3546`, dan dipakai di email tanda terima (`Code.js:3250`).
- **DOI diusulkan** = kolom `doi_diusulkan`, **teks string DOI**. Kolom ini sisa skema lama (`Code.js:3041`, bagian "kolom lama"). Server mau menyimpannya kalau dikirim (`Code.js:3533`), tetapi **tidak ada input di UI mana pun yang mengisinya**:
  - payload pengelola tidak memuatnya (`Pengelola.html:2345-2361`),
  - `perbaruiUsulanDoi` tidak menulisnya (`Code.js:3661-3676`),
  - `ubahStatusUsulanDoi` admin juga tidak (`Code.js:3832-3835`).

  Akibatnya, untuk semua usulan dari UI sekarang, kolom ini selalu kosong. Panel menampilkan "Belum diisi" (`Dashboard.html:1769`), dan email "DOI Aktif" selalu berisi `(lihat detail di dashboard)` (`Code.js:3265`). Keduanya hanya bisa berbeda kalau seseorang mengisi sel sheet secara manual.

**Usul:** pertahankan label "Jumlah DOI diminta". Tampilkan baris "DOI diusulkan" **hanya bila terisi** (`v-if`), dengan label **"Daftar DOI"**. Dampak untuk B7: sistem tidak tahu DOI mana saja yang diaktifkan, jadi pengelola menulis sendiri DOI yang tidak aktif di kolom klarifikasi.

---

## 3. Grill

1. **B7 sebagai status baru merusak lima tempat** (daftar di §1). Rencana berubah: status tetap `BERHASIL`, dan konfirmasi disimpan di **kolom terpisah** `konfirmasi_pengelola`. Dengan begitu `DOI_STATUS`, `DOI_STATUS_BISA_DIEDIT` (`Code.js:3609`, `Pengelola.html:2286`), badge, dropdown admin, validasi sheet, dan checklist akreditasi tidak disentuh. Kolom baru ditambahkan di akhir `DOI_HEADERS`, lalu dimigrasi otomatis oleh `migrasiHeaderDoiJikaPerlu_` (`Code.js:3114-3131`, dipanggil `:3102`). Kolom itu langsung muncul di objek item karena `barisDoiKeObjek_` membaca header sheet (`Code.js:3491-3501`).
2. **Konfirmasi basi.** Kalau admin memindahkan usulan BERHASIL ke status lain lalu kembali ke BERHASIL, nilai `AKTIF`/`KLARIFIKASI` lama akan muncul lagi. Solusinya: kosongkan `konfirmasi_pengelola` di blok transisi-baru-ke-BERHASIL yang sudah ada (`Code.js:3837`). Cukup satu baris.
3. **Zona waktu.** `T00:00:00` yang tepat tengah malam menunjukkan zona spreadsheet = zona skrip (Asia/Jakarta). Kalau berbeda, jamnya tidak akan 00. Ini **disimpulkan, belum terverifikasi**; cek lewat log `cekTanggalExpired` `Code.js:7479`. Risiko nyata ada di **klien**: `new Date('2026-09-10')` = UTC. Karena itu formatter baru **wajib mengurai string dengan regex, tanpa `new Date`**. Jangan menyalin `tglPanjang`.
4. **Sel kosong / lama.** Baris yang diisi manual bisa tanpa `dibuat_pada` atau berformat teks lain. Filter bulan harus menjaga dengan regex `^\d{4}-\d{2}`: baris tanpa bulan tetap tampil saat filter bulan kosong dan tidak muncul sebagai opsi. Formatter tanggal mengembalikan nilai asli bila tidak cocok. Baris lama tidak punya `konfirmasi_pengelola`, jadi perlakukan falsy sebagai "belum dikonfirmasi".
5. **Klien atau server untuk filter bulan?** Klien. `getUsulanDoi` sudah mengirim semua baris (`Code.js:3724`) dan tidak ada paginasi. Portofolio ±214 jurnal (mock `build-preview.mjs:14`) berarti ratusan usulan per tahun, masih ringan.
6. **PDF.** Library PDF baru (jsPDF + autotable) menambah ±400 KB dan pola baru. Cetak browser → "Simpan sebagai PDF" sudah jadi pola di Pengelola. Tapi `Stylesheet.html` **dipakai bersama** (`Dashboard.html:17`, `Pengelola.html:49`, `Masuk.html:13`), jadi CSS cetak DOI harus dibatasi dengan kelas `body.cetak-doi`, supaya cetak akreditasi Pengelola (`Pengelola.html:3376-3390`) tidak rusak.
7. **CSV dan tanda `+`.** `aman_` (`Code.js:337-341`) menambah `'` di sheet, tetapi `getValues` mengembalikan teks tanpa apostrof. Nomor `+62812…` akan dibaca Excel sebagai rumus/angka, dan `=…` bisa jadi injeksi rumus. Untuk CSV, awali string yang dimulai `= + - @` dengan `'`. XLSX tidak perlu karena sel bertipe string.
8. **Ekspor mengikuti filter aktif** (`usulanDoiTersaring`: cari + status + bulan). Kalau tidak, hasil ekspor berbeda dari yang dilihat admin.
9. **Admin tahu ada klarifikasi dari mana?** Tidak ada pola email ke admin, dan menu DOI dimuat malas (`JavaScript.html:414`), jadi badge sidebar tidak akan terisi sebelum tab dibuka. Minimal yang benar: opsi filter "Perlu klarifikasi" + badge di sel status. Email ke admin tidak dikerjakan (§6).
10. **Jalur balik klarifikasi.** Admin memperbaiki di Crossref lalu mencentang "Klarifikasi sudah ditindaklanjuti" di modal. Server mengosongkan `konfirmasi_pengelola`, dan pengelola melihat tombol Aktif/Klarifikasi lagi. Balasan admin memakai `catatan_admin`, yang **sudah tampil** di riwayat pengelola (`Pengelola.html:359`). Tidak perlu kanal baru.
11. **Urutan paling aman:** 1 kosmetik (klien saja) → 2 filter bulan (klien) → 3 ekspor (klien, memakai daftar tersaring dan helper tanggal dari tahap 1–2) → 4 konfirmasi (server + dua view). Hanya tahap 4 yang menyentuh `Code.js` dan skema sheet.
12. **Sisa kecil yang sengaja dibiarkan:** `perbaruiUsulanDoi` membandingkan `String(Date)` dengan `'2026-09-10'` (`Code.js:3685`), sehingga `tanggal_publikasi` selalu ditulis ulang. Nilainya sama, jadi tidak berbahaya dan di luar scope.

---

## 4. PROMPT PERBAIKAN (tempel ke agen pelaksana)

```text
Kamu mengerjakan repo c:\Users\Asus\Documents\djpi-dashboard (Google Apps Script;
Vue 3 global build dengan in-DOM template; tulis komentar & teks UI dalam Bahasa Indonesia).
Kerjakan EMPAT tahap berurutan, satu commit per tahap. Jangan melebarkan scope.

ATURAN PROYEK
- Setelah tiap tahap lolos verifikasi: `clasp push` (HEAD saja). JANGAN `clasp deploy` —
  user yang menjalankannya.
- Commit per tahap, pesan Bahasa Indonesia, diakhiri baris:
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Jangan commit `PDF_Terbit/` atau `mutu-artikel/bukti/`. Stage file per nama, bukan `git add -A`.
- Verifikasi UI lewat preview statis SEBELUM push. Pola: skrip node yang membaca
  Dashboard.html / Pengelola.html, mengganti `<?!= include('Stylesheet'|'Komponen'|'JavaScript'); ?>`
  dengan isi file, mengganti scriptlet token, dan menyuntik mock `window.google.script.run`.
  Contoh ada di scratchpad sesi sebelumnya (build-preview.mjs untuk admin, build-pengelola.mjs
  untuk pengelola); kalau tidak ada di mesinmu, buat ulang di scratchpad-mu dengan pola itu.
  Mock admin sekarang mengembalikan items:[] untuk semua endpoint selain
  getDashboardDataForAdmin (build-preview.mjs:91) — tambahkan mock `getUsulanDoi` berisi
  minimal 5 item: dibuat_pada di 2 bulan berbeda (mis. '2026-08-28T09:15:00' dan
  '2026-09-03T14:22:03'), satu item TANPA dibuat_pada, tanggal_publikasi '2026-09-10T00:00:00',
  whatsapp_pemohon '+6281234567890', satu item status BERHASIL; plus
  statusOptions: ['MENUNGGU_VALIDASI','PERLU_REVISI','SIAP_DIPROSES','SEDANG_DIPROSES','BERHASIL','GAGAL'].
- JANGAN mengubah: DOI_STATUS (Code.js:3064), DOI_STATUS_BISA_DIEDIT (Code.js:3609),
  doiBisaDiedit (Pengelola.html:2285), LABEL_STATUS_DOI/KELAS_STATUS_DOI (JavaScript.html:19-34),
  peta label di Pengelola.html:2387-2403, urutan kolom lama DOI_HEADERS, form wizard pengelola,
  kolom `penulis` di sheet/form/server, bacaJurnalPunyaDoi_ (Code.js:5733).

──────────────────────────────────────────────────────────────────────────────
TAHAP 1 — Kosmetik tabel & panel detail (A1, A4, A5, label A6)
File: Stylesheet.html, JavaScript.html, Dashboard.html

1a. Stylesheet.html — tambahkan tepat setelah baris `.td-num{...}` (baris 185):
      table.tabel th.td-tengah,table.tabel td.td-tengah{text-align:center}
    (Spesifisitas harus mengalahkan `table.tabel th{text-align:left}` di baris 180.
    JANGAN ubah .td-num, dan jangan sentuh aturan sticky tabel-aksi baris 348-350.)
1b. Dashboard.html, tabel Usulan DOI:
    - baris 1257 th Jumlah DOI: class="td-num td-tengah"
    - baris 1278 td Jumlah DOI: class="td-num td-tengah tabular"
    - baris 1259 th Aksi: class="td-tengah" (buang td-num)
    - baris 1282 td Aksi: class="td-tengah" (buang td-num)
    Hanya tabel ini. Tabel riwayat DOI di Pengelola.html TIDAK diubah.
1c. JavaScript.html — helper global di dekat `rupiah` (baris 10), TANPA new Date:
      function tglIndo(s,jam){
        var m=/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(s||''));
        if(!m)return s||'';
        var t=parseInt(m[3],10)+' '+BULAN[parseInt(m[2],10)-1]+' '+m[1];
        return (jam&&m[4])?t+', '+m[4]+'.'+m[5]:t;
      }
    Daftarkan di methods seperti `rupiah:rupiah` (baris 504): tambahkan `tglIndo:tglIndo`.
    (Template Vue tidak bisa memanggil fungsi global langsung.)
1d. Dashboard.html modal detail DOI:
    - baris 1757: {{ doiTerpilih.tanggal_publikasi ? tglIndo(doiTerpilih.tanggal_publikasi) : '—' }}
    - baris 1773: ({{ tglIndo(doiTerpilih.diproses_pada, true) }})
    - hapus baris 1758 (<dt>Penulis</dt>...). Pencarian JavaScript.html:246 tetap memuat penulis.
    - baris 1769: jadikan `<template v-if="doiTerpilih.doi_diusulkan"><dt>Daftar DOI</dt><dd>{{ doiTerpilih.doi_diusulkan }}</dd></template>`
      (label "Jumlah DOI diminta" baris 1756 tetap).

Kriteria selesai (di preview, lebar 1280px dan 360px):
- Header dan isi kolom Jumlah DOI & Aksi sama-sama rata tengah; di 360px kolom Aksi tetap
  lengket di kanan dengan bayangan (tidak berubah dari sebelumnya).
- Tabel lain (Daftar Jurnal, Akreditasi, riwayat DOI pengelola) tampil identik dengan sebelum.
- Panel detail: "Tanggal publikasi 10 Sep 2026"; "Diproses oleh … (3 Sep 2026, 14.22)";
  tidak ada baris Penulis; baris Daftar DOI tidak muncul bila kosong.
- tglIndo('') → '', tglIndo('abc') → 'abc', tglIndo('2026-09-10') → '10 Sep 2026'.

──────────────────────────────────────────────────────────────────────────────
TAHAP 2 — Filter Bulan Ajuan (A2)
File: JavaScript.html, Dashboard.html

2a. data() baris 73: tambahkan `filterDoiBulan:''`.
2b. computed baru di dekat usulanDoiTersaring (baris 241), meniru daftarBulanApc (259-264):
      daftarBulanDoi:function(){
        var set={};
        this.usulanDoi.forEach(function(d){var b=String(d.dibuat_pada||'');if(/^\d{4}-\d{2}/.test(b))set[b.substring(0,7)]=true;});
        return Object.keys(set).sort().reverse();
      },
2c. usulanDoiTersaring: ambil `bl=this.filterDoiBulan`, tambahkan setelah cek status:
      if(bl&&String(d.dibuat_pada||'').substring(0,7)!==bl)return false;
2d. Dashboard.html, di grid filter (setelah blok Status, sebelum `</div>` baris 1224):
      <div>
        <label class="label" for="fDoiBulan">Bulan ajuan</label>
        <select id="fDoiBulan" v-model="filterDoiBulan" class="select">
          <option value="">Semua bulan</option>
          <option v-for="b in daftarBulanDoi" :key="b" :value="b">{{ labelBulanApc(b) }}</option>
        </select>
      </div>
    (labelBulanApc di JavaScript.html:581 generik untuk 'yyyy-MM'; pakai ulang, jangan duplikasi.)
2e. Modal detail: tambahkan `<dt>Diajukan pada</dt><dd>{{ tglIndo(doiTerpilih.dibuat_pada, true) || '—' }}</dd>`
    tepat sebelum <dt>Pemohon</dt> (baris 1749), supaya hasil filter bisa dicek.
2f. Teks alert kosong baris 1247: "Tidak ada usulan yang cocok dengan pencarian atau filter."

Kriteria selesai:
- Opsi bulan berisi tepat bulan yang ada di data (terbaru di atas); item tanpa dibuat_pada
  tidak memunculkan opsi kosong/"undefined".
- Status "Berhasil" + bulan "Sep 2026" menampilkan irisan keduanya; "Menampilkan X dari Y" benar.
- Bulan kosong → item tanpa dibuat_pada tetap tampil.
- Filter ditentukan oleh dibuat_pada, BUKAN tanggal_publikasi.

──────────────────────────────────────────────────────────────────────────────
TAHAP 3 — Ekspor Excel / CSV / PDF (A3)
File: JavaScript.html, Dashboard.html, Stylesheet.html

3a. unduhExcel (JavaScript.html:588): tambah parameter opsional ke-4 `format` ('xlsx' default).
    Bila 'csv': XLSX.writeFile(wb, namaFile+'-'+tanggal+'.csv', {bookType:'csv'}).
    Pemanggil lama tidak diubah.
3b. Method `barisEksporDoi(untukCsv)` → map usulanDoiTersaring (HORMATI filter aktif) ke:
      'ID Usulan', 'Tanggal Ajuan' (tglIndo(dibuat_pada,true)), 'Jurnal', 'Pemohon', 'Jabatan',
      'WhatsApp', 'Email Pengelola', 'Jenis Konten' ('Edisi/Volume'|'Artikel'),
      'Volume', 'Nomor', 'Tahun', 'Judul/Edisi', 'Jumlah DOI' (Number),
      'Tanggal Publikasi' (tglIndo), 'URL Landing Page', 'Status' (labelStatusDoi),
      'Catatan Admin', 'Diproses Oleh', 'Diproses Pada' (tglIndo(...,true)).
    Penulis TIDAK diekspor. Bila untukCsv: string yang diawali = + - @ diberi prefiks '.
    Method `eksporDoi(format)`: bila daftar kosong → tampilkanToast('Tidak ada usulan untuk diekspor.');
    'xlsx'/'csv' → unduhExcel(rows,'Usulan DOI','DJPI-Usulan-DOI',format); 'pdf' → cetakDoi().
3c. PDF = dialog cetak browser (pola Pengelola.html:3131-3134, "Simpan sebagai PDF"). Tanpa library baru.
    - Dashboard.html: beri section baris 1189 class="tab-doi". Di dalamnya, sebagai anak terakhir,
      tambahkan `<div class="doi-cetak">`: judul "Usulan DOI — DJPI UPI", baris keterangan filter
      aktif (status/bulan/cari) + waktu cetak, lalu <table class="doi-cetak-tabel"> dengan kolom
      Tgl Ajuan, Jurnal, Judul/Edisi, Jenis, Jumlah DOI, Tgl Publikasi, Status, dari usulanDoiTersaring.
    - cetakDoi(): document.body.classList.add('cetak-doi'); $nextTick → window.print();
      lepas kelas pada event `afterprint` (window.addEventListener('afterprint', fn, {once:true})).
    - Stylesheet.html (di akhir file): `.doi-cetak{display:none}` dan
      @media print { SEMUA selektor diawali body.cetak-doi — sembunyikan .app-nav, .app-atas,
      .app-nav-backdrop, .footer, dan `.tab-doi > :not(.doi-cetak)`; tampilkan .doi-cetak;
      .app-utama margin/padding 0; tabel border 1px #999, font 10.5px, th tanpa latar gelap. }
      WAJIB berawalan body.cetak-doi: Stylesheet.html juga dimuat Pengelola.html:49 dan
      Masuk.html:13, dan tidak boleh mengubah cetak akreditasi Pengelola (Pengelola.html:3376-3390).
3d. Tombol di card-head daftar (Dashboard.html:1240-1244), di samping teks "Menampilkan…":
    tiga btn btn-sm — "Excel", "CSV", "PDF" — ikon fa-solid fa-file-excel / fa-file-csv / fa-file-pdf,
    :disabled="!usulanDoiTersaring.length".

Kriteria selesai:
- Excel & CSV terunduh, jumlah baris = angka "Menampilkan X"; filter status+bulan tercermin.
- CSV dibuka di Excel: WhatsApp tetap "+62…", tanggal "10 Sep 2026", huruf non-ASCII utuh
  (kalau rusak karena tanpa BOM, catat — jangan tambah library).
- PDF: Ctrl+P dari tombol PDF hanya berisi judul, keterangan filter, dan tabel; tanpa sidebar/topbar.
- Cetak di Pengelola (Persiapan Akreditasi) tetap sama (cek preview pengelola, emulasi media print).
- Ekspor di tab lain (Daftar Jurnal, APC) tetap .xlsx.

──────────────────────────────────────────────────────────────────────────────
TAHAP 4 — Konfirmasi DOI aktif oleh pengelola (B7)
File: Code.js, Pengelola.html, JavaScript.html, Dashboard.html
Model: status TETAP 'BERHASIL'. Konfirmasi disimpan di kolom baru, bukan status baru
(status baru merusak bacaJurnalPunyaDoi_ Code.js:5745, kirimUlangReceiptDoi :3902,
validasi dropdown sheet :3091-3098, dropdown admin Dashboard.html:1799).

4a. Code.js DOI_HEADERS (baris 3028-3062): tambah DI AKHIR
      'konfirmasi_pengelola',   // '' | 'AKTIF' | 'KLARIFIKASI'
      'catatan_klarifikasi',
      'konfirmasi_pada'
    Migrasi otomatis lewat migrasiHeaderDoiJikaPerlu_ (tidak perlu kode migrasi baru).
4b. Code.js fungsi publik baru `konfirmasiAktifDoi(token, payload)` diletakkan setelah
    perbaruiUsulanDoi (baris 3709). Salin kerangka perbaruiUsulanDoi (3611-3709):
    - bacaToken_(token,'edit_') → sesiHabis_() bila null.
    - payload {id_usulan, hasil:'AKTIF'|'KLARIFIKASI', catatan}. hasil lain → ok:false.
      KLARIFIKASI wajib catatan trim ≥10 karakter ("Sebutkan DOI atau judul artikel yang belum aktif.").
    - LockService tryLock(20000); cari baris via kolom id_usulan (pola 3632-3641).
    - Kepemilikan: norm_(lama.nama_jurnal) !== norm_(muatan.namaJurnal) → 'Usulan ini bukan milik jurnal Anda.'
    - String(lama.status).trim().toUpperCase() !== 'BERHASIL' → ok:false,
      'Konfirmasi hanya untuk usulan berstatus Berhasil.'
    - lama.konfirmasi_pengelola === 'KLARIFIKASI' → ok:false,
      'Klarifikasi sebelumnya masih ditindaklanjuti DJPI.'
    - info.peta['konfirmasi_pengelola'] === undefined → ok:false (kolom belum ada).
    - Tulis: konfirmasi_pengelola=hasil; catatan_klarifikasi = hasil==='KLARIFIKASI' ? aman_(catatan) : '';
      konfirmasi_pada=new Date(). SpreadsheetApp.flush().
    - catatAktivitas_(pelakuEdit_(muatan), muatan.namaJurnal, aksiEdit_(muatan,'KONFIRMASI_DOI'),
        id + ': ' + hasil + (catatan ? ' — ' + catatan : ''))
    - return {ok:true, message, item: barisDoiKeObjek_(info, rowBaru)}.
    JANGAN menulis status, catatan_admin, diproses_*, doi_aktif_pada, receipt_*.
4c. Code.js ubahStatusUsulanDoi:
    - di dalam blok `if (status === 'BERHASIL' && statusLama !== 'BERHASIL')` (baris 3837):
      tambah `tulis('konfirmasi_pengelola', '');` (aktivasi ulang = pengelola cek ulang).
    - setelah baris 3835: bila payload.klarifikasi_selesai === true && status === 'BERHASIL'
      && item.konfirmasi_pengelola === 'KLARIFIKASI' → tulis('konfirmasi_pengelola','');
      tambahkan ' | klarifikasi ditindaklanjuti' ke detail catatAktivitas_ baris 3845-3846.
      catatan_klarifikasi dibiarkan (jejak).
4d. Pengelola.html kolom Aksi riwayat (baris 361-368): urutan cabang
      doiBisaDiedit(d) → tombol Edit/Perbaiki (tetap)
      d.status==='BERHASIL' && !d.konfirmasi_pengelola → dua btn-sm: "Aktif" dan "Klarifikasi"
      d.status==='BERHASIL' && d.konfirmasi_pengelola==='AKTIF' → teks kecil "terkonfirmasi aktif"
      d.status==='BERHASIL' && d.konfirmasi_pengelola==='KLARIFIKASI' → teks kecil "menunggu DJPI"
      selain itu → "sudah diproses" (tetap)
    Di sel Status (setelah baris 359): bila KLARIFIKASI tampilkan catatan_klarifikasi (teks-kecil teks-lembut).
    - data(): konfirmasiDoi: null (item), catatanKlarifikasi: '', mengonfirmasiDoi: false.
    - "Aktif": confirm('Semua DOI pada usulan ini sudah aktif dan dapat di-resolve?') → kirimKonfirmasiDoi(d,'AKTIF').
    - "Klarifikasi": set konfirmasiDoi=d → tampilkan card kecil di bawah tabel riwayat (di dalam card
      baris 321-373): judul item, textarea wajib "DOI yang belum aktif (tulis DOI atau judul artikel)",
      tombol Batal & Kirim klarifikasi (disabled bila trim < 10 atau mengonfirmasiDoi).
    - kirimKonfirmasiDoi(d, hasil): pola google.script.run seperti kirimUsulanDoi (2340-2385):
      SESSION_EXPIRED → keluar(); gagal → galatPanel; sukses → toastPanel=res.message,
      tutup card, muatRiwayatDoi().
    Tambahkan mock di preview pengelola: item BERHASIL tanpa konfirmasi, item AKTIF, item
    KLARIFIKASI, dan handler `konfirmasiAktifDoi`.
4e. JavaScript.html + Dashboard.html (admin):
    - Sel status tabel (Dashboard.html:1279-1281): di bawah badge, bila d.status==='BERHASIL':
      konfirmasi 'AKTIF' → <span class="badge badge-ok">Terkonfirmasi aktif</span>;
      'KLARIFIKASI' → <span class="badge badge-bahaya">Klarifikasi</span>.
    - Filter status (Dashboard.html:1221): tambahkan `<option value="__KLARIFIKASI">Berhasil · perlu klarifikasi</option>`
      setelah v-for. usulanDoiTersaring: bila st==='__KLARIFIKASI' → lolos hanya
      d.status==='BERHASIL' && d.konfirmasi_pengelola==='KLARIFIKASI'; selain itu perilaku lama.
      JANGAN menambah opsi ini ke statusDoiOptions (dipakai dropdown modal baris 1799).
    - Modal (setelah blok Tanda terima, sebelum </dl> baris 1794), bila status BERHASIL:
      <dt>Konfirmasi pengelola</dt> berisi: belum ('Belum dikonfirmasi') / 'Aktif' / 'Klarifikasi',
      + tglIndo(konfirmasi_pada,true), + catatan_klarifikasi bila ada.
    - Bila konfirmasi_pengelola==='KLARIFIKASI': checkbox di atas field Catatan admin
      "Klarifikasi sudah ditindaklanjuti — minta pengelola cek ulang" (v-model doiTerpilih.klarifikasi_selesai),
      dengan hint "Tulis hasil tindak lanjut di Catatan admin; pengelola melihatnya di riwayat."
    - simpanStatusDoi payload (JavaScript.html:713-717): tambah klarifikasi_selesai: this.doiTerpilih.klarifikasi_selesai===true.
    - Tahap 3 barisEksporDoi: tambah kolom 'Konfirmasi Pengelola' dan 'Catatan Klarifikasi'.

Kriteria selesai:
- Server (uji di /dev setelah push, pakai sheet nyata):
  * Membuka tab DOI menambah 3 header baru di ujung sheet Usulan_DOI; data lama utuh.
  * konfirmasiAktifDoi dengan token jurnal lain → 'bukan milik jurnal Anda'; status selain BERHASIL
    → ditolak; KLARIFIKASI tanpa catatan → ditolak; dua kali KLARIFIKASI → ditolak.
  * Log_Aktivitas mencatat KONFIRMASI_DOI (atas nama admin tercatat lewat pelakuEdit_).
  * Admin centang tindak lanjut + simpan → konfirmasi_pengelola kosong, status tetap BERHASIL,
    TIDAK ada email aktivasi terkirim (statusLama sudah BERHASIL).
  * Admin ubah BERHASIL → SEDANG_DIPROSES → BERHASIL → konfirmasi kosong lagi.
  * Checklist akreditasi "DOI aktif" jurnal yang sudah konfirmasi tetap lulus.
- UI (preview): semua cabang kolom Aksi pengelola tampil benar; tombol Edit/Perbaiki untuk
  MENUNGGU_VALIDASI/PERLU_REVISI tidak berubah; filter "perlu klarifikasi" admin berfungsi dan
  bisa digabung dengan filter bulan; dropdown status di modal tetap 6 opsi.
```

---

## 5. Keputusan yang dibutuhkan dari user

1. **Model konfirmasi B7.** Default yang direkomendasikan: kolom terpisah `konfirmasi_pengelola`, status tetap BERHASIL. Alternatifnya status baru (`AKTIF_TERKONFIRMASI`/`KLARIFIKASI`), yang menyentuh lima tempat dan membalik checklist akreditasi "DOI aktif" (§1).
2. **PDF.** Default: dialog cetak browser → "Simpan sebagai PDF", tanpa library. Alternatifnya jsPDF + autotable dari cdnjs, yang menghasilkan file langsung tetapi menambah ±400 KB dan dependensi baru.
3. **Tindak lanjut klarifikasi.** Default: admin melihatnya lewat filter/badge di tab Usulan DOI, lalu mencentang "sudah ditindaklanjuti" dan menulis balasan di Catatan admin. Tanpa email ke admin. Alternatifnya email notifikasi ke admin kluster, yang berarti pola baru plus template email baru.
4. **Kolom "DOI diusulkan".** Default: sembunyikan bila kosong, dengan label "Daftar DOI". Alternatifnya menambah input daftar DOI untuk admin saat set BERHASIL, supaya email "DOI Aktif" dan klarifikasi bisa merujuk DOI tertentu. Ini fitur baru.

---

## 6. Tidak dikerjakan

- **Email ke admin saat klarifikasi.** Belum ada pola notifikasi ke admin (`Code.js:1802,1953,2674,3253,3268,3982` semuanya ke pengelola/PIN). Lihat keputusan 3.
- **Input daftar DOI oleh admin / pengisian `doi_diusulkan`.** Fitur baru, bukan perbaikan. Lihat keputusan 4.
- **Ekspor sisi server** (file Drive / `ContentService`). Tidak perlu, karena ekspor klien XLSX sudah terbukti jalan di sembilan tombol yang ada.
- **Menghapus `penulis`** dari form, sheet, server, atau pencarian. User hanya meminta dari panel detail, dan kolom ini wajib untuk jenis artikel (`Pengelola.html:1783`).
- **Badge jumlah klarifikasi di sidebar.** Tab DOI dimuat malas (`JavaScript.html:414`), jadi badge akan kosong sebelum tab dibuka. Membuatnya berarti memuat data DOI saat dashboard dibuka.
- **Rata tengah di tabel riwayat DOI Pengelola** (`Pengelola.html:344,356`). Tidak diminta.
- **Perbandingan `String(Date)` di `perbaruiUsulanDoi`** (`Code.js:3685`). Tidak berbahaya dan di luar scope.
- **Memverifikasi zona waktu spreadsheet.** Disimpulkan sama dengan skrip dari jam `00:00:00`. Formatter baru tidak bergantung padanya.
