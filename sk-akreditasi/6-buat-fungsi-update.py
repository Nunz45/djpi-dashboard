# Menyusun fungsi Apps Script pembaru Sheet1 dari usulan-update.json,
# lalu menempelkannya ke Code.js sebagai section 32.
import json, io, os, re

TMP = os.path.dirname(os.path.abspath(__file__))
CODE = os.path.join(os.path.dirname(TMP), 'Code.js')

u = json.load(open(os.path.join(TMP, 'usulan-update.json'), encoding='utf-8'))['usul']

def q(s):
    return "'" + str(s or '').replace('\\', '\\\\').replace("'", "\\'") + "'"

baris = []
for x in u:
    baris.append('  [%s,%s,%s]' % (q(x['eIssn']), q(x['I_baru']), q(x['AH_baru'])))
data = ',\n'.join(baris)

fn = '''

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
%s
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
    var t = String(teks === null || teks === undefined ? '' : teks).match(/\b(20\d{2})\b/g);
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
''' % data

s = io.open(CODE, encoding='utf-8', newline='').read()
if '32. PEMBARUAN MASA BERLAKU SK' in s:
    # potong dari awal blok komentar section 32 sampai sebelum section 33
    i = s.index('32. PEMBARUAN MASA BERLAKU SK')
    i = s.rfind('/* ===', 0, i)
    j = s.find('33. PEMULIHAN SETELAH PEMBARUAN', i)
    if j != -1:
        j = s.rfind('/* ===', i, j)
        s = s[:i] + s[j:]
    else:
        s = s[:i]
io.open(CODE, 'w', encoding='utf-8', newline='').write(s.rstrip('\n') + '\n' + fn)
print('Fungsi updateMasaBerlakuSk() ditulis ke Code.js dengan %d usulan.' % len(u))
