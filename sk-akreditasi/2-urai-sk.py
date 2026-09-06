# Mengurai lampiran SK -> baris milik Universitas Pendidikan Indonesia.
#
# Lampiran SK memakai TIGA format berbeda, dan ini menentukan seberapa jauh
# masa berlaku bisa diketahui:
#   A. 2018        : Peringkat dari judul bagian, TANPA rentang volume sama sekali
#   B. 2019-2020   : "... mulai Volume X Nomor Y Tahun Z"  (hanya awal, tanpa akhir)
#   C. 2021 ke atas: "... mulai ... sampai Volume D Nomor E Tahun F"  (rentang penuh)
#
# Untuk format B, akhir masa berlaku DITURUNKAN (awal + 5 tahun) dan ditandai
# supaya tidak tertukar dengan yang benar-benar tertulis di dokumen.
import pymupdf, re, os, json, io

SUMBER = r'C:\Users\Asus\Documents\SK Akreditasi'

BERKAS = [
 (2018.1, '2018 Periode I',   '21/E/KPT/2018',        '9 Juli 2018',      'SK 2018-I (21-E-KPT-2018).pdf'),
 (2019.1, '2019 Periode I',   '3/E/KPT/2019',         '14 Januari 2019',  'SK 2019-I (3-E-KPT-2019).pdf'),
 (2019.2, '2019 Periode II',  '10/E/KPT/2019',        '',                 'SK 2019-II (10-E-KPT-2019).pdf'),
 (2019.3, '2019 Periode III', '14/E/KPT/2019',        '10 Mei 2019',      'SK 2019-III (14-E-KPT-2019).pdf'),
 (2019.6, '2019 Periode VI',  '30/E/KPT/2019',        '11 November 2019', 'SK 2019-VI (30-E-KPT-2019).pdf'),
 (2020.1, '2020 Periode I',   '85/M/KPT/2020',        '',                 'SK 2020-I (85-M-KPT-2020).pdf'),
 (2020.2, '2020 Periode II',  '148/M/KPT/2020',       '3 Agustus 2020',   'SK 2020-II (148-M-KPT-2020).pdf'),
 (2020.3, '2020 Periode III', '(nomor belum tercatat)','',                'SK 2020-III (tanpa-nomor).pdf'),
 (2021.1, '2021 Periode I',   '158/E/KPT/2021',       '9 Desember 2021',  'SK 2021-I (158-E-KPT-2021).pdf'),
 (2021.2, '2021 Periode II',  '164/E/KPT/2021',       '',                 'SK 2021-II (164-E-KPT-2021).pdf'),
 (2022.2, '2022 Periode II',  '204/E/KPT/2022',       '3 Oktober 2022',   'SK 2022-II (204-E-KPT-2022).pdf'),
 (2022.3, '2022 Periode III', '225/E/KPT/2022',       '7 Desember 2022',  'Hasil Akreditasi Jurnal Ilmiah Periode III Tahun 2022.pdf'),
 (2023.1, '2023 Periode I',   '79/E/KPT/2023',        '11 Mei 2023',      'SK 2023-I (79-E-KPT-2023).pdf'),
 (2023.2, '2023 Periode II',  '152/E/KPT/2023',       '25 September 2023','SK 2023-II (152-E-KPT-2023).pdf'),
 (2024.1, '2024 Periode I',   '72/E/KPT/2024',        '1 April 2024',     'SK 2024-I (72-E-KPT-2024).pdf'),
 (2024.2, '2024 Periode II',  '177/E/KPT/2024',       '15 Oktober 2024',  'SK 2024-II (177-E-KPT-2024).pdf'),
 (2025.1, '2025 Periode I',   '10/C/C3/DT.05.00/2025','21 Maret 2025',    'SK 2025-I (10-C-C3-2025).pdf'),
]

