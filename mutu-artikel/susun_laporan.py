"""
Menyusun laporan pra-asesmen Tahap 3.2 dari paket bukti JSON.

Butir deterministik (G.1, G.2, G.3, G.4, G.5, F.7, F.8) ditulis otomatis dari bukti.
Butir yang menuntut pemahaman isi (F.1-F.6, G.6) diambil dari penilaian/<nama>.json
bila ada; kalau belum ada, ditandai "belum dinilai".

Laporan tidak memuat level atau skor. Fakta terhitung tetap ditampilkan sebagai bukti.

Keluaran:
  laporan/<nama>-pra-asesmen.md        laporan lengkap per artikel
  laporan/00-ringkasan-lintas-artikel.md
  laporan/Pra_Asesmen_Artikel.tsv      untuk ditempel ke sheet (lihat README)

Jalankan: python susun_laporan.py
"""

import json
import os
from datetime import date

BASE = os.path.dirname(os.path.abspath(__file__))
BUKTI = os.path.join(BASE, "bukti")
PENILAIAN = os.path.join(BASE, "penilaian")
LAPORAN = os.path.join(BASE, "laporan")
PETA_JURNAL = os.path.join(BASE, "peta_jurnal.json")

BUTIR_JUDGMENT = ["F.1", "F.2", "F.3", "F.4", "F.5", "F.6", "G.6"]

URUTAN = ["F.1", "F.2", "F.3", "F.4", "F.5", "F.6", "F.7", "F.8", "F.9",
          "G.1", "G.2", "G.3", "G.4", "G.5", "G.6", "G.7"]

NAMA_BUTIR = {
    "F.1": "Judul artikel",
    "F.2": "Abstrak",
    "F.3": "Kata kunci",
    "F.4": "Kepioniran ilmiah, orisinalitas, kontribusi kebaruan & analisis kesenjangan",
    "F.5": "Analisis & sintesis",
    "F.6": "Penyimpulan",
    "F.7": "Nisbah sumber acuan primer",
    "F.8": "Derajat kemutakhiran pustaka acuan",
    "F.9": "Cakupan keilmuan",
    "G.1": "Kelengkapan galley / PDF artikel",
    "G.2": "Pencantuman nama & afiliasi penulis",
    "G.3": "Sistematika penulisan artikel",
    "G.4": "Pemanfaatan instrumen pendukung",
    "G.5": "Sistem pengacuan pustaka & konsistensi daftar pustaka",
    "G.6": "Gaya penulisan & kualitas kebahasaan",
    "G.7": "Mutu penyuntingan substansi, gaya selingkung, & format tata letak",
}

LABEL_UNSUR = {
    "running_head": "judul sirahan (running head)",
    "lisensi": "lisensi akses",
    "hak_cipta": "hak cipta",
    "riwayat_naskah": "riwayat naskah",
    "doi_tercantum": "DOI",
    "deklarasi_ai": "pernyataan penggunaan AI",
    "kontribusi_penulis": "kontribusi penulis",
    "pendanaan": "pernyataan pendanaan",
    "konflik_kepentingan": "konflik kepentingan",
}

BAIK = "baik"
PERBAIKAN = "perlu perbaikan"
DICEK = "perlu dicek"
LUAR = "di luar jangkauan"
BELUM = "belum dinilai"


def blok(kode, ada, catatan, saran, status=PERBAIKAN):
    """Satu butir sebagai data. Markdown dan baris sheet dirender dari sini."""
    return {
        "kode": kode,
        "nama": NAMA_BUTIR[kode],
        "status": status,
        "ada": ada,
        "catatan": catatan or "",
        "saran": saran or "",
    }


