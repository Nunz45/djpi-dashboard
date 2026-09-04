"""
Ekstraktor bukti Tahap 3.2 (Mutu Artikel) dari PDF artikel terbit.
Deterministik, tanpa AI. Satu PDF -> satu paket bukti JSON.

Menyuplai butir: G.1 (kelengkapan galley), G.2 (nama & afiliasi), G.3 (sistematika),
G.4 (instrumen pendukung), G.5 (pengacuan pustaka), F.7 (nisbah acuan primer),
F.8 (kemutakhiran pustaka), serta teks per section untuk butir yang dinilai manusia.

Jalankan: python ekstrak_artikel.py
"""

import json
import os
import re
import sys
from datetime import date

import pymupdf

BASE = os.path.dirname(os.path.abspath(__file__))
# PDF sumber ada di luar folder ini dan tidak masuk git (artikel berhak cipta).
SUMBER = os.environ.get("DJPI_PDF_DIR") or os.path.join(os.path.dirname(BASE), "PDF_Terbit")
KELUARAN = os.path.join(BASE, "bukti")
PETA_JURNAL = os.path.join(BASE, "peta_jurnal.json")

TAHUN_INI = date.today().year

# --------------------------------------------------------------------------
# Utilitas teks
# --------------------------------------------------------------------------

def rapatkan_huruf_spasi(baris):
    """'A B S T R A C T' -> 'ABSTRACT'. Template IJoST memberi spasi antar huruf."""
    return re.sub(
        r"\b(?:[A-Z]\s+){2,}[A-Z]\b",
        lambda m: re.sub(r"\s+", "", m.group()),
        baris,
    )


def normalkan(teks):
    """Rapatkan spasi/newline jadi satu spasi. Untuk blob referensi & pencarian frasa."""
    return re.sub(r"\s+", " ", teks).strip()


# --------------------------------------------------------------------------
# Struktur (G.3)
# --------------------------------------------------------------------------

NAMA_HEADING = (
    r"ABSTRACT|ABSTRAK|"
    r"INTRODUCTION|PENDAHULUAN|"
    r"LITERATURE\s+REVIEW|TINJAUAN\s+PUSTAKA|THEORETICAL\s+FRAMEWORK|"
    r"MATERIALS?\s+AND\s+METHODS?|RESEARCH\s+METHODS?|METHODOLOGY|METHODS?|"
    r"METODE\s+PENELITIAN|METODE|METODOLOGI|"
    r"(?:RESULTS?|FINDINGS?)\s+AND\s+DISCUSSIONS?|RESULTS?|FINDINGS?|"
    r"HASIL\s+(?:PENELITIAN\s+)?DAN\s+PEMBAHASAN|TEMUAN\s+DAN\s+PEMBAHASAN|HASIL|TEMUAN|"
    r"DISCUSSIONS?|PEMBAHASAN|"
    r"CONCLUSIONS?(?:\s+AND\s+(?:SUGGESTIONS?|RECOMMENDATIONS?))?|"
    r"SIMPULAN(?:\s+DAN\s+SARAN)?|KESIMPULAN(?:\s+DAN\s+SARAN)?|"
    r"ACKNOWLEDGE?MENTS?|UCAPAN\s+TERIMA\s+KASIH|"
    r"AUTHORS?.{0,2}\s+NOTE|CATATAN\s+PENULIS|DECLARATIONS?|"
    r"REFERENCES?|DAFTAR\s+PUSTAKA|BIBLIOGRAPHY"
)
POLA_HEADING = re.compile(
    r"^\s*(?:(\d+)\s*\.?\s*)?(" + NAMA_HEADING + r")\s*:?\s*$", re.IGNORECASE
)

