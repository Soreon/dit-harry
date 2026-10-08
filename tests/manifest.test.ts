import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * public/manifest.webmanifest : règles de Chrome pour l'installation et sa fenêtre enrichie
 * (captures d'écran), et identité de l'appli installée.
 */

interface ManifestImage {
  src: string;
  sizes: string;
  type?: string;
  form_factor?: string;
  label?: string;
}

const PUBLIC = new URL('../public/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', PUBLIC), 'utf8')) as {
  id?: string;
  start_url: string;
  scope: string;
  description?: string;
  icons: ManifestImage[];
  screenshots?: ManifestImage[];
};

/** Largeur × hauteur réelles d'un PNG (en-tête IHDR). */
function pngSize(file: URL): { width: number; height: number } {
  const b = readFileSync(file);
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(b.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function parseSizes(sizes: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(sizes);
  expect(m, `sizes « ${sizes} »`).not.toBeNull();
  return { width: Number(m?.[1]), height: Number(m?.[2]) };
}

describe('manifest.webmanifest', () => {
  it('URLs relatives au dossier du site (sous-chemin GitHub Pages)', () => {
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
  });

  it('pas d’id relatif : il serait résolu contre l’ORIGINE et changerait l’identité de l’appli', () => {
    // L'id est ajouté au build (vite.config.ts) à partir de `base`.
    if (manifest.id !== undefined) expect(manifest.id.startsWith('/')).toBe(true);
  });

  it('icônes PNG 192 et 512 présentes, tailles conformes', () => {
    const png = manifest.icons.filter((i) => i.type === 'image/png');
    expect(png.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of png) {
      expect(pngSize(new URL(icon.src, PUBLIC))).toEqual(parseSizes(icon.sizes));
    }
  });

  it('fenêtre d’installation enrichie (Android) : description et captures « narrow »', () => {
    expect(manifest.description?.trim()).toBeTruthy();
    const shots = manifest.screenshots ?? [];
    const narrow = shots.filter((s) => s.form_factor === 'narrow' || s.form_factor === undefined);
    expect(narrow.length).toBeGreaterThanOrEqual(1);
    const ratios = new Set<string>();
    for (const s of shots) {
      const file = new URL(s.src, PUBLIC);
      expect(existsSync(file), s.src).toBe(true);
      expect(s.type).toBe('image/png');
      expect(s.label?.trim(), `label de ${s.src}`).toBeTruthy();
      const declared = parseSizes(s.sizes);
      expect(pngSize(file), s.src).toEqual(declared);
      const { width, height } = declared;
      // Règles de Chrome : 320 à 3840 px par côté, rapport ≤ 2,3
      for (const side of [width, height]) {
        expect(side).toBeGreaterThanOrEqual(320);
        expect(side).toBeLessThanOrEqual(3840);
      }
      expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(2.3);
      if (s.form_factor === 'narrow') {
        expect(height).toBeGreaterThan(width);
        ratios.add((width / height).toFixed(4));
      }
    }
    // Toutes les captures d'un même format ont le même rapport largeur/hauteur
    expect(ratios.size).toBeLessThanOrEqual(1);
  });
});
