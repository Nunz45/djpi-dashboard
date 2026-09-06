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

## Langkah berikutnya

1. Anda putuskan `[PERLU KEPUTUSAN]` soal kluster di atas.
2. Anda setujui atau koreksi style brief dan rundown.
3. Baru kode ditulis, dari `starter-explainer-katalog.html`.
4. Naskah VO diserahkan bersama `index.html`; Anda rekam, kirim balik, timeline disinkronkan.

ffmpeg dan puppeteer belum terpasang. Tanpa keduanya hasilnya tetap `index.html` yang bisa
ditonton; hanya MP4 dan potret verifikasi otomatis yang belum ada.
