# Perintah kerja UI/UX — turunan AUDIT-UIUX.md

Enam langkah, dikerjakan berurutan. Nomor temuan merujuk `AUDIT-UIUX.md`.
Tiap langkah punya perubahan presis dan cara memverifikasinya.

Aturan yang berlaku sepanjang pekerjaan:

- Satu langkah, satu commit. Tanpa test suite dan tanpa staging, commit gabungan
  membuat rollback jadi tebak-tebakan.
- Perbaikan warna dikerjakan **di selector, bukan di token**. Menyentuh token merambat
  ke dua blok gelap kembar di `Stylesheet.html:280-330` dan `:299-344` yang harus selalu
  diedit berpasangan.
- Setiap kali menambah aturan mode gelap, tulis **dua jalur**: `@media (prefers-color-scheme: dark)`
  dengan penjaga `:root:not([data-theme="light"])`, dan `:root[data-theme="dark"], body.dark`.
  Tema bawaan aplikasi ini `auto`, yang tidak memasang atribut `data-theme` sama sekali —
  menguji lewat tombol toggle tidak akan memunculkan bug jalur pertama.
- Verifikasi render lewat CDP pada 390px dan 1024px, terang dan gelap, sebelum commit.

---

## Langkah 1 — U1 Simpan otomatis akreditasi

**Berkas:** `Pengelola.html`, metode `simpanDiam()` dan `jadwalkanSimpan()`.

**Masalah.** `withFailureHandler` kosong sehingga kegagalan tidak terlihat, dan
`if (!a.dimuat || a.menyimpan) return;` membuang simpanan yang jatuh saat simpan lain
berjalan tanpa menjadwalkannya ulang. Indikator tetap menampilkan cap waktu lama.

**Perubahan.**

1. Tambah state `akrSimpanTertunda: false` dan `akrGalatSimpan: ''`.
2. Di `simpanDiam()`, ganti `if (a.menyimpan) return;` jadi menandai `akrSimpanTertunda = true`
   lalu keluar. Setelah simpan selesai, kalau `akrSimpanTertunda` menyala, bersihkan
   penandanya dan panggil `simpanDiam()` sekali lagi.
3. `withFailureHandler` mengisi `akrGalatSimpan` dan **tidak** memperbarui `terakhirDisimpan`.
4. `withSuccessHandler` membersihkan `akrGalatSimpan` saat berhasil, dan mengisinya kalau
   `res.ok` bernilai salah.
5. Indikator di `.akr-nav-status` menampilkan galat itu bila ada, menggantikan teks
   "Tersimpan otomatis", dengan kelas `teks-kurang` supaya terbaca sebagai peringatan.

**Verifikasi.** Di preview, panggil `simpanDiam()` dua kali beruntun dan pastikan yang kedua
tidak hilang. Paksa stub gagal dan pastikan pesan galat muncul serta cap waktu lama tidak
ikut diperbarui.

---

## Langkah 2 — U2, U3, U9, U10, U13 Override mode gelap

**Berkas:** `Stylesheet.html` dan `Dashboard.html`.

**Masalah.** Lima kelompok warna hardcoded tanpa override gelap. Kontras terukur 1,00–2,54:1.

**Perubahan.** Tambahkan pada kedua jalur tema:

| Selector | Sekarang | Nilai gelap |
|---|---|---|
| `.row-alert` | `#fdfaf4` | `#2a2620` |
| `.row-alert-danger` | `#fbecec` | `#2f1b1b` |
| `.row-alert-warning` | `#fff1e2` | `#2f2617` |
| `.input-galat` | `#fdf6f6` | `#2b1d1d` |
| `.kpi-icon-w` | `#fff1e2` / `var(--warn)` | `#2f2617` / `#e0a13f` |
| `.kpi-icon-g` | `var(--gold-soft)` / `#7a5310` | `#2e2814` / `#e6c563` |
| `.kpi-gold` | `#78590e` | `#e6c563` |

Aturan `.kpi-icon-*` yang sudah ada di `Dashboard.html:1872-1874` **hanya menulis jalur
`data-theme`**. Pindahkan seluruh blok itu ke `Stylesheet.html` bersama yang baru, supaya
kedua jalur tema tercakup di satu tempat.

**Verifikasi.** Render tab Akreditasi Dashboard pada mode gelap lewat `prefers-color-scheme`
(bukan lewat toggle) dan hitung ulang kontras baris darurat. Target minimal 4,5:1.

---

## Langkah 3 — U4 Font input 16px di layar sempit

**Berkas:** `Stylesheet.html`.

**Masalah.** `.input,.select{font-size:13px}` (`:153`) dan `.app-nav-cari input{12.5px}` (`:373`)
memicu auto-zoom Safari iOS pada tiap fokus.