def render(d):
    t = [f"### {d['kode']} {d['nama']}", ""]
    if d["status"] not in (LUAR, BELUM):
        t.append(f"*Status: {d['status']}.*")
        t.append("")
    t.append(f"**Yang ada di artikel.** {d['ada']}")
    t.append("")
    if d["catatan"]:
        t.append(f"**Kemungkinan catatan asesor.** {d['catatan']}")
        t.append("")
    if d["saran"]:
        t.append(f"**Saran.** {d['saran']}")
        t.append("")
    if d.get("keyakinan"):
        t.append(f"*Keyakinan: {d['keyakinan']}.*")
        t.append("")
    return t


def angka(lst):
    return ", ".join(str(x) for x in lst) if lst else "-"


# --------------------------------------------------------------------------
# Butir deterministik
# --------------------------------------------------------------------------

def butir_g1(b):
    g = b["galley"]
    ada_list = [LABEL_UNSUR[k] for k in LABEL_UNSUR if g[k]["ada"]]
    hilang = [LABEL_UNSUR[k] for k in g["hilang"]]
    rh = g["running_head"]

    ada = (f"{g['terpenuhi']} dari {g['dari']} unsur terdeteksi: {', '.join(ada_list)}. "
           f"Riwayat naskah memuat {g['riwayat_naskah']['jumlah_tanggal']} tanggal "
           f"({', '.join(f'{k} {v}' for k, v in g['riwayat_naskah']['tanggal'].items())}). ")
    if rh["ada"]:
        ada += f"Judul sirahan muncul di {rh['halaman_terdeteksi']} halaman, contoh: \"{rh['contoh']}\"."

    catatan = (f"Unsur yang tidak terdeteksi: {', '.join(hilang)}. Rubrik menargetkan 8-9 dari 9 unsur."
               if hilang else "Seluruh unsur terdeteksi.")
    saran = ("Tambahkan blok Declaration di akhir artikel yang memuat "
             + ", ".join(hilang) + ". Blok ini bisa dijadikan bagian tetap template galley jurnal."
             ) if hilang else "Pertahankan kelengkapan ini di terbitan berikutnya."
    return blok("G.1", ada, catatan, saran, PERBAIKAN if hilang else BAIK)


def butir_g2(b):
    p = b["penulis"]
    penulis = p["penulis"]
    satu_kata = [x["nama"] for x in penulis if x["jumlah_kata"] < 2]
    disingkat = [x["nama"] for x in penulis if x["nama_belakang_disingkat"]]
    bergelar = [x["nama"] for x in penulis if x["ada_gelar"]]

    ada = (f"{len(penulis)} nama penulis terbaca: {', '.join(x['nama'] for x in penulis)}. "
           f"Afiliasi {'tercantum' if p['afiliasi_ada_institusi'] else 'tidak terdeteksi'}"
           f"{' dan memuat nama negara' if p['afiliasi_ada_negara'] else ''}. "
           f"E-mail korespondensi {'ada: ' + ', '.join(p['email_korespondensi']) if p['ada_email_korespondensi'] else 'tidak terdeteksi'}.")

    masalah = []
    if satu_kata:
        masalah.append(f"nama satu kata: {', '.join(satu_kata)}")
    if disingkat:
        masalah.append(f"nama belakang disingkat satu huruf: {', '.join(disingkat)}")
    if bergelar:
        masalah.append(f"mencantumkan gelar: {', '.join(bergelar)}")
    if not p["ada_email_korespondensi"]:
        masalah.append("e-mail corresponding author tidak ditemukan")
    if not p["afiliasi_ada_negara"]:
        masalah.append("afiliasi tidak memuat nama negara")

    catatan = ("; ".join(masalah).capitalize() + "." if masalah else
               "Tidak ada masalah format yang terdeteksi pada nama dan afiliasi.")
    saran = ("Rubrik meminta metadata nama minimal dua kata, tanpa gelar, dan afiliasi utuh "
             "berisi institusi, kota, dan negara. Perbaiki juga metadata di OJS, bukan hanya di PDF."
             if masalah else
             "Pertahankan. Pastikan metadata yang sama juga terisi di OJS, karena asesor memeriksa keduanya.")
    tambahan = ("\n\n> Kota pada afiliasi tidak diperiksa otomatis. Periksa manual apakah "
                "tiap afiliasi menuliskan institusi, kota, dan negara.")
    return blok("G.2", ada, catatan, saran + tambahan, PERBAIKAN if masalah else BAIK)


