# Menyusun ulang section 33 (pemulihan) memakai salinan Sheet1 SEBELUM penulisan,
# dan memperbaiki mekanisme pencadangan di section 32.
#
# Cadangan lewat catatAktivitas_ gagal karena fungsi itu memotong detail di 4000
# karakter (Code.js:2523), sedangkan muatannya sekitar 14 KB. JSON-nya terpotong
# di tengah sehingga tidak bisa diurai. Penggantinya: sheet cadangan tersendiri.
import json, io, os

TMP = os.path.dirname(os.path.abspath(__file__))
CODE = os.path.join(os.path.dirname(TMP), 'Code.js')
pulih = json.load(open(os.path.join(TMP, 'pemulihan.json'), encoding='utf-8'))

def q(s):
    return "'" + str(s or '').replace('\\', '\\\\').replace("'", "\\'").replace('\n', ' ') + "'"

baris = ',\n'.join('  [%d,%s,%s]' % (p['baris'], q(p['nama']), q(p['lama'])) for p in pulih)

FN = '''

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
%s
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
    var t = String(teks === null || teks === undefined ? '' : teks).match(/\\b(20\\d{2})\\b/g);
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
''' % baris

s = io.open(CODE, encoding='utf-8', newline='').read()
if '33. PEMULIHAN' in s:
    i = s.index('33. PEMULIHAN')
    i = s.rfind('/* ===', 0, i)
    s = s[:i]
io.open(CODE, 'w', encoding='utf-8', newline='').write(s.rstrip('\n') + '\n' + FN)
print('section 33 ditulis ulang dengan %d baris pemulihan' % len(pulih))
