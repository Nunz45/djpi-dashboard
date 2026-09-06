import json, re, io, os, csv, datetime
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

d = json.load(open('sk-upi-mentah.json', encoding='utf-8'))

for b in d:
    s = b['namaJurnal']
    for _ in range(3):
        s2 = re.sub(r'^\s*\d{1,4}[.\s]+', '', s)
        if s2 == s: break
        s = s2
    b['namaJurnal'] = s.strip(' .;:,-')
    b['perluDicek'] = 'ya' if len(b['namaJurnal']) < 5 else ''

def masaBerlaku(b):
    if b['asalAkhir'] == 'tertulis di SK':
        return 'Vol %s No %s Tahun %s s.d. Vol %s No %s Tahun %s' % (
            b['volMulai'], b['noMulai'], b['tahunMulai'], b['volAkhir'], b['noAkhir'], b['tahunAkhir'])
    if b['asalAkhir'].startswith('DITURUNKAN'):
        return 'mulai Vol %s No %s Tahun %s - berakhir sekitar %s (diturunkan, tidak tertulis di SK)' % (
            b['volMulai'], b['noMulai'], b['tahunMulai'], b['tahunAkhir'])
    return 'tidak tercantum di SK'

TAHUN_INI = datetime.date.today().year
for b in d:
    b['masaBerlaku'] = masaBerlaku(b)

# catatan yang berlaku = SK TERBARU per e-ISSN. Bukan yang tahun akhirnya paling
# jauh: penurunan peringkat bisa memperpendek masa berlaku, dan penomoran volume
# bisa mengulang dari awal sehingga tidak bisa dipakai mengurutkan.
terbaru = {}
for b in sorted(d, key=lambda x: x['urut']):
    terbaru[b['eIssn']] = b
berlaku = sorted(terbaru.values(), key=lambda x: (-x['urut'], x['namaJurnal'].lower()))
for b in berlaku:
    b['jumlahSk'] = sum(1 for x in d if x['eIssn'] == b['eIssn'])
    th = b['tahunAkhir']
    if not th:
        b['perhatian'] = 'tanggal akhir tidak diketahui'
    elif int(th) < TAHUN_INI:
        b['perhatian'] = 'SUDAH LEWAT'
    elif int(th) == TAHUN_INI:
        b['perhatian'] = 'berakhir tahun ini'
    elif int(th) == TAHUN_INI + 1:
        b['perhatian'] = 'berakhir tahun depan'
    else:
        b['perhatian'] = ''

MARUN='FF7F0000'; KERTAS='FFF4EFEB'; EMAS='FFFBF3DF'; MERAH='FFFBECEC'
tepi = Border(*[Side(style='thin', color='FFD8D0C8')]*4)