def butir_g3(b):
    s = b["struktur"]
    ada = ("Heading yang terdeteksi: " + ", ".join(h["label"] for h in s["heading"]) + ".")
    if s["imrad_lengkap"]:
        catatan = "Struktur IMRaD lengkap: pendahuluan, metode, hasil, simpulan, dan daftar pustaka semuanya ada."
        saran = "Pertahankan. Jaga konsistensi urutan dan penomoran heading di seluruh artikel dalam satu terbitan."
        status = BAIK
    else:
        catatan = ("Bagian kanonik yang tidak terdeteksi: " + ", ".join(s["kanonik_hilang"]) +
                   ". Untuk artikel empiris, rubrik mengharapkan pendahuluan, metode, "
                   "hasil-pembahasan, dan simpulan.")
        saran = ("Periksa apakah bagian tersebut memang tidak ada, atau ada tetapi memakai judul "
                 "yang tidak baku sehingga tidak terbaca sebagai heading.")
        status = DICEK
    return blok("G.3", ada, catatan, saran, status)


def butir_g4(b):
    i = b["instrumen"]
    t, g = i["tabel"], i["gambar"]
    ada = (f"{t['jumlah_caption']} caption tabel (nomor {angka(t['caption'])}) dan "
           f"{g['jumlah_caption']} caption gambar (nomor {angka(g['caption'])}). "
           f"Nomor yang diacu di badan teks: tabel {angka(t['nomor_diacu_di_teks'])}, "
           f"gambar {angka(g['nomor_diacu_di_teks'])}.")

    yatim = t["caption_tanpa_acuan"] + g["caption_tanpa_acuan"]
    if yatim:
        catatan = (f"Instrumen bercaption tetapi tidak diacu di teks: "
                   f"tabel {angka(t['caption_tanpa_acuan'])}, gambar {angka(g['caption_tanpa_acuan'])}. "
                   "Rubrik meminta setiap instrumen diacu.")
        saran = "Tambahkan kalimat pengacu di badan teks untuk tiap tabel dan gambar tersebut."
        status = PERBAIKAN
    elif t["jumlah_caption"] + g["jumlah_caption"] == 0:
        catatan = "Tidak ada tabel atau gambar terdeteksi."
        saran = ("Kalau artikel memang tanpa instrumen pendukung, butir ini dinilai dari relevansi. "
                 "Kalau sebenarnya ada, periksa apakah caption ditulis sebagai teks atau tertanam di gambar.")
        status = DICEK
    else:
        catatan = "Setiap tabel dan gambar bercaption juga diacu di badan teks."
        saran = "Pertahankan. Pastikan penomoran berurutan sesuai kemunculan di teks."
        status = BAIK
    return blok("G.4", ada, catatan, saran, status)


