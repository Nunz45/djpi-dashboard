// cek-template.mjs — penjaga sebelum `clasp push`.
//
// Mesin template HtmlService mengurai teks MENTAH berkas .html sebelum
// JavaScript apa pun berjalan. Sintaks scriptlet yang ditulis di dalam komentar
// JS, komentar HTML, atau string tetap dieksekusi. Sekali terjadi, doGet gagal
// pada t.evaluate() dan SELURUH halaman berhenti terbit, termasuk layar login
// admin — tanpa petunjuk selain nomor baris di Code.js.
//
// Jalankan:  node cek-template.mjs
import fs from 'fs';

const BERKAS = ['Dashboard.html', 'Pengelola.html', 'Masuk.html',
                'Komponen.html', 'JavaScript.html', 'Stylesheet.html', 'Landing.html'];

const BUKA = '<' + '?';
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

/**
 * Satu lintasan kiri-ke-kanan. Kutip dan komentar JavaScript hanya dilacak di
 * dalam blok script: di luar itu, tanda kutip adalah pembatas atribut HTML dan
 * garis miring ganda adalah bagian dari URL, bukan awal komentar.
 *
 * Baris yang memuat scriptlet tetapi TIDAK tercatat aman berarti scriptletnya
 * berada di dalam komentar atau string — dan tetap akan dieksekusi.
 */
function periksa(teks) {
  const aman = new Set();
  let i = 0, baris = 1;
  let str = null, komenBaris = false, komenBlok = false, komenHtml = false;
  let dalamSkrip = false;

  while (i < teks.length) {
    const c = teks[i], d = teks[i + 1];
    if (c === NL) { baris++; komenBaris = false; i++; continue; }

    if (str) {
      if (c === BS) { i += 2; continue; }
      if (c === str) str = null;
      i++; continue;
    }
    if (komenBaris) { i++; continue; }
    if (komenBlok) { if (c === '*' && d === '/') { komenBlok = false; i += 2; continue; } i++; continue; }
    if (komenHtml) { if (teks.startsWith('-->', i)) { komenHtml = false; i += 3; continue; } i++; continue; }

    if (teks.startsWith(BUKA, i)) { aman.add(baris); i += 2; continue; }

    if (teks.startsWith('<script', i)) { dalamSkrip = true; i += 7; continue; }
    if (teks.startsWith('</script', i)) { dalamSkrip = false; i += 8; continue; }
    if (teks.startsWith('<!--', i)) { komenHtml = true; i += 4; continue; }

    if (dalamSkrip) {
      if (c === '/' && d === '/') { komenBaris = true; i += 2; continue; }
      if (c === '/' && d === '*') { komenBlok = true; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { str = c; i++; continue; }
    }
    i++;
  }

  const semua = [];
  let p = teks.indexOf(BUKA);
  while (p !== -1) {
    semua.push(teks.slice(0, p).split(NL).length);
    p = teks.indexOf(BUKA, p + 2);
  }
  return { total: semua.length, bahaya: [...new Set(semua.filter(b => !aman.has(b)))] };
}

let masalah = 0, total = 0, diperiksa = 0;
for (const f of BERKAS) {
  if (!fs.existsSync(f)) continue;
  diperiksa++;
  const teks = fs.readFileSync(f, 'utf8');
  const baris = teks.split(NL);
  const r = periksa(teks);
  total += r.total;
  for (const b of r.bahaya) {
    console.error(`  ${f}:${b}  scriptlet di dalam komentar atau string -> TETAP DIEKSEKUSI`);
    console.error(`      ${(baris[b - 1] || '').trim().slice(0, 96)}`);
    masalah++;
  }
}

console.log(`${total} scriptlet diperiksa di ${diperiksa} berkas.`);
if (masalah) {
  console.error(NL + `${masalah} masalah. JANGAN push sebelum diperbaiki.`);
  process.exit(1);
}
console.log('Semua scriptlet berada di posisi yang benar.');