# Urutan kanonik untuk menilai kelengkapan IMRaD
KANONIK = {
    "ABSTRACT": "abstrak", "ABSTRAK": "abstrak",
    "INTRODUCTION": "pendahuluan", "PENDAHULUAN": "pendahuluan",
    "LITERATURE REVIEW": "tinjauan", "TINJAUAN PUSTAKA": "tinjauan",
    "THEORETICAL FRAMEWORK": "tinjauan",
    "METHOD": "metode", "METHODS": "metode", "METODE": "metode",
    "RESEARCH METHOD": "metode", "RESEARCH METHODS": "metode",
    "METODE PENELITIAN": "metode", "METHODOLOGY": "metode", "METODOLOGI": "metode",
    "MATERIALS AND METHOD": "metode", "MATERIALS AND METHODS": "metode",
    "RESULT": "hasil", "RESULTS": "hasil", "HASIL": "hasil",
    "FINDING": "hasil", "FINDINGS": "hasil", "TEMUAN": "hasil",
    "RESULTS AND DISCUSSION": "hasil", "RESULTS AND DISCUSSIONS": "hasil",
    "RESULT AND DISCUSSION": "hasil",
    "FINDINGS AND DISCUSSION": "hasil", "FINDINGS AND DISCUSSIONS": "hasil",
    "FINDING AND DISCUSSION": "hasil",
    "HASIL DAN PEMBAHASAN": "hasil", "HASIL PENELITIAN DAN PEMBAHASAN": "hasil",
    "TEMUAN DAN PEMBAHASAN": "hasil",
    "DISCUSSION": "pembahasan", "DISCUSSIONS": "pembahasan", "PEMBAHASAN": "pembahasan",
    "CONCLUSION": "simpulan", "CONCLUSIONS": "simpulan",
    "CONCLUSION AND SUGGESTION": "simpulan", "CONCLUSIONS AND SUGGESTIONS": "simpulan",
    "CONCLUSION AND RECOMMENDATION": "simpulan", "CONCLUSIONS AND RECOMMENDATIONS": "simpulan",
    "SIMPULAN": "simpulan", "KESIMPULAN": "simpulan",
    "SIMPULAN DAN SARAN": "simpulan", "KESIMPULAN DAN SARAN": "simpulan",
    "ACKNOWLEDGMENT": "ucapan", "ACKNOWLEDGMENTS": "ucapan",
    "ACKNOWLEDGEMENT": "ucapan", "ACKNOWLEDGEMENTS": "ucapan",
    "UCAPAN TERIMA KASIH": "ucapan",
    "AUTHOR'S NOTE": "catatan", "AUTHORS' NOTE": "catatan",
    "AUTHORS NOTE": "catatan", "AUTHOR NOTE": "catatan",
    "CATATAN PENULIS": "catatan", "DECLARATION": "catatan", "DECLARATIONS": "catatan",
    "REFERENCE": "referensi", "REFERENCES": "referensi",
    "DAFTAR PUSTAKA": "referensi", "BIBLIOGRAPHY": "referensi",
}


def petakan_section(baris_list):
    """Kembalikan (daftar_heading, dict heading->teks)."""
    tanda = []
    for i, baris in enumerate(baris_list):
        bersih = rapatkan_huruf_spasi(baris.strip())
        m = POLA_HEADING.match(bersih)
        if m:
            nomor, nama = m.group(1), normalkan(m.group(2)).upper()
            tanda.append((i, nomor, nama))

    heading, section = [], {}
    for k, (i, nomor, nama) in enumerate(tanda):
        akhir = tanda[k + 1][0] if k + 1 < len(tanda) else len(baris_list)
        label = (f"{nomor}. " if nomor else "") + nama
        heading.append({
            "label": label,
            "nama": nama,
            "nomor": int(nomor) if nomor else None,
            "kanonik": KANONIK.get(nama),
            "baris": i,
        })
        section[label] = "\n".join(baris_list[i + 1:akhir]).strip()
    return heading, section


# --------------------------------------------------------------------------
# Identitas & galley (G.1, G.2)
# --------------------------------------------------------------------------

POLA_DOI = re.compile(r"10\.\d{4,9}/[^\s\"'|,;)\]]+")
POLA_EISSN = re.compile(r"e[-\s]*ISSN[:\s]*([0-9]{4}-?[0-9]{3}[0-9Xx])", re.IGNORECASE)
POLA_PISSN = re.compile(r"p[-\s]*ISSN[:\s]*([0-9]{4}-?[0-9]{3}[0-9Xx])", re.IGNORECASE)
POLA_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

# Tanggal riwayat naskah ditulis bermacam bentuk antar template:
# "26 January 2026", "Dec 8, 2025", "November 2025" (tanpa tanggal), "2026-01-26".
TGL = (r"([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4}"
       r"|[A-Za-z]+\s+[0-9]{1,2},?\s+[0-9]{4}"
       r"|[0-9]{4}-[0-9]{2}-[0-9]{2}"
       r"|[A-Za-z]+\s+[0-9]{4})")

RIWAYAT = [
    ("submitted", r"(?:Submitted|Received|Diterima)(?:/Received)?\s*:?\s*" + TGL),
    ("revised", r"(?:First\s+)?Revised\s*:?\s*" + TGL),
    ("accepted", r"Accepted\s*:?\s*" + TGL),
    ("available", r"(?:First\s+)?Available\s+online\s*:?\s*" + TGL),
    ("publikasi", r"(?:Publication\s+Date|Publish(?:ed)?\s+online)\s*:?\s*" + TGL),
]

