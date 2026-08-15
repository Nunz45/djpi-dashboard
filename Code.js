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
  kuartil:         { alias: ['KUARTIL', 'QUARTILE', 'BEREPUTASI'] }
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
      doajDicek: doaj.dicek || ''
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
    bulanTerbit: j.bulanTerbit || []  // array bulan (1-12), untuk fitur kartu bulan
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