def butir_g5(b):
    s = b["sitasi"]
    r = b["rujukan"]
    if s["gaya"] == "bernomor":
        ada = (f"Gaya sitasi bernomor. {s['jumlah_penanda_sitasi']} penanda sitasi di badan teks "
               f"mengacu ke {s['nomor_unik_dikutip']} nomor unik, sedangkan daftar pustaka memuat "
               f"{s['entri_daftar_pustaka']} entri.")
        masalah = []
        if s["nomor_di_luar_rentang"]:
            masalah.append(f"nomor yang dikutip melebihi jumlah entri: {angka(s['nomor_di_luar_rentang'])}")
        if s["entri_tidak_pernah_dikutip"]:
            masalah.append(f"entri tidak pernah dikutip di teks: {angka(s['entri_tidak_pernah_dikutip'])}")
        catatan = ("; ".join(masalah).capitalize() + "." if masalah
                   else "Semua entri daftar pustaka dikutip dan tidak ada nomor di luar rentang.")
        saran = ("Rapikan agar tiap entri dikutip dan tiap kutipan menunjuk entri yang ada. "
                 "Pakai aplikasi manajer referensi supaya penomoran ikut berubah saat entri disisipkan."
                 if masalah else
                 "Pertahankan. Pakai manajer referensi agar penomoran tetap konsisten saat naskah direvisi.")
        status = PERBAIKAN if masalah else BAIK
    else:
        ada = (f"Gaya sitasi nama-tahun. {s['kunci_dalam_teks_unik']} kunci sitasi unik di badan teks, "
               f"daftar pustaka memuat {s['entri_daftar_pustaka']} entri, {s['cocok']} kunci cocok.")
        masalah = []
        if s["jumlah_yatim_teks"]:
            masalah.append(f"{s['jumlah_yatim_teks']} kunci dikutip di teks tetapi tidak ditemukan padanannya "
                           f"di daftar pustaka: {', '.join(s['yatim_teks'][:8])}")
        if s["jumlah_yatim_daftar"]:
            masalah.append(f"{s['jumlah_yatim_daftar']} entri daftar pustaka tidak ditemukan dikutip di teks: "
                           f"{', '.join(s['yatim_daftar'][:8])}")
        catatan = ("; ".join(masalah).capitalize() + "." if masalah
                   else "Sitasi dalam teks dan daftar pustaka saling cocok.")
        saran = ("Cocokkan satu per satu kunci di atas. Sebagian ketidakcocokan biasanya berupa urutan "
                 "penulis yang terbalik, ejaan nama berbeda, atau tahun yang tidak sama antara teks dan daftar."
                 if masalah else
                 "Pertahankan. Sitasi body dan daftar pustaka yang tidak cocok termasuk temuan berat pada rubrik.")
        status = DICEK if masalah else BAIK

    catatan += f" Dari {r['jumlah']} entri, {r['ber_doi']} mencantumkan DOI."
    return blok("G.5", ada, catatan, saran + "\n\n> " + s["catatan"], status)


def butir_f7(b):
    r = b["rujukan"]
    ada = (f"{r['jumlah']} entri daftar pustaka, {r['ber_doi']} di antaranya mencantumkan DOI. "
           f"Rentang tahun terbit {r['tahun_min']}-{r['tahun_maks']}.")
    if r["acuan_minimal_15"]:
        catatan = "Jumlah rujukan memenuhi ambang minimal 15 per artikel."
        status = DICEK
    else:
        catatan = (f"Jumlah rujukan {r['jumlah']}, di bawah ambang minimal 15 per artikel yang "
                   "disebut rubrik. Rujukan di bawah 15 dinilai rendah.")
        status = PERBAIKAN
    saran = ("Proporsi acuan primer (jurnal, prosiding, tesis, disertasi, manuskrip, monograf riset) "
             "belum dihitung otomatis karena jenis sumber tidak selalu terbaca dari teks. "
             "Periksa manual dan targetkan lebih dari 80% acuan primer.")
    return blok("F.7", ada, catatan, saran, status)