# Deklarasi hanya dicari di ZONA DEKLARASI (bagian akhir artikel), bukan di seluruh teks.
# Tanpa pembatasan itu frasa biasa ikut tertangkap: "artificial intelligence" di tinjauan
# pustaka terbaca sebagai pernyataan penggunaan AI, dan kata "credit" terbaca sebagai CRediT.
KATA_DEKLARASI = r"(?:declar\w*|disclos\w*|statement|acknowledg\w*|note|policy|menyatakan|pernyataan)"

DEKLARASI = [
    # Sebutan AI harus berdampingan dengan kata yang menandai pernyataan.
    ("deklarasi_ai",
     r"(?:artificial\s+intelligence|generative\s+AI|ChatGPT|large\s+language\s+model|"
     r"kecerdasan\s+(?:artifisial|buatan))\W{0,40}" + KATA_DEKLARASI +
     r"|" + KATA_DEKLARASI + r"\W{0,60}(?:artificial\s+intelligence|generative\s+AI|ChatGPT|"
     r"large\s+language\s+model|kecerdasan\s+(?:artifisial|buatan))"
     r"|\bAI\s+(?:statement|declaration|disclosure|usage|tools?\s+(?:were|was|used))"),
    ("kontribusi_penulis",
     r"author(?:s'?)?\s+contribution|contributorship|kontribusi\s+penulis"),
    ("pendanaan",
     r"funding\s+(?:statement|information|source)|"
     r"this\s+(?:research|study|work|paper)\s+(?:was|received)\s+"
     r"(?:\w+\s+){0,2}(?:funded|supported|financed|funding|no\s+funding)|"
     r"(?:no|without)\s+(?:\w+\s+){0,2}funding|funding\s+agenc\w*|"
     r"no\s+specific\s+grant|grant\s+(?:\[|no\.|number)|"
     r"pendanaan|sumber\s+dana|didanai\s+oleh|dibiayai\s+oleh"),
    # "conf\w*" mentoleransi salah ketik yang memang ditemukan di lapangan ("confilct").
    ("konflik_kepentingan",
     r"\bconf\w*\s+of\s+interest|competing\s+interest|konflik\s+kepentingan"),
]
# CRediT diperiksa terpisah karena harus peka huruf besar (kata "credit" biasa bukan CRediT).
POLA_CREDIT = re.compile(r"\bCRediT\b")


NOISE_JUDUL = re.compile(
    r"issn|doi|http|copyright|©|available online|journal homepage|^vol\b|^volume|"
    r"abstract|abstrak|article\s*info|licens|e-?mail|^[0-9\s|.,-]+$",
    re.IGNORECASE,
)


def judul_artikel(dok, nama_jurnal=""):
    """Judul artikel biasanya teks terbesar di halaman 1. Sebagian template menaruh
    nama jurnal dengan font lebih besar lagi, jadi tier yang isinya nama jurnal
    dilewati dan diambil tier berikutnya."""
    pg = dok[0]
    tinggi = pg.rect.height
    spans = []
    for blk in pg.get_text("dict")["blocks"]:
        for ln in blk.get("lines", []):
            for sp in ln["spans"]:
                t = normalkan(sp["text"])
                if len(t) < 3 or NOISE_JUDUL.search(t):
                    continue
                # Lewati zona banner paling atas
                if sp["bbox"][1] <= tinggi * 0.08:
                    continue
                spans.append((round(sp["size"], 1), sp["bbox"][1], sp["bbox"][0], t))
    if not spans:
        return ""

    def kunci(s):
        # "&" dan "and" disamakan, tanda baca dibuang, supaya banner "Science &
        # Technology" tetap dikenali sebagai nama jurnal "Science and Technology".
        s = normalkan(s).upper().replace("&", " AND ")
        return re.sub(r"[^A-Z0-9 ]+", " ", " ".join(s.split()))

    jn = kunci(nama_jurnal)
    if jn:
        # Buang span yang isinya potongan nama jurnal, sebelum dikelompokkan per ukuran.
        spans = [s for s in spans if not (len(kunci(s[3])) > 6 and kunci(s[3]) in jn)]

    ukuran = sorted({s[0] for s in spans}, reverse=True)
    for u in ukuran[:4]:
        tier = sorted([s for s in spans if abs(s[0] - u) < 0.6], key=lambda s: (s[1], s[2]))
        teks = normalkan(" ".join(t for _, _, _, t in tier))
        teks = re.sub(r"\(\s+", "(", re.sub(r"\s+\)", ")", teks))
        if len(teks) < 20:
            continue
        if jn and kunci(teks) in jn:
            continue  # tier ini nama jurnal, bukan judul
        return teks[:300]
    return ""


