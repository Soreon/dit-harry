#!/usr/bin/env node
/**
 * Génère les icônes de Dit Harry, sans dépendance :
 *   public/icons/icon-192.png, icon-512.png, icon-maskable-512.png, icon.svg
 *
 * Dessin : carré arrondi terracotta, micro crème posé sur un livre ouvert, avec deux ondes
 * de voix de chaque côté. Les PNG sont rendus par champs de distance signée (anti-crénelage
 * analytique) et encodés à la main (zlib + CRC32) ; le SVG reprend exactement la même géométrie.
 *
 * Usage : npm run icons   (option : --preview=<dossier> pour écrire aussi des aperçus 48 px)
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'icons');

const BG = '#c8553d'; // terracotta
const FG = '#f6f1e9'; // crème

/* ------------------------------------------------------------------ */
/* Géométrie (unités : carré de 100 × 100, y vers le bas)              */
/* ------------------------------------------------------------------ */

const deg = (d) => (d * Math.PI) / 180;

const G = {
  /** Corps du micro : segment vertical épaissi (gélule). */
  capsule: { x: 50, y1: 30, y2: 44, r: 11 },
  /** Support en U autour du bas du micro. */
  holder: { cx: 50, cy: 44, R: 18, w: 5, from: -15, to: 195 },
  /** Pied. */
  stem: { x: 50, y1: 64.5, y2: 72, w: 5 },
  /** Ondes de voix, centrées sur le micro, de part et d'autre. */
  waves: [
    { cx: 50, cy: 37, R: 29, w: 4.5, span: 26 },
    { cx: 50, cy: 37, R: 38, w: 4.5, span: 20 },
  ],
  /**
   * Livre ouvert : deux pages dont les bords haut et bas sont des courbes de Bézier
   * quadratiques (la page se soulève près de la reliure). Page droite = symétrique.
   */
  page: {
    spineTop: [47.5, 77],
    ctrlTop: [38, 70.5],
    outerTop: [24, 72.5],
    outerBottom: [24, 81],
    ctrlBottom: [38, 79],
    spineBottom: [47.5, 85.5],
  },
  pageRound: 0.9,
  /** Centre visuel du dessin (pour la mise à l'échelle). */
  center: { x: 50, y: 51.5 },
};

/** Variantes : échelle du dessin et forme du fond. */
const VARIANTS = {
  // Icône « any » : fond carré arrondi, dessin à 92 %.
  any: { scale: 0.92, cornerRadius: 22 },
  // Icône « maskable » : fond plein cadre ; tout le dessin tient dans le cercle de sécurité (rayon 40).
  maskable: { scale: 0.8, cornerRadius: 0 },
};

/* ------------------------------------------------------------------ */
/* Champs de distance signée                                           */
/* ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Distance à un arc de cercle (angles en degrés, sens croissant, y vers le bas). */
function sdArc(px, py, cx, cy, R, fromDeg, toDeg) {
  const dx = px - cx;
  const dy = py - cy;
  const a0 = deg(fromDeg);
  const a1 = deg(toDeg);
  let a = Math.atan2(dy, dx);
  while (a < a0) a += 2 * Math.PI;
  while (a >= a0 + 2 * Math.PI) a -= 2 * Math.PI;
  if (a <= a1) return Math.abs(Math.hypot(dx, dy) - R);
  const d0 = Math.hypot(px - (cx + R * Math.cos(a0)), py - (cy + R * Math.sin(a0)));
  const d1 = Math.hypot(px - (cx + R * Math.cos(a1)), py - (cy + R * Math.sin(a1)));
  return Math.min(d0, d1);
}

/** Polygone quelconque (Inigo Quilez). Négatif à l'intérieur. */
function sdPolygon(px, py, v) {
  const first = v[0];
  let d = (px - first[0]) ** 2 + (py - first[1]) ** 2;
  let s = 1;
  for (let i = 0, j = v.length - 1; i < v.length; j = i, i++) {
    const [vix, viy] = v[i];
    const [vjx, vjy] = v[j];
    const ex = vjx - vix;
    const ey = vjy - viy;
    const wx = px - vix;
    const wy = py - viy;
    const h = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * h;
    const by = wy - ey * h;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= viy;
    const c2 = py < vjy;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

function sdRoundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const mirror = ([x, y]) => [100 - x, y];

/** Les deux pages (gauche, droite) sous forme de chemins : 4 points + 2 points de contrôle. */
function pageShapes() {
  const p = G.page;
  const right = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, mirror(v)]));
  return [p, right];
}

