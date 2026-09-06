# Mengunduh seluruh SK dari "Daftar SK Akreditasi dan Reakreditasi SINTA.md".
# Nama berkas memakai periode + nomor SK supaya asal-usulnya terbaca dari namanya.
import io, os, re, subprocess, json

TUJUAN = r'C:\Users\Asus\Documents\SK Akreditasi'
os.makedirs(TUJUAN, exist_ok=True)

# (label berkas, nomor SK, url)  -- diambil dari tabel di berkas acuan
SK = [
 ('2018-I',   '21-E-KPT-2018',  'https://ejournal.undip.ac.id/public/fileAccrDecree/2018-I-Elektronik.pdf'),
 ('2019-I',   '3-E-KPT-2019',   'https://ejournal.undip.ac.id/public/fileAccrDecree/2019-I-Elektronik.pdf'),
 ('2019-II',  '10-E-KPT-2019',  'https://ejournal.undip.ac.id/public/fileAccrDecree/2019-II-Elektronik.pdf'),
 ('2019-III', '14-E-KPT-2019',  'https://ejournal.undip.ac.id/public/fileAccrDecree/2019-III-Elektronik.pdf'),
 ('2019-VI',  '30-E-KPT-2019',  'https://ejournal.undip.ac.id/public/fileAccrDecree/2019-VI-Elektronik.pdf'),
 ('2020-I',   '85-M-KPT-2020',  'https://ejournal.undip.ac.id/public/fileAccrDecree/2020-I-Elektronik-85-M-KPT-2020.pdf'),
 ('2020-II',  '148-M-KPT-2020', 'https://okh.uin-malang.ac.id/wp-content/uploads/2022/11/SK-Hasil-Penetapan-Akreditasi-Jurnal-Ilmiah-Periode-II-Tahun-2020.pdf'),
 ('2020-III', 'tanpa-nomor',    'https://ejournal.undip.ac.id/public/fileAccrDecree/2020-III_elektronik.pdf'),
 ('2021-I',   '158-E-KPT-2021', 'https://ejournal.undip.ac.id/public/fileAccrDecree/2021-I-158-E-KPT.pdf'),
 ('2021-II',  '164-E-KPT-2021', 'https://ejournal.undip.ac.id/public/fileAccrDecree/2021-II-164-E-KTP.pdf'),
 ('2022-I',   '105-E-KPT-2022', 'https://repo.uinmybatusangkar.ac.id/xmlui/bitstream/handle/123456789/27980/1676255953037_sk.pdf?sequence=12&isAllowed=y'),
 ('2022-II',  '204-E-KPT-2022', 'https://ejournal.undip.ac.id/public/fileAccrDecree/2022-II-Elektronik.pdf'),
 ('2022-III', '225-E-KPT-2022', 'https://ipa-pasca.unpak.ac.id/pdf/sk-akreditasi-sinta-jsep.pdf'),
 ('2023-I',   '79-E-KPT-2023',  'https://ejournal.undip.ac.id/public/fileAccrDecree/2023-I-Elektronik.pdf'),
 ('2023-II',  '152-E-KPT-2023', 'https://ejournal.undip.ac.id/public/fileAccrDecree/2023-II-Elektronik.pdf'),
 ('2024-I',   '72-E-KPT-2024',  'https://ejournal.undip.ac.id/public/fileAccrDecree/2024-I-Elektronik.pdf'),
 ('2024-I-b', '72-E-KPT-2024',  'https://www.its.ac.id/drpm/wp-content/uploads/sites/71/2024/06/Pemberitahuan-Hasil-Akreditasi-Jurnal-Ilmiah-Periode-I-Tahun-2024.pdf'),
 ('2024-II',  '177-E-KPT-2024', 'https://ejournal.undip.ac.id/public/fileAccrDecree/163_%20Salinan%20177_E_KPT_2024%20(1).pdf'),
 ('2024-II-b','177-E-KPT-2024', 'https://scholarhub.ui.ac.id/ijphn/sinta5.pdf'),
 ('2025-I',   '10-C-C3-2025',   'https://ejournal.undip.ac.id/public/fileAccrDecree/2025-I-Elektronik_compressed.pdf'),
 ('2025-I-b', '10-C-C3-2025',   'https://asset.uinjkt.ac.id/uploads/azGTdycW/2025/03/sk-akreditasi-jurnal-ilmiah-periode-i-tahun-2025compressed-1.pdf'),
 ('2024-I-lampiran','72-E-KPT-2024','https://lldikti6.kemdikbud.go.id/wp-content/uploads/2024/05/Pengumuman_Pemberitahuan_Hasil_Akreditasi_Jurnal_Periode_I_Tahun_2024_dan_Lampiran_SK_No72_E_KPT_2024.pdf'),
]

hasil = []
for label, nomor, url in SK:
    nama = 'SK %s (%s).pdf' % (label, nomor)
    path = os.path.join(TUJUAN, nama)
    if os.path.exists(path) and os.path.getsize(path) > 20000:
        hasil.append((label, nomor, 'sudah ada', os.path.getsize(path), nama, url))
        continue
    cp = subprocess.run(['curl','-sS','-L','--max-time','180','-o',path,
                         '-w','%{http_code}','-A','Mozilla/5.0',url],
                        capture_output=True, text=True)
    kode = (cp.stdout or '').strip()[-3:]
    ukuran = os.path.getsize(path) if os.path.exists(path) else 0
    ok = kode == '200' and ukuran > 20000
    if not ok and os.path.exists(path):
        # buang berkas gagal supaya tidak menyamar jadi hasil unduhan
        try:
            with open(path,'rb') as f: awal = f.read(5)
        except Exception:
            awal = b''
        if awal[:4] != b'%PDF':
            os.remove(path); ukuran = 0
    hasil.append((label, nomor, kode if ok else ('GAGAL ' + kode), ukuran, nama, url))

print('%-14s %-18s %-12s %10s  %s' % ('PERIODE','NOMOR SK','STATUS','BYTE','BERKAS'))
for label, nomor, st, uk, nama, url in hasil:
    print('%-14s %-18s %-12s %10d  %s' % (label, nomor, st, uk, nama))

berhasil = [h for h in hasil if h[2] in ('200','sudah ada')]
print()
print('Berhasil/tersedia: %d dari %d' % (len(berhasil), len(hasil)))
io.open(os.path.join(TUJUAN,'_manifest-unduhan.json'),'w',encoding='utf-8').write(
    json.dumps([{'periode':h[0],'nomorSk':h[1],'status':h[2],'byte':h[3],'berkas':h[4],'url':h[5]} for h in hasil],
               ensure_ascii=False, indent=2))
print('Manifest ditulis ke _manifest-unduhan.json')