def butir_f8(b):
    r = b["rujukan"]
    p = r["persen_mutakhir"]
    ada = (f"{r['mutakhir_10_tahun']} dari {r['punya_tahun']} rujukan bertahun terbit dalam "
           f"10 tahun terakhir ({p}%). Rujukan tertua {r['tahun_min']}, terbaru {r['tahun_maks']}.")
    if p is None:
        catatan = "Tahun terbit tidak terbaca dari daftar pustaka."
        saran = "Periksa format daftar pustaka; tahun terbit harus konsisten dan mudah dikenali."
        status = DICEK
    elif p >= 80:
        catatan = "Proporsi rujukan mutakhir sudah tinggi."
        saran = "Pertahankan. Pustaka klasik boleh dipakai untuk sumber masalah atau keterkaitan teori."
        status = BAIK
    elif p >= 40:
        catatan = f"Proporsi rujukan mutakhir {p}%, di bawah harapan rubrik yang mengarah ke lebih dari 80%."
        saran = ("Perbarui rujukan pada bagian yang membandingkan hasil dan menjustifikasi kebaruan. "
                 "Pustaka klasik sebaiknya hanya untuk sumber masalah atau landasan teori.")
        status = PERBAIKAN
    else:
        catatan = (f"Hanya {p}% rujukan terbit dalam 10 tahun terakhir. Rubrik menempatkan proporsi "
                   "di bawah 40% pada tingkat terendah.")
        saran = ("Tambahkan rujukan mutakhir, terutama untuk pembandingan hasil dan justifikasi kebaruan. "
                 "Kalau bidangnya memang bertumpu pada karya klasik, jelaskan alasannya di naskah.")
        status = PERBAIKAN
    return blok("F.8", ada, catatan, saran, status)


def butir_f9():
    return blok(
        "F.9",
        "Tidak dinilai dari satu artikel.",
        "Butir ini dihitung dari persentase artikel dalam satu terbitan yang sesuai fokus dan skop "
        "jurnal, jadi berlaku pada tingkat jurnal.",
        "Nilai butir ini dengan meninjau seluruh artikel dalam tiga tahun terakhir, bukan artikel tunggal.",
        LUAR,
    )


def butir_g7():
    return blok(
        "G.7",
        "Tidak diperiksa oleh ekstraktor.",
        "Butir ini menuntut inspeksi visual PDF: tabel terpotong, gambar melar atau blur, "
        "konsistensi tipografi. Ekstraktor hanya membaca lapisan teks.",
        "Buka PDF dan periksa manual: tabel tidak terpotong antar halaman, gambar tajam dan tidak "
        "melar, serta font, ukuran, spasi baris, dan alignment konsisten antar artikel dalam satu terbitan.",
        LUAR,
    )


def butir_belum(kode):
    return blok(kode, "Belum dinilai pada laporan ini.", "",
                "Butir ini menuntut pembacaan isi artikel dan diisi pada tahap penilaian berikutnya.",
                BELUM)


def kumpulkan(bukti, nilai):
    """Seluruh 16 butir sebagai daftar dict, urut sesuai URUTAN."""
    hasil = []
    for kode in URUTAN:
        if kode in BUTIR_JUDGMENT:
            if kode in nilai:
                v = nilai[kode]
                # Konvensi: saran yang diawali "Pertahankan" menandai butir tanpa masalah.
                status = BAIK if v.get("saran", "").startswith("Pertahankan") else PERBAIKAN
                d = blok(kode, v["ada"], v.get("catatan", ""), v.get("saran", ""), status)
                d["keyakinan"] = v.get("keyakinan", "")
                hasil.append(d)
            else:
                hasil.append(butir_belum(kode))
        elif kode == "F.7":
            hasil.append(butir_f7(bukti))
        elif kode == "F.8":
            hasil.append(butir_f8(bukti))
        elif kode == "F.9":
            hasil.append(butir_f9())
        elif kode == "G.1":
            hasil.append(butir_g1(bukti))
        elif kode == "G.2":
            hasil.append(butir_g2(bukti))
        elif kode == "G.3":
            hasil.append(butir_g3(bukti))
        elif kode == "G.4":
            hasil.append(butir_g4(bukti))
        elif kode == "G.5":
            hasil.append(butir_g5(bukti))
        elif kode == "G.7":
            hasil.append(butir_g7())
    return hasil


# --------------------------------------------------------------------------
# Laporan markdown
# --------------------------------------------------------------------------

