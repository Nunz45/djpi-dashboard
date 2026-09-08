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
 *  1. Pembacaan data sitasi dulu memanggil 4 pembacaan sheet mentah (Sitasi_Ringkasan,
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
  VERIFIKASI_DOAJ: 'Verifikasi_DOAJ',         // snapshot hasil pengecekan DOAJ per jurnal (lihat section 22)
  PRA_ASESMEN: 'Pra_Asesmen_Artikel'          // temuan pra-asesmen Tahap 3.2 per artikel (lihat section 29)
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
  SAMARAN_TTL: 1800,  // sesi admin atas nama pengelola, 30 menit. Tetap pendek, tetapi
                      // tidak sependek 15 menit yang menjadikannya item paling dekat
                      // kedaluwarsa sehingga pertama digusur saat cache penuh.
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
  nomorSk:         { alias: ['Nomor SK'] },
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
  scope:           { alias: ['Scope', 'SCOPE', 'About Jurnal'] },
  coverUrlDraft:   { alias: ['Cover URL (Draft)'] },
  scopeDraft:      { alias: ['Scope (Draft)'] },
  statusDraftProfil:   { alias: ['Status Draft Profil'] },
  catatanTolakDraft:   { alias: ['Catatan Penolakan Draft'] }
};

/** Status siklus draft profil (cover/scope) — lihat section 25. */
var STATUS_DRAFT_PROFIL = { KOSONG: '', MENUNGGU: 'MENUNGGU_REVIEW', DITOLAK: 'DITOLAK' };

/** Field yang boleh disunting pengelola jurnal (token edit). */
var EDITABLE_PENGELOLA = [
  'linkOjs', 'issn', 'eIssn', 'pIssn', 'linkGaruda', 'linkDoaj', 'apc', 'linkApc',
  'namaPengelola', 'jadwalTerbitan', 'issue',
  'artikelPerIssue', 'artikelPerTahun', 'coverUrlDraft', 'scopeDraft'
];
/*
 * 'email' SENGAJA tidak ada di daftar di atas, dan jangan dikembalikan.
 * Kolom itu adalah tujuan pengiriman PIN (requestPengelolaPin -> GmailApp.sendEmail).
 * Selama pengelola boleh mengubahnya, siapa pun yang memegang token edit_ bisa
 * mengalihkan PIN berikutnya ke alamat mana pun -- emailValid_ hanya memeriksa
 * bentuk x@y.z, tanpa batasan domain -- sehingga jurnal berpindah tangan tanpa
 * sepengetahuan pemilik lama. Perubahan email kini hanya lewat admin.
 */

/** Tambahan yang boleh disunting admin (token session). */
var EDITABLE_ADMIN = EDITABLE_PENGELOLA.concat([
  'email',
  'kluster', 'unitPengelola', 'statusOjs', 'catatanMigrasi',
  'statusAkreditasi', 'masaBerlakuSk', 'tanggalExpired',
  'timeliness', 'performa', 'kuartil'
]);

/* ==========================================================================
   1. ROUTING
   ========================================================================== */

/**
 * URL dasar web app.
 *
 * ScriptApp.getService().getUrl() TIDAK BISA DIPERCAYA. Ia mengembalikan URL
 * yang saat dibuka menghasilkan "Maaf, saat ini tidak dapat membuka file"
 * ("Sorry, unable to open the file at this time"). Ini bug Google yang sudah
 * dilaporkan berkali-kali dan tidak diperbaiki:
 *   https://issuetracker.google.com/issues/235862472
 *   https://issuetracker.google.com/issues/170799249
 * Perilakunya juga pernah berubah diam-diam antara /exec dan /dev lintas versi
 * runtime, jadi tidak ada satu bentuk pun yang bisa diandalkan.
 *
 * Solusinya: pakai URL /exec yang sebenarnya. Urutan sumbernya:
 *   1. Script Property URL_WEBAPP, bila disetel lewat setUrlWebApp_()
 *   2. URL_WEBAPP_TETAP di bawah -- nilai bawaan, cukup untuk deployment sekarang
 *   3. getUrl(), cadangan terakhir yang justru bermasalah
 *
 * ID deployment hanya berubah saat membuat deployment BARU, bukan saat
 * memperbarui versi. Jadi nilai tetap ini stabil. Kalau suatu saat berubah,
 * jalankan setUrlWebApp_() -- propertinya menang atas nilai tetap, tanpa
 * perlu menyunting kode.
 */
var URL_WEBAPP_TETAP =
  'https://script.google.com/macros/s/AKfycbzItggyDD1lM1ua0iiqFdfW9Str5XNAmefTvIsnbnNaNNpa36Y-F0CjTXlpRTe5YRTt9g/exec';

/**
 * Varian URL yang mengunci akun ke domain tertentu.
 *
 * Saat pengguna login beberapa akun Google sekaligus, membuka URL /exec telanjang
 * di TAB BARU memakai akun bawaan peramban (/u/0), bukan akun yang sedang dipakai
 * di tab asal. Kalau akun bawaan itu bukan akun UPI, Google menampilkan
 * "Maaf, saat ini tidak dapat membuka file" -- padahal URL-nya benar dan rutenya
 * hidup. Menyisipkan /a/<domain>/ memaksa Google memilih akun berdomain itu.
 *
 * Dipakai sebagai alternatif yang ditawarkan ke pengguna, bukan pengganti, karena
 * bentuk ini hanya benar bila akunnya memang akun Workspace domain tersebut.
 */
function urlWebAppDomain_(domain) {
  var dasar = urlWebApp_();
  if (!dasar || !domain) return '';
  if (dasar.indexOf('/a/') !== -1) return dasar;
  return dasar.replace('https://script.google.com/', 'https://script.google.com/a/' + domain + '/');
}

function urlWebApp_() {
  try {
    var tersimpan = PropertiesService.getScriptProperties().getProperty('URL_WEBAPP');
    if (tersimpan) return String(tersimpan).trim();
  } catch (err) { /* properti tidak terbaca, jatuh ke nilai tetap */ }
  if (URL_WEBAPP_TETAP) return URL_WEBAPP_TETAP;
  try { return ScriptApp.getService().getUrl() || ''; } catch (err) { return ''; }
}

/**
 * Setel URL web app sekali dari editor Apps Script.
 *
 * Cara memakai:
 *   1. Deploy > Kelola deployment, salin URL yang berakhiran /exec
 *   2. Tempel ke dalam tanda kutip di bawah, jalankan fungsi ini sekali
 *   3. Kembalikan tanda kutipnya jadi kosong supaya tidak ikut ter-commit
 *
 * Jalankan cekUrlWebApp_() untuk melihat nilai yang sedang dipakai.
 */
function setUrlWebApp_() {
  var url = '';   // <-- tempel URL /exec di sini

  url = String(url).trim();
  if (!url) return 'Isi dulu variabel url di dalam fungsi ini dengan URL /exec.';
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    return 'URL harus berupa https://script.google.com/.../exec tanpa parameter.';
  }
  PropertiesService.getScriptProperties().setProperty('URL_WEBAPP', url);
  catatAktivitas_('SISTEM', '-', 'SETEL_URL_WEBAPP', url);
  return 'Tersimpan: ' + url;
}

/** Menampilkan URL yang sedang dipakai dan dari mana asalnya. */
function cekUrlWebApp_() {
  var tersimpan = '';
  try { tersimpan = PropertiesService.getScriptProperties().getProperty('URL_WEBAPP') || ''; } catch (e) {}
  var bawaan = '';
  try { bawaan = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  var pesan = [
    '1. Script Property URL_WEBAPP : ' + (tersimpan || '(belum disetel)'),
    '2. URL_WEBAPP_TETAP di kode   : ' + (URL_WEBAPP_TETAP || '(kosong)'),
    '3. getUrl() bawaan            : ' + (bawaan || '(kosong)'),
    '',
    'Yang sedang dipakai           : ' + urlWebApp_()
  ];
  if (!tersimpan && !URL_WEBAPP_TETAP) {
    pesan.push('');
    pesan.push('PERINGATAN: keduanya kosong, jadi aplikasi bergantung pada getUrl()');
    pesan.push('yang bisa menghasilkan halaman "tidak dapat membuka file".');
  }
  var ringkas = pesan.join(String.fromCharCode(10));
  console.log(ringkas);
  return ringkas;
}

function doGet(e) {
  // Direktori publik dipindahkan ke Litabmas, sehingga halaman Landing dihapus.
  // Bawaan rute kini halaman Masuk, yang cuma menawarkan dua pilihan peran.
  // Akses web app dibatasi DOMAIN di appsscript.json; itulah yang benar-benar
  // menutup akses anonim, bukan pilihan rute di sini.
  var page = (e && e.parameter && e.parameter.page) ? String(e.parameter.page) : 'masuk';
  var HALAMAN = {
    masuk:     { berkas: 'Masuk',     judul: 'Masuk — DJPI UPI' },
    dashboard: { berkas: 'Dashboard', judul: 'DJPI Dashboard — Divisi Jurnal dan Publikasi Ilmiah UPI' },
    pengelola: { berkas: 'Pengelola', judul: 'Dashboard Pengelola Jurnal — DJPI UPI' }
  };
  var pilih = HALAMAN[page] || HALAMAN.masuk;
  var berkas = pilih.berkas;
  var judul = pilih.judul;

  var t = HtmlService.createTemplateFromFile(berkas);

  // Halaman berjalan di dalam iframe sandbox pada origin googleusercontent.com,
  // sehingga href relatif seperti "?page=dashboard" akan mengarah ke origin
  // sandbox dan menghasilkan halaman kosong. Seluruh tautan antar-halaman wajib
  // memakai URL absolut web app.
  var urlDasar = urlWebApp_();
  t.urlMasuk = urlDasar ? (urlDasar + '?page=masuk') : '?page=masuk';
  t.urlDashboard = urlDasar ? (urlDasar + '?page=dashboard') : '?page=dashboard';
  t.urlPengelola = urlDasar ? (urlDasar + '?page=pengelola') : '?page=pengelola';

  // Jalur pemulihan: token sesi dapat dititipkan lewat parameter ?t= bila
  // pengiriman PIN lewat email sedang bermasalah. Lihat buatSesiDarurat().
  t.tokenAwal = (e && e.parameter && e.parameter.t) ? String(e.parameter.t) : '';

  // Penanda mode "bertindak atas nama pengelola". WAJIB disuntikkan dari sini:
  // halaman berjalan di dalam iframe sandbox googleusercontent.com, dan
  // location.search milik iframe itu KOSONG. Parameter query hanya ada di URL
  // frame teratas yang beda origin, jadi klien tidak bisa membacanya sendiri.
  t.atasNamaAwal = (e && e.parameter && e.parameter.atasnama === '1');

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
      nomorSk: ambil_(row, map, 'nomorSk'),
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
      scope: ambil_(row, map, 'scope'),
      coverUrlDraft: ambil_(row, map, 'coverUrlDraft'),
      scopeDraft: ambil_(row, map, 'scopeDraft'),
      statusDraftProfil: ambil_(row, map, 'statusDraftProfil'),
      catatanTolakDraft: ambil_(row, map, 'catatanTolakDraft')
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
   ada tanpa membuat pemanggilnya gagal total. Setiap fungsi menangkap
   galatnya sendiri dan mengembalikan null/[] bila sheet tidak ada, kosong,
   atau strukturnya rusak, sehingga journals/stats/dll tetap tampil normal.

   OPTIMASI 1: keempat fungsi bacaX_() di bawah ini TIDAK dipanggil langsung
   lagi dari satu endpoint. Dulu setiap kunjungan memicu 4 kali
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
 * sebagai satu nilai gabungan. Sebelumnya endpoint publik memanggil 4 fungsi
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

/**
 * Token sesi ditulis ke DUA cache dan dibaca dari dua-duanya.
 *
 * Script cache dijamin sama untuk semua permintaan, tetapi dibatasi 1000 item
 * dan saat penuh Google membuang item yang paling dekat kedaluwarsa. Karena
 * cache itu juga menampung payload jurnal yang dipecah sampai 21 potongan,
 * token ber-TTL pendek adalah yang pertama digusur.
 *
 * User cache punya kuota terpisah, TETAPI terikat ke pengguna. Pada deployment
 * berakses anonim -- dan deployment yang hidup sekarang memang masih anonim,
 * terbukti permintaan tanpa login tetap dilayani -- "pengguna" bisa berbeda
 * antar eksekusi. Token yang ditulis saat membuka mode atas nama karena itu
 * tidak ditemukan lagi ketika tab baru memuat halaman. Itulah SESSION_EXPIRED
 * yang muncul setelah token sempat dipindahkan ke user cache saja.
 *
 * Menulis ke keduanya menutup dua mode gagal sekaligus: script cache menjamin
 * token terbaca lintas eksekusi, user cache menyimpan salinan yang selamat bila
 * script cache penuh. Pembacaan mencoba keduanya.
 */
function buatToken_(prefix, muatan, ttl) {
  var token = prefix + Utilities.getUuid();
  muatan.expires = Date.now() + ttl * 1000;
  var json = JSON.stringify(muatan);
  var okSkrip = false;
  // Kegagalan put TIDAK boleh diam. Sebelumnya catch-nya kosong, sehingga token
  // dikembalikan seolah tersimpan, URL dirakit, tab terbuka, dan tidak ada satu
  // pun jejak ketika ternyata tidak pernah tersimpan.
  try { CacheService.getScriptCache().put(token, json, ttl); okSkrip = true; }
  catch (err) { console.error('buatToken_: put ke script cache gagal -- ' + err); }
  try { CacheService.getUserCache().put(token, json, ttl); }
  catch (err) { console.warn('buatToken_: put ke user cache gagal -- ' + err); }
  if (!okSkrip) console.error('buatToken_: token ' + token.slice(0, 5) + '... tidak tersimpan di script cache');
  return token;
}

/**
 * Mengembalikan muatan token, atau null bila hilang/kedaluwarsa/salah jenis.
 * Sesi disimpan di cache, dan cache dapat digusur sebelum TTL habis — sesi
 * putus lebih cepat harus diperlakukan sebagai keadaan normal.
 */
/**
 * Identitas PELAKU dari muatan token edit_.
 *
 * Muatan edit_ memisahkan dua hal yang dulu ditumpuk di satu field:
 *   muatan.email  DATA  -- alamat pengelola jurnal. Dipakai sebagai tujuan
 *                          pengiriman dan disimpan ke kolom sheet. TIDAK pernah
 *                          berubah saat admin menyamar, supaya tanda terima DOI
 *                          tetap sampai ke pengelola dan kolom sheet tidak tercemar.
 *   muatan.aktor  PELAKU -- siapa yang benar-benar menekan tombol. Dipakai untuk
 *                          SEMUA pencatatan. Saat penyamaran, ini email admin.
 *
 * Token lama yang belum punya aktor tetap jalan: jatuh kembali ke email.
 */
function pelakuEdit_(muatan) {
  if (!muatan) return '';
  if (muatan.samaran && muatan.aktor) {
    return muatan.aktor + ' (atas nama ' + muatan.email + ')';
  }
  return muatan.aktor || muatan.email || '';
}

/** Sufiks aksi supaya baris penyamaran bisa disaring tanpa mengurai kolom email. */
function aksiEdit_(muatan, aksi) {
  return (muatan && muatan.samaran) ? (aksi + '_ATAS_NAMA') : aksi;
}

/**
 * Rahasia penanda tangan token, per proyek. Dibuat sekali saat pertama dipakai.
 */
function rahasiaToken_() {
  var prop = PropertiesService.getScriptProperties();
  var r = prop.getProperty('TOKEN_SECRET');
  if (!r) { r = Utilities.getUuid() + Utilities.getUuid(); prop.setProperty('TOKEN_SECRET', r); }
  return r;
}

/**
 * Padding '=' SENGAJA dipertahankan. base64DecodeWebSafe menuntut panjang yang
 * benar, dan token ini selalu melewati encodeURIComponent sebelum masuk URL
 * sehingga '=' tidak mengganggu.
 */
function b64_(nilai) {
  return Utilities.base64EncodeWebSafe(nilai);
}

/**
 * Token BERTANDA TANGAN, bukan token yang disimpan.
 *
 * Token biasa dititipkan ke cache, lalu dicari lagi saat dipakai. Cara itu punya
 * satu kelas kegagalan yang sulit dilacak: token bisa hilang antara ditulis dan
 * dibaca -- digusur karena cache penuh, atau dicari di penyimpanan yang bukan
 * tempatnya ditulis. Gejalanya selalu sama, "sesi berakhir", tanpa petunjuk mana
 * dari keduanya.
 *
 * Token bertanda tangan tidak menyimpan apa pun. Muatannya dibawa di dalam token
 * itu sendiri, dan keasliannya dibuktikan HMAC memakai rahasia milik proyek.
 * Tidak ada yang bisa hilang, tidak ada TTL cache, tidak ada soal cache milik
 * siapa. Kedaluwarsanya ada di dalam muatan dan diverifikasi saat dibaca.
 *
 * Konsekuensi yang diterima: token tidak bisa dicabut sebelum kedaluwarsa, jadi
 * logout tidak berpengaruh padanya. Karena itu bentuk ini dipakai HANYA untuk
 * sesi mode atas nama yang umurnya pendek, bukan untuk sesi login biasa.
 */
function buatTokenTtd_(prefix, muatan, ttl) {
  var isi = {};
  Object.keys(muatan).forEach(function (k) { isi[k] = muatan[k]; });
  isi.expires = Date.now() + ttl * 1000;
  var badan = b64_(JSON.stringify(isi));
  return prefix + badan + '.' +
    b64_(Utilities.computeHmacSha256Signature(badan, rahasiaToken_()));
}

/** Kebalikan buatTokenTtd_. Mengembalikan muatan, atau null bila tidak sah. */
function bacaTokenTtd_(token, prefix) {
  var inti = token.slice(prefix.length);
  var pisah = inti.lastIndexOf('.');
  if (pisah < 1) return null;
  var badan = inti.slice(0, pisah);
  var ttd = inti.slice(pisah + 1);

  var harap = b64_(Utilities.computeHmacSha256Signature(badan, rahasiaToken_()));
  if (!samaAman_(ttd, harap)) return null;

  try {
    var isi = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(badan)).getDataAsString());
    if (!isi.expires || isi.expires < Date.now()) return null;
    return isi;
  } catch (err) { return null; }
}

function bacaToken_(token, prefix) {
  if (!token || typeof token !== 'string') return null;
  if (prefix && token.indexOf(prefix) !== 0) return null;

  // Token bertanda tangan dikenali dari titik pemisah dan diverifikasi tanpa
  // menyentuh penyimpanan apa pun.
  if (prefix && token.indexOf('.') > prefix.length) return bacaTokenTtd_(token, prefix);

  var mentah = null;
  try { mentah = CacheService.getScriptCache().get(token); } catch (err) { mentah = null; }
  if (!mentah) {
    try { mentah = CacheService.getUserCache().get(token); } catch (err) { mentah = null; }
  }
  if (!mentah) return null;
  try {
    var muatan = JSON.parse(mentah);
    if (!muatan.expires || muatan.expires < Date.now()) return null;
    return muatan;
  } catch (err) { return null; }
}

/**
 * Menerangkan KENAPA sebuah token tidak terbaca. Dipakai pada jalur gagal saja.
 * Tidak pernah membocorkan isi token: hanya panjang dan awalannya.
 */
function diagnosaToken_(token, prefix) {
  if (!token || typeof token !== 'string') return 'token tidak dikirim ke server';
  var potong = token.slice(0, 5) + '...(' + token.length + ' karakter)';
  if (prefix && token.indexOf(prefix) !== 0) return 'awalan salah, diharap ' + prefix + ', dapat ' + potong;

  // Token bertanda tangan tidak disimpan di mana pun, jadi pertanyaannya bukan
  // "ada di cache atau tidak" melainkan "tanda tangannya cocok atau tidak".
  if (token.indexOf('.') > prefix.length) {
    var inti = token.slice(prefix.length);
    var pisah = inti.lastIndexOf('.');
    var badan = inti.slice(0, pisah);
    var cocok = samaAman_(inti.slice(pisah + 1),
      b64_(Utilities.computeHmacSha256Signature(badan, rahasiaToken_())));
    if (!cocok) {
      return 'token bertanda tangan, tetapi TANDA TANGANNYA TIDAK COCOK. ' +
        'Berarti token dibuat oleh proyek Apps Script lain -- rahasia penanda ' +
        'tangan berbeda. Proyek yang melayani halaman ini: ' + ScriptApp.getScriptId();
    }
    try {
      var isi = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(badan)).getDataAsString());
      var sisaT = Math.round((isi.expires - Date.now()) / 1000);
      return 'token bertanda tangan sah, tetapi sudah kedaluwarsa ' + (-sisaT) + ' detik lalu';
    } catch (err) {
      return 'token bertanda tangan sah, tetapi muatannya tidak bisa diurai';
    }
  }

  var diSkrip = null, diUser = null;
  try { diSkrip = CacheService.getScriptCache().get(token); } catch (err) { diSkrip = null; }
  try { diUser = CacheService.getUserCache().get(token); } catch (err) { diUser = null; }

  if (!diSkrip && !diUser) {
    return 'token ' + potong + ' TIDAK ADA di script cache maupun user cache. ' +
      'Berarti tulisan dan pembacaan terjadi pada penyimpanan yang berbeda, ' +
      'atau entrinya sudah hilang. Proyek yang melayani halaman ini: ' +
      ScriptApp.getScriptId();
  }

  var mentah = diSkrip || diUser;
  var dimana = diSkrip ? 'script cache' : 'user cache saja';
  try {
    var m = JSON.parse(mentah);
    if (!m.expires) return 'token ada di ' + dimana + ' tetapi tanpa medan expires';
    var sisa = Math.round((m.expires - Date.now()) / 1000);
    return 'token ada di ' + dimana + ', kedaluwarsa ' + (sisa < 0 ? (-sisa + ' detik lalu') : ('dalam ' + sisa + ' detik'));
  } catch (err) {
    return 'token ada di ' + dimana + ' tetapi isinya tidak bisa diurai';
  }
}