**Perubahan.** Tambahkan blok di dalam `@media(max-width:680px)`:

```css
.input, .select, textarea.input, .app-nav-cari input { font-size: 16px; }
```

Jangan ubah `.input-pin` (21px, sudah di atas ambang) dan jangan ubah nilai desktopnya.

**Verifikasi.** Ukur `getComputedStyle` pada field email login Pengelola di 390px; harus 16px.
Pastikan di 1024px tetap 13px.

---

## Langkah 4 — U5 Penjaga `minmax(0,1fr)`

**Berkas:** `Stylesheet.html`, lima baris di dalam `@media(max-width:1000px)` dan
`@media(max-width:680px)`.

**Perubahan.**

| Baris | Sekarang | Jadi |
|---|---|---|
| 250 | `.grid-kpi{repeat(2,1fr)}` | `repeat(2,minmax(0,1fr))` |
| 251 | `.priority-strip{repeat(2,1fr)}` | `repeat(2,minmax(0,1fr))` |
| 252 | `.grid-2,.grid-3,.grid-13{1fr}` | `minmax(0,1fr)` |
| 260 | `.grid-kpi{1fr 1fr}` | `minmax(0,1fr) minmax(0,1fr)` |
| 261 | `.priority-strip{1fr 1fr}` | `minmax(0,1fr) minmax(0,1fr)` |

**Verifikasi.** `scrollWidth` harus sama dengan `clientWidth` pada tab Ringkasan di 390px.
Lalu buka ketiga halaman di **768px dan 1024px** — rentang itu belum pernah teruji karena
bug ini menyembunyikannya, dan `minmax(0,…)` membuat trek boleh lebih sempit dari isinya
sehingga potongan baru bisa muncul.

---

## Langkah 5 — U6, U7 Kolom Aksi lengket dan header tabel

**Berkas:** `Stylesheet.html`.

**Masalah.** Tombol Aksi ±376px di luar layar tanpa petunjuk, dan `th{position:sticky}`
tidak pernah aktif karena `.tabel-bungkus` tidak punya batas tinggi.

**Perubahan.**

```css
/* header lengket butuh pembungkus yang benar-benar bergulir vertikal */
.tabel-bungkus{overflow-x:auto;max-height:70vh;overflow-y:auto}

@media(max-width:680px){
  /* baris perlu latar solid supaya sel lengket tidak tembus pandang */
  table.tabel tbody tr{background:var(--surface)}
  table.tabel td:last-child{
    position:sticky;right:0;z-index:2;background:inherit;
    box-shadow:-10px 0 10px -10px rgba(0,0,0,.35);
  }
  table.tabel th:last-child{position:sticky;right:0;z-index:3}
}
```

`background:inherit` pada `<td>` mengambil nilai dari `<tr>`, jadi `.row-alert*` ikut
terwarnai dengan benar tanpa aturan tambahan. Karena itu langkah 2 harus selesai lebih dulu.

**Verifikasi.** Di 390px, tombol Aksi harus terlihat tanpa menggulir mendatar. Gulir tabel
25 baris dan pastikan judul kolom tetap terlihat.

---

## Langkah 6 — U12 Ukuran teks

**Berkas:** `Stylesheet.html`. **Dikerjakan setelah langkah 5** — menaikkan `th` lebih dulu
melebarkan setiap tabel sekitar 14%.

**Perubahan** di dalam `@media(max-width:680px)`:

| Selector | Sekarang | Jadi |
|---|---|---|
| `table.tabel` | 12.5px | 14px |
| `table.tabel th` | 10.5px + uppercase | 12px, **buang `text-transform`** |
| `.kpi-label` | 10.5px + uppercase | 12px, **buang `text-transform`** |
| `.badge` | 10.5px | 11.5px |
| `.app-nav-grup` | 9.5px | 11px |
| `.app-nav-user-email` | 10px | 12px |

Membuang `text-transform:uppercase` mengembalikan siluet ascender-descender yang dipakai
mata mengenali kata, dan efeknya lebih besar daripada menaikkan ukuran 1,5px.

Jangan ubah `.kpi-value` (22–29px) dan `.workspace-title`.

**Verifikasi.** Ukur ulang lebar tabel di 390px; kenaikannya harus tertahan oleh kolom
lengket dari langkah 5.

---

## Di luar cakupan perintah kerja ini

U8 jenis input, U11 cincin fokus, U14 stepper, U15 `keAtas()`, U16 jarak COPE, U17 ikon tutup,
U18 kunci gulir modal, U19 `inert` sidebar, U20 hapus CSS mati. Semuanya sudah terlokalisasi
di `AUDIT-UIUX.md` sehingga tidak perlu diaudit ulang.

Menaikkan target sentuh ke 44px tetap dicoret: seluruhnya sudah lolos SC 2.5.8 Level AA.