def cari_running_head(halaman_teks):
    """Baris atas yang berulang di halaman 2 dst. Kembalikan contoh + jumlah halaman yang punya."""
    if len(halaman_teks) < 3:
        return {"ada": False, "contoh": "", "halaman_terdeteksi": 0}

    atas = []
    for t in halaman_teks[1:]:
        baris = [b.strip() for b in t.split("\n") if b.strip()]
        atas.append(baris[0] if baris else "")

    def bentuk(s):
        # Buang angka supaya nomor halaman tidak membedakan
        return normalkan(re.sub(r"\d+", "#", s)).lower()

    hitung = {}
    for s in atas:
        if len(s) < 8:
            continue
        hitung.setdefault(bentuk(s), []).append(s)

    if not hitung:
        return {"ada": False, "contoh": "", "halaman_terdeteksi": 0}

    terbanyak = max(hitung.values(), key=len)
    return {
        "ada": len(terbanyak) >= 2,
        "contoh": terbanyak[0],
        "halaman_terdeteksi": len(terbanyak),
    }


def ekstrak_galley(teks_penuh, halaman_teks, zona_deklarasi=None):
    n = normalkan(teks_penuh)
    z = normalkan(zona_deklarasi if zona_deklarasi is not None else teks_penuh)
    hasil = {}

    rh = cari_running_head(halaman_teks)
    hasil["running_head"] = rh

    m = re.search(r"(Creative\s+Commons[^.]{0,120}|CC\s*BY[-\s]*[A-Z\-]*\s*4\.0|open\s+access\s+article[^.]{0,120})", n, re.IGNORECASE)
    hasil["lisensi"] = {"ada": bool(m), "kutipan": m.group().strip() if m else ""}

    m = re.search(r"(©|\(c\)\s*)\s*\d{4}[^.]{0,80}|Copyright\s*©?[^.]{0,80}", n, re.IGNORECASE)
    hasil["hak_cipta"] = {"ada": bool(m), "kutipan": m.group().strip() if m else ""}

    tanggal = {}
    for kunci, pola in RIWAYAT:
        m = re.search(pola, n, re.IGNORECASE)
        if m:
            tanggal[kunci] = m.group(1).strip()
    hasil["riwayat_naskah"] = {
        "ada": len(tanggal) >= 2,
        "tanggal": tanggal,
        "jumlah_tanggal": len(tanggal),
    }

    doi = POLA_DOI.search(n)
    hasil["doi_tercantum"] = {"ada": bool(doi), "kutipan": doi.group() if doi else ""}

    for kunci, pola in DEKLARASI:
        m = re.search(pola, z, re.IGNORECASE)
        hasil[kunci] = {"ada": bool(m), "kutipan": normalkan(m.group())[:160] if m else ""}

    # CRediT (peka huruf besar) juga sah sebagai pernyataan kontribusi penulis
    if not hasil["kontribusi_penulis"]["ada"]:
        mc = POLA_CREDIT.search(z)
        if mc:
            hasil["kontribusi_penulis"] = {"ada": True, "kutipan": "CRediT"}

    unsur = [
        "running_head", "lisensi", "hak_cipta", "riwayat_naskah", "doi_tercantum",
        "deklarasi_ai", "kontribusi_penulis", "pendanaan", "konflik_kepentingan",
    ]
    hasil["terpenuhi"] = sum(1 for u in unsur if hasil[u]["ada"])
    hasil["dari"] = len(unsur)
    hasil["hilang"] = [u for u in unsur if not hasil[u]["ada"]]
    return hasil


GELAR = re.compile(
    r"\b(Prof|Dr|Drs|Dra|Ir|M\.Pd|M\.Si|M\.Sc|M\.A|M\.T|S\.Pd|S\.Si|S\.T|Ph\.?D|M\.Kom)\b",
    re.IGNORECASE,
)