def tulis(ws, kolom, data, lebar, bungkus=(1,3)):
    for i,k in enumerate(kolom,1):
        c=ws.cell(1,i,k); c.font=Font(bold=True,color='FFFFFFFF',size=10)
        c.fill=PatternFill('solid',fgColor=MARUN)
        c.alignment=Alignment(vertical='center',wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width=lebar[i-1]
    ws.row_dimensions[1].height=30
    for r,row in enumerate(data,2):
        for i,v in enumerate(row,1):
            c=ws.cell(r,i,v); c.border=tepi; c.font=Font(size=10)
            c.alignment=Alignment(vertical='top',wrap_text=(i in bungkus))
        if r%2==0:
            for i in range(1,len(kolom)+1): ws.cell(r,i).fill=PatternFill('solid',fgColor=KERTAS)
    ws.freeze_panes='A2'
    ws.auto_filter.ref='A1:%s%d'%(get_column_letter(len(kolom)),len(data)+1)

wb=Workbook()

# ---------- 1. Masa Berlaku ----------
ws=wb.active; ws.title='Masa Berlaku'
kol=['Nama Jurnal','Nomor SK','Masa Berlaku','e-ISSN','Peringkat','Jenis Penetapan',
     'Periode SK','Tanggal SK','Sumber Tanggal Akhir','Perhatian','Jumlah SK','Perlu Dicek','Berkas Sumber']
data=[[b['namaJurnal'],b['nomorSk'],b['masaBerlaku'],b['eIssn'],
       ('SINTA '+b['peringkat']) if b['peringkat'] else '',b['jenis'],b['periode'],
       b['tanggalSk'],b['asalAkhir'],b['perhatian'],b['jumlahSk'],b['perluDicek'],b['berkas']]
      for b in berlaku]
tulis(ws,kol,data,[44,22,46,12,11,26,18,17,26,22,10,11,38])
for r,b in enumerate(berlaku,2):
    if b['asalAkhir']!='tertulis di SK':
        for i in (3,9): ws.cell(r,i).fill=PatternFill('solid',fgColor=EMAS)
    if b['perhatian'] in ('SUDAH LEWAT','berakhir tahun ini'):
        ws.cell(r,10).fill=PatternFill('solid',fgColor=MERAH)
        ws.cell(r,10).font=Font(size=10,bold=True,color=MARUN)

# ---------- 2. Riwayat ----------
ws2=wb.create_sheet('Riwayat Semua SK')
kol2=['Nama Jurnal','Nomor SK','Masa Berlaku','e-ISSN','Peringkat','Jenis Penetapan',
      'Periode SK','Tanggal SK','Sumber Tanggal Akhir','Status Rekam','Digantikan Oleh']
d2=sorted(d,key=lambda x:(x['eIssn'],x['urut']))
data2=[]
for b in d2:
    aktif = terbaru.get(b['eIssn']) is b
    data2.append([b['namaJurnal'],b['nomorSk'],b['masaBerlaku'],b['eIssn'],
                  ('SINTA '+b['peringkat']) if b['peringkat'] else '',b['jenis'],
                  b['periode'],b['tanggalSk'],b['asalAkhir'],
                  'BERLAKU' if aktif else 'digantikan',
                  '' if aktif else terbaru[b['eIssn']]['nomorSk']])
tulis(ws2,kol2,data2,[44,22,46,12,11,26,18,17,26,14,22])

# ---------- 3. Cek silang dengan Sheet1 direktori ----------
# Sheet1 adalah acuan yang dipakai aplikasi, jadi lembar ini dibangun DARI Sheet1
# dan bukan dari hasil urai SK. Jurnal yang tidak ketemu jadi temuan bernama,
# bukan baris yang hilang diam-diam.
cs = {}
if os.path.exists('cek-silang.json'):
    cs = json.load(open('cek-silang.json', encoding='utf-8'))

if cs:
    ws3 = wb.create_sheet('Cek Silang Sheet1')
    kol3 = ['Nama Jurnal (Sheet1)', 'Kluster', 'e-ISSN', 'Status di Sheet1',
            'Peringkat menurut SK', 'Nomor SK', 'Periode SK', 'Masa Berlaku menurut SK',
            'Tanggal Expired di Sheet1', 'Frekuensi Terbit', 'Terbit/Tahun',
            'Perkiraan Bulan Berakhir', 'Cara Gabung', 'Selisih yang Ditemukan']
    data3 = [[h['nama'], h['kluster'], h['eIssn'], h['statusSheet1'], h['peringkatSk'],
              h['nomorSk'], h['periodeSk'], h['masaBerlaku'], h['tanggalExpiredSheet1'],
              h['issue'], h['terbitPerTahun'], h['perkiraanBulanBerakhir'],
              h['caraGabung'], h['catatan']] for h in cs['hasil']]
    tulis(ws3, kol3, data3, [40,14,12,15,17,26,16,40,17,20,12,16,16,58],
          bungkus=(1,8,14))
    for r, h in enumerate(cs['hasil'], 2):
        if h['catatan']:
            ws3.cell(r,14).fill = PatternFill('solid', fgColor=MERAH)
        if h['caraGabung'] == 'nama jurnal':
            ws3.cell(r,13).fill = PatternFill('solid', fgColor=EMAS)

    if cs.get('yatim'):
        ws3b = wb.create_sheet('Ada di SK Tapi Tidak di Sheet1')
        kol3b = ['Nama Jurnal (dari SK)', 'e-ISSN', 'Peringkat', 'Nomor SK',
                 'Periode SK', 'Cuplikan Penerbit di SK']
        data3b = [[y['namaJurnal'], y['eIssn'],
                   ('SINTA ' + y['peringkat']) if y['peringkat'] else '',
                   y['nomorSk'], y['periode'], y.get('penerbitCuplikan','')]
                  for y in cs['yatim']]
        tulis(ws3b, kol3b, data3b, [46,12,11,26,18,64], bungkus=(1,6))

# ---------- 4. Pemeriksaan ----------
ws4=wb.create_sheet('Pemeriksaan')
ws4.column_dimensions['A'].width=64; ws4.column_dimensions['B'].width=14; ws4.column_dimensions['C'].width=58
uji=[]
def U(nama,lolos,gagal,ket=''):
    uji.append([nama,'LOLOS' if not gagal else '%d menyimpang'%gagal,ket])

g=0; ket=[]
for b in d:
    if b['asalAkhir']=='tertulis di SK':
        dv=int(b['volAkhir'])-int(b['volMulai']); dt=int(b['tahunAkhir'])-int(b['tahunMulai'])
        if dv not in (4,5) or dt not in (4,5) or abs(dv-dt)>1:
            g+=1; ket.append('%s (Vol%s->%s, %s->%s)'%(b['namaJurnal'][:34],b['volMulai'],b['volAkhir'],b['tahunMulai'],b['tahunAkhir']))
U('Selisih volume dan tahun sama-sama 4 atau 5', True, g, '; '.join(ket[:3]))

g=sum(1 for b in d if 'mulai' in b['masaBerlaku'] and b['urut']>=2021 and b['asalAkhir']!='tertulis di SK')
U('SK 2021+ selalu punya klausa "sampai"', True, g, 'kalau ada, itu kegagalan penguraian bukan data')

g=sum(1 for b in berlaku if b['perluDicek'])
U('Nama jurnal terurai utuh', True, g, 'baris bertanda ya perlu dibaca manual')

pasangan={}
for b in d: pasangan.setdefault((b['nomorSk'],b['eIssn']),0); pasangan[(b['nomorSk'],b['eIssn'])]+=1
g=sum(1 for v in pasangan.values() if v>1)
U('Tidak ada e-ISSN ganda dalam satu SK', True, g)

g=sum(1 for b in d if not re.match(r'^\d{7}[\dX]$', b['eIssn']))
U('Format e-ISSN 8 karakter', True, g)

ganda=[e for e in {b['eIssn'] for b in d} if sum(1 for x in d if x['eIssn']==e)>1]
U('Jurnal dengan lebih dari satu SK', True, 0, '%d jurnal — lihat sheet Riwayat'%len(ganda))

r=1
ws4.cell(r,1,'Pemeriksaan otomatis atas berkas ini').font=Font(bold=True,size=13,color=MARUN); r+=2
for nm,hasil,k in uji:
    ws4.cell(r,1,nm).font=Font(size=10)
    c=ws4.cell(r,2,hasil); c.font=Font(size=10,bold=True,color=('FF1F5A2A' if hasil=='LOLOS' else MARUN))
    ws4.cell(r,3,k).font=Font(size=9,color='FF6B615C'); r+=1
r+=1
for t in [
 'Yang BELUM diperiksa dan perlu dikerjakan manual:',
 '- Nomor terbitan akhir harus <= jumlah nomor per tahun jurnal tersebut. Kalau SK menyebut',
 '  Nomor 12 sementara jurnal terbit 2 kali setahun, penurunan bulannya akan meleset jauh.',
 '  Pemeriksaan ini butuh kolom frekuensi terbit dari direktori, tidak ada di berkas ini.',
 '- Peringkat di SK vs peringkat di direktori. Beda berarti direktori kedaluwarsa atau salah jurnal.',
 '- Baris dari SK 2025 Periode II belum masuk sama sekali (lihat Catatan).',
]:
    ws4.cell(r,1,t).font=Font(size=10, bold=t.endswith(':')); r+=1

# ---------- 5. Catatan ----------
ws5=wb.create_sheet('Catatan & Keterbatasan'); ws5.column_dimensions['A'].width=118
catatan=[
 ('J','Daftar Jurnal UPI Menurut SK Akreditasi/Reakreditasi SINTA'),
 ('',''),
 ('H','Cara berkas ini dibuat'),
 ('','SK diunduh dari tautan pada "Daftar SK Akreditasi dan Reakreditasi SINTA.md" ke folder'),
 ('','C:\\Users\\Asus\\Documents\\SK Akreditasi, digabung dengan SK yang sudah ada di sana.'),
 ('','Lampiran diurai dengan PyMuPDF; jangkarnya e-ISSN, bukan nama jurnal.'),
 ('','Skrip ada di djpi-dashboard\\sk-akreditasi dan bisa dijalankan ulang saat SK baru terbit.'),
 ('',''),
 ('H','Dua jebakan yang sempat membuat hasil ini salah'),
 ('','1. Pencarian penerbit harus dilakukan setelah spasi dinormalkan. PDF memecah isi sel jadi'),
 ('','   beberapa baris, sehingga "Universitas \\nPendidikan \\nIndonesia" tidak cocok dengan'),
 ('','   pencarian biasa. Versi pertama melaporkan nol jurnal UPI di hampir semua SK.'),
 ('','2. Menuntut frasa penuh "Universitas Pendidikan Indonesia" melewatkan "UPI Kampus Cibiru",'),
 ('','   "UPI Press", dan "FPOK UPI". Saringan sekarang dua lapis: terima UPI singkat, tetapi'),
 ('','   tolak "Universitas Putra Indonesia YPTK", "Institut Pendidikan Indonesia Garut", dan'),
 ('','   "Universitas Pendidikan Ganesha" yang bukan milik UPI.'),
 ('',''),
 ('H','Tiga format lampiran, dan akibatnya pada kolom Masa Berlaku'),
 ('','SK 2018        : hanya peringkat dan penerbit. TIDAK ADA rentang volume sama sekali.'),
 ('','SK 2019-2020   : hanya "mulai Volume X Nomor Y Tahun Z", tanpa "sampai". Tahun akhir'),
 ('','                 DITURUNKAN (awal + 5 tahun) dan diberi latar kuning.'),
 ('','SK 2021 ke atas: rentang penuh "mulai ... sampai ...". Ini yang paling tepercaya.'),
 ('',''),
 ('H','Yang harus diperhatikan sebelum dipakai mengambil keputusan'),
 ('','- Baris berlatar kuning: tanggal akhirnya tidak tertulis di SK. Jangan dipakai menghitung'),
 ('','  tenggat sebelum diperiksa ke sertifikat jurnal yang bersangkutan.'),
 ('','- SK memuat volume dan nomor, BUKAN bulan. Bulan pastinya baru bisa dihitung kalau'),
 ('','  frekuensi terbit jurnal diketahui. Jangan menganggap masa berlaku habis 31 Desember.'),
 ('','- Masa berlaku dihitung dari VOLUME YANG DINILAI, bukan dari tanggal SK. Karena itu ada'),
 ('','  jurnal yang SK-nya baru terbit tetapi masa berlakunya tinggal satu dua tahun. Urutkan'),
 ('','  berdasarkan kolom Perhatian, jangan berdasarkan tanggal SK.'),
 ('','- Rekam yang berlaku dipilih dari SK TERBARU, bukan dari tahun akhir terjauh. Penurunan'),
 ('','  peringkat bisa memperpendek masa berlaku, dan penomoran volume bisa mengulang dari awal.'),
 ('',''),
 ('H','SK yang belum masuk berkas ini'),
 ('','- 2018 Periode III (34/E/KPT/2018): tautan acuan mengarah ke Scribd, bukan PDF.'),
 ('','- 2022 Periode I (105/E/KPT/2022): cermin repositori menolak unduhan.'),
 ('','- 2025 Periode II: DUA SK berbeda, bukan dua versi satu dokumen.'),
 ('','    295/C/C3/KPT/2026 (2 Januari 2026) untuk REAKREDITASI, PDF-nya belum didapat.'),
 ('','    156/C/C3/KPT/2026 (7 April 2026) untuk AKREDITASI BARU peringkat 3 sampai 6.'),
 ('','    Berkas 156 ada di folder Anda tetapi berupa PINDAIAN 217 halaman tanpa lapisan teks;'),
 ('','    hasil konversinya ke xlsx sudah ada tetapi memuat salah baca OCR pada angka volume.'),
 ('','    Baris dari periode ini HARUS dimasukkan manual setelah diperiksa ke PDF-nya.'),
 ('','- Peringkat 1 dan 2 periode 2 tahun 2025 tidak ada di berkas mana pun.'),
 ('','- 2019 Periode IV dan V, 2022 Periode IV, 2023 Periode III-IV, 2024 Periode III,'),
 ('','  dan 2026 Periode I tidak tercantum di daftar acuan.'),
 ('','- 2021 Periode II dan 2019 Periode III terunduh tetapi tidak menghasilkan baris UPI:'),
 ('','  lapisan teksnya rusak berkolom. Perlu diperiksa manual.'),
 ('',''),
 ('H','Sumber lain yang jangan dijadikan acuan utama'),
 ('','Folder "Hasil reakreditasi periode 2" berisi 17 tangkapan layar WhatsApp bertanggal'),
 ('','8 April 2026, sehari setelah SK 156 terbit. Berguna untuk pembanding, tetapi tidak bisa'),
 ('','dilampirkan pada pengajuan resmi.'),
]
r=1
for j,t in catatan:
    c=ws5.cell(r,1,t)
    c.font=Font(bold=True,size=14,color=MARUN) if j=='J' else (
           Font(bold=True,size=11,color=MARUN) if j=='H' else Font(size=10))
    r+=1

TUJUAN=r'C:\Users\Asus\Documents\Daftar Jurnal UPI - Masa Berlaku Akreditasi SINTA.xlsx'
wb.save(TUJUAN)
print('Excel ditulis: %s'%TUJUAN)
print('  Masa Berlaku          : %d jurnal'%len(berlaku))
print('  Riwayat Semua SK      : %d penetapan'%len(d2))
if cs:
    print('  Cek Silang Sheet1     : %d baris, %d punya selisih'%(
          len(cs['hasil']), sum(1 for h in cs['hasil'] if h['catatan'])))
    print('  Ada di SK tapi tidak di Sheet1 : %d'%len(cs.get('yatim',[])))
print()
for k in ['tertulis di SK','DITURUNKAN (awal + 5 tahun)','tidak ada']:
    print('  akhir %-30s %d'%(k,sum(1 for b in berlaku if b['asalAkhir']==k)))
print('  SUDAH LEWAT / berakhir tahun ini : %d'%sum(1 for b in berlaku if b['perhatian'] in ('SUDAH LEWAT','berakhir tahun ini')))