def susun(nama, bukti, butir):
    ident = bukti["identitas"]
    r, g, s = bukti["rujukan"], bukti["galley"], bukti["sitasi"]
    perlu = [d for d in butir if d["status"] == PERBAIKAN]

    t = []
    t.append(f"# Pra-asesmen Tahap 3.2 — {nama}")
    t.append("")
    t.append(f"Berkas `{bukti['berkas']}` · {bukti['halaman']} halaman · "
             f"DOI {ident['doi'] or '(tidak terdeteksi)'} · "
             f"e-ISSN {ident['eissn'] or '-'} · p-ISSN {ident['pissn'] or '-'}")
    t.append("")
    t.append(f"Disusun {date.today().isoformat()} dari ekstraksi otomatis lapisan teks PDF, "
             "mengacu rubrik Tahap 3.2 pada Kepdirjen 374/2026.")
    t.append("")
    t.append("> Laporan ini berisi temuan dan saran, bukan penilaian. Tidak ada level atau skor "
             "di dalamnya. Penilaian resmi dilakukan asesor ARJUNA.")
    t.append("")
    t.append(f"**{len(perlu)} dari 16 butir perlu perbaikan:** "
             + ", ".join(d["kode"] for d in perlu) + ".")
    t.append("")

    t.append("## Fakta terhitung")
    t.append("")
    t.append("| Fakta | Nilai |")
    t.append("|---|---|")
    t.append(f"| Unsur galley terdeteksi | {g['terpenuhi']} dari {g['dari']} |")
    t.append(f"| Entri daftar pustaka | {r['jumlah']} |")
    t.append(f"| Rujukan terbit ≤10 tahun | {r['mutakhir_10_tahun']} dari {r['punya_tahun']} ({r['persen_mutakhir']}%) |")
    t.append(f"| Entri ber-DOI | {r['ber_doi']} |")
    t.append(f"| Gaya sitasi | {s['gaya']} |")
    t.append(f"| Caption tabel / gambar | {bukti['instrumen']['tabel']['jumlah_caption']} / {bukti['instrumen']['gambar']['jumlah_caption']} |")
    t.append(f"| Panjang abstrak | {bukti['abstrak'].get('jumlah_kata', '-')} kata |")
    t.append(f"| Kata kunci | {len(bukti['kata_kunci']['daftar'])} |")
    t.append(f"| Struktur IMRaD lengkap | {'ya' if bukti['struktur']['imrad_lengkap'] else 'tidak'} |")
    t.append("")

    t.append("## Temuan per butir")
    t.append("")
    for d in butir:
        t += render(d)

    t.append("## Perlu tinjau manual")
    t.append("")
    t.append("- **F.9 cakupan keilmuan** — tingkat jurnal, tinjau seluruh terbitan tiga tahun terakhir.")
    t.append("- **G.7 tata letak** — buka PDF, periksa tabel terpotong, gambar blur, dan konsistensi tipografi.")
    t.append("- **F.7 proporsi acuan primer** — klasifikasi jenis sumber belum otomatis.")
    t.append("- **G.2 kota pada afiliasi** — belum diperiksa otomatis.")
    if s["gaya"] == "nama-tahun" and s["jumlah_yatim_teks"] + s["jumlah_yatim_daftar"]:
        t.append("- **G.5 ketidakcocokan sitasi** — sebagian bisa jadi ejaan nama atau nama majemuk, bukan kesalahan nyata.")
    t.append("")
    return "\n".join(t)


