# Style Brief & Rundown — Video Explainer Profil Jurnal UPI

Revisi 2, setelah `angkaExplainer()` dijalankan. Untuk disetujui **sebelum** kode ditulis.

Format: katalog putih · 16:9 · 60 detik · narasi menyusul.
Starter: `assets/starter-explainer-katalog.html`.
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

## Dua koreksi terhadap revisi 1

**1. Tidak ada cover, jadi entitas visualnya berubah.** Fungsi impor cover dibuang dari sistem ini
awal sesi karena sudah pindah ke Litabmas. Revisi 1 membangun seluruh konsep di atas aset yang
tidak ada.

Penggantinya: **kartu tipografi**. Tiap jurnal jadi kartu putih berisi nama jurnal (Archivo Black),
kluster, dan e-ISSN. Gaya katalog putih tetap utuh — katalog kartu memang tidak harus bergambar —
dan tanda tangan gerak "kartu mendarat" justru tetap hidup. Bonus: 173 kartu teks jauh lebih
ringan daripada 173 gambar, dan selalu terender.

**2. Kolom kluster mencampur tiga hal.** Delapan bidang keilmuan (ECONOMY, EDUCATION, LANGUAGE,
SOCIAL, SCIENCE, TECH, SPORTS, ARTS), lima kampus daerah (CIBIRU, SUMEDANG, TASIKMALAYA, SERANG,
PURWAKARTA), dua unit (SPS, DPPM), dan tiga nama jurnal yang diberi kluster sendiri (IJOST, IJAL,
AJSE). Menyebut semuanya "kluster keilmuan" salah.

`[PERLU KEPUTUSAN]` Dua pilihan untuk adegan 5: sebut **delapan bidang keilmuan** saja dan
kampus daerah disebut satu kalimat terpisah, atau ceritakan sebarannya sebagai "pusat dan lima
kampus daerah" yang justru jadi cerita tersendiri. Saya condong ke yang kedua — jangkauan
geografis lebih menarik daripada daftar bidang, dan tidak ada universitas lain yang punya itu.

---

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

**Transisi.** Push-through kamera menembus kisi kartu (berkedalaman), dan cut ke instrumen
(deretan lencana SINTA, peta kampus). Tanpa balok datar menyapu.

**Momen istimewa.** Adegan 2: 2.687 kartu kecil membanjir masuk dari luar layar dan mengendap
jadi satu bidang penuh, kamera menarik mundur. Sekali saja.

---

## Rundown — 6 adegan, 60 detik

| Detik | Adegan | Kalimat | Visual |
|---|---|---|---|
| 0–9 | Pembuka | "UPI mengelola 173 jurnal ilmiah." | satu kartu mendarat, kamera mundur |
| 9–20 | Volume | "Setiap tahun terbit sekitar 2.700 artikel." | **momen istimewa** — kartu membanjir jadi bidang penuh |
| 20–31 | Akreditasi | "110 di antaranya terakreditasi nasional." | bidang menyusut jadi enam batang SINTA 1–6 |
| 31–42 | Indeksasi | "25 terindeks DOAJ, 137 terdaftar di Garuda, 3 masuk kuartil internasional." | tiga kolom **sejajar**, masing-masing dengan baris sumber |
| 42–52 | Jangkauan | "Dari kampus pusat sampai lima kampus daerah." | kartu berpindah jadi sebaran geografis |
| 52–60 | Penutup | "Katalognya terbuka untuk siapa pun." | bidang penuh + alamat direktori |

**Aturan yang dipasang di rundown, bukan diserahkan ke naskah:**

- Adegan 4 menampilkan tiga indeks **sejajar, bukan bertingkat**. DOAJ hanya menerima jurnal
  akses terbuka penuh, jadi ia bukan tahap menuju Scopus.
- **Garuda 137 diberi label "terdaftar", bukan "terverifikasi".** Angka itu berasal dari
  `urlValid_(linkGaruda)` — pemeriksaan bentuk URL, sama lemahnya dengan cara lama menghitung
  DOAJ, dan tidak ada sheet verifikasi Garuda. DOAJ boleh disebut "terverifikasi" karena
  `Verifikasi_DOAJ` ada dan selisihnya hanya 3.
- Angka 2.687 disebut "sekitar 2.700" dan berasal dari 140 jurnal yang melaporkan. Naskah tidak
  boleh menyiratkan seluruh 173 terhitung.
- Penyebut 173. Tujuh jurnal `BELUM DIKELOLA` tidak ikut dan tidak disebut.
- Tidak ada `timeliness`, tidak ada nama jurnal yang SK-nya mendekati habis.

**APC keluar dari enam adegan.** Contoh isinya menunjukkan pola yang bisa diurai otomatis
("USD 1000", "Rp 750,000", "Gratis"), tetapi dari 12 contoh hanya satu yang gratis. Dugaan bahwa
"tidak memungut biaya" adalah kekuatan portofolio kemungkinan besar salah, dan 41 kolom kosong
membuat angkanya rapuh. Kalau nanti diklasifikasi manual dan hasilnya bagus, ini bisa jadi adegan
ketujuh atau menggantikan adegan 5.

---

## Langkah berikutnya

1. Anda putuskan `[PERLU KEPUTUSAN]` soal kluster di atas.
2. Anda setujui atau koreksi style brief dan rundown.
3. Baru kode ditulis, dari `starter-explainer-katalog.html`.
4. Naskah VO diserahkan bersama `index.html`; Anda rekam, kirim balik, timeline disinkronkan.

ffmpeg dan puppeteer belum terpasang. Tanpa keduanya hasilnya tetap `index.html` yang bisa
ditonton; hanya MP4 dan potret verifikasi otomatis yang belum ada.
