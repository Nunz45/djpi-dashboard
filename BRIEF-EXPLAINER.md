# Style Brief & Rundown — Persiapan Akreditasi & Reakreditasi Jurnal UPI

Revisi 3. Video sudah dibangun; berkas ini jadi catatan keputusannya.

Format: katalog putih · 16:9 · 62 detik · narasi menyusul.
Starter: `assets/starter-explainer-katalog.html` (skill bang-motion).
Keluaran: satu `index.html` autoplay + loop. MP4 menyusul bila ffmpeg dipasang.

---

## Angka nyata (6 September 2026)

| | |
|---|---|
| Baris direktori | 180 |
| **Dikelola (penyebut)** | **173** |
| Belum dikelola | 7 |
| Terakreditasi | 110 dari 173 |
| SINTA 1 / 2 / 3 / 4 / 5 / 6 | 3 · 11 · 34 · 36 · 24 · 2 |
| DOAJ terverifikasi | 25 (selisih vs direktori hanya 3 → **layak dipakai**) |
| Garuda | 137 (**tautan tercatat, belum diverifikasi**) |
| Kuartil Q1–Q4 | 3 |
| Artikel per tahun | 2.687, dari 140 jurnal yang melaporkan |
| Kolom APC terisi | 132; kosong 41 |
| **Cover tersimpan** | **0** |

---

## Riwayat keputusan

**Cover tidak dipakai.** Fungsi impor cover dibuang dari sistem ini karena sudah pindah ke
Litabmas, dan `angkaExplainer()` melaporkan 0 dari 173. Entitas visualnya jadi sel dan kartu
tipografi — lebih ringan dan selalu terender.

**Kolom kluster tidak dipakai.** Isinya mencampur delapan bidang keilmuan, lima kampus daerah,
dua unit, dan tiga nama jurnal. Adegan sebaran geografis sempat dibuat lalu dibuang bersama
struktur lama.

**Dari sensus jadi mekanisme.** Versi pertama mendaftar enam angka; dua grill menunjukkan
adegannya bisa ditukar urutannya tanpa kehilangan apa pun. Versi ini menjelaskan satu hal —
bagaimana jurnal masuk dan dinilai — dan urutannya mengikat.

## Style brief

**Tema.** Katalog 173 jurnal ilmiah satu universitas, dibuka satu per satu. Tiga rasa: **tertata,
terbuka, sedang tumbuh.**

**Palet** — dari identitas UPI, bukan dari starter.

| Peran | Hex |
|---|---|
| Utama | `#7f0000` marun UPI |
| Latar | `#FBFAF8` kertas hangat |
| Tinta | `#1A1614` |
| Sorotan | `#E8B22A` |
| Redup | `#6B615C` |

**Font.** Display **Archivo Black** (padat, katalog, di luar daftar terlarang skill). Pendamping
**Caveat** untuk penghubung tulisan tangan. Angka **IBM Plex Mono** dengan `tabular-nums`.

**Tanda tangan gerak.** *Kartu mendarat* — kartu jurnal terbang masuk, mendarat sedikit miring
lalu lurus, seperti kartu katalog diletakkan di meja.

**Gerak latar.** Menu §7c #8, kisi yang bernapas (1.0↔1.04, 8 detik). Terpisah dari tanda tangan
gerak, sesuai aturan skill.

**Permukaan latar.** Menu §7d c + f: kertas hangat, dua blob marun opacity ≤ .12, grain
`feTurbulence` multiply opacity .10. Dua lapis.

**Transisi.** Tiga jenis, satu berkedalaman sungguhan: push-through lewat `translateZ` +
`perspective`, object wipe berupa kartu besar melewati lensa, dan whip `rotateY`. Tanpa balok
datar menyapu.

**Momen istimewa.** Adegan 1: 173 sel mendarat lalu memisah jadi dua rumpun. Sekali saja, dan
sekaligus menjadi premis seluruh video.

---

## Rundown — 6 adegan, 62 detik (revisi 3)

Judul: **Persiapan Akreditasi & Reakreditasi Jurnal UPI**. Strukturnya memisah lalu menyatu:
posisi → dua jalur yang berbeda → keduanya bertemu di rubrik yang sama → ajakan. Urutannya
tidak bisa ditukar.

| Detik | Adegan | Kalimat di layar | Visual |
|---|---|---|---|
| 0–9 | Posisi | "110 sudah, 63 belum." | 173 sel mendarat lalu **memisah** jadi dua rumpun: 110 merah, 63 emas |
| 9–21 | Jalur akreditasi baru | "Mulai dari tiga tahun terbit." | kartu Akreditasi Baru · 63 jurnal; syarat masuk dan jendela penilaian |
| 21–33 | Jalur reakreditasi | "Ajukan enam bulan sebelum SK habis." | garis waktu: penanda tenggat, jeda enam bulan, penanda SK habis |
| 33–45 | Satu rubrik | "Dua jalur, satu rubrik yang sama." | blok 46 + 54, lalu empat ambang peringkat |
| 45–55 | Bagian terberat | "Bagian terberat dibaca, bukan diklaim." | blok 54 sendirian |
| 55–62 | Ajakan | "Mulai dari daftar periksa-nya." | 173 sel kembali + kartu "Jurnal Anda", match cut ke detik nol |

**Sumber tiap butir, diperiksa ke `Code.js` sebelum dipakai:**

| Butir | Sumber |
|---|---|
| 110 terakreditasi, 63 belum, dari 173 dikelola | `angkaExplainer()` |
| Akreditasi baru: terbit ≥3 tahun berturut-turut | syarat `s2b` |
| Akreditasi baru: dinilai atas terbitan 3 tahun terakhir | catatan unsur Tata Kelola & disinsentif |
| Reakreditasi: ajukan ≥6 bulan sebelum SK habis | `akrTenggatUlang` (`berakhir.getMonth() - 6`) |
| Reakreditasi: dinilai atas 3 nomor terbitan terakhir | syarat `s2u`, diperbarui atas keputusan Anda |
| Tata Kelola 46 + Mutu Artikel 54 = 100 | rubrik §28 |
| Ambang Peringkat 1–4: 90 / 80 / 70 / 60 | `rubrikAkreditasi_().peringkat` |

`[CATATAN]` Syarat `s2u` di `Code.js` semula berbunyi "Terbitan 3 tahun terakhir lengkap".
Diperbarui jadi tiga nomor terbitan terakhir supaya rubrik aplikasi dan video tidak
bertentangan. Kalau juknis ARJUNA ternyata menyebut lain, keduanya perlu diralat bersamaan.

## Yang tersisa

1. Rekam narasi dari `explainer/vo-script.md`, simpan sebagai `explainer/vo.mp3`, lalu kabari
   saya untuk disinkronkan.
2. Pasang ffmpeg dan puppeteer bila ingin MP4. Tanpa itu `index.html` tetap bisa ditonton
   dengan klik dua kali.
3. Periksa butir `[CATATAN]` di atas terhadap juknis ARJUNA.