# Penerbit UPI ditulis dengan banyak bentuk. Menuntut frasa penuh
# "Universitas Pendidikan Indonesia" melewatkan "UPI Kampus Cibiru",
# "UPI Press", dan "Departemen Pendidikan Olahraga-FPOK UPI".
# Sebaliknya, menerima "UPI" polos akan ikut menarik "Majalah Ilmiah UPI YPTK"
# milik Universitas Putra Indonesia Padang. Karena itu dua lapis.
UPI_PENUH = re.compile(r'universitas\s+pendidikan\s+indonesia', re.I)
UPI_SINGKAT = re.compile(r'\bUPI\b')
BUKAN_UPI = re.compile(
    r'(institut\s+(teknologi\s+)?pendidikan\s+indonesia'
    r'|pendidikan\s+ganesha'
    r'|putra\s+indonesia'
    r'|YPTK'
    r'|wise\s+pendidikan'
    r'|sean\s+institute'
    r'|masyarakat\s+penelitian\s+pendidikan\s+indonesia)', re.I)

def milikUpi(ekor):
    if UPI_PENUH.search(ekor):
        return True
    return bool(UPI_SINGKAT.search(ekor)) and not BUKAN_UPI.search(ekor)

# Nomor SK dibaca dari kepala dokumen, bukan dari tabel acuan. Satu entri di
# daftar acuan tertulis "-" padahal berkasnya sendiri memuat 200/M/KPT/2020.
NOMOR_DOK = re.compile(r'NOMOR\s+([0-9]+\s*/\s*[A-Za-z0-9./]+)', re.I)
ISSN = re.compile(r'\b(\d{7}[\dXx])\b')
PENUH = re.compile(r'mulai\s+Volume\s+(\d+)\s+Nomor\s+(\d+)\s+Tahun\s+(\d{4})\s+'
                   r'sampai\s+Volume\s+(\d+)\s+Nomor\s+(\d+)\s+Tahun\s+(\d{4})', re.I)
AWAL  = re.compile(r'mulai\s+Volume\s+(\d+)\s+Nomor\s+(\d+)\s+Tahun\s+(\d{4})', re.I)
PERINGKAT = re.compile(r'Peringkat\s+(\d)\b', re.I)
# "Naik Peringkat dari Peringkat 4 ke Peringkat 3" -> yang berlaku adalah 3.
# Mengambil kemunculan pertama akan selalu memberi peringkat LAMA.
PERINGKAT_BARU = re.compile(r'dari\s+[Pp]eringkat\s+\d\s+ke\s+(?:[Pp]eringkat\s+)?(\d)', re.I)
BAGIAN = re.compile(r'Peringkat\s+(\d)\s*\((?:Satu|Dua|Tiga|Empat|Lima|Enam)\)', re.I)
JENIS = re.compile(r'(Reakreditasi\s+Naik\s+Peringkat|Reakreditasi\s+Turun\s+Peringkat|'
                   r'Reakreditasi\s+Tetap|Reakreditasi|Akreditasi\s+Baru'
                   r'|Peringkat\s+\d\s+Terindeks\s+Bereputasi\s+Internasional|Akreditasi)', re.I)

def bersih(t):
    t = re.sub(r'\s+', ' ', t)
    t = re.sub(r'-\s*\d{1,4}\s*-', ' ', t)
    t = re.sub(r'(NO|No)\s+Nama\s+Jurnal\s+E?-?ISSN\s+Penerbit(\s+Keterangan)?', ' ', t, flags=re.I)
    t = re.sub(r'Peringkat\s+No\s+Nama\s+Jurnal', ' Peringkat ', t, flags=re.I)
    return re.sub(r'\s+', ' ', t)

def rapikanNama(s):
    # Buang ekor keterangan baris SEBELUMNYA yang ikut terbawa. Greedy: potong
    # sampai kemunculan "Tahun YYYY" TERAKHIR, bukan yang pertama.
    s = re.sub(r'^.*Tahun\s+\d{4}\s*', '', s)
    s = re.sub(r'^.*?Peringkat\s+\d\s*(?:\([A-Za-z]+\))?\s*', '', s)
    s = re.sub(r'^\s*\d{1,4}[.\s]+', '', s)          # nomor baris sisa
    s = re.sub(r'\s*\(\s*$', '', s)
    return s.strip(' .;:,-')

