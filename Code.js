/**
 * DJPI Dashboard UPI — Code.gs
 * Divisi Jurnal dan Publikasi Ilmiah, Universitas Pendidikan Indonesia
 *
 * Aturan yang dipegang berkas ini:
 *  - Kolom dibaca lewat nama header, tidak pernah lewat indeks angka tetap.
 *  - Session.getActiveUser() tidak dipakai sama sekali (web app "Anyone").
 *  - Operasi tulis mencari baris berdasarkan NAMA JURNAL saat menulis.
 *  - performa / va / timeliness tidak pernah masuk payload publik.
 *
 * CATATAN OPTIMASI (lihat komentar "OPTIMASI:" di badan kode):
 *  1. getPublicData() dulu memanggil 4 pembacaan sheet mentah (Sitasi_Ringkasan,
 *     Sitasi_Tren, Jurnal_Unggulan, Artikel_Berpengaruh) di SETIAP kunjungan
 *     publik, tanpa cache. Sekarang keempatnya digabung dalam satu cache
 *     (CACHE.CITATION) karena datanya snapshot yang jarang berubah.
 *  2. cariBarisSheet_() dulu memanggil getDataRange().getValues() — menarik
 *     SELURUH sheet (semua baris x semua kolom) hanya untuk mencocokkan satu
 *     nama jurnal saat menyimpan. Sekarang memakai TextFinder (pencocokan
 *     dilakukan di sisi server Sheets) lalu hanya membaca baris yang benar-
 *     benar cocok.
 */

/* ==========================================================================
   0. KONSTANTA
   ========================================================================== */

var SHEET = {
  MAIN: 'Sheet1',
  SCOPUS: 'Sheet 2',
  LOG_APC: 'Log_APC',
  LOG_TERBITAN: 'Log_Terbitan',
  LOG_PENCAIRAN: 'Log_Pencairan_APC',
  ADMIN: 'Daftar_Admin',
  AKTIVITAS: 'Log_Aktivitas',
  SITASI_RINGKASAN: 'Sitasi_Ringkasan',       // snapshot ringkasan Crossref/OpenAlex
  SITASI_TREN: 'Sitasi_Tren',                 // sitasi per tahun
  JURNAL_UNGGULAN: 'Jurnal_Unggulan',         // ranking jurnal berdasarkan sitasi
  ARTIKEL_BERPENGARUH: 'Artikel_Berpengaruh', // artikel dengan sitasi tertinggi
  TEMPLATE_EMAIL: 'Template_Email',           // subjek & isi email otomatis ke pengelola, bisa diedit admin
  VERIFIKASI_DOAJ: 'Verifikasi_DOAJ'          // snapshot hasil pengecekan DOAJ per jurnal (lihat section 22)
};

var CACHE = {
  JOURNALS: 'journals_v2', // bentuk payload jurnal memuat dq, cache lama wajib ditinggalkan
  JOURNALS_TTL: 300,
  SCOPUS_RAW: 'scopus_raw_v1',
  SCOPUS_RAW_TTL: 600, // cache terpisah untuk sheet pipeline Scopus
  APC_LOG: 'apc_log_v1',
  APC_LOG_TTL: 600, // cache terpisah untuk log APC
  CITATION: 'citation_v1', // OPTIMASI 1: cache terpadu untuk 4 sheet snapshot sitasi
  CITATION_TTL: 3600, // snapshot statis (diupdate manual) — aman di-cache 1 jam
  PIN_TTL: 300,
  SESSION_TTL: 14400,
  EDIT_TTL: 3600,
  PENCAIRAN_LOG: 'pencairan_apc_log_v1',
  PENCAIRAN_LOG_TTL: 600,
  TERBITAN_LOG: 'terbitan_log_v1',
  TERBITAN_LOG_TTL: 600, // cache terpisah untuk log progress terbitan
  TEMPLATE_EMAIL: 'template_email_v1',
  TEMPLATE_EMAIL_TTL: 3600, // jarang berubah, di-invalidate manual tiap kali admin menyimpan
  DOAJ: 'doaj_v1',
  DOAJ_TTL: 3600, // snapshot hasil verifikasi DOAJ, diperbarui trigger harian
  MAX_VALUE_BYTES: 90000
};

var RATE_LIMIT = { MAX: 5, WINDOW_MS: 60 * 60 * 1000 };
var PIN_GUARD = { MAX_ATTEMPTS: 5, LOCK_TTL: 900, PREFIX: 'pin_guard_' };

var TZ = 'Asia/Jakarta';
var KLUSTER_KOSONG = 'BELUM DIKELOLA';

var BULAN = [
  { nama: 'Januari',   pola: /\bJAN/ },
  { nama: 'Februari',  pola: /\bFEB|\bPEB/ },
  { nama: 'Maret',     pola: /\bMAR/ },
  { nama: 'April',     pola: /\bAPR/ },
  { nama: 'Mei',       pola: /\bMEI\b|\bMAY\b/ },
  { nama: 'Juni',      pola: /\bJUN/ },
  { nama: 'Juli',      pola: /\bJUL/ },
  { nama: 'Agustus',   pola: /\bAGU|\bAGS|\bAUG/ },
  { nama: 'September', pola: /\bSEP/ },
  { nama: 'Oktober',   pola: /\bOKT|\bOCT/ },
  { nama: 'November',  pola: /\bNOV|\bNOP/ },
  { nama: 'Desember',  pola: /\bDES|\bDEC/ }
];

/**
 * Definisi field. `alias` berisi kandidat nama header.
 * Pencocokan dilakukan dua tahap: seluruh field dicoba exact-match lebih dulu,
 * baru sisanya dicoba partial-match. Tanpa urutan ini, header "ISSUE" akan
 * salah tertangkap oleh "JUMLAH ARTIKEL TERBIT PER ISSUE".
 */
var FIELD_MAP = {
  no:              { alias: ['No'] },
  namaJurnal:      { alias: ['NAMA JURNAL'], wajib: true },
  kluster:         { alias: ['KLUSTER'], wajib: true },
  unitPengelola:   { alias: ['UNIT PENGELOLA'] },
  linkOjs:         { alias: ['Link OJS 3.5', 'Link OJS', 'LINK OJS'] },
  statusOjs:       { alias: ['STATUS OJS 3.5', 'STATUS OJS'] },
  catatanMigrasi:  { alias: ['CATATAN MIGRASI'] },
  statusAkreditasi:{ alias: ['STATUS AKREDITASI'], wajib: true },
  masaBerlakuSk:   { alias: ['MASA BERLAKU SK AKREDITASI'] },
  apc:             { alias: ['Article Processing Charge (APC)', 'Article Processing Charge', 'APC'] },
  linkApc:         { alias: ['Tautan informasi APC'] },
  tanggalExpired:  { alias: ['TANGGAL EXPIRED'] },
  terakhirLapor:   { alias: ['TERAKHIR LAPOR'] },
  artikelPerIssue: { alias: ['JUMLAH ARTIKEL TERBIT PER ISSUE'] },
  artikelPerTahun: { alias: ['JUMLAH ARTIKEL TERBIT PER TAHUN'] },
  performa:        { alias: ['PERFORMA'] },
  timeliness:      { alias: ['TIMELINESS'] },
  issue:           { alias: ['ISSUE'] },
  jadwalTerbitan:  { alias: ['JADWAL TERBITAN'] },
  issn:            { alias: ['ISSN'] },
  eIssn:           { alias: ['E-ISSN', 'EISSN'] },
  pIssn:           { alias: ['P-ISSN', 'PISSN'] },
  linkGaruda:      { alias: ['LINK GARUDA'] },
  linkDoaj:        { alias: ['LINK DOAJ'] },
  va:              { alias: ['Nomor VA'] },
  namaPengelola:   { alias: ['Nama Pengelola'] },
  email:           { alias: ['Email'] },
  kuartil:         { alias: ['KUARTIL', 'QUARTILE', 'BEREPUTASI'] },
  coverUrl:        { alias: ['Cover URL', 'COVER URL'] },
  scope:           { alias: ['Scope', 'SCOPE', 'About Jurnal'] }
};

/** Field yang boleh disunting pengelola jurnal (token edit). */
var EDITABLE_PENGELOLA = [
  'linkOjs', 'issn', 'eIssn', 'pIssn', 'linkGaruda', 'linkDoaj', 'apc', 'linkApc',
  'namaPengelola', 'email', 'jadwalTerbitan', 'issue',
  'artikelPerIssue', 'artikelPerTahun'
];

/** Tambahan yang boleh disunting admin (token session). */
var EDITABLE_ADMIN = EDITABLE_PENGELOLA.concat([
  'kluster', 'unitPengelola', 'statusOjs', 'catatanMigrasi',
  'statusAkreditasi', 'masaBerlakuSk', 'tanggalExpired',
  'timeliness', 'performa', 'kuartil'
]);

/* ==========================================================================
   1. ROUTING
   ========================================================================== */

function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) ? String(e.parameter.page) : 'landing';
  var isDashboard = (page === 'dashboard');
  var isPengelola = (page === 'pengelola');
  var berkas = isPengelola ? 'Pengelola' : (isDashboard ? 'Dashboard' : 'Landing');
  var judul = isPengelola
    ? 'Dashboard Pengelola Jurnal — DJPI UPI'
    : (isDashboard
      ? 'DJPI Dashboard — Divisi Jurnal dan Publikasi Ilmiah UPI'
      : 'Direktori Jurnal Ilmiah UPI');

  var t = HtmlService.createTemplateFromFile(berkas);

  // Halaman berjalan di dalam iframe sandbox pada origin googleusercontent.com,
  // sehingga href relatif seperti "?page=dashboard" akan mengarah ke origin
  // sandbox dan menghasilkan halaman kosong. Seluruh tautan antar-halaman wajib
  // memakai URL absolut web app.
  var urlDasar = '';
  try { urlDasar = ScriptApp.getService().getUrl() || ''; } catch (err) { urlDasar = ''; }
  t.urlLanding = urlDasar ? (urlDasar + '?page=landing') : '?page=landing';
  t.urlDashboard = urlDasar ? (urlDasar + '?page=dashboard') : '?page=dashboard';
  t.urlPengelola = urlDasar ? (urlDasar + '?page=pengelola') : '?page=pengelola';

  // Jalur pemulihan: token sesi dapat dititipkan lewat parameter ?t= bila
  // pengiriman PIN lewat email sedang bermasalah. Lihat buatSesiDarurat().
  t.tokenAwal = (e && e.parameter && e.parameter.t) ? String(e.parameter.t) : '';

  return t.evaluate()
    .setTitle(judul)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ==========================================================================
   2. UTILITAS DASAR
   ========================================================================== */

function norm_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function str_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  return String(v).trim();
}

function angka_(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  var bersih = String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  var n = parseFloat(bersih);
  return isNaN(n) ? 0 : n;
}

/** Cegah formula injection saat menulis input pengguna ke spreadsheet. */
function aman_(v) {
  var s = String(v === null || v === undefined ? '' : v).trim();
  if (s && /^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

function inisial_(nama) {
  var kata = String(nama || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!kata.length) return 'JR';
  if (kata.length === 1) return kata[0].substring(0, 2).toUpperCase();
  return (kata[0][0] + kata[1][0]).toUpperCase();
}

function sheetWajib_(nama) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nama);
  if (!sh) throw new Error('Sheet "' + nama + '" tidak ditemukan pada spreadsheet ini.');
  return sh;
}

function sheetOpsional_(nama) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nama);
}

/* ==========================================================================
   3. PEMETAAN HEADER
   ========================================================================== */

/**
 * Membangun peta nama-field -> indeks kolom dari baris header.
 * Melempar galat bernama bila field wajib tidak ditemukan. Tidak pernah
 * mengembalikan undefined diam-diam.
 */
function buatHeaderMap_(barisHeader) {
  var headerNorm = barisHeader.map(norm_);
  var terpakai = {};
  var map = {};

  // Tahap 1 — exact match.
  Object.keys(FIELD_MAP).forEach(function (field) {
    var alias = FIELD_MAP[field].alias;
    for (var a = 0; a < alias.length; a++) {
      var target = norm_(alias[a]);
      for (var i = 0; i < headerNorm.length; i++) {
        if (!terpakai[i] && headerNorm[i] === target) {
          map[field] = i; terpakai[i] = true; return;
        }
      }
    }
  });

  // Tahap 2 — partial match pada kolom yang belum diklaim.
  Object.keys(FIELD_MAP).forEach(function (field) {
    if (map[field] !== undefined) return;
    var alias = FIELD_MAP[field].alias;
    for (var a = 0; a < alias.length; a++) {
      var target = norm_(alias[a]);
      if (!target) continue;
      for (var i = 0; i < headerNorm.length; i++) {
        if (!terpakai[i] && headerNorm[i] && headerNorm[i].indexOf(target) !== -1) {
          map[field] = i; terpakai[i] = true; return;
        }
      }
    }
  });

  var hilang = Object.keys(FIELD_MAP).filter(function (f) {
    return FIELD_MAP[f].wajib && map[f] === undefined;
  });
  if (hilang.length) {
    throw new Error(
      'Kolom wajib tidak ditemukan pada "' + SHEET.MAIN + '": ' +
      hilang.map(function (f) { return FIELD_MAP[f].alias[0]; }).join(', ') +
      '. Header yang terbaca: ' + barisHeader.join(' | ')
    );
  }
  return map;
}

function ambil_(row, map, field) {
  var i = map[field];
  return (i === undefined) ? '' : str_(row[i]);
}

/* ==========================================================================
   4. NORMALISASI NILAI TIDAK BAKU
   ========================================================================== */

/** Status OJS bernilai tidak baku. Jangan pernah exact-match. */
function sudahMigrasi_(statusOjs) {
  var s = norm_(statusOjs);
  if (!s) return false;
  if (s.indexOf('BELUM') !== -1) return false;
  return s.indexOf('SUDAH') !== -1 || /OJS\s*3/.test(s);
}

function peringkatSinta_(statusAkreditasi) {
  var m = norm_(statusAkreditasi).match(/SINTA\s*([1-6])/);
  return m ? parseInt(m[1], 10) : 0;
}

function terakreditasi_(statusAkreditasi) {
  return peringkatSinta_(statusAkreditasi) > 0;
}

/** Kosong berarti Belum Dinilai — bukan Tepat Waktu. */
function kategoriTimeliness_(nilai) {
  var s = norm_(nilai);
  if (!s) return 'Belum Dinilai';
  if (s.indexOf('TEPAT') !== -1) return 'Tepat Waktu';
  if (s.indexOf('TERLAMBAT') !== -1) return 'Terlambat';
  if (s.indexOf('HUTANG') !== -1) return 'Punya Hutang Terbitan';
  return 'Belum Dinilai';
}

function klusterAtau_(nilai) {
  var s = str_(nilai);
  return s ? s.toUpperCase() : KLUSTER_KOSONG;
}

function bulanDariJadwal_(jadwal) {
  var s = norm_(jadwal);
  var hasil = [];
  if (!s) return hasil;
  for (var i = 0; i < BULAN.length; i++) {
    if (BULAN[i].pola.test(s)) hasil.push(i);
  }
  return hasil;
}

/* ==========================================================================
   4B. DATA QUALITY ENGINE
   --------------------------------------------------------------------------
   Seluruh penilaian kualitas data dihitung di server. Frontend hanya
   menampilkan hasilnya, tidak pernah menghitung ulang.

   Tiga jenis status per field:
     valid   -> nilai dapat dipakai sistem
     kosong  -> field belum diisi           (jenis masalah 'kosong')
     rusak   -> field terisi tetapi invalid (jenis masalah 'rusak')

   Empat level risiko per jurnal:
     kritis          -> menghambat operasional (hutang terbitan, kontak/OJS mati)
     perluTindakan   -> perlu program pembinaan (akreditasi, migrasi)
     perluVerifikasi -> ada nilai tetapi formatnya salah / placeholder
     terkendali      -> data inti lengkap dan tidak ada isu mendesak
   ========================================================================== */

/** Placeholder yang terlihat "terisi" pada sheet namun bukan data operasional. */
var PLACEHOLDER_PERSIS = {
  'ERROR': 1, 'ERRORNA': 1, 'ERROR NA': 1, '#N/A': 1, 'N/A': 1, 'NA': 1,
  '#VALUE!': 1, 'VALUE!': 1, '#REF!': 1, '#NAME?': 1, '#DIV/0!': 1, '#NULL!': 1,
  '-': 1, '--': 1, '...': 1, '.': 1, '0': 1,
  'BELUM ADA': 1, 'BELUM ADA DATA': 1, 'BELUM': 1, 'TIDAK ADA': 1,
  'TIDAK ADA DATA': 1, 'TIDAK ADA DOMAIN': 1, 'TIDAK DISEBUTKAN': 1,
  'TIDAK TERSEDIA': 1, 'KOSONG': 1, 'NULL': 1, 'NONE': 1, 'UNDEFINED': 1,
  'TITLE': 1, 'TITLE SHEET1': 1, 'SHEET1': 1, 'X': 1, 'XX': 1, 'ISSN': 1
};

/** true bila nilai kosong atau berupa placeholder yang tidak boleh dipercaya. */
function placeholder_(nilai) {
  var s = norm_(nilai);
  if (!s) return true;
  if (PLACEHOLDER_PERSIS[s]) return true;
  if (/^#[A-Z0-9\/!?]+[!?]?$/.test(s)) return true;      // sisa galat formula spreadsheet
  if (/^ERROR/.test(s)) return true;                      // ERROR, ERRORNA, ERROR!, dst
  if (/^VALUE!?$/.test(s)) return true;
  if (/^TITLE\b/.test(s)) return true;
  if (/^BELUM\s+(ADA|TERSEDIA|DIISI|DIDATA)/.test(s)) return true;
  if (/^TIDAK\s+(ADA|TERSEDIA|DISEBUTKAN|DIKETAHUI)/.test(s)) return true;
  if (/^[-–—_.\s]+$/.test(s)) return true;                // hanya tanda hubung/titik
  return false;
}

function emailValid_(nilai) {
  if (placeholder_(nilai)) return false;
  var s = str_(nilai).replace(/^MAILTO:/i, '').trim();
  if (/[\s,;]/.test(s)) return false;                     // dua alamat dalam satu sel
  return /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(s);
}

function urlValid_(nilai) {
  if (placeholder_(nilai)) return false;
  var s = str_(nilai);
  if (!/^https?:\/\//i.test(s)) return false;
  if (/\s/.test(s)) return false;
  return /^https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(\/|:|\?|$)/.test(s);
}

/** Cover jurnal yang dihosting sendiri sebagai data URI base64 (bukan link eksternal). */
function coverDataUriValid_(nilai) {
  var s = str_(nilai);
  return /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s);
}

function issnValid_(nilai) {
  if (placeholder_(nilai)) return false;
  var s = norm_(nilai);
  // Terima satu atau lebih ISSN 8 karakter, dengan atau tanpa tanda hubung.
  return /\b\d{4}-?\d{3}[\dX]\b/.test(s);
}

/** Sama seperti issnValid_, tapi sel harus PERSIS satu ISSN — dipakai untuk kolom E-ISSN/P-ISSN. */
function issnTunggalValid_(nilai) {
  if (placeholder_(nilai)) return false;
  var s = norm_(nilai);
  return /^\d{4}-?\d{3}[\dX]$/.test(s);
}

/** Status akreditasi hanya sah bila terbaca sebagai SINTA 1-6 atau Belum Akreditasi. */
function akreditasiValid_(nilai) {
  if (placeholder_(nilai)) return false;
  var s = norm_(nilai);
  if (/SINTA\s*[1-6]\b/.test(s)) return true;
  if (/BELUM\s*(TER)?AKREDITASI/.test(s)) return true;
  return false;
}

/** Kuartil Scopus hanya diakui bila berpola Q1-Q4 atau menyebut Scopus. */
function kuartilValid_(nilai) {
  if (placeholder_(nilai)) return false;
  var s = norm_(nilai);
  return /\bQ\s*[1-4]\b/.test(s) || /SCOPUS/.test(s);
}

/** APC cukup berupa teks informatif; tidak boleh dipaksa jadi angka. */
function apcValid_(nilai) {
  if (placeholder_(nilai)) return false;
  return norm_(nilai).length >= 3;
}

function namaValid_(nilai) {
  if (placeholder_(nilai)) return false;
  return norm_(nilai).length >= 3;
}

/**
 * Status jadwal terbit. Teks bebas dipertahankan; yang dinilai hanyalah
 * apakah minimal satu nama bulan dapat dikenali.
 *   terbaca | takTerbaca | kosong
 */
function statusJadwal_(nilai, bulanTerbit) {
  if (placeholder_(nilai)) return 'kosong';
  return (bulanTerbit && bulanTerbit.length) ? 'terbaca' : 'takTerbaca';
}

/**
 * Status masa berlaku SK akreditasi.
 *   berlaku | habis | takTerbaca | kosong
 * Tahun diambil dari angka empat digit terakhir yang muncul pada teks.
 */
function statusMasaBerlaku_(nilai) {
  if (placeholder_(nilai)) return 'kosong';
  var s = norm_(nilai);
  if (/SUDAH\s*HABIS|KEDALUWARSA|KADALUARSA|EXPIRED|BERAKHIR/.test(s)) return 'habis';
  var tahun = s.match(/\b(19|20)\d{2}\b/g);
  if (!tahun || !tahun.length) return 'takTerbaca';
  var maks = Math.max.apply(null, tahun.map(Number));
  var tahunIni = Number(Utilities.formatDate(new Date(), TZ, 'yyyy'));
  return (maks < tahunIni) ? 'habis' : 'berlaku';
}

/** Field inti yang dipakai menghitung kelengkapan profil jurnal. */
var FIELD_INTI = [
  { k: 'kluster',          l: 'Kluster' },
  { k: 'statusAkreditasi', l: 'Status akreditasi' },
  { k: 'jadwalTerbitan',   l: 'Jadwal terbitan' },
  { k: 'linkOjs',          l: 'Link OJS' },
  { k: 'email',            l: 'Email pengelola' },
  { k: 'namaPengelola',    l: 'Nama pengelola' },
  { k: 'issn',             l: 'ISSN' },
  { k: 'apc',              l: 'Informasi APC' },
  { k: 'masaBerlakuSk',    l: 'Masa berlaku SK' }
];

/**
 * Jenis masalah pada sebuah field:
 *   kosong -> perlu dilengkapi (sel benar-benar kosong)
 *   rusak  -> perlu diperbaiki (sel terisi tetapi nilainya tidak dapat dipakai)
 */
function jenisMasalah_(nilai) {
  return norm_(nilai) ? 'rusak' : 'kosong';
}

var LABEL_JENIS = {
  kosong: 'Perlu dilengkapi',
  rusak: 'Perlu diperbaiki',
  kondisi: 'Perlu ditindak'
};

var LABEL_LEVEL = {
  kritis: 'Kritis',
  perluTindakan: 'Perlu tindakan',
  perluVerifikasi: 'Perlu verifikasi',
  terkendali: 'Terkendali'
};

/**
 * Menilai satu jurnal. Menerima objek jurnal yang sudah punya field mentah,
 * mengembalikan objek dq yang siap dikirim ke frontend.
 *
 * berat: 3 = kritis, 2 = perlu tindakan, 1 = perlu verifikasi
 * jenis: 'kosong' | 'rusak' = masalah data, 'kondisi' = kondisi operasional jurnal
 */
function nilaiKualitas_(j) {
  var masalah = [];
  function catat(field, label, jenis, nilai, pesan, berat) {
    masalah.push({
      field: field,
      label: label,
      jenis: jenis,
      labelJenis: LABEL_JENIS[jenis],
      nilai: String(nilai == null ? '' : nilai).substring(0, 60),
      pesan: pesan,
      berat: berat
    });
  }

  // -- Kontak pengelola: penentu bisa tidaknya PIN dan pengingat terkirim ----
  if (!j.punyaEmail) {
    if (placeholder_(j.email)) {
      catat('email', 'Email pengelola', jenisMasalah_(j.email), j.email,
        'Tidak ada email pengelola yang dapat dihubungi, sehingga PIN dan pengingat terbitan tidak dapat dikirim.', 3);
    } else {
      catat('email', 'Email pengelola', 'rusak', j.email,
        'Format email tidak valid, sehingga PIN dan pengingat terbitan pasti gagal terkirim.', 3);
    }
  }

  // -- Kanal publik ----------------------------------------------------------
  if (!j.linkOjsValid) {
    catat('linkOjs', 'Link OJS', jenisMasalah_(j.linkOjs), j.linkOjs,
      placeholder_(j.linkOjs)
        ? 'Jurnal belum memiliki alamat OJS yang dapat dibuka publik.'
        : 'Nilai bukan URL http/https yang sah, sehingga tautan disembunyikan dari halaman publik.', 3);
  }

  // -- Kepatuhan terbitan ----------------------------------------------------
  if (j.kategoriTimeliness === 'Punya Hutang Terbitan') {
    catat('timeliness', 'Kepatuhan terbitan', 'kondisi', j.timeliness,
      'Jurnal memiliki hutang terbitan dan harus diselesaikan lebih dulu.', 3);
  } else if (j.kategoriTimeliness === 'Terlambat') {
    catat('timeliness', 'Kepatuhan terbitan', 'kondisi', j.timeliness,
      'Terbitan terlambat dari jadwal yang terdaftar.', 2);
  } else if (j.kategoriTimeliness === 'Belum Dinilai') {
    catat('timeliness', 'Kepatuhan terbitan', jenisMasalah_(j.timeliness), j.timeliness,
      'Kepatuhan terbitan belum dinilai, sehingga jurnal tidak terpantau.', 1);
  }

  // -- Akreditasi ------------------------------------------------------------
  if (!akreditasiValid_(j.statusAkreditasi)) {
    catat('statusAkreditasi', 'Status akreditasi', jenisMasalah_(j.statusAkreditasi), j.statusAkreditasi,
      'Status akreditasi tidak terbaca sebagai SINTA 1 sampai SINTA 6 atau Belum Akreditasi.', 1);
  } else if (!j.terakreditasi) {
    catat('statusAkreditasi', 'Status akreditasi', 'kondisi', j.statusAkreditasi,
      'Belum terakreditasi SINTA. Kandidat program pembinaan.', 2);
  }

  if (j.terakreditasi) {
    var masa = statusMasaBerlaku_(j.masaBerlakuSk);
    if (masa === 'habis') {
      catat('masaBerlakuSk', 'Masa berlaku SK', 'kondisi', j.masaBerlakuSk,
        'Masa berlaku SK akreditasi tampak sudah terlewat. Perlu diproses reakreditasi.', 2);
    } else if (masa === 'kosong') {
      catat('masaBerlakuSk', 'Masa berlaku SK', jenisMasalah_(j.masaBerlakuSk), j.masaBerlakuSk,
        'Masa berlaku SK belum tercatat, sehingga jadwal reakreditasi tidak terpantau.', 2);
    } else if (masa === 'takTerbaca') {
      catat('masaBerlakuSk', 'Masa berlaku SK', 'rusak', j.masaBerlakuSk,
        'Masa berlaku SK tidak dapat dibaca sebagai tahun atau rentang tahun.', 1);
    }
  }

  // -- Migrasi OJS -----------------------------------------------------------
  if (!j.sudahMigrasi) {
    if (placeholder_(j.statusOjs)) {
      catat('statusOjs', 'Status migrasi OJS', jenisMasalah_(j.statusOjs), j.statusOjs,
        'Status migrasi OJS belum tercatat, sehingga progres migrasi tidak terpantau.', 2);
    } else {
      catat('statusOjs', 'Status migrasi OJS', 'kondisi', j.statusOjs,
        'Belum migrasi ke OJS 3.5.', 2);
    }
  }

  // -- Kluster: penentu siapa admin penanggung jawab -------------------------
  if (placeholder_(j.kluster) || j.kluster === KLUSTER_KOSONG) {
    catat('kluster', 'Kluster', 'kosong', j.kluster,
      'Jurnal belum masuk kluster mana pun, sehingga tidak ada admin penanggung jawab.', 2);
  }

  // -- Jadwal terbitan: penentu masuk tidaknya pengingat bulanan -------------
  if (j.statusJadwal === 'kosong') {
    catat('jadwalTerbitan', 'Jadwal terbitan', jenisMasalah_(j.jadwalTerbitan), j.jadwalTerbitan,
      'Jadwal terbit belum tercatat, sehingga jurnal tidak pernah masuk pengingat bulanan.', 2);
  } else if (j.statusJadwal === 'takTerbaca') {
    catat('jadwalTerbitan', 'Jadwal terbitan', 'rusak', j.jadwalTerbitan,
      'Jadwal terisi tetapi tidak ada nama bulan yang dapat dikenali sistem, sehingga jurnal tidak masuk pengingat bulanan.', 1);
  }

  // -- Identitas dan metadata publik ----------------------------------------
  if (!j.issnValid) {
    catat('issn', 'ISSN', jenisMasalah_(j.issn), j.issn,
      placeholder_(j.issn)
        ? 'ISSN belum tercatat.'
        : 'Nilai ISSN tidak mengikuti pola delapan karakter, contoh 2085-1243.', 1);
  }
  if (!namaValid_(j.namaPengelola)) {
    catat('namaPengelola', 'Nama pengelola', jenisMasalah_(j.namaPengelola), j.namaPengelola,
      'Nama pengelola jurnal belum tercatat dengan jelas.', 1);
  }
  if (!apcValid_(j.apc)) {
    catat('apc', 'Informasi APC', jenisMasalah_(j.apc), j.apc,
      'Informasi tarif APC belum dapat ditampilkan ke publik.', 1);
  }

  // -- Tautan opsional: hanya dinilai bila memang diklaim terisi ------------
  if (!placeholder_(j.linkGaruda) && !j.terindeksGaruda) {
    catat('linkGaruda', 'Link Garuda', 'rusak', j.linkGaruda,
      'Nilai terisi tetapi bukan URL sah, sehingga tautan disembunyikan dari halaman publik.', 1);
  }
  if (!placeholder_(j.linkDoaj) && !j.terindeksDoaj) {
    catat('linkDoaj', 'Link DOAJ', 'rusak', j.linkDoaj,
      'Nilai terisi tetapi bukan URL sah, sehingga tautan disembunyikan dari halaman publik.', 1);
  }

  // -- Silang dengan snapshot verifikasi DOAJ (section 22) ------------------
  // HANYA status definitif yang dinilai. '' (belum dicek / ISSN tak sah) dan
  // 'GAGAL' (API bermasalah) sengaja dilewati — lihat aturan 1 di section 22.
  // Kedua cabang di bawah saling eksklusif dengan pemeriksaan format di atas.
  if (j.doajStatus === 'TERINDEKS' && placeholder_(j.linkDoaj)) {
    catat('linkDoaj', 'Link DOAJ', 'kosong', j.linkDoaj,
      'Terverifikasi terindeks DOAJ' + (j.doajJudul ? ' sebagai "' + j.doajJudul + '"' : '') +
      ', tetapi tautan DOAJ belum tercatat di direktori.', 1);
  } else if (j.doajStatus === 'TIDAK DITEMUKAN' && j.terindeksDoaj) {
    catat('linkDoaj', 'Link DOAJ', 'rusak', j.linkDoaj,
      'Tautan DOAJ tercatat, tetapi ISSN jurnal ini tidak ditemukan di DOAJ pada pengecekan terakhir. ' +
      'Perlu diverifikasi — bisa jadi ISSN yang tercatat keliru.', 1);
  }
  if (!placeholder_(j.linkApc) && !j.linkApcValid) {
    catat('linkApc', 'Tautan informasi APC', 'rusak', j.linkApc,
      'Nilai terisi tetapi bukan URL sah, sehingga tautan disembunyikan dari halaman publik.', 1);
  }
  if (!placeholder_(j.kuartil) && !j.bereputasi) {
    catat('kuartil', 'Kuartil Scopus', 'rusak', j.kuartil,
      'Nilai kuartil tidak terbaca sebagai Q1 sampai Q4, sehingga jurnal ini tidak dihitung sebagai jurnal bereputasi.', 1);
  }

  // -- Rangkuman -------------------------------------------------------------
  var kritis = 0, tindakan = 0, verifikasi = 0;
  var perluDilengkapi = 0, perluDiperbaiki = 0, perluDitindak = 0;
  masalah.forEach(function (m) {
    if (m.berat === 3) kritis++; else if (m.berat === 2) tindakan++; else verifikasi++;
    if (m.jenis === 'kosong') perluDilengkapi++;
    else if (m.jenis === 'rusak') perluDiperbaiki++;
    else perluDitindak++;
  });

  var level = 'terkendali';
  if (kritis) level = 'kritis';
  else if (tindakan) level = 'perluTindakan';
  else if (verifikasi) level = 'perluVerifikasi';

  // Kelengkapan hanya menghitung masalah data, bukan kondisi operasional.
  var fieldBermasalah = {};
  masalah.forEach(function (m) {
    if (m.jenis !== 'kondisi') fieldBermasalah[m.field] = true;
  });
  var lengkap = 0;
  FIELD_INTI.forEach(function (f) { if (!fieldBermasalah[f.k]) lengkap++; });

  return {
    level: level,
    labelLevel: LABEL_LEVEL[level],
    skor: kritis * 100 + tindakan * 10 + verifikasi,
    kritis: kritis,
    tindakan: tindakan,
    verifikasi: verifikasi,
    perluDilengkapi: perluDilengkapi,
    perluDiperbaiki: perluDiperbaiki,
    perluDitindak: perluDitindak,
    jumlahMasalah: masalah.length,
    lengkap: lengkap,
    totalInti: FIELD_INTI.length,
    persenLengkap: Math.round((lengkap / FIELD_INTI.length) * 100),
    masalah: masalah
  };
}

/** Rekap kualitas data untuk kartu dan daftar antrean di dashboard admin. */
function rekapKualitas_(daftar) {
  var hasil = {
    total: daftar.length,
    kritis: 0, perluTindakan: 0, perluVerifikasi: 0, terkendali: 0,
    bermasalah: 0,
    perluDilengkapi: 0, perluDiperbaiki: 0, perluDitindak: 0,
    totalMasalah: 0,
    persenTerkendali: 0,
    rataLengkap: 0,
    ringkas: []
  };

  var hitungField = {};
  var jumlahLengkap = 0, totalInti = FIELD_INTI.length;
  // rekap status verifikasi DOAJ (section 22), ditampilkan sebagai catatan di tab Kualitas Data
  var doaj = { terakhirDicek: '', terindeks: 0, tidakDitemukan: 0, gagal: 0, belumDicek: 0 };

  daftar.forEach(function (j) {
    var dq = j.dq || { level: 'terkendali', masalah: [], lengkap: totalInti };
    hasil[dq.level]++;
    if (dq.level !== 'terkendali') hasil.bermasalah++;
    hasil.totalMasalah += (dq.jumlahMasalah || 0);
    hasil.perluDilengkapi += (dq.perluDilengkapi || 0);
    hasil.perluDiperbaiki += (dq.perluDiperbaiki || 0);
    hasil.perluDitindak += (dq.perluDitindak || 0);
    jumlahLengkap += (dq.lengkap || 0);

    if (j.doajStatus === 'TERINDEKS') doaj.terindeks++;
    else if (j.doajStatus === 'TIDAK DITEMUKAN') doaj.tidakDitemukan++;
    else if (j.doajStatus === 'GAGAL') doaj.gagal++;
    else doaj.belumDicek++;
    if (j.doajDicek && j.doajDicek > doaj.terakhirDicek) doaj.terakhirDicek = j.doajDicek;

    (dq.masalah || []).forEach(function (m) {
      var kunci = m.field + '|' + m.jenis;
      if (!hitungField[kunci]) {
        hitungField[kunci] = {
          field: m.field, label: m.label, jenis: m.jenis,
          labelJenis: m.labelJenis, berat: m.berat, jumlah: 0
        };
      }
      hitungField[kunci].jumlah++;
    });
  });

  hasil.ringkas = Object.keys(hitungField).map(function (k) { return hitungField[k]; })
    .sort(function (a, b) {
      if (b.berat !== a.berat) return b.berat - a.berat;
      return b.jumlah - a.jumlah;
    });

  if (hasil.total) {
    hasil.persenTerkendali = Math.round((hasil.terkendali / hasil.total) * 100);
    hasil.rataLengkap = Math.round((jumlahLengkap / (hasil.total * totalInti)) * 100);
  }
  hasil.totalInti = totalInti;
  hasil.fieldInti = FIELD_INTI;
  hasil.doaj = doaj; // baru: status snapshot verifikasi DOAJ

  return hasil;
}

/* ==========================================================================
   5. AKSES DATA JURNAL
   ========================================================================== */

/* Cache berpotong. Payload jurnal memuat penilaian kualitas data sehingga
   melewati batas 100 KB per satu nilai cache. JSON dipecah menjadi beberapa
   potongan di bawah batas, lalu disatukan kembali saat dibaca. */
var CACHE_POTONG_MAKS = 20; // 20 x 90 KB cukup untuk skala ribuan baris

function bacaCachePotong_(cache, prefix) {
  var meta = cache.get(prefix + '_meta');
  if (!meta) return null;
  var jumlah = Number(meta);
  if (!jumlah || jumlah > CACHE_POTONG_MAKS) return null;

  var kunci = [];
  for (var i = 0; i < jumlah; i++) kunci.push(prefix + '_' + i);

  var peta = cache.getAll(kunci);
  var gabung = '';
  for (var k = 0; k < jumlah; k++) {
    var bagian = peta[prefix + '_' + k];
    if (bagian === undefined || bagian === null) return null; // satu potongan hangus, cache dianggap batal
    gabung += bagian;
  }
  try { return JSON.parse(gabung); } catch (err) { return null; }
}

function tulisCachePotong_(cache, prefix, json, ttl) {
  var ukuran = CACHE.MAX_VALUE_BYTES;
  var jumlah = Math.ceil(json.length / ukuran);
  if (jumlah > CACHE_POTONG_MAKS) return; // terlalu besar, lewati cache

  var muatan = {};
  for (var i = 0; i < jumlah; i++) {
    muatan[prefix + '_' + i] = json.substring(i * ukuran, (i + 1) * ukuran);
  }
  muatan[prefix + '_meta'] = String(jumlah);
  cache.putAll(muatan, ttl);
}

function hapusCachePotong_(cache, prefix) {
  var kunci = [prefix, prefix + '_meta'];
  for (var i = 0; i < CACHE_POTONG_MAKS; i++) kunci.push(prefix + '_' + i);
  cache.removeAll(kunci);
}

function bacaDataJurnal_() {
  var cache = CacheService.getScriptCache();
  var tersimpan = bacaCachePotong_(cache, CACHE.JOURNALS); // cache berpotong
  if (tersimpan) return tersimpan;

  var sh = sheetWajib_(SHEET.MAIN);
  var nilai = sh.getDataRange().getValues();
  if (nilai.length < 2) return [];

  var map = buatHeaderMap_(nilai[0]);
  var petaDoaj = bacaVerifikasiDoaj_(); // snapshot verifikasi DOAJ (section 22), dibaca SEKALI di luar loop
  var hasil = [];

  for (var r = 1; r < nilai.length; r++) {
    var row = nilai[r];
    var nama = ambil_(row, map, 'namaJurnal');
    if (!nama) continue;

    var doaj = petaDoaj[norm_(nama)] || {};

    var statusAkr = ambil_(row, map, 'statusAkreditasi');
    var statusOjs = ambil_(row, map, 'statusOjs');
    var kuartil = ambil_(row, map, 'kuartil');
    var linkDoaj = ambil_(row, map, 'linkDoaj');
    var linkGaruda = ambil_(row, map, 'linkGaruda');
    var linkOjs = ambil_(row, map, 'linkOjs');
    var linkApc = ambil_(row, map, 'linkApc');
    var email = ambil_(row, map, 'email');
    var jadwal = ambil_(row, map, 'jadwalTerbitan');
    var bulanTerbit = bulanDariJadwal_(jadwal);

    var j = {
      no: ambil_(row, map, 'no'),
      namaJurnal: nama,
      kluster: klusterAtau_(ambil_(row, map, 'kluster')),
      unitPengelola: ambil_(row, map, 'unitPengelola'),
      linkOjs: linkOjs,
      statusOjs: statusOjs,
      sudahMigrasi: sudahMigrasi_(statusOjs),
      catatanMigrasi: ambil_(row, map, 'catatanMigrasi'),
      statusAkreditasi: statusAkr || 'Belum Akreditasi',
      peringkatSinta: peringkatSinta_(statusAkr),
      terakreditasi: terakreditasi_(statusAkr),
      masaBerlakuSk: ambil_(row, map, 'masaBerlakuSk'),
      apc: ambil_(row, map, 'apc'),
      linkApc: linkApc,
      tanggalExpired: ambil_(row, map, 'tanggalExpired'),
      terakhirLapor: ambil_(row, map, 'terakhirLapor'),
      artikelPerIssue: ambil_(row, map, 'artikelPerIssue'),
      artikelPerTahun: ambil_(row, map, 'artikelPerTahun'),
      performa: ambil_(row, map, 'performa'),
      timeliness: ambil_(row, map, 'timeliness'),
      kategoriTimeliness: kategoriTimeliness_(ambil_(row, map, 'timeliness')),
      issue: ambil_(row, map, 'issue'),
      jadwalTerbitan: jadwal,
      bulanTerbit: bulanTerbit,
      statusJadwal: statusJadwal_(jadwal, bulanTerbit), // jadwal terbaca / tak terbaca / kosong
      issn: ambil_(row, map, 'issn'),
      issnValid: issnValid_(ambil_(row, map, 'issn')), // penanda format ISSN
      eIssn: ambil_(row, map, 'eIssn'),
      eIssnValid: issnTunggalValid_(ambil_(row, map, 'eIssn')),
      pIssn: ambil_(row, map, 'pIssn'),
      pIssnValid: issnTunggalValid_(ambil_(row, map, 'pIssn')),
      linkGaruda: linkGaruda,
      linkDoaj: linkDoaj,
      // indeksasi hanya diakui bila tautannya benar-benar URL sah
      terindeksGaruda: urlValid_(linkGaruda),
      terindeksDoaj: urlValid_(linkDoaj),
      linkOjsValid: urlValid_(linkOjs),
      linkApcValid: urlValid_(linkApc),
      va: ambil_(row, map, 'va'),
      namaPengelola: ambil_(row, map, 'namaPengelola'),
      email: email,
      kuartil: kuartil,
      // kuartil placeholder (ERRORNA, VALUE!, dst) tidak dihitung bereputasi
      bereputasi: kuartilValid_(kuartil),
      // email wajib berformat valid agar PIN dan pengingat tidak gagal kirim
      punyaEmail: emailValid_(email),
      inisial: inisial_(nama),
      // hasil verifikasi DOAJ (section 22). '' = belum pernah dicek / ISSN tak sah;
      // 'GAGAL' = API bermasalah. Keduanya BUKAN berarti tidak terindeks.
      doajStatus: doaj.status || '',
      doajJudul: doaj.judul || '',
      doajDicek: doaj.dicek || '',
      coverUrl: ambil_(row, map, 'coverUrl'),
      scope: ambil_(row, map, 'scope')
    };

    j.dq = nilaiKualitas_(j); // penilaian kualitas data per jurnal, dihitung di server
    hasil.push(j);
  }

  // tulis cache berpotong agar payload di atas 100 KB tetap tersimpan
  try {
    tulisCachePotong_(cache, CACHE.JOURNALS, JSON.stringify(hasil), CACHE.JOURNALS_TTL);
  } catch (err) { /* cache opsional, abaikan kegagalan */ }

  return hasil;
}

function bersihkanCacheJurnal_() {
  hapusCachePotong_(CacheService.getScriptCache(), CACHE.JOURNALS); // bersihkan seluruh potongan
  CacheService.getScriptCache().remove(CACHE.SCOPUS_RAW); // invalidasi cache turunan admin
  CacheService.getScriptCache().remove(CACHE.APC_LOG); // invalidasi cache APC bila data dasar jurnal berubah
}

function bersihkanCacheApc_() {
  CacheService.getScriptCache().remove(CACHE.APC_LOG); // invalidasi cache log APC setelah append
}

/**
 * OPTIMASI 1: bersihkan cache snapshot sitasi.
 * Panggil ini dari mana pun Sitasi_Ringkasan/Sitasi_Tren/Jurnal_Unggulan/
 * Artikel_Berpengaruh ditulis ulang (mis. skrip terjadwal harian), agar
 * pengunjung berikutnya tidak melihat data basi sampai TTL habis sendiri.
 */
function bersihkanCacheSitasi_() {
  CacheService.getScriptCache().remove(CACHE.CITATION);
}

function cariJurnal_(daftar, nama) {
  var target = norm_(nama);
  return daftar.filter(function (j) { return norm_(j.namaJurnal) === target; });
}

/* ==========================================================================
   5B. DATA SITASI (Crossref/OpenAlex snapshot)
   --------------------------------------------------------------------------
   Empat sheet opsional: Sitasi_Ringkasan, Sitasi_Tren, Jurnal_Unggulan,
   Artikel_Berpengaruh. Ini bukan pemanggilan API langsung — hanya membaca
   snapshot yang sudah ditulis ke sheet.

   Sengaja TIDAK memakai sheetWajib_/buatHeaderMap_: bagian ini boleh tidak
   ada tanpa membuat getPublicData() gagal total. Setiap fungsi menangkap
   galatnya sendiri dan mengembalikan null/[] bila sheet tidak ada, kosong,
   atau strukturnya rusak, sehingga journals/stats/dll tetap tampil normal.

   OPTIMASI 1: keempat fungsi bacaX_() di bawah ini TIDAK dipanggil langsung
   dari getPublicData() lagi. Dulu setiap kunjungan publik memicu 4 kali
   getDataRange().getValues() tanpa cache. Sekarang seluruhnya dibungkus satu
   kali oleh bacaDataSitasi_() yang di-cache (lihat CACHE.CITATION).
   ========================================================================== */

/** Cari indeks kolom berdasarkan nama header (exact match, case/spasi-insensitive). */
function cariKolom_(headerNorm, namaKolom) {
  var target = norm_(namaKolom);
  for (var i = 0; i < headerNorm.length; i++) {
    if (headerNorm[i] === target) return i;
  }
  return -1;
}

function ambilSel_(row, idx) {
  return idx === -1 ? '' : row[idx];
}

function bacaCitationStats_() {
  try {
    var sh = sheetOpsional_(SHEET.SITASI_RINGKASAN);
    if (!sh) return null;

    var nilai = sh.getDataRange().getValues();
    if (nilai.length < 2) return null;

    var header = nilai[0].map(norm_);
    var idx = {
      tanggal: cariKolom_(header, 'tanggalUpdate'),
      totalDoi: cariKolom_(header, 'totalDoiCrossref'),
      matched: cariKolom_(header, 'doiMatched'),
      sitasiCr: cariKolom_(header, 'totalSitasiCrossref'),
      sitasiOa: cariKolom_(header, 'totalSitasiOpenAlex')
    };

    var row = nilai[1];
    var tanggalRaw = ambilSel_(row, idx.tanggal);
    var tanggalStr = '';
    if (Object.prototype.toString.call(tanggalRaw) === '[object Date]') {
      tanggalStr = Utilities.formatDate(tanggalRaw, TZ, 'd MMMM yyyy');
    } else if (tanggalRaw) {
      tanggalStr = str_(tanggalRaw);
    }

    return {
      tanggalUpdate: tanggalStr,
      totalDoiCrossref: angka_(ambilSel_(row, idx.totalDoi)),
      doiMatched: angka_(ambilSel_(row, idx.matched)),
      totalSitasiCrossref: angka_(ambilSel_(row, idx.sitasiCr)),
      totalSitasiOpenAlex: angka_(ambilSel_(row, idx.sitasiOa))
    };
  } catch (err) {
    console.error('bacaCitationStats_ gagal: ' + err.message);
    return null;
  }
}

function bacaSitasiTren_() {
  try {
    var sh = sheetOpsional_(SHEET.SITASI_TREN);
    if (!sh) return [];

    var nilai = sh.getDataRange().getValues();
    if (nilai.length < 2) return [];

    var header = nilai[0].map(norm_);
    var idx = {
      tahun: cariKolom_(header, 'tahun'),
      sitasiCr: cariKolom_(header, 'totalSitasiCrossref'),
      sitasiOa: cariKolom_(header, 'totalSitasiOpenAlex')
    };

    var hasil = [];
    for (var r = 1; r < nilai.length; r++) {
      var row = nilai[r];
      var tahun = angka_(ambilSel_(row, idx.tahun));
      if (!tahun) continue; // baris tanpa tahun diabaikan, bukan dipaksa jadi 0
      hasil.push({
        tahun: tahun,
        totalSitasiCrossref: angka_(ambilSel_(row, idx.sitasiCr)),
        totalSitasiOpenAlex: angka_(ambilSel_(row, idx.sitasiOa))
      });
    }
    return hasil;
  } catch (err) {
    console.error('bacaSitasiTren_ gagal: ' + err.message);
    return [];
  }
}

function bacaJurnalUnggulan_() {
  try {
    var sh = sheetOpsional_(SHEET.JURNAL_UNGGULAN);
    if (!sh) return [];

    var nilai = sh.getDataRange().getValues();
    if (nilai.length < 2) return [];

    var header = nilai[0].map(norm_);
    // rankingRaw & rankingNormalisasi sengaja tidak dipetakan — frontend
    // menghitung ranking tampilan sendiri dari totalSitasiOpenAlex dan
    // rataSitasiPerArtikel_OpenAlex.
    var idx = {
      nama: cariKolom_(header, 'namaJurnal'),
      totalArtikel: cariKolom_(header, 'totalArtikel'),
      sitasiCr: cariKolom_(header, 'totalSitasiCrossref'),
      sitasiOa: cariKolom_(header, 'totalSitasiOpenAlex'),
      rataCr: cariKolom_(header, 'rataSitasiPerArtikel_Crossref'),
      rataOa: cariKolom_(header, 'rataSitasiPerArtikel_OpenAlex')
    };

    var hasil = [];
    for (var r = 1; r < nilai.length; r++) {
      var row = nilai[r];
      var nama = str_(ambilSel_(row, idx.nama));
      if (!nama) continue;

      hasil.push({
        namaJurnal: nama,
        totalArtikel: angka_(ambilSel_(row, idx.totalArtikel)),
        totalSitasiCrossref: angka_(ambilSel_(row, idx.sitasiCr)),
        totalSitasiOpenAlex: angka_(ambilSel_(row, idx.sitasiOa)),
        rataSitasiPerArtikel_Crossref: angka_(ambilSel_(row, idx.rataCr)),
        rataSitasiPerArtikel_OpenAlex: angka_(ambilSel_(row, idx.rataOa))
      });
    }
    return hasil;
  } catch (err) {
    console.error('bacaJurnalUnggulan_ gagal: ' + err.message);
    return [];
  }
}

function bacaArtikelBerpengaruh_() {
  try {
    var sh = sheetOpsional_(SHEET.ARTIKEL_BERPENGARUH);
    if (!sh) return [];

    var nilai = sh.getDataRange().getValues();
    if (nilai.length < 2) return [];

    var header = nilai[0].map(norm_);
    var idx = {
      judul: cariKolom_(header, 'judul'),
      nama: cariKolom_(header, 'namaJurnal'),
      doi: cariKolom_(header, 'doi'),
      sitasiCr: cariKolom_(header, 'totalSitasiCrossref'),
      sitasiOa: cariKolom_(header, 'totalSitasiOpenAlex'),
      tahun: cariKolom_(header, 'tahunTerbit'),
      link: cariKolom_(header, 'linkArtikel')
    };

    var hasil = [];
    for (var r = 1; r < nilai.length; r++) {
      var row = nilai[r];
      var judul = str_(ambilSel_(row, idx.judul));
      if (!judul) continue;

      hasil.push({
        judul: judul,
        namaJurnal: str_(ambilSel_(row, idx.nama)),
        doi: str_(ambilSel_(row, idx.doi)),
        totalSitasiCrossref: angka_(ambilSel_(row, idx.sitasiCr)),
        totalSitasiOpenAlex: angka_(ambilSel_(row, idx.sitasiOa)),
        tahunTerbit: angka_(ambilSel_(row, idx.tahun)),
        linkArtikel: str_(ambilSel_(row, idx.link))
      });
    }

    // Diurutkan di server agar slice(0,15) di frontend konsisten walau
    // urutan baris di sheet berubah.
    hasil.sort(function (a, b) { return b.totalSitasiOpenAlex - a.totalSitasiOpenAlex; });
    return hasil;
  } catch (err) {
    console.error('bacaArtikelBerpengaruh_ gagal: ' + err.message);
    return [];
  }
}

/**
 * OPTIMASI 1: satu titik masuk untuk seluruh data snapshot sitasi, di-cache
 * sebagai satu nilai gabungan. Sebelumnya getPublicData() memanggil 4 fungsi
 * bacaX_() di atas secara langsung tanpa cache sama sekali, sehingga setiap
 * kunjungan Landing menghasilkan 4 pembacaan sheet tambahan. Data ini adalah
 * snapshot yang diupdate manual/berkala, jadi TTL 1 jam aman dipakai.
 */
function bacaDataSitasi_() {
  var cache = CacheService.getScriptCache();
  var tersimpan = cache.get(CACHE.CITATION);
  if (tersimpan) {
    try { return JSON.parse(tersimpan); } catch (err) { /* cache rusak, baca ulang */ }
  }

  var hasil = {
    citationStats: bacaCitationStats_(),
    trend: bacaSitasiTren_(),
    topJournals: bacaJurnalUnggulan_(),
    topArticles: bacaArtikelBerpengaruh_()
  };

  try {
    var json = JSON.stringify(hasil);
    if (json.length < CACHE.MAX_VALUE_BYTES) cache.put(CACHE.CITATION, json, CACHE.CITATION_TTL);
    // Catatan: bila suatu saat volume topJournals/topArticles membesar dan
    // melewati MAX_VALUE_BYTES, pola chunking seperti CACHE.JOURNALS di atas
    // (tulisCachePotong_/bacaCachePotong_) dapat dipakai ulang untuk kunci ini.
  } catch (err) { /* cache opsional */ }

  return hasil;
}

/* ==========================================================================
   6. PAYLOAD PUBLIK
   ========================================================================== */

/**
 * Menyusun objek BARU berisi field yang diizinkan saja. Penyaringan terjadi
 * di server, bukan di frontend.
 */
function keJurnalPublik_(j) {
  return {
    namaJurnal: j.namaJurnal,
    kluster: j.kluster,
    unitPengelola: j.unitPengelola,
    // tautan invalid/placeholder dikosongkan agar publik tidak melihat tautan mati
    linkOjs: j.linkOjsValid ? j.linkOjs : '',
    // dihapus: statusOjs & sudahMigrasi (info migrasi internal DJPI, tidak untuk publik)
    statusAkreditasi: akreditasiValid_(j.statusAkreditasi) ? j.statusAkreditasi : 'Belum Akreditasi',
    peringkatSinta: j.peringkatSinta,
    terakreditasi: j.terakreditasi,
    apc: apcValid_(j.apc) ? j.apc : '',
    linkApc: j.linkApcValid ? j.linkApc : '',
    issn: j.issnValid ? j.issn : '',
    eIssn: j.eIssnValid ? j.eIssn : '',
    pIssn: j.pIssnValid ? j.pIssn : '',
    linkGaruda: j.terindeksGaruda ? j.linkGaruda : '',
    linkDoaj: j.terindeksDoaj ? j.linkDoaj : '',
    terindeksGaruda: j.terindeksGaruda,
    terindeksDoaj: j.terindeksDoaj,
    kuartil: j.bereputasi ? j.kuartil : '',
    bereputasi: j.bereputasi,
    punyaEmail: j.punyaEmail,
    inisial: j.inisial,
    jadwalTerbitan: j.jadwalTerbitan, // teks jadwal terbit asli, untuk kartu/modal Landing
    bulanTerbit: j.bulanTerbit || [],  // array bulan (1-12), untuk fitur kartu bulan
    coverUrl: (urlValid_(j.coverUrl) || coverDataUriValid_(j.coverUrl)) ? j.coverUrl : '',
    scope: j.scope || ''
  };
}

function getPublicData() {
  try {
    var semua = bacaDataJurnal_();
    var sitasi = bacaDataSitasi_(); // OPTIMASI 1: 1 cache hit, bukan 4 pembacaan sheet per kunjungan

    return {
      ok: true,
      journals: semua.map(keJurnalPublik_),
      stats: statistikPublik_(semua),
      clusters: rekapKluster_(semua),
      months: rekapBulan_(semua), // dipakai grid 12 kartu bulan di Landing
      citationStats: sitasi.citationStats,
      trend: sitasi.trend,
      topJournals: sitasi.topJournals,
      topArticles: sitasi.topArticles,
      generatedAt: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm')
    };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function statistikPublik_(daftar) {
  var s = { total: daftar.length, terakreditasi: 0, belum: 0, bereputasi: 0, doaj: 0, garuda: 0, sinta: {} };
  for (var i = 1; i <= 6; i++) s.sinta[i] = 0;
  daftar.forEach(function (j) {
    if (j.terakreditasi) { s.terakreditasi++; s.sinta[j.peringkatSinta]++; } else { s.belum++; }
    if (j.bereputasi) s.bereputasi++;
    if (j.terindeksDoaj) s.doaj++;
    if (j.terindeksGaruda) s.garuda++;
  });
  return s;
}

function rekapBulan_(daftar) { // rekap jumlah jurnal per bulan terbit, untuk kartu bulan di Landing
  var hasil = [];
  for (var b = 0; b < 12; b++) hasil.push({ bulan: b, nama: BULAN[b].nama, total: 0 });
  daftar.forEach(function (j) {
    (j.bulanTerbit || []).forEach(function (b) { if (hasil[b]) hasil[b].total++; });
  });
  return hasil;
}

function rekapKluster_(daftar) {
  var peta = {};
  daftar.forEach(function (j) {
    if (!peta[j.kluster]) peta[j.kluster] = { nama: j.kluster, total: 0, terakreditasi: 0, bereputasi: 0 };
    peta[j.kluster].total++;
    if (j.terakreditasi) peta[j.kluster].terakreditasi++;
    if (j.bereputasi) peta[j.kluster].bereputasi++;
  });
  return Object.keys(peta).map(function (k) {
    var c = peta[k];
    c.persen = c.total ? Math.round((c.terakreditasi / c.total) * 100) : 0;
    return c;
  }).sort(function (a, b) {
    if (a.nama === KLUSTER_KOSONG) return 1;
    if (b.nama === KLUSTER_KOSONG) return -1;
    return b.total - a.total;
  });
}

/* ==========================================================================
   7. KEAMANAN — SALT, HASH, RATE LIMIT, TOKEN
   ========================================================================== */

function getSalt_() {
  var props = PropertiesService.getScriptProperties();
  var salt = props.getProperty('PIN_SALT');
  if (!salt) {
    salt = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PIN_SALT', salt);
  }
  return salt;
}

function hash_(teks) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(teks) + '|' + getSalt_(), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b) + 0x100).toString(16).slice(1); }).join('');
}

function kunciPendek_(prefix, nilai) {
  return prefix + hash_(norm_(nilai)).substring(0, 32);
}

function samaAman_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var beda = 0;
  for (var i = 0; i < a.length; i++) beda |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return beda === 0;
}

/**
 * Penghitung rate limit disimpan di PropertiesService, bukan CacheService.
 * Masa berlaku cache hanya bersifat saran dan entri dapat digusur lebih awal,
 * sehingga penghitung di cache bisa dipakai untuk melewati batas.
 */
function lolosRateLimit_(tipe, target) {
  var props = PropertiesService.getScriptProperties();
  var kunci = kunciPendek_('RL_' + tipe + '_', target);
  var sekarang = Date.now();
  var data = { count: 0, windowStart: sekarang };

  var mentah = props.getProperty(kunci);
  if (mentah) {
    try { data = JSON.parse(mentah); } catch (err) { data = { count: 0, windowStart: sekarang }; }
  }
  if (sekarang - data.windowStart > RATE_LIMIT.WINDOW_MS) {
    data = { count: 0, windowStart: sekarang };
  }
  if (data.count >= RATE_LIMIT.MAX) return false;

  data.count++;
  props.setProperty(kunci, JSON.stringify(data));
  return true;
}

function buatToken_(prefix, muatan, ttl) {
  var token = prefix + Utilities.getUuid();
  muatan.expires = Date.now() + ttl * 1000;
  CacheService.getScriptCache().put(token, JSON.stringify(muatan), ttl);
  return token;
}

/**
 * Mengembalikan muatan token, atau null bila hilang/kedaluwarsa/salah jenis.
 * Sesi disimpan di cache, dan cache dapat digusur sebelum TTL habis — sesi
 * putus lebih cepat harus diperlakukan sebagai keadaan normal.
 */
function bacaToken_(token, prefix) {
  if (!token || typeof token !== 'string') return null;
  if (prefix && token.indexOf(prefix) !== 0) return null;
  var mentah = CacheService.getScriptCache().get(token);
  if (!mentah) return null;
  try {
    var muatan = JSON.parse(mentah);
    if (!muatan.expires || muatan.expires < Date.now()) return null;
    return muatan;
  } catch (err) { return null; }
}

function sesiHabis_() {
  return { ok: false, code: 'SESSION_EXPIRED', message: 'Sesi Anda telah berakhir. Silakan masuk kembali.' };
}

function pinAcak_() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function logout(token) {
  if (token && typeof token === 'string') CacheService.getScriptCache().remove(token);
  return { ok: true };
}

function statusPinGuard_(kunciBasis) {
  var cache = CacheService.getScriptCache();
  var mentah = cache.get(PIN_GUARD.PREFIX + kunciBasis);
  if (!mentah) return { locked: false, attempts: 0, sisa: PIN_GUARD.MAX_ATTEMPTS };
  try {
    var data = JSON.parse(mentah);
    if (data && data.lockedUntil && data.lockedUntil > Date.now()) {
      return { locked: true, attempts: data.attempts || PIN_GUARD.MAX_ATTEMPTS, sisa: 0 };
    }
    if (data && (data.attempts || 0) > 0) {
      return { locked: false, attempts: data.attempts || 0, sisa: Math.max(0, PIN_GUARD.MAX_ATTEMPTS - (data.attempts || 0)) };
    }
  } catch (err) {}
  return { locked: false, attempts: 0, sisa: PIN_GUARD.MAX_ATTEMPTS };
}

function resetPinGuard_(kunciBasis) {
  CacheService.getScriptCache().remove(PIN_GUARD.PREFIX + kunciBasis); // hapus penghitung saat PIN sukses / diganti
}

function catatPinSalah_(kunciBasis) {
  var cache = CacheService.getScriptCache();
  var cacheKey = PIN_GUARD.PREFIX + kunciBasis;
  var sekarang = Date.now();
  var data = { attempts: 0, lockedUntil: 0 };

  var mentah = cache.get(cacheKey);
  if (mentah) {
    try { data = JSON.parse(mentah) || data; } catch (err) {}
  }

  if (data.lockedUntil && data.lockedUntil > sekarang) {
    return { locked: true, sisa: 0 };
  }

  data.attempts = Number(data.attempts || 0) + 1;

  if (data.attempts >= PIN_GUARD.MAX_ATTEMPTS) {
    data.lockedUntil = sekarang + (PIN_GUARD.LOCK_TTL * 1000);
    cache.put(cacheKey, JSON.stringify(data), PIN_GUARD.LOCK_TTL);
    return { locked: true, sisa: 0 };
  }

  cache.put(cacheKey, JSON.stringify(data), CACHE.PIN_TTL);
  return { locked: false, sisa: Math.max(0, PIN_GUARD.MAX_ATTEMPTS - data.attempts) };
}

/* ==========================================================================
   8. LOGIN ADMIN
   ========================================================================== */

function bacaDaftarAdmin_() {
  var sh = sheetWajib_(SHEET.ADMIN);
  var nilai = sh.getDataRange().getValues();
  if (nilai.length < 2) return [];

  var header = nilai[0].map(norm_);
  var iEmail = header.indexOf('EMAIL_ADMIN');
  var iAkses = header.indexOf('AKSES_KLUSTER');
  if (iEmail === -1) {
    for (var h = 0; h < header.length; h++) if (header[h].indexOf('EMAIL') !== -1) { iEmail = h; break; }
  }
  if (iAkses === -1) {
    for (var k = 0; k < header.length; k++) if (header[k].indexOf('KLUSTER') !== -1) { iAkses = k; break; }
  }
  if (iEmail === -1) throw new Error('Kolom "Email_Admin" tidak ditemukan pada sheet "' + SHEET.ADMIN + '".');

  var hasil = [];
  for (var r = 1; r < nilai.length; r++) {
    var email = str_(nilai[r][iEmail]).toLowerCase();
    if (!email) continue;
    var aksesMentah = (iAkses === -1) ? '' : str_(nilai[r][iAkses]);
    var isSuper = !aksesMentah || norm_(aksesMentah) === 'ALL';
    hasil.push({
      email: email,
      isSuperadmin: isSuper,
      aksesKluster: isSuper ? [] : aksesMentah.split(',').map(function (s) { return norm_(s); }).filter(Boolean)
    });
  }
  return hasil;
}

/** Respons selalu identik agar keberadaan email tidak bocor. */
function requestAdminPin(email) {
  var jawabanSeragam = {
    ok: true,
    message: 'Jika email tersebut terdaftar sebagai admin, PIN telah dikirim. Periksa kotak masuk Anda.'
  };
  try {
    var bersih = str_(email).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(bersih)) return jawabanSeragam;
    if (!lolosRateLimit_('admin', bersih)) {
      return { ok: false, message: 'Terlalu banyak permintaan PIN. Coba lagi dalam satu jam.' };
    }

    var admin = bacaDaftarAdmin_().filter(function (a) { return a.email === bersih; })[0];
    if (!admin) {
      console.warn('requestAdminPin: email tidak ada di ' + SHEET.ADMIN + ' -> ' + bersih);
      return jawabanSeragam;
    }

    var pin = pinAcak_();
    CacheService.getScriptCache().put(kunciPendek_('pin_admin_', bersih), hash_(pin), CACHE.PIN_TTL);
    resetPinGuard_(kunciPendek_('pin_admin_', bersih)); // PIN baru menghapus hitungan salah lama
    GmailApp.sendEmail(bersih, 'PIN Masuk DJPI Dashboard UPI',
      'PIN Anda: ' + pin + '\n\nPIN berlaku 5 menit dan hanya untuk satu kali masuk.\n' +
      'Abaikan email ini bila Anda tidak meminta akses.\n\n— Divisi Jurnal dan Publikasi Ilmiah UPI');
    console.log('requestAdminPin: PIN terkirim ke ' + bersih);
    return jawabanSeragam;
  } catch (err) {
    console.error('requestAdminPin gagal: ' + err.message);
    return jawabanSeragam;
  }
}

function verifyAdminPin(email, pin) {
  try {
    var bersih = str_(email).toLowerCase();
    var kunci = kunciPendek_('pin_admin_', bersih);
    var guard = statusPinGuard_(kunci);
    if (guard.locked) {
      return { ok: false, message: 'Terlalu banyak percobaan PIN salah. Coba lagi beberapa menit lagi.' };
    }

    var tersimpan = CacheService.getScriptCache().get(kunci);
    if (!tersimpan) {
      return { ok: false, message: 'PIN salah atau sudah kedaluwarsa.' };
    }

    if (!samaAman_(tersimpan, hash_(str_(pin)))) {
      var status = catatPinSalah_(kunci);
      if (status.locked) {
        CacheService.getScriptCache().remove(kunci); // lockout juga mematikan PIN lama
        return { ok: false, message: 'Terlalu banyak percobaan PIN salah. Minta PIN baru atau coba lagi beberapa menit lagi.' };
      }
      return { ok: false, message: 'PIN salah atau sudah kedaluwarsa.' };
    }

    CacheService.getScriptCache().remove(kunci);
    resetPinGuard_(kunci); // sukses menghapus penghitung salah

    var admin = bacaDaftarAdmin_().filter(function (a) { return a.email === bersih; })[0];
    if (!admin) return { ok: false, message: 'PIN salah atau sudah kedaluwarsa.' };

    var profile = { email: admin.email, isSuperadmin: admin.isSuperadmin, aksesKluster: admin.aksesKluster };
    return { ok: true, token: buatToken_('session_', profile, CACHE.SESSION_TTL), profile: profile };
  } catch (err) {
    return { ok: false, message: 'Terjadi kesalahan: ' + err.message };
  }
}

function bolehAksesKluster_(profile, kluster) {
  if (profile.isSuperadmin) return true;
  return profile.aksesKluster.indexOf(norm_(kluster)) !== -1;
}

/* ==========================================================================
   9. LOGIN PENGELOLA JURNAL
   ========================================================================== */

function requestJournalPin(namaJurnal) {
  try {
    var cocok = cariJurnal_(bacaDataJurnal_(), namaJurnal);
    if (cocok.length !== 1) {
      return { ok: false, punyaEmail: false, message: 'Jurnal tidak ditemukan.' };
    }
    var j = cocok[0];
    // email wajib berformat valid, bukan sekadar terisi
    if (!j.punyaEmail) {
      return {
        ok: false, punyaEmail: false,
        message: placeholder_(j.email)
          ? 'Jurnal ini belum memiliki email pengelola terdaftar. ' +
            'Perubahan hanya dapat dilakukan oleh admin kluster.'
          : 'Email pengelola yang terdaftar tidak berformat valid, sehingga PIN tidak dapat dikirim. ' +
            'Hubungi admin kluster untuk memperbaiki data email.'
      };
    }
    if (!lolosRateLimit_('jurnal', j.namaJurnal)) {
      return { ok: false, punyaEmail: true, message: 'Terlalu banyak permintaan PIN. Coba lagi dalam satu jam.' };
    }

    var pin = pinAcak_();
    CacheService.getScriptCache().put(kunciPendek_('pin_jurnal_', j.namaJurnal), hash_(pin), CACHE.PIN_TTL);
    resetPinGuard_(kunciPendek_('pin_jurnal_', j.namaJurnal)); // PIN baru menghapus hitungan salah lama
    var emailPinJurnal = renderTemplateEmail_('pin_jurnal', { pin: pin, namaJurnal: j.namaJurnal });
    GmailApp.sendEmail(j.email, emailPinJurnal.subjek, emailPinJurnal.isi);

    var samar = j.email.replace(/^(.).*(@.*)$/, function (m, a, b) { return a + '****' + b; });
    return { ok: true, punyaEmail: true, message: 'PIN telah dikirim ke ' + samar + '.' };
  } catch (err) {
    return { ok: false, punyaEmail: false, message: 'Terjadi kesalahan: ' + err.message };
  }
}

function verifyJournalPin(namaJurnal, pin) {
  try {
    var cocok = cariJurnal_(bacaDataJurnal_(), namaJurnal);
    if (cocok.length !== 1) return { ok: false, message: 'Jurnal tidak ditemukan.' };

    var kunci = kunciPendek_('pin_jurnal_', cocok[0].namaJurnal);
    var guard = statusPinGuard_(kunci);
    if (guard.locked) {
      return { ok: false, message: 'Terlalu banyak percobaan PIN salah. Coba lagi beberapa menit lagi.' };
    }

    var tersimpan = CacheService.getScriptCache().get(kunci);
    if (!tersimpan) {
      return { ok: false, message: 'PIN salah atau sudah kedaluwarsa.' };
    }

    if (!samaAman_(tersimpan, hash_(str_(pin)))) {
      var status = catatPinSalah_(kunci);
      if (status.locked) {
        CacheService.getScriptCache().remove(kunci); // lockout mematikan PIN lama
        return { ok: false, message: 'Terlalu banyak percobaan PIN salah. Minta PIN baru atau coba lagi beberapa menit lagi.' };
      }
      return { ok: false, message: 'PIN salah atau sudah kedaluwarsa.' };
    }

    CacheService.getScriptCache().remove(kunci);
    resetPinGuard_(kunci); // sukses menghapus penghitung salah

    var muatan = { namaJurnal: cocok[0].namaJurnal, email: cocok[0].email };
    return { ok: true, token: buatToken_('edit_', muatan, CACHE.EDIT_TTL), namaJurnal: cocok[0].namaJurnal };
  } catch (err) {
    return { ok: false, message: 'Terjadi kesalahan: ' + err.message };
  }
}

function getJournalDetailForEditor(token, namaJurnal) {
  var muatan = bacaToken_(token, 'edit_');
  if (!muatan) return sesiHabis_();
  if (norm_(muatan.namaJurnal) !== norm_(namaJurnal)) {
    return { ok: false, message: 'Token tidak berlaku untuk jurnal ini.' };
  }
  var cocok = cariJurnal_(bacaDataJurnal_(), muatan.namaJurnal);
  if (cocok.length !== 1) return { ok: false, message: 'Jurnal tidak ditemukan.' };

  var j = cocok[0];
  var detail = {};
  EDITABLE_PENGELOLA.forEach(function (f) { detail[f] = j[f]; });
  detail.namaJurnal = j.namaJurnal;
  detail.kluster = j.kluster;
  // pengelola melihat daftar perbaikan yang relevan dengan field yang boleh ia sunting
  var dqPengelola = {
    level: j.dq.level, labelLevel: j.dq.labelLevel,
    lengkap: j.dq.lengkap, totalInti: j.dq.totalInti,
    masalah: j.dq.masalah.filter(function (m) { return EDITABLE_PENGELOLA.indexOf(m.field) !== -1; })
  };
  return { ok: true, detail: detail, editable: EDITABLE_PENGELOLA, dq: dqPengelola };
}

/* ==========================================================================
   10. DASHBOARD ADMIN
   ========================================================================== */

function getDashboardDataForAdmin(token) {
  var profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();

  try {
    var semua = bacaDataJurnal_();
    var terlihat = profile.isSuperadmin ? semua : semua.filter(function (j) {
      return bolehAksesKluster_(profile, j.kluster);
    });

    return {
      ok: true,
      profile: { email: profile.email, isSuperadmin: profile.isSuperadmin, aksesKluster: profile.aksesKluster },
      stats: statistikAdmin_(terlihat),
      bulanan: sebaranBulanan_(terlihat),
      clusters: rekapKluster_(terlihat),
      scopus: pipelineScopus_(terlihat, profile),
      apc: rekapApc_(terlihat, profile),
      terbitan: rekapProgressTerbitan_(terlihat, profile), // rekap progres terbitan untuk tab Progress Terbitan
      dataQuality: rekapKualitas_(terlihat), // rekap kualitas data untuk tab Kualitas Data
      journals: terlihat,
      generatedAt: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm')
    };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function statistikAdmin_(daftar) {
  var s = statistikPublik_(daftar);
  s.timeliness = { 'Tepat Waktu': 0, 'Terlambat': 0, 'Punya Hutang Terbitan': 0, 'Belum Dinilai': 0 };
  s.migrasi = { sudah: 0, belum: 0 };
  daftar.forEach(function (j) {
    s.timeliness[j.kategoriTimeliness]++;
    if (j.sudahMigrasi) s.migrasi.sudah++; else s.migrasi.belum++;
  });
  return s;
}

function sebaranBulanan_(daftar) {
  var hasil = [0,0,0,0,0,0,0,0,0,0,0,0];
  daftar.forEach(function (j) {
    (j.bulanTerbit || []).forEach(function (i) { hasil[i]++; });
  });
  return hasil;
}

/* ==========================================================================
   11. PIPELINE SCOPUS
   ========================================================================== */

function bacaPipelineScopusRaw_() {
  var cache = CacheService.getScriptCache();
  var tersimpan = cache.get(CACHE.SCOPUS_RAW);
  if (tersimpan) {
    try { return JSON.parse(tersimpan); } catch (err) { /* cache rusak, baca ulang */ }
  }

  var hasil = { tahap1: [], tahap2: [], tahap3: [], catatan: '' };
  var sh = sheetOpsional_(SHEET.SCOPUS);
  if (!sh) {
    hasil.catatan = 'Sheet "' + SHEET.SCOPUS + '" tidak ditemukan.';
    return hasil;
  }

  var nilai = sh.getDataRange().getValues();
  if (nilai.length < 2) {
    hasil.catatan = 'Belum ada kandidat yang tercatat pada "' + SHEET.SCOPUS + '".';
    return hasil;
  }

  var header = nilai[0].map(norm_);
  function kolom(kandidat) {
    for (var a = 0; a < kandidat.length; a++) {
      var i = header.indexOf(norm_(kandidat[a]));
      if (i !== -1) return i;
    }
    for (var b = 0; b < kandidat.length; b++) {
      for (var h = 0; h < header.length; h++) {
        if (header[h] && header[h].indexOf(norm_(kandidat[b])) !== -1) return h;
      }
    }
    return -1;
  }

  var iNama = kolom(['Nama Jurnal']);
  if (iNama === -1) {
    hasil.catatan = 'Kolom "Nama Jurnal" tidak ditemukan pada "' + SHEET.SCOPUS + '".';
    return hasil;
  }
  var iPic = kolom(['Nama PIC']);
  var iSk = kolom(['SK Pengelola Jurnal Terbaru']);
  var iKendala = kolom(['Kendala Pengelolaan']);
  var iBentuk = kolom(['Bentuk pendampingan yang diharapkan']);
  var iTarget = kolom(['Target waktu submit indeksasi Scopus']);
  var iCatatan = kolom(['Catatan Tambahan']);
  var iTahap = kolom(['TAHAP']);

  for (var r = 1; r < nilai.length; r++) {
    var nama = str_(nilai[r][iNama]);
    if (!nama) continue;

    var baris = {
      namaJurnal: nama,
      pic: iPic === -1 ? '' : str_(nilai[r][iPic]),
      sk: iSk === -1 ? '' : str_(nilai[r][iSk]),
      kendala: iKendala === -1 ? '' : str_(nilai[r][iKendala]),
      pendampingan: iBentuk === -1 ? '' : str_(nilai[r][iBentuk]),
      target: iTarget === -1 ? '' : str_(nilai[r][iTarget]),
      catatan: iCatatan === -1 ? '' : str_(nilai[r][iCatatan])
    };

    var tahap = (iTahap === -1) ? 1 : (parseInt(str_(nilai[r][iTahap]).replace(/\D/g, ''), 10) || 1);
    if (tahap === 3) hasil.tahap3.push(baris);
    else if (tahap === 2) hasil.tahap2.push(baris);
    else hasil.tahap1.push(baris);
  }

  if (iTahap === -1) {
    hasil.catatan = 'Sheet "' + SHEET.SCOPUS + '" belum memiliki kolom "Tahap", sehingga seluruh baris ' +
      'dihitung sebagai Tahap 1 (Kandidat Inkubasi). Tambahkan kolom "Tahap" berisi 1, 2, atau 3 ' +
      'untuk memisahkan Pembinaan Aktif dan Submitted CSAB.';
  }

  try {
    var json = JSON.stringify(hasil);
    if (json.length < CACHE.MAX_VALUE_BYTES) cache.put(CACHE.SCOPUS_RAW, json, CACHE.SCOPUS_RAW_TTL);
  } catch (err) {}

  return hasil;
}

/**
 * "Sheet 2" hanya memuat Tahap 1 (Kandidat Inkubasi). Sumber data Tahap 2 dan
 * Tahap 3 belum ditetapkan pada skema audit, sehingga tidak dikarang di sini.
 * Bila kolom opsional "TAHAP" ditambahkan pada Sheet 2, baris akan otomatis
 * terdistribusi ke tahap yang sesuai.
 */
function pipelineScopus_(terlihat, profile) {
  var mentah = bacaPipelineScopusRaw_();
  var hasil = {
    tahap1: [],
    tahap2: [],
    tahap3: [],
    catatan: mentah.catatan || ''
  };

  var namaTerlihat = {};
  var klusterByNama = {};
  terlihat.forEach(function (j) {
    namaTerlihat[norm_(j.namaJurnal)] = true;
    klusterByNama[norm_(j.namaJurnal)] = j.kluster;
  });

  var labelTahap = {
    tahap1: 'Tahap 1 — Kandidat Inkubasi',
    tahap2: 'Tahap 2 — Pembinaan Aktif',
    tahap3: 'Tahap 3 — Submitted CSAB'
  };

  // Dashboard.html (tab Ringkasan & tab Pipeline Scopus) membaca bentuk gabungan
  // items / ringkas / ringkasList, bukan tahap1/tahap2/tahap3 terpisah. Tanpa ini
  // "data.scopus.items" undefined dan render Vue gagal tepat setelah login.
  var items = [];

  ['tahap1', 'tahap2', 'tahap3'].forEach(function (k) {
    hasil[k] = (mentah[k] || []).filter(function (baris) {
      return profile.isSuperadmin || !!namaTerlihat[norm_(baris.namaJurnal)];
    });
    hasil[k].forEach(function (baris) {
      items.push({
        namaJurnal: baris.namaJurnal,
        kluster: klusterByNama[norm_(baris.namaJurnal)] || '',
        tahap: labelTahap[k],
        catatan: baris.catatan
      });
    });
  });

  var total = items.length;
  hasil.items = items;
  hasil.ringkas = {
    proses: hasil.tahap1.length + hasil.tahap2.length,
    total: total
  };
  hasil.ringkasList = ['tahap1', 'tahap2', 'tahap3'].map(function (k) {
    var jumlah = hasil[k].length;
    return {
      label: labelTahap[k],
      jumlah: jumlah,
      persen: total ? Math.round(jumlah / total * 100) : 0
    };
  });

  return hasil;
}

/* ==========================================================================
   12. REKAP APC
   ========================================================================== */

function bacaLogApc_() {
  var cache = CacheService.getScriptCache();
  var tersimpan = cache.get(CACHE.APC_LOG);
  if (tersimpan) {
    try { return JSON.parse(tersimpan); } catch (err) { /* cache rusak, baca ulang */ }
  }

  var sh = sheetOpsional_(SHEET.LOG_APC);
  if (!sh) return { header: null, baris: [] };
  var nilai = sh.getDataRange().getValues();
  if (nilai.length < 2) return { header: nilai[0] || null, baris: [] };

  var header = nilai[0].map(norm_);
  function kolom(kandidat) {
    for (var a = 0; a < kandidat.length; a++) {
      var i = header.indexOf(norm_(kandidat[a]));
      if (i !== -1) return i;
    }
    for (var b = 0; b < kandidat.length; b++) {
      for (var h = 0; h < header.length; h++) {
        if (header[h] && header[h].indexOf(norm_(kandidat[b])) !== -1) return h;
      }
    }
    return -1;
  }

  var idx = {
    timestamp: kolom(['Timestamp']),
    email: kolom(['Email Pengelola']),
    nama: kolom(['Nama Jurnal']),
    edisi: kolom(['Edisi Laporan']),
    jumlah: kolom(['Jumlah Artikel Berbayar']),
    total: kolom(['Total Pemasukan APC']),
    honor: kolom(['Alokasi: Honorarium Pengelola', 'Honorarium']),
    bangun: kolom(['Alokasi: Pengembangan Jurnal', 'Pengembangan'])
  };

  var baris = [];
  for (var r = 1; r < nilai.length; r++) {
    var nama = idx.nama === -1 ? '' : str_(nilai[r][idx.nama]);
    if (!nama) continue;
    baris.push({
      timestamp: idx.timestamp === -1 ? '' : str_(nilai[r][idx.timestamp]),
      email: idx.email === -1 ? '' : str_(nilai[r][idx.email]),
      namaJurnal: nama,
      edisi: idx.edisi === -1 ? '' : str_(nilai[r][idx.edisi]),
      jumlahArtikel: idx.jumlah === -1 ? 0 : angka_(nilai[r][idx.jumlah]),
      total: idx.total === -1 ? 0 : angka_(nilai[r][idx.total]),
      honor: idx.honor === -1 ? 0 : angka_(nilai[r][idx.honor]),
      pengembangan: idx.bangun === -1 ? 0 : angka_(nilai[r][idx.bangun])
    });
  }

  var hasil = { header: nilai[0], baris: baris };
  try {
    var json = JSON.stringify(hasil);
    if (json.length < CACHE.MAX_VALUE_BYTES) cache.put(CACHE.APC_LOG, json, CACHE.APC_LOG_TTL);
  } catch (err) {}

  return hasil;
}

/** Keadaan kosong dirancang, bukan kebetulan: sheet ini memang masih 0 baris. */

/* ==========================================================================
   13. OPERASI TULIS
   ========================================================================== */

/**
 * OPTIMASI 2: mencari baris sasaran berdasarkan NAMA JURNAL tanpa menarik
 * seluruh sheet ke Apps Script. Sebelumnya fungsi ini memanggil
 * getDataRange().getValues() — menarik SEMUA baris x SEMUA kolom hanya untuk
 * mencocokkan satu nama saat menyimpan. Sekarang:
 *   1. Header dibaca sendiri (1 baris saja) untuk membangun peta kolom.
 *   2. Pencarian nama dilakukan lewat TextFinder pada satu kolom saja —
 *      pencocokan berjalan di sisi server Sheets, bukan ditarik ke Apps
 *      Script dulu.
 *   3. Hanya baris yang benar-benar cocok yang dibaca penuh (barisData),
 *      bukan seluruh sheet.
 * Nomor baris tidak pernah diterima dari client karena kolom "No" bukan ID
 * stabil dan urutan baris dapat berubah kapan saja.
 *
 * Bentuk hasil berubah dari { map, baris, nilai } menjadi
 * { map, baris, barisData } — barisData adalah peta nomor-baris -> array
 * nilai satu baris penuh, hanya untuk baris yang cocok.
 */
function cariBarisSheet_(sh, nama) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    return { map: {}, baris: [], barisData: {} };
  }

  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = buatHeaderMap_(header);

  if (lastRow < 2) {
    return { map: map, baris: [], barisData: {} };
  }

  var kolomNama = map.namaJurnal + 1; // 1-based untuk Range
  var target = norm_(nama);

  // Pencocokan case/spasi-insensitive konsisten dengan norm_(): TextFinder
  // dipakai untuk mempersempit kandidat baris di sisi server, lalu tiap
  // kandidat divalidasi ulang dengan norm_() persis seperti alur lama.
  var kandidat = sh.getRange(2, kolomNama, lastRow - 1, 1)
    .createTextFinder(str_(nama))
    .matchCase(false)
    .findAll();

  var baris = [];
  var barisData = {};

  kandidat.forEach(function (rng) {
    var b = rng.getRow();
    var rowFull = sh.getRange(b, 1, 1, lastCol).getValues()[0];
    if (norm_(rowFull[map.namaJurnal]) !== target) return; // jaga presisi seperti norm_() lama
    baris.push(b);
    barisData[b] = rowFull;
  });

  return { map: map, baris: baris, barisData: barisData };
}

function simpanPerubahanJurnal(token, namaJurnal, changes) {
  var sesi = bacaToken_(token, 'session_');
  var edit = sesi ? null : bacaToken_(token, 'edit_');
  if (!sesi && !edit) return sesiHabis_();

  var pelaku = sesi ? sesi.email : edit.email;
  var izin = sesi ? EDITABLE_ADMIN : EDITABLE_PENGELOLA;

  if (edit && norm_(edit.namaJurnal) !== norm_(namaJurnal)) {
    return { ok: false, message: 'Token tidak berlaku untuk jurnal ini.' };
  }
  if (!changes || typeof changes !== 'object') {
    return { ok: false, message: 'Tidak ada perubahan yang dikirim.' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };
  }

  try {
    var sh = sheetWajib_(SHEET.MAIN);
    var temu = cariBarisSheet_(sh, namaJurnal);

    if (temu.baris.length === 0) return { ok: false, message: 'Jurnal tidak ditemukan.' };
    if (temu.baris.length > 1) {
      return { ok: false, message: 'Nama jurnal ganda, hubungi administrator. Tidak ada data yang diubah.' };
    }

    var barisKe = temu.baris[0];
    if (sesi && !sesi.isSuperadmin) {
      var klusterBaris = klusterAtau_(temu.barisData[barisKe][temu.map.kluster]); // diubah: dari barisData, bukan nilai penuh sheet
      if (!bolehAksesKluster_(sesi, klusterBaris)) {
        return { ok: false, message: 'Anda tidak memiliki akses ke kluster jurnal ini.' };
      }
    }

    // Hitung seluruh perubahan di memori lebih dulu, baru tulis.
    // Penulisan dilakukan per sel yang benar-benar berubah, bukan menimpa
    // seluruh baris, agar sel berformula pada kolom lain tidak ikut hancur.
    var barisNilai = temu.barisData[barisKe]; // diubah: dari barisData, bukan nilai penuh sheet
    var rencana = [], ditolak = [];

    var galatValidasi = []; // nilai baru yang gagal validasi Data Quality Engine

    Object.keys(changes).forEach(function (field) {
      if (izin.indexOf(field) === -1) { ditolak.push(field); return; }
      var kolom = temu.map[field];
      if (kolom === undefined) { ditolak.push(field); return; }
      var lama = str_(barisNilai[kolom]);
      var baru = aman_(changes[field]);
      if (lama === baru) return;

      // tolak nilai baru yang jelas invalid, agar data rusak tidak masuk lagi
      var salah = periksaNilaiField_(field, baru);
      if (salah) { galatValidasi.push(salah); return; }

      rencana.push({ field: field, kolom: kolom, dari: lama, ke: baru });
    });

    // satu pun nilai invalid membatalkan seluruh penyimpanan
    if (galatValidasi.length) {
      return {
        ok: false,
        message: 'Perubahan dibatalkan karena ada nilai yang tidak valid.',
        galatValidasi: galatValidasi
      };
    }

    if (!rencana.length) {
      return { ok: true, message: 'Tidak ada perubahan yang perlu disimpan.', diterapkan: 0, ditolak: ditolak };
    }

    var diterapkan = rencana.map(function (r) {
      sh.getRange(barisKe, r.kolom + 1).setValue(r.ke);
      return { field: r.field, dari: r.dari, ke: r.ke };
    });

    SpreadsheetApp.flush();
    catatAktivitas_(pelaku, namaJurnal, sesi ? 'EDIT_ADMIN' : 'EDIT_PENGELOLA',
      JSON.stringify(diterapkan));
    bersihkanCacheJurnal_();

    return {
      ok: true,
      message: diterapkan.length + ' field berhasil diperbarui.',
      diterapkan: diterapkan.length,
      ditolak: ditolak
    };
  } catch (err) {
    return { ok: false, message: 'Gagal menyimpan: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Alokasi 50/50 hanya saran awal di sisi form. Backend tidak mengunci rasio,
 * hanya memastikan honor + pengembangan tidak melebihi total pemasukan.
 */

/* ==========================================================================
   14. AUDIT LOG
   ========================================================================== */

/** Log_Aktivitas adalah satu-satunya sheet yang boleh dibuat otomatis. */
function catatAktivitas_(email, namaJurnal, aksi, detail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET.AKTIVITAS);
    if (!sh) {
      sh = ss.insertSheet(SHEET.AKTIVITAS);
      sh.appendRow(['Timestamp', 'Email', 'Nama Jurnal', 'Aksi', 'Detail']);
      sh.setFrozenRows(1);
    }
    sh.appendRow([
      Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
      aman_(email), aman_(namaJurnal), aman_(aksi),
      aman_(String(detail).substring(0, 4000))
    ]);
  } catch (err) {
    console.error('Gagal menulis Log_Aktivitas: ' + err.message);
  }
}

/* ==========================================================================
   13B. PENGINGAT JADWAL TERBITAN
   --------------------------------------------------------------------------
   Dipicu manual oleh admin dari modal bulan, bukan otomatis. Alasannya:
   pengiriman massal yang salah sasaran tidak dapat ditarik kembali, jadi
   manusia harus menyetujui daftar penerima lebih dulu.

   Empat pengaman:
     1. Deduplikasi per jurnal per bulan per tahun, disimpan permanen di
        PropertiesService. Satu jurnal hanya bisa diingatkan sekali untuk
        bulan yang sama pada tahun berjalan.
     2. Batas 40 penerima per panggilan, agar eksekusi tidak menabrak batas
        6 menit Apps Script.
     3. Kuota harian Gmail diperiksa sebelum dan selama perulangan.
     4. Setiap pengiriman dicatat di Log_Aktivitas berikut nama pengirimnya.
   ========================================================================== */

var MAKS_PENGINGAT_SEKALI = 40;

function kunciPengingat_(namaJurnal, bulanIndex) {
  var tahun = Number(Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy'));
  return kunciPendek_('PGT_' + tahun + '_' + bulanIndex + '_', namaJurnal);
}

/**
 * Mengembalikan daftar jurnal yang dijadwalkan terbit pada satu bulan,
 * lengkap dengan status kelayakan kirim. Tidak mengirim apa pun.
 */
function getJurnalPerBulan(token, bulanIndex) {
  var sesi = bacaToken_(token, 'session_');
  if (!sesi) return sesiHabis_();

  var b = Number(bulanIndex);
  if (!(b >= 0 && b <= 11)) return { ok: false, message: 'Bulan tidak valid.' };

  var props = PropertiesService.getScriptProperties();
  var daftar = bacaDataJurnal_()
    .filter(function (j) { return j.bulanTerbit.indexOf(b) !== -1; })
    .filter(function (j) { return bolehAksesKluster_(sesi, j.kluster); })
    .map(function (j) {
      var sudah = props.getProperty(kunciPengingat_(j.namaJurnal, b));
      return {
        namaJurnal: j.namaJurnal,
        kluster: j.kluster,
        unitPengelola: j.unitPengelola,
        namaPengelola: j.namaPengelola,
        jadwalTerbitan: j.jadwalTerbitan,
        issue: j.issue,
        peringkatSinta: j.peringkatSinta,
        terakreditasi: j.terakreditasi,
        punyaEmail: j.punyaEmail,
        emailSamar: j.email ? j.email.replace(/^(.).*(@.*)$/, function (m, a, c) { return a + '****' + c; }) : '',
        sudahDiingatkan: !!sudah,
        waktuPengingat: sudah || '',
        inisial: j.inisial
      };
    })
    .sort(function (x, y) { return x.namaJurnal.localeCompare(y.namaJurnal, 'id'); });

  return { ok: true, bulan: BULAN[b].nama, bulanIndex: b, daftar: daftar };
}

/**
 * Mengirim email pengingat ke pengelola jurnal terpilih untuk satu bulan.
 * Alamat email tidak pernah dikirim ke client; client hanya menyebut nama
 * jurnal, dan server yang memetakannya ke alamat.
 */
function kirimPengingatTerbitan(token, bulanIndex, namaJurnalList) {
  var sesi = bacaToken_(token, 'session_');
  if (!sesi) return sesiHabis_();

  var b = Number(bulanIndex);
  if (!(b >= 0 && b <= 11)) return { ok: false, message: 'Bulan tidak valid.' };
  if (!namaJurnalList || !namaJurnalList.length) {
    return { ok: false, message: 'Tidak ada jurnal yang dipilih.' };
  }
  if (namaJurnalList.length > MAKS_PENGINGAT_SEKALI) {
    return {
      ok: false,
      message: 'Maksimal ' + MAKS_PENGINGAT_SEKALI + ' jurnal per pengiriman. ' +
               'Pilih sebagian dulu, sisanya menyusul.'
    };
  }

  var sisaKuota = 0;
  try { sisaKuota = MailApp.getRemainingDailyQuota(); } catch (err) { sisaKuota = 0; }
  if (sisaKuota <= 0) {
    return { ok: false, message: 'Kuota email harian sudah habis. Coba lagi besok.' };
  }

  var props = PropertiesService.getScriptProperties();
  var semua = bacaDataJurnal_();
  var namaBulan = BULAN[b].nama;
  var stempel = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd HH:mm');
  var hasil = [];
  var terkirim = 0;

  for (var i = 0; i < namaJurnalList.length; i++) {
    var nama = str_(namaJurnalList[i]);
    var cocok = cariJurnal_(semua, nama);

    if (cocok.length !== 1) {
      hasil.push({ namaJurnal: nama, status: 'gagal', alasan: 'Jurnal tidak ditemukan atau namanya ganda.' });
      continue;
    }
    var j = cocok[0];

    if (!bolehAksesKluster_(sesi, j.kluster)) {
      hasil.push({ namaJurnal: nama, status: 'gagal', alasan: 'Di luar kluster Anda.' });
      continue;
    }
    if (j.bulanTerbit.indexOf(b) === -1) {
      hasil.push({ namaJurnal: nama, status: 'gagal', alasan: 'Tidak dijadwalkan terbit ' + namaBulan + '.' });
      continue;
    }
    // lewati juga email yang terisi tetapi formatnya invalid
    if (!j.punyaEmail) {
      hasil.push({
        namaJurnal: nama, status: 'dilewati',
        alasan: placeholder_(j.email)
          ? 'Belum punya email pengelola.'
          : 'Email pengelola tidak berformat valid.'
      });
      continue;
    }

    var kunci = kunciPengingat_(j.namaJurnal, b);
    if (props.getProperty(kunci)) {
      hasil.push({ namaJurnal: nama, status: 'dilewati', alasan: 'Sudah diingatkan pada ' + props.getProperty(kunci) + '.' });
      continue;
    }
    if (sisaKuota <= 0) {
      hasil.push({ namaJurnal: nama, status: 'dilewati', alasan: 'Kuota email harian habis di tengah proses.' });
      continue;
    }

    var emailPengingat = renderTemplateEmail_('pengingat', {
      namaJurnal: j.namaJurnal, bulan: namaBulan,
      jadwalTerbitan: j.jadwalTerbitan || '-', unitPengelola: j.unitPengelola || '-', kluster: j.kluster || '-'
    });

    try {
      GmailApp.sendEmail(j.email, emailPengingat.subjek, emailPengingat.isi);
      props.setProperty(kunci, stempel);
      sisaKuota--;
      terkirim++;
      hasil.push({ namaJurnal: nama, status: 'terkirim', alasan: '' });
      catatAktivitas_(sesi.email, j.namaJurnal, 'PENGINGAT_TERBITAN',
        'Bulan ' + namaBulan + ' dikirim ke pengelola');
    } catch (err) {
      hasil.push({ namaJurnal: nama, status: 'gagal', alasan: err.message });
    }
  }

  return {
    ok: true,
    bulan: namaBulan,
    terkirim: terkirim,
    dilewati: hasil.filter(function (h) { return h.status === 'dilewati'; }).length,
    gagal: hasil.filter(function (h) { return h.status === 'gagal'; }).length,
    sisaKuota: sisaKuota,
    hasil: hasil
  };
}

/**
 * Menghapus penanda deduplikasi satu bulan pada tahun berjalan, agar
 * pengingat dapat dikirim ulang. Sengaja dipisah supaya pengiriman ulang
 * menjadi tindakan sadar, bukan efek samping.
 */
function resetPengingatBulan(token, bulanIndex) {
  var sesi = bacaToken_(token, 'session_');
  if (!sesi) return sesiHabis_();
  if (!sesi.isSuperadmin) return { ok: false, message: 'Hanya superadmin yang dapat mengatur ulang pengingat.' };

  var b = Number(bulanIndex);
  if (!(b >= 0 && b <= 11)) return { ok: false, message: 'Bulan tidak valid.' };

  var tahun = Number(Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy'));
  var awalan = 'PGT_' + tahun + '_' + b + '_';
  var props = PropertiesService.getScriptProperties();
  var semua = props.getProperties();
  var jumlah = 0;

  Object.keys(semua).forEach(function (k) {
    if (k.indexOf(awalan) === 0) { props.deleteProperty(k); jumlah++; }
  });

  catatAktivitas_(sesi.email, '-', 'RESET_PENGINGAT', 'Bulan ' + BULAN[b].nama + ', ' + jumlah + ' penanda dihapus');
  return { ok: true, message: jumlah + ' penanda pengingat bulan ' + BULAN[b].nama + ' dihapus.' };
}

/* ==========================================================================
   15. BOOTSTRAP ADMIN DAN SESI DARURAT
   --------------------------------------------------------------------------
   Dua fungsi berikut hanya untuk pemasangan awal. Keduanya sengaja dirancang
   agar tetap aman meski dipanggil sembarang orang dari client:
     - Hanya boleh bekerja untuk satu email yang dipatok di EMAIL_BOOTSTRAP.
     - Token sesi TIDAK pernah dikembalikan ke pemanggil, hanya ditulis ke log
       eksekusi yang cuma dapat dibaca pemilik skrip.
   Tidak ada PIN statis, dan alur PIN normal tidak dilemahkan.
   Hapus seluruh bagian ini setelah pemasangan selesai.
   ========================================================================== */

var EMAIL_BOOTSTRAP = 'nurhadiansyah45@gmail.com';

/**
 * Menambahkan EMAIL_BOOTSTRAP ke sheet Daftar_Admin sebagai superadmin.
 * Jalankan sekali dari editor Apps Script. Aman diulang.
 */
function bootstrapAdmin() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, message: 'Sistem sedang sibuk.' };
  try {
    var sudah = bacaDaftarAdmin_().filter(function (a) { return a.email === EMAIL_BOOTSTRAP; })[0];
    if (sudah) {
      console.log('Email ' + EMAIL_BOOTSTRAP + ' sudah terdaftar sebagai admin.');
      return { ok: true, message: 'Sudah terdaftar.' };
    }
    // Tulis berdasarkan nama header, bukan urutan kolom yang diasumsikan.
    var sh = sheetWajib_(SHEET.ADMIN);
    var header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(norm_);
    var iEmail = -1, iAkses = -1;
    for (var h = 0; h < header.length; h++) {
      if (iEmail === -1 && header[h].indexOf('EMAIL') !== -1) iEmail = h;
      if (iAkses === -1 && header[h].indexOf('KLUSTER') !== -1) iAkses = h;
    }
    if (iEmail === -1) {
      throw new Error('Kolom email tidak ditemukan pada sheet "' + SHEET.ADMIN + '".');
    }

    var baris = new Array(header.length).fill('');
    baris[iEmail] = EMAIL_BOOTSTRAP;
    if (iAkses !== -1) baris[iAkses] = 'ALL';
    sh.appendRow(baris);
    SpreadsheetApp.flush();
    catatAktivitas_(EMAIL_BOOTSTRAP, '-', 'BOOTSTRAP_ADMIN', 'Ditambahkan sebagai superadmin');
    console.log('Berhasil menambahkan ' + EMAIL_BOOTSTRAP + ' sebagai superadmin.');
    return { ok: true, message: 'Selesai.' };
  } catch (err) {
    console.error(err.message);
    return { ok: false, message: err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Membuat token sesi untuk EMAIL_BOOTSTRAP tanpa melalui email dan PIN.
 * Jalankan dari editor Apps Script, lalu baca token pada log eksekusi dan buka
 * URL yang tercetak di sana. Token berlaku 4 jam.
 */
function buatSesiDarurat() {
  try {
    var admin = bacaDaftarAdmin_().filter(function (a) { return a.email === EMAIL_BOOTSTRAP; })[0];
    if (!admin) {
      console.warn('Email belum ada di Daftar_Admin. Jalankan bootstrapAdmin() lebih dulu.');
      return { ok: false, message: 'Jalankan bootstrapAdmin() lebih dulu.' };
    }

    var profile = { email: admin.email, isSuperadmin: admin.isSuperadmin, aksesKluster: admin.aksesKluster };
    var token = buatToken_('session_', profile, CACHE.SESSION_TTL);
    var urlDasar = '';
    try { urlDasar = ScriptApp.getService().getUrl() || ''; } catch (err) { urlDasar = ''; }

    console.log('Token sesi darurat untuk ' + admin.email + ' (berlaku 4 jam):');
    console.log(token);
    console.log('Buka URL berikut di browser:');
    console.log(urlDasar + '?page=dashboard&t=' + encodeURIComponent(token));

    catatAktivitas_(admin.email, '-', 'SESI_DARURAT', 'Token sesi dibuat lewat editor Apps Script');

    // Token sengaja tidak dikembalikan ke pemanggil.
    return { ok: true, message: 'Token telah ditulis ke log eksekusi.' };
  } catch (err) {
    console.error(err.message);
    return { ok: false, message: err.message };
  }
}

/**
 * Diagnostik pengiriman email. Jalankan dari editor Apps Script.
 * Menjawab pertanyaan: apakah kegagalan ada di kuota, di izin, atau di data.
 */
function cekPengirimanEmail() {
  var laporan = [];

  // 1. Sisa kuota harian.
  var sisa = -1;
  try {
    sisa = MailApp.getRemainingDailyQuota();
    laporan.push('Sisa kuota email hari ini : ' + sisa);
  } catch (err) {
    laporan.push('Gagal membaca kuota        : ' + err.message);
  }

  // 2. Apakah email target benar-benar ada di Daftar_Admin.
  try {
    var daftar = bacaDaftarAdmin_();
    laporan.push('Jumlah admin terdaftar    : ' + daftar.length);
    laporan.push('Email admin               : ' + daftar.map(function (a) { return a.email; }).join(', '));
    var ada = daftar.filter(function (a) { return a.email === EMAIL_BOOTSTRAP; }).length > 0;
    laporan.push('EMAIL_BOOTSTRAP terdaftar : ' + (ada ? 'ya' : 'TIDAK — jalankan bootstrapAdmin()'));
  } catch (err) {
    laporan.push('Gagal membaca Daftar_Admin: ' + err.message);
  }

  // 3. Uji kirim sungguhan. Galat sengaja dibiarkan muncul apa adanya.
  if (sisa > 0) {
    try {
      GmailApp.sendEmail(EMAIL_BOOTSTRAP, 'Uji Kirim DJPI Dashboard',
        'Bila email ini sampai, GmailApp berfungsi normal dan masalahnya ada di tempat lain.');
      laporan.push('Uji kirim                 : berhasil dikirim ke ' + EMAIL_BOOTSTRAP);
    } catch (err) {
      laporan.push('Uji kirim GAGAL           : ' + err.message);
    }
  } else {
    laporan.push('Uji kirim dilewati karena kuota habis atau tidak terbaca.');
  }

  var teks = laporan.join('\n');
  console.log(teks);
  return teks;
}

/* ==========================================================================
   15B. VALIDASI TULIS (dipakai simpanPerubahanJurnal)
   ========================================================================== */

/**
 * Validasi nilai baru sebelum ditulis ke sheet.
 * Mengembalikan null bila lolos, atau objek {field,label,pesan} bila gagal.
 * Nilai kosong selalu diizinkan (pengosongan field disengaja).
 */
function periksaNilaiField_(field, nilai) {
  var s = str_(nilai);
  if (!s) return null;

  var aturanUrl = { linkOjs: 'Link OJS', linkApc: 'Tautan APC', linkGaruda: 'Link Garuda', linkDoaj: 'Link DOAJ' };
  if (aturanUrl[field] && !urlValid_(s)) {
    return {
      field: field, label: aturanUrl[field],
      pesan: 'Harus berupa alamat lengkap yang dimulai dengan http:// atau https:// dan tanpa spasi.'
    };
  }
  if (field === 'email' && !emailValid_(s)) {
    return { field: field, label: 'Email pengelola', pesan: 'Format email tidak valid. Isi satu alamat saja, contoh nama@upi.edu.' };
  }
  if (field === 'issn' && !issnValid_(s)) {
    return { field: field, label: 'ISSN', pesan: 'ISSN harus berpola delapan karakter, contoh 2085-1243.' };
  }
  if ((field === 'eIssn' || field === 'pIssn') && !issnTunggalValid_(s)) {
    return {
      field: field, label: (field === 'eIssn' ? 'E-ISSN' : 'P-ISSN'),
      pesan: 'Harus persis satu ISSN delapan karakter, contoh 2085-1243 — tanpa label atau ISSN lain di sel yang sama.'
    };
  }
  if ((field === 'artikelPerIssue' || field === 'artikelPerTahun') && !/^\d+$/.test(s)) {
    return { field: field, label: (field === 'artikelPerIssue' ? 'Artikel per issue' : 'Artikel per tahun'), pesan: 'Harus berupa angka bulat.' };
  }
  if (field === 'kuartil' && !kuartilValid_(s)) {
    return { field: field, label: 'Kuartil Scopus', pesan: 'Gunakan format Q1 sampai Q4, contoh SCOPUS Q2.' };
  }
  if (field === 'statusAkreditasi' && !akreditasiValid_(s)) {
    return { field: field, label: 'Status akreditasi', pesan: 'Gunakan SINTA 1 sampai SINTA 6, atau Belum Akreditasi.' };
  }
  // Penolakan placeholder generik hanya untuk field inti; field catatan bebas teks.
  var fieldInti = { kluster: 'Kluster', namaPengelola: 'Nama pengelola', apc: 'Informasi APC',
                    jadwalTerbitan: 'Jadwal terbitan', masaBerlakuSk: 'Masa berlaku SK', issue: 'Issue' };
  if (fieldInti[field] && placeholder_(s)) {
    return {
      field: field, label: fieldInti[field],
      pesan: 'Nilai "' + s + '" terbaca sebagai placeholder. Kosongkan field bila datanya memang belum ada.'
    };
  }
  return null;
}

/* ==========================================================================
   16. DIAGNOSTIK (jalankan manual dari editor Apps Script)
   ========================================================================== */

/** Diagnostik terpisah: sebaran kualitas data dan sepuluh jurnal paling mendesak. */
function cekKualitasData() {
  var daftar = bacaDataJurnal_();
  var rekap = rekapKualitas_(daftar);

  var baris = [
    'Total jurnal        : ' + rekap.total,
    'Kritis              : ' + rekap.kritis,
    'Perlu tindakan      : ' + rekap.perluTindakan,
    'Perlu verifikasi    : ' + rekap.perluVerifikasi,
    'Terkendali          : ' + rekap.terkendali,
    '',
    'Masalah terbanyak:'
  ];
  rekap.ringkas.slice(0, 15).forEach(function (r) {
    baris.push('  - ' + r.label + ' (' + r.jenis + ') : ' + r.jumlah);
  });

  baris.push('', 'Sepuluh jurnal paling mendesak:');
  daftar.slice().sort(function (a, b) { return b.dq.skor - a.dq.skor; }).slice(0, 10)
    .forEach(function (j) {
      baris.push('  [' + j.dq.labelLevel + '] ' + j.namaJurnal + ' (' + j.dq.jumlahMasalah + ' masalah)');
    });

  var laporan = baris.join('\n');
  console.log(laporan);
  return laporan;
}

function cekIntegritasData() {
  var daftar = bacaDataJurnal_();
  var hitung = { total: daftar.length, terakreditasi: 0, belum: 0, punyaEmail: 0, bereputasi: 0 };
  var namaTerlihat = {}, ganda = [];

  daftar.forEach(function (j) {
    if (j.terakreditasi) hitung.terakreditasi++; else hitung.belum++;
    if (j.punyaEmail) hitung.punyaEmail++;
    if (j.bereputasi) hitung.bereputasi++;
    var k = norm_(j.namaJurnal);
    if (namaTerlihat[k]) ganda.push(j.namaJurnal); else namaTerlihat[k] = true;
  });

  var laporan = [
    'Total jurnal        : ' + hitung.total + ' (harapan 181)',
    'Terakreditasi SINTA : ' + hitung.terakreditasi + ' (harapan 114)',
    'Belum akreditasi    : ' + hitung.belum + ' (harapan 67)',
    'Punya email         : ' + hitung.punyaEmail + ' (harapan 78)',
    'Bereputasi/Scopus   : ' + hitung.bereputasi + ' (harapan 3)',
    'Nama jurnal ganda   : ' + (ganda.length ? ganda.join(' ; ') : 'tidak ada')
  ].join('\n');

  console.log(laporan);
  if (ganda.length) {
    console.warn('Nama ganda memblokir operasi tulis pada jurnal terkait. Perbaiki lebih dulu.');
  }
  return laporan;
}


/* =========================================================
 * FASE 1B — MODUL USULAN DOI (REVISI)
 * ---------------------------------------------------------
 * Menggantikan seluruh blok "FASE 1A — MODUL USULAN DOI" yang lama.
 * Perubahan terhadap versi sebelumnya:
 *
 *  1. simpanUsulanDoi() sekarang WAJIB token 'edit_' (pengelola jurnal).
 *     nama_jurnal & email_pengelola diambil dari token, TIDAK dari
 *     payload klien lagi — mencegah pengelola mengklaim jadi jurnal lain.
 *
 *  2. getUsulanDoi() dan ubahStatusUsulanDoi() sekarang WAJIB token
 *     'session_' (admin) dan hasilnya difilter memakai bolehAksesKluster_,
 *     persis pola getDashboardDataForAdmin().
 *
 *  3. diproses_oleh pada ubahStatusUsulanDoi() diambil dari profile.email
 *     hasil verifikasi token, bukan dari payload — klien tidak lagi bisa
 *     mengklaim identitas admin manapun.
 *
 *  4. Fungsi baru getUsulanDoiUntukPengelola(token) — daftar usulan milik
 *     SATU jurnal saja, dipakai di Dashboard Pengelola.
 *
 *  5. Status tidak dapat diubah ke SIAP_DIPROSES bila ISSN jurnal belum
 *     sah (issnValid_), sesuai aturan bisnis "DOI tidak diaktifkan tanpa
 *     ISSN sah" dari form pengajuan asli.
 *
 *  6. Dua email receipt terpisah (bukan satu field yang bisa tertimpa):
 *       - receipt_pengajuan_*  dikirim saat simpanUsulanDoi() sukses
 *       - receipt_aktivasi_*   dikirim HANYA saat status berubah
 *                               menjadi BERHASIL (bukan transisi lain)
 *     Kegagalan kirim email TIDAK membatalkan operasi utama (simpan/ubah
 *     status tetap berhasil), hanya dicatat — konsisten dengan pola
 *     requestAdminPin yang menangkap galat GmailApp secara terpisah.
 *
 *  7. DOI_HEADERS mendapat kolom baru, DITAMBAHKAN DI AKHIR saja, supaya
 *     baris yang sudah tersimpan dengan skema lama tidak rusak. Sheet
 *     yang sudah ada otomatis dimigrasi (kolom header baru ditambahkan)
 *     lewat migrasiHeaderDoiJikaPerlu_() saat sheet pertama kali dibuka.
 *
 * TIDAK DIUBAH dari versi sebelumnya:
 *  - DOI_SHEET_NAME, DOI_STATUS (lifecycle 6 status dipertahankan apa
 *    adanya sesuai keputusan blueprint, tidak dibuat skema status baru)
 *  - buatIdUsulanDoi_, rowToDoiObject_
 * ========================================================= */

const DOI_SHEET_NAME = 'Usulan_DOI';

const DOI_HEADERS = [
  // --- kolom lama, urutan & nama tidak diubah ---
  'id_usulan',
  'dibuat_pada',
  'nama_jurnal',
  'email_pengelola',
  'jenis_objek',
  'volume',
  'nomor',
  'tahun',
  'judul_artikel',
  'penulis',
  'url_landing_page',
  'doi_diusulkan',
  'status',
  'catatan_pengelola',
  'catatan_admin',
  'diproses_oleh',
  'diproses_pada',
  'submission_id_crossref',
  'hasil_submission_log',
  'doi_aktif_pada',
  // --- kolom baru, ditambahkan di akhir (lihat blueprint §4) ---
  'nama_pemohon',
  'whatsapp_pemohon',
  'jabatan_pemohon',
  'jenis_konten',              // 'edisi' | 'artikel'
  'jumlah_doi',
  'tanggal_publikasi',
  'persetujuan',                // boolean
  'receipt_pengajuan_status',   // 'terkirim' | 'gagal'
  'receipt_pengajuan_pada',
  'receipt_aktivasi_status',    // 'terkirim' | 'gagal'
  'receipt_aktivasi_pada'
];

const DOI_STATUS = [
  'MENUNGGU_VALIDASI',
  'PERLU_REVISI',
  'SIAP_DIPROSES',
  'SEDANG_DIPROSES',
  'BERHASIL',
  'GAGAL'
];

/**
 * Private helper: mengambil atau membuat sheet transaksi DOI.
 * Tidak dapat dipanggil dari browser karena namanya berakhiran underscore.
 */
function getUsulanDoiSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DOI_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(DOI_SHEET_NAME);
    sheet.getRange(1, 1, 1, DOI_HEADERS.length)
      .setValues([DOI_HEADERS])
      .setFontWeight('bold')
      .setBackground('#7f0000')
      .setFontColor('#ffffff');

    sheet.setFrozenRows(1);

    const statusColumn = DOI_HEADERS.indexOf('status') + 1;
    const validation = SpreadsheetApp.newDataValidation()
      .requireValueInList(DOI_STATUS, true)
      .setAllowInvalid(false)
      .build();

    sheet.getRange(2, statusColumn, sheet.getMaxRows() - 1, 1)
      .setDataValidation(validation);

    sheet.autoResizeColumns(1, DOI_HEADERS.length);
  } else {
    migrasiHeaderDoiJikaPerlu_(sheet);
  }

  return sheet;
}

/**
 * Menambahkan kolom header baru ke sheet Usulan_DOI yang sudah ada dan
 * masih memakai skema lama, TANPA menyentuh baris data yang sudah ada.
 * Kolom yang belum ada di header sheet ditambahkan di akhir, mengikuti
 * urutan DOI_HEADERS. Aman dipanggil berulang kali (idempotent).
 */
function migrasiHeaderDoiJikaPerlu_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headerSekarang = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
    : [];

  const hilang = DOI_HEADERS.filter(function (h) { return headerSekarang.indexOf(h) === -1; });
  if (!hilang.length) return;

  const mulaiKolom = headerSekarang.length + 1;
  sheet.getRange(1, mulaiKolom, 1, hilang.length)
    .setValues([hilang])
    .setFontWeight('bold')
    .setBackground('#7f0000')
    .setFontColor('#ffffff');

  console.log('migrasiHeaderDoiJikaPerlu_: menambahkan kolom baru -> ' + hilang.join(', '));
}

/**
 * Private helper: membuat ID transaksi DOI.
 */
function buatIdUsulanDoi_() {
  const waktu = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyyMMdd-HHmmss'
  );

  const acak = Math.random()
    .toString(36)
    .substring(2, 7)
    .toUpperCase();

  return `DOI-${waktu}-${acak}`;
}

/**
 * Private helper: membuat objek berdasarkan header dan baris.
 */
function rowToDoiObject_(headers, row) {
  return headers.reduce((obj, header, index) => {
    obj[header] = row[index] instanceof Date
      ? Utilities.formatDate(
          row[index],
          Session.getScriptTimeZone(),
          "yyyy-MM-dd'T'HH:mm:ss"
        )
      : row[index];
    return obj;
  }, {});
}

/**
 * Validasi payload usulan DOI sebelum disimpan. Mengembalikan pesan
 * galat pertama yang ditemukan, atau null bila lolos semua.
 */
function validasiPayloadDoi_(payload) {
  if (!payload || typeof payload !== 'object') return 'Data usulan DOI tidak valid.';

  if (!String(payload.judul_artikel || '').trim()) return 'Judul artikel wajib diisi.';

  const urlLanding = String(payload.url_landing_page || '').trim();
  if (!urlLanding || !/^https?:\/\/.+/i.test(urlLanding)) {
    return 'URL landing page harus diawali http:// atau https://.';
  }

  if (!String(payload.nama_pemohon || '').trim()) return 'Nama pemohon wajib diisi.';
  if (!String(payload.jabatan_pemohon || '').trim()) return 'Jabatan pemohon wajib diisi.';

  const wa = String(payload.whatsapp_pemohon || '').replace(/[\s-]/g, '');
  if (!/^(0|\+62)8\d{8,11}$/.test(wa)) {
    return 'Nomor WhatsApp pemohon tidak valid. Gunakan format 08xxxxxxxxxx atau +62xxxxxxxxxx.';
  }

  const jenisKonten = String(payload.jenis_konten || '').trim();
  if (['edisi', 'artikel'].indexOf(jenisKonten) === -1) {
    return 'Jenis konten wajib dipilih (edisi atau artikel).';
  }

  const jumlahDoi = Number(payload.jumlah_doi);
  if (!jumlahDoi || jumlahDoi < 1) return 'Jumlah DOI dibutuhkan wajib diisi, minimal 1.';

  if (!String(payload.tanggal_publikasi || '').trim()) return 'Tanggal publikasi wajib diisi.';

  if (payload.persetujuan !== true) {
    return 'Pernyataan dan persetujuan wajib dicentang sebelum usulan dapat dikirim.';
  }

  return null;
}

/**
 * Mengambil semua usulan DOI untuk sisi ADMIN, terfilter sesuai akses
 * kluster (superadmin melihat semua). Endpoint: gs('getUsulanDoi', token).
 */

/**
 * Mengambil usulan DOI milik SATU jurnal saja, untuk Dashboard Pengelola.
 * Endpoint: gs('getUsulanDoiUntukPengelola', token).
 */

/**
 * Menyimpan usulan DOI baru. Dipanggil oleh PENGELOLA JURNAL, wajib
 * token 'edit_'. nama_jurnal & email_pengelola diambil dari token.
 * Endpoint: gs('simpanUsulanDoi', token, payload).
 */

/**
 * Mengubah status serta catatan admin suatu usulan DOI. Dipanggil oleh
 * ADMIN, wajib token 'session_'. diproses_oleh diambil dari profile.email
 * hasil verifikasi token — TIDAK diterima dari payload klien.
 * Endpoint: gs('ubahStatusUsulanDoi', token, payload).
 */

/**
 * Mengirim ulang tanda terima (pengajuan atau aktivasi) secara manual.
 * Dipanggil ADMIN, wajib token 'session_'. Dipakai tombol "Kirim ulang"
 * di modal detail saat receipt_*_status sebelumnya 'gagal', atau kapan
 * pun admin ingin mengirim ulang atas permintaan pengelola.
 * Endpoint: gs('kirimUlangReceiptDoi', token, payload).
 * payload: { id_usulan, jenis: 'pengajuan' | 'aktivasi' }
 */

/* =========================================================
 * EMAIL RECEIPT — dua kejadian terpisah, lihat blueprint §4.
 * Keduanya menangkap galat sendiri dan mengembalikan boolean,
 * konsisten dengan pola requestAdminPin/requestJournalPin yang
 * tidak membatalkan operasi utama hanya karena kirim email gagal.
 * ========================================================= */

function kirimReceiptPengajuanDoi_(email, namaJurnal, record) {
  try {
    var emailDoiPengajuan = renderTemplateEmail_('doi_pengajuan', {
      namaJurnal: namaJurnal, idUsulan: record.id_usulan,
      jenisKonten: record.jenis_konten === 'edisi' ? 'Edisi/Volume Tertentu' : 'Artikel Jurnal Tertentu',
      judulArtikel: record.judul_artikel, jumlahDoi: record.jumlah_doi
    });

    GmailApp.sendEmail(email, emailDoiPengajuan.subjek, emailDoiPengajuan.isi);
    return true;
  } catch (err) {
    console.error('kirimReceiptPengajuanDoi_ gagal: ' + err.message);
    return false;
  }
}

function kirimReceiptAktivasiDoi_(email, namaJurnal, item) {
  try {
    var emailDoiAktif = renderTemplateEmail_('doi_aktif', {
      namaJurnal: namaJurnal, idUsulan: item.id_usulan, judulArtikel: item.judul_artikel,
      doiDiusulkan: item.doi_diusulkan || '(lihat detail di dashboard)'
    });

    GmailApp.sendEmail(email, emailDoiAktif.subjek, emailDoiAktif.isi);
    return true;
  } catch (err) {
    console.error('kirimReceiptAktivasiDoi_ gagal: ' + err.message);
    return false;
  }
}


/* =========================================================
 * MODUL PIN TETAP ADMIN (per-admin, opsional)
 * ---------------------------------------------------------
 * Setiap admin BOLEH mengatur PIN tetap enam digit miliknya sendiri,
 * untuk login cepat berikutnya tanpa menunggu email PIN sekali pakai.
 * PIN tetap ini TIDAK menggantikan alur email PIN — dua-duanya tetap
 * aktif berdampingan, admin bebas pakai salah satu tiap login.
 *
 * PRINSIP KEAMANAN YANG DIPERTAHANKAN (lihat brainstorming sebelumnya):
 *  1. PIN tetap hanya bisa DIATUR dari sesi yang sudah terverifikasi
 *     lewat email PIN normal terlebih dahulu — tidak pernah dibagikan
 *     lewat kanal lain, tidak pernah dikirim oleh admin lain untuknya.
 *  2. Disimpan ter-hash (hash_ + getSalt_), sama seperti PIN email biasa.
 *     TIDAK PERNAH disimpan sebagai teks biasa di sheet.
 *  3. PIN_GUARD tetap aktif untuk PIN tetap, dengan prefix kunci TERPISAH
 *     dari PIN email ('pin_tetap_admin_'), supaya lockout satu jalur
 *     tidak memengaruhi jalur lainnya.
 *  4. Setiap login sukses maupun gagal via PIN tetap dicatat di
 *     Log_Aktivitas, sama seperti login PIN email.
 *  5. Kolom PIN_Tetap di Daftar_Admin ditambahkan otomatis kalau belum
 *     ada (migrasi non-destruktif), dan HANYA menyimpan hash — pemilik
 *     spreadsheet yang membuka Daftar_Admin secara manual tidak akan
 *     melihat PIN dalam bentuk apa pun yang bisa dipakai ulang.
 * ========================================================= */

var KOLOM_PIN_TETAP = 'PIN_TETAP_HASH';

/**
 * Menambahkan kolom PIN_Tetap_Hash ke sheet Daftar_Admin bila belum ada.
 * Non-destruktif — tidak menyentuh kolom/baris yang sudah ada.
 */
function migrasiKolomPinTetapJikaPerlu_() {
  var sh = sheetWajib_(SHEET.ADMIN);
  var lastCol = sh.getLastColumn();
  var header = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(norm_) : [];

  if (header.indexOf(KOLOM_PIN_TETAP) !== -1) return; // sudah ada

  sh.getRange(1, lastCol + 1).setValue('PIN_Tetap_Hash');
  console.log('migrasiKolomPinTetapJikaPerlu_: kolom PIN_Tetap_Hash ditambahkan ke ' + SHEET.ADMIN);
}

/**
 * Mencari nomor baris (1-based) admin tertentu di Daftar_Admin berdasarkan
 * email, beserta indeks kolom (0-based) PIN_Tetap_Hash. Dipakai bersama
 * oleh aturPinTetapAdmin dan verifyAdminPinTetap.
 */
function cariBarisAdmin_(email) {
  var sh = sheetWajib_(SHEET.ADMIN);
  var nilai = sh.getDataRange().getValues();
  if (nilai.length < 2) return null;

  var header = nilai[0].map(norm_);
  var iEmail = header.indexOf('EMAIL_ADMIN');
  if (iEmail === -1) {
    for (var h = 0; h < header.length; h++) if (header[h].indexOf('EMAIL') !== -1) { iEmail = h; break; }
  }
  var iPin = header.indexOf(KOLOM_PIN_TETAP);
  if (iEmail === -1) return null;

  var target = String(email).toLowerCase();
  for (var r = 1; r < nilai.length; r++) {
    if (String(nilai[r][iEmail]).toLowerCase() === target) {
      return { baris: r + 1, kolomPin: iPin === -1 ? -1 : iPin + 1, nilaiPinSekarang: iPin === -1 ? '' : str_(nilai[r][iPin]) };
    }
  }
  return null;
}

/**
 * Admin mengatur/mengganti PIN tetap miliknya sendiri. WAJIB dipanggil
 * dari sesi yang sudah login (token 'session_') — tidak bisa dipakai
 * untuk mengatur PIN tetap admin lain.
 * Endpoint: gs('aturPinTetapAdmin', token, pinBaru).
 */
function aturPinTetapAdmin(token, pinBaru) {
  var profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();

  var pin = String(pinBaru || '').trim();
  if (!/^\d{6}$/.test(pin)) {
    return { ok: false, message: 'PIN tetap harus berupa enam digit angka.' };
  }
  // Tolak PIN lemah yang jelas mudah ditebak — pemeriksaan dasar, bukan jaminan penuh.
  if (/^(\d)\1{5}$/.test(pin) || pin === '123456' || pin === '654321') {
    return { ok: false, message: 'PIN terlalu mudah ditebak. Gunakan kombinasi angka yang tidak berurutan/berulang.' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };

  try {
    migrasiKolomPinTetapJikaPerlu_();
    var lokasi = cariBarisAdmin_(profile.email);
    if (!lokasi) return { ok: false, message: 'Data admin tidak ditemukan pada Daftar_Admin.' };

    var sh = sheetWajib_(SHEET.ADMIN);
    var lastCol = sh.getLastColumn();
    var header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(norm_);
    var kolomPin = header.indexOf(KOLOM_PIN_TETAP) + 1;

    sh.getRange(lokasi.baris, kolomPin).setValue(hash_(pin));
    SpreadsheetApp.flush();

    resetPinGuard_(kunciPendek_('pin_tetap_admin_', profile.email)); // PIN baru menghapus histori percobaan salah lama
    catatAktivitas_(profile.email, '-', 'ATUR_PIN_TETAP', 'PIN tetap diperbarui oleh pemilik akun');

    return { ok: true, message: 'PIN tetap berhasil disimpan. Gunakan PIN ini untuk login cepat berikutnya.' };
  } catch (err) {
    return { ok: false, message: 'Gagal menyimpan PIN tetap: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menghapus PIN tetap admin (nonaktifkan login cepat), tanpa menghapus
 * baris admin itu sendiri dari Daftar_Admin.
 * Endpoint: gs('hapusPinTetapAdmin', token).
 */
function hapusPinTetapAdmin(token) {
  var profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };

  try {
    var lokasi = cariBarisAdmin_(profile.email);
    if (!lokasi || lokasi.kolomPin === -1) {
      return { ok: true, message: 'PIN tetap memang belum diatur.' };
    }
    var sh = sheetWajib_(SHEET.ADMIN);
    sh.getRange(lokasi.baris, lokasi.kolomPin).setValue('');
    SpreadsheetApp.flush();

    catatAktivitas_(profile.email, '-', 'HAPUS_PIN_TETAP', 'PIN tetap dinonaktifkan oleh pemilik akun');
    return { ok: true, message: 'PIN tetap dinonaktifkan. Login berikutnya wajib memakai PIN email.' };
  } catch (err) {
    return { ok: false, message: 'Gagal menghapus PIN tetap: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Login admin memakai PIN tetap — jalur ALTERNATIF dari requestAdminPin/
 * verifyAdminPin (email OTP), tidak menggantikannya. Endpoint publik,
 * jadi tetap dijaga rate limit + PIN_GUARD seperti jalur PIN email.
 * Endpoint: gs('verifyAdminPinTetap', email, pin).
 */
function verifyAdminPinTetap(email, pin) {
  try {
    var bersih = str_(email).toLowerCase();
    if (!bersih) return { ok: false, message: 'Email wajib diisi.' };

    var kunciGuard = kunciPendek_('pin_tetap_admin_', bersih);
    var guard = statusPinGuard_(kunciGuard);
    if (guard.locked) {
      return { ok: false, message: 'Terlalu banyak percobaan PIN salah. Coba lagi beberapa menit lagi.' };
    }

    if (!lolosRateLimit_('pin_tetap', bersih)) {
      return { ok: false, message: 'Terlalu banyak percobaan. Coba lagi dalam satu jam.' };
    }

    var lokasi = cariBarisAdmin_(bersih);
    if (!lokasi || lokasi.kolomPin === -1 || !lokasi.nilaiPinSekarang) {
      // Pesan disamarkan: tidak membedakan "email tidak terdaftar" vs "PIN tetap belum diatur",
      // supaya keberadaan akun admin tidak bocor lewat pesan galat.
      catatPinSalah_(kunciGuard);
      return { ok: false, message: 'PIN tetap salah, atau belum diaktifkan untuk akun ini.' };
    }

    if (!samaAman_(lokasi.nilaiPinSekarang, hash_(str_(pin)))) {
      var status = catatPinSalah_(kunciGuard);
      if (status.locked) {
        return { ok: false, message: 'Terlalu banyak percobaan PIN salah. Coba lagi beberapa menit lagi.' };
      }
      return { ok: false, message: 'PIN tetap salah, atau belum diaktifkan untuk akun ini.' };
    }

    resetPinGuard_(kunciGuard);

    var admin = bacaDaftarAdmin_().filter(function (a) { return a.email === bersih; })[0];
    if (!admin) return { ok: false, message: 'Data admin tidak ditemukan.' };

    var profile = { email: admin.email, isSuperadmin: admin.isSuperadmin, aksesKluster: admin.aksesKluster };
    catatAktivitas_(admin.email, '-', 'LOGIN_PIN_TETAP', 'Login memakai PIN tetap');

    return { ok: true, token: buatToken_('session_', profile, CACHE.SESSION_TTL), profile: profile };
  } catch (err) {
    return { ok: false, message: 'Terjadi kesalahan: ' + err.message };
  }
}


/* ==========================================================================
   17. PERBAIKAN KOLOM MODUL DOI (baca/tulis berbasis nama header sheet)
   ========================================================================== */

function petaKolomDoi_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return { peta: {}, header: [], lebar: 0 };

  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var peta = {};
  header.forEach(function (nama, i) {
    if (nama && peta[nama] === undefined) peta[nama] = i; // header duplikat: yang pertama menang
  });

  return { peta: peta, header: header, lebar: lastCol };
}

function barisDoiKeObjek_(info, row) {
  var obj = {};
  info.header.forEach(function (nama, i) {
    if (!nama) return;
    var nilai = row[i];
    obj[nama] = (nilai instanceof Date)
      ? Utilities.formatDate(nilai, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss")
      : nilai;
  });
  return obj;
}

function simpanUsulanDoi(token, payload) {
  const muatan = bacaToken_(token, 'edit_');
  if (!muatan) return sesiHabis_();

  const galat = validasiPayloadDoi_(payload);
  if (galat) return { ok: false, message: galat };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };
  }

  try {
    const sheet = getUsulanDoiSheet_();
    const info = petaKolomDoi_(sheet);
    const sekarang = new Date();
    const idUsulan = buatIdUsulanDoi_();

    const record = {
      id_usulan: idUsulan,
      dibuat_pada: sekarang,
      nama_jurnal: muatan.namaJurnal,
      email_pengelola: muatan.email,
      jenis_objek: String(payload.jenis_objek || 'ARTIKEL').trim().toUpperCase(),
      volume: aman_(payload.volume || ''),
      nomor: aman_(payload.nomor || ''),
      tahun: aman_(payload.tahun || ''),
      judul_artikel: aman_(payload.judul_artikel),
      penulis: aman_(payload.penulis || ''),
      url_landing_page: String(payload.url_landing_page).trim(),
      doi_diusulkan: aman_(payload.doi_diusulkan || ''),
      status: 'MENUNGGU_VALIDASI',
      catatan_pengelola: aman_(payload.catatan_pengelola || ''),
      catatan_admin: '',
      diproses_oleh: '',
      diproses_pada: '',
      submission_id_crossref: '',
      hasil_submission_log: '',
      doi_aktif_pada: '',
      nama_pemohon: aman_(payload.nama_pemohon),
      whatsapp_pemohon: aman_(String(payload.whatsapp_pemohon).replace(/[\s-]/g, '')),
      jabatan_pemohon: aman_(payload.jabatan_pemohon),
      jenis_konten: String(payload.jenis_konten).trim(),
      jumlah_doi: Number(payload.jumlah_doi),
      tanggal_publikasi: String(payload.tanggal_publikasi).trim(),
      persetujuan: true,
      receipt_pengajuan_status: '',
      receipt_pengajuan_pada: '',
      receipt_aktivasi_status: '',
      receipt_aktivasi_pada: ''
    };

    // DIPERBAIKI: baris disusun selebar kolom sheet yang sebenarnya, tiap
    // nilai ditempatkan pada indeks kolom sesuai NAMA HEADER — bukan urutan
    // DOI_HEADERS. Kolom lama yang tidak dikenal (mis. receipt_status sisa
    // skema lama) dibiarkan kosong, tidak menggeser apa pun.
    const row = new Array(info.lebar).fill('');
    Object.keys(record).forEach(function (nama) {
      var idx = info.peta[nama];
      if (idx !== undefined) row[idx] = record[nama];
    });

    sheet.appendRow(row);
    SpreadsheetApp.flush();

    catatAktivitas_(muatan.email, muatan.namaJurnal, 'AJUKAN_DOI',
      idUsulan + ' — ' + record.jenis_konten + ', ' + record.jumlah_doi + ' DOI');

    const barisKe = sheet.getLastRow();
    const receiptOk = kirimReceiptPengajuanDoi_(muatan.email, muatan.namaJurnal, record);

    if (info.peta['receipt_pengajuan_status'] !== undefined) {
      sheet.getRange(barisKe, info.peta['receipt_pengajuan_status'] + 1)
        .setValue(receiptOk ? 'terkirim' : 'gagal');
    }
    if (info.peta['receipt_pengajuan_pada'] !== undefined) {
      sheet.getRange(barisKe, info.peta['receipt_pengajuan_pada'] + 1).setValue(new Date());
    }

    const rowBaru = sheet.getRange(barisKe, 1, 1, info.lebar).getValues()[0];
    return {
      ok: true,
      message: 'Usulan DOI berhasil disimpan.' +
        (receiptOk ? '' : ' (Tanda terima email gagal terkirim, hubungi DJPI bila perlu konfirmasi.)'),
      item: barisDoiKeObjek_(info, rowBaru)
    };
  } catch (err) {
    return { ok: false, message: 'Gagal menyimpan: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function getUsulanDoi(token) {
  const profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();

  try {
    const sheet = getUsulanDoiSheet_();
    const info = petaKolomDoi_(sheet);
    const lastRow = sheet.getLastRow();

    if (lastRow < 2) return { ok: true, items: [], statusOptions: DOI_STATUS };

    // DIPERBAIKI: baca selebar kolom sheet yang sebenarnya (info.lebar),
    // bukan DOI_HEADERS.length yang bisa lebih pendek dan memotong kolom.
    const values = sheet.getRange(2, 1, lastRow - 1, info.lebar).getValues();

    const klusterByNama = {};
    bacaDataJurnal_().forEach(function (j) { klusterByNama[norm_(j.namaJurnal)] = j.kluster; });

    const items = values
      .filter(function (row) { return row.some(function (cell) { return cell !== ''; }); })
      .map(function (row) { return barisDoiKeObjek_(info, row); })
      .filter(function (item) {
        if (profile.isSuperadmin) return true;
        return bolehAksesKluster_(profile, klusterByNama[norm_(item.nama_jurnal)]);
      })
      .reverse();

    return { ok: true, items: items, statusOptions: DOI_STATUS };
  } catch (err) {
    return { ok: false, message: 'Gagal memuat usulan DOI: ' + err.message };
  }
}

function getUsulanDoiUntukPengelola(token) {
  const muatan = bacaToken_(token, 'edit_');
  if (!muatan) return sesiHabis_();

  try {
    const sheet = getUsulanDoiSheet_();
    const info = petaKolomDoi_(sheet);
    const lastRow = sheet.getLastRow();

    if (lastRow < 2) return { ok: true, items: [] };

    const values = sheet.getRange(2, 1, lastRow - 1, info.lebar).getValues();
    const target = norm_(muatan.namaJurnal);

    const items = values
      .filter(function (row) { return row.some(function (cell) { return cell !== ''; }); })
      .map(function (row) { return barisDoiKeObjek_(info, row); })
      .filter(function (item) { return norm_(item.nama_jurnal) === target; })
      .reverse();

    return { ok: true, items: items };
  } catch (err) {
    return { ok: false, message: 'Gagal memuat usulan DOI: ' + err.message };
  }
}

function ubahStatusUsulanDoi(token, payload) {
  const profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();

  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Data perubahan status DOI tidak valid.' };
  }

  const idUsulan = String(payload.id_usulan || '').trim();
  const status = String(payload.status || '').trim().toUpperCase();
  const catatanAdmin = String(payload.catatan_admin || '').trim();

  if (!idUsulan) return { ok: false, message: 'ID usulan DOI wajib tersedia.' };
  if (DOI_STATUS.indexOf(status) === -1) return { ok: false, message: 'Status DOI tidak valid.' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };
  }

  try {
    const sheet = getUsulanDoiSheet_();
    const info = petaKolomDoi_(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: false, message: 'Data usulan DOI belum tersedia.' };

    const kolomId = info.peta['id_usulan'];
    if (kolomId === undefined) return { ok: false, message: 'Kolom id_usulan tidak ditemukan pada sheet.' };

    const ids = sheet.getRange(2, kolomId + 1, lastRow - 1, 1).getValues().flat().map(String);
    const index = ids.indexOf(idUsulan);
    if (index === -1) return { ok: false, message: 'Usulan DOI dengan ID ' + idUsulan + ' tidak ditemukan.' };

    const rowNumber = index + 2;
    const item = barisDoiKeObjek_(info, sheet.getRange(rowNumber, 1, 1, info.lebar).getValues()[0]);

    if (!profile.isSuperadmin) {
      const cocokJurnal = cariJurnal_(bacaDataJurnal_(), item.nama_jurnal)[0];
      if (!bolehAksesKluster_(profile, cocokJurnal ? cocokJurnal.kluster : undefined)) {
        return { ok: false, message: 'Anda tidak memiliki akses ke kluster jurnal ini.' };
      }
    }

    if (status === 'SIAP_DIPROSES') {
      const cocokJurnal = cariJurnal_(bacaDataJurnal_(), item.nama_jurnal)[0];
      if (!cocokJurnal || !(cocokJurnal.issnValid || cocokJurnal.eIssnValid || cocokJurnal.pIssnValid)) {
        return {
          ok: false,
          message: 'Status tidak dapat diubah ke Siap Diproses: jurnal ini belum memiliki ISSN yang sah. ' +
                   'Perbaiki data ISSN jurnal terlebih dahulu.'
        };
      }
    }

    const statusLama = item.status;
    const sekarang = new Date();

    function tulis(namaKolom, nilai) {
      var idx = info.peta[namaKolom];
      if (idx !== undefined) sheet.getRange(rowNumber, idx + 1).setValue(nilai);
    }

    tulis('status', status);
    tulis('catatan_admin', catatanAdmin);
    tulis('diproses_oleh', profile.email);
    tulis('diproses_pada', sekarang);

    if (status === 'BERHASIL' && statusLama !== 'BERHASIL') {
      tulis('doi_aktif_pada', sekarang);
      const receiptOk = kirimReceiptAktivasiDoi_(item.email_pengelola, item.nama_jurnal, item);
      tulis('receipt_aktivasi_status', receiptOk ? 'terkirim' : 'gagal');
      tulis('receipt_aktivasi_pada', sekarang);
    }

    SpreadsheetApp.flush();
    catatAktivitas_(profile.email, item.nama_jurnal, 'UBAH_STATUS_DOI',
      idUsulan + ': ' + statusLama + ' -> ' + status);

    const rowBaru = sheet.getRange(rowNumber, 1, 1, info.lebar).getValues()[0];
    return {
      ok: true,
      message: 'Status usulan DOI berhasil diperbarui.',
      item: barisDoiKeObjek_(info, rowBaru)
    };
  } catch (err) {
    return { ok: false, message: 'Gagal memperbarui status: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function kirimUlangReceiptDoi(token, payload) {
  const profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();

  if (!payload || typeof payload !== 'object') return { ok: false, message: 'Data tidak valid.' };

  const idUsulan = String(payload.id_usulan || '').trim();
  const jenis = String(payload.jenis || '').trim();
  if (!idUsulan) return { ok: false, message: 'ID usulan wajib tersedia.' };
  if (['pengajuan', 'aktivasi'].indexOf(jenis) === -1) {
    return { ok: false, message: 'Jenis tanda terima tidak valid.' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };
  }

  try {
    const sheet = getUsulanDoiSheet_();
    const info = petaKolomDoi_(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: false, message: 'Data usulan DOI belum tersedia.' };

    const kolomId = info.peta['id_usulan'];
    if (kolomId === undefined) return { ok: false, message: 'Kolom id_usulan tidak ditemukan pada sheet.' };

    const ids = sheet.getRange(2, kolomId + 1, lastRow - 1, 1).getValues().flat().map(String);
    const index = ids.indexOf(idUsulan);
    if (index === -1) return { ok: false, message: 'Usulan DOI dengan ID ' + idUsulan + ' tidak ditemukan.' };

    const rowNumber = index + 2;
    const item = barisDoiKeObjek_(info, sheet.getRange(rowNumber, 1, 1, info.lebar).getValues()[0]);

    if (!profile.isSuperadmin) {
      const cocokJurnal = cariJurnal_(bacaDataJurnal_(), item.nama_jurnal)[0];
      if (!bolehAksesKluster_(profile, cocokJurnal ? cocokJurnal.kluster : undefined)) {
        return { ok: false, message: 'Anda tidak memiliki akses ke kluster jurnal ini.' };
      }
    }

    if (jenis === 'aktivasi' && item.status !== 'BERHASIL') {
      return { ok: false, message: 'Tanda terima aktivasi hanya dapat dikirim ulang untuk usulan berstatus Berhasil.' };
    }

    var berhasilKirim, kolomStatus, kolomWaktu;
    if (jenis === 'pengajuan') {
      berhasilKirim = kirimReceiptPengajuanDoi_(item.email_pengelola, item.nama_jurnal, item);
      kolomStatus = 'receipt_pengajuan_status';
      kolomWaktu = 'receipt_pengajuan_pada';
    } else {
      berhasilKirim = kirimReceiptAktivasiDoi_(item.email_pengelola, item.nama_jurnal, item);
      kolomStatus = 'receipt_aktivasi_status';
      kolomWaktu = 'receipt_aktivasi_pada';
    }

    if (info.peta[kolomStatus] !== undefined) {
      sheet.getRange(rowNumber, info.peta[kolomStatus] + 1).setValue(berhasilKirim ? 'terkirim' : 'gagal');
    }
    if (info.peta[kolomWaktu] !== undefined) {
      sheet.getRange(rowNumber, info.peta[kolomWaktu] + 1).setValue(new Date());
    }
    SpreadsheetApp.flush();

    catatAktivitas_(profile.email, item.nama_jurnal, 'KIRIM_ULANG_RECEIPT_DOI',
      idUsulan + ' (' + jenis + '): ' + (berhasilKirim ? 'terkirim' : 'gagal'));

    if (!berhasilKirim) {
      return { ok: false, message: 'Pengiriman ulang gagal. Coba lagi beberapa saat, atau kirim manual ke pengelola.' };
    }

    const rowBaru = sheet.getRange(rowNumber, 1, 1, info.lebar).getValues()[0];
    return {
      ok: true,
      message: 'Tanda terima berhasil dikirim ulang.',
      item: barisDoiKeObjek_(info, rowBaru)
    };
  } catch (err) {
    return { ok: false, message: 'Gagal mengirim ulang: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}


/* ==========================================================================
   18. MODUL LOGIN PENGELOLA BERBASIS EMAIL
   ========================================================================== */

var PILIH_TTL = 600; // token pemilihan jurnal berumur pendek, 10 menit

function requestPengelolaPin(email) {
  var jawabanSeragam = {
    ok: true,
    message: 'Jika email tersebut terdaftar sebagai pengelola jurnal, PIN telah dikirim. Periksa kotak masuk Anda.'
  };

  try {
    var bersih = str_(email).toLowerCase();
    if (!emailValid_(bersih)) return jawabanSeragam;

    if (!lolosRateLimit_('pengelola', bersih)) {
      return { ok: false, message: 'Terlalu banyak permintaan PIN. Coba lagi dalam satu jam.' };
    }

    var cocok = cariJurnalByEmail_(bersih);
    if (!cocok.length) {
      console.warn('requestPengelolaPin: email tidak terhubung ke jurnal mana pun -> ' + bersih);
      return jawabanSeragam;
    }

    var pin = pinAcak_();
    var kunci = kunciPendek_('pin_pengelola_', bersih);
    CacheService.getScriptCache().put(kunci, hash_(pin), CACHE.PIN_TTL);
    resetPinGuard_(kunci);

    var daftarNama = cocok.map(function (j) { return '  - ' + j.namaJurnal; }).join('\n');
    var emailPinPengelola = renderTemplateEmail_('pin_pengelola', {
      pin: pin, jumlahJurnal: cocok.length, daftarJurnal: daftarNama
    });

    GmailApp.sendEmail(bersih, emailPinPengelola.subjek, emailPinPengelola.isi);
    console.log('requestPengelolaPin: PIN terkirim ke ' + bersih + ' (' + cocok.length + ' jurnal)');

    return jawabanSeragam;
  } catch (err) {
    console.error('requestPengelolaPin gagal: ' + err.message);
    return jawabanSeragam;
  }
}

function verifyPengelolaPin(email, pin) {
  try {
    var bersih = str_(email).toLowerCase();
    var kunci = kunciPendek_('pin_pengelola_', bersih);

    var guard = statusPinGuard_(kunci);
    if (guard.locked) {
      return { ok: false, message: 'Terlalu banyak percobaan PIN salah. Coba lagi beberapa menit lagi.' };
    }

    var tersimpan = CacheService.getScriptCache().get(kunci);
    if (!tersimpan) return { ok: false, message: 'PIN salah atau sudah kedaluwarsa.' };

    if (!samaAman_(tersimpan, hash_(str_(pin)))) {
      var status = catatPinSalah_(kunci);
      if (status.locked) {
        CacheService.getScriptCache().remove(kunci);
        return { ok: false, message: 'Terlalu banyak percobaan PIN salah. Minta PIN baru atau coba lagi beberapa menit lagi.' };
      }
      return { ok: false, message: 'PIN salah atau sudah kedaluwarsa.' };
    }

    CacheService.getScriptCache().remove(kunci);
    resetPinGuard_(kunci);

    var cocok = cariJurnalByEmail_(bersih);
    if (!cocok.length) return { ok: false, message: 'Email ini tidak terhubung ke jurnal mana pun.' };

    // Satu jurnal: langsung beri token edit_, tanpa langkah pemilihan.
    if (cocok.length === 1) {
      var muatan = { namaJurnal: cocok[0].namaJurnal, email: cocok[0].email };
      catatAktivitas_(bersih, cocok[0].namaJurnal, 'LOGIN_PENGELOLA', 'Masuk lewat email');
      return {
        ok: true,
        perluPilih: false,
        token: buatToken_('edit_', muatan, CACHE.EDIT_TTL),
        namaJurnal: cocok[0].namaJurnal
      };
    }

    // Banyak jurnal: kembalikan token pemilihan + daftar nama jurnal.
    // Daftar jurnal disimpan DI DALAM token (sisi server), sehingga klien
    // tidak bisa menambahkan jurnal lain ke daftar pilihannya sendiri.
    var daftarNama = cocok.map(function (j) { return j.namaJurnal; });
    var tokenPilih = buatToken_('pilih_', { email: bersih, daftarJurnal: daftarNama }, PILIH_TTL);

    return {
      ok: true,
      perluPilih: true,
      token: tokenPilih,
      daftarJurnal: cocok.map(function (j) {
        return { namaJurnal: j.namaJurnal, kluster: j.kluster, statusAkreditasi: j.statusAkreditasi };
      })
    };
  } catch (err) {
    return { ok: false, message: 'Terjadi kesalahan: ' + err.message };
  }
}

function pilihJurnalPengelola(token, namaJurnal) {
  var muatan = bacaToken_(token, 'pilih_');
  if (!muatan) return sesiHabis_();

  var target = norm_(namaJurnal);
  var diizinkan = (muatan.daftarJurnal || []).some(function (n) { return norm_(n) === target; });
  if (!diizinkan) {
    return { ok: false, message: 'Jurnal tersebut tidak termasuk dalam daftar kelolaan email Anda.' };
  }

  var cocok = cariJurnal_(bacaDataJurnal_(), namaJurnal);
  if (cocok.length !== 1) return { ok: false, message: 'Jurnal tidak ditemukan atau namanya ganda.' };

  CacheService.getScriptCache().remove(token); // token pemilihan sekali pakai

  var edit = { namaJurnal: cocok[0].namaJurnal, email: cocok[0].email };
  catatAktivitas_(muatan.email, cocok[0].namaJurnal, 'LOGIN_PENGELOLA', 'Masuk lewat email, jurnal dipilih');

  return {
    ok: true,
    token: buatToken_('edit_', edit, CACHE.EDIT_TTL),
    namaJurnal: cocok[0].namaJurnal
  };
}

function cariJurnalByEmail_(email) {
  var target = String(email || '').toLowerCase().trim();
  if (!target) return [];

  return bacaDataJurnal_().filter(function (j) {
    if (!j.punyaEmail) return false; // email rusak/kosong tidak bisa dipakai login
    var e = str_(j.email).replace(/^MAILTO:/i, '').toLowerCase().trim();
    return e === target;
  });
}


/* ==========================================================================
   19. MODUL PENCAIRAN APC (10% UPI, 2% DPPM, sisanya dana terserap jurnal)
   ========================================================================== */

var PERSEN_ALOKASI_UPI = 0.10;
var PERSEN_ALOKASI_DPPM = 0.02;
// Sisanya (1 - 0.10 - 0.02 = 0.88) adalah dana terserap milik jurnal.

var PENCAIRAN_HEADERS = [
  'Timestamp', 'Nama Jurnal', 'Jumlah Diajukan',
  'Alokasi UPI', 'Alokasi DPPM', 'Dana Terserap Jurnal',
  'Dicatat Oleh', 'Catatan'
];

function getLogPencairanSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET.LOG_PENCAIRAN);
  if (!sh) {
    sh = ss.insertSheet(SHEET.LOG_PENCAIRAN);
    sh.appendRow(PENCAIRAN_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function bacaLogPencairanApc_() {
  var cache = CacheService.getScriptCache();
  var tersimpan = cache.get(CACHE.PENCAIRAN_LOG);
  if (tersimpan) {
    try { return JSON.parse(tersimpan); } catch (err) { /* cache rusak, baca ulang */ }
  }

  var sh = getLogPencairanSheet_();
  var nilai = sh.getDataRange().getValues();
  if (nilai.length < 2) return { baris: [] };

  var header = nilai[0].map(norm_);
  function kolom(nama) { return header.indexOf(norm_(nama)); }

  var idx = {
    timestamp: kolom('Timestamp'),
    nama: kolom('Nama Jurnal'),
    diajukan: kolom('Jumlah Diajukan'),
    upi: kolom('Alokasi UPI'),
    dppm: kolom('Alokasi DPPM'),
    terserap: kolom('Dana Terserap Jurnal'),
    dicatatOleh: kolom('Dicatat Oleh'),
    catatan: kolom('Catatan')
  };

  var baris = [];
  for (var r = 1; r < nilai.length; r++) {
    var nama = idx.nama === -1 ? '' : str_(nilai[r][idx.nama]);
    if (!nama) continue;
    baris.push({
      timestamp: idx.timestamp === -1 ? '' : str_(nilai[r][idx.timestamp]),
      namaJurnal: nama,
      diajukan: idx.diajukan === -1 ? 0 : angka_(nilai[r][idx.diajukan]),
      upi: idx.upi === -1 ? 0 : angka_(nilai[r][idx.upi]),
      dppm: idx.dppm === -1 ? 0 : angka_(nilai[r][idx.dppm]),
      terserap: idx.terserap === -1 ? 0 : angka_(nilai[r][idx.terserap]),
      dicatatOleh: idx.dicatatOleh === -1 ? '' : str_(nilai[r][idx.dicatatOleh]),
      catatan: idx.catatan === -1 ? '' : str_(nilai[r][idx.catatan])
    });
  }

  var hasil = { baris: baris };
  try {
    var json = JSON.stringify(hasil);
    if (json.length < CACHE.MAX_VALUE_BYTES) cache.put(CACHE.PENCAIRAN_LOG, json, CACHE.PENCAIRAN_LOG_TTL);
  } catch (err) {}

  return hasil;
}

function bersihkanCachePencairanApc_() {
  CacheService.getScriptCache().remove(CACHE.PENCAIRAN_LOG);
}

function catatPencairanApc(token, entry) {
  var sesi = bacaToken_(token, 'session_');
  if (!sesi) return sesiHabis_();

  if (!entry || typeof entry !== 'object') return { ok: false, message: 'Data pencairan kosong.' };

  var nama = str_(entry.namaJurnal);
  var jumlah = angka_(entry.jumlahDiajukan);
  var catatan = str_(entry.catatan || '');

  if (!nama) return { ok: false, message: 'Nama jurnal wajib dipilih.' };
  if (jumlah <= 0) return { ok: false, message: 'Jumlah diajukan harus lebih dari nol.' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };

  try {
    var cocok = cariJurnal_(bacaDataJurnal_(), nama);
    if (cocok.length === 0) return { ok: false, message: 'Jurnal tidak ditemukan.' };
    if (cocok.length > 1) return { ok: false, message: 'Nama jurnal ganda, hubungi administrator.' };
    if (!sesi.isSuperadmin && !bolehAksesKluster_(sesi, cocok[0].kluster)) {
      return { ok: false, message: 'Anda tidak memiliki akses ke kluster jurnal ini.' };
    }

    var alokasiUpi = Math.round(jumlah * PERSEN_ALOKASI_UPI);
    var alokasiDppm = Math.round(jumlah * PERSEN_ALOKASI_DPPM);
    var terserap = jumlah - alokasiUpi - alokasiDppm;

    var sh = getLogPencairanSheet_();
    sh.appendRow([
      Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
      aman_(cocok[0].namaJurnal),
      jumlah, alokasiUpi, alokasiDppm, terserap,
      aman_(sesi.email), aman_(catatan)
    ]);
    SpreadsheetApp.flush();

    catatAktivitas_(sesi.email, cocok[0].namaJurnal, 'PENCAIRAN_APC',
      JSON.stringify({ diajukan: jumlah, upi: alokasiUpi, dppm: alokasiDppm, terserap: terserap }));
    bersihkanCachePencairanApc_();

    return {
      ok: true,
      message: 'Pencairan tercatat: Rp' + terserap.toLocaleString('id-ID') + ' terserap jurnal, ' +
                'Rp' + alokasiUpi.toLocaleString('id-ID') + ' ke UPI, ' +
                'Rp' + alokasiDppm.toLocaleString('id-ID') + ' ke DPPM.'
    };
  } catch (err) {
    return { ok: false, message: 'Gagal mencatat: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function rekapPencairanApc_(terlihat, profile) {
  var kosong = { totalDiajukan: 0, totalUpi: 0, totalDppm: 0, totalTerserap: 0, jumlahEntri: 0 };

  var log = bacaLogPencairanApc_();
  if (!log.baris.length) return kosong;

  var klusterPer = {};
  terlihat.forEach(function (j) { klusterPer[norm_(j.namaJurnal)] = j.kluster; });

  var hasil = { totalDiajukan: 0, totalUpi: 0, totalDppm: 0, totalTerserap: 0, jumlahEntri: 0 };

  log.baris.forEach(function (b) {
    var kunci = norm_(b.namaJurnal);
    if (!profile.isSuperadmin && klusterPer[kunci] === undefined) return;

    hasil.totalDiajukan += b.diajukan;
    hasil.totalUpi += b.upi;
    hasil.totalDppm += b.dppm;
    hasil.totalTerserap += b.terserap;
    hasil.jumlahEntri++;
  });

  return hasil;
}

function logApcEntry(token, entry) {
  var sesi = bacaToken_(token, 'session_');
  var edit = sesi ? null : bacaToken_(token, 'edit_');
  if (!sesi && !edit) return sesiHabis_();

  var pelaku = sesi ? sesi.email : edit.email;
  if (!entry || typeof entry !== 'object') return { ok: false, message: 'Data laporan kosong.' };

  var nama = str_(entry.namaJurnal);
  if (edit && norm_(edit.namaJurnal) !== norm_(nama)) {
    return { ok: false, message: 'Token tidak berlaku untuk jurnal ini.' };
  }

  var edisi = str_(entry.edisi);
  var jumlahArtikel = angka_(entry.jumlahArtikel);
  var total = angka_(entry.total);

  if (!nama) return { ok: false, message: 'Nama jurnal wajib diisi.' };
  if (!edisi) return { ok: false, message: 'Edisi laporan wajib diisi.' };
  if (jumlahArtikel < 0 || total < 0) return { ok: false, message: 'Nilai tidak boleh negatif.' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };

  try {
    var daftar = bacaDataJurnal_();
    var cocok = cariJurnal_(daftar, nama);
    if (cocok.length === 0) return { ok: false, message: 'Jurnal tidak ditemukan.' };
    if (cocok.length > 1) return { ok: false, message: 'Nama jurnal ganda, hubungi administrator.' };
    if (sesi && !bolehAksesKluster_(sesi, cocok[0].kluster)) {
      return { ok: false, message: 'Anda tidak memiliki akses ke kluster jurnal ini.' };
    }

    var sh = sheetWajib_(SHEET.LOG_APC);
    // Kolom honor/pengembangan tetap ada di sheet lama untuk kompatibilitas,
    // ditulis kosong karena tidak lagi diisi pengelola.
    sh.appendRow([
      Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
      aman_(pelaku), aman_(cocok[0].namaJurnal), aman_(edisi),
      jumlahArtikel, total, '', ''
    ]);
    SpreadsheetApp.flush();

    catatAktivitas_(pelaku, cocok[0].namaJurnal, 'LAPOR_APC',
      JSON.stringify({ edisi: edisi, artikel: jumlahArtikel, total: total }));
    bersihkanCacheApc_();

    return { ok: true, message: 'Laporan APC berhasil dicatat.' };
  } catch (err) {
    return { ok: false, message: 'Gagal mencatat: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

function rekapApc_(terlihat, profile) {
  var pencairan = rekapPencairanApc_(terlihat, profile);

  var kosongDefault = {
    totalPemasukan: 0, jumlahEntri: 0, jumlahJurnalBerApc: 0,
    perKluster: [], topJurnal: [], riwayat: [], entriTerbesar: null, rataRataEntri: 0, kosong: true,
    pesanKosong: 'Belum ada data pemasukan APC yang tercatat. Rekap akan muncul setelah pengelola jurnal mengisi laporan pertama.',
    pencairan: pencairan
  };

  var log = bacaLogApc_();
  if (!log.baris.length) return kosongDefault;

  var klusterPer = {};
  terlihat.forEach(function (j) { klusterPer[norm_(j.namaJurnal)] = j.kluster; });

  var totalPemasukan = 0, jumlahEntri = 0;
  var perKluster = {}, perJurnal = {}, riwayat = [], entriTerbesar = null;

  log.baris.forEach(function (b) {
    var kunci = norm_(b.namaJurnal);
    if (!profile.isSuperadmin && klusterPer[kunci] === undefined) return;
    var kluster = klusterPer[kunci] || KLUSTER_KOSONG;

    totalPemasukan += b.total;
    jumlahEntri++;

    if (!perKluster[kluster]) perKluster[kluster] = { nama: kluster, total: 0, entri: 0 };
    perKluster[kluster].total += b.total; perKluster[kluster].entri++;

    if (!perJurnal[b.namaJurnal]) perJurnal[b.namaJurnal] = { namaJurnal: b.namaJurnal, total: 0, artikel: 0 };
    perJurnal[b.namaJurnal].total += b.total;
    perJurnal[b.namaJurnal].artikel += b.jumlahArtikel;

    // baru: riwayat laporan mentah (tab "Riwayat Laporan APC") + entri terbesar untuk KPI
    riwayat.push({
      timestamp: b.timestamp, namaJurnal: b.namaJurnal, kluster: kluster,
      edisi: b.edisi, jumlahArtikel: b.jumlahArtikel, total: b.total
    });
    if (!entriTerbesar || b.total > entriTerbesar.total) {
      entriTerbesar = { namaJurnal: b.namaJurnal, edisi: b.edisi, total: b.total };
    }
  });

  if (!jumlahEntri) return kosongDefault;

  riwayat.sort(function (a, b) { return b.timestamp.localeCompare(a.timestamp); }); // terbaru dulu

  return {
    totalPemasukan: totalPemasukan,
    jumlahEntri: jumlahEntri,
    jumlahJurnalBerApc: Object.keys(perJurnal).length, // GANTI dari jumlah kluster
    perKluster: Object.keys(perKluster).map(function (k) { return perKluster[k]; })
      .sort(function (a, b) { return b.total - a.total; }),
    topJurnal: Object.keys(perJurnal).map(function (k) { return perJurnal[k]; })
      .sort(function (a, b) { return b.total - a.total; }).slice(0, 10),
    riwayat: riwayat, // baru: baris laporan mentah untuk tab Riwayat Laporan APC
    entriTerbesar: entriTerbesar, // baru
    rataRataEntri: Math.round(totalPemasukan / jumlahEntri), // baru
    kosong: false,
    pesanKosong: '',
    pencairan: pencairan // { totalDiajukan, totalUpi, totalDppm, totalTerserap, jumlahEntri }
  };
}

/* ==========================================================================
   20. MODUL LAPOR PROGRESS TERBITAN (Log_Terbitan)
   --------------------------------------------------------------------------
   Pengelola melaporkan tahap naskah per EDISI (bukan per artikel), append-
   only sama seperti Log_APC — satu submit = satu baris baru, baris lama
   tidak pernah disunting. Riwayat status sebelumnya tetap tersimpan sebagai
   jejak progres.

   Data ini BERDAMPINGAN dengan kolom TIMELINESS di Sheet1, BUKAN pengganti.
   Admin tetap yang menentukan nilai TIMELINESS resmi secara manual — modul
   ini tidak pernah menulis balik ke Sheet1.
   ========================================================================== */

var TERBITAN_STATUS = [
  'INITIAL_SCREENING',
  'DESK_REVIEW',
  'PEER_REVIEW',
  'DECISION',
  'COPYEDIT',
  'PUBLISH'
];

function bacaLogTerbitan_() {
  var cache = CacheService.getScriptCache();
  var tersimpan = cache.get(CACHE.TERBITAN_LOG);
  if (tersimpan) {
    try { return JSON.parse(tersimpan); } catch (err) { /* cache rusak, baca ulang */ }
  }

  var sh = sheetOpsional_(SHEET.LOG_TERBITAN);
  if (!sh) return { baris: [] };
  var nilai = sh.getDataRange().getValues();
  if (nilai.length < 2) return { baris: [] };

  var header = nilai[0].map(norm_);
  function kolom(nama) { return header.indexOf(norm_(nama)); }

  var idx = {
    timestamp: kolom('Timestamp'),
    email: kolom('Email Pengelola'),
    nama: kolom('Nama Jurnal'),
    edisi: kolom('Edisi Terbitan'),
    status: kolom('Status Naskah'),
    catatan: kolom('Catatan / Kendala')
  };

  var baris = [];
  for (var r = 1; r < nilai.length; r++) {
    var nama = idx.nama === -1 ? '' : str_(nilai[r][idx.nama]);
    if (!nama) continue;
    baris.push({
      timestamp: idx.timestamp === -1 ? '' : str_(nilai[r][idx.timestamp]),
      email: idx.email === -1 ? '' : str_(nilai[r][idx.email]),
      namaJurnal: nama,
      edisi: idx.edisi === -1 ? '' : str_(nilai[r][idx.edisi]),
      status: idx.status === -1 ? '' : str_(nilai[r][idx.status]),
      catatan: idx.catatan === -1 ? '' : str_(nilai[r][idx.catatan])
    });
  }

  var hasil = { baris: baris };
  try {
    var json = JSON.stringify(hasil);
    if (json.length < CACHE.MAX_VALUE_BYTES) cache.put(CACHE.TERBITAN_LOG, json, CACHE.TERBITAN_LOG_TTL);
  } catch (err) {}

  return hasil;
}

function bersihkanCacheTerbitan_() {
  CacheService.getScriptCache().remove(CACHE.TERBITAN_LOG);
}

/**
 * Pengelola melaporkan progres naskah untuk satu edisi. WAJIB token 'edit_'
 * — admin tidak melapor progres, hanya memonitor lewat rekapProgressTerbitan_.
 * Timestamp, Email Pengelola, dan Nama Jurnal diisi dari token, TIDAK PERNAH
 * dari payload klien, sama seperti logApcEntry.
 * Endpoint: gs('logProgressTerbitan', token, entry).
 */
function logProgressTerbitan(token, entry) {
  var muatan = bacaToken_(token, 'edit_');
  if (!muatan) return sesiHabis_();

  if (!entry || typeof entry !== 'object') return { ok: false, message: 'Data laporan kosong.' };

  var edisi = str_(entry.edisi);
  var status = String(entry.status || '').trim().toUpperCase();
  var catatan = str_(entry.catatan || '');

  if (!edisi) return { ok: false, message: 'Edisi terbitan wajib diisi.' };
  if (TERBITAN_STATUS.indexOf(status) === -1) return { ok: false, message: 'Status naskah tidak valid.' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };

  try {
    var sh = sheetWajib_(SHEET.LOG_TERBITAN);
    sh.appendRow([
      Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
      aman_(muatan.email), aman_(muatan.namaJurnal), aman_(edisi), status, aman_(catatan)
    ]);
    SpreadsheetApp.flush();

    catatAktivitas_(muatan.email, muatan.namaJurnal, 'LAPOR_PROGRESS_TERBITAN',
      JSON.stringify({ edisi: edisi, status: status }));
    bersihkanCacheTerbitan_();

    return { ok: true, message: 'Progres terbitan berhasil dicatat.' };
  } catch (err) {
    return { ok: false, message: 'Gagal mencatat: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Riwayat laporan progres milik SATU jurnal saja, untuk Dashboard Pengelola.
 * Endpoint: gs('getProgressTerbitanUntukPengelola', token).
 */
function getProgressTerbitanUntukPengelola(token) {
  var muatan = bacaToken_(token, 'edit_');
  if (!muatan) return sesiHabis_();

  try {
    var log = bacaLogTerbitan_();
    var target = norm_(muatan.namaJurnal);
    var items = log.baris
      .filter(function (b) { return norm_(b.namaJurnal) === target; })
      .slice()
      .reverse(); // terbaru lebih dulu

    return { ok: true, items: items, statusOptions: TERBITAN_STATUS };
  } catch (err) {
    return { ok: false, message: 'Gagal memuat riwayat: ' + err.message };
  }
}

/**
 * Rekap progres terbitan untuk Dashboard Admin, terfilter akses kluster
 * (superadmin melihat semua), dipanggil dari getDashboardDataForAdmin().
 *
 * kpi dihitung dari status TERKINI tiap edisi (kunci: nama jurnal + edisi),
 * bukan dari seluruh baris riwayat — supaya satu edisi yang sudah maju ke
 * tahap berikutnya tidak ikut dihitung dobel di tahap lamanya. bacaLogTerbitan_
 * mengembalikan baris dalam urutan kronologis lama->baru, sehingga penulisan
 * terakhir ke terbaruPerEdisi untuk kunci yang sama pasti yang paling baru.
 */
function rekapProgressTerbitan_(terlihat, profile) {
  var kosong = { items: [], kpi: {}, statusOptions: TERBITAN_STATUS };
  TERBITAN_STATUS.forEach(function (s) { kosong.kpi[s] = 0; });

  var log = bacaLogTerbitan_();
  if (!log.baris.length) return kosong;

  var klusterPer = {};
  terlihat.forEach(function (j) { klusterPer[norm_(j.namaJurnal)] = j.kluster; });

  var items = [];
  var terbaruPerEdisi = {}; // kunci: "namaJurnalNorm|edisiNorm" -> status baris terakhir

  log.baris.forEach(function (b) {
    var kunciJurnal = norm_(b.namaJurnal);
    if (!profile.isSuperadmin && klusterPer[kunciJurnal] === undefined) return; // di luar akses kluster

    items.push({
      namaJurnal: b.namaJurnal,
      kluster: klusterPer[kunciJurnal] || '',
      edisi: b.edisi,
      status: b.status,
      catatan: b.catatan,
      timestamp: b.timestamp
    });

    var kunciEdisi = kunciJurnal + '|' + norm_(b.edisi);
    terbaruPerEdisi[kunciEdisi] = b.status;
  });

  var kpi = {};
  TERBITAN_STATUS.forEach(function (s) { kpi[s] = 0; });
  Object.keys(terbaruPerEdisi).forEach(function (k) {
    var s = terbaruPerEdisi[k];
    if (kpi[s] !== undefined) kpi[s]++;
  });

  items.reverse(); // tampilkan yang terbaru lebih dulu

  return { items: items, kpi: kpi, statusOptions: TERBITAN_STATUS };
}

/* ==========================================================================
   21. MODUL TEMPLATE EMAIL KE PENGELOLA
   --------------------------------------------------------------------------
   Subjek & isi 5 email otomatis yang dikirim ke pengelola jurnal, disimpan
   di sheet Template_Email supaya admin bisa mengubahnya tanpa menyentuh
   kode. HANYA kolom Subjek & Isi yang disimpan di sheet dan bisa diedit —
   nama tampilan, catatan pemicu, dan daftar variabel WAJIB tetap di
   TEMPLATE_EMAIL_DEFAULT (kode), supaya admin tidak bisa tidak sengaja
   melumpuhkan validasi variabel wajib lewat Sheets langsung.

   PIN Masuk Admin (requestAdminPin) SENGAJA tidak masuk modul ini — itu
   email untuk admin sendiri, bukan untuk pengelola jurnal.
   ========================================================================== */

var TEMPLATE_EMAIL_DEFAULT = {
  pin_jurnal: {
    nama: 'PIN Verifikasi Pengelola',
    catatan: 'Dikirim oleh requestJournalPin saat pengelola satu jurnal minta akses sunting/lapor APC lewat token per-jurnal.',
    variabelWajib: ['{{pin}}', '{{namaJurnal}}'],
    subjek: 'PIN Verifikasi Pengelola — {{namaJurnal}}',
    isi: 'PIN Anda: {{pin}}\n\nPIN berlaku 5 menit untuk menyunting data jurnal "{{namaJurnal}}".\n' +
      'Abaikan email ini bila Anda tidak meminta akses.\n\n— Divisi Jurnal dan Publikasi Ilmiah UPI'
  },
  pin_pengelola: {
    nama: 'PIN Masuk Pengelola',
    catatan: 'Dikirim oleh requestPengelolaPin saat pengelola login lewat Dashboard Pengelola berbasis email (bisa mengelola lebih dari satu jurnal).',
    variabelWajib: ['{{pin}}', '{{jumlahJurnal}}', '{{daftarJurnal}}'],
    subjek: 'PIN Masuk Dashboard Pengelola Jurnal',
    isi: 'PIN Anda: {{pin}}\n\nPIN berlaku 5 menit untuk masuk ke Dashboard Pengelola Jurnal.\n\n' +
      'Email ini terdaftar sebagai pengelola untuk {{jumlahJurnal}} jurnal:\n{{daftarJurnal}}\n\n' +
      'Abaikan email ini bila Anda tidak meminta akses.\n\n— Divisi Jurnal dan Publikasi Ilmiah UPI'
  },
  pengingat: {
    nama: 'Pengingat Jadwal Terbit',
    catatan: 'Dikirim oleh kirimPengingatTerbitan saat admin mengirim pengingat manual dari modal jadwal terbit di tab Ringkasan.',
    variabelWajib: ['{{namaJurnal}}', '{{bulan}}', '{{jadwalTerbitan}}', '{{unitPengelola}}', '{{kluster}}'],
    subjek: 'Pengingat Jadwal Terbitan {{bulan}} — {{namaJurnal}}',
    isi: 'Yth. Pengelola {{namaJurnal}},\n\n' +
      'Berdasarkan data Divisi Jurnal dan Publikasi Ilmiah UPI, jurnal Anda dijadwalkan terbit pada bulan {{bulan}}.\n\n' +
      'Jadwal terbitan terdaftar : {{jadwalTerbitan}}\n' +
      'Unit pengelola            : {{unitPengelola}}\n' +
      'Kluster                   : {{kluster}}\n\n' +
      'Mohon pastikan proses penerbitan berjalan sesuai jadwal. Bila terdapat kendala, silakan hubungi ' +
      'Divisi Jurnal dan Publikasi Ilmiah UPI agar dapat dibantu.\n\n' +
      'Email ini dikirim otomatis dari DJPI Dashboard dan tidak perlu dibalas.\n\n' +
      '— Divisi Jurnal dan Publikasi Ilmiah\nUniversitas Pendidikan Indonesia'
  },
  doi_pengajuan: {
    nama: 'Tanda Terima Usulan DOI',
    catatan: 'Dikirim oleh kirimReceiptPengajuanDoi_ otomatis begitu pengelola mengirim usulan aktivasi DOI.',
    variabelWajib: ['{{namaJurnal}}', '{{idUsulan}}', '{{jenisKonten}}', '{{judulArtikel}}', '{{jumlahDoi}}'],
    subjek: 'Tanda Terima Usulan Aktivasi DOI — {{namaJurnal}}',
    isi: 'Yth. Pengelola {{namaJurnal}},\n\n' +
      'Usulan aktivasi DOI Anda telah kami terima dengan rincian berikut:\n\n' +
      'ID Usulan       : {{idUsulan}}\n' +
      'Jenis konten    : {{jenisKonten}}\n' +
      'Judul/Edisi     : {{judulArtikel}}\n' +
      'Jumlah DOI      : {{jumlahDoi}}\n' +
      'Status saat ini : Menunggu Validasi\n\n' +
      'Kami akan menginformasikan perkembangan usulan ini melalui email berikutnya.\n\n' +
      'Email ini dikirim otomatis dari DJPI Dashboard dan tidak perlu dibalas.\n\n' +
      '— Divisi Jurnal dan Publikasi Ilmiah\nUniversitas Pendidikan Indonesia'
  },
  doi_aktif: {
    nama: 'DOI Aktif',
    catatan: 'Dikirim oleh kirimReceiptAktivasiDoi_ otomatis begitu admin mengubah status usulan DOI menjadi BERHASIL.',
    variabelWajib: ['{{namaJurnal}}', '{{idUsulan}}', '{{judulArtikel}}', '{{doiDiusulkan}}'],
    subjek: 'DOI Aktif — {{namaJurnal}}',
    isi: 'Yth. Pengelola {{namaJurnal}},\n\n' +
      'DOI untuk usulan berikut telah berhasil diaktifkan:\n\n' +
      'ID Usulan       : {{idUsulan}}\n' +
      'Judul/Edisi     : {{judulArtikel}}\n' +
      'DOI aktif       : {{doiDiusulkan}}\n\n' +
      'Terima kasih atas kerja sama Anda.\n\n' +
      'Email ini dikirim otomatis dari DJPI Dashboard dan tidak perlu dibalas.\n\n' +
      '— Divisi Jurnal dan Publikasi Ilmiah\nUniversitas Pendidikan Indonesia'
  }
};

var TEMPLATE_EMAIL_HEADER = ['Kunci', 'Subjek', 'Isi', 'Diubah Oleh', 'Diubah Pada'];

/**
 * Get-or-create sheet Template_Email. Kalau baru dibuat, sheet di-seed
 * langsung dengan TEMPLATE_EMAIL_DEFAULT supaya admin melihat teks yang
 * SEKARANG benar-benar terkirim, bukan baris kosong.
 */
function getTemplateEmailSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET.TEMPLATE_EMAIL);
  if (!sh) {
    sh = ss.insertSheet(SHEET.TEMPLATE_EMAIL);
    sh.appendRow(TEMPLATE_EMAIL_HEADER);
    sh.setFrozenRows(1);
    Object.keys(TEMPLATE_EMAIL_DEFAULT).forEach(function (kunci) {
      var t = TEMPLATE_EMAIL_DEFAULT[kunci];
      sh.appendRow([kunci, t.subjek, t.isi, '', '']);
    });
  }
  return sh;
}

/** Baca sheet Template_Email -> map kunci -> {subjek, isi}. Cache 1 jam. */
function bacaTemplateEmail_() {
  var cache = CacheService.getScriptCache();
  var tersimpan = cache.get(CACHE.TEMPLATE_EMAIL);
  if (tersimpan) {
    try { return JSON.parse(tersimpan); } catch (err) { /* cache rusak, baca ulang */ }
  }

  var sh = getTemplateEmailSheet_();
  var nilai = sh.getDataRange().getValues();
  var hasil = {};
  if (nilai.length >= 2) {
    var header = nilai[0].map(norm_);
    var iKunci = header.indexOf(norm_('Kunci'));
    var iSubjek = header.indexOf(norm_('Subjek'));
    var iIsi = header.indexOf(norm_('Isi'));
    for (var r = 1; r < nilai.length; r++) {
      var kunci = iKunci === -1 ? '' : str_(nilai[r][iKunci]);
      if (!kunci) continue;
      hasil[kunci] = {
        subjek: iSubjek === -1 ? '' : str_(nilai[r][iSubjek]),
        isi: iIsi === -1 ? '' : str_(nilai[r][iIsi])
      };
    }
  }

  try {
    var json = JSON.stringify(hasil);
    if (json.length < CACHE.MAX_VALUE_BYTES) cache.put(CACHE.TEMPLATE_EMAIL, json, CACHE.TEMPLATE_EMAIL_TTL);
  } catch (err) {}

  return hasil;
}

function bersihkanCacheTemplateEmail_() {
  CacheService.getScriptCache().remove(CACHE.TEMPLATE_EMAIL);
}

/**
 * Susun subjek & isi email siap kirim untuk satu kunci template, dengan
 * tiap {{variabel}} diganti nilai sungguhan. Dipanggil dari titik-titik
 * kirim email (requestJournalPin, requestPengelolaPin,
 * kirimPengingatTerbitan, kirimReceiptPengajuanDoi_, kirimReceiptAktivasiDoi_).
 *
 * Fallback ke TEMPLATE_EMAIL_DEFAULT bila sheet/baris tidak ditemukan,
 * supaya pengiriman email tidak pernah gagal gara-gara sheet ini rusak
 * atau belum sempat dibuat.
 */
function renderTemplateEmail_(kunci, variabel) {
  var bawaan = TEMPLATE_EMAIL_DEFAULT[kunci];
  var tersimpan = bacaTemplateEmail_()[kunci];
  var subjek = (tersimpan && tersimpan.subjek) ? tersimpan.subjek : bawaan.subjek;
  var isi = (tersimpan && tersimpan.isi) ? tersimpan.isi : bawaan.isi;

  Object.keys(variabel || {}).forEach(function (key) {
    var token = '{{' + key + '}}';
    var nilai = String(variabel[key] === null || variabel[key] === undefined ? '' : variabel[key]);
    subjek = subjek.split(token).join(nilai);
    isi = isi.split(token).join(nilai);
  });

  return { subjek: subjek, isi: isi };
}

/**
 * Daftar 5 template untuk panel admin. WAJIB token 'session_' DAN
 * superadmin — satu template dipakai lintas kluster, beda dari fitur
 * admin-kluster lain yang datanya sudah terfilter per kluster.
 * Endpoint: gs('getTemplateEmailUntukAdmin', token).
 */
function getTemplateEmailUntukAdmin(token) {
  var profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();
  if (!profile.isSuperadmin) return { ok: false, message: 'Hanya superadmin yang dapat mengelola template email.' };

  try {
    var tersimpan = bacaTemplateEmail_();
    var items = Object.keys(TEMPLATE_EMAIL_DEFAULT).map(function (kunci) {
      var bawaan = TEMPLATE_EMAIL_DEFAULT[kunci];
      var t = tersimpan[kunci];
      return {
        kunci: kunci,
        nama: bawaan.nama,
        catatan: bawaan.catatan,
        variabelWajib: bawaan.variabelWajib,
        subjek: (t && t.subjek) ? t.subjek : bawaan.subjek,
        isi: (t && t.isi) ? t.isi : bawaan.isi
      };
    });
    return { ok: true, items: items };
  } catch (err) {
    return { ok: false, message: 'Gagal memuat template email: ' + err.message };
  }
}

/**
 * Simpan perubahan subjek/isi satu template. WAJIB token 'session_' DAN
 * superadmin. Menolak kalau ada variabel wajib (dari TEMPLATE_EMAIL_DEFAULT,
 * bukan dari input) yang hilang dari subjek+isi baru — mencegah, misalnya,
 * {{pin}} terhapus sehingga PIN tidak pernah sampai ke pengelola padahal
 * sistem tetap melaporkan "terkirim".
 * Endpoint: gs('simpanTemplateEmail', token, kunci, data).
 */
function simpanTemplateEmail(token, kunci, data) {
  var profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();
  if (!profile.isSuperadmin) return { ok: false, message: 'Hanya superadmin yang dapat mengelola template email.' };

  var bawaan = TEMPLATE_EMAIL_DEFAULT[kunci];
  if (!bawaan) return { ok: false, message: 'Template tidak dikenal.' };
  if (!data || typeof data !== 'object') return { ok: false, message: 'Data template kosong.' };

  var subjekBaru = str_(data.subjek);
  var isiBaru = str_(data.isi);
  if (!subjekBaru) return { ok: false, message: 'Subjek email wajib diisi.' };
  if (!isiBaru) return { ok: false, message: 'Isi email wajib diisi.' };

  var gabungan = subjekBaru + '\n' + isiBaru;
  var hilang = bawaan.variabelWajib.filter(function (v) { return gabungan.indexOf(v) === -1; });
  if (hilang.length) {
    return {
      ok: false,
      message: 'Perubahan dibatalkan: variabel ' + hilang.join(', ') + ' wajib tetap ada di subjek atau isi, ' +
        'kalau tidak sistem tidak bisa mengisi nilainya saat email dikirim.'
    };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };

  try {
    var sh = getTemplateEmailSheet_();
    var nilai = sh.getDataRange().getValues();
    var header = nilai[0].map(norm_);
    var iKunci = header.indexOf(norm_('Kunci'));
    var iSubjek = header.indexOf(norm_('Subjek'));
    var iIsi = header.indexOf(norm_('Isi'));
    var iDiubahOleh = header.indexOf(norm_('Diubah Oleh'));
    var iDiubahPada = header.indexOf(norm_('Diubah Pada'));

    var barisKe = -1;
    for (var r = 1; r < nilai.length; r++) {
      if (str_(nilai[r][iKunci]) === kunci) { barisKe = r + 1; break; }
    }
    if (barisKe === -1) return { ok: false, message: 'Baris template tidak ditemukan di sheet.' };

    sh.getRange(barisKe, iSubjek + 1).setValue(aman_(subjekBaru));
    sh.getRange(barisKe, iIsi + 1).setValue(aman_(isiBaru));
    if (iDiubahOleh !== -1) sh.getRange(barisKe, iDiubahOleh + 1).setValue(profile.email);
    if (iDiubahPada !== -1) sh.getRange(barisKe, iDiubahPada + 1).setValue(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'));
    SpreadsheetApp.flush();

    catatAktivitas_(profile.email, '-', 'UBAH_TEMPLATE_EMAIL', kunci);
    bersihkanCacheTemplateEmail_();

    return {
      ok: true,
      message: 'Template "' + bawaan.nama + '" berhasil disimpan.',
      item: {
        kunci: kunci, nama: bawaan.nama, catatan: bawaan.catatan, variabelWajib: bawaan.variabelWajib,
        subjek: subjekBaru, isi: isiBaru
      }
    };
  } catch (err) {
    return { ok: false, message: 'Gagal menyimpan: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}


/* ==========================================================================
   22. VERIFIKASI DOAJ OTOMATIS
   --------------------------------------------------------------------------
   Mencocokkan ISSN tiap jurnal ke DOAJ lewat API publik mereka, hasilnya
   disimpan sebagai snapshot di sheet Verifikasi_DOAJ. Data Quality Engine
   membaca snapshot itu untuk memunculkan temuan "perlu diverifikasi" bila
   catatan direktori bertentangan dengan DOAJ.

   POLA YANG DIPEGANG (sama seperti snapshot sitasi Crossref/OpenAlex):
   API eksternal TIDAK PERNAH dipanggil saat pengunjung membuka halaman.
   perbaruiVerifikasiDoaj() dijalankan trigger harian / manual dari editor,
   aplikasi hanya membaca sheet hasilnya.

   TIGA ATURAN YANG TIDAK BOLEH DILANGGAR:
   1. TRI-STATE, bukan boolean. 'GAGAL' (API error, respons tak dikenali)
      dan '' (belum pernah dicek / ISSN tak sah) BUKAN berarti tidak
      terindeks — keduanya tidak pernah memunculkan temuan DQ. Hanya
      'TERINDEKS' dan 'TIDAK DITEMUKAN' yang dianggap jawaban definitif.
   2. TIDAK PERNAH menimpa data admin di Sheet1. Modul ini cuma menandai
      "perlu dicek", keputusan tetap di tangan manusia.
   3. Bobot temuan selalu 1 (perluVerifikasi), tidak pernah kritis.
   ========================================================================== */

var DOAJ_API = 'https://doaj.org/api/search/journals/';
var DOAJ_BATCH = 25; // fetchAll paralel; 181 jurnal -> ~8 batch, aman dari batas 6 menit
var DOAJ_STATUS = { ADA: 'TERINDEKS', TIDAK: 'TIDAK DITEMUKAN', GAGAL: 'GAGAL' };
var DOAJ_HEADER = ['Nama Jurnal', 'ISSN Dicek', 'Status', 'Judul di DOAJ', 'Terakhir Dicek', 'Catatan'];

function getVerifikasiDoajSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET.VERIFIKASI_DOAJ);
  if (!sh) {
    sh = ss.insertSheet(SHEET.VERIFIKASI_DOAJ);
    sh.appendRow(DOAJ_HEADER);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Ambil satu ISSN berpola sah dari sel yang mungkin memuat beberapa ISSN. */
function ambilIssnPertama_(nilai) {
  var s = norm_(nilai);
  var m = s.match(/\b(\d{4})-?(\d{3}[\dX])\b/);
  return m ? (m[1] + '-' + m[2]) : '';
}

/**
 * Menerjemahkan satu HTTPResponse DOAJ jadi { status, judul, catatan }.
 *
 * DITULIS DEFENSIF DENGAN SENGAJA: apa pun yang tidak dikenali (HTTP bukan
 * 200, JSON rusak, bentuk respons di luar dugaan) dipetakan ke GAGAL, BUKAN
 * TIDAK DITEMUKAN. Salah memetakan ke TIDAK DITEMUKAN akan menuduh jurnal
 * tidak terindeks padahal cuma API-nya yang sedang bermasalah.
 */
function parseDoaj_(respons) {
  try {
    var kode = respons.getResponseCode();
    if (kode !== 200) {
      return { status: DOAJ_STATUS.GAGAL, judul: '', catatan: 'HTTP ' + kode };
    }

    var data;
    try {
      data = JSON.parse(respons.getContentText());
    } catch (err) {
      return { status: DOAJ_STATUS.GAGAL, judul: '', catatan: 'Respons bukan JSON yang sah.' };
    }

    if (!data || typeof data !== 'object') {
      return { status: DOAJ_STATUS.GAGAL, judul: '', catatan: 'Bentuk respons tidak dikenali.' };
    }

    var punyaTotal = (typeof data.total === 'number');
    var punyaResults = (Object.prototype.toString.call(data.results) === '[object Array]');
    if (!punyaTotal && !punyaResults) {
      // Bentuk respons berubah / bukan payload pencarian DOAJ — jangan menebak.
      return { status: DOAJ_STATUS.GAGAL, judul: '', catatan: 'Bentuk respons tidak dikenali.' };
    }

    var jumlah = punyaTotal ? data.total : data.results.length;
    if (jumlah > 0) {
      var judul = '';
      try {
        if (punyaResults && data.results.length && data.results[0].bibjson) {
          judul = str_(data.results[0].bibjson.title);
        }
      } catch (err) { judul = ''; }
      return { status: DOAJ_STATUS.ADA, judul: judul, catatan: '' };
    }

    return { status: DOAJ_STATUS.TIDAK, judul: '', catatan: '' };
  } catch (err) {
    return { status: DOAJ_STATUS.GAGAL, judul: '', catatan: 'Galat baca respons: ' + err.message };
  }
}

/** Snapshot hasil verifikasi -> map norm_(namaJurnal) -> {status, judul, dicek}. */
function bacaVerifikasiDoaj_() {
  var cache = CacheService.getScriptCache();
  var tersimpan = cache.get(CACHE.DOAJ);
  if (tersimpan) {
    try { return JSON.parse(tersimpan); } catch (err) { /* cache rusak, baca ulang */ }
  }

  // sheetOpsional_: modul ini boleh belum pernah dijalankan tanpa membuat
  // getDashboardDataForAdmin/getPublicData gagal total.
  var sh = sheetOpsional_(SHEET.VERIFIKASI_DOAJ);
  if (!sh) return {};

  var nilai = sh.getDataRange().getValues();
  if (nilai.length < 2) return {};

  var header = nilai[0].map(norm_);
  var iNama = header.indexOf(norm_('Nama Jurnal'));
  var iStatus = header.indexOf(norm_('Status'));
  var iJudul = header.indexOf(norm_('Judul di DOAJ'));
  var iDicek = header.indexOf(norm_('Terakhir Dicek'));

  var hasil = {};
  for (var r = 1; r < nilai.length; r++) {
    var nama = iNama === -1 ? '' : str_(nilai[r][iNama]);
    if (!nama) continue;
    hasil[norm_(nama)] = {
      status: iStatus === -1 ? '' : str_(nilai[r][iStatus]),
      judul: iJudul === -1 ? '' : str_(nilai[r][iJudul]),
      dicek: iDicek === -1 ? '' : str_(nilai[r][iDicek])
    };
  }

  try {
    var json = JSON.stringify(hasil);
    if (json.length < CACHE.MAX_VALUE_BYTES) cache.put(CACHE.DOAJ, json, CACHE.DOAJ_TTL);
  } catch (err) {}

  return hasil;
}

function bersihkanCacheDoaj_() {
  CacheService.getScriptCache().remove(CACHE.DOAJ);
}

/**
 * Menarik status DOAJ untuk seluruh jurnal yang punya ISSN sah, lalu menulis
 * ulang sheet Verifikasi_DOAJ. Dijalankan trigger harian (pasangTriggerDoaj)
 * atau manual dari editor Apps Script.
 *
 * Mengembalikan ringkasan teks supaya hasilnya langsung terbaca di log
 * eksekusi, pola sama seperti cekIntegritasData()/cekKualitasData().
 */
function perbaruiVerifikasiDoaj() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    var sibuk = 'Sistem sedang sibuk, verifikasi DOAJ dilewati.';
    console.warn(sibuk);
    return sibuk;
  }

  try {
    var semua = bacaDataJurnal_();
    var target = [];
    semua.forEach(function (j) {
      var issn = j.issnValid ? ambilIssnPertama_(j.issn) : '';
      if (issn) target.push({ namaJurnal: j.namaJurnal, issn: issn });
    });

    if (!target.length) {
      var kosong = 'Tidak ada jurnal dengan ISSN sah untuk dicek ke DOAJ.';
      console.warn(kosong);
      return kosong;
    }

    var stempel = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
    var baris = [];
    var hitung = { terindeks: 0, tidak: 0, gagal: 0 };

    for (var i = 0; i < target.length; i += DOAJ_BATCH) {
      var potong = target.slice(i, i + DOAJ_BATCH);
      var permintaan = potong.map(function (t) {
        return {
          url: DOAJ_API + encodeURIComponent('issn:' + t.issn),
          method: 'get',
          muteHttpExceptions: true,
          followRedirects: true
        };
      });

      var respons = [];
      try {
        respons = UrlFetchApp.fetchAll(permintaan);
      } catch (err) {
        // Seluruh batch dianggap GAGAL — bukan "tidak ditemukan". Lihat aturan 1.
        console.error('fetchAll DOAJ gagal pada batch ' + i + ': ' + err.message);
        respons = [];
      }

      potong.forEach(function (t, k) {
        var hasil = respons[k]
          ? parseDoaj_(respons[k])
          : { status: DOAJ_STATUS.GAGAL, judul: '', catatan: 'Permintaan tidak terkirim.' };

        if (hasil.status === DOAJ_STATUS.ADA) hitung.terindeks++;
        else if (hasil.status === DOAJ_STATUS.TIDAK) hitung.tidak++;
        else hitung.gagal++;

        baris.push([t.namaJurnal, t.issn, hasil.status, hasil.judul, stempel, hasil.catatan]);
      });
    }

    var sh = getVerifikasiDoajSheet_();
    if (sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, DOAJ_HEADER.length).clearContent();
    }
    if (baris.length) {
      sh.getRange(2, 1, baris.length, DOAJ_HEADER.length).setValues(baris);
    }
    SpreadsheetApp.flush();

    bersihkanCacheDoaj_();
    bersihkanCacheJurnal_(); // WAJIB: nilai dq tiap jurnal ikut berubah

    var ringkas = 'Verifikasi DOAJ selesai ' + stempel + ' — ' + target.length + ' jurnal dicek: ' +
      hitung.terindeks + ' terindeks, ' + hitung.tidak + ' tidak ditemukan, ' + hitung.gagal + ' gagal.';
    catatAktivitas_('SISTEM', '-', 'VERIFIKASI_DOAJ', ringkas);
    console.log(ringkas);
    return ringkas;
  } catch (err) {
    var pesan = 'perbaruiVerifikasiDoaj gagal: ' + err.message;
    console.error(pesan);
    return pesan;
  } finally {
    lock.releaseLock();
  }
}

/** Pasang trigger harian. Aman dijalankan berulang — trigger lama dihapus dulu. */
function pasangTriggerDoaj() {
  var dihapus = hapusTriggerDoaj();
  ScriptApp.newTrigger('perbaruiVerifikasiDoaj').timeBased().everyDays(1).atHour(2).create();
  var pesan = 'Trigger harian verifikasi DOAJ dipasang (sekitar pukul 02:00). ' +
    (dihapus ? dihapus + ' trigger lama dihapus lebih dulu.' : '');
  console.log(pesan);
  return pesan;
}

function hapusTriggerDoaj() {
  var jumlah = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'perbaruiVerifikasiDoaj') {
      ScriptApp.deleteTrigger(t);
      jumlah++;
    }
  });
  return jumlah;
}

/* ==========================================================================
   23. PEMISAHAN E-ISSN / P-ISSN
   --------------------------------------------------------------------------
   Kolom ISSN di Sheet1 sering berisi DUA nomor dalam satu sel, misalnya
   "E-ISSN: 2776-5938; P-ISSN: 2776-6098". pisahkanEissnPissn() membaca
   kolom itu dan mengisi dua kolom baru, E-ISSN dan P-ISSN (dibuat otomatis
   bila belum ada di header), supaya keduanya bisa dipakai/divalidasi
   terpisah di tempat lain.

   ATURAN YANG DIPEGANG (sama semangatnya dengan section 22):
   1. TIDAK PERNAH menimpa sel E-ISSN/P-ISSN yang sudah terisi — hanya sel
      kosong yang diisi. Aman dijalankan berulang kali (idempoten).
   2. Kolom ISSN asli tidak pernah diubah maupun dihapus.
   3. Bila sel ISSN berisi dua nomor TANPA label E-/P- (mis. "ISSN: X;
      ISSN: Y"), fungsi ini tidak menebak — dicocokkan dulu ke data resmi
      DOAJ (identifier eissn/pissn pada bibjson). Kalau DOAJ juga tidak
      bisa memastikan (gagal/tidak terdaftar/tidak cocok), sel dibiarkan
      kosong dan baris ditandai di kolom Catatan Pemisahan ISSN untuk
      dilengkapi manual oleh admin — bukan diisi dengan tebakan.
   ========================================================================== */

var POLA_ISSN_LABEL = /(E-?ISSN|P-?ISSN)\s*:?\s*(\d{4}-?\d{3}[\dXx])/gi;
var POLA_ISSN_GENERIK = /\b(\d{4}-?\d{3}[\dXx])\b/g;
var KOLOM_CATATAN_PISAH_ISSN = 'Catatan Pemisahan ISSN';

function normalisasiIssn_(v) {
  var s = norm_(v).replace(/[^0-9X]/g, '');
  if (s.length !== 8) return norm_(v);
  return s.slice(0, 4) + '-' + s.slice(4);
}

/** Pastikan kolom berlabel `label` ada di header; buat di ujung kanan bila belum ada. Mengembalikan indeks kolom 1-based. */
function pastikanKolomAda_(sh, header, label) {
  var target = norm_(label);
  for (var i = 0; i < header.length; i++) {
    if (norm_(header[i]) === target) return i + 1;
  }
  var kolomBaru = header.length + 1;
  sh.getRange(1, kolomBaru).setValue(label);
  header.push(label);
  return kolomBaru;
}

/**
 * Menerjemahkan satu HTTPResponse DOAJ jadi { eissn, pissn } dari
 * bibjson.identifier. DITULIS DEFENSIF: apa pun yang tidak dikenali
 * mengembalikan null, tidak pernah menebak.
 */
function ambilIdentifierDoaj_(respons) {
  try {
    if (!respons || respons.getResponseCode() !== 200) return null;
    var data = JSON.parse(respons.getContentText());
    if (!data || !data.results || !data.results.length) return null;
    var bibjson = data.results[0].bibjson;
    if (!bibjson || Object.prototype.toString.call(bibjson.identifier) !== '[object Array]') return null;

    var out = {};
    bibjson.identifier.forEach(function (id) {
      if (!id || !id.type || !id.id) return;
      var tipe = String(id.type).toLowerCase();
      if (tipe === 'eissn') out.eissn = normalisasiIssn_(id.id);
      if (tipe === 'pissn') out.pissn = normalisasiIssn_(id.id);
    });
    return (out.eissn || out.pissn) ? out : null;
  } catch (err) {
    return null;
  }
}

/**
 * Memisahkan sel ISSN (Sheet1) ke kolom E-ISSN/P-ISSN. Baris dengan label
 * eksplisit dipisah langsung; baris dengan ISSN ganda tanpa label
 * dicocokkan ke DOAJ. Dijalankan manual dari editor Apps Script — bukan
 * trigger harian, karena ini migrasi data yang idempoten, bukan sinkron
 * berkelanjutan.
 */
function pisahkanEissnPissn() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    var sibuk = 'Sistem sedang sibuk, pemisahan ISSN dilewati.';
    console.warn(sibuk);
    return sibuk;
  }

  try {
    var sh = sheetWajib_(SHEET.MAIN);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2) {
      var kosongSheet = 'Sheet1 belum punya data jurnal.';
      console.warn(kosongSheet);
      return kosongSheet;
    }

    var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var map = buatHeaderMap_(header);
    if (map.issn === undefined) {
      var tanpaIssn = 'Kolom ISSN tidak ditemukan di Sheet1, pemisahan dibatalkan.';
      console.warn(tanpaIssn);
      return tanpaIssn;
    }

    var kolomE = pastikanKolomAda_(sh, header, 'E-ISSN');
    var kolomP = pastikanKolomAda_(sh, header, 'P-ISSN');
    var kolomCatatan = pastikanKolomAda_(sh, header, KOLOM_CATATAN_PISAH_ISSN);

    // Header row mungkin baru diperlebar oleh pastikanKolomAda_ — baca ulang data lengkap.
    lastCol = sh.getLastColumn();
    var nilai = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    var tulisan = []; // { baris, kolom, nilai }
    var perluDoaj = []; // { indeksBaris(0-based di `nilai`), namaJurnal, kandidat: [issn,...] }
    var hitung = { berlabel: 0, sudahAda: 0, dilewati: 0 };

    for (var r = 0; r < nilai.length; r++) {
      var row = nilai[r];
      var namaJurnal = ambil_(row, map, 'namaJurnal');
      if (!namaJurnal) continue;

      var eSekarang = str_(row[kolomE - 1]);
      var pSekarang = str_(row[kolomP - 1]);
      if (eSekarang && pSekarang) { hitung.sudahAda++; continue; }

      var issnMentah = ambil_(row, map, 'issn');
      if (!issnMentah) { hitung.dilewati++; continue; }

      var labelE = '', labelP = '';
      var m;
      POLA_ISSN_LABEL.lastIndex = 0;
      while ((m = POLA_ISSN_LABEL.exec(issnMentah)) !== null) {
        var tipeLabel = m[1].toUpperCase().replace(/-/g, '');
        var nilaiIssn = normalisasiIssn_(m[2]);
        if (tipeLabel === 'EISSN' && !labelE) labelE = nilaiIssn;
        if (tipeLabel === 'PISSN' && !labelP) labelP = nilaiIssn;
      }

      if (labelE || labelP) {
        if (labelE && !eSekarang) { tulisan.push({ baris: r + 2, kolom: kolomE, nilai: labelE }); hitung.berlabel++; }
        if (labelP && !pSekarang) { tulisan.push({ baris: r + 2, kolom: kolomP, nilai: labelP }); hitung.berlabel++; }
        continue;
      }

      // Tidak ada label E-/P- sama sekali — kumpulkan kandidat ISSN generik untuk dicek ke DOAJ.
      if (eSekarang || pSekarang) { hitung.dilewati++; continue; } // salah satu sudah terisi manual, jangan ganggu
      var kandidat = [];
      POLA_ISSN_GENERIK.lastIndex = 0;
      while ((m = POLA_ISSN_GENERIK.exec(issnMentah)) !== null) {
        var norm = normalisasiIssn_(m[1]);
        if (kandidat.indexOf(norm) === -1) kandidat.push(norm);
      }
      if (!kandidat.length) { hitung.dilewati++; continue; }

      perluDoaj.push({ baris: r + 2, namaJurnal: namaJurnal, kandidat: kandidat.slice(0, 2) });
    }

    var hitungDoaj = { cocok: 0, manual: 0 };
    if (perluDoaj.length) {
      for (var i = 0; i < perluDoaj.length; i++) {
        var target = perluDoaj[i];
        var identifier = null;
        for (var k = 0; k < target.kandidat.length && !identifier; k++) {
          var permintaan = {
            url: DOAJ_API + encodeURIComponent('issn:' + target.kandidat[k]),
            method: 'get',
            muteHttpExceptions: true,
            followRedirects: true
          };
          var respons = null;
          try { respons = UrlFetchApp.fetch(permintaan.url, permintaan); } catch (err) { respons = null; }
          identifier = respons ? ambilIdentifierDoaj_(respons) : null;
        }

        if (identifier) {
          // Hanya percaya hasil DOAJ bila salah satu nomornya memang ada di antara kandidat kita —
          // memastikan record yang cocok benar-benar jurnal yang sama, bukan salah tangkap.
          var eDoaj = identifier.eissn || '';
          var pDoaj = identifier.pissn || '';
          var cocokSalahSatu = target.kandidat.indexOf(eDoaj) !== -1 || target.kandidat.indexOf(pDoaj) !== -1;
          if (cocokSalahSatu) {
            if (eDoaj) tulisan.push({ baris: target.baris, kolom: kolomE, nilai: eDoaj });
            if (pDoaj) tulisan.push({ baris: target.baris, kolom: kolomP, nilai: pDoaj });
            hitungDoaj.cocok++;
            continue;
          }
        }

        tulisan.push({
          baris: target.baris, kolom: kolomCatatan,
          nilai: '[PERLU DICEK MANUAL] ISSN tanpa label E-/P- (' + target.kandidat.join(', ') +
                 '), DOAJ tidak bisa memastikan mana elektronik/cetak.'
        });
        hitungDoaj.manual++;
      }
    }

    tulisan.forEach(function (t) {
      sh.getRange(t.baris, t.kolom).setValue(t.nilai);
    });
    SpreadsheetApp.flush();

    bersihkanCacheJurnal_();

    var ringkas = 'Pemisahan E-ISSN/P-ISSN selesai — ' + hitung.berlabel + ' nilai terisi dari label eksplisit, ' +
      hitungDoaj.cocok + ' baris ambigu terselesaikan lewat DOAJ, ' + hitungDoaj.manual +
      ' baris ambigu ditandai perlu dicek manual, ' + hitung.sudahAda + ' baris sudah terisi sebelumnya (dilewati).';
    catatAktivitas_('SISTEM', '-', 'PISAH_ISSN', ringkas);
    console.log(ringkas);
    return ringkas;
  } catch (err) {
    var pesan = 'pisahkanEissnPissn gagal: ' + err.message;
    console.error(pesan);
    return pesan;
  } finally {
    lock.releaseLock();
  }
}

var TAG_AKURASI_ISSN = '[AKURASI DOAJ]';

/**
 * Audit akurasi: mencocokkan SEMUA E-ISSN/P-ISSN yang sudah terisi di
 * Sheet1 (baik dari label eksplisit, hasil DOAJ, maupun input manual
 * pengelola) ke data resmi DOAJ, lalu menuliskan peringatan bila tidak
 * cocok. TIDAK PERNAH mengubah nilai E-ISSN/P-ISSN itu sendiri — hanya
 * menulis/menghapus catatan bertanda "[AKURASI DOAJ]" di kolom Catatan
 * Pemisahan ISSN. Catatan lain (mis. "[PERLU DICEK MANUAL]" dari
 * pisahkanEissnPissn, atau catatan bebas admin) tidak pernah disentuh.
 * Dijalankan manual dari editor Apps Script, atau dipasang trigger sendiri
 * seperti pasangTriggerDoaj() bila ingin berkala.
 */
function periksaAkurasiEissnPissn() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    var sibuk = 'Sistem sedang sibuk, audit akurasi ISSN dilewati.';
    console.warn(sibuk);
    return sibuk;
  }

  try {
    var sh = sheetWajib_(SHEET.MAIN);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2) {
      var kosongSheet = 'Sheet1 belum punya data jurnal.';
      console.warn(kosongSheet);
      return kosongSheet;
    }

    var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var map = buatHeaderMap_(header);
    var kolomE = pastikanKolomAda_(sh, header, 'E-ISSN');
    var kolomP = pastikanKolomAda_(sh, header, 'P-ISSN');
    var kolomCatatan = pastikanKolomAda_(sh, header, KOLOM_CATATAN_PISAH_ISSN);

    lastCol = sh.getLastColumn();
    var nilai = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    var target = [];
    for (var r = 0; r < nilai.length; r++) {
      var row = nilai[r];
      var namaJurnal = ambil_(row, map, 'namaJurnal');
      if (!namaJurnal) continue;

      var eLokal = str_(row[kolomE - 1]);
      var pLokal = str_(row[kolomP - 1]);
      if (!eLokal && !pLokal) continue;

      var catatanSekarang = str_(row[kolomCatatan - 1]);
      target.push({
        baris: r + 2, namaJurnal: namaJurnal, eLokal: eLokal, pLokal: pLokal,
        issnCari: eLokal || pLokal, catatanSekarang: catatanSekarang
      });
    }

    if (!target.length) {
      var tanpaTarget = 'Belum ada E-ISSN/P-ISSN terisi untuk diaudit. Jalankan pisahkanEissnPissn() dulu.';
      console.warn(tanpaTarget);
      return tanpaTarget;
    }

    var stempel = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
    var tulisan = [];
    var hitung = { cocok: 0, masalah: 0, takTerverifikasi: 0 };

    for (var i = 0; i < target.length; i += DOAJ_BATCH) {
      var potong = target.slice(i, i + DOAJ_BATCH);
      var permintaan = potong.map(function (t) {
        return {
          url: DOAJ_API + encodeURIComponent('issn:' + t.issnCari),
          method: 'get',
          muteHttpExceptions: true,
          followRedirects: true
        };
      });

      var respons = [];
      try {
        respons = UrlFetchApp.fetchAll(permintaan);
      } catch (err) {
        console.error('fetchAll DOAJ (audit ISSN) gagal pada batch ' + i + ': ' + err.message);
        respons = [];
      }

      potong.forEach(function (t, k) {
        // Hanya cell kosong atau bertanda TAG_AKURASI_ISSN yang boleh disentuh —
        // catatan manual/ambigu dari fungsi lain tidak pernah ditimpa di sini.
        var bolehTulis = !t.catatanSekarang || t.catatanSekarang.indexOf(TAG_AKURASI_ISSN) === 0;

        var identifier = respons[k] ? ambilIdentifierDoaj_(respons[k]) : null;
        if (!identifier) { hitung.takTerverifikasi++; return; } // GAGAL/tidak terdaftar — bukan berarti salah, jangan menuduh

        var masalah = [];
        if (t.eLokal && identifier.eissn && identifier.eissn !== t.eLokal) {
          masalah.push('E-ISSN tercatat ' + t.eLokal + ', DOAJ mencatat ' + identifier.eissn);
        }
        if (t.pLokal && identifier.pissn && identifier.pissn !== t.pLokal) {
          masalah.push('P-ISSN tercatat ' + t.pLokal + ', DOAJ mencatat ' + identifier.pissn);
        }

        if (masalah.length) {
          hitung.masalah++;
          if (bolehTulis) {
            tulisan.push({
              baris: t.baris, kolom: kolomCatatan,
              nilai: TAG_AKURASI_ISSN + ' ' + masalah.join('; ') + '. Dicek ' + stempel + '.'
            });
          }
        } else {
          hitung.cocok++;
          // Sebelumnya bermasalah, sekarang cocok — bersihkan catatan lama milik audit ini.
          if (bolehTulis && t.catatanSekarang) {
            tulisan.push({ baris: t.baris, kolom: kolomCatatan, nilai: '' });
          }
        }
      });
    }

    tulisan.forEach(function (t) {
      sh.getRange(t.baris, t.kolom).setValue(t.nilai);
    });
    SpreadsheetApp.flush();

    var ringkas = 'Audit akurasi E-ISSN/P-ISSN selesai ' + stempel + ' — ' + target.length + ' jurnal dicek: ' +
      hitung.cocok + ' cocok dengan DOAJ, ' + hitung.masalah + ' tidak cocok (ditandai), ' +
      hitung.takTerverifikasi + ' tidak bisa diverifikasi (DOAJ gagal/tidak terdaftar, tidak ditandai salah).';
    catatAktivitas_('SISTEM', '-', 'AUDIT_AKURASI_ISSN', ringkas);
    console.log(ringkas);
    return ringkas;
  } catch (err) {
    var pesan = 'periksaAkurasiEissnPissn gagal: ' + err.message;
    console.error(pesan);
    return pesan;
  } finally {
    lock.releaseLock();
  }
}

/* ==========================================================================
   24. IMPOR COVER & SCOPE DARI EJOURNAL.UPI.EDU
   --------------------------------------------------------------------------
   UrlFetchApp DIBLOKIR oleh Cloudflare di seluruh subdomain *.upi.edu
   (dicoba curl polos maupun dengan User-Agent Chrome asli, tetap 403 —
   proteksi berbasis fingerprint browser, bukan sekadar cek header). Karena
   itu data cover + deskripsi jurnal di bawah ini DIAMBIL MANUAL lewat
   browser sungguhan (bypass tantangan Cloudflare), lalu ditempel di sini
   sebagai data literal — bukan dipanggil live dari Apps Script.

   Sumber: https://ejournal.upi.edu/ (portal pusat OJS UPI), diambil pada
   Agustus 2026. Deskripsi dipotong ~320 karakter (elipsis "…" bila
   terpotong) — cukup untuk teks ringkas kartu/modal, bukan salinan
   lengkap halaman About.

   TEMUAN KEAMANAN — 3 entri dari portal sumber berisi SPAM JUDI ONLINE
   (bukan konten jurnal asli), sudah dikosongkan di data ini sebelum
   ditulis ke sheet: "Jurnal Penelitian Pendidikan", "INFANTIA: Jurnal
   Pendidikan Anak Usia Dini", dan "Indonesian Journal of Entrepreneurial
   Economics". WAJIB dilaporkan ke tim IT/keamanan UPI — kemungkinan besar
   instalasi OJS jurnal-jurnal itu disusupi. 4 entri lain berisi teks
   placeholder "Lorem ipsum..." (belum pernah diisi admin jurnalnya) juga
   dikosongkan.

   ATURAN (sama semangatnya dengan section 23):
   1. TIDAK PERNAH menimpa sel Cover URL/Scope yang sudah terisi — hanya
      sel kosong yang diisi. Aman dijalankan berulang (idempoten).
   2. Pencocokan ke Sheet1 lewat NAMA JURNAL yang dinormalisasi (norm_()) —
      bila tidak ketemu pasangan yang persis, TIDAK ditebak/dipaksakan.
      Baris yang tidak cocok dicatat di ringkasan hasil, bukan didiamkan.
   3. Sekali dijalankan dan datanya sudah masuk ke Sheet1, fungsi ini boleh
      dihapus dari Code.js — literal _IMPOR_PROFIL_JURNAL_ di atas hanya
      dipakai sekali sebagai jembatan migrasi, bukan sumber data permanen.
   ========================================================================== */

var _IMPOR_PROFIL_JURNAL_ = [
  {"t":"Indonesian Journal of Science and Technology","cover":"https://ejournal.upi.edu/public/journals/90/journalThumbnail_en_US.jpg","d":"The Indonesian Journal of Science and Technology (IJoST) (ISSN: e.2527-8045 p.2528-1410) is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia, which is a dissemination from research results from scientists and engineers in many fields of science and technology. In 2016-2020, IJoST…"},
  {"t":"ASEAN Journal of Science and Engineering","cover":"https://ejournal.upi.edu/public/journals/274/journalThumbnail_en_US.jpg","d":"The ASEAN Journal of Science and Engineering(AJSE) (e-ISSN = 2776-5938; p-ISSN = 2776-6098; accreditated SINTA 1 by DGHE (Ministry of Research, Technology and Higher Education, Republic of Indonesia) no 79/E/KPT/2023 on 11/05/2023 (improved from SINTA 4 no 204/E/KPT/2022 on 03/10/2022) is an open access and…"},
  {"t":"Indonesian Journal of Applied Linguistics","cover":"https://ejournal.upi.edu/public/journals/2/journalThumbnail_en_US.jpg","d":"From June 1, 2025, Indonesian Journal of Applied Linguistics is migrating from OJS 2 to OJS 3.3. All manuscript submissions will be accepted only through the new website at: https://ijal.upi.edu/index.php/ijalManuscripts will no longer be accepted through this website after this date. Migration official statement can…"},
  {"t":"International Journal of Education","cover":"https://ejournal.upi.edu/public/journals/70/journalThumbnail_en_US.jpg","d":"Welcome to the International Journal of Education (IJE) website. IJE (e-ISSN: 2442-4730 and p-ISSN: 1978-1342) is the first open access and double-blind peer-reviewed international journal managed by Universitas Pendidikan Indonesia, which exclusively focuses on formal education. This international journal is a part…"},
  {"t":"Jurnal Pendidikan Keperawatan Indonesia","cover":"https://ejournal.upi.edu/public/journals/82/journalThumbnail_en_US.png","d":"e-ISSN 2477-3743 p-ISSN 2541-0024WelcomeJurnal Pendidikan Keperawatan Indonesia (JPKI) is an open-access journal published by Universitas Pendidikan Indonesia. This Journal aims to improve nursing science development, especially in nursing education by publishing scientific papers from researchers, lecturers, and…"},
  {"t":"Jurnal ASET (Akuntansi Riset)","cover":"https://ejournal.upi.edu/public/journals/121/journalThumbnail_en_US.jpg","d":"Nationally Accredited based on the The Directorate General of Higher Education, Research, and Technology (DGHERT) of the Ministry of Education, Culture, Research, and Technology (MOECRT) of the Republic of Indonesia, Number 177/E/KPT/2024-15 Oktober 2024Jurnal ASET (Akuntansi Riset) (p-ISSN: 2086-2563 and e-ISSN:…"},
  {"t":"Jurnal Pendidikan Jasmani dan Olahraga","cover":"https://ejournal.upi.edu/public/journals/89/journalThumbnail_en_US.jpg","d":"p-ISSN : 2085-6180 | e-ISSN : 2580-071XJurnal Pendidikan Jasmani dan Olahraga (JPJO) is a peer-reviewed journal published in online and printed platform by Departemen Pendidikan Olahraga, Universitas Pendidikan Indonesia, which was founded in 2016 and regularly published online. It publishes articles of a high…"},
  {"t":"Journal of Science Learning","cover":"https://ejournal.upi.edu/public/journals/172/journalThumbnail_en_US.png","d":"Journal of Science Learning abbreviated JSL is a peer-reviewed, open-access international journal dedicated to advancing global science education by exploring how students construct scientific literacy, systemic thinking, and epistemic skills within digitally rich and culturally diverse environments. Focusing…"},
  {"t":"ALSUNIYAT: Jurnal Penelitian Bahasa, Sastra, dan Budaya Arab","cover":"","d":"Journal titleAlsuniyat : Jurnal Penelitian Bahasa, Sastra, dan Budaya ArabInitialsJurnal AlsuniyatAccreditationSinta 2 by Ministry of Research, Technology, and Higher Education of the Republic of IndonesiaFrequency2 issues per year (April and October)DOIPrefix 10.17509 by CrossrefISSNE-ISSN 2721-480X P-ISSN…"},
  {"t":"EduBasic Journal: Jurnal Pendidikan Dasar","cover":"","d":"EduBasic Journal: Jurnal Pendidikan Dasar (e-ISSN: 2549-4562 p-ISSN: 2987-937X) is an open-access journal that aim to publish research in the field of learning development for basic education and early childhood education. EduBasic Journal: Jurnal Pendidikan Dasar invites authors to publish their manuscripts in…"},
  {"t":"Mimbar Sekolah Dasar","cover":"https://ejournal.upi.edu/public/journals/64/journalThumbnail_en_US.png","d":"p-ISSN 2355-5343 | e-ISSN 2502-4795Mimbar Sekolah Dasar (Elementary School Forum) is an international, peer-reviewed, open-access journal dedicated to advancing knowledge and innovation in elementary education. Published four times a year (March, June, September, and December) by Elementary Teacher Education Program,…"},
  {"t":"Jurnal Pengajaran Matematika dan Ilmu Pengetahuan Alam","cover":"https://ejournal.upi.edu/public/journals/147/journalThumbnail_en_US.jpg","d":"From June 1, 2026, JPMIPA is migrating from OJS 2 to OJS 3.5. All manuscript submissions will be accepted only through the new website at: https://ejournal-science.upi.edu/jpmipa/indexJournal of Mathematics and Science Teaching or Jurnal Pengajaran Matematika dan Ilmu Pengetahuan Alam (JPMIPA) was founded in 1993 and…"},
  {"t":"Jurnal Pendidikan Ilmu Sosial","cover":"https://ejournal.upi.edu/public/journals/96/journalThumbnail_en_US.jpg","d":"JPIS (Jurnal Pendidikan Ilmu Sosial) (e-ISSN: 2540-7694 |p-ISSN: 0854-5251) is an open access and international peer-reviewed journal published by Faculty of Social Sciences Education Universitas Pendidikan Indonesia, which is the dissemination of research results by researchers in various fields of social science…"},
  {"t":"Indonesian Journal of Educational Research and Technology","cover":"https://ejournal.upi.edu/public/journals/253/journalThumbnail_en_US.png","d":"The Indonesian Journal of Educational Research and Technology (IJERT) (ISSN: e. 2775-8427 p. 2775-8419)is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia, which is a dissemination medium for research result from scientists, engineers, and educators in many fields of education.…"},
  {"t":"Jurnal Pendidikan Manajemen Perkantoran","cover":"https://ejournal.upi.edu/public/journals/138/journalThumbnail_en_US.jpg","d":"Nationally Accredited based on the Decree of the Minister of Research Technology/BRIN, Number 225/E/KPT/2022Jurnal Pendidikan Manajemen Perkantoran (JPManper) is published online (e-ISSN 2656-4734/ p-ISSN 2686-5491) by the Office Management Education Study Program, the Faculty of Economics and Business Education,…"},
  {"t":"EduHumaniora : Jurnal Pendidikan Dasar","cover":"https://ejournal.upi.edu/public/journals/83/journalThumbnail_en_US.jpg","d":"EduHumaniora: Jurnal Pendidikan Dasar| p-ISSN 2085-1243| e-ISSN 2579-5457Journal Eduhumaniora is a peer-reviewed scientific journal that publishes different kinds of scientific articles based on the research-article and ideas-article. All topics that we received only articles relating to elementary school fields. For…"},
  {"t":"Review of Islamic Economics and Finance","cover":"","d":"Review of Islamic Economics and Finance (RIEF) with the registered number e-issn 2657-1498 and p-issn 2656-7083 and is published by Program Studi Ilmu Ekonomi dan Keuangan Islam (Islamic Economics and Finance Study Program), Faculty of Economics and Business Education, Universitas Pendidikan Indonesia in collaboration…"},
  {"t":"Assimilation: Indonesian Journal of Biology Education","cover":"https://ejournal.upi.edu/public/journals/152/journalThumbnail_en_US.jpg","d":"Assimilation: Indonesian Journal of Biology Education (AIJBE), ISSN 2621-7260 (Online) is a peer-reviewed scientific journal published by the Department of Biology Education, Universitas Pendidikan Indonesia collaborates with Perkumpulan Pendidik IPA Indonesia (PPII) and Himpunan Pendidik dan Peneliti Biologi…"},
  {"t":"Historia: Jurnal Pendidik dan Peneliti Sejarah","cover":"https://ejournal.upi.edu/public/journals/104/journalThumbnail_en_US.jpg","d":"HISTORIA: Jurnal Pendidik dan Peneliti Sejarah was formerly named Historia: Jurnal Pendidikan Sejarah, published by the Department of History, Universitas Pendidikan Indonesia (UPI) or Indonesia University of Education, and was firstly published on June 15th on 2000. Since June 2009, the title of the journal has…"},
  {"t":"Jurnal Penelitian Pendidikan","cover":"https://ejournal.upi.edu/public/journals/88/journalThumbnail_en_US.jpg","d":""},
  {"t":"Cakrawala Dini: Jurnal Pendidikan Anak Usia Dini","cover":"https://ejournal.upi.edu/public/journals/140/journalThumbnail_en_US.jpg","d":"Cakrawala Dini: Jurnal Pendidikan Anak Usia Dini| p-ISSN 2087-1317 | e-ISSN 2621-8321Cakrawala Dini is a peer-reviewed scientific journal that publishes different kinds of scientific articles based on the research-article and ideas-article. All topics that we received only articles relating to early childhood…"},
  {"t":"Jurnal Riset Akuntansi dan Keuangan","cover":"https://ejournal.upi.edu/public/journals/118/journalThumbnail_en_US.jpg","d":"Nationally Accredited based on the Decree of the Minister of Research, Technology and Higher Education, Number 0010/E5/KI.02.04/2022 - 27 Desember 2021Jurnal Riset Akuntansi dan Keuangan with registered number ISSN 2338-1507 (Print) and ISSN 2541-061X (Online) is published by Program Studi Akuntansi Fakultas…"},
  {"t":"Jurnal Pendidikan Bahasa dan Sastra","cover":"https://ejournal.upi.edu/public/journals/55/journalThumbnail_en_US.jpg","d":"JURNAL PENDIDIKAN BAHASA DAN SASTRA (Journal of Language and Literature Education) We are pleased to announce that starting from Volume 26, Issue 1 2026, our journal will officially migrate to a new and updated Open Journal Systems (OJS) 3 platform.Please take note of the following URL changes:Previous Website:…"},
  {"t":"Journal of Indonesian Tourism, Hospitality and Recreation","cover":"https://ejournal.upi.edu/public/journals/192/journalThumbnail_en_US.jpg","d":"Journal of Indonesian Tourism, Hospitality and Recreation is a tourism scientific journal, published by Study Program Management of Resort and Leisure, Universitas Pendidikan Indonesia. This Journal is supported by tourism scholar associations Ikatan Cendikiawan Pariwisata Indonesia (ICPI). The journal publishes two…"},
  {"t":"Image : Jurnal Riset Manajemen","cover":"https://ejournal.upi.edu/public/journals/80/journalThumbnail_en_US.jpg","d":"ACCREDITED Sinta 3 by Ministry of Research and Technology/National Research and Innovation Agency) No 148/M/KPT/2020, August 3, 2020. Certificate is available hereImage : Jurnal Riset Manajemen with registered number ISSN 2339-2878 (Print) and ISSN 2657-0688 (Online), is a peer-reviewed journal published two times a…"},
  {"t":"TEGAR: Journal of Teaching Physical Education in Elementary School","cover":"https://ejournal.upi.edu/public/journals/175/journalThumbnail_en_US.jpg","d":"TEGAR, Journal of Teaching Physical Education in Elementary School, (ISSN: e- 2614-5626; p-2614-5626 DOI: https://dx.doi.org/10.17509) is a peer-review journal, specializing in publishing:Teaching and learning researches and conceptual review of the teaching innovation on models, approaches, strategies, and styles…"},
  {"t":"Jurnal Geografi Gea","cover":"https://ejournal.upi.edu/public/journals/76/journalThumbnail_en_US.png","d":"Jurnal Geografi Gea is the information media academics and researchers who have attention to developing the educational disciplines and disciplines of Geography Education in Indonesia. GEA taken from the Greek Ghea means \"God of Earth\". Jurnal Geografi Gea is published by Departemen Geografi, Fakultas Pendidikan Ilmu…"},
  {"t":"TARBAWY: Indonesian Journal of Islamic Education","cover":"https://ejournal.upi.edu/public/journals/109/journalThumbnail_en_US.jpg","d":"TARBAWY: Indonesian Journal of Islamic Education (P-ISSN: 2580-6181 I E-ISSN: 2599-2481) is an open-access and peer-reviewed journal, published by Universitas Pendidikan Indonesia. This journal focuses on Islamic education studies. Topics might be about Islamic educational studies in schools, pesantren (Islamic…"},
  {"t":"JOMSIGN: Journal of Multicultural Studies in Guidance and Counseling","cover":"https://ejournal.upi.edu/public/journals/164/journalThumbnail_en_US.jpg","d":"📢 Announcement: Journal Migration to New PlatformDear Authors and Readers,We would like to inform you that JOMSIGN (Journal of Mathematics and Science in Education) has officially migrated from OJS 2 to OJS 3. This upgrade is part of our ongoing efforts to improve the submission and publication experience.🔗 Old…"},
  {"t":"JAPANEDU: Jurnal Pendidikan dan Pengajaran Bahasa Jepang","cover":"https://ejournal.upi.edu/public/journals/101/journalThumbnail_en_US.jpg","d":"JAPANEDU: Jurnal Pendidikan dan Pengajaran Bahasa Jepang (e-ISSN:2528-5548, p ISSN: 2776-4478) is an online, open access peer-reviewed journal, which is published by Universitas Pendidikan Indonesia twice a year (every June and December). This journal is for all contributors who concern with researches about Japanese…"},
  {"t":"Wahana Fisika","cover":"https://ejournal.upi.edu/public/journals/78/journalThumbnail_en_US.jpg","d":"From January 1, 2026, Wahana Fisika journal is migrating from OJS 2 to OJS 3.5. All manuscript submissions will be accepted only through the new website at: https://ejournal-science.upi.edu/wafi//Manuscripts will no longer be accepted through this website after this date. Migration official statement can be accessed…"},
  {"t":"MIMBAR PENDIDIKAN","cover":"https://ejournal.upi.edu/public/journals/94/journalThumbnail_en_US.jpg","d":"MIMBAR PENDIDIKAN: Jurnal Indonesia untuk Kajian Pendidikan (Indonesian Journal for Educational Studies)This journal was first published on March 11, 2016, and it is issued every March and September. MIMBAR PENDIDIKAN is a new version of the old journal with the similar name that was published from 1995 to 2005. This…"},
  {"t":"Jurnal Pendidikan Akuntansi & Keuangan","cover":"https://ejournal.upi.edu/public/journals/202/journalThumbnail_en_US.jpg","d":"Nationally Accredited based on the Decree of the Minister of Research, Technology and Higher Education, Number 225/E/KPT/2023 - 1 Februari 2023JPAK : Jurnal Pendidikan Akuntansi dan Keuangan published by Program Studi Pendidikan Akuntansi Fakultas Pendidikan Ekonomi dan Bisnis Universitas Pendidikan Indonesia with…"},
  {"t":"Jurnal Terapan Ilmu Keolahragaan","cover":"https://ejournal.upi.edu/public/journals/100/journalThumbnail_en_US.png","d":""},
  {"t":"PEDAGOGIA","cover":"https://ejournal.upi.edu/public/journals/125/journalThumbnail_en_US.jpg","d":"PEDAGOGIA (e-ISSN 2579-7700, p.ISSN 1693-5276 is a peer-reviewed (double blind review) journal published by Faculty of Education, Indonesia Univerity of Education. The goal of this journal is to facilitate scholars, researchers, and teachers for publishing the original research articles or review articles. Pedagogia :…"},
  {"t":"Edulib","cover":"https://ejournal.upi.edu/public/journals/63/journalThumbnail_en_US.png","d":"Journal title: Journal of Library and Information ScienceInitials: EdulibFrequency: Two issues per year Print ISSN: 2089-6549 Online ISSN: 2528-2182Editor-in-chief: Gema RullyanaPublisher: Universitas Pendidikan IndonesiaOrganizer: Library and Information Science Study Program Faculty of Educational Science"},
  {"t":"Inovasi Kurikulum","cover":"https://ejournal.upi.edu/public/journals/277/journalThumbnail_en_US.jpg","d":"Official Statement: Website Migration to OJS 3.5From June 14, 2025, Jurnal Inovasi Kurikulum (JIK) is migrating from OJS 2 to OJS 3.5. All manuscript submissions will be accepted only through the new website at: https://ejournal-hipkin.or.id/index.php/jik/JournalInovasi KurikulumInitialsJIKFrequencyQuaterly (Feb, May,…"},
  {"t":"FRANCISOLA","cover":"","d":"From June 1, 2026, FRANCISOLA is migrating from OJS 2 to OJS 3.5. All manuscript submissions will be accepted only through the new website at: https://ejournal-language.upi.edu/FrancisolaManuscripts will no longer be accepted through this website after this date. Migration official statement can be accessed on the…"},
  {"t":"LOKABASA","cover":"https://ejournal.upi.edu/public/journals/67/journalThumbnail_en_US.jpg","d":"Lokabasa is a journal of language studies, literature, regional culture and teaching. This journal is published by the Department of Sundanese Language Education, The Faculty of Language and Literature Education, Indonesia University of Education (UPI), in cooperation with Ikatan Dosen Budaya Daerah Indonesia…"},
  {"t":"Jurnal Pengabdian dan Pemberdayaan Sosial Kemanusiaan","cover":"","d":"Journal title Jurnal Pengabdian dan Pemberdayaan Sosial KemanusiaanInitials JPPSKFrequency 2 issues per year (June and December)Online ISSN Jurnal Pengabdian dan Pemberdayaan Sosial Kemanusiaan (ISSN Online : xxxx-xxxx) is a high-quality open access peer-reviewed research journal published by Faculty of Social Science…"},
  {"t":"Journal of Business Management Education (JBME)","cover":"https://ejournal.upi.edu/public/journals/116/journalThumbnail_en_US.jpg","d":"ACCREDITED Sinta 3 by Ministry of Research and Technology/National Research and Innovation Agency) No 148/M/KPT/2020, August 3, 2020. Certificate is available hereJournal of Business Management Education (JBME) with the registered number e-issn 2715-3037 and p-issn 2715-3045 is an online journal of undergraduate…"},
  {"t":"Indonesian Journal of Geography Information Science","cover":"https://ejournal.upi.edu/public/journals/302/journalThumbnail_en_US.png","d":"The Indonesian Journal of Geography Information Science is an open access and peer-reviewed interdisciplinary journal dedicated to publish high quality, original research articles in the field of GIScience. The journal published by Geographic Information Science Study Program (SAIG), Universitas Pendidikan Indonesia…"},
  {"t":"EDUTECH","cover":"https://ejournal.upi.edu/public/journals/62/journalThumbnail_en_US.jpg","d":"Online ISSN : 2502-0781Edutech has achieved accreditation at the SINTA 3 level, as recognized by the national indexing system.Edutech: Jurnal Teknologi Pendidikan, managed by the Educational Technology Study Program at Universitas Pendidikan Indonesia and published three times a year (February, June, and October), is…"},
  {"t":"Jurnal MANAJERIAL","cover":"https://ejournal.upi.edu/public/journals/84/journalThumbnail_en_US.jpg","d":"Manajerial : Jurnal Manajemen dan Sistem Informasi (ISSN: 1412-6613 & E-ISSN: 2527-4570) merupakan Jurnal Manajemen dan sistem informasi sebagai wahana untuk menyebarluaskan hasil penelitian, kajian dan gagasan di bidang manajemen dan sistem informasi yang dipublikasikan oleh Program Studi Pendidikan Manajemen…"},
  {"t":"Indonesian Journal of Primary Education","cover":"https://ejournal.upi.edu/public/journals/158/journalThumbnail_en_US.png","d":"From January 1, 2026, Indonesian Journal of Primary Education is migrating from OJS 2 to OJS 3.3. All manuscript submissions will be accepted only through the new website at: https://ejournal-upitasikmalaya.upi.edu/ijpeThe Indonesian Journal of Primary Education (ISSN: e.2597-4866 p.2599-2821) is a scientific…"},
  {"t":"Higher Education Spiritual Pedagogies","cover":"","d":"Journal title Higher Education Spiritual Pedagogies Initials HESPFrequency 2 issues per year (June and December)Online ISSN Higher Education Spiritual Pedagogies (ISSN Online : 2988-5248) is a high-quality open access peer-reviewed research journal published by Islamic Religious Education Study Program, Faculty of…"},
  {"t":"SemestaEdu: Journal of Mathematics, Science and Technology Education in Elementary School","cover":"https://ejournal.upi.edu/public/journals/284/journalThumbnail_en_US.png","d":"SemestaEdu Journal is an open-access and peer-reviewed journal published every April and October. SemestaEdu Journal covers research on mathematics, science, and technology education in elementary school that studies and develops research topics into various scopes such as teaching and learning, curriculum,…"},
  {"t":"Jurnal Pengabdian Isola","cover":"","d":"Dear Authors, Reviewers, and Readers,We are pleased to announce that Jurnal Pengabdian Isola (JPI) has officially migrated from Open Journal Systems (OJS) 2 to Open Journal Systems (OJS) 3. If you have previously submitted a manuscript through the OJS 2 system that is still under editorial processing, we kindly ask…"},
  {"t":"Motor: Journal of Automotive Engineering","cover":"","d":"Journal of Automotive Engineering (MOTOR) (e-ISSN:3110-8784) is a scholarly publication dedicated to advancing research in automotive engineering. Published biannually in June and December, MOTOR is managed by the Editorial Office of the Study Programme of Automotive Engineering Education, Universitas Pendidikan…"},
  {"t":"KANAYAGAN - Journal of Music Education","cover":"","d":"Kanayagan: Journal of Music Education (e-ISSN: xxxx-xxxx | p-ISSN: xxxx-xxxx) is published by Program Studi Pendidikan Seni Musik, Fakultas Pendidikan Seni dan Desain, Universitas Pendidikan Indonesia, publish on April and October in a years. Provides a forum for lecturers, teachers, academicians, researchers,…"},
  {"t":"Jurnal Pecinta Alam dan Lingkungan","cover":"https://ejournal.upi.edu/public/journals/287/journalThumbnail_en_US.png","d":"Jurnal Pecinta Alam dan Lingkungan merupakan jurnal penelitian dan pengabdian kepada masyarakat yang dipublikasikan oleh Universitas Pendidikan Indonesia. Pertama kali terbit Tahun 2022 dengan ISSN Online : 2962-4754 serta ISSN Cetak : 2962-5653. Terbit 1 tahun dua kali pada bulan Agustus and Desember. Menerima naskah…"},
  {"t":"Curricula: Journal of Curriculum Development","cover":"https://ejournal.upi.edu/public/journals/285/journalThumbnail_en_US.jpg","d":"Official Statement: Website Migration to OJS 3.5From February 2, 2026, Curricula: Journal of Curriculum Development is migrating from OJS 2 to OJS 3.5. All manuscript submissions will be accepted only through the new website at: https://ejournal-education.upi.edu/curriculaManuscripts will no longer be accepted through…"},
  {"t":"Research of Economics, Management, Business and Education","cover":"","d":"Research of Economics, Management, Business and Education published by Fakultas Pendidikan Ekonomi dan Bisnis Universitas Pendidikan Indonesia It is published twice a year in June and December. Research of Economics, Management, Business and Education accepts manuscripts of either quantitative research, qualitative…"},
  {"t":"Indonesian Journal of Arts Education Research","cover":"","d":"Indonesian Journal of Arts Education Research (InJAERe) is a multidisciplinary peer-reviewed journal that focuses on arts education research results including performing arts education (music, dance, theater), fine arts education, film & television, and Visual Arts. The authors are academics and researchers, namely…"},
  {"t":"Jurnal Arsitektur ZONASI","cover":"https://ejournal.upi.edu/public/journals/183/journalThumbnail_en_US.jpg","d":"REGISTED NUMBER:ISSN: 2621-1610 (print) | ISSN: 2620-9934 (online)DOI: http://dx.doi.org/10.17509/jazURL: https://ejournal.upi.edu/index.php/jaz/indexJurnal Arsitektur Zonasi is Open Journal System published by Studio Perancangan Arsitektur dan Kota Universitas Pendidikan Indonesia, Bandung. This journal is a means of…"},
  {"t":"Journal of Automotive Engineering Education","cover":"https://ejournal.upi.edu/public/journals/305/journalThumbnail_en_US.png","d":"Journal Of Automotive Engineering Education : ATIKANOTO is a scientific publication aimed at advancing research in the field of automotive engineering education. ATIKANOTO is taken from the Sundanese language, namely \"Atikan\" which means Education and \"Oto\" which is an abbreviation of Automotive, based on this, this…"},
  {"t":"Early Childhood Education & Parenting","cover":"https://ejournal.upi.edu/public/journals/289/journalThumbnail_en_US.jpg","d":"ISSN 3046-451X (Online - Elektronik)Early Childhood Education &amp; Parenting (ECEPA) promotes research in the field of early childhood education, parenting, and ethno parenting with particular respect to Indonesia, but not limited to authorship or topical coverage within the region. Contributions are expected from…"},
  {"t":"Strength and Conditioning Exercise Science Journal","cover":"","d":"Journal DescriptionJournal title: Strength and Conditioning Exercise Science JournalInitial: SCESJFrequency: Twice a year, in May and Octobere-ISSN: 3090-8396p-ISSN: 3109-2195Editor-in-Chief: Dr. Alen Rismayadi, M.Pd.Managing Editor: Geraldi Novian, M.Pd.Publisher: Universitas Pendidikan IndonesiaStrength and…"},
  {"t":"Jurnal Profesi Bimbingan dan Konseling","cover":"https://ejournal.upi.edu/public/journals/278/journalThumbnail_en_US.png","d":"ISSN (p): 2275-0760ISSN (e): 2275-0804Jurnal Profesi Bimbingan dan Konseling : Journal of Counseling Profession (JCP) is published by Guidance and Counseling Study Program, Faculty of Educational Science, Universitas Pendidikan Indonesia (UPI) in collaboration with Asosiasi Bimbingan dan Konseling Indonesia (ABKIN).…"},
  {"t":"Indonesian Journal of Teaching English as a Foreign Language","cover":"","d":"The Indonesian Journal of Teaching English as a Foreign Language (IJTEFL) is a biannual journal, published by the English Language Education Study Program, Faculty of Language and Literature Education, Universitas Pendidikan Indonesia, that publishes research-based and conceptual articles. Each issue consists of five…"},
  {"t":"Journal of Industrial Product Design Research and Studies","cover":"https://ejournal.upi.edu/public/journals/282/journalThumbnail_en_US.jpg","d":"The Journal of Industrial Product Design Research and Studies (JIPDRS) (pISSN: 2830-6929 eISSN: 2830-6937) is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia, which is a dissemination medium for research result from scientists, engineers, and educators in many fields of design.…"},
  {"t":"The International Journal of Business Review (The Jobs Review)","cover":"https://ejournal.upi.edu/public/journals/185/journalThumbnail_en_US.jpg","d":"ACCREDITED by Minister of Research, Technology and Higher Education, Number 225/E/KPT/2023 - 1 Februari 2023The International Journal of Business Review (The Jobs Review) with the registered number e-issn 2621-413X and p-issn 2621-7317 and is published by Fakultas Pendidikan Ekonomi dan Bisnis Universitas Pendidikan…"},
  {"t":"INVOTEC","cover":"https://ejournal.upi.edu/public/journals/113/journalThumbnail_en_US.png","d":"Journal titleINVOTECFrequency2 issues per year (June & December)DOIPrefix 10.17509 Online ISSN2461-1336Print ISSN1411-5514Editor-in-chiefDewi CakrawatiPublisher Universitas Pendidikan IndonesiaCitation AnalysisSinta | Google Scholar | Garuda INVOTEC with registered number ISSN 2461-1336 (online) & ISSN 1411-5514…"},
  {"t":"Strategic : Jurnal Pendidikan Manajemen Bisnis","cover":"https://ejournal.upi.edu/public/journals/75/journalThumbnail_en_US.png","d":"ACCREDITED by Ministry of Research and Technology/National Research and Innovation Agency) No 85/M/KPT/2020, April 1, 2020. Certificate is available hereStrategic : Jurnal Pendidikan Manajemen Bisnis with registered number ISSN 1412-1964 (Print) and ISSN 2684-8066 (Online), is a peer-reviewed journal published two…"},
  {"t":"Jurnal Administrasi Pendidikan","cover":"https://ejournal.upi.edu/public/journals/157/journalThumbnail_en_US.jpg","d":"Jurnal Administrasi Pendidikan (JAP) (ISSN: e.2580-1007 p.1412-8152) is published on 2003 by Educational Administration Postgraduate Program, Universitas Pendidikan Indonesia. JAP is a journal that focuses on publishing qualitative and quantitative research articles in the scope of Educational Administration including…"},
  {"t":"Jurnal Ilmu Manajemen dan Bisnis","cover":"https://ejournal.upi.edu/public/journals/74/journalThumbnail_en_US.jpg","d":"Jurnal Ilmu Manajemen dan Bisnis with registered number ISSN 2337-411X (Print) and ISSN 2503-3522 (Online), is a peer-reviewed journal published two times a year (March and September) by Master in Management Program Fakultas Pendidikan Ekonomi dan Bisnis Universitas Pendidikan Indonesia. Jurnal Ilmu Manajemen dan…"},
  {"t":"Indonesian Journal of Applied Communication","cover":"","d":"Indonesian Journal of Applied Communication (IJAC) is a scientific communication journal published by the Communication Studies Study Programme UPI. The journal publishes two issues annually in April and October. Editors encourage authors to submit research results, findings, and academic writings, particularly those…"},
  {"t":"STILASI Jurnal Pendidikan Seni Rupa dan Desain","cover":"","d":""},
  {"t":"Edusentris","cover":"https://ejournal.upi.edu/public/journals/294/journalThumbnail_en_US.png","d":"Edusentris, the Journal of Teaching and Education Studies, is published by Center for Development and Publication of Scientific Work, School of Postgraduate Studies, Universitas Pendidikan Indonesia, on March, July and December. It aims to stimulate research, encourage academic exchange, and enhance the professional…"},
  {"t":"Journal of Mechatronics and Artificial Intelligence","cover":"https://ejournal.upi.edu/public/journals/293/journalThumbnail_en_US.png","d":"The Journal of Mechatronics and Artificial Intelligence (JMAI)E-ISSN 3048-4227 | P-ISSN 3062-729XThe Journal of Mechatronics and Artificial Intelligence (JMAI) serves as a platform for disseminating scholarly research related to the fields of mechatronics and artificial intelligence, as well as related…"},
  {"t":"Journal of Accounting Review and Audit Research","cover":"","d":""},
  {"t":"Jurnal Pengabdian Masyarakat dalam Ekonomi, Bisnis, Manajemen, dan Akuntansi (JPM-EBMA)","cover":"","d":""},
  {"t":"Jurnal Abdi Nusantara","cover":"","d":"Jurnal Abdi Nusantara (JAN) is published on 2025 by Elementary School and Early Childhood Teacher Education Program, Universitas Pendidikan Indonesia. Jurnal Abdi Nusantara is a journal that focuses on facilitating the results of community service from various educational disciplines and various other scientific…"},
  {"t":"Journal of Tourism Education","cover":"https://ejournal.upi.edu/public/journals/276/journalThumbnail_en_US.png","d":"Journal of Tourism Education (eISSN 2809-2449 pISSN 2809-3739) is a peer-reviewed journal designed to facilitate scholarly discussion regarding tourism education within a broad sense from related disciplines. It aims to serve the needs of most current advances of tourism education through the presentation of issues…"},
  {"t":"Indonesian Journal of Mathematics and Science Education","cover":"","d":""},
  {"t":"Journal of Didactic Studies","cover":"","d":"Journal titleJournal of Didactic StudiesPrint ISSN2987-856XOnline ISSN2987-7512DOIhttps://doi.org/10.17509/jds.xxxx|| prefix by Frequency2 issues per yearEditor-in-chiefEndah Silawati, M.PdPublisherPrimary Teacher Education and Early Childhood Education study programUniversitas Pendidikan Indonesia, Cibiru…"},
  {"t":"Dedicated: Journal of Community Services (Pengabdian kepada Masyarakat)","cover":"https://ejournal.upi.edu/public/journals/297/journalThumbnail_en_US.png","d":"Official Statement: Website Migration to OJS 3.5From January 12, 2026, Dedicated: Journal of Community Services (Pengabdian kepada Masyarakat) is migrating from OJS 2 to OJS 3.5. All manuscript submissions will be accepted only through the new website at: https://ejournal-education.upi.edu/dedicatedManuscripts will no…"},
  {"t":"Indonesian Journal of Multidiciplinary Research","cover":"https://ejournal.upi.edu/public/journals/275/journalThumbnail_en_US.jpg","d":"The Indonesian Journal of Multidiciplinary Research (IJoMR) (e-ISSN = 2776-5970; p-ISSN = 2776-608X; accreditated SINTA 4 by DGHE (Ministry of Research, Technology and Higher Education, Republic of Indonesia) no 204/E/KPT/2022 on 03/10/2022) is an open access and peer-reviewed journal, published by Universitas…"},
  {"t":"International Journal Pedagogy of Social Studies","cover":"https://ejournal.upi.edu/public/journals/102/journalThumbnail_en_US.jpg","d":"International Journal Pedagogy of Social Studies is an international journal that has coverage on Social Sciences Education which have relevance to social science education, sociology, politics, history, economics, geography, sociology, antropologhy, civics and all about of contributing to the formation of good…"},
  {"t":"Sosietas: Jurnal Pendidikan Sosiologi","cover":"","d":"Sosietas: Jurnal Pendidikan Sosiologi, registered under E-ISSN 2528-4657 (online: ISSN Portal) and P-ISSN 2088-575X (print: ISSN Portal), is a scientific journal published by the Sociology Education Programme, Faculty of Social Science Education, Universitas Pendidikan Indonesia, in collaboration with the Indonesian…"},
  {"t":"INFANTIA: Jurnal Pendidikan Anak Usia Dini","cover":"","d":""},
  {"t":"Lentera Karya Edukasi","cover":"https://ejournal.upi.edu/public/journals/271/journalThumbnail_en_US.jpg","d":"REGISTERED NUMBER:ISSN: 2776-9747 (print) | ISSN: 2776-9720 (online)DOI: http://dx.doi.org/10.17509/lenteraURL: http://ejournal.upi.edu/index.php/lentera/indexJURNAL LENTERA KARYA EDUKASI: Jurnal Pengabdian kepada Masyarakat adalah jurnal multidisiplin ilmiah yang diterbitkan oleh Pusat Pengembangan dan Kajian Sarana…"},
  {"t":"Jurnal Pendidikan Teknik Bangunan","cover":"https://ejournal.upi.edu/public/journals/270/journalThumbnail_en_US.png","d":"Journal titleJurnal Pendidikan Teknik BangunanFrequency 2 issues per year (April & November) DOI Prefix 10.17509 Print ISSN2807 - 9450Online ISSN2808-4284Editor-in-chiefSri RahayuPublisher Universitas Pendidikan Indonesia Citation Analysis Sinta | Google Scholar | Garuda Jurnal Pendidikan Teknik Bangunan (J PTB ) is a…"},
  {"t":"Indonesian Journal of Community Services in Engineering & Education (IJOCSEE)","cover":"https://ejournal.upi.edu/public/journals/269/journalThumbnail_en_US.png","d":"Indonesian Journal of Community Services in Engineering & Education (IJOCSEE) is published by Universitas Pendidikan Indonesia - Regional Campus of Purwakarta, with p-ISSN: 2776-3315, and e-ISSN: 2776-4370. IJOCSEE is a peer-reviewed journal that contains scientific articles adopting community service activities…"},
  {"t":"Jurnal Riset dan Praktik Pendidikan Kimia","cover":"","d":"Jurnal “Riset dan Praktik Pendidikan Kimia” adalah jurnal berkala yang terbit 2 kali dalam satu tahun pada bulan April dan Oktober. Jurnal Riset dan Praktik Pendidikan Kimia diterbitkan oleh Program Studi Pendidikan Kimia, Fakultas Pendidikan Matematika dan Ilmu Pengetahuan Alam bekerja sama dengan Masyarakat…"},
  {"t":"Journal of Logistics and Supply Chain","cover":"https://ejournal.upi.edu/public/journals/267/journalThumbnail_en_US.jpg","d":"Welcome to Journal of Logistics and Supply Chain(e-ISSN:2776-4400 p ISSN:2776-4397), short as JLSC, aims to facilitate and promote the inquiry into and dissemination of research results on Logistics field and Supply Chain. Academics and practitioner are welcomed, the journal area of interest are based on the…"},
  {"t":"TEKMULOGI: Jurnal Pengabdian Masyarakat","cover":"https://ejournal.upi.edu/public/journals/273/journalThumbnail_en_US.jpg","d":"Tekmulogi: Jurnal Pengabdian Masyarakat (ISSN : e. 2777-0990, p. 2777-1199) merupakan jurnal nasional yang didedikasikan untuk publikasi hasil kegiatan pengabdian kepada masyarakat yang berkualitas dalam bidang Tekonologi Pendidikan, Multimedia, Seni dan Desain, Teknik Komputer, Rekayasa Prangkat Lunak, Industri…"},
  {"t":"Indonesian Journal of Community Development","cover":"https://ejournal.upi.edu/public/journals/265/journalThumbnail_en_US.jpg","d":"The Indonesian Journal of Community Development (IJCD) is an open access scientific journal published by the Indonesian University of Education. It is a multidisciplinary, peer-reviewed journal that publishes articles derived from community service practices and research related to health, education, arts and…"},
  {"t":"Jurnal Pendidikan Perikanan Kelautan (Journal of Fisheries and Maritime Studies)","cover":"","d":"Jurnal Pendidikan Perikanan Kelautan (JPPK) / Journal of Fisheries and Maritime Studies merupakan media publikasi ilmiah yang memuat penelitian, kajian, dan pengembangan di bidang pendidikan, kelautan, dan perikanan dengan pendekatan interdisiplin. Jurnal ini berfokus pada kontribusi ilmiah yang memperkuat…"},
  {"t":"Current Issues on Elementary Education Journal","cover":"https://ejournal.upi.edu/public/journals/281/journalThumbnail_en_US.png","d":"Current Issues on Elementary Education Journal publishes original research or theoretical papers about teaching and learning in Elementary Education on current issues, namely:Teacher of elementary educationObservers and Researchers of elementary educationEducational decisions maker on the regional and national…"},
  {"t":"Journal of Computer Engineering, Electronics and Information Technology","cover":"https://ejournal.upi.edu/public/journals/266/journalThumbnail_en_US.png","d":"Journal of Computer Engineering, Electronics and Information Technology (COELITE) merupakan jurnal peer-review yang didedikasikan untuk publikasi hasil penelitian yang berkualitas dalam bidang Teknik Komputer, Elektronik, dan Teknologi Informasi, namum tidak terbatas secara implisit.Journal of Computer Engineering,…"},
  {"t":"Journal of Korean Applied Linguistics","cover":"https://ejournal.upi.edu/public/journals/263/journalThumbnail_en_US.png","d":"Journal of Korean Applied Linguistics (p-ISSN 2776-4494; e-ISSN 2776-4486) is an open access peer-refereed journal which is managed by Korean Language Education Study Program, Faculty of Language and Literature Education, and published by Universitas Pendidikan Indonesia. JoKAL welcomes and acknowledges high quality…"},
  {"t":"Telecommunications, Networks, Electronics, and Computer Technologies (TELNECT)","cover":"https://ejournal.upi.edu/public/journals/259/journalThumbnail_en_US.png","d":"Telecommunications, Networks, Electronics, and Computer Technologies (TELNECT) adalah peer-review jurnal ilmiah yang diterbitkan oleh Program Studi S1 Sistem Telekomunikasi Universitas Pendidikan Indonesia Kampus Purwakarta (p-ISSN: 2798-3242 dan e-ISSN: 2798-2785). Jurnal ini bertujuan untuk menerbitkan artikel…"},
  {"t":"Cinematology: Journal Anthology of Film and Television Studies","cover":"","d":"Cinematology: Journal Anthology of Film and Television Studies publishes papers regularly three times a year by the Film and Television Study Program, issued by the Faculty of Art and Design Education, Universitas Pendidikan Indonesia, Bandung, Indonesia. Cinematology: Journal Anthology of Film and Television Studies…"},
  {"t":"Indonesian Journal of Science and Engineering","cover":"","d":""},
  {"t":"Journal of Dance and Dance Education Studies","cover":"https://ejournal.upi.edu/public/journals/260/journalThumbnail_en_US.png","d":"JDDES; Journal of Dance and Dance Education Studies [e-ISSN: 2776-5326 | p-ISSN: 2797-8990] is a journal of dance studies and dance education published by the Dance Education Study Program, FPSD UPI, to disseminate research findings in the fields of dance studies and dance education.The scope of research in education…"},
  {"t":"Kokoh","cover":"https://ejournal.upi.edu/public/journals/261/journalThumbnail_en_US.jpg","d":"Jurnal Teknik Sipil Kokoh is a civil engineering journal published twice a year, namely in January and July which is routinely published by the Civil Engineering Study Program of Universitas Pendidikan Indonesia. eISSN 2828-5778 and pISSN 1412-050X.This journal contains research manuscripts and research analysis…"},
  {"t":"Journal of Applied Food and Nutrition","cover":"https://ejournal.upi.edu/public/journals/257/journalThumbnail_en_US.png","d":"JAFN: Journal Applied of Food and Nutrition (e-ISSN:2797-0698 and p-ISSN: 2797-068X) is an online, open access peer-reviewed journal, which is published by Universitas Pendidikan Indonesia twice a year (every June and December). This journal is for all contributors who concern with researches related to Food and…"},
  {"t":"Chemica Isola","cover":"https://ejournal.upi.edu/public/journals/258/journalThumbnail_en_US.jpg","d":"Jurnal Chemica Isola (e-ISSN: 2776-561X, p-ISSN: 2776-4427) merupakan jurnal nasional jurnal berkala ilmiah yang diterbitkan dua kali dalam setahun yang mempublikasikan hasil-hasil penelitian dalam bidang kimia. Cakupan jurnal ini meliputi semua bidang kimia dan bidang-bidang ilmu yang terkait termasuk, Kimia Organik,…"},
  {"t":"Bina Sehat Masyarakat","cover":"https://ejournal.upi.edu/public/journals/256/journalThumbnail_en_US.png","d":"Jurnal Pengabdian Masyarakat “Bina Sehat Masyarakat” adalah jurnal yang berisi hasil pengabdian kepada masyarakat yang berfokus pada masalah utama dalam pengembangan ilmu bidang keperawatan. Bentuk kegiatan pengabdian kepada masyarakat yang dipublikasikan berupa implementasi hasil penelitian, penerapan teknologi tepat…"},
  {"t":"Jurnal Manajemen Resort dan Leisure","cover":"https://ejournal.upi.edu/public/journals/77/journalThumbnail_en_US.jpg","d":"Jurnal Manajemen Resort & Leisuremerupakan manuskrip berkualitas yang menerbitkan hasil penelitian, pemikiran-pemikiran, maupun tulisan akdemik, khususnya yang berkaitan dengan bidang kepariwisataan. Jurnal ini memfokuskan pada kajian pengembangan dan pengelolaan destinasi wisata, pariwisata berkelanjutan,…"},
  {"t":"Tourism and Hospitality Essentials Journal","cover":"https://ejournal.upi.edu/public/journals/107/journalThumbnail_en_US.jpg","d":"Tourism and Hospitality Essentials Journal (e-ISSN: 2549-9920 and p-ISSN 2460-366X) is a collection of articles of academic publication. The article could be based on conceptual or empirical research using the qualitative, quantitative, or mixed method approach. Tourism and hospitality themes within the field of…"},
  {"t":"Jurnal Tata Kelola Pendidikan","cover":"https://ejournal.upi.edu/public/journals/133/journalThumbnail_en_US.png","d":"This journal has been published since April 1999 under the name Journal Addend. Since April 2019 it has changed to ADPEND Journal of Jurnal Tata Kelola Pendidikan. Which was loaded with volume 1, Number 1, April 2019. Jurnal Tata Kelola Pendidikan accepts writing contributions that have not been published in other…"},
  {"t":"Journal of Mechanical Engineering Education","cover":"https://ejournal.upi.edu/public/journals/68/journalThumbnail_en_US.png","d":"The Journal of Mechanical Engineering Education (Jurnal Pendidikan Teknik Mesin) (ISSN: p.2356-4997 e.2715-4734) is an open access and peer-reviewed journal, published by Department of Mechanical Engineering Education, Universitas Pendidikan Indonesia which collaborates with ADVGI.This journal aims to facilitate…"},
  {"t":"Gunahumas","cover":"https://ejournal.upi.edu/public/journals/211/journalThumbnail_en_US.png","d":"Jurnal Gunahumas with registered number 2655-1551 (Print) and 2774-2822 (Online) is published by Kantor Hubungan Masyarakat Universitas Pendidikan Indonesia. It is published twice a year. Jurnal Gunahumas Journal is a journal that publishes the work of researchers and practitioners in the field of Public Relations.…"},
  {"t":"Metodik Didaktik","cover":"https://ejournal.upi.edu/public/journals/145/journalThumbnail_en_US.jpg","d":"p-ISSN 1907-6967 | e-ISSN 2528-5653Metodik Didaktik is a peer-reviewed, professional scientific national journal in the field of Primary Education. Metodik Didaktik, which focuses on the theoretical issues and pedagogical practices in primary education, was published by Elementary School Teacher Education Study…"},
  {"t":"EDUFORTECH","cover":"https://ejournal.upi.edu/public/journals/110/journalThumbnail_en_US.jpg","d":"E-ISSN : 2541-4593 dan P-ISSN : 2776-4761 Jurnal EDUFORTECH merupakan sarana pengembangan dan publikasi karya ilmiah bagi para peneliti, dosen dan praktisi di bidang teknologi pengolahan hasil pertanian, dan pendidikan teknologi agroindustri.EDUFORTECH diterbitkan oleh Program Studi Pendidikan Teknologi Agroindustri…"},
  {"t":"ELECTRANS","cover":"https://ejournal.upi.edu/public/journals/66/journalThumbnail_en_US.jpg","d":"ELECTRANS - Jurnal Teknik ElektroMenerbitkan makalah-makalah original dalam bidang teknik elektro dan elektronika. Tim redaksi menerima kontribusi yang mendasar untuk pengembangan keilmuan teknik elektro dan aplikasinya, baik hasil riset teoritis ataupun eksperimental"},
  {"t":"Jurnal Kepelatihan Olahraga","cover":"https://ejournal.upi.edu/public/journals/191/journalThumbnail_en_US.png","d":"Jurnal Kepelatihan Olahraga (JKO) is a media for widespread the results of research, studies and ideas in the field of sports coaching. This journal is published by Universitas Pendidikan Indonesia. This Jurnal Kepelatihan Olahraga (JKO), firstly published offline/printed in 2009 and then registered nationally since…"},
  {"t":"Jurnal Pendidikan Luar Sekolah","cover":"https://ejournal.upi.edu/public/journals/73/journalThumbnail_en_US.jpg","d":"Jurnal Pendidikan Luar SekolahJurnal Pendidikan Luar Sekolah sebagai jurnal pendidikan sosial dan pembangunan masyarakat yang mempublikasikan hasil penelitian dan artikel dalam kajian pendidikan orang dewasa, pendidikan sepanjang hayat, penyelenggaraan pendidikan dan pembelajaran dalam setting pendidikan nonformal dan…"},
  {"t":"Allemania","cover":"","d":"Journal of German Language Education pISSN: 2088-7582eISSN : 3063- 5381 Allemania is a journal of German language education with the registered number p-ISSN 2088-7582 and e-ISSN 3063-5381. It is published by the German Language Education Study Program, Faculty of Languages and Literature Education, Universitas…"},
  {"t":"SABA: Journal of Tourism Research","cover":"","d":"“Saba” is a word taken from the Sundanese language that means the act of travelling around. This word aligns with this journal’s focus on travel and tourism.Saba : Journal of Tourism Research is dedicated to disseminating scholarly publications on tourism. This journal was formerly known as Tourism and Hospitality…"},
  {"t":"Jurnal Pena Ilmiah","cover":"","d":"E-ISSN: 2540-9174 Jurnal Pena Ilmiah merupakan jurnal ilmiah yang diterbitkan oleh Program Studi Pendidikan Guru Sekolah Dasar (PGSD), Universitas Pendidikan Indonesia Kampus Sumedang. Jurnal ini berfokus pada publikasi hasil penelitian, kajian teoritis, serta praktik inovatif dalam bidang pendidikan dasar.Tujuan…"},
  {"t":"Journal of Physical Education and Sport Pedagogy","cover":"https://ejournal.upi.edu/public/journals/251/journalThumbnail_en_US.png","d":"Journal DescriptionThis journal facilitates academic articles, book reports, and literature reviews. It aims to develop scientific discussion related to Physical Education and Sport Pedagogy. General discussion and essential findings are welcomed to create sustainability of worldwide learning education.Aims and…"},
  {"t":"Journal Description","cover":"","d":""},
  {"t":"Aims and Scopes","cover":"","d":""},
  {"t":"FamilyEdu: Jurnal Pendidikan Kesejahteraan Keluarga","cover":"https://ejournal.upi.edu/public/journals/72/journalThumbnail_en_US.jpg","d":"Jurnal FamilyEdu merupakan wahana penyaluran dan penyebarluasan hasil penelitian, kajian dan gagasan di bidang pendidikan khususnya Pendidikan Kesejahteraan Keluarga. Redaksi menerima sumbangan tulisan dari penemuan hasil penelitian dan kajian di bidang Pendidikan Kesejahteraan Keluarga. Redaksi berhak menambah,…"},
  {"t":"TORSI","cover":"https://ejournal.upi.edu/public/journals/111/journalThumbnail_en_US.jpg","d":"Jurnal TORSI ini diterbitkan dengan sasaran untuk mempublikasikan hasil penelitian yang orisinal, pemikiran, dan pandangan serta penyebarluasan ilmu bidang teknik mesin. Redaksi berharap jurnal TORSI ini akan berkembang menjadi jurnal yang berkualitas, memilki bobot ilmiah yang cukup tinggi, dan terakreditasi.…"},
  {"t":"Passage: Journal of English Language and Literature","cover":"","d":"Register Aims & ScopePassage: Journal of English Language and Literature is a journal published by the English Language and Literature Study Program, Universitas Pendidikan Indonesia. Initially published for students’ articles based on their final research paper, Passage: Journal of English Language and Literature now…"},
  {"t":"Jurnal Asesmen Dan Intervensi Anak Berkebutuhan Khusus","cover":"https://ejournal.upi.edu/public/journals/129/journalThumbnail_en_US.png","d":"The Jurnal Asesmen Dan Intervensi Anak Berkebutuhan Khusus is a journal in the field of special education, therefore this journal contains knowledge in the field of special education both from research results and ideas. The scientific fields published in the journal are the results of research, studies, and ideas in…"},
  {"t":"Religio Education","cover":"https://ejournal.upi.edu/public/journals/247/journalThumbnail_en_US.png","d":"Religio Education (ISSN e.2776-3285 p.2776-3366) is an International journal published by the Islamic Religious Education Study Program, Faculty of Social Science Education, Universitas Pendidikan Indonesia, Bandung, West Java, Indonesia. Religio Education is a member of the Directory of Open Access Journals (DOAJ).…"},
  {"t":"Indonesian Journal of Digital Business","cover":"","d":"From January 1, 2026, Indonesian Journal of Digital Business is migrating from OJS 2 to OJS 3.3. All manuscript submissions will be accepted only through the new website at: https://ejournal-upitasikmalaya.upi.edu/ijdbManuscripts will no longer be accepted through this website after this date. Migration official…"},
  {"t":"Edulibinfo","cover":"https://ejournal.upi.edu/public/journals/117/journalThumbnail_en_US.png","d":"Jurnal Edulibinfo merupakan jurnal pada bidang kajian Perpustakaan dan Ilmu Informasi (Perpusinfo) yang diterbitkan oleh Program Studi Perpustakaan dan Ilmu Informasi, Departemen Kurikulum dan Teknologi Pendidikan, Fakultas Ilmu Pendidikan, Universitas Pendidikan Indonesia. Jurnal ini mempublikasikan hasil penelitian…"},
  {"t":"Journal of Physical Education For Secondary Schools","cover":"https://ejournal.upi.edu/public/journals/237/journalThumbnail_en_US.png","d":"Journal of Physical Education for Secondary Schools (JPESS), peer-reviewed journal (print and online) published by Program Studi Pendidikan Jasmani Kesehatan dan Rekreasi, Universitas Pendidikan Indonesia, which was founded in 2020. It publishes articles of a high standard on various aspects of the Physical Education…"},
  {"t":"Jurnal Abmas","cover":"https://ejournal.upi.edu/public/journals/250/journalThumbnail_en_US.jpg","d":"About Abmas JournalFrom November 2025, Jurnal Abmas is migrating from OJS 2 to OJS 3.5. All manuscript submissions will be accepted only through the new website at: https://ejournal-dppm.upi.edu/abmas/Abmas Journal has been accredited at Rank 5 through the Decree of the Director General of Higher Education, Research…"},
  {"t":"About Abmas Journal","cover":"","d":""},
  {"t":"Contact Information","cover":"","d":""},
  {"t":"Didaktika","cover":"","d":"Didaktika (e-ISSN: 2775-9024 p-ISSN: 2987-9388) adalah jurnal ilmiah open akses yang secara berkala yang diterbitkan oleh Universitas Pendidikan Indonesia Kampus Serang. Didaktika diterbitkan empat kali satu tahun (Maret, Juni, September, dan Desember) yang mempublikasikan hasil penelitian orisinal tentang pendidikan…"},
  {"t":"Jurnal Pedagogik Pendidikan Dasar","cover":"https://ejournal.upi.edu/public/journals/86/journalThumbnail_en_US.jpg","d":"Jurnal Pedagogik Pendidikan Dasar with registered number ISSN 2776-2467 (online) and ISSN 2337-4543 (print), is an open access and peer-reviewed scientific journal that publishes different kinds of scientific articles based on the research-article and ideas-article. All topics that we received only articles relating…"},
  {"t":"Jurnal Pengabdian Masyarakat PGSD","cover":"https://ejournal.upi.edu/public/journals/239/journalThumbnail_en_US.jpg","d":"Jurnal Pengabdian Masyarakat PGSD (e-ISSN: 2775-5940 p-ISSN: 2987-9396) is calling for best practice articles from researchers around the globe. This journal is published by the Primary School Teacher Education Program, Universitas Pendidikan Indonesian at Serang Campus. Jurnal Pengabdian Masyarakat PGSD is a…"},
  {"t":"PEDADIDAKTIKA: Jurnal Ilmiah Mahasiswa Pendidikan Guru Sekolah Dasar","cover":"https://ejournal.upi.edu/public/journals/137/journalThumbnail_en_US.jpg","d":"PEDADIDAKTIKA: Jurnal Ilmiah Mahasiswa Pendidikan Guru Sekolah Dasar adalah jurnal berkala ilmiah yang diterbitkan empat kali satu tahun (Maret, Juni, September, dan Desember) yang mempublikasikan hasil penelitian orisinal tentang pendidikan guru sekolah dasar. Jurnal ini bertujuan untuk mengembangkan konsep, teori,…"},
  {"t":"Indonesian Journal of Community and Special Needs Education","cover":"https://ejournal.upi.edu/public/journals/254/journalThumbnail_en_US.png","d":"The Indonesian Journal of Community and Special Needs Education (IJCSNE) (ISSN e. 2775-9857 p. 2775-8400; accreditated SINTA 4 by DGHE (Ministry of Research, Technology and Higher Education, Republic of Indonesia) no 204/E/KPT/2022 on 03/10/2022) is an open access and peer-reviewed journal, published by Universitas…"},
  {"t":"Sosio Religi: Jurnal Kajian Pendidikan Umum","cover":"https://ejournal.upi.edu/public/journals/126/journalThumbnail_en_US.jpg","d":"Sosio Religi (Journal of General Education / Values) was published twice in March and September which was published by the FPIPS Department of General Education, University of Education and Association of Lecturers and Scholars of General / Value of Indonesian Education (Asosiasi Dosen dan Sarjana Pendidikan…"},
  {"t":"Nursing Insight: Jurnal Ilmu Keperawatan","cover":"","d":"The Nursing Insight: Jurnal Ilmu Keperawatan (NIJIK) is an open access, peer-reviewed, multidisciplinary journal dedicated to the publication of novel research in all aspects of nursing area. NIJIK is published three times a year and accepts original research articles featuring well-designed studies with clearly…"},
  {"t":"Interlude: Indonesian Journal of Music Research, Development, and Technology","cover":"https://ejournal.upi.edu/public/journals/242/journalThumbnail_en_US.png","d":"Interlude: The Indonesian Journal of Music Research, Development, and Technology (ISSN: e.3062-6846 p.XXXX-XXXX) serves as a vibrant forum where professionals and academics collaborate to further the comprehension and implementation of music in the context of interdisciplinary research and technological advancements.…"},
  {"t":"Journal of English and Education","cover":"https://ejournal.upi.edu/public/journals/54/journalThumbnail_en_US.jpg","d":"Learning is an anthology of articles from students of English Education study program at Indonesia University of Education. It publishes twice a year: October and April. The articles in each issue are based on undergraduate students' final paper (skripsi)."},
  {"t":"Tourism Industry Journal","cover":"https://ejournal.upi.edu/public/journals/249/journalThumbnail_en_US.jpg","d":"ProfileTourism Industry Journal is aims to establish and improve the quality of tourism especially in Indonesia in an integrated and sustainable. This is implemented in research, publication, and devotion in the tourism sector. The Tourism Industry Journal as one of the roles of academics in the development pentahelix…"},
  {"t":"A Social Science and Entrepreneurship Journal","cover":"https://ejournal.upi.edu/public/journals/236/journalThumbnail_en_US.jpg","d":""},
  {"t":"FINDER: Journal of Visual Communication Design","cover":"https://ejournal.upi.edu/public/journals/243/journalThumbnail_en_US.png","d":"The FINDER: Journal of Visual Communication Design is an open-access, peer-reviewed academic publication dedicated to the advancement of Visual Communication Design. Published by the Visual Communication Design Department at Universitas Pendidikan Indonesia, the journal explores a broad range of topics, including…"},
  {"t":"Jurnal Pendidikan Guru Sekolah Dasar","cover":"https://ejournal.upi.edu/public/journals/134/journalThumbnail_en_US.jpg","d":"Online ISSN: 3048-0140Print ISSN: 3062-7559Jurnal Pendidikan Guru Sekolah Dasar (JPGSD) dipublikasikan oleh Program Studi Pendidikan Guru Sekolah Dasar (PGSD) Fakultas Ilmu Pendidikan Universitas Pendidikan Indonesia. Jurnal ini mempublikasikan hasil penelitian tentang kependidikan dasaran dengan berbagai topik kajian…"},
  {"t":"ASEAN Journal of Science and Engineering Education","cover":"https://ejournal.upi.edu/public/journals/248/journalThumbnail_en_US.png","d":"The ASEAN Journal of Science and Engineering Education (AJSEE) (ISSN: e. 2775-6815 p. 2775-6793) accreditated SINTA 4 by DGHE (Ministry of Research, Technology and Higher Education, Republic of Indonesia) no 79/E/KPT/2023 on 11/05/2023 is an open access and peer-reviewed journal, published by Universitas Pendidikan…"},
  {"t":"Jurnal Pendidikan Non Formal dan Informal","cover":"https://ejournal.upi.edu/public/journals/161/journalThumbnail_en_US.jpg","d":"Jurnal Pendidikan Non Formal dan InformalJurnal Pendidikan Non Formal dan Informal sebagai jurnal pendidikan sosial dan pembangunan masyarakat yang mempublikasikan hasil penelitian dan artikel dalam kajian pendidikan orang dewasa, pendidikan sepanjang hayat, penyelenggaraan pendidikan dan pembelajaran dalam setting…"},
  {"t":"Educational Technologia","cover":"https://ejournal.upi.edu/public/journals/132/journalThumbnail_en_US.jpg","d":"Jurnal EDUTECHNOLOGIA merupakan jurnal pada bidang kajian Pendidikan, Teknologi Pendidikan, Teknologi Informasi dan Komunikasi yang diterbitkan oleh Program Studi Teknologi Pendidikan, Departemen Kurikulum dan Teknologi Pendidikan, Fakultas Ilmu Pendidikan, Universitas Pendidikan Indonesia. Jurnal ini mempublikasikan…"},
  {"t":"Fesyen Perspektif","cover":"https://ejournal.upi.edu/public/journals/155/journalThumbnail_en_US.png","d":"Fesyen Perspektif merupakan Jurnal yang dikelola oleh program studi Pendidikan Tata Busana, sebagai tempat yang mewadahi berbagai hasil karya ilmiah mahasiswa dan pengajar di lingkungan Prodi Pendidikan Tata Busana Departemen PKK FPTK UPI. Terbit dua kali setahun pada bulan April dan Oktober, berisi tulisan yang…"},
  {"t":"EDUJAPAN","cover":"https://ejournal.upi.edu/public/journals/150/journalThumbnail_en_US.jpg","d":"Jurnal elektronik EDUJAPAN merupakan jurnal yang memuat hasil-hasil penelitian yang dilakukan oleh mahasiswa/i Departemen Pendidikan Bahasa Jepang, Fakultas Pendidikan Bahasa dan Sastra, Universitas Pendidikan Indonesia.Artikel-artikel yang dimuat pada jurnal EDUJAPAN merupakan ringkasan hasil penelitian yang…"},
  {"t":"Riksa Bahasa: Jurnal Bahasa, Sastra, dan Pembelajarannya","cover":"https://ejournal.upi.edu/public/journals/159/journalThumbnail_en_US.jpg","d":"Riksa Bahasa merupakan jurnal yang mempublikasikan kumpulan artikel hasil penelitian-penelitian dan telaah di bidang bahasa, sastra, tradisi lisan dan pembelajarannya. Jurnal ini dikelola oleh Program Studi Pendidikan Bahasa Indonesia, Sekolah Pascasarjana, Universitas Pendidikan Indonesia."},
  {"t":"JURNAL PSIKOLOGI INSIGHT","cover":"https://ejournal.upi.edu/public/journals/130/journalThumbnail_en_US.jpg","d":"The Jurnal Psikologi Insight (JPI) (ISSN: e.2581-0553 p.2599-3208) is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia, which is a dissemination from research results from scientists and psychologist in many fields of psychology. JPI is issues 2 times a year (April and…"},
  {"t":"JURNAL PAUD AGAPEDIA","cover":"https://ejournal.upi.edu/public/journals/167/journalThumbnail_en_US.png","d":"JPA is a journal that publishes the results of studies and research related to early childhood education from a multidisciplinary perspective. This journal aims to expand and create innovative concepts, theories, paradigms, perspectives and methodologies in developing early childhood education.The scope of the…"},
  {"t":"SpoRTIVE","cover":"","d":"SpoRTIVE is an online scholarly journal published by the Physical Education Teacher Education Program (PGSD Penjas), Universitas Pendidikan Indonesia (UPI) Sumedang Campus, since 2016. The journal serves as a scientific publication medium for disseminating original research articles and high-quality review…"},
  {"t":"Mimbar Pendidikan Dasar","cover":"https://ejournal.upi.edu/public/journals/144/journalThumbnail_en_US.jpg","d":"Jurnal Mimbar Pendidikan Dasar adalah jurnal yang memuat artikel-artikel hasil penelitian dan gagasan pada tataran pendidikan dasar. Jurnal terbit dua kali dalam setahun, yaitu di bulan Februari dan September. Jurnal diterbitkan oleh Program Studi PGSD Penjas Universitas Pendidikan Indonesia Kampus Sumedang."},
  {"t":"Jurnal EurekaMatika","cover":"https://ejournal.upi.edu/public/journals/168/journalThumbnail_en_US.jpg","d":"🚨 IMPORTANT ANNOUNCEMENT 🚨We would like to inform all authors, reviewers, and readers that the official website of Jurnal EurekaMatika (JEM) has been moved to a new platform:👉 https://ejournal-science.upi.edu/jem/index This transition has been made following the upgrade provided by Universitas Pendidikan Indonesia…"},
  {"t":"EARR (Educational Administration Research and Review)","cover":"https://ejournal.upi.edu/public/journals/154/journalThumbnail_en_US.jpg","d":"The Educational Administration Research and Review (EARR) is the international refereed journal in the field of educational leadership and management founded first in 2017 initiated by the center of Study Educational Leadership and Planning of Educational Administration School of Post Graduate Universitas Pendidikan…"},
  {"t":"Media Pendidikan Gizi dan Kuliner","cover":"https://ejournal.upi.edu/public/journals/153/journalThumbnail_en_US.png","d":"Journal titleJurnal Media Pendidikan, Gizi dan KulinerInnitialsJMPGKFrequency2 issues per year (April & November)DOIon ProgressPrint ISSN2085-9783Online ISSN2549-6123Editor-in-ChiefDr. Ai Nurhayati, M.Si.PublisherProgram Studi Tata Boga, DPKK, FPTK, Universitas Pendidikan IndonesiaCitation AnalysisGoogle…"},
  {"t":"Indonesian Journal of Economic Education (IJEE)","cover":"https://ejournal.upi.edu/public/journals/123/journalThumbnail_en_US.png","d":"Indonesian Journal of Economic Education (IJEE), with registered numbers ISSN 2615-5001 (Print) and ISSN 2615-5060 (Online), is published by the Economics Education Study Program, Faculty of Economics and Business Education, Universitas Pendidikan Indonesia. This journal is published twice a year, in February and…"},
  {"t":"Journal of Sustainable Development Education and Research","cover":"https://ejournal.upi.edu/public/journals/163/journalThumbnail_en_US.jpg","d":"ISSN: 2580-6920Journal of Sustainable Development Education and Research (JSDER) is a referred online journal published by School of Postgraduate Studies, Universitas Pendidikan Indonesia (SPS UPI).JSDER is a peer-reviewed journal published twice a year. The journal is dedicated to increasing the depth of Current…"},
  {"t":"International Journal of Sport Science, Health and Physical Education","cover":"https://ejournal.upi.edu/public/journals/188/journalThumbnail_en_US.png","d":"The International Journal of Sport Science, Health and Physical Education (IJSSHPE) is biannual journal issued on January and August by Faculty of Sport and Health Education, Universitas Pendidikan Indonesia, Indonesia. IJSSHPE is an open access and blind peer-reviewed journal, which is a dissemination medium for…"},
  {"t":"Edukids: Jurnal Pertumbuhan, Perkembangan, dan Pendidikan Anak Usia Dini","cover":"https://ejournal.upi.edu/public/journals/207/journalThumbnail_en_US.png","d":""},
  {"t":"The Journal Gastronomy Tourism","cover":"https://ejournal.upi.edu/public/journals/105/journalThumbnail_en_US.png","d":"We Have Moved! Our website is now available at a new address. For the latest information, please visit: https://ejournal-social.upi.edu/gastur/"},
  {"t":"Journal of BioSustainability","cover":"","d":"Journal of BioSustainability (e-ISSN: 3063-2129) is a biannual peer-reviewed journal that publishes original research and review articles in the field of sustainability and biological sciences. It is published by the Study Program of Biology, Universitas Pendidikan Indonesia, and collaborates with Konsorsium Biologi…"},
  {"t":"Current Research in Education: Conference Series Journal","cover":"https://ejournal.upi.edu/public/journals/197/journalThumbnail_en_US.jpg","d":"Current Research in Education: Conference Series Journal | e-ISSN 2656-4025Current Research in Education: Conference Series Journal is a conference proceedings journal that publishes scientific papers presented at conferences, workshops, and symposia in the field of education. The journal aims to disseminate academic…"},
  {"t":"ASEAN Journal of Sport for Development and Peace","cover":"https://ejournal.upi.edu/public/journals/241/journalThumbnail_en_US.png","d":"ASEAN Journal of Sport for Development and Peace (AJSDP) is a journal that aims to promote Sport for Development and Peace (S4DP), which is one of the issues raised by the United Nations. This journal will not only publish about the development of sport but also the development through sport.AJSDP publishes two issues…"},
  {"t":"Professional Development and Learning Improvement","cover":"https://ejournal.upi.edu/public/journals/198/journalThumbnail_en_US.jpg","d":"Professional Development and Learning improvement is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia, which is a dissemination medium for research result from scientists and engineers in many fields of science and technology. PDLI is a biannual journal issued on April and…"},
  {"t":"INTEGRATED (Journal of Information Technology and Vocational Education)","cover":"https://ejournal.upi.edu/public/journals/195/journalThumbnail_en_US.png","d":"INTEGRATED is a scientific journal published by the Department of PSTI UPI Kampus Purwakarta. This journal contains scientific papers from Academics, Researchers, and Practitioners about research on information system and vocational education.INTEGRATED is published twice a year in April and October. The paper is an…"},
  {"t":"Journal of Architectural Research and Education","cover":"https://ejournal.upi.edu/public/journals/203/journalThumbnail_en_US.jpg","d":"ISSN:2580-1279 (online) and 2776-9909 (cetak)DOI : https://dx.doi.org/10.17509/jareURL: https://ejournal.upi.edu/index.php/jare/indexJournal of Architectural Research and Education (JARE) is an Open Journal System published by the Department of Architecture Education, Universitas Pendidikan Indonesia, Bandung. This…"},
  {"t":"Journal of Development and Integrated Engineering","cover":"https://ejournal.upi.edu/public/journals/246/journalThumbnail_en_US.png","d":"ISSN: 2798-2165(online) dan 2798-2246 (cetak) DOI: https://dx.doi.org/10.17509/Jodie URL: https://ejournal.upi.edu/index.php/JoDiE/indexAims and Scope: The Journal of Development and Integrated Engineering - JoDiE is an international journal dedicated to the improvement and dissemination of knowledge on methods,…"},
  {"t":"Journal of Software Engineering, Information and Communication Technology (SEICT)","cover":"https://ejournal.upi.edu/public/journals/232/journalThumbnail_en_US.jpg","d":"Journal of Software Engineering, Information and Communication Technology (SEICT) is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia, which is a dissemination medium for research results from scientists and engineers in many fields of software engineering, information technology…"},
  {"t":"CAPEU Journal of Education","cover":"https://ejournal.upi.edu/public/journals/206/journalThumbnail_en_US.png","d":"CAPEU Journal of Education focuses, but not limited to:Language and Literature EducationSocial Science EducationSports and Health EducationEducation SciencesTechnical and vocational educationEconomics and Business EducationMath and Natural Science EducationVisual Arts, Dance, Music, and Design EducationThe policy,…"},
  {"t":"Indonesian Journal of Adult and Community Education","cover":"https://ejournal.upi.edu/public/journals/201/journalThumbnail_en_US.jpg","d":"Indonesian Journal of Adult and Community Education (IJACE) is an open access and peer-reviewed journal, published by Department Community Education, Faculty of Education Universitas Pendidikan Indonesia. This Journal collaborative with Indonesian Community Education Association (APENMASI) which is publishes research…"},
  {"t":"JURNAL CIVICUS","cover":"https://ejournal.upi.edu/public/journals/103/journalThumbnail_en_US.png","d":"From June 1, 2026, Jurnal Civicus is migrating from OJS 2 to OJS 3.3. All manuscript submissions will be accepted only through the new website at: https://ejournal-social.upi.edu/civicusJournal Title Jurnal CivicusInitials JCAbbrevation J.civicusFrequency 2 issues per year (June and December)DOI 10/17509/civicusOnline…"},
  {"t":"International Journal of Learning Sustainability","cover":"","d":"The International Journal of Learning and Education Sustainability (IJoLES) provides a dedicated platform for the dissemination of high-quality research, theoretical frameworks, case studies, and innovative practices in the fields of learning and education sustainability. The journal seeks to bridge the gap between…"},
  {"t":"Research in Early Childhood Education and Parenting","cover":"https://ejournal.upi.edu/public/journals/234/journalThumbnail_en_US.png","d":"Research in Early Childhood Education and Parenting (RECEP) is a peer-reviewed, professional scientific national journal in the field of Early Childhood Education. RECEP, which focuses on the theoretical issues and pedagogical practices in early childhood education and parenting, published by the Early Childhood…"},
  {"t":"Dimasatra","cover":"https://ejournal.upi.edu/public/journals/235/journalThumbnail_en_US.jpg","d":"DIMASATRA: Jurnal Pengabdian kepada Masyarakat memuat artikel hasil kajian dan penelitian terkait pengabdian masyarakat bidang ilmu bahasa, budaya, dan sastra. Jurnal ini memiliki online-ISSN 2774-759X, diterbitkan pertama kali pada Oktober 2020. Ruang lingkup jurnal ini di antaranya: (1) Pendidikan kemasyarakatan di…"},
  {"t":"FACTUM: Jurnal Sejarah dan Pendidikan Sejarah","cover":"https://ejournal.upi.edu/public/journals/151/journalThumbnail_en_US.jpg","d":"Factum: Jurnal Sejarah dan Pendidikan Sejarah with registered number p-ISSN 2302-9889 and e-IISN 2615-515X. Published by Departement of History Education, Faculty of Social Studies Education. Indonesian University of Education. This journal collaborates with the Association of History Educators and Researchers (APPS)…"},
  {"t":"Jurnal Pendidikan Multimedia (Edsence)","cover":"https://ejournal.upi.edu/public/journals/204/journalThumbnail_en_US.png","d":"Fast traslate Icon translate Fast traslate Icon translate Fast traslate Icon translate The Jurnal Pendidikan Multimedia (Edsence) is a journal intended as a communication forum for practitioners in the field of Multimedia expertise and other scientists from various disciplines.The Jurnal Pendidikan Multimedia…"},
  {"t":"Jurnal Kemaritiman: Indonesian Journal of Maritime","cover":"","d":"Jurnal Kemaritiman: Indonesian Journal of Maritime is an open-access, peer-reviewed journal that publishes high-quality research articles covering a wide range of topics in maritime studies. The journal aims to promote interdisciplinary research and innovation in the maritime domain, including but not limited to the…"},
  {"t":"Jurnal Pasca Dharma Pengabdian Masyarakat","cover":"https://ejournal.upi.edu/public/journals/223/journalThumbnail_en_US.png","d":"Jurnal Pasca Dharma Pengabdian Masyarakat (PDPM), with ISSN 2722-6085 (Print) and ISSN 2722-4996 (Online), is published by the Faculty of Economics and Business Education, Universitas Pendidikan Indonesia. Established on January 10, 2020, this journal was initiated by the management of the Postgraduate School to…"},
  {"t":"Taklim : Jurnal Pendidikan Agama Islam","cover":"https://ejournal.upi.edu/public/journals/233/journalThumbnail_en_US.jpg","d":"Taklim: Jurnal Pendidikan Agama Islam (TJPAI) (ISSN: e.2776-026X p.2337-4276) is open access (means that all content is freely available without charge to the user or his/her institution) and peer-reviewed journal published by Program Studi Ilmu Pendidikan Agama Islam (IPAI), Fakultas Pendidikan Ilmu Pengetahuan…"},
  {"t":"Jurnal Aplikasi dan Teori Ilmu Komputer","cover":"https://ejournal.upi.edu/public/journals/216/journalThumbnail_en_US.jpg","d":"JATIKOM is a national journal aimed as a publication medium for research results on applications and theories in the field of computer science. These include areas such as artificial intelligence, software engineering, databases, information systems, computer networks, information technology, simulation and modeling,…"},
  {"t":"Journal of Computers for Society","cover":"https://ejournal.upi.edu/public/journals/228/journalThumbnail_en_US.jpg","d":"Journal of Computers for Society (JCS) (e-ISSN:2723-4088) is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia. JCS is a biannual journal issued on June and November. The Journal invites original articles and not simultaneously submitted to another journal or conference. The whole…"},
  {"t":"International Journal Management Science and Business","cover":"https://ejournal.upi.edu/public/journals/209/journalThumbnail_en_US.jpg","d":"International Journal Management Science and Business with registered number ISSN 2684-8058 (online) ISSN 2657-1951 (Print), is a peer-reviewed journal published two times a year (May and November) by Doctor in Management Program Sekolah Pascasarjana Universitas Pendidikan Indonesia. International Journal Management…"},
  {"t":"Artikulasi: Jurnal Pendidikan Bahasa dan Sastra Indonesia","cover":"https://ejournal.upi.edu/public/journals/205/journalThumbnail_en_US.jpg","d":"Jurnal @Artikulasi Pendidikan Bahasa dan Sastra Indonesia (p-ISSN: 1412-4548 e-ISSN: 2776-5911) adalah jurnal berkala ilmiah yang diterbitkan Progran Studi Pendidikan Bahasa dan Sastra Indonesia, Fakultas Pendidikan Bahasa dan Sastra Indonesia, Universitas Pendidikan Indonesia. Jurnal ini terbit pertama kali pada Mei…"},
  {"t":"RITME","cover":"https://ejournal.upi.edu/public/journals/87/journalThumbnail_en_US.jpg","d":"Jurnal Ritme (Seni dan Desain serta Pengajarannya)diterbitkan oleh Fakultas Pendidikan Seni dan Desain Universitas Pendidikan Indonesia dua kali dalam setahun, bulan Februari dan Agustus. Ruang lingkup topik artikel meliputi pembelajaran seni dan desain, inovasi pembelajaran seni, model pembelajaran seni, strategi…"},
  {"t":"Ringkang : Kajian Seni Tari dan Pendidikan Seni Tari","cover":"https://ejournal.upi.edu/public/journals/60/journalThumbnail_en_US.png","d":"RINGKANG: Jurnal Kajian Tari dan Pendidikan Seni Tari [e-ISSN: 2776-4778 | p-ISSN: 2797-9105] adalah jurnal kajian tari dan pendidikan tari yang diterbitkan oleh Program Studi Pendidikan Tari, FPSD UPI, untuk menyebarluaskan hasil penelitian di bidang kajian tari dan pendidikan tari.Ruang lingkup penelitian dalam…"},
  {"t":"SIGMA DIDAKTIKA: Jurnal Pendidikan Matematika","cover":"https://ejournal.upi.edu/public/journals/176/journalThumbnail_en_US.jpg","d":""},
  {"t":"Journal of Finance, Entrepreneurship, and Accounting Education Research","cover":"https://ejournal.upi.edu/public/journals/245/journalThumbnail_en_US.png","d":"Journal of Finance, Entrepreneurship, and Accounting Education Research is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia, which is a dissemination medium for research result from economics and business. Fineteach is a triannual journal issued on April, August, and December.…"},
  {"t":"Indonesian Journal of Teaching in Science","cover":"https://ejournal.upi.edu/public/journals/219/journalThumbnail_en_US.png","d":"The Indonesian Journal of Teaching in Science (IJoTis) (ISSN: e. 2776-6101 p. 2776-6152) is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia, which is a dissemination medium for research result from scientists, engineers, and educators in many fields of education. IJoTis is a…"},
  {"t":"Logat","cover":"https://ejournal.upi.edu/public/journals/146/journalThumbnail_en_US.jpg","d":"Indonesian Journal of Arabic Educationa and Literature"},
  {"t":"Psikoeduko: Jurnal Psikologi Edukasi dan Konseling","cover":"https://ejournal.upi.edu/public/journals/222/journalThumbnail_en_US.jpg","d":"Online ISSN: 2776-0804Psikoeduko has achieved accreditation at the SINTA 5 level, as recognized by the national indexing system.The purpose of Psikoeduko is to publish works oriented towards new trends and innovations in practice and understanding of comprehensive guidance and counseling. Psikoeduko : Jurnal Psikologi…"},
  {"t":"WaPFi (Wahana Pendidikan Fisika)","cover":"https://ejournal.upi.edu/public/journals/149/journalThumbnail_en_US.png","d":"Dear Authors, We would like to inform you that starting from Volume 11 Issue 1, 2026, this journal will migrate to a new website. Therefore, registration and new article submissions should be conducted through the backup site below: Meanwhile, all manuscripts submitted up to the year 2025 will continue to be processed…"},
  {"t":"OPTIMA: Journal Of Guidance and Counseling","cover":"https://ejournal.upi.edu/public/journals/194/journalThumbnail_en_US.jpg","d":"Welcome to OPTIMA: Journal of Guidance and Counseling [ISSN e.2776-6683 p.2776-6624]OPTIMA: Journal of Guidance and Counseling is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia. These free to view online journals cover disciplines of educational, guidance and counseling field.…"},
  {"t":"Journal of Education and Human Resources","cover":"https://ejournal.upi.edu/public/journals/212/journalThumbnail_en_US.jpg","d":"The International Journal of Education and Human Resources (JEHR) is an open access and peer-reviewed journal, published by Universitas Pendidikan Indonesia, which is a dissemination medium for research result from scientists in fields of education and human resources. JEHR is a biannual journal issued on February and…"},
  {"t":"Irama: Jurnal Seni, Desain dan Pembelajarannya","cover":"https://ejournal.upi.edu/public/journals/200/journalThumbnail_en_US.png","d":"Irama: Jurnal Seni, Desain dan Pembelajarannya, publishes papers regularly twice times a year, issued by the Faculty of Art and Design Education, Universitas Pendidikan Indonesia, Bandung, Indonesia. Irama: Jurnal Seni, Desain dan Pembelajarannya, provides open access to the public to read abstract and complete…"},
  {"t":"Jurnal Guru Komputer","cover":"https://ejournal.upi.edu/public/journals/229/journalThumbnail_en_US.jpg","d":"Jurnal Guru Komputer (JGrKom) (e-ISSN: 2774-7891) is an open-access and peer-reviewed journal, published by the Universitas Pendidikan Indonesia, which is a medium for disseminating research results from scientists and educational practitioners in various fields of pedagogy and technology learning.JGrKom publishes…"},
  {"t":"Indonesian Journal of Functional Linguistics","cover":"https://ejournal.upi.edu/public/journals/227/journalThumbnail_en_US.jpg","d":"The Indonesian Journal of Functional Linguistics is an peer-reviewed journal managed collaboratively by the Indonesian Association of Systemic Functional Linguistics (ALSFI) and English Language and Literature Study Program Universitas Pendidikan Indonesia. This journal explores the appliability of Systemic Functional…"},
  {"t":"Jurnal Pendidikan Ekonomi Indonesia","cover":"","d":"Jurnal Pendidikan Ekonomi Indonesia (JPEI), with ISSN 2987-4904 (Print) and ISSN 2721-1401 (Online), is published by the Economic Education Study Programme, Faculty of Economics and Business Education, Universitas Pendidikan Indonesia, in collaboration with ASPROPENDO (The Indonesian Association of Economic Education…"},
  {"t":"Etsa: Jurnal Pendidikan dan Inovasi Seni Rupa","cover":"","d":"GRADASI: Journal of Fine arts and Learning, publishes papers regularly twice a year, issued by the Department of Fine Arts Education, Faculty of Arts and Design Education, Universitas Pendidkan Indonesia, Bandung, Indonesia. GRADASI: Journal of Fine arts and Learning, provides open access to the public to read…"},
  {"t":"Indonesian Journal of Engineering, Technical and Vocational Education","cover":"","d":""},
  {"t":"Indonesian Journal of Teaching in Social Science","cover":"","d":""},
  {"t":"Indonesian Journal of Entrepreneurial Economics","cover":"","d":""},
  {"t":"Indonesian Journal of Language Education","cover":"","d":""},
  {"t":"SWARA","cover":"","d":"SWARA – Antologi Pendidikan Musik adalah jurnal ilmiah yang diterbitkan oleh Program Studi Pendidikan Musik, Fakultas Pendidikan Seni dan Desain, Universitas Pendidikan Indonesia. Jurnal ini hadir sebagai wadah akademik untuk mengembangkan kajian-kajian ilmiah di bidang pendidikan musik, baik secara teoritis maupun…"},
  {"t":"Indonesian Review of Community Service","cover":"","d":""},
  {"t":"DALUANG: Jurnal Kajian Bahasa, Sastra dan Budaya Daerah serta Pengajarannya","cover":"","d":""},
  {"t":"Applied Geography Education Journal","cover":"","d":"Applied Geography Education Journal obtain study of education that related by geography and education"},
  {"t":"Journal of Indonesian for Speakers of Other Languages","cover":"","d":"Journal on Applied Linguistics"},
  {"t":"RITME: Jurnal seni, desain, dan pembelajarannya","cover":"","d":"Jurnal seni, desain, dan pembelajarannya"},
  {"t":"Journal on Mathematics Education Research (J-MER)","cover":"","d":"Journal on Mathematics Education Research (J-MER) publishes research articles in the field of mathematics education which include Algebra Education, Geometry Education, Statistics and Probability Education, Realistic Mathematics Education, Assessment in Mathematics Education, etc. Journal on Mathematics Education…"},
  {"t":"Progress in Electrical and Computer Engineering Education","cover":"","d":""},
  {"t":"ELT Tech: Journal of English Language Teaching and Technology","cover":"","d":""},
  {"t":"Jurnal Bahtera Sastra Indonesia","cover":"","d":""},
  {"t":"Bahtera Bahasa: Antologi Pendidikan Bahasa dan Sastra Indonesia","cover":"","d":"Antologi Pendidikan Bahasa dan Sastra Indonesia"}
];
/**
 * Menulis Cover URL + Scope ke Sheet1 dari _IMPOR_PROFIL_JURNAL_, dicocokkan
 * lewat nama jurnal ternormalisasi. Dijalankan manual sekali dari editor
 * Apps Script (bukan trigger) — lihat catatan migrasi di atas.
 */
/**
 * Normalisasi judul untuk pencocokan nama jurnal lintas-sumber: sama seperti
 * norm_(), ditambah tanda baca umum dihapus (bukan sekadar spasi dirapikan)
 * supaya "EduHumaniora : X" dan "EduHumaniora: X" dianggap sama. Dipakai
 * KHUSUS untuk pencocokan judul (imporCoverDanScope, sarankanKecocokanProfilJurnal),
 * tidak menggantikan norm_() di tempat lain.
 */
function normJudul_(v) {
  return norm_(v).replace(/[.,:;\-–—()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Judul generik OJS (sub-bagian halaman jurnal, bukan judul jurnal sungguhan) — jangan pernah disarankan sebagai jurnal. */
var ARTEFAK_JUDUL_ = {
  'JOURNAL DESCRIPTION': 1, 'AIMS AND SCOPES': 1, 'AIMS AND SCOPE': 1,
  'CONTACT INFORMATION': 1, 'EDITORIAL TEAM': 1, 'FOCUS AND SCOPE': 1,
  'PUBLICATION ETHICS': 1, 'AUTHOR GUIDELINES': 1, 'PEER REVIEW PROCESS': 1,
  'JOURNAL HISTORY': 1, 'ONLINE SUBMISSIONS': 1, 'PRIVACY STATEMENT': 1
};
function judulArtefak_(judul) {
  var n = normJudul_(judul);
  if (ARTEFAK_JUDUL_[n]) return true;
  return /^ABOUT /.test(n);
}

/** Skor kemiripan sederhana berbasis irisan kata (Jaccard atas token >2 huruf). 0..1. */
function tokenJudul_(v) {
  return normJudul_(v).split(' ').filter(function (w) { return w.length > 2; });
}
function skorKemiripanJudul_(a, b) {
  var ta = tokenJudul_(a), tb = tokenJudul_(b);
  if (!ta.length || !tb.length) return 0;
  var setB = {};
  tb.forEach(function (w) { setB[w] = true; });
  var overlap = 0;
  ta.forEach(function (w) { if (setB[w]) overlap++; });
  // Math.min, bukan Math.max: judul pendek ("SWARA") yang seluruh katanya
  // muncul di judul panjang Sheet1 ("SWARA - Jurnal Antologi...") harus
  // dianggap sangat mirip (rasio keterkandungan), bukan dihukum karena
  // judul Sheet1-nya jauh lebih panjang.
  return overlap / Math.min(ta.length, tb.length);
}

/**
 * TIDAK MENULIS APA PUN — cuma laporan untuk ditinjau manusia. Untuk tiap
 * entri hasil scrape ejournal.upi.edu yang judulnya tidak ketemu persis di
 * Sheet1 (lihat imporCoverDanScope), cari nama jurnal Sheet1 yang paling
 * mirip (irisan kata) dan laporkan skornya. Ini BUKAN pencocokan otomatis:
 * admin yang memutuskan apakah pasangannya benar, lalu bisa menyalin
 * cover/scope-nya manual atau menyesuaikan nama di salah satu sisi.
 */
function sarankanKecocokanProfilJurnal() {
  var sh = sheetWajib_(SHEET.MAIN);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2) return 'Sheet1 belum punya data jurnal.';

  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = buatHeaderMap_(header);
  var nilai = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  var namaSheet = [];
  var terpakaiJudul = {};
  for (var r = 0; r < nilai.length; r++) {
    var nama = ambil_(nilai[r], map, 'namaJurnal');
    if (!nama) continue;
    namaSheet.push(nama);
    terpakaiJudul[normJudul_(nama)] = true;
  }

  var diabaikan = [], usulan = [], tanpaKandidat = [];

  _IMPOR_PROFIL_JURNAL_.forEach(function (entri) {
    if (!entri.t) return;
    var key = normJudul_(entri.t);
    if (terpakaiJudul[key]) return; // sudah cocok persis, tidak perlu saran
    if (PENYESUAIAN_NAMA_PROFIL_JURNAL_[key]) return; // sudah dikonfirmasi manual sebelumnya
    if (judulArtefak_(entri.t)) { diabaikan.push(entri.t); return; }

    var terbaik = null, skorTerbaik = 0;
    namaSheet.forEach(function (nama) {
      var skor = skorKemiripanJudul_(entri.t, nama);
      if (skor > skorTerbaik) { skorTerbaik = skor; terbaik = nama; }
    });

    if (terbaik && skorTerbaik >= 0.4) {
      usulan.push('"' + entri.t + '" → mungkin "' + terbaik + '" (skor ' + skorTerbaik.toFixed(2) + ')');
    } else {
      tanpaKandidat.push(entri.t);
    }
  });

  var lap = 'Saran kecocokan profil jurnal (tidak ada yang ditulis ke sheet):\n\n' +
    'DIABAIKAN (bukan judul jurnal, sub-bagian halaman OJS) — ' + diabaikan.length + ':\n' +
    (diabaikan.join(' | ') || '(tidak ada)') +
    '\n\nUSULAN PASANGAN (perlu ditinjau manual) — ' + usulan.length + ':\n' +
    (usulan.join('\n') || '(tidak ada)') +
    '\n\nTANPA KANDIDAT MIRIP (kemungkinan jurnal ini belum ada di Sheet1) — ' + tanpaKandidat.length + ':\n' +
    (tanpaKandidat.join(' | ') || '(tidak ada)');

  console.log(lap);
  return lap;
}

/**
 * Pasangan judul-hasil-scrape -> nama jurnal Sheet1 yang SUDAH DITINJAU DAN
 * DIKONFIRMASI MANUSIA (lewat sarankanKecocokanProfilJurnal, ditinjau oleh
 * admin DJPI). Bukan tebakan algoritma — ini yang membedakannya dari skor
 * kemiripan di sarankanKecocokanProfilJurnal. Kunci memakai normJudul_ pada
 * judul hasil scrape, nilai adalah namaJurnal PERSIS seperti di Sheet1.
 */
var PENYESUAIAN_NAMA_PROFIL_JURNAL_ = {};
[
  ['Indonesian Journal of Educational Research and Technology', 'Indonesian Journal of Educational Research and Technology (IJERT)'],
  ['Journal of Automotive Engineering Education', 'ATIKANOTO: Journal of Automotive Engineering Education'],
  ['Early Childhood Education & Parenting', 'Early Childhood Education and Parenting (ECEPA)'],
  ['Early Childhood Education and Parenting', 'Early Childhood Education and Parenting (ECEPA)'],
  ['Jurnal Riset dan Praktik Pendidikan Kimia', 'Jurnal Riset dan Praktik Pendidikan Kimia (JRPPK)'],
  ['Journal of Computer Engineering, Electronics and Information Technology', 'Journal of Computer Engineering, Electronics and Information Technology (COELITE)'],
  ['Jurnal Tata Kelola Pendidikan', 'Jurnal Tata Kelola Pendidikan (JTKP)'],
  ['Metodik Didaktik', 'Metodik Didaktik: Jurnal Pendidikan Ke-SD-an'],
  ['PEDADIDAKTIKA: Jurnal Ilmiah Mahasiswa Pendidikan Guru Sekolah Dasar', 'PEDADIDAKTIKA: Jurnal Ilmiah Pendidikan Guru Sekolah Dasar'],
  ['Jurnal Pendidikan Multimedia (Edsence)', 'Edsence: Jurnal Pendidikan Multimedia'],
  ['Jurnal Guru Komputer', 'Jurnal Guru Komputer (JgrKom)'],
  ['Indonesian Journal of Teaching in Social Science', 'Indonesian Journal of Teaching in Science'],
  ['Wahana Fisika', 'Wahana Fisika: Jurnal Fisika dan Terapannya'],
  ['Jurnal MANAJERIAL', 'Manajerial : Jurnal Manajemen dan Sistem Informasi'],
  ['KANAYAGAN - Journal of Music Education', 'KANAYAGAN - Jurnal Pengabdian Masyarakat Bidang Seni'],
  ['MIMBAR PENDIDIKAN', 'Mimbar Pendidikan: Jurnal Indonesia untuk Kajian Pendidikan'],
  ['Jurnal Pendidikan Akuntansi & Keuangan', 'Jurnal Pendidikan Akuntansi dan Keuangan'],
  ['Jurnal Pendidikan Perikanan Kelautan (Journal of Fisheries and Maritime Studies)', 'Jurnal Pendidikan Perikanan Kelautan'],
  ['ASEAN Journal of Science and Engineering Education', 'ASEAN Journal of Science and Engineering Education (AJSEE)'],
  ['Indonesian Journal of Language Education', 'Indonesian Journal of Primary Education']
].forEach(function (p) { PENYESUAIAN_NAMA_PROFIL_JURNAL_[normJudul_(p[0])] = p[1]; });

function imporCoverDanScope() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    var sibuk = 'Sistem sedang sibuk, impor cover/scope dilewati.';
    console.warn(sibuk);
    return sibuk;
  }

  try {
    var sh = sheetWajib_(SHEET.MAIN);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2) {
      var kosongSheet = 'Sheet1 belum punya data jurnal.';
      console.warn(kosongSheet);
      return kosongSheet;
    }

    var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var map = buatHeaderMap_(header);
    var kolomCover = pastikanKolomAda_(sh, header, 'Cover URL');
    var kolomScope = pastikanKolomAda_(sh, header, 'Scope');

    lastCol = sh.getLastColumn();
    var nilai = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    // Peta nama-ternormalisasi -> nomor baris sheet, dibangun sekali.
    // normJudul_ (bukan norm_) supaya beda spasi di sekitar tanda baca
    // ("EduHumaniora : X" vs "EduHumaniora: X") tetap ketemu.
    var petaBaris = {};
    for (var r = 0; r < nilai.length; r++) {
      var nama = ambil_(nilai[r], map, 'namaJurnal');
      if (!nama) continue;
      var key = normJudul_(nama);
      // Nama ganda (jarang, tapi ada) -> jangan pernah menebak baris mana yang benar.
      petaBaris[key] = (petaBaris[key] === undefined) ? (r + 2) : -1;
    }

    var tulisan = [];
    var cocok = 0, dilewatiSudahAda = 0, tidakCocok = [], namaGanda = [];

    _IMPOR_PROFIL_JURNAL_.forEach(function (entri) {
      if (!entri.t) return;
      var key = normJudul_(entri.t);
      var baris = petaBaris[key];

      // Cocok langsung gagal -> coba penyesuaian manual yang sudah dikonfirmasi
      // admin (lihat PENYESUAIAN_NAMA_PROFIL_JURNAL_), sebelum menyerah.
      if (baris === undefined && PENYESUAIAN_NAMA_PROFIL_JURNAL_[key]) {
        baris = petaBaris[normJudul_(PENYESUAIAN_NAMA_PROFIL_JURNAL_[key])];
      }

      if (baris === undefined) { tidakCocok.push(entri.t); return; }
      if (baris === -1) { namaGanda.push(entri.t); return; }

      var rowArr = nilai[baris - 2];
      var coverSekarang = str_(rowArr[kolomCover - 1]);
      var scopeSekarang = str_(rowArr[kolomScope - 1]);

      var adaPerubahan = false;
      if (entri.cover && !coverSekarang) {
        tulisan.push({ baris: baris, kolom: kolomCover, nilai: entri.cover });
        adaPerubahan = true;
      }
      if (entri.d && !scopeSekarang) {
        tulisan.push({ baris: baris, kolom: kolomScope, nilai: entri.d });
        adaPerubahan = true;
      }
      if (adaPerubahan) cocok++; else dilewatiSudahAda++;
    });

    tulisan.forEach(function (t) {
      sh.getRange(t.baris, t.kolom).setValue(t.nilai);
    });
    SpreadsheetApp.flush();

    bersihkanCacheJurnal_();

    var ringkas = 'Impor cover/scope dari ejournal.upi.edu selesai — ' + cocok +
      ' jurnal terisi (cover dan/atau scope), ' + dilewatiSudahAda +
      ' sudah terisi sebelumnya (dilewati), ' + tidakCocok.length +
      ' entri sumber tidak cocok ke nama jurnal manapun di Sheet1' +
      (namaGanda.length ? (', ' + namaGanda.length + ' dilewati karena nama jurnal ganda di Sheet1') : '') + '.';

    if (tidakCocok.length) {
      ringkas += '\nTidak cocok: ' + tidakCocok.join(' | ');
    }
    if (namaGanda.length) {
      ringkas += '\nNama ganda: ' + namaGanda.join(' | ');
    }

    catatAktivitas_('SISTEM', '-', 'IMPOR_COVER_SCOPE', ringkas);
    console.log(ringkas);
    return ringkas;
  } catch (err) {
    var pesan = 'imporCoverDanScope gagal: ' + err.message;
    console.error(pesan);
    return pesan;
  } finally {
    lock.releaseLock();
  }
}

/** Ambil ID file Drive dari link "https://drive.google.com/open?id=XXXX" (format hasil upload Google Form). */
function idFileDriveDariLink_(url) {
  var m = String(url || '').match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = String(url || '').match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

/** Cari indeks kolom dari nama header PERSIS (case-insensitive via norm_), untuk sheet non-Sheet1 yang tidak pakai FIELD_MAP. */
function kolomBerdasarkanHeader_(header, namaHeader) {
  var target = norm_(namaHeader);
  for (var i = 0; i < header.length; i++) {
    if (norm_(header[i]) === target) return i;
  }
  return -1;
}

/**
 * Impor Cover Jurnal + Aim & Scope dari sheet Profil_Jurnal — hasil Google
 * Form yang diisi LANGSUNG oleh pengelola jurnal (bukan hasil scrape).
 * Sumbernya dianggap lebih terpercaya daripada imporCoverDanScope():
 * - Cover-nya sudah berupa file Drive milik kita sendiri (bukan hotlink ke
 *   ejournal.upi.edu yang diblokir CORP oleh browser pengunjung).
 * - Teks scope dilaporkan sendiri oleh pengelola, bukan cuplikan hasil scrape.
 * Karena itu fungsi ini SENGAJA MENIMPA Cover URL/Scope yang sudah ada di
 * Sheet1 (pengecualian dari aturan "jangan pernah menimpa" — nilai lama dari
 * ejournal.upi.edu memang tidak pernah berfungsi untuk pengunjung, jadi tidak
 * ada yang hilang). Dijalankan manual dari editor Apps Script.
 *
 * CATATAN: fungsi ini TIDAK memanggil DriveApp untuk membaca/mengubah sharing
 * file cover. Domain Google Workspace UPI membatasi akses API terprogram
 * (DriveApp) ke file meski filenya sendiri sudah publik lewat browser biasa —
 * sudah diverifikasi manual bahwa link "Anyone with the link" pada folder
 * upload form benar-benar bisa diakses pengunjung anonim. URL thumbnail
 * dibangun langsung dari ID file yang diambil dari link, tanpa verifikasi API.
 */
function imporProfilJurnalDariForm() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    var sibuk = 'Sistem sedang sibuk, impor Profil_Jurnal dilewati.';
    console.warn(sibuk);
    return sibuk;
  }

  try {
    var shForm = sheetOpsional_('Profil_Jurnal');
    if (!shForm) return 'Sheet "Profil_Jurnal" tidak ditemukan.';

    var lastRowForm = shForm.getLastRow();
    if (lastRowForm < 2) return 'Sheet Profil_Jurnal belum punya data.';

    var nilaiForm = shForm.getRange(1, 1, lastRowForm, shForm.getLastColumn()).getValues();
    var headerForm = nilaiForm[0];
    var iNama = kolomBerdasarkanHeader_(headerForm, 'Nama Jurnal');
    var iCover = kolomBerdasarkanHeader_(headerForm, 'Cover Jurnal Resolusi Tinggi');
    var iScope = kolomBerdasarkanHeader_(headerForm, 'Aim & Scope Jurnal');
    if (iNama === -1 || iCover === -1 || iScope === -1) {
      return 'Header yang diharapkan (Nama Jurnal / Cover Jurnal Resolusi Tinggi / Aim & Scope Jurnal) tidak ditemukan di Profil_Jurnal.';
    }

    var sh = sheetWajib_(SHEET.MAIN);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2) return 'Sheet1 belum punya data jurnal.';

    var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var map = buatHeaderMap_(header);
    var kolomCover = pastikanKolomAda_(sh, header, 'Cover URL');
    var kolomScope = pastikanKolomAda_(sh, header, 'Scope');

    lastCol = sh.getLastColumn();
    var nilai = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    var petaBaris = {};
    for (var r = 0; r < nilai.length; r++) {
      var nama = ambil_(nilai[r], map, 'namaJurnal');
      if (!nama) continue;
      var key = normJudul_(nama);
      petaBaris[key] = (petaBaris[key] === undefined) ? (r + 2) : -1;
    }

    var tulisan = [];
    var cocok = 0, tidakCocok = [], namaGanda = [];

    // Baris terbawah = submission terbaru; biarkan yang belakangan menang
    // kalau ada pengelola yang submit ulang untuk jurnal yang sama.
    for (var f = 1; f < nilaiForm.length; f++) {
      var rowForm = nilaiForm[f];
      var namaForm = str_(rowForm[iNama]);
      if (!namaForm) continue;

      var keyForm = normJudul_(namaForm);
      var baris = petaBaris[keyForm];
      if (baris === undefined && PENYESUAIAN_NAMA_PROFIL_JURNAL_[keyForm]) {
        baris = petaBaris[normJudul_(PENYESUAIAN_NAMA_PROFIL_JURNAL_[keyForm])];
      }
      if (baris === undefined) { tidakCocok.push(namaForm); continue; }
      if (baris === -1) { namaGanda.push(namaForm); continue; }

      var coverLink = str_(rowForm[iCover]);
      var scopeText = str_(rowForm[iScope]);

      if (coverLink) {
        // TIDAK memanggil DriveApp sama sekali: domain Google Workspace UPI
        // membatasi akses API terprogram (DriveApp) walau filenya sendiri
        // sudah publik lewat browser ("Anyone with the link" sudah diverifikasi
        // manual). URL thumbnail dibangun langsung dari ID file di link form.
        var fileId = idFileDriveDariLink_(coverLink);
        if (fileId) {
          tulisan.push({ baris: baris, kolom: kolomCover, nilai: 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w400' });
        }
      }
      if (scopeText) {
        tulisan.push({ baris: baris, kolom: kolomScope, nilai: scopeText });
      }
      if (coverLink || scopeText) cocok++;
    }

    tulisan.forEach(function (t) {
      sh.getRange(t.baris, t.kolom).setValue(t.nilai);
    });
    SpreadsheetApp.flush();

    bersihkanCacheJurnal_();

    var ringkas = 'Impor Profil_Jurnal (Google Form) selesai — ' + cocok + ' jurnal terisi/diperbarui, ' +
      tidakCocok.length + ' entri tidak cocok ke Sheet1' +
      (namaGanda.length ? (', ' + namaGanda.length + ' dilewati karena nama jurnal ganda di Sheet1') : '') + '.';
    if (tidakCocok.length) ringkas += '\nTidak cocok: ' + tidakCocok.join(' | ');
    if (namaGanda.length) ringkas += '\nNama ganda: ' + namaGanda.join(' | ');

    catatAktivitas_('SISTEM', '-', 'IMPOR_PROFIL_JURNAL_FORM', ringkas);
    console.log(ringkas);
    return ringkas;
  } catch (err) {
    var pesan = 'imporProfilJurnalDariForm gagal: ' + err.message;
    console.error(pesan);
    return pesan;
  } finally {
    lock.releaseLock();
  }
}


/**
 * PILOT: 5 cover jurnal di-hosting sebagai data URI base64 langsung di sel
 * Cover URL (bukan link eksternal sama sekali) — percobaan untuk menutup sisa
 * jurnal yang cover-nya masih hotlink ke ejournal.upi.edu (diblokir CORP oleh
 * browser pengunjung) dan tidak punya submission Profil_Jurnal.
 *
 * Sumber gambar: screenshot elemen <img> yang di-render inline di halaman
 * ejournal.upi.edu (same-origin, jadi tidak kena Cloudflare/CORP), diperkecil
 * ke ~96x137px lewat CSS lalu di-capture sebagai PNG. BUKAN hasil canvas
 * resize+download-blob seperti percobaan sebelumnya — teknik itu terbukti
 * tidak konsisten di lingkungan ini (anchor+blob download kadang malah
 * menavigasi tab, kadang diam saja tanpa file tersimpan). Screenshot-to-disk
 * terbukti jauh lebih andal.
 *
 * TIDAK PERNAH menimpa Cover URL yang sudah berupa link Drive (dari
 * imporProfilJurnalDariForm) atau yang sudah data:image — hanya mengisi sel
 * yang masih kosong atau masih hotlink ejournal.upi.edu yang rusak.
 * Dijalankan manual dari editor Apps Script.
 */
var _PILOT_COVER_BASE64_ = [
  {"t":"Indonesian Journal of Applied Linguistics","b64":"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"},
  {"t":"International Journal of Education","b64":"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"},
  {"t":"Jurnal Pendidikan Keperawatan Indonesia","b64":"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"},
  {"t":"Indonesian Journal of Science and Technology","b64":"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"},
  {"t":"ASEAN Journal of Science and Engineering","b64":"iVBORw0KGgoAAAANSUhEUgAAAGAAAACJCAIAAABcsaolAAAQAElEQVR4nOy9B5Rcx3kmeuuGvp2n00xPRAYGOREACVAUSIBRlEibpi1voBWsQFl6OrK5kldr+Vlar46SLWl9bPkp06RIURItikEgKYIJDMiRCIMwwOSZnp7pnG96X1Xd7mkAA6KHBO31HhYaPd23b6qv/vz/VVe2LOulHScWd8+WFVOwiCCIeLMEk1iicEEjJvsjEvYHB57/KxEu3SzLIAKx6vYyTX64xT6zLfRnw2KXt+yzm/R3i19LZB/oXhZrtTvgX0wLO9PdLPtnwTSM6t72Ifhg0pfR2hyc3Rn+5JveM28y/r/6+v6DB3tuf/97mpoUwVQJAUb6hf3nXcGVBB1dFaburP53Ikz9wH4hF57CEqwqQOg97bDA+oZ/+AmjAoDY0fS7SVFEtxlq7AJ0M91uWFP9toEyKUgmvyyQoU1g7ya+0H3oBooOPuh+jyoIYaGBRgHSTXPX7lOaTu78/asDPsmyZIJxEKxLHEIYUnbXyRQGHCB+t4SQ8w7nHRbOOydh3cN+hL0zLAT2zQaYsNPgJ5FeDx8ZoRG6WWTEwncRrOrZQdyE0yOlcnqsiD3xEhnlMdoS8TM/Q2ONAmQSUta1Pft6coXkxz72h6qi08uxU9AeVOmQ2AhcgNwU4TD6sOzO129k/bOmwGLDzgmIsN/ozpJoCgYx7INEgf3O+knPJNrA07vgW6ypWwHhkSm2pPfAADJNCo1IkRIovVJ6BEL0kmIDzMUbQ8FULLFYNkqHDg/97f/8fqFkmsS8mMX4kPMbn9rEgLB3vojqbJbiXavuX4UQI2nYZzMNydJBupIlSRaRLBHvogl+49jRY+1xIgwzRkYi+0cb/ZGIkoAX+8ES6YttxXaRviRJlCRZFEW2RRRmBBCxDMGSKdCSEJsofvvvHxweTDJuv6i/QhUJCGwqs017JAnf2SJ1e1ZxtITpuRVsIqFT+CNLhirrDqkkVhJ6fryUHsxN9pXSw0ZhzNSyjIopk1aRsOwXYfgRigX6LQkSfRFRJrJEZJlI+IPvhMMJqSHietgCqBrlL4EDJAiaYCkCJUYNXR0YSj7w0FMnTvaBW+mla7Awnq+Di1Q30htltH8xLueJasaBtcNwOQkfJGKKllYpZ0ultGUVFKksiyXRyhVyo+Njp8cGThaToyLEgKiIVRri5IOG7kt4Z419E4lNWFT00H1AVYTtRl/sM8CjO8+Eghg0lNoJY1Bw7rnB+M9/uX3P3uPsd12wISJMeFOpyYQEJ357NIgtXYllbydMYbPPFxAWo4Pq5U1JMBVRAFSpRCIeG4/H4j3HevSyPhkbN8ploZLJxHslEUSuUMlCmUi02YaSDRDgjCZwQWe/OHPy/ThwFBybvxijNUpEtiS+aDuJxbIPP7L9sSdfMCAQKIRcFOIlsXfCuGzqQJs0yIX8VH/yesbHCSXLUETTIVlauWAaeiYDbpLLZXNwKCZJ6rm+4YH+UV03S6V8Lp8Cv9inYJhUW6239peqzOK0JHAlRjmLHiUwKVQDtKEmX+oH6MOCZmx7+kgyVfngH2xxO5mcYdYaV3AMNFOoR+g8fKherpPdhH0XLsAPe+iWZliG2+1tbetyuNy4f9Xb5A+FWzvnwIQhkpKcGBGGBuYt6SB0XDh/EWZnkgtsRvYjp2WL40c1Fx83W8tzpWE2jpAs1CRM/X3bitQwLHHXruPlYun979vc2eGHDUpJh15EYvcn1QFC6ck6j0ymbuPCKxCBs6osS4rkdCgKjg6FI5VyRqtUgk0urZRevXIJGDCbTltGIdLaTIUxBAojEnCNxWxBwRZ71ODhBjd+wnaR6kimdUTbPmCGIr0/iepPcWYATaOf6ZUlpolLhintP3A6lc7fesuGlcuXEqHC9BcUn1RPMfySdXajbXkzBTSFy5QVTrnUYuNLdL2MDtNG6VKkZClJpUrF0CroutfnkwEkVLUgU+JhRh8nkCnCse+BYyQyo1ywTX1imyeEmwfgbnEGWkye6kw9OlSgUAiI6TKJBnY7dXYk8fDTI5sTW7dco8hcwU+J5zqMSf1JmOlk8xYXUlOqD1YhGwSQqSKKpXL+XO8ZbPG63cMjQ+2tbcVCvlgs+nwBQpRsNusL0m4Z1CmBh8WEEKcTLuY4WpYNExXn1GXhrpwNI4hLsO1acpETdMnGtRRXK2L1eG6OUVvUEnX2G9UEybT+5LZdDz78TCpv0CsTDTcIY45ZRJznuUN7ET9RIwUi2YLkgL8gVjUdOhEfH9XKxVQiDjX12ssv9Z0b1jSSzZRUp0/Thdh4IptNjo0OnHzj4NC5N0xBo64VUSRRUWAjQEIJlAQN3CfOS1mnKhuq+pVrNJHZSBQf2bQk02G4FXkmrsZ0Wkw4H2OOl6Ebxq7dBxLJ+B//0e3tbQFqkVJzxrBsgiJMcp9nGRImHBiGugiqNAz0RcZWQ7MsLeJz4l11e1xe37wlq9pbIsFQYD5ZAMkkK0o4HGpqCqWSWZ9TJVopOdonKQ76AhXJDkEGdTtESSGmBmllcPFMbMuMRyZEi9T1D1+opZ7L9MPd7GjbIDTQKGH+5Zfv7zk+YNKRZpKFomFOR4QGYxMZwxYMuO+44/oVK+Z5PS7uN4qc1S1BuMBNhcgUBb04USjkJcYUbo8bO2VSKcPQ/X6fpCi6Yeo6RV8vl3R8MjRD16l/zgIWmlYp5bOFbFbXKy2tUdmhTqTiuBdV9Tn90XB0rih7qLNqR2OEqlSuqrYaPOxDOj782o5fLr9q1e23/Umj4Y6GmwwqYOaPnEyVH/75Uxt6l269/ur2jlYakbDtNIHz+BRRilQW6IVSJV+ONDdLsioqKkx02WU4wJ6SBEAECiLxKIrpdgET4KIbMO7NcqlUKRVgZ1uKrCsOh8sXbpvvcPs8/tZ8ItYPmRVPBQIR4oANAnFZrz4pupyTReb6M8dJ1CrFs737k4kBQV/bcJ9tIXcJh6m+QaTS4TDAU+AsTZd37z7V3zf2gTuuX7VqviVoBIRL/V6T2wncU+W2v9zkUygcVj4/gVsHuSnMbcKlVaeHxWgo2QigHE0DRpVKCZBho+LxqcGQkstIroyg68nYADQaPVqUw61dguJV3U0QcZR4mEa3zS0aWKJ4wasINPk1TctkIDgtScHRSqkAZvAIjTVGQdZlsWGN6JTDiCwwRxz3oGvS4HDmH//p57fctPHuu99n05cwZQ7aup8Ql7vF5QoZlRI0oEi1u4HuQ906nG4RTqUEgQta0fLpLEVIq4AkKxqIRtKLxUpFxwuXVBSv2+uBEpOkyUy6WBb05mgzUVRRkAE+BoZwxUohMlwusLITwwCxrldMWNLQLJLoiLbOcXuCuqULjTVZaIB0pgCiXCYzMWjQo0Q+Sr7t2w+fOTVy1+9vmTsvoqpqVTSbXPdjMJ1UjZEiERTVDVopFbPoilOGLhK1cjmTS8VH+lUJRhcdcwxYOp0ETMViQXUowUCwXCjl8kWquAXT6VTnLtnkF3PNrQ5RdcrQjqJB3U9LYRFWkKekKqrH64G9DW6FTpCotyFaVLoZY7HhYiVNSLHBTnMKamxfCg26rtsHMllOeNRLlM4Njf/4/l9v3LT22mu626JhyFVdy4MQFFmVZEdRl02ZOiqmVklNjBlmwaE4IHjLqhNSCaPv9IZ9Ho+YS5ksWkokR8AXkNJpt9crORyyIeRiMacTcMhnT/VrpjJr1ux0Kg25JEsTsgTdCBPfqTh9bZ2tiugChSKGA/szlZjwuNyVUrFSKAz2D0CoFbLjqkNWlUaFL6cgq2EqmgY2psKpA5DOVLY/t7un59x7r120eH7Io0iQJ7LPaVBKM2gMzDKKxXQ6nVq8fCVYpr+/Txe0JgfVgz6/HxynNjVT2jNN1R/CmDt8ISqI9IoH9rQ3AOjmdS8Ndsx5YduTzYGA2+2WTATIjWKukEolc9l0Jp+/464PCx4XHTu9/Pr2x3t6ehyqA2xrmEApny/kZadULBQNfUauhlXzNGfa+CHUVDRZfEc3xXPnErHhA93zfR+4fU045FUcTklSTAm2HEjI9ESiiyLtqieYz6UWLey2tJJeKZRKWi6XS0EAFRIVaC6tjNuB4w1uhVKXVbcMtlo4l4bARCniD27ccqsCKEEJioJNOT3+yp4XO1v9CrXxiU4ZXyVWZjLRX6okDx07CxfG5/UCMlmG8WSV4T4ZjfZQ5t2sutpvoXGf3mDiGQpMFGW9YBQO9OR7h1+4665rNqxxO4kqEogbYogK+IUadeWclkvEJiAQBvp6TyUSCYsGK2QX+iyLLD4PDWaU4CVrGqS2QxRbm6OhSHMgGvUEgq0tYUVRMKjILiD44nO7V6xc4VDI4Nnegf4TvpZoJNC+77Xnz549k84WkJJQVBeC7i3BACwH1SVo5YppNtq9N7GkZ9SI7SDC1IRcQlhZElIF/Sc/3XFo38BNN66ZPzvq8dDYBnUH9NLYwOlMYhwtl8svWtzt9fqptQJ2IjLhPEadEuZHGZoJYZbPDg0NxidjsItc4+Mdi9eqCoFWwouKZKdn8eIlhWx6pL/v0Ud+7HS7V69cP9R/ZmIsg98VQYGO9PqclVLWhAjUFEM3iTgjFhOEtyaDeHCFeT8yqWp3i+co6BDB8DAOHT976lzs6g0Lr7ume8GcKJR7uajnS6VcLl0uF/2hUHP7bFF28CgWDdgz4qHpK/aBig+94lXUWbIjORGHva24VDj8zKUHhDIdENCn6nJZxJBIOptJJlITE7/NFgRYCC6n0zAJrliuFKAeEVdRZeoGwnRvsI9vi4KIbV/yEBXfUhc4I3aWplAs7thx/Pix02tXz3//+653wclq7hB0I1c0ox2zmyJtNFullw0jZ2oa7EUC18PUmLUpKwDPKRGXEwgQhwuD7/H4ZclB8cMXXaJMJtJkF3JVDtWdSBcdqmpkSkBAknGmCvVjgYhmEh1fDdkrsXhfo0JIrvVVeMsoXfi3Ghut/aGudjE2of3u+eMvvXT4j+7ect2mpR0L/B0LuouF7MTo8ERs6MyJo3pRL5KiS3WDbOCBwSNDtzVd8vsDi7oXIVgdDkF3hZ0OB0I+sJL27Nk9e/bsWXPmEkFlAVzR6/ILlprNwhY3IcpUjwTyM5iTKcoitF4hX8jlNLcLvrzSWO9m5ou9xcZkCU0rYZDhzD/4yO9eee2NW7cs6Wxtgv2cScS8Lp+qeoNNktsXaom2g4zKlaKsWKZmxMbHC8VCtDmye+frueZsOpBqb28PtM4C8KFgQCuX4iNDcDUcDqemld2qAsfWoMa8iDgu2I+Gz2AIIGJQ0VPlDEJCcIahJCxrZiHXty+k36wx5xXyBRLTYG63enYw+YP7X+peENmwbl5nS7NLlZvbOz1uiBHi9Hmd6HC5gp7B9i3pglLMOVzetvaucCRSLpVTqYwzWIIZCBsxNjI8KUmIE/h83lKloGuVaHNgODbJ0qnAAcQj4p1lhmQECwTKhhBgmiTNzA6qZbLeoQY7UqdMxebHFgAAEABJREFUAFdWYEE1+NWCdKQ32Tt4eOHstrWr56xduxHy1DJVFmenGhG2MejNF44gZ4Yg+7zuZWA9jw/ilYbGIJhhJYF38F4qFdF/QtOQSrGo0QQtvRZNh9IINYiWJuyp68dsdDPaEnbT4oWGWp0v9tZMxYYaRLXtwRF+JUuSWQQBRuEbvQNnhuIv7z25dev6TeuX6JW0aJQJDTtbsL4VSUWWtFIq+wOhUqEAATQ0OHC2t3fevLkB+Gilisvl9PoDEMzeQglyO9A0lEiXaU4K6RJTaG5uQYwulUwSVuEAWe+B6epwwLpq8NbfKovVIvJMDpPzovX2DnbUnH+zWKzMrn8QTR6xEU0WtSbFYnnwbPz+009ve+z533v/DcuXdFl6kaWKIYxLquKoFMs0wIJWKnV3L+ob6nth+/bVa9ZG21qhuFmuXYBHkk2n3B4H/F+I5EjA/6cf/sQLz7/Q03NMBiFJNNWDnRGE6O8byudm5KzSZtJQIe0njWNYVT1t2zYwA6nVYSB7B0nhcjqQqYG/53I5XC7ZA/XgcamqQ2LJS1pZhEA/7UulWIB7WCqX9VKZ9g4RDHjUFQ0mMhoiuEzhspykzthiJCn88/2/7epoCvsrspG+bv2G13e//p4t7w0HI5Al8O4TE7FKKd3WNdfnbaIqKZP3eEg6k2VEgRibhVuBbEIPEPH//g+/V6lUwKcImzhoYFzOF7K5AgxHD2TSTAAyHWyMNfZVslhhAo09WSxNKBhuF2lvj3S1gWDD0ZZgOOzDKxTygWIlsZYaM6u63bTJybKTB5DMxUo5ny9lskXEcXL5cjqdS2dy2WwumcwlU4V0qpRIZBH0oRFtURwayY4MS36v3zg8CP8sn9ErWiIUCYTbmnWrPB6Ph0JRgTr91kR6ErmhfXt2+71ejEioOYIAPuwfWEimgSBIiVn3klGhI+eQhWirLxiUMKL4MAOAaIaHpkx5usGkRR4mXBx4dNqc2dEN65csWTKrORKIhFQPwsmUWUgVAp5b5QajJNQS7uengBCK9qour9MVDTeZNqOBzGSo81yO4pUvlBHugQXcNzAxNBwbhFMxmZ/MWonjk4rsfHLH8UjAeevWDUsWLnCI7q7OheVy2kDwuljOTCSC/iZfwI9cLJIzCJhoBU00KLkbEuIrNFAO30bglWlFzaMqbS1hpwvW+EyENE9y0aSjoAMXeAPQyfPntv/hBzcvWdLmhmAUVRuO8zrOJIm9SRTOS6JeKO15joySh10uwYBTRGdQiYT4Bprx0gwQBEwYI51JHz3ae+zo6PETo32D8ZGYNjDy6sZ1QyuXNIc9Xktw5Ky84lNb1HYoqmWLVrM6KdBNOZvPQipT+xoiTiqzwZKRRhFpwAHxTOJ1+iUkRPC/cYAMi0GD/BLLirRGXb/3e9df957ViOZhI810QmOaknAh23JKuTDBRC6ZQyLnfa3tVk16stodF79KwKPObo3efiMd/fhk+uDBU8d7+g+/MbR7b//8RdGVC1tEiwZqFVHZ+fqr8Gbnze4Eu0fbO4LBIOgISUeJ6JrpZrFEqhXCYc/8hfMCQYdgInwLDTczIW1ntXxuecO6JXf//hbkvASa+YQtIbEUM4YbMVbpgjKW6duFCPF8JD+EkAtdk7q0dB12CJMy/YYgtxiJNN1843q8IOMHB2Onz4ycONUvC2W3Aucqa+max+1QnIrb5+05eghcvHZxZxYB7kollxNcqhEKqKV82aF4J0dyibg0MZnLZAv+QG7VOqFRgKijZ5K2lsCdd1xz09b1DpnftkLZQuTJUlocwXR0NXFmVXmKddBkhUNV13UaGuKFmCIvmrEPk2w86tjWqpX5SDYXMvVp8qISxM7mL2hfsKD1plvXJBO54YHxTDITjs5OJUZSiUk9Xy7mKmZEDbW0F0YH3S7R64G01pLJPLJtCKspqpQcT6QzOkResVgSGmtMSFtSS8T9X/7TTddcs8jBpbadOxSr917LsBl2RUc1xUtqvbQYnOfVQtcDJNjZeaoRbOVuN1LbwU5K1BiyZmUJ5xEYZZpIKNAcCuCaEPOlXCmbTY0NnTVPHIM29Pncg/3jyUzS53GHQuFstgi/Pxh0hUMhWNUBvyNXKAeaZqLFVFF+/x9uvvY9iyS7bkyYutvz7o2X6QrndY1wVUZr3HiV7rRJb5orEznR0ZyaKBh1Wq/+Gg21up0tn8/l9brCbcGuRXOvuf56s1wc6D3V1jUrEY97/R4Dmf9CAZIIiVnk0oIu93A87lJdkVBTg9eiAN1y0/qtW1aIVE5zsjcFS6y7kaqnRtnKYdmKvXaHFDjJtqUJmWK0+qtY9i/UrqalhgYt+rKmzixUCw4aroybOnU1vyzTsA8RXe65y1bPW7oml82NDpweHhpM5YbD/iavJ1Aq5FWXVqFDJSGa3eD5KUA33riSqTCF97ZKJhZnqEyyEhtLstS76G9yRdpcrBsWJx6EoAZpao+i16SIbU56YWjss2fPDg4OFotwI6VIc2T+ooVebxPsK0Aj9J80ymlTkK0qL9KsMDtK6V7bSGkTTSvb/FcVhBaPYhKOM755mnwLl69ZuGxVqZCbiMfymfRQf//kRDxfNoaGB7sWTgqNNQqQSDSBB5Bs3udl9joNDmvyvp0nX3nxAAxRIuhdc1s/9ImbBVtyU1LJ68Zve9NDRVUnxsaw/AcLlEq5+O1vf/vVV1+NT0zA0UCkAZm/1StWf/Tejy9dugCZ69QzP5T6jluCYlYFM68MhQ8S/tZTjQBk1xtVyc2qVQPw2lJ7dKnnDtRUT1Onx4cxmLVw8ejw8PjomPvkCdk1o9TzFO2AEpgFRS9CIUMC5sjB0+MjeWJWYJRWSmPxWKK5LVS1LUnFEsfL5nAur0tC0ufEGP7tV//Xzx54EE6QUB3qWGys53TP2Pjwd7/5nWB7lxSLGyODrEyQFxAy9sKuZc3ucF15//TNsuDLIW1ds65oNU0hozhcCCUxYUc9DrFaHUDDYwiMuL2zF3R3zetetf7qxoVeXciVou+oWckWK++HhDvbM4ysLtXPBF8NpJib24Ks8LxAiBtxGShh5E0VauDLZ0+fevq32xg64sqVKz/wgQ+cPt37r//6KETOK7t2HT9zcnNXB3XiiaBJxOkOiV1LCBLOtCBMUwtu+17IBQJMpxlpOoIwkoXSUN/4d79hqdHZ3/iKYOlmJQ/JWHaI+kiy/y/u8t52W+hPPin5nAKLwyKsRNNSNCVny1caNHK5hIbbpUKuLLkukEP7TyNy4vEokB6lEvIEhXNnRjdcu0xShKqJULWHGOcPDQ8hj8UI3mxvb1uzZs0tt9yyePHClmh003s2RSMttQu4EFRfeFXTJ/5f03KKNKmtI1Y8bXKOWDKtAkGcIFOYfObXsX/6ZzjuC++7j0bii72V3X/k9G1Wr/q2c05XORiu/PD7+R37Wz/337xXLREUL86M6IRkTd3hTLXA9AAxjUQF756dPaLoaO9sdnnE44eGQLGjw5nJeKal3VM7tl6jtbS2yrLC7aRnn31m//79c+fOnTN3DlKgCC0LVk38CxVJVweO5X7+bV1AKAI5ep/8x58lZLqxpTF/y8qX4r/6afJfHpXyCUtxOVeuEUxFEJ1S5EbDM1cEBcuCf/myyePHtNNHhv/ub9rv+x++q6+FVybZoRsyjVvUQLvEIaxmLDVJ6QWOS1tnYN013RZTauMjmRjCNnYVqSBY5xXPzJ8//33vex8NzbBf4vHx3Xt2/eKRR772ta998YtfHB4ets9OxQLR42PZHb/SXvxl8cVH8zufFvVpKd9gVSJiYt+L4w/9SMunyoJbFpTSyJiey8nqbLH7r5RZHyFixTx3Ri6ZokErRopnh4a/+3dmYlDS6TQrnU0CEN9SSPnSmFri/t19xHQoCJK5nNHWiMhKRzPp/MhAkubdLLt2td7nkGX5S1/663/4h3/saO9EgB0RE4nWf5JCofDiiy8+8sgjtdPLrA5URCJd14hBk1eaPE0+mF4DkQvTin39G1IaniGSFfAccr1/+Re9n723cu6srPiIoU7+8tETH/3Q2LanIHSIqeKAwtnjQ//8w4pcsqu3TVaJIswYpOlZzKJTI0uH9p+gxTq6vO3xvU89vhNBRDAOgjsnjw9sumGBF9Y6wnxcvVq2a4AgWDadueqqq370ox8DF6Sunnvud1D5AiuPP3DgQO0KNAS6/pamz3xd4HcvIigqXjxeCDpCPld+9oAx0i+QkCUi0qjpokvUK6WDO5MPPeSIRNTbbh78yT9b+XGH7tWlMpuCY8q6I/Gvv4nc+yFHeIFCTX25DMFnzpjNLiGDLGRUtNhIgUY5QEUOidkUuqU7LanS1zeaT5djogt6vy+rpysmUpgSLagwQCM/f+jnZ8/2hcLBL/73/77h6g2r16zes2ePVkayQXR7nQarxweeGpEdmZh5bCe2OAyaiDGskrJs8wUqDNYkrjL460cqSBsbGhQlgdNKy6WR/nemTr7hb77WM540huOIN0NfyaZTEy2GOPYp5x592n3v/0OzPzSibDU+TewyAKGdPN6v6QVLlBd0R9ZvXEyTw8R87Af7Eeks57TTx8Z3zxfjCYT2pLRmumii193qlYWOWePxccOsxMdjf/u//mdHe0dF04owF0WIU+dtt9wsQuWCZWgA2jD7jhd+8jcV5qIgTWOWy8F/eNkeoVrxvCDkJ4fyZ8acdAaPSQ0CLrNZCbSplRxIfVQ0EVkiJHRwdlOUaXELq5M0xfzufcInTe4eK0IFedeZZm6mB8gwzLNnRsoVXZFcV12z9Nobui1JrxBr9zNnBoc0iLv9+4+WZ4VHSjpGVZTkguhpcZbXhwKhG24e/ezn/seXvqg61EQikUwmucUrOoSP3PPhG268VaAmFuxJFcxi6PlKsswrQ2Ab6bS48qJGjTxl7qfvrShFDcZZtixNpApDJ7WTfVqRBr10OKJCBYcbRlltaXV2LxJb212+kIREvmrI7gAUmcKEpcnmj820TQ9QJl12e5oWL+uEJ7V87SxLhpSkJambr+8+eBBWhWJZ+iKns6iUYpLUIjlXNMl3LvKHVMTqpE/c+6lbbrv1O9/5zs6dOycnJ5HyuHbTpns+dM+mDe+xZIxhWVo0V/aWJTbjkF2NTbnFcE9X1QRJ5Qh1OD78EWou0jgRm4cCpjTy+q43Ej95IPP4z7QXWgIf+pPOP/gv0qy2CuiI2j3I3oPxSyUnre2kXrYuaFTDAc+ZZdtJfVKsNjEmm8klJ5MOWt/lyOZyLrc/GAzHYgMu1S2qMpI3uLwDVljRLMqmV3JNpCciqq9AFIdZhCZDdyU6GZIqNaTp4FjTjDidWyjoikfR0oIia2UdNgpySBhazdBLlQq0jNfpxCFer7dunpB+cNeu2//4j5FjBKJIOYWbW5YsWb5m/ZpNV2+aNb9NfvoVdc3acZfj5Okzu1/aceDIgd7+05l0sqKVZMs5b9H8F19+nWyV04gAABAASURBVM6ms6pJuToWeyuF5LTISdd37nr92LFjxVJ+1ao1Rw6/0RJt2bp18y9+9agqOZubmzFCkwmkEyJGxUQaqino7Tl2fNW69UNDw0ZFR74PTnxbW1sul4NZhA4f2H8gl8n5gn70PxwKv3HiuN/TlMmlIfNnd81Clg0E1HeuL5XOLF66dPHixatXr66jILFr/jzIadkBX0cqG/ro6PBQ7Nxzv3sy0Bx4/+23/9ePf7rv2Kl/eeCHe/bu0WBV0LgwoFDoFCtLnNc2T+DocIQsMsPQ03QUBIDGxkZg62VziUiovUgLs8zmSGRsYkzLlGHEKi6HXkiDVzSf5FW8lDAquqe5NRkfBTnohmXohs/nA0yhUAheZTqdwjlBF7LqdCvywHAsnUz4/V7VibQAjAcZ/zPpLPaHtT1nzpxZs2ZNURCbz33HHTe+cfgwgUtokYpEFdQNm250N3nTiYmbP3D7ay+/aJZNp8d96szp4z0n6GReHh6win/z5a9/7GOfYjkVOnHZPN/V+GRjkYOZ2E5WXRSNFmxYZMpMvODDpY+kRQkGnzt6wU7A8cLtzCPftu3Jj330ww6HYhgWsnTX37Dl8d/8BkoAJvuHPvSh3zz+m1wmA1xWrloFE+zHP/4xLdenc6rVw0fe8Hl99uzDi9o7ANC/R+OT9e/8wPsPHzm0fv06r8f33HPbu2Z1bd68OdoSXbp0yYmeHsPQDx86dPDQQWRr77nnvz7zzLPwcv7ivi9+9rOf5VPspj3z/w0AVWe9Gvv37v3ud/4ePHj2bO+KFSvBsPv27oUP/J//8396fvvziF4GAwEIrzeOHo2Nj69duxZJ+q9/4+88Hu+lyEdoDCDpy1/+8nS3ZfX29uK8Dofj9OnTIGbIWojtgYEBcAFEEj4gRTc0NITtmUzG6UT8RSiVSjgKeh0bhcYaeO3cuXP4wM/AG8TWoUOHAoEAnbfCjF/EmqEcoi3Nr7322sqVK8bH4z09J5YtW6aq6tKly2KxmN/va/I34dcFCxcFgsAq8IUv/GWkOcqXWrjU1Z/6yleEy7XpaS8ej3/rW9/61a9+derUqVdeeaWnpwdu1J/+6Z/SaSku17Zt2z7zmc8Aju9973u/+93vdu/eDVkATEdGRr75zW9iMAEZHHdsnJiYgJuKDkCj4Zz4PDY2lk6n8QGgAxps/9nPfnbkyBF+XewJ2/K555576qmncB77blgHHQ51w9Ubv/mtv8vniz09J6+/fsuxYycOHjh07lzfwYOHjrxxdHwifstt79v+/As333TLf7vv852dXeJbsAsvatMPdX9/P2j45Zdfxih99atf/fM///Nrr722r6/v9ddfpxMAJAnUdPjwYfT54Ycf3rBhw9atW4EdAomjo6MnT55EkOyee+4BTCC0G2644cEHH1y3bt2+ffuw209/+tPbbrsNKGOfJ598EmSIo4AX8MV4PPDAA7giHF5g94UvfIHGXu15ovSPy+Ve3L3kB9//4aHDBz/2sY8Ba4UlJ3DpXDZ/5PBRGCVPPvHkqrVrZVF+C25XowCBg/L5fGtr6xNPPPGlL33pc5/7HAZZURQw1wc/+MFUKgUVjlAhuoduHzx48KWXXvqzP/szKGlkMoAdaA3aHfvgA1gAdEQdMafz3nvvjUajv/jFL5YvX47+g3NBSjgtZy50EvEQRNdwafBde3u7iwVG7cQ9a+yzqDjU9euu3rVr7wH4O0ePLly4sB3xqmBg3fp18xcs5NPG+do6whUHiM/SB+8AI4wkgspwxHEHH/nIR7q6ugAHqIN34KabbgIR3XzzzUuXLr3//vu5eTk+Pr5ixYrrrrsOLOnxeLAPKBF3jH1weGdnJ6gSchQwgRmBDlAGlYXD4aYmmsZDpA0UioEBauBNfkv1/SR2lpW+u9yea697L174vuXGmy7o1RWiHnaqCwxFbqSA5tFD8BQIAQQPUQ2xB37Br7h7dBVwQMrwcQZbcdMOAEG+YiPHBWIVMgVEBOLC2Thv4ihuPYKzIINx8ibWcCGcHGSFD7gcDgGmU7i8M23Gar7mi5G6lJ4w3S1OrTNV96H+/YKjLs7kXHAVe3mSiza+c+gIjQF0npyv3Q3G+fHHH4cqEaqGLwQKZASbg2PY62UwacXf+Qe2coJ9Hn4UZz2r2riawwcIpscee+y73/0uZ08+L4OfAXrtxIkTEHD8a+0kBluLghsZ/DbAhpDrEAj8V95AeqBKWp53hey7aYQ0Tr19+3aoW/QTIhkmCfgId4Nbh9YHF8Cf3Lt3b3d3N3CE4Q9rCBwExoHowU/z5s3DSXbt2gUdB0GGeCveodSxD6ykr3/965///OfBX1Btt99+O6QY5A6iIjjk6quvfvbZZ4EOToI+4xI4P8TWggULjh8/DtYDI+MMYEC/348tEF64NG4J+rSFNQzAjh07cAMf//jHL599fAsA1VCHpPz1r3+NLi1atAiq97777kNwB4LjhRdewIi9973v/cY3vvHXf/3XP/jBDyB08RWD9tBDDwHN66+/vqOjA8Ll+eefx31D7v7VX/3VV77yFQw1NPqqVavq1tkgGAOoalwIHYNew544ISQ3+gzxhy3QA8ACQg1beGAAFwLuuChMkDvuuAOEBhn3/e9/H0cBLyg1oEMLaMkV8xC4mWHQV3XxGpCyx+v51Kc+hfGBlC2XiyadI0zdS9wflDQgAI/gnrA/yAqiF6hBH0FbQX7jJ+wGo5ZXtqNBtXEGQW9rbIiv0I8gCnQ7EolA9uMkOBxwQGbz8Ye+AwVB3+HrXXfdhZsB+axfvx4/Aa+NGzfSaXWWhX1AvyA6jCuUCWwFPgDVFIZh2Yl71j+2VqApNDqjji0JYgp1ZU/0bIODA3v27XE53Zs3b3nxxZeggnA9Xa9As4B3cGeg5DvvvBOcCLzAdLNnz8YAgr5ATbg/nBLRe7zjdmEc3X333TgKO4BSwGuf/vSn0RmY4/iKHqJXMIXQeQAKigAZwvKEMwWKgzLFDYHjnnnmGZAGBgDngXIETBgYWCGgI86AgBVEh1EBQeG0sLawD6ml7hlMNPlsseUniZDJFIMBb6NabDKZw9kQ55FFFg1ntQymXQvFF3ohJlstR6wux3NBq22clu35PIna52lXtkGDsAPW4Gv0HKR0saIULl3XYNFBHYQmAS6gpmuuuYY58bWMvFArekJ6v68v8fz2Vz7x8bsaBegrX/2lxyMtmA/yDkSafdFICJFNZo1SUhR5/t0SL2WaXkGGv8LNZjMODWHLo+qn+xL3//i3kYj/vj//w0ZDrrFkfOjw2MuvHgv6/S3RpmjU19URnjurde68zkjER9mVr9d26fKvd9RaecutWrEtsaiJZVji0aNDD//yxTNnhkORRgs8+Gwfic5sJ0Y6n072Jk/2GgiFepwup6o2RwJLl8xasqxz0aIuj+oU/kO1mlBF4rCsCY8/sePZZ1+bTOt0C5nJbB/CFySjq5IghuoA3CVNKOplki2PxFNHjp0zH6lsvHr9X37+Tlm+AgGEf7vGyyKJcfLkyP/3/Uf7BlIWTy4KLsuc2Xwx3a715VW6dvEqp1CWVHKox3vPlSqGB2FvGvqmi/sQw1GuaKPxhCSJyEx4PS6X6uCVQXXnt8uEz9MntQLHi+dFkjftLf9zqToWe+Eyvr5bRTPkyWRmdCz97PZde/b2aDqcfJktMghtU5lmMeg3AejNG1+lLZlM9Z4ZWbmylc4AN2VDNPLFyjNPv/7CS0dVJwwZf3tbqLkZat0bCroCTf5wKIjtNjysGkKwdRFfHLW6xO35XSQXVV+wRS35WaxquRaRpoWHhR75l5HR1K49vYcPnT3Rc6YM/U5kBptJqqGlxrXK5QGyFyIWxVde3bty+d1UKYjCRDJ7//3bDx48VqhQZu4bGjH3C7Ike90ev091u51erxoIuFtaApBioXBTW2skFAoobEUUWiRNLF5MYLcppKaZ+VHL0tuF6JdutfqWkbHJbU/viicyrOKV0IpFWkjLVlria801rHUboSC74HbXzjOfvFeQRa1/cPIf//HpU+fG2E07+MiLEq5tZAqZdMFecBpZYkWiy23w1TIditTkd0dbw9GWUDDY1BJxRKOBcDgEK1SSayuf8bKEWoepCcE4x5riMAS/y2VmB07n67My5vaOqD/gj6VSVVXGeIutasbAmgFCM0hUJ7KZE6cGdE3/yY+eHhgZN4mbINVt5yqrfEDX77FX5aOTcnU6D0Sky1PSoteJVPrsQMyOBLDKMXggiiI5kdKmCyK5mnw09ojOw8Lm8XYcrxtaRRMqJb2QK5TyebDxn9yzCU7i+aZmDSm6MdoSbG/19PapJuVkow6OKs7vBECK6vjloy+MDWdjEwlapoM0vFWdO1ctm2c0IBGbHKy6D/bUFZMblnijhaes1JhYJV0rZbVENj08Si5IPNaWZ5REYXZX8023brxx60aP0+TQXFQPa09bwsVWLJ27a98ZTTP5IouM2E2rWsb5jgBkWdLhI30sLiwwGSuyxZbqB5ArK2Mqj2rTlz35terxWXxlJlJNetmN8CVS7ZI1wssuMQaG1hxxX7957aaNK+bMbpbEssWKuS9hndobVyyfp4ig8LJgONk0SmLVq1LyDgDEJGtViNrkIl3iFqekSG1voY40zl++ov5Is7reDlvD0yKKbL3nujW33rxp7pyIU+Vnli9lt1fXMKME0toaam9v7e3rZ/RkP89BmJra8U4A9G/QTJcg5eh6rvSzGG3xfvSjd6xcsQAGlljlNUu4TL6Cdx5BmA1XL+rtHaGLidqhDjgMGhcL/1EBIqRkmQrUn98TuH7z8j+4+yqfR6UTQm2ia5QxuP983bUrHn7wBbpGqsBCEzWJSdt/MIBqMssMBlxrVi+8+Za1i+Z3STBKLdusPK9e/c2toapd0hptmj2ruX9s3KwKR1KV+VfSDvo3axjzVSsX3Hzz1auWzfK5FbtWXRDql3UgjQ89kzQbrl587tdxQWK0Q4yaIdo4i/0f4nzaACDerJWKisiWL6Fuhm5Vl1q2ahZDwyvbQAOu37Ckuja4ZS99MM0yGm96kuk3c61MTG4T8+eGWHBTBVoSadWehzGD4bx8w72PjiW//b9/+Zm/+N7jzxzKVwS60AtbiYuw0nZe1m+ROsfVXlB6+hvBXTeH3fO6AiKdOwY3h6/UzH5q+MYvRUHUeSA1h5KVJhOxJAoam/zGx8RsfKGrBptpuYisjidyP/zxE5+892v/8tBLb5zoT6by9BkrLDrIV45mzMIlkUjNPzqVYfo7QUyru3uuafBnh4jWTGiHt0vIIH49KhoNZuWJzHSQBXvON5d54tREjSvULNh19CoOIpuZov7YU6++9PLB5UvmLV8+a/ny2V2dzSKzJuvmGgqCPSF9WhISVNWxcEHb8y9KGuFnZputt63mLbZAidcVsKxyNpMRZQfNCFgMJqJzMWDS1a+kGRBrA40+oALntyefS0QkqXwqdoBEAAAJgElEQVTp1T1H9x/p6WhtXrK4ffPmq+bO6VBEFmauyXDb0ZlmrGBQtbeHEFEYnhiza2mE+ozQ5dslKAi2PJFcHu1rX//0yNDgvt2D+/adHhgalmVaZssXkqDzT+hayFeWy2RSv7wYTaTA2RULFenMwETf4MT2Fw8tWdx51x1bly2fTagFqLOlgxxsyv5FJ2OPlmqNBpGMGB6PcUkmzJDmLwGQWALEsdGyWTJXLV20asnij3xkayan7d974vCh/pMnB/PFkmYVKlrFMJQLw4Vvoxl0soXCaIOvvCwTQwUQloD7kTXEUzRy6HDswIEfzp3bfOedm1csn9Pkdary9FfnixwEg4HOzuDBI05NoLSJOBRjsLfJYvRRP7JE3K++cvjuu65lYX0z4FW23rBiyw3LyxXzXF/sbG/s9JmBWDyVSucnJrKlcoWNIltFhs5vNao3OTP8IIZM9iQ2dm/sgUcme2KUwB/NRp9DYInKucH0d//h8TldLZs2LkdCd9asSMDvrbMArKrhTTNy8xd0eFy92WK6llB9u4YiXRObVEzJsWvvsd+/6xqJRv8kUiUVl0NYuqgLL9Ncm0jmoJtHRhMjsXj/wOjAwER8PE8licSXzqk+U6IxiFh0SZrqJD+4qhdqD8agC/+xp0H1DcfP/uLZlubAku65K5bNWbducSToth+jQcG15dSiRZ1ej5UvYruDrttPyNulIMFemKw8PDI5NpbuaA0K1vQiMBJyh4P+Zcs6wW3ZrJ7JZScSyWPHBnbt6hkbTwu8HE4QrCvDglNXZuejNpIoSQjOv7rz8IHDZ3779K51axdu2bKqsz2C5IJFNCokLSEaDnV1Bkbjk4LIV3Z++/EgfhZS1g33saN9ba1N00+SoapE5MYSnfgScERCztmzm9KpzNj4qElcbFY2e27ZlTUpWU7CYg84I3x9NUKyxUK+lBt4YuLJJ/Zs3Lj47g/e0NERlpHAQKyciGtXrdq9v4+ZEc4Z3cyb+GLU+tF0/XjPwJatq8m09jmpxhLpSiWGgdRjuvLYY7t/88QLRG7i9lt1HZB3pPFnnbAn+7D5nKZi0UfraDt2Hdmx6+jald233Lxu7uxgKOhZuWY+jfKaLNJ2ZeJBdJ03xRC0kZFUIpFtDgcutR/nH51Y/YMT//rozl27jxEFerfCHljGHnx5pZRctZlTS+bwE1s8gWc/30zg8+SF/W/0HDx0snth25q13d1L57V3hUZHE1N5pMbapebNC4xPocJLyWRuYGAsEg5M38mqtXbqZPyBB7ed6h2mk2pZAlKiHpzCrG3DuqJescWflWM/X4e76ZZZleNcNRDK3tjm6ekdOn12vDl6qIw74xrAetssxmLidnpiIlnoG5pYu5av+KNbHDimBpiggvGi7Tt4+nv/9FQybVAP2q7WZQ8htGaq5Rtq4lRwkX+tkVJdSI1SlEzY2oe4dagatrHqW75dLcZtLPbgLk0vD/THcrm83+sS6CIeFDu2tAcGSKvo5NlnD97/L08ZRBH4I0fqw/i1pN8VbuRNv9a2kikLo7aQjnDe38u2S8kg/tQ+ZrBJRl/feCIJgPz2zVB0aJxmMpV/8umdzz592BB8TOjownlrWP0f2qrRpYbaJQGqJjDofNiRkcmJycLsDr5yPQ/xmiOjhUceeXHngeMVTRekMhsjFvclMxKC/+bN4lqs0d2nl53MgBV5GhfyFRAcP9FvWBrsa1YiQ06civ39/3741d1ApxrEsjOI5pU1ea58IzMj8Uta0tzEZ1pTEST96LFzpvFekZUT7dzZ84MfPZnKVgyxLFns2Z4md6bNxr2Kf9/29u2gOpzZGq+nT/XnCwVVde3YceSRR36XypUMRMKZOqNz0qlIktlCEuaUX3ERVpYwJTar7xY57yHSU7J0aoHFqk9WNT9qeQ47fFrl64YHZiYk/iaGolFV0TTZVjHM5186ki/oTz+7o1DEL4rEloCkAUeTPViN1lLzYA5Fiz+PjaVKq2lV/mwT6hkY/NnEtjTgnqVNtKSqegzec7YHXX/cYA805s8WN+lJiCiypeXEimW56fNYGgPI4mtevm0tdmETJXHbttcR2TC4w01Yfp3mvI1Zs7qymXRzc3OxUPD6/eOx8ebmcC6bcbud6HyhWHK53JJlZrI5t9uTmJxsibYCvlKp7PF44hPxQABxS1onTJclU2XDsCbik4GmoNfrHxkeV1Q52hYZGBhobW8t5AuAKNAUGBgaaWkJlUsavOVkstAU9Pf1jTRuis7oWUYzyItNJisWeyhUrXaO0Of1iJ3RaEzQfU5hzfJl47FRyfCuu2rF6dM97W2tGnw5w4rHJ8ORABABQKOjzlAoWCwWFCU8OZm47j0bDPbsPoRvc7mcP+CWJXVsNNYSjZ46dWbp8vmpycnWiN/vntve0ZFOpRHSzGXyzSvnRVuC47FkIOibiJc9fml4YEBv+EkQM0Ko0QIq+7Sklp+irGTAVhTJK/sOyZBHQ/EDb5xjxqXjxOltbM/TCFobOmMlGsajD5AFGqI4yGLelEcPnhgiHGn6xB+DPp+F28nkBFvVfRRfj5+JmaZOyGl+E3DfTfa0A1o9ZGmEPmkZ9v0MngA+o6LlGVV38Bx5tfGndtPl8EzTsGSRtESbm/weYGQYRiqTgZWtOp0OuqyxVKYrtdAqfYk9all1OMB65VIl0tyaTqdpQEQSOzo6+/qG6VoMilwsZTs62hKJVDKddnu8Lc3hkdER1aGC2MKRZtMqBQPN+PXcuWGchVgepigaJYp3isWqSqS2Ii19XhzhpUx0WUFk53StosmK2d7arutmqpy1DNPj93o9rkxWVh3ObDaHWwuFQplMSlYkRXG3trWWyyWHSmvKSuWy26eCE70u+oQ5w9SCoaZyRQuHgpZpel1OQBMbnyhRHVGZwL8K7DL2JHP2FPgZmReN6zG2EifvrGCvjGlXQZBLndUu3rFVb3W1aHwfn0iPW2lJEs71T+i6ySOk2OhwyNTarj4Tu384XjslcoTAxT4900w4hoYi2XdWkmFNpAoa9iHC0Fhao6tl2ysp2PM2qg/sbVCH8YWLG18ukALUGm2xFxm0jT3RtjXeUqufpDyNOq3L6dS5j29yrbrdamd7y6YoL8cTzJaWcINHkE8I77Y3a/+hphb8e7R3AbpMexegy7R3AbpMexegy7R3AbpMexegy7R3AbpMexegy7R3AbpMexegy7R3AbpMexegy7R3AbpMexegy7R3AbpM+/8BAAD//8gmZTMAAAAGSURBVAMA6IIvDSu1iYcAAAAASUVORK5CYII="}
];

function imporCoverBase64Pilot() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    var sibuk = 'Sistem sedang sibuk, impor cover base64 (pilot) dilewati.';
    console.warn(sibuk);
    return sibuk;
  }

  try {
    var sh = sheetWajib_(SHEET.MAIN);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2) return 'Sheet1 belum punya data jurnal.';

    var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var map = buatHeaderMap_(header);
    var kolomCover = pastikanKolomAda_(sh, header, 'Cover URL');

    lastCol = sh.getLastColumn();
    var nilai = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    var petaBaris = {};
    for (var r = 0; r < nilai.length; r++) {
      var nama = ambil_(nilai[r], map, 'namaJurnal');
      if (!nama) continue;
      var key = normJudul_(nama);
      petaBaris[key] = (petaBaris[key] === undefined) ? (r + 2) : -1;
    }

    var tulisan = [];
    var cocok = 0, dilewatiSudahAda = 0, tidakCocok = [], namaGanda = [];

    _PILOT_COVER_BASE64_.forEach(function (entri) {
      if (!entri.t || !entri.b64) return;
      var key = normJudul_(entri.t);
      var baris = petaBaris[key];
      if (baris === undefined && PENYESUAIAN_NAMA_PROFIL_JURNAL_[key]) {
        baris = petaBaris[normJudul_(PENYESUAIAN_NAMA_PROFIL_JURNAL_[key])];
      }
      if (baris === undefined) { tidakCocok.push(entri.t); return; }
      if (baris === -1) { namaGanda.push(entri.t); return; }

      var coverSekarang = str_(nilai[baris - 2][kolomCover - 1]);
      var bolehTulis = !coverSekarang || coverSekarang.indexOf('ejournal.upi.edu') !== -1;
      if (!bolehTulis) { dilewatiSudahAda++; return; }

      tulisan.push({ baris: baris, kolom: kolomCover, nilai: 'data:image/png;base64,' + entri.b64 });
      cocok++;
    });

    tulisan.forEach(function (t) {
      sh.getRange(t.baris, t.kolom).setValue(t.nilai);
    });
    SpreadsheetApp.flush();

    bersihkanCacheJurnal_();

    var ringkas = 'Impor cover base64 (pilot) selesai — ' + cocok + ' jurnal terisi, ' +
      dilewatiSudahAda + ' dilewati (sudah punya cover kerja), ' + tidakCocok.length + ' tidak cocok ke Sheet1' +
      (namaGanda.length ? (', ' + namaGanda.length + ' dilewati karena nama jurnal ganda di Sheet1') : '') + '.';
    if (tidakCocok.length) ringkas += '\nTidak cocok: ' + tidakCocok.join(' | ');
    if (namaGanda.length) ringkas += '\nNama ganda: ' + namaGanda.join(' | ');

    catatAktivitas_('SISTEM', '-', 'IMPOR_COVER_BASE64_PILOT', ringkas);
    console.log(ringkas);
    return ringkas;
  } catch (err) {
    var pesan = 'imporCoverBase64Pilot gagal: ' + err.message;
    console.error(pesan);
    return pesan;
  } finally {
    lock.releaseLock();
  }
}