def ekstrak_penulis(halaman1_baris, heading):
    """Blok penulis: antara judul dan ABSTRACT di halaman 1. Best-effort."""
    batas = len(halaman1_baris)
    for i, b in enumerate(halaman1_baris):
        if re.match(r"^\s*(A\s*B\s*S\s*T\s*R\s*A\s*C\s*T|ABSTRACT|ABSTRAK)\b", b.strip(), re.IGNORECASE):
            batas = i
            break

    blok = [b.strip() for b in halaman1_baris[:batas] if b.strip()]
    email = POLA_EMAIL.findall("\n".join(blok))

    # Baris kandidat nama: banyak koma / ada superskrip angka, bukan kalimat panjang
    kandidat = []
    for b in blok:
        if len(b) > 200 or b.lower().startswith(("available online", "https://", "doi:", "copyright", "vol", "volume")):
            continue
        if re.search(r"[A-Z][a-z]+\s+[A-Z]", b) and ("," in b or re.search(r"[a-z]\d", b)):
            kandidat.append(b)

    baris_nama = kandidat[0] if kandidat else ""
    nama_mentah = [n.strip() for n in re.split(r",| and | & ", baris_nama) if n.strip()]

    penulis = []
    for nm in nama_mentah:
        bersih = re.sub(r"[\d\*\u2020\u2021]+", "", nm).strip()
        if not bersih or len(bersih.split()) > 6:
            continue
        kata = bersih.split()
        penulis.append({
            "nama": bersih,
            "jumlah_kata": len(kata),
            "nama_belakang_disingkat": bool(re.match(r"^[A-Z]\.?$", kata[-1])) if kata else False,
            "ada_gelar": bool(GELAR.search(nm)),
        })

    afiliasi = [b for b in blok if re.search(r"Universit|Institut|Politeknik|Sekolah Tinggi|Faculty|Fakultas|Department|Departemen|Program", b, re.IGNORECASE)]
    teks_af = " ".join(afiliasi)

    return {
        "blok_mentah": blok[-8:],
        "penulis": penulis,
        "afiliasi_baris": afiliasi,
        "afiliasi_ada_institusi": bool(afiliasi),
        "afiliasi_ada_negara": bool(re.search(r"Indonesia|Malaysia|Singapore|Australia|China|Japan|P\.R\. China|Thailand|Philippines", teks_af, re.IGNORECASE)),
        "email_korespondensi": email[:3],
        "ada_email_korespondensi": bool(email),
    }


# --------------------------------------------------------------------------
# Rujukan (F.7, F.8) & sitasi (G.5)
# --------------------------------------------------------------------------

POLA_TAHUN = re.compile(r"(?:19|20)\d{2}")
# Entri gaya nama-tahun dimulai di AWAL BARIS: "Surname, A." atau "Lumban Gaol, N. T."
POLA_ENTRI_NAMA = re.compile(
    r"^\s*[A-ZÀ-Ý][\wÀ-ÿ’'\-]*(?:\s+[A-ZÀ-Ý][\wÀ-ÿ’'\-]*){0,2},\s*[A-ZÀ-Ý]\."
)
# Entri gaya bernomor: "[12]" sendirian di satu baris, "[12] Author", atau "12. Author"
POLA_ENTRI_NOMOR = re.compile(
    r"^\s*(?:\[(\d{1,3})\]\s*$|\[(\d{1,3})\]\s+\S|(\d{1,3})\.\s+[A-ZÀ-Ý])"
)


def pisah_entri_rujukan(baris_ref):
    """Tentukan gaya daftar pustaka dan indeks baris awal tiap entri."""
    idx_nomor = [i for i, b in enumerate(baris_ref) if POLA_ENTRI_NOMOR.match(b)]
    idx_nama = [i for i, b in enumerate(baris_ref) if POLA_ENTRI_NAMA.match(b)]
    if len(idx_nomor) >= 3 and len(idx_nomor) >= len(idx_nama):
        return "bernomor", idx_nomor
    return "nama-tahun", idx_nama


def ekstrak_rujukan(baris_ref):
    if not baris_ref:
        return {"jumlah": 0, "gaya_daftar": None,
                "catatan": "section REFERENCES tidak ditemukan"}

    gaya, indeks = pisah_entri_rujukan(baris_ref)
    entri = []
    for k, i in enumerate(indeks):
        akhir = indeks[k + 1] if k + 1 < len(indeks) else len(baris_ref)
        teks = normalkan(" ".join(baris_ref[i:akhir]))
        if len(teks) < 25:
            continue
        # Buang penanda nomor di depan supaya surname terbaca benar
        bersih = re.sub(r"^\s*(?:\[\d{1,3}\]|\d{1,3}\.)\s*", "", teks)
        mt = POLA_TAHUN.search(bersih)
        entri.append({
            "nomor": k + 1,
            "surname": bersih.split(",")[0].strip()[:60],
            "tahun": int(mt.group()) if mt else None,
            "ada_doi": bool(POLA_DOI.search(teks)),
            "kutipan": teks[:200],
        })

    tahun = [e["tahun"] for e in entri if e["tahun"]]
    mutakhir = [t for t in tahun if TAHUN_INI - t <= 10]

    return {
        "jumlah": len(entri),
        "gaya_daftar": gaya,
        "tahun_min": min(tahun) if tahun else None,
        "tahun_maks": max(tahun) if tahun else None,
        "punya_tahun": len(tahun),
        "mutakhir_10_tahun": len(mutakhir),
        "persen_mutakhir": round(len(mutakhir) / len(tahun) * 100) if tahun else None,
        "ber_doi": sum(1 for e in entri if e["ada_doi"]),
        "acuan_minimal_15": len(entri) >= 15,
        "entri": entri,
    }