function quad(a, c, b, t) {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

/** Page → polygone (bords courbes échantillonnés). */
function pagePolygon(p, steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(quad(p.spineTop, p.ctrlTop, p.outerTop, i / steps));
  for (let i = 0; i <= steps; i++) pts.push(quad(p.outerBottom, p.ctrlBottom, p.spineBottom, i / steps));
  return pts;
}

const PAGE_POLYGONS = pageShapes().map((p) => pagePolygon(p));

/** Distance au dessin crème (union de toutes les formes), en unités du dessin. */
function sdArtwork(x, y) {
  const { capsule: c, holder: h, stem: st } = G;
  let d = sdSegment(x, y, c.x, c.y1, c.x, c.y2) - c.r;
  d = Math.min(d, sdArc(x, y, h.cx, h.cy, h.R, h.from, h.to) - h.w / 2);
  d = Math.min(d, sdSegment(x, y, st.x, st.y1, st.x, st.y2) - st.w / 2);
  for (const w of G.waves) {
    d = Math.min(d, sdArc(x, y, w.cx, w.cy, w.R, -w.span, w.span) - w.w / 2);
    d = Math.min(d, sdArc(x, y, w.cx, w.cy, w.R, 180 - w.span, 180 + w.span) - w.w / 2);
  }
  for (const p of PAGE_POLYGONS) d = Math.min(d, sdPolygon(x, y, p) - G.pageRound);
  return d;
}

/* ------------------------------------------------------------------ */
/* Rendu PNG                                                           */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function render(size, variant) {
  const { scale, cornerRadius } = VARIANTS[variant];
  const bg = hexToRgb(BG);
  const fg = hexToRgb(FG);
  const px = 100 / size; // taille d'un pixel en unités du cadre
  const pxArt = px / scale; // … et en unités du dessin
  const rgba = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * px;
      const y = (j + 0.5) * px;
      const bgCov =
        cornerRadius > 0 ? clamp(0.5 - sdRoundBox(x, y, 50, 50, 50, 50, cornerRadius) / px, 0, 1) : 1;
      const ax = (x - 50) / scale + G.center.x;
      const ay = (y - 50) / scale + G.center.y;
      const fgCov = clamp(0.5 - sdArtwork(ax, ay) / pxArt, 0, 1);
      const o = (j * size + i) * 4;
      for (let k = 0; k < 3; k++) rgba[o + k] = Math.round(bg[k] + (fg[k] - bg[k]) * fgCov);
      rgba[o + 3] = Math.round(bgCov * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression deflate
  ihdr[11] = 0; // filtrage standard
  ihdr[12] = 0; // pas d'entrelacement
  // Chaque ligne : octet de filtre 0 (aucun) + pixels.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* SVG (même géométrie)                                                */
/* ------------------------------------------------------------------ */

const f = (n) => Number(n.toFixed(2)).toString();

function arcPath(cx, cy, R, fromDeg, toDeg) {
  const x0 = cx + R * Math.cos(deg(fromDeg));
  const y0 = cy + R * Math.sin(deg(fromDeg));
  const x1 = cx + R * Math.cos(deg(toDeg));
  const y1 = cy + R * Math.sin(deg(toDeg));
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M${f(x0)} ${f(y0)}A${f(R)} ${f(R)} 0 ${large} 1 ${f(x1)} ${f(y1)}`;
}

function buildSvg() {
  const { scale, cornerRadius } = VARIANTS.any;
  const { capsule: c, holder: h, stem: st } = G;
  const strokes = [
    `<path d="${arcPath(h.cx, h.cy, h.R, h.from, h.to)}" stroke-width="${f(h.w)}"/>`,
    `<path d="M${f(st.x)} ${f(st.y1)}V${f(st.y2)}" stroke-width="${f(st.w)}"/>`,
    ...G.waves.flatMap((w) => [
      `<path d="${arcPath(w.cx, w.cy, w.R, -w.span, w.span)}" stroke-width="${f(w.w)}"/>`,
      `<path d="${arcPath(w.cx, w.cy, w.R, 180 - w.span, 180 + w.span)}" stroke-width="${f(w.w)}"/>`,
    ]),
  ];
  const pt = ([x, y]) => `${f(x)} ${f(y)}`;
  const pages = pageShapes().map(
    (p) =>
      `<path d="M${pt(p.spineTop)}Q${pt(p.ctrlTop)} ${pt(p.outerTop)}L${pt(p.outerBottom)}` +
      `Q${pt(p.ctrlBottom)} ${pt(p.spineBottom)}Z"/>`,
  );
  const t = `translate(50 50) scale(${scale}) translate(${f(-G.center.x)} ${f(-G.center.y)})`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">',
    '<title>Dit Harry</title>',
    `<rect width="100" height="100" rx="${cornerRadius}" fill="${BG}"/>`,
    `<g transform="${t}" fill="${FG}">`,
    `<rect x="${f(c.x - c.r)}" y="${f(c.y1 - c.r)}" width="${f(2 * c.r)}" height="${f(c.y2 - c.y1 + 2 * c.r)}" rx="${f(c.r)}"/>`,
    `<g fill="none" stroke="${FG}" stroke-linecap="round">`,
    ...strokes,
    '</g>',
    `<g stroke="${FG}" stroke-width="${f(2 * G.pageRound)}" stroke-linejoin="round">`,
    ...pages,
    '</g>',
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Sortie                                                              */
/* ------------------------------------------------------------------ */

function writePng(dir, name, size, variant) {
  const file = join(dir, name);
  writeFileSync(file, encodePng(size, render(size, variant)));
  console.log(`  ${file}`);
}

mkdirSync(OUT_DIR, { recursive: true });
console.log('Icônes Dit Harry :');
writePng(OUT_DIR, 'icon-192.png', 192, 'any');
writePng(OUT_DIR, 'icon-512.png', 512, 'any');
writePng(OUT_DIR, 'icon-maskable-512.png', 512, 'maskable');
writeFileSync(join(OUT_DIR, 'icon.svg'), buildSvg());
console.log(`  ${join(OUT_DIR, 'icon.svg')}`);

const previewArg = process.argv.find((a) => a.startsWith('--preview='));
if (previewArg) {
  const dir = resolve(previewArg.slice('--preview='.length));
  mkdirSync(dir, { recursive: true });
  writePng(dir, 'preview-48.png', 48, 'any');
  writePng(dir, 'preview-maskable-48.png', 48, 'maskable');
  writePng(dir, 'preview-96.png', 96, 'any');
}