def ringkasan(semua):
    t = []
    t.append("# Ringkasan lintas artikel — pra-asesmen Tahap 3.2")
    t.append("")
    t.append(f"{len(semua)} artikel terbit dari enam jurnal UPI, diekstraksi {date.today().isoformat()}. "
             "Angka di bawah adalah hasil pembacaan otomatis lapisan teks PDF, bukan penilaian.")
    t.append("")

    t.append("## Bandingan")
    t.append("")
    t.append("| Artikel | Perlu perbaikan | Galley | Rujukan | Mutakhir ≤10 th | Ber-DOI | Gaya sitasi | Abstrak |")
    t.append("|---|---|---|---|---|---|---|---|")
    for nama, b, butir in semua:
        r, g, s = b["rujukan"], b["galley"], b["sitasi"]
        perlu = sum(1 for d in butir if d["status"] == PERBAIKAN)
        t.append(f"| {nama} | {perlu}/16 | {g['terpenuhi']}/9 | {r['jumlah']} | {r['persen_mutakhir']}% "
                 f"| {r['ber_doi']} | {s['gaya']} "
                 f"| {b['abstrak'].get('jumlah_kata','-')} kata |")
    t.append("")

    hitung = {}
    for nama, b, _ in semua:
        for u in b["galley"]["hilang"]:
            hitung.setdefault(u, []).append(nama)
    t.append("## Unsur galley yang hilang (G.1)")
    t.append("")
    t.append("| Unsur | Artikel yang tidak memuatnya |")
    t.append("|---|---|")
    for u, daftar in sorted(hitung.items(), key=lambda x: -len(x[1])):
        t.append(f"| {LABEL_UNSUR[u]} | {len(daftar)}/{len(semua)} — {', '.join(daftar)} |")
    t.append("")

    t.append("## Pola yang berulang")
    t.append("")
    universal = [LABEL_UNSUR[u] for u, d in hitung.items() if len(d) == len(semua)]
    if universal:
        t.append(f"- Tidak ada satu pun dari {len(semua)} artikel yang memuat **{', '.join(universal)}**. "
                 "Penyebabnya ada di template galley jurnal, yang belum menyediakan blok Declaration. "
                 "Satu perbaikan template menaikkan G.1 untuk seluruh artikel jurnal itu sekaligus.")
    kurang15 = [n for n, b, _ in semua if not b["rujukan"]["acuan_minimal_15"]]
    t.append(f"- Jumlah rujukan: {'semua artikel memenuhi ambang minimal 15' if not kurang15 else 'di bawah 15 pada ' + ', '.join(kurang15)}.")
    lawas = [(n, b["rujukan"]["persen_mutakhir"]) for n, b, _ in semua
             if b["rujukan"]["persen_mutakhir"] is not None and b["rujukan"]["persen_mutakhir"] < 80]
    if lawas:
        t.append("- Kemutakhiran pustaka di bawah 80%: " +
                 ", ".join(f"{n} ({p}%)" for n, p in lawas) + ".")
    gaya = {}
    for n, b, _ in semua:
        gaya.setdefault(b["sitasi"]["gaya"], []).append(n)
    t.append("- Gaya sitasi terbagi: " +
             "; ".join(f"{k} pada {', '.join(v)}" for k, v in gaya.items()) +
             ". Algoritma harus mengenali keduanya, karena pencocokan nama-tahun tidak berlaku "
             "pada daftar bernomor.")
    t.append("")

    t.append("## Batas alat ini")
    t.append("")
    t.append("- **F.9 cakupan keilmuan** dinilai pada tingkat jurnal, tidak bisa dihitung dari artikel tunggal.")
    t.append("- **G.7 tata letak** menuntut inspeksi visual PDF. Ekstraktor hanya membaca lapisan teks.")
    t.append("- **F.7 proporsi acuan primer** baru menghitung jumlah rujukan. Klasifikasi jenis sumber "
             "(jurnal, prosiding, buku, web) belum otomatis.")
    t.append("- **G.2 kota pada afiliasi** belum diperiksa.")
    t.append("- Pencocokan sitasi nama-tahun memakai surname penulis pertama dan tahun, sehingga nama "
             "majemuk atau urutan penulis yang terbalik bisa muncul sebagai ketidakcocokan palsu. "
             "Tiap temuan G.5 perlu dilihat satu per satu sebelum disampaikan ke penulis.")
    t.append("- Butir F.1 sampai F.6 dan G.6 dinilai dengan membaca isi artikel, bukan oleh ekstraktor.")
    t.append("")
    return "\n".join(t)