POLA_SITASI_KURUNG = re.compile(r"\(([^()]{2,200}?(?:19|20)\d{2}[a-z]?)\)")
POLA_SITASI_NARASI = re.compile(r"\b([A-ZÀ-Ý][\wÀ-ÿ’'\-]+)(?:\s+et\s+al\.)?\s*\((?:19|20)(\d{2})[a-z]?\)")


def kunci_sitasi(teks_badan):
    kunci = set()
    for m in POLA_SITASI_KURUNG.finditer(teks_badan):
        isi = m.group(1)
        for bagian in re.split(r";", isi):
            b = bagian.strip()
            mt = re.search(r"((?:19|20)\d{2})", b)
            if not mt:
                continue
            nm = re.match(r"([A-ZÀ-Ý][\wÀ-ÿ’'\-]+)", b)
            if nm:
                kunci.add((nm.group(1).lower(), int(mt.group(1))))
    for m in POLA_SITASI_NARASI.finditer(teks_badan):
        kunci.add((m.group(1).lower(), int("20" + m.group(2)) if int(m.group(2)) < 50 else int("19" + m.group(2))))
    return kunci


POLA_SITASI_NOMOR = re.compile(r"\[(\d{1,3})(?:\s*[,–-]\s*\d{1,3})*\]")


def deteksi_gaya_sitasi(teks_badan):
    n_nomor = len(POLA_SITASI_NOMOR.findall(teks_badan))
    n_nama = len(kunci_sitasi(teks_badan))
    if n_nomor >= 5 and n_nomor > n_nama:
        return "bernomor", n_nomor, n_nama
    return "nama-tahun", n_nomor, n_nama


def cocokkan_sitasi(teks_badan, rujukan):
    gaya, n_nomor, n_nama = deteksi_gaya_sitasi(teks_badan)
    jml_entri = rujukan.get("jumlah", 0)

    if gaya == "bernomor":
        dikutip = set()
        for m in POLA_SITASI_NOMOR.finditer(teks_badan):
            for angka in re.findall(r"\d{1,3}", m.group()):
                dikutip.add(int(angka))
        di_luar = sorted(x for x in dikutip if jml_entri and x > jml_entri)
        tak_dikutip = sorted(x for x in range(1, jml_entri + 1) if x not in dikutip)
        return {
            "gaya": "bernomor",
            "jumlah_penanda_sitasi": n_nomor,
            "nomor_unik_dikutip": len(dikutip),
            "entri_daftar_pustaka": jml_entri,
            "nomor_di_luar_rentang": di_luar,
            "entri_tidak_pernah_dikutip": tak_dikutip,
            "catatan": "Gaya bernomor. Pencocokan membandingkan nomor yang dikutip di teks "
                       "dengan jumlah entri daftar pustaka.",
        }

    dalam_teks = kunci_sitasi(teks_badan)
    daftar = {(e["surname"].lower(), e["tahun"]) for e in rujukan.get("entri", []) if e["tahun"]}
    # Surname majemuk ("Lumban Gaol") juga didaftarkan lewat kata pertamanya
    for e in rujukan.get("entri", []):
        if e["tahun"] and " " in e["surname"]:
            daftar.add((e["surname"].split()[0].lower(), e["tahun"]))

    cocok = dalam_teks & daftar
    yatim_teks = dalam_teks - daftar
    yatim_daftar = daftar - dalam_teks

    return {
        "gaya": "nama-tahun",
        "kunci_dalam_teks_unik": len(dalam_teks),
        "entri_daftar_pustaka": rujukan.get("jumlah", 0),
        "cocok": len(cocok),
        "jumlah_yatim_teks": len(yatim_teks),
        "yatim_teks": sorted(f"{a} {b}" for a, b in yatim_teks)[:25],
        "jumlah_yatim_daftar": len(yatim_daftar),
        "yatim_daftar": sorted(f"{a} {b}" for a, b in yatim_daftar)[:25],
        "catatan": "Pencocokan berbasis surname penulis pertama + tahun. Ejaan berbeda, "
                   "nama majemuk, atau tahun ganda dapat menghasilkan yatim palsu. "
                   "Angka ini penunjuk, bukan vonis.",
    }


# --------------------------------------------------------------------------
# Instrumen pendukung (G.4)
# --------------------------------------------------------------------------

