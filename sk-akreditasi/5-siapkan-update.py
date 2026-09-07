# Menyiapkan nilai yang akan ditulis ke Sheet1:
#   kolom I  = MASA BERLAKU SK AKREDITASI  (rentang volume dari lampiran SK)
#   kolom AH = Nomor SK
#
# Tidak menulis apa pun. Keluarannya berkas usulan yang harus dilihat dulu.
# TANGGAL EXPIRED (kolom L) sengaja TIDAK disentuh: bulannya dicari staf, dan
# tanggalnya selalu tanggal 1.
import csv, io, json, os, re

TMP = os.path.dirname(os.path.abspath(__file__))

# Tiga jurnal ini dikecualikan atas permintaan.
KECUALI = {
    'indonesian journal of science and technology',
    'indonesian journal of applied linguistics',
    'asean journal of science and engineering',
}

def issn(v):
    v = re.sub(r'[^0-9Xx]', '', str(v or '')).upper()
    return v if re.match(r'^\d{7}[\dX]$', v) else ''

def kunci(n):
    n = re.sub(r'\([^)]*\)', ' ', n or '')
    n = re.sub(r'[^a-z0-9 ]', ' ', n.lower())
    return re.sub(r'\s+', ' ', n).strip()

utama = list(csv.DictReader(io.open(os.path.join(TMP,'utama.csv'), encoding='utf-8-sig', newline='')))
sk = json.load(open(os.path.join(TMP,'sk-upi-mentah.json'), encoding='utf-8'))

terbaru = {}
for b in sorted(sk, key=lambda x: x['urut']):
    if b['eIssn']: terbaru[b['eIssn']] = b
petaNama = {}
for e, b in terbaru.items(): petaNama.setdefault(kunci(b['namaJurnal']), b)

def masaBerlaku(b):
    if b['asalAkhir'] == 'tertulis di SK':
        return 'Volume %s Nomor %s Tahun %s sampai Volume %s Nomor %s Tahun %s' % (
            b['volMulai'], b['noMulai'], b['tahunMulai'], b['volAkhir'], b['noAkhir'], b['tahunAkhir'])
    if b['asalAkhir'].startswith('DITURUNKAN'):
        return 'mulai Volume %s Nomor %s Tahun %s (akhir tidak tertulis di SK)' % (
            b['volMulai'], b['noMulai'], b['tahunMulai'])
    return ''

usul, lewat = [], []
for i, r in enumerate(utama, start=2):        # baris 2 = data pertama di Sheet
    nama = (r.get('NAMA JURNAL') or '').strip()
    if not nama: continue
    if kunci(nama) in KECUALI:
        lewat.append((i, nama, 'dikecualikan atas permintaan')); continue

    e = issn(r.get('E-ISSN')); pi = issn(r.get('P-ISSN'))
    rec, cara = (terbaru.get(e), 'e-ISSN (AF)') if e and e in terbaru else (None, '')
    if not rec and pi and pi in terbaru: rec, cara = terbaru[pi], 'p-ISSN (AG)'
    if not rec:
        rec = petaNama.get(kunci(nama)); cara = 'nama jurnal' if rec else ''
    if not rec:
        lewat.append((i, nama, 'tidak ada rekam SK')); continue

    mb = masaBerlaku(rec)
    if not mb:
        lewat.append((i, nama, 'SK tidak memuat rentang volume')); continue

    lamaI  = (r.get('MASA BERLAKU SK AKREDITASI') or '').strip()
    lamaAH = (r.get('Catatan Pemisahan ISSN') or '').strip()
    usul.append({
        'baris': i, 'nama': nama, 'eIssn': e, 'cara': cara,
        'I_lama': lamaI, 'I_baru': mb,
        'AH_lama': lamaAH, 'AH_baru': rec['nomorSk'],
        'periode': rec['periode'],
        'berubahI': lamaI != mb,
        'timpaAH': bool(lamaAH),
        'perluPeriksa': cara != 'e-ISSN (AF)' or 'PERLU KONFIRMASI' in rec['nomorSk'],
    })

json.dump({'usul': usul, 'lewat': lewat},
          open(os.path.join(TMP,'usulan-update.json'),'w',encoding='utf-8'),
          ensure_ascii=False, indent=2)

print('=== USULAN PEMBARUAN Sheet1 ===')
print('  baris akan diisi           : %d' % len(usul))
print('  kolom I berubah nilainya   : %d' % sum(1 for u in usul if u['berubahI']))
print('  kolom I sudah sama         : %d' % sum(1 for u in usul if not u['berubahI']))
print('  kolom AH akan MENIMPA isi  : %d  <-- perhatikan' % sum(1 for u in usul if u['timpaAH']))
print('  perlu diperiksa dulu       : %d  (gabung bukan lewat e-ISSN, atau nomor SK belum pasti)'
      % sum(1 for u in usul if u['perluPeriksa']))
print()
print('  dilewati                   : %d' % len(lewat))
import collections
for k, v in collections.Counter(x[2] for x in lewat).most_common():
    print('     %-34s %d' % (k, v))
print()
print('=== 6 contoh perubahan kolom I ===')
for u in [x for x in usul if x['berubahI']][:6]:
    print('  baris %-4d %-38s' % (u['baris'], u['nama'][:38]))
    print('        lama: %r' % u['I_lama'][:64])
    print('        baru: %r' % u['I_baru'][:64])
print()
print('Ditulis: usulan-update.json — belum ada yang ditulis ke Sheet1.')