# --------------------------------------------------------------------------
# Baris untuk sheet Pra_Asesmen_Artikel
# --------------------------------------------------------------------------

HEADER_TSV = ["Nama Jurnal", "Judul Artikel", "DOI", "Tanggal Asesmen",
              "Butir", "Nama Butir", "Status", "Temuan", "Saran"]


def bersih_sel(s):
    """Sel sheet tidak boleh memuat tab atau baris baru."""
    s = str(s or "").replace("\t", " ").replace("\r", " ").replace("\n", " ")
    # Buang catatan kaki markdown yang hanya relevan di laporan
    s = s.split("> ")[0].strip()
    return " ".join(s.split())[:1500]


def baris_sheet(nama_jurnal, b, butir):
    jud = b["identitas"].get("judul") or "(judul tidak terbaca)"
    doi = b["identitas"].get("doi", "")
    tgl = date.today().isoformat()
    rows = []
    for d in butir:
        if d["status"] in (BELUM,):
            continue
        rows.append([nama_jurnal, jud, doi, tgl, d["kode"], d["nama"],
                     d["status"], bersih_sel(d["catatan"]), bersih_sel(d["saran"])])
    return rows


def main():
    os.makedirs(LAPORAN, exist_ok=True)

    peta = {}
    if os.path.exists(PETA_JURNAL):
        peta = json.load(open(PETA_JURNAL, encoding="utf-8"))

    semua, rows = [], []
    for f in sorted(os.listdir(BUKTI)):
        if not f.endswith(".json"):
            continue
        kode = os.path.splitext(f)[0].replace("artikel_", "")
        nama = kode.replace("_", " ")
        bukti = json.load(open(os.path.join(BUKTI, f), encoding="utf-8"))

        nilai = {}
        pnil = os.path.join(PENILAIAN, f)
        if os.path.exists(pnil):
            nilai = json.load(open(pnil, encoding="utf-8"))

        butir = kumpulkan(bukti, nilai)
        semua.append((nama, bukti, butir))

        isi = susun(nama, bukti, butir)
        tujuan = os.path.join(LAPORAN, f"{nama.replace(' ', '-')}-pra-asesmen.md")
        with open(tujuan, "w", encoding="utf-8") as fh:
            fh.write(isi)

        nama_jurnal = peta.get(kode, "")
        if not nama_jurnal:
            print(f"  ! {kode}: nama jurnal belum ada di peta_jurnal.json, baris sheet dilewati")
        else:
            rows += baris_sheet(nama_jurnal, bukti, butir)

        perlu = sum(1 for d in butir if d["status"] == PERBAIKAN)
        print(f"tulis {os.path.basename(tujuan)} ({perlu}/16 perlu perbaikan, "
              f"{len(nilai)}/{len(BUTIR_JUDGMENT)} butir penilaian terisi)")

    isi = ringkasan(semua)
    with open(os.path.join(LAPORAN, "00-ringkasan-lintas-artikel.md"), "w", encoding="utf-8") as fh:
        fh.write(isi)
    print(f"tulis 00-ringkasan-lintas-artikel.md")

    tsv = os.path.join(LAPORAN, "Pra_Asesmen_Artikel.tsv")
    with open(tsv, "w", encoding="utf-8", newline="") as fh:
        fh.write("\t".join(HEADER_TSV) + "\n")
        for r in rows:
            fh.write("\t".join(r) + "\n")
    print(f"tulis Pra_Asesmen_Artikel.tsv ({len(rows)} baris temuan, siap ditempel ke sheet)")


if __name__ == "__main__":
    main()
