/**
 * Fonctions pures de l'interface : routage hash, regroupement par jour, humeur,
 * libellés et formats de date. Aucune dépendance aux services → testables seules.
 */
import type { DayKey, LocalEntry, LocalSynthesis, Mood, SyncStatus } from '../lib/types';
import { addDays, parseDayKey, timeHHmm } from '../lib/util';

/* ------------------------------------------------------------------ */
/* Routage                                                             */
/* ------------------------------------------------------------------ */

export type Route =
  | { name: 'today' }
  | { name: 'journal' }
  | { name: 'day'; day: DayKey }
  | { name: 'entry'; id: string }
  | { name: 'settings' };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const d = parseDayKey(day);
  return !Number.isNaN(d.getTime()) && d.getDate() === Number(day.slice(8, 10));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** '#/jour/2026-10-08' → { name: 'day', day: '2026-10-08' } ; inconnu → Aujourd'hui. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const [head = '', ...rest] = path.split('/');
  const arg = rest.join('/');
  switch (head) {
    case 'journal':
      return { name: 'journal' };
    case 'reglages':
      return { name: 'settings' };
    case 'jour':
      return isValidDay(arg) ? { name: 'day', day: arg } : { name: 'journal' };
    case 'entree':
      return arg ? { name: 'entry', id: safeDecode(arg) } : { name: 'today' };
    default:
      return { name: 'today' };
  }
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'today':
      return '#/';
    case 'journal':
      return '#/journal';
    case 'settings':
      return '#/reglages';
    case 'day':
      return hrefDay(route.day);
    case 'entry':
      return hrefEntry(route.id);
  }
}

export function hrefDay(day: DayKey): string {
  return `#/jour/${day}`;
}

export function hrefEntry(id: string): string {
  return `#/entree/${encodeURIComponent(id)}`;
}

/* ------------------------------------------------------------------ */
/* Humeur                                                              */
/* ------------------------------------------------------------------ */

export type MoodScore = Mood['score'];

const MOOD_EMOJI: Record<MoodScore, string> = { [-2]: '😞', [-1]: '🙁', 0: '😐', 1: '🙂', 2: '😄' };
const MOOD_WORD: Record<MoodScore, string> = {
  [-2]: 'très mal',
  [-1]: 'pas terrible',
  0: 'neutre',
  1: 'bien',
  2: 'très bien',
};

/** Arrondit et borne un score quelconque dans -2..2. */
export function toMoodScore(n: number): MoodScore {
  const r = Math.max(-2, Math.min(2, Math.round(n)));
  return (Object.is(r, -0) ? 0 : r) as MoodScore;
}

export function moodEmoji(score: number): string {
  return MOOD_EMOJI[toMoodScore(score)];
}

/** Libellé générique d'un score (quand Gemini n'en fournit pas). */
export function moodWord(score: number): string {
  return MOOD_WORD[toMoodScore(score)];
}

/* ------------------------------------------------------------------ */
/* Regroupement par jour                                               */
/* ------------------------------------------------------------------ */

export interface DayGroup {
  day: DayKey;
  /** Ordre chronologique (matin → soir). */
  entries: LocalEntry[];
  synthesis?: LocalSynthesis;
}

