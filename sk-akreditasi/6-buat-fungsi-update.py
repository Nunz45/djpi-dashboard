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
     2. updateMasaBerlakuSk(true)  -> menulis, setelah laporannya Anda setujui

   Kolom TANGGAL EXPIRED sengaja TIDAK disentuh: bulan berakhirnya dicari staf
   dari terbitan yang bersangkutan, dan harinya selalu tanggal 1.
   ========================================================================== */

// [e-ISSN, MASA BERLAKU SK AKREDITASI, Nomor SK]
var UPDATE_SK = [
%s
];

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
  var iCatatan= kolom('Catatan Pemisahan ISSN');
  var iNomor  = kolom('Nomor SK');

  if (iNama < 0 || iMasa < 0 || iEissn < 0) {
    throw new Error('Kolom NAMA JURNAL / MASA BERLAKU SK AKREDITASI / E-ISSN tidak ketemu.');
  }

  var L = [];
  L.push('== PEMBARUAN MASA BERLAKU SK & NOMOR SK ==');
  L.push(tulis === true ? 'MODE: MENULIS' : 'MODE: LAPORAN SAJA (jalankan updateMasaBerlakuSk(true) untuk menulis)');
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

  var diisi = 0, sama = 0, takKetemu = 0, jejak = [];
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
  L.push('Tidak ada usulan        : ' + takKetemu);
  L.push('Total usulan tersedia   : ' + UPDATE_SK.length);

  if (tulis === true) {
    SpreadsheetApp.flush();
    bersihkanCacheJurnal_();
    // Nilai lama disimpan supaya pembaruan ini bisa ditelusuri dan dibatalkan.
    catatAktivitas_('SISTEM', '-', 'UPDATE_MASA_BERLAKU_SK',
      JSON.stringify({ diperbarui: diisi, nilaiLama: jejak }).substring(0, 45000));
    L.push('Nilai lama tersimpan di ' + SHEET.AKTIVITAS + ' (aksi UPDATE_MASA_BERLAKU_SK).');
  } else {
    L.push('Tidak ada yang ditulis. Jalankan updateMasaBerlakuSk(true) bila laporan di atas sudah benar.');
  }

  var teks = L.join(String.fromCharCode(10));
  console.log(teks);
  return teks;
}
''' % data

s = io.open(CODE, encoding='utf-8', newline='').read()
if 'function updateMasaBerlakuSk' in s:
    a = s.index('\n/* ====\n   32. PEMBARUAN'.replace('====', '======================================================================'))
    s = s[:a]
io.open(CODE, 'w', encoding='utf-8', newline='').write(s.rstrip('\n') + '\n' + fn)
print('Fungsi updateMasaBerlakuSk() ditulis ke Code.js dengan %d usulan.' % len(u))
