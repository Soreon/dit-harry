import type { DayKey, Entry } from './types';

/** Identifiant unique (UUID v4). */
export function newId(): string {
  return crypto.randomUUID();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Jour calendaire LOCAL 'YYYY-MM-DD'. */
export function dayKey(d: Date = new Date()): DayKey {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Heure locale 'HH:mm'. */
export function timeHHmm(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** DayKey → Date locale à minuit. */
export function parseDayKey(day: DayKey): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Décale un jour de `delta` jours (gère les changements d'heure). */
export function addDays(day: DayKey, delta: number): DayKey {
  const d = parseDayKey(day);
  d.setDate(d.getDate() + delta);
  return dayKey(d);
}

const dayFmt = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** 'jeudi 8 octobre 2026' */
export function formatDayFr(day: DayKey): string {
  return dayFmt.format(parseDayKey(day));
}

/** 'Jeudi 8 octobre 2026' */
export function formatDayFrTitle(day: DayKey): string {
  const s = formatDayFr(day);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Durée 'm:ss' ou 'h:mm:ss'. */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/** 'audio/webm;codecs=opus' → 'audio/webm' */
export function stripMimeParams(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/** Extension de fichier pour un MIME audio. */
export function audioExtension(mime: string): string {
  switch (stripMimeParams(mime)) {
    case 'audio/webm':
      return 'webm';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    default:
      return 'bin';
  }
}

/** Hash FNV-1a 32 bits, en hexadécimal. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Signature stable d'un ensemble d'entrées (ordre indifférent). */
export function entriesSignature(entries: Pick<Entry, 'id' | 'updatedAt'>[]): string {
  const parts = entries.map((e) => `${e.id}:${e.updatedAt}`).sort();
  return `${entries.length}-${fnv1a(parts.join('|'))}`;
}

/** Blob → base64 (sans préfixe data:). Fonctionne en navigateur et sous Node. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Tri : plus récent d'abord. */
export function byCreatedDesc<T extends { createdAt: string }>(a: T, b: T): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}