/**
 * Uji dua langkah untuk membuktikan apakah cache benar-benar dibagi antar
 * eksekusi. Jalankan dari editor Apps Script:
 *   1. ujiTokenLangkah1_()  -> menghasilkan token, salin dari log
 *   2. ujiTokenLangkah2_()  -> tempel token itu ke dalam fungsinya, jalankan
 * Kalau langkah 2 gagal padahal langkah 1 berhasil, cache tidak menyeberang
 * antar eksekusi dan token harus dipindahkan ke penyimpanan lain.
 */
function ujiTokenLangkah1_() {
  var tok = buatToken_('edit_', { namaJurnal: 'UJI', email: 'uji@upi.edu', aktor: 'uji', samaran: true }, 1800);
  var langsung = bacaToken_(tok, 'edit_');
  var pesan = [
    'Token dibuat : ' + tok,
    'Dibaca ulang dalam eksekusi yang SAMA: ' + (langsung ? 'BERHASIL' : 'GAGAL'),
    '',
    'Salin token di atas, tempel ke dalam ujiTokenLangkah2_(), lalu jalankan.'
  ].join(String.fromCharCode(10));
  console.log(pesan);
  return pesan;
}

function ujiTokenLangkah2_() {
  var tok = '';   // <-- tempel token dari langkah 1 di sini

  if (!tok) return 'Tempel dulu token dari ujiTokenLangkah1_() ke dalam fungsi ini.';
  var muatan = bacaToken_(tok, 'edit_');
  var pesan = [
    'Dibaca pada eksekusi BERBEDA: ' + (muatan ? 'BERHASIL' : 'GAGAL'),
    'Diagnosa: ' + diagnosaToken_(tok, 'edit_')
  ].join(String.fromCharCode(10));
  console.log(pesan);
  return pesan;
}

function sesiHabis_() {
  return { ok: false, code: 'SESSION_EXPIRED', message: 'Sesi Anda telah berakhir. Silakan masuk kembali.' };
}

