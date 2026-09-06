# Style Brief & Rundown — Video Explainer Profil Jurnal UPI

Untuk disetujui **sebelum** kode ditulis (syarat bang-motion, Hukum #3 dan alur kerja langkah 0b).

Format: katalog putih · 16:9 · 60 detik · narasi menyusul.
Starter: `assets/starter-explainer-katalog.html`.
Keluaran: satu `index.html` yang autoplay dan loop. MP4 menyusul bila ffmpeg dipasang.

---

## Style brief

**Tema.** Portofolio 100-an jurnal ilmiah yang dikelola satu universitas, disajikan sebagai
katalog yang dibuka satu per satu. Tiga rasa yang ingin ditinggalkan: **tertata, terbuka, sedang
tumbuh** — bukan megah, bukan defensif.

**Palet.** Diambil dari identitas UPI, bukan dari starter.

| Peran | Hex | Asal |
|---|---|---|
| Utama | `#7f0000` | merah marun UPI, warna yang sudah dipakai sistem DJPI |
| Latar | `#FBFAF8` | putih kertas hangat, sedikit bias merah |
| Tinta | `#1A1614` | hampir hitam, kecokelatan |
| Sorotan | `#E8B22A` | kuning keemasan, tidak berkelahi dengan marun |
| Redup | `#6B615C` | label dan kredit |

**Font.** Display **Archivo Black** — padat, katalog, berkarakter, dan tidak termasuk daftar
terlarang skill (Poppins/Inter/Roboto/Montserrat/Arial). Pendamping **Caveat** untuk penghubung
tulisan tangan ("lalu…", "dan yang ini"). Angka **IBM Plex Mono** dengan `tabular-nums`, supaya
penghitung tidak berubah lebar.

**Tanda tangan gerak.** *Kartu mendarat.* Cover jurnal terbang masuk dan mendarat di kisi dengan
sedikit miring lalu lurus, seperti kartu katalog diletakkan di meja. Diulang di setiap adegan
sebagai identitas. Dipilih karena subjeknya memang katalog, dan karena kita punya cover asli —
bukan gerak generik yang bisa dipakai video mana pun.

**Gerak latar.** Menu §7c **#8 — kisi yang bernapas** (skala 1.0↔1.04, 8 detik). Terpisah dari
tanda tangan gerak, terasa teknis dan presisi, dan cocok dengan latar bergrid gaya katalog.
Bukan "benda melintas ke samping", yang dilarang skill kecuali temanya kecepatan.

**Permukaan latar.** Menu §7d **c + f**: kertas hangat dengan dua blob marun sangat samar
(opacity ≤ .12) ditambah lapis grain `feTurbulence` `multiply` opacity .10. Dua lapis, tidak flat.

**Transisi.** Dua jenis, satu berkedalaman: **push-through** kamera menembus kisi cover (3D), dan
**cut ke instrumen** (peta kluster, deretan lencana SINTA). Tanpa balok datar menyapu frame.

**Momen istimewa.** Sekali saja, di adegan 2: seluruh cover jurnal berkumpul dari luar layar dan
mendarat serentak membentuk satu kisi penuh, kamera menarik mundur. Efek termahal dipakai di sini
dan tidak diulang.

**Kantong teks.** Latar di bawah teks ≥ 80% luminance (kertas), tinta hampir hitam. Cover yang
berada di belakang teks diturunkan opacity-nya ≤ .35.

---

## Rundown — 6 adegan, 60 detik

Angka ditulis `[ANGKA]` sampai `angkaExplainer()` dijalankan. Naskah VO final menyusul setelah
rundown ini disetujui.

| Detik | Adegan | Satu kalimat | Satu visual |
|---|---|---|---|
| 0–9 | Pembuka | "Universitas Pendidikan Indonesia mengelola [N] jurnal ilmiah." | satu cover mendarat, lalu kamera mundur sedikit |
| 9–20 | Skala | "Tersebar di [K] kluster keilmuan." | **momen istimewa** — semua cover mendarat jadi kisi, lalu diwarnai per kluster |
| 20–31 | Akreditasi | "[A] di antaranya sudah terakreditasi nasional." | kisi menyusut jadi deretan lencana SINTA 1–6, tinggi batang per peringkat |
| 31–42 | Indeksasi | "Terindeks di DOAJ, Garuda, dan sebagian di Scopus." | tiga kolom **berdiri sendiri**, bukan corong; tiap kolom punya baris sumber kecil |
| 42–52 | Biaya terbit | "[G] jurnal tidak memungut biaya dari penulis." | cover-cover yang gratis menyala, sisanya meredup |
| 52–60 | Penutup | "Katalog lengkapnya terbuka untuk siapa pun." | kisi penuh kembali + alamat direktori, tanpa klaim peringkat |

**Aturan yang dipasang di rundown, bukan diserahkan ke naskah:**

- Adegan 4 menampilkan tiga indeks **sejajar**, tidak bertingkat. DOAJ hanya menerima jurnal
  akses terbuka penuh, jadi ia bukan tahap menuju Scopus — jurnal hibrida bisa masuk Scopus dan
  secara struktur tidak bisa masuk DOAJ. Corong akan salah.
- Angka DOAJ diambil dari `doajStatus` hasil verifikasi. Kalau `angkaExplainer()` melaporkan
  selisih besar antara tautan direktori dan hasil verifikasi, adegan 4 menyebut Garuda dan Scopus
  saja.
- Penyebut adalah jurnal yang dikelola. Kluster `BELUM DIKELOLA` tidak ikut.
- Tidak ada `timeliness` di layar — kategorinya memuat "Punya Hutang Terbitan", itu catatan
  kepatuhan internal.
- Tidak ada nama jurnal yang SK-nya mendekati habis.
- Adegan 5 baru bisa dibuat setelah kolom APC diklasifikasi manual jadi gratis / berbayar /
  tidak jelas. `apcValid_` hanya menuntut panjang ≥ 3 karakter, jadi isinya teks bebas.
  **Kalau klasifikasi ini tidak dikerjakan, adegan 5 diganti volume terbitan.**

---

## Langkah berikutnya

1. Jalankan `angkaExplainer()` dari editor Apps Script, tempel keluarannya ke sini.
2. Anda setujui style brief dan rundown di atas (atau koreksi).
3. Baru kode ditulis, dari `starter-explainer-katalog.html`.
4. Naskah VO diserahkan bersama `index.html`; Anda rekam, kirim balik, timeline disinkronkan.

Belum dikerjakan: instalasi ffmpeg dan puppeteer. Tanpa keduanya keluarannya tetap
`index.html` yang bisa ditonton; hanya MP4 dan potret verifikasi otomatis yang belum ada.