def ekstrak_instrumen(baris_list, teks_badan):
    """Caption ditulis dua gaya: label sendirian di satu baris ("Table 1", judul di baris
    berikutnya) atau label + pemisah + judul ("Table 1. Sebaran ..."). Kalimat biasa yang
    kebetulan diawali "Table 1 displays ..." bukan caption, jadi pemisah wajib ada."""
    hasil = {}
    for label, pola_id in (("tabel", r"(?:Table|Tabel)"), ("gambar", r"(?:Figure|Fig\.?|Gambar)")):
        caption = set()
        for b in baris_list:
            s = b.strip()
            m = (re.match(r"^" + pola_id + r"\s*(\d+)\s*[.:]?$", s, re.IGNORECASE)
                 or re.match(r"^" + pola_id + r"\s*(\d+)\s*[.:]\s+\S", s, re.IGNORECASE))
            if m:
                caption.add(int(m.group(1)))
        diacu = {int(m.group(1)) for m in re.finditer(pola_id + r"\s*(\d+)", teks_badan, re.IGNORECASE)}
        hasil[label] = {
            "caption": sorted(caption),
            "jumlah_caption": len(caption),
            "nomor_diacu_di_teks": sorted(diacu),
            "caption_tanpa_acuan": sorted(caption - diacu),
        }
    return hasil


# --------------------------------------------------------------------------
# Abstrak & kata kunci (F.2, F.3)
# --------------------------------------------------------------------------

# Label kolom ARTICLE INFO. Harus di AWAL BARIS dan diikuti titik dua, supaya kata
# "keywords" yang muncul di tengah kalimat abstrak tidak ikut memotong.
# Label kolom ARTICLE INFO yang menandai berakhirnya teks abstrak. Harus di awal
# baris supaya kata "keywords" di tengah kalimat abstrak tidak ikut memotong.
POLA_LABEL_INFO = re.compile(
    r"^[ \t]*(?:Key\s*words?|Kata\s*kunci|Article\s+History|Riwayat\s+Artikel)"
    r"\s*[::]?[ \t]*$"
    r"|^[ \t]*(?:Key\s*words?|Kata\s*kunci|Article\s+History)\s*[::]",
    re.MULTILINE | re.IGNORECASE,
)
# "A R T I C L E  I N F O" adalah judul kolom kanan, bukan penanda akhir abstrak.
POLA_ARTICLE_INFO = re.compile(
    r"^[ \t]*A\s*R\s*T\s*I\s*C\s*L\s*E\s+I\s*N\s*F\s*O[ \t]*$",
    re.MULTILINE | re.IGNORECASE,
)


def ekstrak_abstrak(section):
    for label, teks in section.items():
        if "ABSTRACT" in label.upper() or "ABSTRAK" in label.upper():
            teks = POLA_ARTICLE_INFO.sub("", teks)
            # Abaikan label yang muncul sangat awal: itu sisa header kolom, bukan akhir abstrak
            m = next((x for x in POLA_LABEL_INFO.finditer(teks) if x.start() > 120), None)
            potong = teks[:m.start()] if m else teks
            potong = re.split(r"©|\(c\)\s*\d{4}", potong)[0]
            n = normalkan(potong)
            return {
                "ada": True,
                "jumlah_kata": len(n.split()),
                "memuat_sitasi": bool(re.search(r"\((?:19|20)\d{2}\)", n)),
                "menyebut_tabel_gambar": bool(re.search(r"\b(Table|Tabel|Figure|Gambar)\s*\d", n, re.IGNORECASE)),
                "teks": n[:2500],
            }
    return {"ada": False, "catatan": "heading ABSTRACT/ABSTRAK tidak terdeteksi"}


POLA_LABEL_KATA_KUNCI = re.compile(
    r"^[ \t]*(?:Key\s*words?|Kata\s*kunci)\s*[::]?[ \t]*$"
    r"|^[ \t]*(?:Key\s*words?|Kata\s*kunci)\s*[::][ \t]*",
    re.MULTILINE | re.IGNORECASE,
)


def ekstrak_kata_kunci(teks_penuh):
    m = POLA_LABEL_KATA_KUNCI.search(teks_penuh)
    if not m:
        return {"ada": False, "daftar": []}
    blok = teks_penuh[m.end():m.end() + 400]
    blok = re.split(
        r"\n\s*\n|Indonesian Journal|©|https?://|A R T I C L E|Open\s+access|"
        r"^[ \t]*(?:ABSTRA|INTRODUCTION|PENDAHULUAN|Article\s+History)",
        blok,
        flags=re.MULTILINE,
    )[0]
    pisah = [k.strip(" .;:") for k in re.split(r"[;,\n]", blok) if 2 < len(k.strip()) < 60]
    return {"ada": bool(pisah), "daftar": pisah[:12], "blok_mentah": normalkan(blok)[:300]}


# --------------------------------------------------------------------------
# Orkestrasi
# --------------------------------------------------------------------------