function pinAcak_() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function logout(token) {
  if (token && typeof token === 'string') {
    // Hapus dari kedua tempat: token yang terbit sebelum pemindahan ke user
    // cache masih tersimpan di script cache.
    try { CacheService.getScriptCache().remove(token); } catch (err) { /* abaikan */ }
    try { CacheService.getUserCache().remove(token); } catch (err) { /* abaikan */ }
  }
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

/**
 * Diagnostik: memeriksa apakah kolom Akses_Kluster terisi untuk setiap admin.
 * Jalankan dari editor Apps Script sebelum memutuskan membuat isSuperadmin
 * fail-closed.
 *
 * Aturan yang berlaku SEKARANG (bacaDaftarAdmin_): sel kosong ATAU kolomnya
 * tidak ada sama sekali membuat admin itu superadmin. Jadi kalau laporan di
 * bawah menyebut banyak baris kosong, membuat aturannya fail-closed akan
 * mengunci mereka semua sekaligus -- termasuk kemungkinan Anda sendiri.
 */
function cekAksesAdmin_() {
  var sh = sheetWajib_(SHEET.ADMIN);
  var nilai = sh.getDataRange().getValues();
  if (nilai.length < 2) return 'Sheet ' + SHEET.ADMIN + ' kosong.';

  var header = nilai[0].map(norm_);
  var iEmail = header.indexOf('EMAIL_ADMIN');
  var iAkses = header.indexOf('AKSES_KLUSTER');

  var garis = [];
  garis.push('Kolom EMAIL_ADMIN   : ' + (iEmail === -1 ? 'TIDAK ADA' : 'kolom ke-' + (iEmail + 1)));
  garis.push('Kolom AKSES_KLUSTER : ' + (iAkses === -1 ? 'TIDAK ADA -- SEMUA admin jadi superadmin' : 'kolom ke-' + (iAkses + 1)));
  garis.push('');

  var kosong = [], all = [], berkluster = [];
  for (var r = 1; r < nilai.length; r++) {
    var email = str_(nilai[r][iEmail]).toLowerCase();
    if (!email) continue;
    var akses = (iAkses === -1) ? '' : str_(nilai[r][iAkses]);
    if (!akses) kosong.push(email);
    else if (norm_(akses) === 'ALL') all.push(email);
    else berkluster.push(email + '  ->  ' + akses);
  }

  garis.push('Superadmin karena sel KOSONG (' + kosong.length + '):');
  kosong.forEach(function (e) { garis.push('  ' + e); });
  garis.push('');
  garis.push('Superadmin karena ditulis ALL (' + all.length + '):');
  all.forEach(function (e) { garis.push('  ' + e); });
  garis.push('');
  garis.push('Admin berkluster (' + berkluster.length + '):');
  berkluster.forEach(function (e) { garis.push('  ' + e); });
  garis.push('');

  if (kosong.length) {
    garis.push('KESIMPULAN: ' + kosong.length + ' baris bergantung pada sel kosong. Isi kolomnya');
    garis.push('lebih dulu -- "ALL" untuk yang memang superadmin, nama kluster untuk sisanya --');
    garis.push('baru aturan fail-closed aman dinyalakan.');
  } else {
    garis.push('KESIMPULAN: tidak ada baris yang bergantung pada sel kosong.');
    garis.push('Aturan fail-closed aman dinyalakan.');
  }

  var ringkas = garis.join(String.fromCharCode(10));
  console.log(ringkas);
  return ringkas;
}


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
   BERTINDAK ATAS NAMA PENGELOLA
   --------------------------------------------------------------------------
   Admin membuka panel Pengelola untuk satu jurnal, dan boleh menulis di sana.
   Token yang diterbitkan berjenis edit_ seperti login pengelola biasa, tetapi
   muatannya memisahkan dua hal:

     email  = alamat pengelola jurnal. Tetap dipakai sebagai tujuan pengiriman
              dan kolom sheet, supaya tanda terima DOI tidak nyasar ke admin
              dan data operasional tidak tercemar.
     aktor  = email admin yang benar-benar bertindak. Dipakai untuk seluruh
              pencatatan lewat pelakuEdit_(), sehingga log tidak pernah
              menuding pengelola atas perbuatan admin.

   Dibatasi superadmin. Selama sel Akses_Kluster yang kosong masih dihitung
   sebagai superadmin (lihat cekAksesAdmin_), membuka ini untuk admin kluster
   berarti membukanya bagi setiap baris sheet yang cacat pengisiannya.

   TTL sengaja 15 menit, bukan satu jam seperti login pengelola biasa.
   ========================================================================== */

function mulaiAtasNamaPengelola(token, namaJurnal) {
  var profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();
  if (!profile.isSuperadmin) {
    return { ok: false, message: 'Hanya superadmin yang dapat bertindak atas nama pengelola.' };
  }

  try {
    var jurnal = cariJurnal_(bacaDataJurnal_(), namaJurnal)[0];
    if (!jurnal) return { ok: false, message: 'Jurnal tidak ditemukan.' };

    var muatan = {
      namaJurnal: jurnal.namaJurnal,
      email: jurnal.email || '',      // DATA: tujuan pengiriman, tetap pengelola
      aktor: profile.email,           // PELAKU: yang tercatat di seluruh log
      samaran: true
    };

    catatAktivitas_(profile.email, jurnal.namaJurnal, 'MULAI_ATAS_NAMA',
      'Admin membuka panel pengelola dan dapat menulis atas nama jurnal ini. Berlaku ' +
      Math.round(CACHE.SAMARAN_TTL / 60) + ' menit.');

    // Bertanda tangan, bukan disimpan: mode atas nama harus menyeberang dari
    // eksekusi tombol ke eksekusi doGet tab baru, dan penyeberangan lewat cache
    // itulah yang selama ini gagal.
    var tok = buatTokenTtd_('edit_', muatan, CACHE.SAMARAN_TTL);
    var query = '?page=pengelola&t=' + encodeURIComponent(tok) + '&atasnama=1';
    var dasarDomain = urlWebAppDomain_('upi.edu');

    return {
      ok: true,
      token: tok,
      // URL dirakit di server, bukan di klien, supaya klien tidak perlu menebak
      // bentuk URL dasarnya. urlAlt memakai /a/upi.edu/ untuk kasus multi-login.
      url: urlWebApp_() + query,
      urlAlt: dasarDomain ? (dasarDomain + query) : '',
      namaJurnal: jurnal.namaJurnal,
      emailPengelola: jurnal.email || '',
      berlakuMenit: Math.round(CACHE.SAMARAN_TTL / 60),
      // untuk dibandingkan dengan proyek yang melayani halaman tujuan
      idProyek: ScriptApp.getScriptId()
    };
  } catch (err) {
    return { ok: false, message: 'Gagal membuka panel pengelola: ' + err.message };
  }
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

/**
 * Kembalikan identitas sesi dari muatan token edit_, TANPA perlu tahu nama
 * jurnalnya lebih dulu.
 *
 * Dibutuhkan karena getJournalDetailForEditor menuntut namaJurnal sebagai
 * argumen kedua untuk mencocokkannya dengan token. Pada dua jalur, klien belum
 * punya nama itu: mode "bertindak atas nama pengelola", dan pemulihan lewat ?t=
 * di perangkat yang localStorage-nya kosong. Nama jurnalnya justru ada di dalam
 * token, jadi tanya saja ke sini lebih dulu.
 */
function getSesiPengelola(token) {
  var muatan = bacaToken_(token, 'edit_');
  if (!muatan) {
    // Diagnostik: tanpa ini, SESSION_EXPIRED tidak membedakan token yang tidak
    // pernah sampai, token yang salah prefix, token yang tidak ada di cache mana
    // pun, dan token yang ada tetapi sudah kedaluwarsa. Keempatnya butuh
    // perbaikan yang berbeda.
    var d = diagnosaToken_(token, 'edit_');
    console.warn('getSesiPengelola gagal: ' + d);
    var r = sesiHabis_();
    r.diagnosa = d;
    return r;
  }
  return {
    ok: true,
    namaJurnal: muatan.namaJurnal,
    email: muatan.email || '',
    atasNama: !!muatan.samaran,
    aktor: muatan.samaran ? (muatan.aktor || '') : ''
  };
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
  // Read-only untuk pengelola: status review draft cover/scope terakhir,
  // supaya form bisa menampilkan badge "Menunggu Review"/"Ditolak: ...".
  detail.statusDraftProfil = j.statusDraftProfil;
  detail.catatanTolakDraft = j.catatanTolakDraft;
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

    lekatkanAkreditasi_(terlihat); // section 27 — melekatkan j.akreditasi (kedaluwarsa SK + checklist kesiapan)

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
      akreditasi: rekapAkreditasi_(terlihat), // rekap tab Akreditasi (Grup D — algoritma 9 & 10)
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

  var pelaku = sesi ? sesi.email : pelakuEdit_(edit);
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

    // Pengelola mengubah cover/scope draft -> otomatis masuk antrean review
    // superadmin, dan catatan penolakan lama (kalau ada) dibersihkan karena
    // ini submission baru. Admin (sesi) TIDAK memicu ini — admin yang edit
    // draft dianggap sedang menyiapkan untuk pengelola, bukan mengajukan.
    if (edit) {
      var draftBerubah = rencana.some(function (r) { return r.field === 'coverUrlDraft' || r.field === 'scopeDraft'; });
      if (draftBerubah) {
        var kolomStatusDraft = temu.map['statusDraftProfil'];
        var kolomCatatanDraft = temu.map['catatanTolakDraft'];
        if (kolomStatusDraft !== undefined) {
          rencana.push({ field: 'statusDraftProfil', kolom: kolomStatusDraft, dari: str_(barisNilai[kolomStatusDraft]), ke: STATUS_DRAFT_PROFIL.MENUNGGU });
        }
        if (kolomCatatanDraft !== undefined) {
          rencana.push({ field: 'catatanTolakDraft', kolom: kolomCatatanDraft, dari: str_(barisNilai[kolomCatatanDraft]), ke: '' });
        }
      }
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
  if (field === 'coverUrlDraft' && !coverDataUriValid_(s)) {
    return {
      field: field, label: 'Cover jurnal',
      pesan: 'Cover harus diunggah lewat tombol pilih gambar (bukan tempel link), format PNG/JPEG.'
    };
  }
  if (field === 'scopeDraft' && placeholder_(s)) {
    return { field: field, label: 'Deskripsi jurnal', pesan: 'Nilai "' + s + '" terbaca sebagai placeholder. Isi deskripsi yang sebenarnya.' };
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

    catatAktivitas_(pelakuEdit_(muatan), muatan.namaJurnal, aksiEdit_(muatan, 'AJUKAN_DOI'),
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

/**
 * Pengelola memperbaiki usulan DOI miliknya sendiri.
 *
 * Hanya boleh saat usulan belum disentuh admin. Setelah masuk SIAP_DIPROSES
 * ke atas, admin sudah bekerja atas isi yang lama; mengubahnya diam-diam akan
 * membuat yang dikerjakan berbeda dari yang tampil.
 *
 * PERLU_REVISI justru kasus utamanya: admin meminta perbaikan, pengelola
 * memperbaiki, statusnya kembali ke MENUNGGU_VALIDASI supaya masuk antrean lagi.
 *
 * Kolom milik admin (status, catatan_admin, diproses_*, hasil submission)
 * tidak pernah ditulis dari sini.
 */
var DOI_STATUS_BISA_DIEDIT = ['MENUNGGU_VALIDASI', 'PERLU_REVISI'];

function perbaruiUsulanDoi(token, payload) {
  const muatan = bacaToken_(token, 'edit_');
  if (!muatan) return sesiHabis_();

  if (!payload || typeof payload !== 'object' || !String(payload.id_usulan || '').trim()) {
    return { ok: false, message: 'Usulan yang akan diperbarui tidak disebutkan.' };
  }
  const galat = validasiPayloadDoi_(payload);
  if (galat) return { ok: false, message: galat };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };
  }

  try {
    const sheet = getUsulanDoiSheet_();
    const info = petaKolomDoi_(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: false, message: 'Usulan tidak ditemukan.' };

    const idCari = String(payload.id_usulan).trim();
    const iId = info.peta['id_usulan'];
    if (iId === undefined) return { ok: false, message: 'Kolom id_usulan tidak ada di sheet.' };

    const kolomId = sheet.getRange(2, iId + 1, lastRow - 1, 1).getValues();
    var barisKe = -1;
    for (var i = 0; i < kolomId.length; i++) {
      if (String(kolomId[i][0]).trim() === idCari) { barisKe = i + 2; break; }
    }
    if (barisKe < 0) return { ok: false, message: 'Usulan ' + idCari + ' tidak ditemukan.' };

    const barisLama = sheet.getRange(barisKe, 1, 1, info.lebar).getValues()[0];
    const lama = barisDoiKeObjek_(info, barisLama);

    // Kepemilikan: usulan hanya bisa disunting oleh jurnal yang mengajukannya.
    if (norm_(lama.nama_jurnal) !== norm_(muatan.namaJurnal)) {
      return { ok: false, message: 'Usulan ini bukan milik jurnal Anda.' };
    }

    const statusLama = String(lama.status || '').trim().toUpperCase();
    if (DOI_STATUS_BISA_DIEDIT.indexOf(statusLama) === -1) {
      return {
        ok: false, code: 'TIDAK_BISA_DIEDIT',
        message: 'Usulan berstatus "' + statusLama + '" sudah diproses admin dan tidak bisa diubah lagi. ' +
                 'Hubungi DJPI bila ada yang perlu diperbaiki.'
      };
    }

    // Hanya kolom milik pengelola yang ditulis ulang.
    const baru = {
      jenis_objek: String(payload.jenis_objek || 'ARTIKEL').trim().toUpperCase(),
      volume: aman_(payload.volume || ''),
      nomor: aman_(payload.nomor || ''),
      tahun: aman_(payload.tahun || ''),
      judul_artikel: aman_(payload.judul_artikel),
      penulis: aman_(payload.penulis || ''),
      url_landing_page: String(payload.url_landing_page).trim(),
      catatan_pengelola: aman_(payload.catatan_pengelola || ''),
      nama_pemohon: aman_(payload.nama_pemohon),
      whatsapp_pemohon: aman_(String(payload.whatsapp_pemohon).replace(/[\s-]/g, '')),
      jabatan_pemohon: aman_(payload.jabatan_pemohon),
      jenis_konten: String(payload.jenis_konten).trim(),
      jumlah_doi: Number(payload.jumlah_doi),
      tanggal_publikasi: String(payload.tanggal_publikasi).trim()
    };
    // Perbaikan atas permintaan admin masuk kembali ke antrean validasi.
    if (statusLama === 'PERLU_REVISI') baru.status = 'MENUNGGU_VALIDASI';

    var berubah = [];
    Object.keys(baru).forEach(function (nama) {
      var idx = info.peta[nama];
      if (idx === undefined) return;
      var sebelum = barisLama[idx];
      if (String(sebelum) === String(baru[nama])) return;
      sheet.getRange(barisKe, idx + 1).setValue(baru[nama]);
      berubah.push(nama);
    });
    SpreadsheetApp.flush();

    catatAktivitas_(pelakuEdit_(muatan), muatan.namaJurnal, aksiEdit_(muatan, 'EDIT_USULAN_DOI'),
      idCari + ' — ' + (berubah.length ? berubah.join(', ') : 'tidak ada perubahan') +
      (baru.status ? ' | status ' + statusLama + ' -> ' + baru.status : ''));

    const rowBaru = sheet.getRange(barisKe, 1, 1, info.lebar).getValues()[0];
    return {
      ok: true,
      message: berubah.length
        ? ('Usulan ' + idCari + ' diperbarui.' +
           (baru.status ? ' Status kembali ke Menunggu Validasi.' : ''))
        : 'Tidak ada perubahan yang perlu disimpan.',
      item: barisDoiKeObjek_(info, rowBaru)
    };
  } catch (err) {
    return { ok: false, message: 'Gagal memperbarui: ' + err.message };
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

  var pelaku = sesi ? sesi.email : pelakuEdit_(edit);
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
      aman_(pelakuEdit_(muatan)), aman_(muatan.namaJurnal), aman_(edisi), status, aman_(catatan)
    ]);
    SpreadsheetApp.flush();

    catatAktivitas_(pelakuEdit_(muatan), muatan.namaJurnal, aksiEdit_(muatan, 'LAPOR_PROGRESS_TERBITAN'),
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
  // getDashboardDataForAdmin gagal total.
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
   24 & 26. IMPOR COVER DARI EJOURNAL.UPI.EDU -- DIHAPUS
   --------------------------------------------------------------------------
   Pengelolaan cover jurnal dipindahkan ke Litabmas, jadi perkakas impor
   sekali-jalan di sini tidak dipakai lagi:

     section 24  _IMPOR_PROFIL_JURNAL_, _PILOT_COVER_BASE64_,
                 imporCoverDanScope, imporProfilJurnalDariForm,
                 imporCoverBase64Pilot, dan pembantu pencocokan judulnya
     section 26  _COVER_DRAFT_BATCH_1/2/3_ berisi 107 cover base64,
                 imporCoverDraftBatch1/2/3

   Keduanya memuat 1,79 MB data gambar base64 yang membuat setiap clasp push
   mengirim ulang seluruh berkas. Kodenya masih utuh di commit 187518e kalau
   sewaktu-waktu diperlukan: git show 187518e:Code.js

   Yang TETAP ADA: section 25 gerbang draft-review profil jurnal (dipakai
   JavaScript.html), serta kolom Cover URL di Sheet1 yang dibaca Landing.
   Nomor 24 dan salah satu 26 sengaja dibiarkan kosong sebagai jejak.
   ========================================================================== */

/* ==========================================================================
   25. DRAFT & REVIEW PROFIL JURNAL (COVER/SCOPE)
   --------------------------------------------------------------------------
   Pengelola tidak pernah menulis langsung ke Cover URL/Scope yang tayang di
   direktori publik — mereka menulis ke Cover URL (Draft)/Scope (Draft) lewat
   simpanPerubahanJurnal() (lihat wiring statusDraftProfil di sana), lalu
   SUPERADMIN meninjau dan menyetujui/menolak lewat tiga fungsi di bawah.

   KENAPA ADA GERBANG INI: sesi kerja yang menghasilkan modul ini menemukan
   3 dari 211 halaman jurnal sumber luar (ejournal.upi.edu) ternyata berisi
   spam judi online yang menyamar sebagai deskripsi jurnal. Kalau nanti
   pengelola bisa submit sendiri, konten publik tidak boleh tayang otomatis
   tanpa mata manusia memeriksa — pola yang sama seperti alur Usulan DOI
   (section 14 area, cariBarisSheet_/simpanPerubahanJurnal) yang sudah lama
   dipegang project ini: token menentukan identitas, bukan payload client.
   ========================================================================== */

/**
 * Jalankan SEKALI dari editor Apps Script (superadmin) sebelum fitur draft
 * profil dipakai — memastikan 4 kolom barunya ada di Sheet1. Aman diulang.
 */
function siapkanKolomProfilDraft() {
  var sh = sheetWajib_(SHEET.MAIN);
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  pastikanKolomAda_(sh, header, 'Cover URL (Draft)');
  pastikanKolomAda_(sh, header, 'Scope (Draft)');
  pastikanKolomAda_(sh, header, 'Status Draft Profil');
  pastikanKolomAda_(sh, header, 'Catatan Penolakan Draft');
  var pesan = 'Kolom draft profil jurnal siap: Cover URL (Draft), Scope (Draft), Status Draft Profil, Catatan Penolakan Draft.';
  console.log(pesan);
  return pesan;
}

/** Daftar draft menunggu review. WAJIB token 'session_' DAN superadmin. */
function getDraftProfilJurnal(token) {
  var profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();
  if (!profile.isSuperadmin) return { ok: false, message: 'Hanya superadmin yang dapat meninjau draft profil jurnal.' };

  try {
    var semua = bacaDataJurnal_();
    var items = semua
      .filter(function (j) { return j.statusDraftProfil === STATUS_DRAFT_PROFIL.MENUNGGU; })
      .map(function (j) {
        return {
          namaJurnal: j.namaJurnal,
          kluster: j.kluster,
          coverUrlDraft: j.coverUrlDraft,
          scopeDraft: j.scopeDraft,
          coverUrl: j.coverUrl,
          scope: j.scope
        };
      });
    return { ok: true, items: items };
  } catch (err) {
    return { ok: false, message: 'Gagal memuat draft profil jurnal: ' + err.message };
  }
}

/**
 * Setujui satu draft: salin draft -> live (field yang non-kosong saja),
 * lalu kosongkan draft + status + catatan. WAJIB token 'session_' DAN
 * superadmin.
 */
function setujuiDraftProfilJurnal(token, namaJurnal) {
  var profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();
  if (!profile.isSuperadmin) return { ok: false, message: 'Hanya superadmin yang dapat menyetujui draft profil jurnal.' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };

  try {
    var sh = sheetWajib_(SHEET.MAIN);
    var temu = cariBarisSheet_(sh, namaJurnal);
    if (temu.baris.length === 0) return { ok: false, message: 'Jurnal tidak ditemukan.' };
    if (temu.baris.length > 1) return { ok: false, message: 'Nama jurnal ganda, hubungi administrator.' };

    var barisKe = temu.baris[0];
    var rowArr = temu.barisData[barisKe];
    var mapDraft = temu.map;

    var coverDraft = str_(rowArr[mapDraft.coverUrlDraft]);
    var scopeDraft = str_(rowArr[mapDraft.scopeDraft]);
    if (!coverDraft && !scopeDraft) {
      return { ok: false, message: 'Tidak ada draft untuk jurnal ini.' };
    }

    if (coverDraft) sh.getRange(barisKe, mapDraft.coverUrl + 1).setValue(coverDraft);
    if (scopeDraft) sh.getRange(barisKe, mapDraft.scope + 1).setValue(scopeDraft);
    sh.getRange(barisKe, mapDraft.coverUrlDraft + 1).setValue('');
    sh.getRange(barisKe, mapDraft.scopeDraft + 1).setValue('');
    sh.getRange(barisKe, mapDraft.statusDraftProfil + 1).setValue(STATUS_DRAFT_PROFIL.KOSONG);
    sh.getRange(barisKe, mapDraft.catatanTolakDraft + 1).setValue('');
    SpreadsheetApp.flush();

    catatAktivitas_(profile.email, namaJurnal, 'SETUJUI_DRAFT_PROFIL',
      (coverDraft ? 'cover ' : '') + (scopeDraft ? 'scope' : ''));
    bersihkanCacheJurnal_();

    return { ok: true, message: 'Draft profil "' + namaJurnal + '" disetujui dan tayang.' };
  } catch (err) {
    return { ok: false, message: 'Gagal menyetujui draft: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Tolak satu draft: draft TETAP tersimpan (supaya pengelola tidak kehilangan
 * kerjaan), status -> DITOLAK, catatan alasan ditulis untuk dibaca pengelola.
 * WAJIB token 'session_' DAN superadmin. `catatan` wajib diisi.
 */
function tolakDraftProfilJurnal(token, namaJurnal, catatan) {
  var profile = bacaToken_(token, 'session_');
  if (!profile) return sesiHabis_();
  if (!profile.isSuperadmin) return { ok: false, message: 'Hanya superadmin yang dapat menolak draft profil jurnal.' };

  var alasan = str_(catatan);
  if (!alasan) return { ok: false, message: 'Alasan penolakan wajib diisi.' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, message: 'Sistem sedang sibuk. Coba lagi beberapa saat.' };

  try {
    var sh = sheetWajib_(SHEET.MAIN);
    var temu = cariBarisSheet_(sh, namaJurnal);
    if (temu.baris.length === 0) return { ok: false, message: 'Jurnal tidak ditemukan.' };
    if (temu.baris.length > 1) return { ok: false, message: 'Nama jurnal ganda, hubungi administrator.' };

    var barisKe = temu.baris[0];
    var mapDraft = temu.map;

    sh.getRange(barisKe, mapDraft.statusDraftProfil + 1).setValue(STATUS_DRAFT_PROFIL.DITOLAK);
    sh.getRange(barisKe, mapDraft.catatanTolakDraft + 1).setValue(aman_(alasan));
    SpreadsheetApp.flush();

    catatAktivitas_(profile.email, namaJurnal, 'TOLAK_DRAFT_PROFIL', alasan);
    bersihkanCacheJurnal_();

    return { ok: true, message: 'Draft profil "' + namaJurnal + '" ditolak.' };
  } catch (err) {
    return { ok: false, message: 'Gagal menolak draft: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/* ==========================================================================
   27. MODUL KESIAPAN AKREDITASI (Grup D — algoritma 9 & 10)
   --------------------------------------------------------------------------
   Semua dihitung di server dari data yang SUDAH ada:
     - Sheet1  : statusAkreditasi, masaBerlakuSk, tanggalExpired, timeliness,
                 issue, artikelPerIssue, artikelPerTahun, statusOjs,
                 eIssn/pIssn/issn, coverUrl, scope
     - j.doajStatus    : hasil Verifikasi_DOAJ (sudah menempel di bacaDataJurnal_)
     - Jurnal_Unggulan : rata-rata sitasi/artikel OpenAlex -> percentil di antara jurnal UPI
     - Usulan_DOI      : nama jurnal dengan status BERHASIL -> penanda DOI aktif

   Keluaran per jurnal (dilekatkan di getDashboardDataForAdmin):
     j.akreditasi = {
       kedaluwarsa : { sumber, tanggalIso, tahun, bulanTersisa, bucket, label },
       kesiapan    : { skor, checklist:[{k,label,lulus,nilai,bobot}], lulus, gagal, perluCek },
       kandidat    : { relevan, jenis:'baru'|'naik'|'', skor, alasan:[], penghambat:[] }
     }
   Ubah bobot checklist di BOBOT_KESIAPAN; ambang bucket di AKR_BUCKET.
   ========================================================================== */

var BOBOT_KESIAPAN = {
  terbitTepatWaktu: 25,
  volumeArtikel:    20,
  ojsModern:        15,
  doiAktif:         12,
  issnSah:          10,
  terindeksDoaj:    10,
  profilPublik:      8
};

/** Ambang bucket kedaluwarsa SK, dalam bulan tersisa. */
var AKR_BUCKET = { kritis: 3, dekat: 6, pantau: 12 };

/** Selisih bulan dari a ke b (b - a), dibulatkan ke bawah; bisa negatif. */
function selisihBulan_(a, b) {
  var m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m -= 1;
  return m;
}

function tanggalSah_(y, mo, d) {
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  var t = new Date(y, mo - 1, d);
  return isNaN(t.getTime()) ? null : t;
}

/**
 * Parser tanggal toleran: Date asli dari sheet, ISO (yyyy-mm-dd),
 * dd/mm/yyyy, dd-mm-yyyy, atau "30 November 2026" / "30 Nov 2026".
 */
function bacaTanggalLonggar_(nilai) {
  if (nilai instanceof Date && !isNaN(nilai.getTime())) return nilai;
  var s = String(nilai == null ? '' : nilai).trim();
  if (!s || placeholder_(s)) return null;

  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return tanggalSah_(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return tanggalSah_(+m[3], +m[2], +m[1]);

  m = norm_(s).match(/\b(\d{1,2})\s+([A-Z]+)\s+((?:19|20)\d{2})\b/);
  if (m) {
    for (var i = 0; i < BULAN.length; i++) {
      if (BULAN[i].pola.test(m[2])) return tanggalSah_(+m[3], i + 1, +m[1]);
    }
  }
  return null;
}

/**
 * Menafsirkan kedaluwarsa SK akreditasi.
 * Prioritas TANGGAL EXPIRED bila memuat tanggal sah -> hitung mundur bulanan.
 * Jatuh ke tahun 4-digit dari MASA BERLAKU SK -> anggap berakhir 31 Des tahun itu.
 */
function parseKedaluwarsaSk_(tanggalExpired, masaBerlakuSk) {
  var hasil = { sumber: '', tanggalIso: '', tahun: null, bulanTersisa: null, bucket: 'takTerbaca', label: '' };
  var sekarang = new Date();

  var tgl = bacaTanggalLonggar_(tanggalExpired);
  if (tgl) {
    hasil.sumber = 'tanggal';
    hasil.tanggalIso = Utilities.formatDate(tgl, TZ, 'yyyy-MM-dd');
    hasil.tahun = tgl.getFullYear();
    hasil.bulanTersisa = selisihBulan_(sekarang, tgl);
  } else if (placeholder_(masaBerlakuSk)) {
    hasil.bucket = 'kosong';
    hasil.label = 'Masa berlaku SK belum tercatat';
    return hasil;
  } else {
    var thn = (norm_(masaBerlakuSk).match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
    if (!thn.length) {
      hasil.label = 'Masa berlaku SK tidak terbaca sebagai tahun';
      return hasil;
    }
    hasil.sumber = 'tahun';
    hasil.tahun = Math.max.apply(null, thn);
    hasil.bulanTersisa = selisihBulan_(sekarang, new Date(hasil.tahun, 11, 31));
  }

  var b = hasil.bulanTersisa;
  var kapan = hasil.tanggalIso || String(hasil.tahun);
  if (b < 0)                       { hasil.bucket = 'lewat';  hasil.label = 'SK terlewat ' + Math.abs(b) + ' bulan lalu'; }
  else if (b <= AKR_BUCKET.kritis) { hasil.bucket = 'kritis'; hasil.label = 'Kedaluwarsa dalam ' + b + ' bulan'; }
  else if (b <= AKR_BUCKET.dekat)  { hasil.bucket = 'dekat';  hasil.label = 'Kedaluwarsa dalam ' + b + ' bulan'; }
  else if (b <= AKR_BUCKET.pantau) { hasil.bucket = 'pantau'; hasil.label = 'Kedaluwarsa dalam ' + b + ' bulan'; }
  else                             { hasil.bucket = 'aman';   hasil.label = 'Masih ' + b + ' bulan (' + kapan + ')'; }
  return hasil;
}

/** Jumlah issue per tahun dari kolom "ISSUE" (frekuensi terbit). */
function issuePerTahun_(issue) {
  var s = norm_(issue);
  if (!s || placeholder_(s)) return null;
  if (/BULANAN|MONTHLY/.test(s)) return 12;
  if (/DWI\s*BULAN|BIMONTH/.test(s)) return 6;
  if (/TRIWULAN|KUARTAL|QUARTER/.test(s)) return 4;
  if (/TENGAH\s*TAHUN|SEMESTER|SEMIANNUAL|DUA\s*KALI|2\s*KALI/.test(s)) return 2;
  if (/TAHUNAN|ANNUAL|SEKALI\s*SETAHUN|SETAHUN\s*SEKALI/.test(s)) return 1;
  var n = parseInt(s.replace(/[^0-9]/g, ''), 10);
  return (n >= 1 && n <= 24) ? n : null;
}

/** Set nama jurnal (ternormalisasi) yang punya minimal satu usulan DOI BERHASIL. */
function bacaJurnalPunyaDoi_() {
  try {
    var sh = sheetOpsional_(DOI_SHEET_NAME);
    if (!sh) return {};
    var nilai = sh.getDataRange().getValues();
    if (nilai.length < 2) return {};
    var header = nilai[0].map(function (h) { return String(h).trim(); });
    var iNama = header.indexOf('nama_jurnal');
    var iStatus = header.indexOf('status');
    if (iNama === -1 || iStatus === -1) return {};
    var set = {};
    for (var r = 1; r < nilai.length; r++) {
      if (String(nilai[r][iStatus]).trim().toUpperCase() === 'BERHASIL') set[norm_(nilai[r][iNama])] = true;
    }
    return set;
  } catch (e) { return {}; }
}

function petaUnggulan_(topJournals) {
  var peta = {};
  (topJournals || []).forEach(function (t) { if (t.namaJurnal) peta[norm_(t.namaJurnal)] = t; });
  return peta;
}

/** Percentil (0..1) rata-rata sitasi/artikel OpenAlex di antara jurnal yang punya data. */
function percentilSitasi_(topJournals) {
  var arr = (topJournals || [])
    .map(function (t) { return { nama: norm_(t.namaJurnal), v: angka_(t.rataSitasiPerArtikel_OpenAlex) }; })
    .filter(function (x) { return x.nama; });
  arr.sort(function (a, b) { return a.v - b.v; });
  var peta = {}, n = arr.length;
  arr.forEach(function (x, i) { peta[x.nama] = n > 1 ? i / (n - 1) : 1; });
  return peta;
}

/** Checklist kesiapan akreditasi satu jurnal + skor berbobot 0..100. */
function nilaiKesiapanAkreditasi_(j, ctx) {
  ctx = ctx || {};
  var checklist = [];
  function item(k, label, lulus, nilai) {
    checklist.push({ k: k, label: label, lulus: lulus, nilai: String(nilai == null ? '' : nilai), bobot: BOBOT_KESIAPAN[k] || 0 });
  }

  // 1. Terbit tepat waktu (Belum Dinilai -> perlu dicek)
  var kt = j.kategoriTimeliness;
  item('terbitTepatWaktu', 'Terbit tepat waktu',
    kt === 'Tepat Waktu' ? true : (kt === 'Belum Dinilai' ? null : false), kt);

  // 2. Volume artikel memadai: realisasi/terdaftar >= kapasitas (artikelPerIssue x issue/tahun)
  var perIssue = angka_(j.artikelPerIssue);
  var perTahun = angka_(j.artikelPerTahun);
  var ipt = issuePerTahun_(j.issue);
  var kapasitas = (perIssue && ipt) ? perIssue * ipt : null;
  var vLulus, vNilai;
  if (!perTahun && !kapasitas) { vLulus = null; vNilai = 'jumlah artikel & frekuensi belum tercatat'; }
  else if (kapasitas) {
    var acuan = perTahun || kapasitas;
    vLulus = acuan >= Math.ceil(kapasitas * 0.8);
    vNilai = acuan + '/tahun vs kapasitas ' + perIssue + ' x ' + ipt + ' = ' + kapasitas;
  } else {
    vLulus = perTahun >= 20;
    vNilai = perTahun + '/tahun (frekuensi terbit belum tercatat)';
  }
  item('volumeArtikel', 'Volume artikel memadai', vLulus, vNilai);

  // 3. OJS 3.x
  item('ojsModern', 'Sudah OJS 3.x', !!j.sudahMigrasi, j.statusOjs || 'status OJS belum tercatat');

  // 4. DOI aktif
  var namaN = norm_(j.namaJurnal);
  var punyaDoi = !!(ctx.doiSet && ctx.doiSet[namaN]);
  var unggul = ctx.unggulanMap && ctx.unggulanMap[namaN];
  if (!punyaDoi && unggul && angka_(unggul.totalArtikel) > 0) punyaDoi = true;
  item('doiAktif', 'DOI aktif',
    punyaDoi ? true : ((ctx.doiSet || ctx.unggulanMap) ? false : null),
    punyaDoi ? 'terdaftar di Crossref / usulan DOI berhasil' : 'belum terdeteksi ber-DOI');

  // 5. ISSN sah
  var issnOk = j.eIssnValid || j.issnValid || (j.pIssnValid && !placeholder_(j.pIssn));
  item('issnSah', 'ISSN sah', !!issnOk, j.eIssn || j.issn || j.pIssn || '—');

  // 6. Terindeks DOAJ
  var dj = j.doajStatus;
  item('terindeksDoaj', 'Terindeks DOAJ',
    dj === 'TERINDEKS' ? true : (dj === 'TIDAK DITEMUKAN' ? false : (j.terindeksDoaj ? true : null)),
    dj === 'TERINDEKS' ? (j.doajJudul || 'terverifikasi DOAJ')
      : (dj === 'TIDAK DITEMUKAN' ? 'ISSN tidak ditemukan di DOAJ'
      : (j.terindeksDoaj ? 'ada tautan DOAJ (belum diverifikasi)' : 'belum dicek')));

  // 7. Profil publik lengkap (scope + cover)
  var adaScope = !placeholder_(j.scope);
  var adaCover = urlValid_(j.coverUrl) || String(j.coverUrl || '').indexOf('data:image') === 0;
  item('profilPublik', 'Profil publik lengkap',
    (adaScope && adaCover) ? true : ((adaScope || adaCover) ? null : false),
    (adaScope ? 'scope ada' : 'scope kosong') + ' + ' + (adaCover ? 'cover ada' : 'cover kosong'));

  var totBobot = 0, dapat = 0, lulus = 0, gagal = 0, perluCek = 0;
  checklist.forEach(function (c) {
    totBobot += c.bobot;
    if (c.lulus === true) { dapat += c.bobot; lulus++; }
    else if (c.lulus === null) { dapat += c.bobot * 0.5; perluCek++; }
    else gagal++;
  });

  return {
    skor: totBobot ? Math.round((dapat / totBobot) * 100) : 0,
    checklist: checklist,
    lulus: lulus, gagal: gagal, perluCek: perluCek
  };
}

/** Objek akreditasi lengkap satu jurnal: kedaluwarsa + kesiapan + kandidat. */
function akreditasiJurnal_(j, ctx) {
  var kedaluwarsa = j.terakreditasi
    ? parseKedaluwarsaSk_(j.tanggalExpired, j.masaBerlakuSk)
    : { sumber: '', tanggalIso: '', tahun: null, bulanTersisa: null, bucket: 'takRelevan', label: 'Belum terakreditasi' };

  var kesiapan = nilaiKesiapanAkreditasi_(j, ctx);

  var kandidat = { relevan: false, jenis: '', skor: 0, alasan: [], penghambat: [] };
  kesiapan.checklist.forEach(function (c) {
    if (c.lulus === true) kandidat.alasan.push(c.label);
    else if (c.lulus === false) kandidat.penghambat.push(c.label);
  });
  var sitP = (ctx.percentilSitasi && ctx.percentilSitasi[norm_(j.namaJurnal)]) || 0;
  var skorGabung = Math.round(kesiapan.skor * 0.7 + sitP * 100 * 0.3);

  if (!j.terakreditasi) {
    kandidat.relevan = true; kandidat.jenis = 'baru'; kandidat.skor = skorGabung;
  } else if (j.peringkatSinta >= 3 && j.peringkatSinta <= 6 && kesiapan.skor >= 70) {
    kandidat.relevan = true; kandidat.jenis = 'naik'; kandidat.skor = skorGabung;
  }

  return { kedaluwarsa: kedaluwarsa, kesiapan: kesiapan, kandidat: kandidat };
}

/** Rekap tab Akreditasi: kalender reakreditasi, prioritas darurat, kandidat. */
function rekapAkreditasi_(daftar) {
  function ringkas(j) {
    return {
      namaJurnal: j.namaJurnal, kluster: j.kluster,
      statusAkreditasi: j.statusAkreditasi, peringkatSinta: j.peringkatSinta,
      kedaluwarsa: j.akreditasi.kedaluwarsa,
      skor: j.akreditasi.kesiapan.skor,
      lulus: j.akreditasi.kesiapan.lulus,
      gagal: j.akreditasi.kesiapan.gagal,
      perluCek: j.akreditasi.kesiapan.perluCek,
      alasan: j.akreditasi.kandidat.alasan.slice(0, 4),
      penghambat: j.akreditasi.kandidat.penghambat.slice(0, 4),
      jenisKandidat: j.akreditasi.kandidat.jenis,
      skorKandidat: j.akreditasi.kandidat.skor
    };
  }
  function byBulan(a, b) {
    return (a.kedaluwarsa.bulanTersisa == null ? 999 : a.kedaluwarsa.bulanTersisa) -
           (b.kedaluwarsa.bulanTersisa == null ? 999 : b.kedaluwarsa.bulanTersisa);
  }

  var terakreditasi = daftar.filter(function (j) { return j.terakreditasi; });

  var kalender = { jadwal: [], lewat: 0, kritis: 0, dekat: 0, pantau: 0, takTerbaca: 0, kosong: 0,
                   totalTerakreditasi: terakreditasi.length };
  terakreditasi.forEach(function (j) {
    var b = j.akreditasi.kedaluwarsa.bucket;
    if (b === 'lewat' || b === 'kritis' || b === 'dekat' || b === 'pantau') {
      kalender[b]++;
      kalender.jadwal.push(ringkas(j));
    } else if (b === 'takTerbaca') kalender.takTerbaca++;
    else if (b === 'kosong') kalender.kosong++;
  });
  kalender.jadwal.sort(byBulan);

  var darurat = terakreditasi.filter(function (j) {
    var b = j.akreditasi.kedaluwarsa.bucket;
    return (b === 'lewat' || b === 'kritis' || b === 'dekat') && j.akreditasi.kesiapan.skor < 60;
  }).map(ringkas).sort(function (x, y) { return byBulan(x, y) || (x.skor - y.skor); });

  var kandidatBaru = daftar.filter(function (j) { return j.akreditasi.kandidat.jenis === 'baru'; })
    .map(ringkas).sort(function (x, y) { return y.skorKandidat - x.skorKandidat; });
  var kandidatNaik = daftar.filter(function (j) { return j.akreditasi.kandidat.jenis === 'naik'; })
    .map(ringkas).sort(function (x, y) { return y.skorKandidat - x.skorKandidat; });

  var distribusi = { '0-39': 0, '40-59': 0, '60-79': 0, '80-100': 0 };
  terakreditasi.forEach(function (j) {
    var s = j.akreditasi.kesiapan.skor;
    if (s < 40) distribusi['0-39']++;
    else if (s < 60) distribusi['40-59']++;
    else if (s < 80) distribusi['60-79']++;
    else distribusi['80-100']++;
  });

  return {
    kalender: kalender,
    darurat: darurat,
    kandidatBaru: kandidatBaru,
    kandidatNaik: kandidatNaik,
    distribusi: distribusi,
    bobot: BOBOT_KESIAPAN
  };
}

/** Melekatkan j.akreditasi ke setiap jurnal terlihat. Dipanggil dari getDashboardDataForAdmin. */
function lekatkanAkreditasi_(terlihat) {
  var sitasi = {};
  try { sitasi = bacaDataSitasi_() || {}; } catch (e) { sitasi = {}; }
  var ctx = {
    doiSet: bacaJurnalPunyaDoi_(),
    unggulanMap: petaUnggulan_(sitasi.topJournals),
    percentilSitasi: percentilSitasi_(sitasi.topJournals)
  };
  terlihat.forEach(function (j) { j.akreditasi = akreditasiJurnal_(j, ctx); });
}


/* ==========================================================================
   28. PERSIAPAN AKREDITASI PENGELOLA (Kepdirjen 374/2026)
   --------------------------------------------------------------------------
   Alat swa-penilaian untuk pengelola jurnal, selaras Petunjuk Teknis
   Akreditasi Jurnal Ilmiah (Kepdirjen 374/DST/D.D1/HM.01.01/2026, penjabaran
   Permendiktisaintek No. 9 Tahun 2026).

   n total = 0-100 = Tata Kelola (0-46) + Mutu Artikel (0-54).
   Peringkat: 1 (90-100) . 2 (80-<90) . 3 (70-<80) . 4 (60-<70) . <60 tidak
   terakreditasi. Masa berlaku 5 tahun; akreditasi ulang wajib diajukan paling
   lambat 6 bulan sebelum masa berlaku berakhir.

   RUANG LINGKUP:
     - Syarat Tahap 1 (8 butir gerbang, Ya/Tidak).
     - Seluruh unit Tata Kelola A-E dengan rubrik resmi -> proyeksi progres /46.
     - Mutu Artikel F/G: panduan + checklist "sudah dicek", TIDAK diskor
       (dinilai asesor per-artikel pada sampel).
   Output hanya PERSENTASE KESIAPAN, tidak dikonversi ke Peringkat/nilai n.

   Sumber data: input mandiri pengelola. Prefill ringan dari direktori DJPI,
   Crossref/OpenAlex, dan DOAJ (UrlFetchApp ke *.upi.edu diblokir Cloudflare -
   lihat section 24 - jadi tidak ada penarikan data OJS otomatis).

   Endpoint (token wajib 'edit_', terikat satu nama jurnal):
     gs('getPersiapanAkreditasi', token)
     gs('simpanPersiapanAkreditasi', token, payload)
   ========================================================================== */

var SHEET_PERSIAPAN_AKREDITASI = 'Persiapan_Akreditasi';

var PERSIAPAN_AKR_HEADER = [
  'Nama Jurnal', 'Email Pengelola', 'Jenis Pengajuan', 'Tanggal Berakhir SK',
  'Jawaban (JSON)', 'Nilai Tata Kelola (dari 46)', 'Syarat Gerbang Terpenuhi', 'Terakhir Disimpan'
];

/* -- Syarat Tahap 1: gerbang, semua wajib "ya" --------------------------- */
var AKR_SYARAT_TAHAP1 = [
  { k: 's1', berlaku: 'semua', label: 'e-ISSN valid & identitas ilmiah',
    deskripsi: 'Nama jurnal dan penerbit bersifat ilmiah serta identik dengan data pada Portal ISSN.' },
  { k: 's2b', berlaku: 'baru', label: 'Terbit minimal 3 tahun berturut-turut',
    deskripsi: 'Jurnal telah terbit sekurang-kurangnya 3 tahun berturut-turut, dihitung mundur dari tanggal pengajuan.' },
  { k: 's2u', berlaku: 'ulang', label: 'Tiga nomor terbitan terakhir lengkap',
    deskripsi: 'Tiga nomor terbitan terakhir tersedia lengkap dan dapat diakses. Pada reakreditasi, ' +
      'ketiga nomor inilah yang dinilai asesor — berbeda dari akreditasi baru yang dinilai ' +
      'atas terbitan 3 tahun terakhir.' },
  { k: 's3', berlaku: 'semua', label: 'Frekuensi & isi terbitan',
    deskripsi: 'Frekuensi sesuai e-ISSN, terbit sedikitnya 2 kali setahun, dan setiap terbitan memuat sedikitnya 5 artikel.' },
  { k: 's4', berlaku: 'semua', label: 'Laman editor & mitra bestari',
    deskripsi: 'Laman editor dan laman mitra bestari tersedia terpisah; editor dari minimal 2 afiliasi berbeda, reviewer dari minimal 4 afiliasi berbeda.' },
  { k: 's5', berlaku: 'semua', label: 'Kebijakan etika publikasi (COPE)',
    deskripsi: 'Laman jurnal mencantumkan kebijakan etika publikasi yang mengacu pada COPE.' },
  { k: 's6', berlaku: 'semua', label: 'Informasi biaya penulis (APC)',
    deskripsi: 'Kebijakan biaya penulis / APC disajikan di laman jurnal, walaupun nol.' },
  { k: 's7', berlaku: 'semua', label: 'Akun editor dapat diakses',
    deskripsi: 'Username dan password akun editor dapat login dan memiliki peran editor (untuk verifikasi asesor).' },
  { k: 's8', berlaku: 'semua', label: 'DOI aktif & full text',
    deskripsi: 'DOI aktif dan setiap artikel tersedia lengkap dengan berkas PDF yang dapat diakses.' }
];

/* -- Tata Kelola: 14 unit, maks 46 -------------------------------------- */
var AKR_TATA_KELOLA = [
  { k: 'A', nama: 'Konsistensi Identitas Jurnal', maks: 2,
    levels: [
      { n: 2, l: 'Unik & spesifik sesuai bidang ilmu; konsisten di laman, metadata artikel, dan galley PDF; sesuai data ISSN.' },
      { n: 1, l: 'Kurang unik / kurang spesifik; masih umum; konsistensi belum penuh.' },
      { n: 0, l: 'Tidak unik / mirip jurnal lain / memakai nama institusi atau lokasi / tidak sesuai ISSN.' }
    ] },
  { k: 'B.1', nama: 'Komposisi, rekam jejak, & keberagaman asal Mitra Bestari', maks: 6,
    catatan: 'Dinilai pada 3 tahun terakhir. Editor & reviewer tidak boleh rangkap jabatan. AI dilarang untuk proses review.',
    levels: [
      { n: 6, l: 'Reviewer dari >= 5 negara, >= 3 reviewer per naskah, ada bukti telaah.' },
      { n: 4, l: 'Reviewer dari >= 6 institusi di 3 negara atau >= 8 institusi, >= 2 reviewer per naskah, ada bukti telaah.' },
      { n: 2, l: 'Rekam jejak nasional, >= 6 institusi, >= 2 reviewer per naskah.' },
      { n: 1, l: 'Rekam jejak nasional, >= 4 institusi, >= 2 reviewer per naskah.' },
      { n: 0, l: 'Reviewer tidak aktif dan/atau tidak ada bukti telaah substantif.' }
    ] },
  { k: 'B.2', nama: 'Mutu penyuntingan substansi oleh Mitra Bestari', maks: 4,
    catatan: 'Dinilai pada terbitan 3 tahun terakhir. Fokus pada isi, bukan bahasa. Tanpa bukti = tanpa review.',
    levels: [
      { n: 4, l: 'Komentar substantif & signifikan, saran perbaikan nyata, mutu isi terjaga, konsisten 3 tahun terakhir.' },
      { n: 2, l: 'Komentar kurang substantif, saran perbaikan terbatas, dampak kurang signifikan.' },
      { n: 0, l: 'Komentar hanya menyangkut tata bahasa / layout, tidak menyentuh substansi artikel.' }
    ] },
  { k: 'B.3', nama: 'Pelibatan, komposisi, rekam jejak, & keberagaman asal Tim Penyunting', maks: 5,
    catatan: 'EIC wajib berafiliasi di Indonesia. Nama & afiliasi harus valid & terverifikasi; identitas fiktif / pencatutan -> nilai terendah. Struktur berbasis kualifikasi, bukan ex-officio.',
    levels: [
      { n: 5, l: 'Rekam jejak publikasi internasional & editor dari >= 5 negara.' },
      { n: 3, l: 'Rekam jejak internasional & editor dari >= 2 negara atau >= 6 institusi.' },
      { n: 2, l: 'Rekam jejak nasional & editor dari >= 4 institusi.' },
      { n: 1, l: 'Rekam jejak nasional & editor dari >= 2 institusi.' },
      // Kepdirjen tidak menuliskan level 0 untuk unsur ini, tetapi jurnal yang
      // seluruh penyuntingnya satu institusi tidak punya opsi yang bisa dipilih
      // dan formulirnya jadi mustahil diselesaikan secara jujur.
      { n: 0, l: 'Belum memenuhi level terendah: penyunting berasal dari satu institusi dan/atau rekam jejaknya belum dapat diverifikasi.' }
    ] },
  { k: 'B.4', nama: 'Keberagaman asal Penulis', maks: 6,
    catatan: 'Dilihat per nomor terbitan, 3 tahun terakhir. Afiliasi penulis wajib valid & terverifikasi. Penambahan penulis pasca-accepted tanpa alasan jelas tidak diakui.',
    levels: [
      { n: 6, l: 'Penulis dari >= 5 negara.' },
      { n: 4, l: 'Penulis dari >= 2 negara atau >= 8 institusi.' },
      { n: 2, l: 'Penulis dari >= 4 institusi.' },
      { n: 1, l: 'Penulis dari >= 2 institusi.' },
      { n: 0, l: 'Penulis hanya dari 1 institusi.' }
    ] },
  { k: 'B.5', nama: 'Pengelolaan artikel', maks: 1,
    catatan: 'Metadata harus ramah pengindeks (terbaca mesin). Pengelolaan manual & log aktivitas tak wajar menurunkan penilaian.',
    levels: [
      { n: 1, l: 'Sistem manajemen jurnal daring penuh (submit, review, edit, terbit lewat sistem).' },
      { n: 0.5, l: 'Kombinasi sistem daring + email.' },
      { n: 0, l: 'Pengelolaan via email saja.' }
    ] },
  { k: 'C.1', nama: 'Kejelasan kebijakan proses penelaahan (peer-review)', maks: 2,
    catatan: 'Tautan kebijakan tersedia publik di laman depan. Fast-track yang menjanjikan accepted dilarang; LOA tidak boleh sebelum accepted. Ikuti prinsip COPE.',
    levels: [
      { n: 2, l: 'Semua proses peer-review dijelaskan dengan jelas (tipe review, tahapan, kriteria & kualifikasi reviewer, jumlah reviewer & batas waktu, cek similaritas, keputusan editorial).' },
      { n: 1, l: 'Sebagian proses peer-review dijelaskan.' },
      { n: 0, l: 'Kebijakan tidak tersedia atau prinsip dasarnya tidak dijelaskan.' }
    ] },
  { k: 'C.2', nama: 'Kejelasan petunjuk penulisan bagi penulis (author guidelines)', maks: 1,
    levels: [
      { n: 1, l: 'Rinci, lengkap, jelas, substansif & sistematis; ada di laman jurnal; disertai contoh / template artikel.' },
      { n: 0.5, l: 'Rinci, lengkap, jelas; ada di laman jurnal; tanpa contoh / template.' },
      { n: 0, l: 'Kurang lengkap / kurang jelas; atau template ada tetapi guideline tidak ada.' }
    ] },
  { k: 'C.3', nama: 'Kebijakan penggunaan kecerdasan artifisial (AI)', maks: 1,
    catatan: 'Naskah tidak boleh diunggah ke aplikasi AI. AI bukan penulis. Reviewer dilarang menggunakan AI. Keputusan editorial tetap oleh manusia.',
    levels: [
      { n: 1, l: 'Kebijakan AI tersedia; mewajibkan pengungkapan AI oleh penulis dan oleh tim editor; melarang AI bagi mitra bestari.' },
      { n: 0.5, l: 'Kebijakan tersedia tetapi belum lengkap / hanya mengatur sebagian.' },
      { n: 0, l: 'Kebijakan tidak tersedia atau hanya pernyataan umum tanpa ketentuan AI yang jelas.' }
    ] },
  { k: 'C.4', nama: 'Kelengkapan laman jurnal (16 klausul COPE)', maks: 3, cope: true,
    catatan: 'Dinilai dari persentase pemenuhan 16 klausul COPE Principles of Transparency & Best Practice. Satu tampilan laman tidak boleh bilingual; desain sampul harus khas.',
    levels: [
      { n: 3, l: '100% klausul terpenuhi.' },
      { n: 2, l: '>= 75% dan < 100% klausul terpenuhi.' },
      { n: 1, l: '>= 50% dan < 75% klausul terpenuhi.' },
      { n: 0, l: '< 50% klausul terpenuhi.' }
    ] },
  { k: 'D.1', nama: 'Jadwal penerbitan', maks: 2,
    catatan: 'DILARANG menyisipkan artikel ke nomor terbitan yang sudah resmi terbit (back issue). Naskah diproses berkelanjutan; pra-publikasi (Issue in Progress / Article in Press) diperbolehkan, Abstract Only tidak. Dinilai 3 tahun terakhir.',
    levels: [
      { n: 2, l: 'Memakai Article in Press dan/atau Issue in Progress; seluruh terbitan sesuai periode.' },
      { n: 1.5, l: '> 75% terbitan sesuai periode.' },
      { n: 1, l: '> 25% - 75% terbitan sesuai periode.' },
      { n: 0.5, l: '<= 25% terbitan sesuai periode.' },
      { n: 0, l: 'Abstract only dan/atau menyisipkan artikel ke back issue.' }
    ] },
  { k: 'D.2', nama: 'Sistem penomoran volume, nomor terbitan, & halaman / identitas artikel', maks: 1,
    catatan: 'Angka Arab, bukan Romawi. Volume baru diawali halaman 1. Identitas artikel (article ID) boleh menggantikan nomor halaman. Dinilai 3 tahun terakhir.',
    levels: [
      { n: 1, l: 'Bersistem baik dan konsisten.' },
      { n: 0.5, l: 'Cukup baik dan/atau cukup konsisten.' },
      { n: 0, l: 'Kurang baik dan/atau kurang konsisten.' }
    ] },
  { k: 'E.1', nama: 'Dampak ilmiah - jumlah sitasi', maks: 6,
    catatan: 'Data sitasi dari pengindeks internasional atau basis data DOI (Crossref/OpenAlex), 3 tahun terakhir. Pola sitasi tak wajar atau permintaan sitasi oleh editor -> nilai terendah.',
    levels: [
      { n: 6, l: '> 25 sitasi (pengindeks internasional) dan/atau > 75 sitasi (basis data DOI).' },
      { n: 4, l: '20-25 sitasi (pengindeks internasional) dan/atau 31-75 sitasi (basis data DOI).' },
      { n: 3, l: '10-19 sitasi (pengindeks internasional) dan/atau 11-30 sitasi (basis data DOI).' },
      { n: 2, l: '5-9 sitasi (pengindeks internasional) dan/atau 5-10 sitasi (basis data DOI).' },
      { n: 1, l: '< 5 sitasi (pengindeks internasional) dan/atau < 5 sitasi (basis data DOI).' },
      { n: 0, l: 'Jumlah sitasi 3 tahun terakhir tidak dapat diverifikasi memadai.' }
    ] },
  { k: 'E.2', nama: 'Visibilitas - indeksasi', maks: 6,
    catatan: 'Metadata wajib konsisten diunggah. Metadata belum terindeks -> nilai lebih rendah.',
    levels: [
      { n: 6, l: 'Tercantum + metadata terindeks di pengindeks bereputasi internasional (mis. Scopus, Web of Science).' },
      { n: 4, l: 'Tercantum, tetapi metadata belum terindeks di pengindeks bereputasi internasional.' },
      { n: 3, l: 'Tercantum + metadata terindeks di pengindeks internasional/nasional bersistem seleksi (mis. DOAJ).' },
      { n: 2, l: 'Tercantum, tetapi metadata belum terindeks di pengindeks bersistem seleksi.' },
      { n: 1, l: 'Tercantum + metadata terindeks di pengindeks tanpa sistem seleksi (mis. Google Scholar).' },
      // Sama seperti B.3: tanpa level 0, jurnal yang belum terindeks di mana pun
      // tidak punya jawaban yang benar.
      { n: 0, l: 'Belum memenuhi level terendah: belum tercantum di pengindeks mana pun.' }
    ] }
];

/* -- Tahap 2: apa yang diperiksa ARJUNA (paparan Kepdirjen 374/2026) ----
   Tahap ini dikerjakan ARJUNA, bukan pengelola, jadi tidak ada isian. Butir
   2.1 sudah dijawab pengelola di Tahap 1; butir 2.2 tidak tercakup di sana
   dan perlu diketahui sebelum mengajukan.                                */
var AKR_TAHAP2 = [
  { k: '2.1', nama: 'Pemeriksaan Awal',
    tujuan: 'Memastikan prasyarat formal jurnal terpenuhi.',
    catatan: 'Butir di bawah sudah Anda jawab di Tahap 1.',
    butir: [
      'Validitas laman jurnal, nama jurnal, dan penerbit sesuai ISSN.',
      'Kesesuaian jenis usulan dan waktu pengajuan.',
      'Frekuensi terbit, keberkalaan 3 tahun terakhir, serta pencantuman peringkat dan masa berlaku.',
      'Laman etika publikasi dan informasi biaya pemrosesan artikel.',
      'DOI aktif dan ketersediaan full text setiap artikel.',
      'Keberagaman afiliasi editor dan mitra bestari.',
      'Validitas username/password serta ketersediaan peran editor.'
    ] },
  { k: '2.2', nama: 'Pemeriksaan Kelayakan',
    tujuan: 'Memastikan jurnal layak dinilai akreditasi.',
    catatan: 'Butir ini tidak ada di Tahap 1 dan diperiksa langsung oleh ARJUNA.',
    butir: [
      'Kecukupan penelaahan artikel oleh mitra bestari.',
      'Validitas dan integritas penerbit.',
      'Rekam jejak penerbit serta kepatuhan terhadap etika publikasi dan integritas akademik.',
      'Temuan pelanggaran integritas pada tahap penilaian dapat menjadi dasar untuk meninjau kembali hasil Pemeriksaan Kelayakan.'
    ] }
];

/* -- 16 klausul COPE untuk sub-checklist unit C.4 ---------------------- */
var AKR_COPE = [
  { k: 'a', l: 'ISSN (cetak dan/atau elektronik)' },
  { k: 'b', l: 'Fokus & ruang lingkup (Aim & Scope)' },
  { k: 'c', l: 'Jenis manuskrip yang diterima' },
  { k: 'd', l: 'Jadwal penerbitan' },
  { k: 'e', l: 'Kebijakan akses (open access / lainnya)' },
  { k: 'f', l: 'Informasi kontak redaksi' },
  { k: 'g', l: 'Hak cipta' },
  { k: 'h', l: 'Lisensi' },
  { k: 'i', l: 'Kepemilikan & pengelolaan jurnal' },
  { k: 'j', l: 'Kriteria kepengarangan (authorship)' },
  { k: 'k', l: 'Penanganan pelanggaran riset (research misconduct)' },
  { k: 'l', l: 'Diskusi & koreksi pasca-publikasi' },
  { k: 'm', l: 'Kebijakan koreksi & retraksi' },
  { k: 'n', l: 'Pengarsipan elektronik' },
  { k: 'o', l: 'Kebijakan konflik kepentingan' },
  { k: 'p', l: 'Kebijakan deteksi plagiasi' }
];

/* -- Mutu Artikel: 16 butir panduan, TANPA nilai --------------------- */
var AKR_MUTU_ARTIKEL = [
  { k: 'F.1', nama: 'Judul artikel',
    rubrik: 'Lugas, spesifik, informatif; memuat temuan penting; menggambarkan isi. Artikel berbahasa Indonesia: judul Bahasa Indonesia + Inggris. Lokasi riset dicantumkan bila relevan.' },
  { k: 'F.2', nama: 'Abstrak',
    rubrik: 'Ringkas, jelas, utuh; memuat tujuan, metode, hasil, dan simpulan; tanpa rujukan, gambar, atau tabel. Artikel berbahasa Indonesia: abstrak Bahasa Indonesia + Inggris.' },
  { k: 'F.3', nama: 'Kata kunci',
    rubrik: 'Kata atau frasa yang mencerminkan konsep penting isi artikel, dipilih cermat dan baku, memudahkan penelusuran mesin pencari.' },
  { k: 'F.4', nama: 'Kepioniran ilmiah, orisinalitas, kontribusi kebaruan & analisis kesenjangan',
    rubrik: 'Pendahuluan memuat state of the art memadai, justifikasi kebaruan / research gap yang jelas, dan tujuan riset dinyatakan tegas. Original research diutamakan.' },
  { k: 'F.5', nama: 'Analisis & sintesis',
    rubrik: 'Metode sesuai & mencukupi; temuan penting dijelaskan tajam dengan data jelas; interpretasi pembahasan mendalam & akurat; dibandingkan kritis dengan teori / riset lain yang relevan & mutakhir.' },
  { k: 'F.6', nama: 'Penyimpulan',
    rubrik: 'Simpulan menjawab tujuan riset, mempertegas temuan penting, dapat memuat implikasi / rekomendasi / saran lanjut; hindari pembahasan baru di simpulan.' },
  { k: 'F.7', nama: 'Nisbah sumber acuan primer',
    rubrik: 'Minimal 15 rujukan per artikel; sebagian besar (idealnya > 80%) acuan primer: jurnal, prosiding, tesis/disertasi/skripsi, manuskrip, monograf riset.' },
  { k: 'F.8', nama: 'Derajat kemutakhiran pustaka acuan',
    rubrik: 'Idealnya > 80% rujukan terbit dalam 10 tahun terakhir. Pustaka klasik boleh untuk sumber masalah / keterkaitan teori, bukan untuk pembandingan utama hasil atau justifikasi kebaruan.' },
  { k: 'F.9', nama: 'Cakupan keilmuan',
    rubrik: 'Idealnya >= 90% artikel sesuai fokus & skop jurnal secara konsisten. Pendekatan antardisiplin yang terfokus tetap baik; hindari "bunga rampai" (artikel dari bidang yang tidak berkaitan).' },
  { k: 'G.1', nama: 'Kelengkapan galley / PDF artikel',
    rubrik: 'Target 8-9 dari 9 unsur. First page: judul sirahan (nama jurnal, volume, nomor, tahun, halaman/ID artikel), lisensi akses, hak cipta, riwayat naskah (received, revised, accepted, available online), DOI. Declaration: pernyataan penggunaan AI, kontribusi penulis, pernyataan pendanaan, konflik kepentingan.' },
  { k: 'G.2', nama: 'Pencantuman nama & afiliasi penulis',
    rubrik: 'Metadata nama penulis minimal 2 kata (nama 1 kata diulang pada first name & last name); nama belakang tidak disingkat 1 huruf; tanpa gelar / jabatan; afiliasi utuh (institusi, kota, negara); e-mail corresponding author ada & jelas.' },
  { k: 'G.3', nama: 'Sistematika penulisan artikel',
    rubrik: 'Empiris: pendahuluan, metode, hasil-pembahasan, simpulan. Review: pendahuluan, pembahasan, simpulan. Sesuai author guidelines dan konsisten antar artikel & terbitan.' },
  { k: 'G.4', nama: 'Pemanfaatan instrumen pendukung',
    rubrik: 'Tabel, gambar/grafik, persamaan, simbol, singkatan, tipografi dipakai bila relevan, efektif & komplementer; setiap instrumen diacu di dalam teks; jelas, baku, konsisten.' },
  { k: 'G.5', nama: 'Sistem pengacuan pustaka & konsistensi daftar pustaka',
    rubrik: 'Sitasi dalam teks dan daftar pustaka baku & saling cocok; sistem nama-tahun / nomor / catatan kaki konsisten; gunakan aplikasi manajer referensi. Sitasi body & daftar pustaka tidak cocok -> nilai terendah.' },
  { k: 'G.6', nama: 'Gaya penulisan & kualitas kebahasaan',
    rubrik: 'Gunakan istilah baku; kalimat baik & benar; sesuai bidang ilmu; konsisten antar artikel. Bahasa ilmiah: baik, jelas, ringkas.' },
  { k: 'G.7', nama: 'Mutu penyuntingan substansi, gaya selingkung, & format tata letak',
    rubrik: 'Substansi, gaya selingkung, dan layout konsisten & sesuai standar artikel ilmiah; tabel tidak terpotong; gambar tidak stretched / blur; tipografi konsisten (font, ukuran, spasi baris, alignment).' }
];

var AKR_DISINSENTIF =
  'Dinilai asesor per-artikel pada sampel terbitan 3 tahun terakhir. Pelanggaran ' +
  'integritas akademik (fabrikasi, falsifikasi, plagiat, kepengarangan tidak sah, ' +
  'konflik kepentingan, pengajuan jamak) menjadi dasar penyesuaian nilai (disinsentif) ' +
  'dan tindakan korektif (koreksi/erratum, retraksi, withdrawal). Riset yang melibatkan ' +
  'manusia/hewan wajib mencantumkan nomor & tahun dokumen persetujuan etik (ethical clearance). ' +
  'Pemantauan sewaktu-waktu dapat berujung penurunan peringkat, pembekuan (discontinued), ' +
  'atau pencabutan (delisting).';

var AKR_TATA_KELOLA_MAKS = 46;
var AKR_MUTU_ARTIKEL_MAKS = 54;

/**
 * Berkas dan terbitan yang harus disiapkan di luar layar ini. Enam langkah di
 * menu ini bisa selesai seluruhnya sementara pengajuan tetap tersendat di tahap
 * unggah, karena daftar ini sebelumnya tidak disebut di mana pun.
 */
var AKR_BERKAS_ARJUNA = [
  { k: 'ar1', nama: 'Akun ARJUNA aktif atas nama pengelola jurnal',
    ket: 'Pastikan surel yang terdaftar masih bisa diakses.' },
  { k: 'ar2', nama: 'Terbitan full-text yang bisa diakses penilai',
    ket: 'Akreditasi baru: terbitan dua tahun terakhir. Reakreditasi: terbitan sejak SK berjalan. Pastikan PDF terbuka tanpa login.' },
  { k: 'ar3', nama: 'Tautan halaman kebijakan: fokus & ruang lingkup, etika publikasi, proses telaah, dan lisensi',
    ket: 'Halaman harus hidup dan isinya konsisten dengan jawaban Anda di Tahap 3.1.' },
  { k: 'ar4', nama: 'Bukti DOI aktif dan metadata terkirim ke Crossref',
    ket: 'Termasuk metadata rujukan, karena ini dilihat pada unsur visibilitas.' },
  { k: 'ar5', nama: 'Susunan Tim Penyunting beserta afiliasi dan tautan profil',
    ket: 'Nama dan afiliasi harus dapat diverifikasi; identitas yang tidak terverifikasi menurunkan nilai B.3.' },
  { k: 'ar6', nama: 'Bukti telaah mitra bestari untuk sampel naskah',
    ket: 'Rubrik B.1 menyatakan tanpa bukti berarti tanpa telaah.' },
  { k: 'ar7', nama: 'Salinan SK akreditasi berjalan (untuk reakreditasi)',
    ket: 'Beserta tanggal berakhirnya, yang juga diisi di langkah 1.' },
  { k: 'ar8', nama: 'Borang evaluasi diri ARJUNA',
    ket: 'Diisi sendiri dan menentukan penugasan asesor. Angka di bagian "Perkiraan posisi terhadap peringkat" membantu mengisinya.' }
];

/* -- Helper sheet & rubrik -------------------------------------------- */

function getPersiapanAkreditasiSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_PERSIAPAN_AKREDITASI);
  if (!sh) {
    sh = ss.insertSheet(SHEET_PERSIAPAN_AKREDITASI);
    sh.getRange(1, 1, 1, PERSIAPAN_AKR_HEADER.length)
      .setValues([PERSIAPAN_AKR_HEADER])
      .setFontWeight('bold').setBackground('#7f0000').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function rubrikAkreditasi_() {
  return {
    syaratTahap1: AKR_SYARAT_TAHAP1,
    tahap2: AKR_TAHAP2,
    tataKelola: AKR_TATA_KELOLA,
    cope: AKR_COPE,
    mutuArtikel: AKR_MUTU_ARTIKEL,
    disinsentif: AKR_DISINSENTIF,
    berkasArjuna: AKR_BERKAS_ARJUNA,
    tataKelolaMaks: AKR_TATA_KELOLA_MAKS,
    mutuArtikelMaks: AKR_MUTU_ARTIKEL_MAKS,
    peringkat: [
      { p: 1, min: 90 }, { p: 2, min: 80 }, { p: 3, min: 70 }, { p: 4, min: 60 }
    ]
  };
}

/** Cari nomor baris berdasar nama jurnal di kolom A. 0 bila tidak ada. */
/**
 * Cap waktu simpan disamakan ke menit. Sheet menyimpan detik, sedangkan yang
 * dikirim ke klien saat memuat sudah dipotong ke menit; tanpa penyamaan ini
 * perbandingan versi akan selalu berbeda dan setiap simpan dianggap konflik.
 */
function capAkrNorm_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm');
  return str_(v).substring(0, 16);
}

function cariBarisPersiapanAkr_(sh, namaJurnal) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var kolomA = sh.getRange(2, 1, last - 1, 1).getValues();
  var target = norm_(namaJurnal);
  for (var i = 0; i < kolomA.length; i++) {
    if (norm_(kolomA[i][0]) === target) return i + 2;
  }
  return 0;
}

/**
 * Prefill jawaban dari data DJPI yang sudah ada. Semua bisa dikoreksi pengelola.
 *
 * Mengembalikan dua hal berdampingan:
 *   prefill  nilai awal per kunci jawaban
 *   sumber   { status, teks, data[] } per kunci, untuk penanda di UI.
 *            status 'otomatis'  = data DJPI cukup untuk menjawab
 *                   'verifikasi' = data ada tetapi belum tentu mutakhir/setara
 *                                  definisi rubrik, jadi minta pengelola menegaskan
 *            data   pasangan { label, isi } berisi angka/teks yang dipakai
 *                   sebagai dasar jawaban, supaya pengelola bisa mencocokkannya
 *                   sendiri tanpa membuka direktori
 * Kalimat sumber TIDAK disimpan ke kolom catatan; catatan milik pengelola.
 */
function prefillAkreditasi_(namaJurnal) {
  var jurnal = null;
  try { jurnal = cariJurnal_(bacaDataJurnal_(), namaJurnal)[0] || null; } catch (e) { jurnal = null; }
  if (!jurnal) return { prefill: {}, sumber: {}, jurnal: null };

  var pre = {}, src = {};
  /** data = [{ label, isi }] nilai yang jadi dasar jawaban; boleh dikosongkan. */
  function tandai(k, status, teks, data) {
    src[k] = { status: status, teks: teks, data: (data || []).filter(function (d) { return d.isi; }) };
  }

  if (jurnal.eIssnValid) {
    pre.s1 = 'ya';
    tandai('s1', 'otomatis', 'Format e-ISSN jurnal Anda di direktori DJPI sudah valid. ' +
      'Pastikan nama jurnal dan penerbit juga sama persis dengan data di Portal ISSN.', [
        { label: 'e-ISSN', isi: jurnal.eIssn },
        { label: 'p-ISSN', isi: jurnal.pIssnValid ? jurnal.pIssn : '' },
        { label: 'Nama jurnal', isi: jurnal.namaJurnal }
      ]);
  }

  var perIssue = angka_(jurnal.artikelPerIssue);
  var ipt = issuePerTahun_(jurnal.issue);
  if (perIssue >= 5 && ipt && ipt >= 2) {
    pre.s3 = 'ya';
    tandai('s3', 'verifikasi', 'Angka di atas diambil dari direktori DJPI dan keduanya ' +
      'di atas syarat minimum. Periksa lagi bila sudah berubah tahun ini.', [
        { label: 'Frekuensi terbit', isi: ipt + ' nomor per tahun (syarat: minimal 2)' },
        { label: 'Artikel per nomor', isi: perIssue + ' artikel (syarat: minimal 5)' },
        { label: 'Jadwal terbitan', isi: jurnal.jadwalTerbitan },
        { label: 'Artikel per tahun', isi: jurnal.artikelPerTahun }
      ]);
  }

  var punyaDoi = false;
  try {
    var set = bacaJurnalPunyaDoi_();
    if (set && set[norm_(namaJurnal)]) punyaDoi = true;
  } catch (e) {}

  var refSit = null;
  try {
    var sit = bacaDataSitasi_() || {};
    var u = petaUnggulan_(sit.topJournals)[norm_(namaJurnal)];
    if (u) {
      if (angka_(u.totalArtikel) > 0) punyaDoi = true;
      refSit = { crossref: angka_(u.totalSitasiCrossref), openalex: angka_(u.totalSitasiOpenAlex),
                 artikel: angka_(u.totalArtikel) };
    }
  } catch (e) {}
  if (punyaDoi) {
    pre.s8 = 'ya';
    tandai('s8', 'otomatis', 'DOI jurnal Anda terdeteksi aktif di Crossref. ' +
      'Pastikan juga setiap artikel punya berkas PDF yang bisa diunduh.', [
        { label: 'Status DOI', isi: 'Aktif di Crossref' },
        { label: 'Artikel ber-DOI terdata', isi: refSit ? refSit.artikel + ' artikel' : '' },
        { label: 'Laman OJS', isi: jurnal.linkOjsValid ? jurnal.linkOjs : '' }
      ]);
  }

  // E.1 dampak ilmiah. Sitasi yang dipegang DJPI dihitung sepanjang tahun terbit,
  // sedangkan rubrik meminta 3 tahun terakhir saja, dan kolom sitasi 3 tahun tidak
  // ada di sheet mana pun. Level apa pun yang diturunkan dari angka ini adalah
  // BATAS ATAS, bukan nilai. Karena itu fieldnya sengaja dibiarkan kosong: prefill
  // yang meninggikan hampir tidak pernah diturunkan lagi oleh pengelola, dan
  // selisihnya terbawa sampai ke pengajuan.
  if (refSit) {
    var doiSit = Math.max(angka_(refSit.crossref), angka_(refSit.openalex));
    var lvAtas = doiSit > 75 ? 6 : doiSit >= 31 ? 4 : doiSit >= 11 ? 3 : doiSit >= 5 ? 2 : doiSit >= 1 ? 1 : 0;
    tandai('E.1', 'verifikasi', 'Sitasi yang tercatat di DJPI mencakup seluruh tahun terbit, ' +
      'sedangkan rubrik hanya menghitung 3 tahun terakhir. Dari angka itu, level tertinggi ' +
      'yang mungkin adalah ' + lvAtas + ' — nilai sebenarnya sama atau lebih rendah. ' +
      'Periksa sitasi 3 tahun terakhir di Crossref atau Google Scholar, lalu pilih sendiri.', [
        { label: 'Sitasi Crossref (seluruh tahun)', isi: refSit.crossref },
        { label: 'Sitasi OpenAlex (seluruh tahun)', isi: refSit.openalex },
        { label: 'Batas atas level', isi: 'Level ' + lvAtas },
        { label: 'Artikel terdata', isi: refSit.artikel + ' artikel' }
      ]);
  }

  if (jurnal.bereputasi) {
    pre['E.2'] = 6;
    tandai('E.2', 'otomatis', 'Ubah bila kondisi sekarang berbeda.', [
      { label: 'Kuartil', isi: jurnal.kuartil },
      { label: 'Status', isi: 'Terindeks pengindeks bereputasi internasional' },
      { label: 'DOAJ', isi: jurnal.terindeksDoaj ? 'Terindeks' : '' }
    ]);
  } else if (jurnal.doajStatus === 'TERINDEKS') {
    pre['E.2'] = 3;
    tandai('E.2', 'otomatis', 'Naikkan ke 4 atau 6 bila sudah tercantum di Scopus atau ' +
      'Web of Science.', [
        { label: 'DOAJ', isi: 'Terindeks' + (jurnal.doajDicek ? ', dicek ' + jurnal.doajDicek : '') },
        { label: 'Judul di DOAJ', isi: jurnal.doajJudul },
        { label: 'Garuda', isi: jurnal.terindeksGaruda ? 'Terindeks' : '' }
      ]);
  }

  var ked = parseKedaluwarsaSk_(jurnal.tanggalExpired, jurnal.masaBerlakuSk);
  var tglIso = ked.tanggalIso || (ked.tahun ? (ked.tahun + '-12-31') : '');
  if (tglIso) {
    tandai('tglBerakhirSk', 'verifikasi', 'Kalau di SK Anda tertulis tanggal yang lebih tepat, ' +
      'silakan koreksi.', [
        { label: 'Masa berlaku SK', isi: jurnal.masaBerlakuSk },
        { label: 'Tanggal kedaluwarsa', isi: jurnal.tanggalExpired }
      ]);
  }
  if (jurnal.statusAkreditasi) {
    tandai('jenis', 'otomatis', 'Ubah bila tidak sesuai.', [
      { label: 'Status akreditasi', isi: jurnal.statusAkreditasi },
      { label: 'Kluster', isi: jurnal.kluster }
    ]);
  }

  return {
    prefill: pre,
    sumber: src,
    jurnal: {
      namaJurnal: jurnal.namaJurnal,
      kluster: jurnal.kluster,
      statusAkreditasi: jurnal.statusAkreditasi,
      terakreditasi: jurnal.terakreditasi,
      masaBerlakuSk: jurnal.masaBerlakuSk,
      tanggalExpired: jurnal.tanggalExpired,
      nomorSk: jurnal.nomorSk,
      tglBerakhirIso: tglIso,
      // 'tanggal' bila TANGGAL EXPIRED memuat tanggal sah; 'tahun' bila hanya
      // tahun 4-digit dari MASA BERLAKU SK; '' bila keduanya tidak terbaca.
      // Pengelola.html memakai ini untuk menolak menampilkan hitung mundur
      // ketika yang tercatat baru tahunnya.
      sumberTanggal: ked.sumber,
      sitasiReferensi: refSit
    }
  };
}

/* -- Endpoint ------------------------------------------------------- */

function getPersiapanAkreditasi(token) {
  var muatan = bacaToken_(token, 'edit_');
  if (!muatan) return sesiHabis_();

  try {
    var pf = prefillAkreditasi_(muatan.namaJurnal);

    var tersimpan = null;
    var sh = getPersiapanAkreditasiSheet_();
    var baris = cariBarisPersiapanAkr_(sh, muatan.namaJurnal);
    if (baris) {
      var nilai = sh.getRange(baris, 1, 1, PERSIAPAN_AKR_HEADER.length).getValues()[0];
      var jawaban = {};
      try { jawaban = JSON.parse(nilai[4] || '{}'); } catch (e) { jawaban = {}; }
      tersimpan = {
        jenis: (str_(nilai[2]) === 'baru') ? 'baru' : 'ulang',
        tglBerakhirSk: (nilai[3] instanceof Date)
          ? Utilities.formatDate(nilai[3], TZ, 'yyyy-MM-dd') : str_(nilai[3]),
        jawaban: jawaban,
        // Nilai Tata Kelola dan status gerbang tidak dikirim: klien menghitungnya
        // sendiri dari jawaban, dan dua field ini tidak pernah dibaca di sana.
        terakhirDisimpan: (nilai[7] instanceof Date)
          ? Utilities.formatDate(nilai[7], TZ, 'yyyy-MM-dd HH:mm') : str_(nilai[7])
      };
    }

    // Temuan pra-asesmen Tahap 3.2 milik jurnal ini (section 29). Sheet boleh
    // belum ada; kartu Mutu Artikel tetap tampil, hanya tanpa daftar temuan.
    var praAsesmen = { artikel: [], totalArtikel: 0, totalPerluPerbaikan: 0, terakhirDiperbarui: '' };
    try { praAsesmen = praAsesmenJurnal_(muatan.namaJurnal); } catch (e) { /* opsional */ }

    return {
      ok: true,
      rubrik: rubrikAkreditasi_(),
      prefill: pf.prefill,
      sumber: pf.sumber || {},
      jurnal: pf.jurnal,
      tersimpan: tersimpan,
      praAsesmen: praAsesmen
    };
  } catch (err) {
    return { ok: false, message: 'Gagal memuat data persiapan akreditasi: ' + err.message };
  }
}

function simpanPersiapanAkreditasi(token, payload) {
  var muatan = bacaToken_(token, 'edit_');
  if (!muatan) return sesiHabis_();
  if (!payload || typeof payload !== 'object') return { ok: false, message: 'Data kosong.' };

  // Jaring pengaman: klien ikut menyebut jurnal yang sedang diisi. Kalau panel
  // masih memegang jawaban jurnal sebelumnya, namanya tidak akan cocok dengan
  // token, dan simpanan ditolak alih-alih menimpa baris jurnal yang salah.
  if (payload.namaJurnal && norm_(str_(payload.namaJurnal)) !== norm_(str_(muatan.namaJurnal))) {
    return {
      ok: false, code: 'JURNAL_TIDAK_COCOK',
      message: 'Isian di layar milik jurnal lain. Muat ulang halaman sebelum menyimpan.'
    };
  }

  var jenis = (str_(payload.jenis) === 'baru') ? 'baru' : 'ulang';
  var tglBerakhir = str_(payload.tglBerakhirSk).substring(0, 10);
  var jawaban = (payload.jawaban && typeof payload.jawaban === 'object') ? payload.jawaban : {};

  // Nilai Tata Kelola: jumlah level terpilih, disimpan MENTAH dari 46.
  //
  // Dulu kolom ini berisi persen. Angka 0-100 itu berada di rentang yang sama
  // dengan skala nilai akreditasi, sehingga "85%" terbaca sebagai nilai 85 dan
  // mengesankan Peringkat 2, padahal 85% x 46 = 39,1 dari 100.
  var tk = jawaban.tataKelola || {};
  var total = 0;
  AKR_TATA_KELOLA.forEach(function (u) {
    var v = tk[u.k];
    var n = (v && typeof v === 'object') ? Number(v.nilai) : Number(v);
    if (!isNaN(n)) total += Math.max(0, Math.min(n, u.maks));
  });
  var nilaiTk = Math.round(total * 10) / 10;

  // Syarat gerbang: hitung yang "ya" dari syarat yang berlaku untuk jenis pengajuan
  var t1 = jawaban.tahap1 || {};
  var berlaku = AKR_SYARAT_TAHAP1.filter(function (s) {
    return s.berlaku === 'semua' || s.berlaku === jenis;
  });
  var lolos = 0;
  berlaku.forEach(function (s) {
    var v = t1[s.k];
    var j = (v && typeof v === 'object') ? v.jawab : v;
    if (j === 'ya') lolos++;
  });
  var gerbang = lolos + '/' + berlaku.length;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, message: 'Sistem sedang sibuk. Coba lagi.' };

  try {
    var jsonJawab = JSON.stringify(jawaban);
    if (jsonJawab.length > 45000) {
      return { ok: false, message: 'Isian terlalu panjang. Persingkat catatan / bukti.' };
    }

    var sh = getPersiapanAkreditasiSheet_();
    var stempel = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
    var barisData = [
      aman_(muatan.namaJurnal), aman_(pelakuEdit_(muatan)), jenis, aman_(tglBerakhir),
      jsonJawab, nilaiTk, gerbang, stempel
    ];

    var baris = cariBarisPersiapanAkr_(sh, muatan.namaJurnal);

    // Deteksi tabrakan. Penulisan di sini mengganti SELURUH baris, jadi dua tab
    // atau admin mode atas nama yang menyimpan bersamaan akan saling menghapus.
    // LockService hanya mengurutkan penulisan, ia tidak melihat isi yang ditimpa.
    if (baris && !payload.paksa) {
      var capServer = capAkrNorm_(sh.getRange(baris, 8).getValue());
      var capKlien = capAkrNorm_(payload.terakhirDisimpan);
      if (capServer && capServer !== capKlien) {
        var lamaJson = str_(sh.getRange(baris, 5).getValue());
        var lamaJawab = {};
        try { lamaJawab = JSON.parse(lamaJson || '{}'); } catch (e) { lamaJawab = {}; }
        return {
          ok: false, code: 'KONFLIK',
          message: 'Isian jurnal ini sudah diperbarui dari tempat lain pada ' + capServer +
                   '. Isian Anda belum ditimpakan.',
          serverTerakhirDisimpan: capServer,
          serverJawaban: lamaJawab
        };
      }
    }

    if (!baris) {
      sh.appendRow(barisData);
      baris = sh.getLastRow();
    }
    // Kolom tanggal SK dijadikan teks SEBELUM ditulis. Tanpa ini Sheets meng-coerce
    // string ISO jadi Date memakai zona spreadsheet, sedangkan pembacaan memakai TZ
    // di atas, sehingga tanggalnya bisa bergeser sehari tiap siklus simpan-muat.
    sh.getRange(baris, 4).setNumberFormat('@');
    sh.getRange(baris, 1, 1, barisData.length).setValues([barisData]);
    SpreadsheetApp.flush();

    catatAktivitas_(pelakuEdit_(muatan), muatan.namaJurnal, aksiEdit_(muatan, 'PERSIAPAN_AKREDITASI'),
      JSON.stringify({ jenis: jenis, nilaiTataKelola: nilaiTk, gerbang: gerbang }));

    return { ok: true, message: 'Isian persiapan akreditasi tersimpan.',
             nilaiTataKelola: nilaiTk, gerbang: gerbang, terakhirDisimpan: stempel };
  } catch (err) {
    return { ok: false, message: 'Gagal menyimpan: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}


/* ==========================================================================
   29. PRA-ASESMEN MUTU ARTIKEL (Tahap 3.2) -- jembatan ke menu Pengelola
   --------------------------------------------------------------------------
   Temuan per artikel dihasilkan perkakas lokal di folder mutu-artikel/ (Python,
   di luar Apps Script). Keluarannya berupa berkas TSV yang ditempel ke sheet
   Pra_Asesmen_Artikel. Bagian ini hanya MEMBACA sheet itu dan menyodorkannya ke
   kartu Tahap 3.2 pada menu Persiapan Akreditasi, disaring untuk jurnal yang
   sedang login.

   Alur kerja:
     1. python mutu-artikel/ekstrak_artikel.py
     2. python mutu-artikel/susun_laporan.py
        -> mutu-artikel/laporan/Pra_Asesmen_Artikel.tsv
     3. buatSheetPraAsesmen() dari editor (sekali saja, membuat sheet + header)
     4. Tempel isi TSV mulai baris 2. Google Sheets memecah kolom otomatis.
     5. cekPraAsesmen() dari editor untuk memastikan seluruh baris cocok ke jurnal.

   Kolom sheet:
     Nama Jurnal | Judul Artikel | DOI | Tanggal Asesmen | Butir | Nama Butir |
     Status | Temuan | Saran

   Status yang dikenali: "perlu perbaikan", "baik", "perlu dicek",
   "di luar jangkauan". Nilai lain tetap ditampilkan apa adanya.

   Laporan ini berisi temuan dan saran, bukan penilaian. Tidak ada skor.
   ========================================================================== */

var PRA_ASESMEN_HEADER = [
  'Nama Jurnal', 'Judul Artikel', 'DOI', 'Tanggal Asesmen',
  'Butir', 'Nama Butir', 'Status', 'Temuan', 'Saran'
];

var CACHE_PRA_ASESMEN = 'pra_asesmen_v1';
var CACHE_PRA_ASESMEN_TTL = 900;

/** Membuat sheet Pra_Asesmen_Artikel beserta headernya. Aman dipanggil berulang. */
function buatSheetPraAsesmen() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET.PRA_ASESMEN);
  if (sh) return 'Sheet "' + SHEET.PRA_ASESMEN + '" sudah ada, tidak diubah.';

  sh = ss.insertSheet(SHEET.PRA_ASESMEN);
  sh.getRange(1, 1, 1, PRA_ASESMEN_HEADER.length)
    .setValues([PRA_ASESMEN_HEADER])
    .setFontWeight('bold').setBackground('#7f0000').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.setColumnWidth(2, 320);
  sh.setColumnWidth(8, 460);
  sh.setColumnWidth(9, 460);
  return 'Sheet "' + SHEET.PRA_ASESMEN + '" dibuat. Tempel isi Pra_Asesmen_Artikel.tsv mulai baris 2.';
}

/** Membaca seluruh baris pra-asesmen. Di-cache; sheet ini jarang berubah. */
function bacaPraAsesmen_() {
  var cache = CacheService.getScriptCache();
  var tersimpan = cache.get(CACHE_PRA_ASESMEN);
  if (tersimpan) {
    try { return JSON.parse(tersimpan); } catch (err) { /* cache rusak, baca ulang */ }
  }

  var sh = sheetOpsional_(SHEET.PRA_ASESMEN);
  if (!sh) return [];
  var nilai = sh.getDataRange().getValues();
  if (nilai.length < 2) return [];

  var header = nilai[0].map(norm_);
  function kolom(nama) { return header.indexOf(norm_(nama)); }
  var idx = {
    jurnal: kolom('Nama Jurnal'), judul: kolom('Judul Artikel'), doi: kolom('DOI'),
    tanggal: kolom('Tanggal Asesmen'), butir: kolom('Butir'), namaButir: kolom('Nama Butir'),
    status: kolom('Status'), temuan: kolom('Temuan'), saran: kolom('Saran')
  };
  if (idx.jurnal === -1 || idx.butir === -1) return [];

  function sel(row, i) {
    if (i === -1) return '';
    var v = row[i];
    if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
    return str_(v);
  }

  var baris = [];
  for (var r = 1; r < nilai.length; r++) {
    var jurnal = sel(nilai[r], idx.jurnal);
    if (!jurnal) continue;
    baris.push({
      namaJurnal: jurnal,
      judul: sel(nilai[r], idx.judul),
      doi: sel(nilai[r], idx.doi),
      tanggal: sel(nilai[r], idx.tanggal),
      butir: sel(nilai[r], idx.butir),
      namaButir: sel(nilai[r], idx.namaButir),
      status: sel(nilai[r], idx.status).toLowerCase(),
      temuan: sel(nilai[r], idx.temuan),
      saran: sel(nilai[r], idx.saran)
    });
  }

  try {
    var json = JSON.stringify(baris);
    if (json.length < CACHE.MAX_VALUE_BYTES) cache.put(CACHE_PRA_ASESMEN, json, CACHE_PRA_ASESMEN_TTL);
  } catch (err) { /* cache opsional */ }

  return baris;
}

function bersihkanCachePraAsesmen_() {
  CacheService.getScriptCache().remove(CACHE_PRA_ASESMEN);
}

/**
 * Kunci pencocokan nama jurnal: huruf besar, spasi rapi, tanda baca dibuang.
 * Toleran terhadap beda tanda titik dua atau tanda hubung, tetapi tetap membedakan
 * nama yang memang berbeda.
 */
function kunciJurnal_(v) {
  return norm_(v).replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Cocokkan nama jurnal secara TEPAT setelah dinormalkan.
 *
 * Sebelumnya fungsi ini menerima substring dua arah, sehingga nama pendek
 * mewarisi temuan jurnal lain: "Curricula" cocok ke "Curricula: Journal of
 * Curriculum Development", "Passage" ke "Passage: Journal of English Language
 * and Literature", dan "Indonesian Journal of Science" ke "Indonesian Journal of
 * Science and Technology". Pengelola bisa melihat, dan memperbaiki, temuan milik
 * jurnal yang bukan miliknya. Kolom "Nama Jurnal" di sheet pra-asesmen memang
 * sudah ditulis persis seperti Sheet1 (lihat mutu-artikel/peta_jurnal.json),
 * jadi kecocokan tepat tidak menghilangkan satu pun baris yang sah.
 */
function cocokJurnal_(a, b) {
  var x = kunciJurnal_(a), y = kunciJurnal_(b);
  if (!x || !y) return false;
  return x === y;
}

/**
 * Temuan pra-asesmen milik SATU jurnal, dikelompokkan per artikel.
 * Bentuk: { artikel: [...], totalArtikel, totalPerluPerbaikan, terakhirDiperbarui }
 */
function praAsesmenJurnal_(namaJurnal) {
  var semua = bacaPraAsesmen_();
  var milik = semua.filter(function (b) { return cocokJurnal_(b.namaJurnal, namaJurnal); });
  if (!milik.length) {
    return { artikel: [], totalArtikel: 0, totalPerluPerbaikan: 0, terakhirDiperbarui: '' };
  }

  var peta = {}, urutan = [], terakhir = '';
  milik.forEach(function (b) {
    var kunci = (b.doi || b.judul || '(tanpa judul)');
    if (!peta[kunci]) {
      peta[kunci] = { judul: b.judul || '(judul tidak terbaca)', doi: b.doi, tanggal: b.tanggal, butir: [] };
      urutan.push(kunci);
    }
    peta[kunci].butir.push({
      kode: b.butir, nama: b.namaButir, status: b.status,
      temuan: b.temuan, saran: b.saran
    });
    if (b.tanggal > terakhir) terakhir = b.tanggal;
  });

  var artikel = urutan.map(function (k) {
    var a = peta[k];
    a.butir.sort(function (x, y) { return String(x.kode).localeCompare(String(y.kode)); });
    a.perluPerbaikan = a.butir.filter(function (x) { return x.status === 'perlu perbaikan'; }).length;
    a.perluDicek = a.butir.filter(function (x) { return x.status === 'perlu dicek'; }).length;
    a.jumlahButir = a.butir.length;
    return a;
  });

  return {
    artikel: artikel,
    totalArtikel: artikel.length,
    totalPerluPerbaikan: artikel.reduce(function (n, a) { return n + a.perluPerbaikan; }, 0),
    terakhirDiperbarui: terakhir
  };
}

/**
 * Diagnostik untuk dijalankan dari editor Apps Script setelah menempel TSV.
 * Melaporkan berapa baris yang cocok ke jurnal di Sheet1 dan mana yang tidak,
 * karena nama jurnal yang tidak cocok membuat temuan tidak pernah tampil ke pengelola.
 */
function cekPraAsesmen() {
  // Cache dibuang lebih dulu supaya diagnostik membaca sheet yang baru
  // ditempel, bukan salinan lama yang masih hidup sampai 900 detik.
  bersihkanCachePraAsesmen_();
  var baris = bacaPraAsesmen_();
  if (!baris.length) {
    var pesan = 'Sheet "' + SHEET.PRA_ASESMEN + '" kosong atau belum ada. ' +
      'Jalankan buatSheetPraAsesmen() lalu tempel isi Pra_Asesmen_Artikel.tsv.';
    console.log(pesan);
    return pesan;
  }

  var jurnal = bacaDataJurnal_().map(function (j) { return j.namaJurnal; });
  var cocok = {}, tidakCocok = {}, ganda = {};
  baris.forEach(function (b) {
    // Dihitung, bukan sekadar some(): satu baris yang cocok ke lebih dari satu
    // jurnal berarti temuannya tampil di beberapa panel sekaligus. Versi lama
    // memakai some() sehingga kasus itu tetap dilaporkan "OK".
    var kena = jurnal.filter(function (n) { return cocokJurnal_(n, b.namaJurnal); });
    if (kena.length > 1) ganda[b.namaJurnal] = kena;
    var wadah = kena.length ? cocok : tidakCocok;
    wadah[b.namaJurnal] = (wadah[b.namaJurnal] || 0) + 1;
  });

  var garis = [];
  garis.push(baris.length + ' baris terbaca dari sheet ' + SHEET.PRA_ASESMEN + '.');
  garis.push('Cocok ke Sheet1: ' + Object.keys(cocok).length + ' jurnal.');
  Object.keys(cocok).forEach(function (k) { garis.push('  OK   ' + k + ' (' + cocok[k] + ' baris)'); });
  if (Object.keys(tidakCocok).length) {
    garis.push('TIDAK cocok ke jurnal mana pun di Sheet1:');
    Object.keys(tidakCocok).forEach(function (k) {
      garis.push('  MISS ' + k + ' (' + tidakCocok[k] + ' baris) -- temuan ini tidak akan tampil ke pengelola');
    });
    garis.push('Perbaiki kolom "Nama Jurnal" di sheet, atau perbarui mutu-artikel/peta_jurnal.json lalu susun ulang TSV.');
  }
  if (Object.keys(ganda).length) {
    garis.push('Cocok ke LEBIH DARI SATU jurnal -- temuan akan bocor antar-panel:');
    Object.keys(ganda).forEach(function (k) {
      garis.push('  GANDA ' + k + ' -> ' + ganda[k].join(' | '));
    });
  }
  if (!Object.keys(tidakCocok).length && !Object.keys(ganda).length) {
    garis.push('Seluruh baris cocok ke tepat satu jurnal. Temuan akan tampil di menu Persiapan Akreditasi masing-masing jurnal.');
  }

  var ringkas = garis.join(String.fromCharCode(10));
  console.log(ringkas);
  catatAktivitas_('SISTEM', '-', 'CEK_PRA_ASESMEN', baris.length + ' baris, ' +
    Object.keys(tidakCocok).length + ' nama jurnal tidak cocok');
  return ringkas;
}

/* ==========================================================================
   30. ANGKA UNTUK VIDEO EXPLAINER
   Dijalankan sekali dari editor Apps Script; hasilnya disalin ke rundown.
   Empat aturan kejujuran dipasang di sini, bukan diserahkan ke penyusun naskah:
     1. DOAJ dihitung dari doajStatus (sheet Verifikasi_DOAJ), BUKAN dari ada
        tidaknya tautan di direktori. Tautan hanya membuktikan seseorang
        menempelkan URL.
     2. Penyebut = jurnal yang dikelola. Kluster BELUM DIKELOLA dilaporkan
        terpisah supaya tidak menggelembungkan angka kegagalan.
     3. timeliness tidak diikutkan sama sekali; kategorinya memuat "Punya
        Hutang Terbitan", itu catatan kepatuhan internal.
     4. Tidak ada nama jurnal yang masa SK-nya hampir habis. statusMasaBerlaku_
        hanya membandingkan TAHUN, terlalu kasar untuk klaim per jurnal.
   ========================================================================== */

function angkaExplainer() {
  var semua = bacaDataJurnal_();
  var dikelola = semua.filter(function (j) { return j.kluster !== KLUSTER_KOSONG; });
  var takDikelola = semua.length - dikelola.length;

  var L = [];
  function baris(k, v) { L.push('  ' + k + ': ' + v); }

  L.push('== PENYEBUT ==');
  baris('Total baris direktori', semua.length);
  baris('Dikelola (penyebut dipakai)', dikelola.length);
  baris('BELUM DIKELOLA (dilaporkan terpisah)', takDikelola);

  L.push('== AKREDITASI ==');
  var akr = 0, sinta = {};
  for (var i = 1; i <= 6; i++) sinta[i] = 0;
  dikelola.forEach(function (j) {
    if (j.terakreditasi) { akr++; if (sinta[j.peringkatSinta] !== undefined) sinta[j.peringkatSinta]++; }
  });
  baris('Terakreditasi', akr + ' dari ' + dikelola.length);
  for (var s = 1; s <= 6; s++) baris('SINTA ' + s, sinta[s]);

  L.push('== INDEKSASI (masing-masing berdiri sendiri, bukan corong) ==');
  var doajYa = 0, doajTidak = 0, doajBelumCek = 0, bedaDoaj = 0;
  dikelola.forEach(function (j) {
    if (j.doajStatus === 'TERINDEKS') doajYa++;
    else if (j.doajStatus === 'TIDAK DITEMUKAN') doajTidak++;
    else doajBelumCek++;
    // Selisih antara klaim direktori dan hasil verifikasi. Kalau angkanya besar,
    // sebutkan DOAJ apa adanya di video atau jangan sebut sama sekali.
    if (j.terindeksDoaj && j.doajStatus === 'TIDAK DITEMUKAN') bedaDoaj++;
    if (!j.terindeksDoaj && j.doajStatus === 'TERINDEKS') bedaDoaj++;
  });
  baris('DOAJ terverifikasi TERINDEKS', doajYa);
  baris('DOAJ TIDAK DITEMUKAN', doajTidak);
  baris('DOAJ belum pernah dicek / gagal', doajBelumCek);
  baris('SELISIH tautan direktori vs verifikasi', bedaDoaj + '  <-- kalau besar, jangan pakai angka DOAJ');

  var garuda = 0, kuartilAda = 0, sebutScopus = 0, sebutQ = 0;
  dikelola.forEach(function (j) {
    if (j.terindeksGaruda) garuda++;
    if (j.bereputasi) kuartilAda++;
    var k = norm_(j.kuartil);
    if (/\bQ\s*[1-4]\b/.test(k)) sebutQ++;
    else if (/SCOPUS/.test(k)) sebutScopus++;
  });
  baris('Garuda (tautan tercatat)', garuda);
  baris('Kolom kuartil terisi Q1-Q4', sebutQ);
  baris('Kolom kuartil hanya menyebut SCOPUS tanpa Q', sebutScopus + '  <-- periksa manual, bisa "discontinued"/"target"');

  L.push('== KLUSTER ==');
  rekapKluster_(dikelola).forEach(function (c) {
    baris(c.nama, c.total + ' jurnal, ' + c.terakreditasi + ' terakreditasi');
  });

  L.push('== BIAYA TERBIT (APC) ==');
  // apc adalah teks bebas (apcValid_ hanya menuntut panjang >= 3), jadi yang
  // dilaporkan di sini adalah keterisian, bukan klasifikasi gratis/berbayar.
  var apcIsi = 0, apcKosong = 0, contoh = [];
  dikelola.forEach(function (j) {
    if (apcValid_(j.apc)) { apcIsi++; if (contoh.length < 12) contoh.push(str_(j.apc)); }
    else apcKosong++;
  });
  baris('Kolom APC terisi', apcIsi);
  baris('Kolom APC kosong', apcKosong);
  L.push('  Contoh isi APC (untuk klasifikasi manual gratis/berbayar):');
  contoh.forEach(function (c) { L.push('    - ' + c.substring(0, 70)); });

  L.push('== VOLUME TERBITAN ==');
  var perTahun = 0, adaAngka = 0;
  dikelola.forEach(function (j) {
    var n = angka_(j.artikelPerTahun);
    if (n > 0) { perTahun += n; adaAngka++; }
  });
  baris('Jurnal dengan angka artikel/tahun', adaAngka + ' dari ' + dikelola.length);
  baris('Perkiraan total artikel per tahun', perTahun + '  <-- hanya sah bila keterisian di atas tinggi');

  L.push('== COVER (bahan visual video) ==');
  var coverAda = 0;
  dikelola.forEach(function (j) { if (coverDataUriValid_(j.coverUrl)) coverAda++; });
  baris('Cover tersimpan sebagai data URI', coverAda + ' dari ' + dikelola.length);

  var teks = L.join(String.fromCharCode(10));
  console.log(teks);
  return teks;
}


/* ==========================================================================
   31. UKURAN PEKERJAAN PELENGKAPAN DATA AKREDITASI
   Dijalankan sekali dari editor Apps Script sebelum tugas dibagi ke staf.
   Menjawab dua hal: berapa baris yang benar-benar perlu dikerjakan, dan
   dikelompokkan bagaimana supaya perburuan dokumen SK tidak dikerjakan dua
   kali oleh orang berbeda.
   ========================================================================== */

function angkaPersiapanData() {
  var semua = bacaDataJurnal_();
  var dikelola = semua.filter(function (j) { return j.kluster !== KLUSTER_KOSONG; });
  var L = [];
  function b(k, v) { L.push('  ' + k + ': ' + v); }

  var akr = dikelola.filter(function (j) { return j.terakreditasi; });
  var belum = dikelola.filter(function (j) { return !j.terakreditasi; });

  L.push('== TUGAS A - BULAN HABIS MASA AKREDITASI (' + akr.length + ' jurnal) ==');
  var lengkap = 0, tahunSaja = 0, kosong = 0, perSinta = {}, perTahun = {};
  akr.forEach(function (j) {
    var s = j.peringkatSinta || '?';
    perSinta[s] = perSinta[s] || { total: 0, perlu: 0 };
    perSinta[s].total++;
    // bacaTanggalLonggar_ MENUNTUT hari. "Juli 2027" akan ditolak dan jatuh ke tahun.
    var tgl = bacaTanggalLonggar_(j.tanggalExpired);
    if (tgl) {
      lengkap++;
      var th = tgl.getFullYear();
      perTahun[th] = (perTahun[th] || 0) + 1;
    } else if (!placeholder_(j.masaBerlakuSk) || !placeholder_(j.tanggalExpired)) {
      tahunSaja++; perSinta[s].perlu++;
    } else {
      kosong++; perSinta[s].perlu++;
    }
  });
  b('Tanggal lengkap, sudah bisa dipakai', lengkap);
  b('Hanya tahun / tidak terbaca -> PERLU DIKERJAKAN', tahunSaja);
  b('Kosong sama sekali -> PERLU DIKERJAKAN', kosong);
  b('TOTAL PERLU DIKERJAKAN', tahunSaja + kosong);
  L.push('  Pecahan per peringkat (untuk membagi perburuan SK):');
  Object.keys(perSinta).sort().forEach(function (k) {
    b('    SINTA ' + k, perSinta[k].perlu + ' perlu dari ' + perSinta[k].total);
  });
  if (Object.keys(perTahun).length) {
    L.push('  Tahun kedaluwarsa yang sudah terbaca:');
    Object.keys(perTahun).sort().forEach(function (k) { b('    ' + k, perTahun[k] + ' jurnal'); });
  }

  L.push('== BENTUK ISI KOLOM MASA BERLAKU (contoh apa adanya) ==');
  var contoh = [], lihat = {};
  akr.forEach(function (j) {
    var v = str_(j.masaBerlakuSk) || str_(j.tanggalExpired);
    if (!v || lihat[v]) return;
    lihat[v] = 1;
    if (contoh.length < 18) contoh.push(v);
  });
  contoh.forEach(function (c) { L.push('    - ' + c.substring(0, 60)); });

  L.push('== TUGAS B - USIA e-ISSN (' + belum.length + ' jurnal belum terakreditasi) ==');
  var adaEissn = 0, tanpaEissn = 0, daftarTanpa = [];
  belum.forEach(function (j) {
    if (j.eIssnValid) adaEissn++;
    else { tanpaEissn++; if (daftarTanpa.length < 20) daftarTanpa.push(j.namaJurnal); }
  });
  b('Punya e-ISSN tercatat & sah -> tinggal dicari tanggal terbitnya', adaEissn);
  b('e-ISSN belum tercatat / tidak sah -> dua langkah', tanpaEissn);
  if (daftarTanpa.length) {
    L.push('  Contoh yang e-ISSN-nya belum tercatat:');
    daftarTanpa.forEach(function (n) { L.push('    - ' + n); });
  }

  L.push('== BARIS GRATIS - KOREKSI PENGELOLA YANG BELUM MASUK Sheet1 ==');
  // Menu Persiapan Akreditasi meminta pengelola mengoreksi tanggal SK
  // ('Kalau di SK Anda tertulis tanggal yang lebih tepat, silakan koreksi')
  // lalu menyimpannya ke sheet Persiapan_Akreditasi. Koreksi itu TIDAK pernah
  // mengalir balik ke Sheet1. Pengelola memegang sertifikatnya, jadi jawabannya
  // lebih tepercaya daripada isi direktori.
  try {
    var shP = getPersiapanAkreditasiSheet_();
    var nilaiP = shP.getDataRange().getValues();
    var petaP = {};
    for (var r = 1; r < nilaiP.length; r++) {
      var nm = norm_(nilaiP[r][0]);
      var tg = (nilaiP[r][3] instanceof Date)
        ? Utilities.formatDate(nilaiP[r][3], TZ, 'yyyy-MM-dd') : str_(nilaiP[r][3]);
      if (nm && tg) petaP[nm] = tg;
    }
    var gratis = 0, beda = 0, samaSaja = 0;
    akr.forEach(function (j) {
      var dariPengelola = petaP[norm_(j.namaJurnal)];
      if (!dariPengelola) return;
      var punyaSheet1 = bacaTanggalLonggar_(j.tanggalExpired);
      if (!punyaSheet1) {
        gratis++;
        L.push('    GRATIS  ' + j.namaJurnal + ' -> ' + dariPengelola);
      } else {
        var isoSheet1 = Utilities.formatDate(punyaSheet1, TZ, 'yyyy-MM-dd');
        if (isoSheet1 !== dariPengelola) {
          beda++;
          L.push('    BEDA    ' + j.namaJurnal + ' | Sheet1 ' + isoSheet1 + ' | pengelola ' + dariPengelola);
        } else samaSaja++;
      }
    });
    b('Tanggal dari pengelola yang Sheet1 belum punya', gratis + '  <-- pakai ini dulu, tidak perlu dicari');
    b('Berbeda dengan Sheet1, perlu diadu', beda);
    b('Sudah sama', samaSaja);
  } catch (e) {
    L.push('    (sheet Persiapan_Akreditasi belum ada atau gagal dibaca: ' + e.message + ')');
  }

  L.push('== CATATAN ==');
  L.push('  Format tanggal yang diterima sistem: 2027-07-01, 01/07/2027, atau 1 Juli 2027.');
  L.push('  "Juli 2027" TANPA hari akan ditolak dan jatuh balik ke ketelitian tahun.');

  var teks = L.join(String.fromCharCode(10));
  console.log(teks);
  return teks;
}


/* ==========================================================================
   32. PEMBARUAN MASA BERLAKU SK & NOMOR SK DI Sheet1
   Sumber: lampiran SK akreditasi/reakreditasi yang diurai di
   djpi-dashboard/sk-akreditasi. Tiga jurnal dikecualikan atas permintaan:
   Indonesian Journal of Science and Technology, Indonesian Journal of Applied
   Linguistics, dan ASEAN Journal of Science and Engineering.

   Cara pakai, DUA LANGKAH:
     1. updateMasaBerlakuSk()      -> hanya laporan, tidak menulis apa pun
     2. updateMasaBerlakuSkTULIS() -> menulis, setelah laporannya Anda setujui
        (daftar Run editor hanya memuat fungsi tanpa argumen)

   Kolom TANGGAL EXPIRED sengaja TIDAK disentuh: bulan berakhirnya dicari staf
   dari terbitan yang bersangkutan, dan harinya selalu tanggal 1.
   ========================================================================== */

var SHEET_CADANGAN_SK = 'Cadangan_Masa_Berlaku';

// [e-ISSN, MASA BERLAKU SK AKREDITASI, Nomor SK]
var UPDATE_SK = [
  ['26854414','Volume 10 Nomor 2 Tahun 2025 sampai Volume 15 Nomor 1 Tahun 2030','355/DST/D.D1/HM.01.01/2026'],
  ['25024795','Volume 7 Nomor 3 Tahun 2020 sampai Volume 12 Nomor 2 Tahun 2025','158/E/KPT/2021'],
  ['2580071X','Volume 9 Nomor 1 Tahun 2024 sampai Volume 13 Nomor 2 Tahun 2028','10/C/C3/DT.05.00/2025'],
  ['25410342','Volume 15 Nomor 1 Tahun 2023 sampai Volume 19 Nomor 2 Tahun 2027','177/E/KPT/2024'],
  ['26146568','Volume 5 Nomor 1 Tahun 2022 sampai Volume 9 Nomor 2 Tahun 2026','204/E/KPT/2022'],
  ['26570688','Volume 12 Nomor 2 Tahun 2024 sampai Volume 17 Nomor 1 Tahun 2029','295/C/C3/KPT/2026 [PERLU KONFIRMASI]'],
  ['25494562','Volume 4 Nomor 1 Tahun 2022 sampai Volume 8 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['2721480X','Volume 7 Nomor 1 Tahun 2023 sampai Volume 11 Nomor 2 Tahun 2027','152/E/KPT/2023'],
  ['27163970','Volume 1 Nomor 10 Tahun 2023 sampai Volume 6 Nomor 9 Tahun 2028','177/E/KPT/2024'],
  ['2621413X','Volume 8 Nomor 1 Tahun 2025 sampai Volume 12 Nomor 2 Tahun 2029','355/DST/D.D1/HM.01.01/2026'],
  ['26145626','Volume 4 Nomor 2 Tahun 2021 sampai Volume 9 Nomor 1 Tahun 2026','204/E/KPT/2022'],
  ['30259827','Volume 1 Nomor 2 Tahun 2023 sampai Volume 6 Nomor 1 Tahun 2028','355/DST/D.D1/HM.01.01/2026'],
  ['26571498','Volume 1 Nomor 1 Tahun 2021 sampai Volume 5 Nomor 2 Tahun 2025','152/E/KPT/2023'],
  ['25797700','mulai Volume 17 Nomor 3 Tahun 2019 (akhir tidak tertulis di SK)','148/M/KPT/2020'],
  ['2541061X','Volume 12 Nomor 3 Tahun 2024 sampai Volume 17 Nomor 2 Tahun 2029','295/C/C3/KPT/2026 [PERLU KONFIRMASI]'],
  ['27755940','Volume 5 Nomor 2 Tahun 2025 sampai Volume 10 Nomor 1 Tahun 2030','355/DST/D.D1/HM.01.01/2026'],
  ['25414135','Volume 20 Nomor 3 Tahun 2020 sampai Volume 25 Nomor 2 Tahun 2025','158/E/KPT/2021'],
  ['26564734','Volume 10 Nomor 2 Tahun 2025 sampai Volume 15 Nomor 1 Tahun 2030','355/DST/D.D1/HM.01.01/2026'],
  ['25407694','Volume 32 Nomor 1 Tahun 2023 sampai Volume 36 Nomor 2 Tahun 2027','177/E/KPT/2024'],
  ['27211401','Volume 6 Nomor 1 Tahun 2024 sampai Volume 10 Nomor 2 Tahun 2028','355/DST/D.D1/HM.01.01/2026'],
  ['26563266','Volume 10 Nomor 1 Tahun 2022 sampai Volume 14 Nomor 2 Tahun 2026','225/E/KPT/2022'],
  ['27741699','Volume 6 Nomor 1 Tahun 2025 sampai Volume 10 Nomor 2 Tahun 2029','355/DST/D.D1/HM.01.01/2026'],
  ['27154734','Volume 9 Nomor 1 Tahun 2022 sampai Volume 13 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['26544687','Volume 8 Nomor 1 Tahun 2025 sampai Volume 12 Nomor 2 Tahun 2029','295/C/C3/KPT/2026 [PERLU KONFIRMASI]'],
  ['25497073','Volume 4 Nomor 1 Tahun 2020 sampai Volume 8 Nomor 2 Tahun 2024','204/E/KPT/2022'],
  ['25285548','Volume 6 Nomor 2 Tahun 2021 sampai Volume 11 Nomor 1 Tahun 2026','225/E/KPT/2022'],
  ['24611336','Volume 20 Nomor 1 Tahun 2024 sampai Volume 24 Nomor 2 Tahun 2028','10/C/C3/DT.05.00/2025'],
  ['24424730','Volume 15 Nomor 2 Tahun 2022 sampai Volume 20 Nomor 1 Tahun 2027','10/C/C3/DT.05.00/2025'],
  ['27766101','Volume 5 Nomor 1 Tahun 2025 sampai Volume 9 Nomor 2 Tahun 2029','295/C/C3/KPT/2026 [PERLU KONFIRMASI]'],
  ['','Volume 1 Nomor 3 Tahun 2021 sampai Volume 6 Nomor 2 Tahun 2026','72/E/KPT/2024'],
  ['','Volume 5 Nomor 1 Tahun 2025 sampai Volume 9 Nomor 2 Tahun 2029','295/C/C3/KPT/2026 [PERLU KONFIRMASI]'],
  ['26157993','Volume 5 Nomor 1 Tahun 2022 sampai Volume 9 Nomor 2 Tahun 2026','204/E/KPT/2022'],
  ['2615515X','Volume 14 Nomor 2 Tahun 2025 sampai Volume 19 Nomor 1 Tahun 2030','355/DST/D.D1/HM.01.01/2026'],
  ['25020781','mulai Volume 21 Nomor 1 Tahun 2022 (akhir tidak tertulis di SK)','156/C/C3/KPT/2026'],
  ['25795457','Volume 15 Nomor 1 Tahun 2023 sampai Volume 19 Nomor 2 Tahun 2027','177/E/KPT/2024'],
  ['27759024','Volume 5 Nomor 1 Tahun 2025 sampai Volume 9 Nomor 2 Tahun 2029','295/C/C3/KPT/2026 [PERLU KONFIRMASI]'],
  ['28307917','mulai Volume 1 Nomor 2 Tahun 2022 (akhir tidak tertulis di SK)','10/C/C3/DT.05.00/2025'],
  ['26218321','Volume 14 Nomor 2 Tahun 2023 sampai Volume 19 Nomor 1 Tahun 2028','10/C/C3/DT.05.00/2025'],
  ['26217260','Volume 5 Nomor 1 Tahun 2022 sampai Volume 9 Nomor 2 Tahun 2026','177/E/KPT/2024'],
  ['','Volume 5 Nomor 1 Tahun 2025 sampai Volume 9 Nomor 2 Tahun 2029','295/C/C3/KPT/2026 [PERLU KONFIRMASI]'],
  ['27770990','Volume 5 Nomor 1 Tahun 2025 sampai Volume 9 Nomor 2 Tahun 2029','355/DST/D.D1/HM.01.01/2026'],
  ['26848066','Volume 23 Nomor 2 Tahun 2023 sampai Volume 28 Nomor 1 Tahun 2028','156/C/C3/KPT/2026'],
  ['26563622','Volume 21 Nomor 2 Tahun 2023 sampai Volume 26 Nomor 1 Tahun 2028','355/DST/D.D1/HM.01.01/2026'],
  ['2775118X','Volume 3 Nomor 1 Tahun 2022 sampai Volume 7 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['','Volume 1 Nomor 1 Tahun 2021 sampai Volume 5 Nomor 2 Tahun 2025','79/E/KPT/2023'],
  ['2774213X','Volume 10 Nomor 1 Tahun 2023 sampai Volume 14 Nomor 2 Tahun 2027','355/DST/D.D1/HM.01.01/2026'],
  ['2503457X','Volume 9 Nomor 1 Tahun 2024 sampai Volume 13 Nomor 2 Tahun 2028','355/DST/D.D1/HM.01.01/2026'],
  ['25285653','Volume 18 Nomor 2 Tahun 2023 sampai Volume 23 Nomor 1 Tahun 2028','10/C/C3/DT.05.00/2025'],
  ['25274570','Volume 21 Nomor 1 Tahun 2022 sampai Volume 25 Nomor 2 Tahun 2026','79/E/KPT/2023'],
  ['25285904','Volume 14 Nomor 2 Tahun 2023 sampai Volume 19 Nomor 1 Tahun 2028','10/C/C3/DT.05.00/2025'],
  ['28084284','Volume 2 Nomor 1 Tahun 2022 sampai Volume 6 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['25278312','Volume 22 Nomor 2 Tahun 2022 sampai Volume 27 Nomor 1 Tahun 2027','10/C/C3/DT.05.00/2025'],
  ['27762467','Volume 8 Nomor 2 Tahun 2021 sampai Volume 13 Nomor 1 Tahun 2026','177/E/KPT/2024'],
  ['26571765','mulai Volume 14 Nomor 1 Tahun 2022 (akhir tidak tertulis di SK)','10/C/C3/DT.05.00/2025'],
  ['25033522','Volume 16 Nomor 1 Tahun 2025 sampai Volume 20 Nomor 2 Tahun 2029','355/DST/D.D1/HM.01.01/2026'],
  ['27768783','Volume 20 Nomor 1 Tahun 2020 sampai Volume 24 Nomor 2 Tahun 2024','225/E/KPT/2022'],
  ['26209934','mulai Volume 1 Nomor 1 Tahun 2018 (akhir tidak tertulis di SK)','85/M/KPT/2020'],
  ['25801007','Volume 20 Nomor 2 Tahun 2023 sampai Volume 25 Nomor 1 Tahun 2028','177/E/KPT/2024'],
  ['30471095','Volume 4 Nomor 3 Tahun 2023 sampai Volume 9 Nomor 2 Tahun 2028','156/C/C3/KPT/2026'],
  ['27769852','Volume 3 Nomor 1 Tahun 2023 sampai Volume 7 Nomor 2 Tahun 2027','355/DST/D.D1/HM.01.01/2026'],
  ['28294149','Volume 1 Nomor 1 Tahun 2022 sampai Volume 5 Nomor 2 Tahun 2026','72/E/KPT/2024'],
  ['25801279','Volume 5 Nomor 2 Tahun 2023 sampai Volume 10 Nomor 1 Tahun 2028','10/C/C3/DT.05.00/2025'],
  ['','Volume 1 Nomor 1 Tahun 2021 sampai Volume 5 Nomor 2 Tahun 2025','204/E/KPT/2022'],
  ['27982432','Volume 2 Nomor 2 Tahun 2022 sampai Volume 7 Nomor 1 Tahun 2027','10/C/C3/DT.05.00/2025'],
  ['26866153','Volume 4 Nomor 1 Tahun 2022 sampai Volume 8 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['25275100','Volume 8 Nomor 2 Tahun 2023 sampai Volume 13 Nomor 1 Tahun 2028','355/DST/D.D1/HM.01.01/2026'],
  ['25282182','Volume 12 Nomor 1 Tahun 2022 sampai Volume 16 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['25414593','Volume 8 Nomor 2 Tahun 2023 sampai Volume 13 Nomor 1 Tahun 2028','177/E/KPT/2024'],
  ['26852535','Volume 5 Nomor 1 Tahun 2023 sampai Volume 9 Nomor 2 Tahun 2027','72/E/KPT/2024'],
  ['2721480X','Volume 7 Nomor 1 Tahun 2023 sampai Volume 11 Nomor 2 Tahun 2027','152/E/KPT/2023'],
  ['2776026X','Volume 20 Nomor 1 Tahun 2022 sampai Volume 24 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['28072502','Volume 2 Nomor 1 Tahun 2022 sampai Volume 6 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['25496360','Volume 9 Nomor 2 Tahun 2024 sampai Volume 14 Nomor 1 Tahun 2029','355/DST/D.D1/HM.01.01/2026'],
  ['27468909','Volume 4 Nomor 1 Tahun 2022 sampai Volume 8 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['25281178','Volume 10 Nomor 2 Tahun 2022 sampai Volume 15 Nomor 1 Tahun 2027','10/C/C3/DT.05.00/2025'],
  ['25810553','Volume 6 Nomor 2 Tahun 2022 sampai Volume 11 Nomor 1 Tahun 2027','10/C/C3/DT.05.00/2025'],
  ['28307178','Volume 1 Nomor 2 Tahun 2022 sampai Volume 6 Nomor 1 Tahun 2027','10/C/C3/DT.05.00/2025'],
  ['27769720','Volume 2 Nomor 1 Tahun 2022 sampai Volume 6 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['27224260','Volume 3 Nomor 1 Tahun 2022 sampai Volume 7 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['27747891','Volume 3 Nomor 1 Tahun 2022 sampai Volume 7 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['25284231','Volume 9 Nomor 2 Tahun 2021 sampai Volume 14 Nomor 1 Tahun 2026','177/E/KPT/2024'],
  ['27764400','Volume 2 Nomor 1 Tahun 2022 sampai Volume 6 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['27764494','Volume 2 Nomor 1 Tahun 2022 sampai Volume 6 Nomor 2 Tahun 2026','10/C/C3/DT.05.00/2025'],
  ['27765326','Volume 3 Nomor 2 Tahun 2023 sampai Volume 8 Nomor 1 Tahun 2028','156/C/C3/KPT/2026'],
  ['27234088','Volume 4 Nomor 1 Tahun 2023 sampai Volume 8 Nomor 2 Tahun 2027','156/C/C3/KPT/2026'],
  ['27970698','mulai Volume 1 Nomor 3 Tahun 2023 (akhir tidak tertulis di SK)','177/E/KPT/2024'],
  ['28097386','Volume 5 Nomor 2 Tahun 2023 sampai Volume 10 Nomor 1 Tahun 2028','156/C/C3/KPT/2026'],
  ['27767078','mulai Volume 3 Nomor 2 Tahun 2023 (akhir tidak tertulis di SK)','156/C/C3/KPT/2026'],
  ['16935284','mulai Volume 15 Nomor 1 Tahun 2018 (akhir tidak tertulis di SK)','148/M/KPT/2020'],
  ['28285778','Volume 20 Nomor 2 Tahun 2022 sampai Volume 25 Nomor 1 Tahun 2027','10/C/C3/DT.05.00/2025'],
  ['25812823','Volume 2 Nomor 1 Tahun 2018 sampai Volume 6 Nomor 2 Tahun 2022','158/E/KPT/2021'],
  ['14121891','Volume 5 Nomor 2 Tahun 2022 sampai Volume 10 Nomor 1 Tahun 2027','152/E/KPT/2023']
];

/**
 * Daftar Run di editor Apps Script hanya memuat fungsi TANPA argumen, jadi
 * updateMasaBerlakuSk(true) tidak bisa dipilih dari sana. Ini pasangannya.
 *
 * Urutannya:
 *   1. updateMasaBerlakuSk()       -> laporan saja, tidak menulis
 *   2. updateMasaBerlakuSkTULIS()  -> menulis
 */
function updateMasaBerlakuSkTULIS() {
  return updateMasaBerlakuSk(true);
}

function updateMasaBerlakuSk(tulis) {
  var sh = sheetWajib_(SHEET.MAIN);
  var nilai = sh.getDataRange().getValues();
  var header = nilai[0].map(function (h) { return norm_(h); });

  function kolom(nama) {
    for (var i = 0; i < header.length; i++) if (header[i] === norm_(nama)) return i;
    return -1;
  }

  var iNama   = kolom('NAMA JURNAL');
  var iMasa   = kolom('MASA BERLAKU SK AKREDITASI');
  var iEissn  = kolom('E-ISSN');
  var iPissn  = kolom('P-ISSN');
  var iExp    = kolom('TANGGAL EXPIRED');
  var iCatatan= kolom('Catatan Pemisahan ISSN');
  var iNomor  = kolom('Nomor SK');

  if (iNama < 0 || iMasa < 0 || iEissn < 0) {
    throw new Error('Kolom NAMA JURNAL / MASA BERLAKU SK AKREDITASI / E-ISSN tidak ketemu.');
  }


  // Tahun berakhir terbesar yang tersirat di sebuah sel, dipakai membandingkan
  // mana yang lebih baru antara isi Sheet1 dan usulan.
  function tahunAkhirDari_(teks) {
    var t = String(teks === null || teks === undefined ? '' : teks).match(/(20\d{2})/g);
    if (!t || !t.length) return 0;
    return Math.max.apply(null, t.map(Number));
  }

  var L = [];
  L.push('== PEMBARUAN MASA BERLAKU SK & NOMOR SK ==');
  L.push(tulis === true ? 'MODE: MENULIS' : 'MODE: LAPORAN SAJA (jalankan updateMasaBerlakuSkTULIS() untuk menulis)');
  L.push('Kolom MASA BERLAKU SK ada di kolom ke-' + (iMasa + 1));

  // --- pindahkan Catatan Pemisahan ISSN ke kolom baru di ujung kanan ---
  if (iNomor < 0) {
    if (iCatatan < 0) throw new Error('Kolom "Catatan Pemisahan ISSN" maupun "Nomor SK" tidak ketemu.');
    var kolBaru = header.length + 1;   // 1-based, kolom kosong pertama di kanan
    var isiCatatan = 0;
    for (var r = 1; r < nilai.length; r++) if (str_(nilai[r][iCatatan])) isiCatatan++;
    L.push('Kolom ke-' + (iCatatan + 1) + ' masih berjudul "Catatan Pemisahan ISSN" dengan ' +
           isiCatatan + ' baris terisi.');
    L.push('  -> disalin ke kolom ke-' + kolBaru + ', lalu kolom ke-' + (iCatatan + 1) +
           ' diganti judulnya jadi "Nomor SK" dan dikosongkan.');
    if (tulis === true) {
      var salinan = [['Catatan Pemisahan ISSN']];
      for (var r2 = 1; r2 < nilai.length; r2++) salinan.push([nilai[r2][iCatatan]]);
      sh.getRange(1, kolBaru, salinan.length, 1).setValues(salinan);
      var kosong = [['Nomor SK']];
      for (var r3 = 1; r3 < nilai.length; r3++) kosong.push(['']);
      sh.getRange(1, iCatatan + 1, kosong.length, 1).setValues(kosong);
      SpreadsheetApp.flush();
    }
    iNomor = iCatatan;
  } else {
    L.push('Kolom "Nomor SK" sudah ada di kolom ke-' + (iNomor + 1) + '.');
  }

  // --- peta e-ISSN -> usulan ---
  var peta = {};
  UPDATE_SK.forEach(function (u) { peta[u[0]] = u; });

  function bersihIssn(v) {
    var s = String(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^0-9X]/g, '');
    return /^[0-9]{7}[0-9X]$/.test(s) ? s : '';
  }

  var diisi = 0, sama = 0, takKetemu = 0, mundur = 0, jejak = [];
  for (var r = 1; r < nilai.length; r++) {
    var nama = str_(nilai[r][iNama]);
    if (!nama) continue;
    var e = bersihIssn(nilai[r][iEissn]);
    var p = iPissn >= 0 ? bersihIssn(nilai[r][iPissn]) : '';
    var u = peta[e] || (p ? peta[p] : null);
    if (!u) { takKetemu++; continue; }

    var lamaMasa = str_(nilai[r][iMasa]);
    var lamaNomor = str_(nilai[r][iNomor]);
    if (lamaMasa === u[1] && lamaNomor === u[2]) { sama++; continue; }

    // PENGAMAN. Sheet1 bisa memuat penetapan yang LEBIH BARU daripada kumpulan
    // SK yang kita punya, misalnya karena periodenya belum terunduh. Menulis
    // usulan yang lebih tua akan memundurkan data yang sudah benar. Kasus nyata:
    // WaPFi sudah SINTA 2 berlaku sampai 2030 di Sheet1, sedangkan rekam SK
    // terbaru kita masih 2024 Periode II yang berakhir 2026.
    var thSheet = Math.max(tahunAkhirDari_(lamaMasa), tahunAkhirDari_(nilai[r][iExp]));
    var thUsul = tahunAkhirDari_(u[1]);
    if (thSheet && thUsul && thSheet > thUsul) {
      mundur++;
      L.push('  LEWAT baris ' + (r + 1) + '  ' + nama.substring(0, 40));
      L.push('     Sheet1 sudah berakhir ' + thSheet + ', usulan hanya ' + thUsul +
             ' -> tidak ditulis supaya tidak memundurkan data');
      continue;
    }

    diisi++;
    jejak.push({ baris: r + 1, jurnal: nama, masaLama: lamaMasa, nomorLama: lamaNomor });
    L.push('  baris ' + (r + 1) + '  ' + nama.substring(0, 40));
    L.push('     I  lama: ' + (lamaMasa || '(kosong)'));
    L.push('     I  baru: ' + u[1]);
    L.push('     AH baru: ' + u[2]);

    if (tulis === true) {
      sh.getRange(r + 1, iMasa + 1).setValue(u[1]);
      sh.getRange(r + 1, iNomor + 1).setValue(u[2]);
    }
  }

  L.push('');
  L.push('Baris diperbarui        : ' + diisi);
  L.push('Sudah sama, dilewati    : ' + sama);
  L.push('Dilewati, Sheet1 lebih baru : ' + mundur + '  <-- periksa, SK periode itu belum terkumpul');
  L.push('Tidak ada usulan        : ' + takKetemu);
  L.push('Total usulan tersedia   : ' + UPDATE_SK.length);

  if (tulis === true) {
    SpreadsheetApp.flush();
    bersihkanCacheJurnal_();
    // Cadangan ditulis ke sheet tersendiri, SATU BARIS PER JURNAL.
    // Sebelumnya seluruh muatan dijejalkan ke satu sel Log_Aktivitas lewat
    // catatAktivitas_, yang memotong detail di 4000 karakter (lihat sekitar
    // Code.js:2523). Muatannya belasan kilobyte, jadi JSON-nya terpotong di
    // tengah dan cadangannya tidak bisa dipulihkan sama sekali.
    var shCad = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CADANGAN_SK);
    if (!shCad) {
      shCad = SpreadsheetApp.getActiveSpreadsheet().insertSheet(SHEET_CADANGAN_SK);
      shCad.appendRow(['Waktu', 'Baris', 'Nama Jurnal', 'Masa Berlaku Sebelumnya', 'Nomor SK Sebelumnya']);
      shCad.setFrozenRows(1);
    }
    if (jejak.length) {
      var stempel = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
      var isi = jejak.map(function (j) {
        return [stempel, j.baris, j.jurnal, j.masaLama, j.nomorLama];
      });
      shCad.getRange(shCad.getLastRow() + 1, 1, isi.length, 5).setValues(isi);
      SpreadsheetApp.flush();
    }
    catatAktivitas_('SISTEM', '-', 'UPDATE_MASA_BERLAKU_SK',
      'diperbarui ' + diisi + ' baris, cadangan di sheet ' + SHEET_CADANGAN_SK);
    L.push('Nilai lama tersimpan di sheet ' + SHEET_CADANGAN_SK + ', satu baris per jurnal.');
  } else {
    L.push('Tidak ada yang ditulis. Jalankan updateMasaBerlakuSkTULIS() bila laporan di atas sudah benar.');
  }

  var teks = L.join(String.fromCharCode(10));
  console.log(teks);
  return teks;
}


/* ==========================================================================
   33. PEMULIHAN BARIS YANG TERMUNDURKAN
   updateMasaBerlakuSk sempat dijalankan sebelum pengaman anti-mundur terpasang
   dan sebelum SK 2025 Periode II dan III terkumpul, sehingga sebagian baris
   tertulis dengan penetapan yang lebih tua daripada yang sudah ada di Sheet1.

   Nilai lama di bawah diambil dari salinan Sheet1 tertanggal 7 September 2026
   pukul 06.16, yaitu sebelum penulisan itu berjalan. Salinannya disimpan di
   sk-akreditasi/utama-sebelum-update.csv.

   Cadangan lewat Log_Aktivitas tidak bisa dipakai: catatAktivitas_ memotong
   detail di 4000 karakter, sehingga JSON-nya terpotong di tengah.

   Dua langkah:
     1. pulihkanMasaBerlakuSk()      -> laporan saja
     2. pulihkanMasaBerlakuSkTULIS() -> memulihkan
   ========================================================================== */

// [nomor baris di Sheet1, nama jurnal untuk verifikasi, nilai MASA BERLAKU SK sebelum ditimpa]
var PULIH_MASA_BERLAKU = [
  [5,'WaPFi (Wahana Pendidikan Fisika)','Reakreditasi Naik Peringkat dari Peringkat 4 ke Peringkat 2 mulai Volume 10 Nomor 2 Tahun 2025 sampai Volume 15 Nomor 1 Tahun 2030'],
  [15,'ALSUNIYAT: Jurnal Penelitian Bahasa, Sastra, dan Budaya Arab','Volume 10 Nomor 2 Tahun 2027'],
  [18,'The International Journal of Business Review (The Jobs Review)','Reakreditasi Naik Peringkat dari Peringkat 4 ke Peringkat 3 mulai Volume 8 Nomor 1 Tahun 2025 sampai Volume 12 Nomor 2 Tahun 2029'],
  [21,'Review of Islamic Economics and Finance','Vol 5 No 2 Tahun 2022-Vol 10 No 1 Tahun 2027'],
  [22,'PEDAGOGIA','sampai Volume 18 Nomor 1 Tahun 2026'],
  [24,'Jurnal Pengabdian Masyarakat PGSD','Reakreditasi Naik Peringkat dari Peringkat 5 ke Peringkat 3 mulai Volume 5 Nomor 2 Tahun 2025 sampai Volume 10 Nomor 1 Tahun 2030'],
  [26,'Jurnal Pendidikan Manajemen Perkantoran','Sampai Volume 15 Nomor 1 Tahun 2030'],
  [40,'Indonesian Journal of Educational Research and Technology (IJERT)','sampai Volume 6 Nomor 2 Tahun 2026'],
  [41,'Indonesian Journal of Community and Special Needs Education','Volume 13 Nomor 2 Tahun 2029'],
  [43,'FACTUM: Jurnal Sejarah dan Pendidikan Sejarah','Reakreditasi Naik Peringkat dari Peringkat 4 ke Peringkat 3 mulai Volume 14 Nomor 2 Tahun 2025 sampai Volume 19 Nomor 1 Tahun 2030'],
  [48,'Curricula: Journal of Curriculum Development','Volume 6 Nomor 1 Tahun 2027'],
  [51,'ASEAN Journal of Science and Engineering Education (AJSEE)','Volume 9 Nomor 2 Tahun 2029'],
  [53,'TEKMULOGI: Jurnal Pengabdian Masyarakat','Reakreditasi Tetap di Peringkat 4 mulai Volume 5 Nomor 1 Tahun 2025 sampai Volume 9 Nomor 2 Tahun 2029'],
  [69,'Jurnal Ilmu Manajemen dan Bisnis','Reakreditasi Tetap di Peringkat 4 mulai Volume 16 Nomor 1 Tahun 2025 sampai Volume 20 Nomor 2 Tahun 2029'],
  [71,'Jurnal Arsitektur ZONASI','berlaku sampai 2022'],
  [77,'Journal of Business Management Education (JBME)','sampai Volume 13 Nomor 2 Tahun 2028'],
  [88,'Artikulasi: Jurnal Pendidikan Bahasa dan Sastra Indonesia','Akreditasi Baru Peringkat 4 mulai Volume 3 Nomor 2 Tahun 2023 sampai Volume 8 Nomor 1 Tahun 2028'],
  [99,'Jurnal Lentera Karya Edukasi: Jurnal Pengabdian Kepada Masyarakat','10 Nomor 2 Tahun 2029'],
  [107,'Journal of Applied Food and Nutrition','15 Oktober 2024-15 Oktober 2028'],
  [111,'Edukids: Jurnal Pertumbuhan, Perkembangan, dan Pendidikan Anak Usia Dini','berlaku sampai edisi April 2026']
];

function pulihkanMasaBerlakuSkTULIS() {
  return pulihkanMasaBerlakuSk(true);
}

function pulihkanMasaBerlakuSk(tulis) {
  var sh = sheetWajib_(SHEET.MAIN);
  var nilai = sh.getDataRange().getValues();
  var header = nilai[0].map(function (h) { return norm_(h); });
  function kolom(nama) {
    for (var i = 0; i < header.length; i++) if (header[i] === norm_(nama)) return i;
    return -1;
  }
  var iNama  = kolom('NAMA JURNAL');
  var iMasa  = kolom('MASA BERLAKU SK AKREDITASI');
  var iNomor = kolom('Nomor SK');
  if (iNama < 0 || iMasa < 0) throw new Error('Kolom NAMA JURNAL / MASA BERLAKU SK tidak ketemu.');

  function tahunAkhir_(teks) {
    var t = String(teks === null || teks === undefined ? '' : teks).match(/\b(20\d{2})\b/g);
    return (t && t.length) ? Math.max.apply(null, t.map(Number)) : 0;
  }

  var L = [];
  L.push('== PEMULIHAN BARIS YANG TERMUNDURKAN ==');
  L.push(tulis === true ? 'MODE: MEMULIHKAN'
         : 'MODE: LAPORAN SAJA (jalankan pulihkanMasaBerlakuSkTULIS() untuk memulihkan)');
  L.push('Kandidat: ' + PULIH_MASA_BERLAKU.length + ' baris.');

  var pulih = 0, lewat = 0, salah = 0;
  PULIH_MASA_BERLAKU.forEach(function (p) {
    var r = p[0];
    if (r < 2 || r > nilai.length) { salah++; return; }
    var namaKini = str_(nilai[r - 1][iNama]);
    // Nomor baris bisa bergeser kalau ada penyisipan; nama diverifikasi dulu.
    if (norm_(namaKini) !== norm_(p[1])) {
      salah++;
      L.push('  LEWAT baris ' + r + ': nama tidak cocok. Di sheet "' + namaKini +
             '", diharapkan "' + p[1] + '". Baris mungkin bergeser.');
      return;
    }
    var kini = str_(nilai[r - 1][iMasa]);
    if (tahunAkhir_(p[2]) <= tahunAkhir_(kini)) { lewat++; return; }

    pulih++;
    L.push('  baris ' + r + '  ' + namaKini.substring(0, 42));
    L.push('     kini  : ' + kini);
    L.push('     pulih : ' + p[2]);
    if (tulis === true) {
      sh.getRange(r, iMasa + 1).setValue(p[2]);
      // Nomor SK ikut dikosongkan: nomor yang tertulis berasal dari SK lama yang
      // sudah tidak berlaku, dan yang benar belum tentu ada di kumpulan kita.
      if (iNomor >= 0) sh.getRange(r, iNomor + 1).setValue('');
    }
  });

  L.push('');
  L.push('Dipulihkan            : ' + pulih);
  L.push('Sudah benar, dilewati : ' + lewat);
  L.push('Tidak cocok / di luar : ' + salah);
  if (tulis === true) {
    SpreadsheetApp.flush();
    bersihkanCacheJurnal_();
    catatAktivitas_('SISTEM', '-', 'PULIH_MASA_BERLAKU_SK', 'dipulihkan ' + pulih + ' baris');
    L.push('Selesai. Jalankan updateMasaBerlakuSk() untuk melihat pembaruan dengan data terbaru.');
  } else {
    L.push('Tidak ada yang ditulis.');
  }

  var teks = L.join(String.fromCharCode(10));
  console.log(teks);
  return teks;
}


/* ==========================================================================
   34. DIAGNOSTIK TANGGAL EXPIRED
   Nilai di kolom TANGGAL EXPIRED terekspor sebagai "6/1/2025". Bentuk itu
   ambigu: bisa berupa sel TANGGAL sungguhan yang ditampilkan Sheets menurut
   lokal spreadsheet, bisa pula TEKS biasa. Keduanya menghasilkan hasil baca
   yang BERBEDA di bacaTanggalLonggar_:
     - sel Date  -> dikembalikan apa adanya, benar
     - sel teks  -> diurai sebagai HARI/BULAN/TAHUN, sehingga 1 Juni 2025
                    terbaca sebagai 6 Januari 2025
   Jalankan sekali untuk memastikan yang mana.
   ========================================================================== */

function cekTanggalExpired() {
  var sh = sheetWajib_(SHEET.MAIN);
  var nilai = sh.getDataRange().getValues();
  var header = nilai[0].map(function (h) { return norm_(h); });
  var iNama = header.indexOf(norm_('NAMA JURNAL'));
  var iExp  = header.indexOf(norm_('TANGGAL EXPIRED'));
  if (iExp < 0) throw new Error('Kolom TANGGAL EXPIRED tidak ketemu.');

  var L = [];
  L.push('== DIAGNOSTIK TANGGAL EXPIRED ==');
  L.push('Zona waktu spreadsheet: ' + SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone());
  L.push('Zona waktu skrip      : ' + TZ);
  L.push('');

  var jmlDate = 0, jmlTeks = 0, jmlKosong = 0, contoh = [];
  for (var r = 1; r < nilai.length; r++) {
    var v = nilai[r][iExp];
    if (v === '' || v === null || v === undefined) { jmlKosong++; continue; }
    var isDate = (v instanceof Date) && !isNaN(v.getTime());
    if (isDate) jmlDate++; else jmlTeks++;
    if (contoh.length < 12) {
      var dibaca = bacaTanggalLonggar_(v);
      contoh.push('  ' + str_(nilai[r][iNama]).substring(0, 34) +
        '  | tipe: ' + (isDate ? 'TANGGAL' : 'teks "' + String(v) + '"') +
        ' | dibaca sistem: ' + (dibaca ? Utilities.formatDate(dibaca, TZ, 'd MMMM yyyy') : '(gagal)'));
    }
  }
  L.push('Sel bertipe TANGGAL : ' + jmlDate);
  L.push('Sel bertipe teks    : ' + jmlTeks);
  L.push('Kosong              : ' + jmlKosong);
  L.push('');
  L.push('Contoh pembacaan:');
  L = L.concat(contoh);
  L.push('');
  if (jmlTeks > 0) {
    L.push('PERINGATAN: sel teks berpola "6/1/2025" akan dibaca sebagai 6 Januari 2025,');
    L.push('bukan 1 Juni 2025. Kalau maksudnya bulan/tanggal/tahun, isinya perlu diubah');
    L.push('ke bentuk yyyy-mm-dd yang tidak bermakna ganda.');
  } else {
    L.push('Seluruh sel bertipe TANGGAL, jadi tidak ada risiko tertukar hari dan bulan.');
  }

  var teks = L.join(String.fromCharCode(10));
  console.log(teks);
  return teks;
}