/** Jours (récent → ancien) ; entrées de chaque jour dans l'ordre chronologique. */
export function groupDays(
  entries: readonly LocalEntry[],
  syntheses: Readonly<Record<DayKey, LocalSynthesis>>,
): DayGroup[] {
  const map = new Map<DayKey, DayGroup>();
  for (const e of entries) {
    let g = map.get(e.day);
    if (!g) {
      g = { day: e.day, entries: [] };
      map.set(e.day, g);
    }
    g.entries.push(e);
  }
  for (const s of Object.values(syntheses)) {
    const g = map.get(s.day);
    if (g) g.synthesis = s;
    else map.set(s.day, { day: s.day, entries: [], synthesis: s });
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.entries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
  return groups.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** Humeur d'un jour : celle de la synthèse, sinon moyenne des entrées analysées. */
export function dayMoodScore(g: DayGroup): MoodScore | undefined {
  if (g.synthesis) return toMoodScore(g.synthesis.mood.score);
  const scores: number[] = g.entries.flatMap((e) => (e.analysis ? [e.analysis.mood.score] : []));
  if (scores.length === 0) return undefined;
  return toMoodScore(scores.reduce((a, b) => a + b, 0) / scores.length);
}

/**
 * Le jour a-t-il (ou aura-t-il, une fois analysé) du texte à synthétiser ?
 * Faux quand toutes ses entrées sont analysées mais inaudibles (transcription vide) :
 * la synchro n'écrit alors pas de synthèse (même règle que sync.ts).
 */
export function hasSynthesisContent(entries: readonly LocalEntry[]): boolean {
  return entries.some((e) => e.local.needsAnalysis || (!!e.analysis && e.transcript.trim() !== ''));
}

/** Les `n` derniers jours jusqu'à `today` inclus, du plus ancien au plus récent. */
export function lastNDays(today: DayKey, n: number): DayKey[] {
  const out: DayKey[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

/* ------------------------------------------------------------------ */
/* Entrées : libellés et statut                                        */
/* ------------------------------------------------------------------ */

export function entryTitle(e: LocalEntry): string {
  if (e.analysis?.title) return e.analysis.title;
  if (e.local.needsAnalysis) return e.local.error ? 'Analyse impossible' : 'Analyse en cours…';
  if (e.source === 'text' && e.transcript) return truncate(e.transcript, 48);
  return e.source === 'voice' ? 'Mémo vocal' : 'Note';
}

/** Une ligne d'aperçu : résumé, sinon début du texte. */
export function entrySnippet(e: LocalEntry): string {
  if (e.analysis?.summary) return e.analysis.summary;
  if (e.transcript) return truncate(e.transcript, 140);
  return '';
}

export type EntryStatusKind = 'ok' | 'pending' | 'analyzing' | 'unsent' | 'error';

export interface EntryStatusInfo {
  kind: EntryStatusKind;
  label: string;
}

export function entryStatus(
  e: LocalEntry,
  sync: Pick<SyncStatus, 'running' | 'phase'>,
): EntryStatusInfo {
  const l = e.local;
  if (l.needsAnalysis) {
    if (l.error) return { kind: 'error', label: 'Erreur' };
    if (sync.running && sync.phase === 'analyzing') return { kind: 'analyzing', label: 'Analyse…' };
    return { kind: 'pending', label: 'En attente' };
  }
  if (l.dirty || (e.source === 'voice' && l.hasLocalAudio && !e.audioFileId)) {
    return { kind: 'unsent', label: 'Non envoyée' };
  }
  return { kind: 'ok', label: 'Sauvegardée' };
}

/* ------------------------------------------------------------------ */
/* Textes et dates                                                     */
/* ------------------------------------------------------------------ */

export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Découpe une transcription en paragraphes (lignes vides ou retours à la ligne). */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** « 1 entrée », « 3 entrées » (0 et 1 au singulier, comme en français). */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const fmtWeekdayDayMonth = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const fmtFull = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const fmtMonthYear = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
const fmtShortDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });
const fmtWeekdayShort = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' });

/** « Mercredi 8 octobre » (année ajoutée si différente de celle de `today`). */
export function formatDayHeading(day: DayKey, today: DayKey): string {
  const d = parseDayKey(day);
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return capitalize((sameYear ? fmtWeekdayDayMonth : fmtFull).format(d));
}

/** « Aujourd'hui », « Hier », sinon « Lundi 5 octobre ». */
export function relativeDayLabel(day: DayKey, today: DayKey): string {
  if (day === today) return "Aujourd'hui";
  if (day === addDays(today, -1)) return 'Hier';
  return formatDayHeading(day, today);
}

/** « Octobre 2026 » */
export function formatMonth(day: DayKey): string {
  return capitalize(fmtMonthYear.format(parseDayKey(day)));
}

/** « lun. » */
export function formatWeekdayShort(day: DayKey): string {
  return fmtWeekdayShort.format(parseDayKey(day));
}

/** Heure locale 'HH:mm' d'une date ISO. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : timeHHmm(d);
}

/** « à l'instant », « il y a 5 min », « il y a 2 h », « hier à 21:04 », « le 3 octobre à 10:00 ». */
export function formatRelative(iso: string | undefined, now: Date): string {
  if (!iso) return 'jamais';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'jamais';
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return `il y a ${diffMin} min`;
  if (diffMin < 6 * 60) return `il y a ${Math.floor(diffMin / 60)} h`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `aujourd'hui à ${timeHHmm(d)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `hier à ${timeHHmm(d)}`;
  return `le ${fmtShortDate.format(d)} à ${timeHHmm(d)}`;
}

/** « 3:42 » pour une durée en secondes (h:mm:ss au-delà d'une heure). */
export { formatDuration } from '../lib/util';