def proses(path, nama_jurnal=""):
    dok = pymupdf.open(path)
    halaman_teks = [p.get_text() for p in dok]
    teks_penuh = "\n".join(halaman_teks)
    baris_list = teks_penuh.split("\n")

    heading, section = petakan_section(baris_list)

    # Daftar pustaka selalu di akhir artikel. Ambil heading "referensi" TERAKHIR:
    # sebagian PDF punya kata "REFERENCE" nyasar di tengah (label gambar/kolom).
    ref_heading = [h for h in heading if h["kanonik"] == "referensi"]
    idx_ref = ref_heading[-1]["baris"] if ref_heading else len(baris_list)
    baris_ref = baris_list[idx_ref + 1:]
    teks_badan = "\n".join(baris_list[:idx_ref])

    rujukan = ekstrak_rujukan(baris_ref)
    n = normalkan(teks_penuh)

    # Zona deklarasi: dari heading simpulan sampai akhir dokumen. Blok Acknowledgements
    # dan Authors' Note ada di rentang itu, entah sebelum atau sesudah daftar pustaka.
    idx_simpulan = next((h["baris"] for h in heading if h["kanonik"] == "simpulan"), None)
    if idx_simpulan is None:
        idx_simpulan = int(len(baris_list) * 0.70)
    zona_deklarasi = "\n".join(baris_list[idx_simpulan:])

    kanonik_ada = [h["kanonik"] for h in heading if h["kanonik"]]
    wajib = ["pendahuluan", "metode", "hasil", "simpulan", "referensi"]

    return {
        "berkas": os.path.basename(path),
        "halaman": len(dok),
        "karakter": len(teks_penuh),
        "identitas": {
            "doi": (POLA_DOI.search(n).group() if POLA_DOI.search(n) else ""),
            "eissn": (POLA_EISSN.search(n).group(1) if POLA_EISSN.search(n) else ""),
            "pissn": (POLA_PISSN.search(n).group(1) if POLA_PISSN.search(n) else ""),
            "judul": judul_artikel(dok, nama_jurnal),
            "nama_jurnal": nama_jurnal,
            "baris_awal_halaman1": [b.strip() for b in halaman_teks[0].split("\n") if b.strip()][:25],
        },
        "galley": ekstrak_galley(teks_penuh, halaman_teks, zona_deklarasi),
        "penulis": ekstrak_penulis(halaman_teks[0].split("\n"), heading),
        "struktur": {
            "heading": [{"label": h["label"], "kanonik": h["kanonik"]} for h in heading],
            "kanonik_ada": sorted(set(kanonik_ada)),
            "imrad_lengkap": all(w in kanonik_ada for w in wajib),
            "kanonik_hilang": [w for w in wajib if w not in kanonik_ada],
        },
        "rujukan": rujukan,
        "sitasi": cocokkan_sitasi(teks_badan, rujukan),
        "instrumen": ekstrak_instrumen(baris_list, teks_badan),
        "abstrak": ekstrak_abstrak(section),
        "kata_kunci": ekstrak_kata_kunci(teks_penuh),
        "teks_section": {k: v for k, v in section.items()},
    }


def main():
    os.makedirs(KELUARAN, exist_ok=True)
    berkas = sorted(f for f in os.listdir(SUMBER) if f.lower().endswith(".pdf"))
    if not berkas:
        sys.exit(f"Tidak ada PDF di {SUMBER}")

    peta = {}
    if os.path.exists(PETA_JURNAL):
        peta = json.load(open(PETA_JURNAL, encoding="utf-8"))

    for f in berkas:
        kode = os.path.splitext(f)[0].replace("artikel ", "").replace(" ", "_")
        hasil = proses(os.path.join(SUMBER, f), peta.get(kode, ""))
        nama = os.path.splitext(f)[0].replace(" ", "_")
        tujuan = os.path.join(KELUARAN, nama + ".json")
        with open(tujuan, "w", encoding="utf-8") as fh:
            json.dump(hasil, fh, ensure_ascii=False, indent=2)

        g = hasil["galley"]
        r = hasil["rujukan"]
        s = hasil["sitasi"]
        if s["gaya"] == "bernomor":
            ringkas_sitasi = (f"bernomor, {s['nomor_unik_dikutip']}/{s['entri_daftar_pustaka']} entri dikutip")
        else:
            ringkas_sitasi = (f"nama-tahun, cocok {s['cocok']}/{s['kunci_dalam_teks_unik']}")
        print(
            f"{f:26s} | hlm {hasil['halaman']:2d} "
            f"| galley {g['terpenuhi']}/{g['dari']} "
            f"| rujukan {r.get('jumlah', 0):3d} (mutakhir {r.get('persen_mutakhir')}%) "
            f"| {ringkas_sitasi}"
        )


if __name__ == "__main__":
    main()