baris = []
for urut, periode, nomor, tglSk, berkas in BERKAS:
    path = os.path.join(SUMBER, berkas)
    if not os.path.exists(path):
        print('LEWAT %s (berkas tidak ada)' % periode); continue
    d = pymupdf.open(path)
    teks = bersih(' '.join(d[i].get_text() for i in range(d.page_count)))
    kepalaDok = bersih(' '.join(d[i].get_text() for i in range(min(3, d.page_count))))
    d.close()
    md = NOMOR_DOK.search(kepalaDok)
    nomorDok = re.sub(r'\s*/\s*', '/', md.group(1)).rstrip('.') if md else ''
    if nomorDok and 'belum tercatat' in nomor:
        print('   nomor SK dipulihkan dari dokumen: %s' % nomorDok)
        nomor = nomorDok

    # peta posisi -> peringkat dari judul bagian (dipakai format 2018)
    bagian = [(m.start(), m.group(1)) for m in BAGIAN.finditer(teks)]

    pos = [(m.start(), m.end(), m.group(1)) for m in ISSN.finditer(teks)]
    n = 0
    for i, (a, b, issn) in enumerate(pos):
        ekor = teks[b: pos[i+1][0] if i+1 < len(pos) else min(len(teks), b+900)]
        if not milikUpi(ekor):
            continue
        kepala = teks[(pos[i-1][1] if i else max(0, a-400)):a]
        m = re.search(r'(?:^|\s)(\d{1,4})\s+(.{3,200})$', kepala)
        nama = rapikanNama(m.group(2) if m else kepala[-200:])

        p = PENUH.search(ekor)
        w = AWAL.search(ekor)
        j = JENIS.search(ekor)
        mb = PERINGKAT_BARU.search(ekor)
        pk = [mb.group(1)] if mb else PERINGKAT.findall(ekor)
        if not pk:
            sblm = [g for s_, g in bagian if s_ < a]
            pk = [sblm[-1]] if sblm else []

        rec = {
            'urut': urut, 'periode': periode, 'nomorSk': nomor, 'tanggalSk': tglSk,
            'berkas': berkas, 'namaJurnal': nama, 'eIssn': issn.upper(),
            'penerbitCuplikan': re.sub(r'\s+',' ',ekor[:120]).strip(),
            'jenis': (j.group(1) if j else '').title(),
            'peringkat': pk[0] if pk else '',
            'volMulai': '', 'noMulai': '', 'tahunMulai': '',
            'volAkhir': '', 'noAkhir': '', 'tahunAkhir': '',
            'asalAkhir': 'tidak ada',
        }
        if p:
            rec.update(volMulai=p.group(1), noMulai=p.group(2), tahunMulai=p.group(3),
                       volAkhir=p.group(4), noAkhir=p.group(5), tahunAkhir=p.group(6),
                       asalAkhir='tertulis di SK')
        elif w:
            th = int(w.group(3))
            rec.update(volMulai=w.group(1), noMulai=w.group(2), tahunMulai=w.group(3),
                       volAkhir='', noAkhir='', tahunAkhir=str(th + 5),
                       asalAkhir='DITURUNKAN (awal + 5 tahun)')
        baris.append(rec); n += 1
    print('%-20s %-24s %2d baris' % (periode, nomor, n))

io.open('sk-upi-mentah.json','w',encoding='utf-8').write(json.dumps(baris, ensure_ascii=False, indent=2))
print()
print('TOTAL baris          : %d' % len(baris))
for k in ['tertulis di SK', 'DITURUNKAN (awal + 5 tahun)', 'tidak ada']:
    print('  akhir %-28s %d' % (k, sum(1 for b in baris if b['asalAkhir'] == k)))
print('e-ISSN unik          : %d' % len({b['eIssn'] for b in baris}))
