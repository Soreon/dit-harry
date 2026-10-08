/**
 * Repères de temps français (« hier », « lundi dernier », « dans trois jours », « le 3 octobre »…)
 * → jours calendaires. Voir docs/SPEC.md §16.
 *
 * Module PUR et déterministe : aucune horloge. La référence est toujours le jour et l'heure de
 * l'ENTRÉE, jamais ceux de l'analyse : une entrée analysée en retard se résout de la même façon.
 * C'est ce code, et non le modèle, qui fixe le jour. La date proposée par le modèle sert
 * seulement à départager (passé ou futur d'un « lundi », côté d'un « ce week-end ») ; le
 * module des mentions s'en sert aussi pour signaler un désaccord.
 */
import type { DayKey } from './types';
import { addDays, parseDayKey } from './util';

/**
 * - sure : un seul jour, sans ambiguïté → rattaché d'office ;
 * - check : un jour, sûr si le modèle est d'accord ou ne donne pas de date (sinon on demande) ;
 * - pick : plusieurs jours, le modèle peut choisir parmi eux (temps du verbe) ; sinon on demande ;
 * - ask : plusieurs jours que le modèle ne peut pas départager (nuit, week-end…) → on demande.
 */
export type WhenCertainty = 'sure' | 'check' | 'pick' | 'ask';

export type WhenResult =
  /** Période floue, jour même, ou repère sans jour précis : rien à rattacher. */
  | { type: 'none' }
  /** Repère non reconnu : seule la date du modèle peut servir, à confirmer. */
  | { type: 'unknown' }
  | { type: 'days'; certainty: WhenCertainty; days: DayKey[] };

/** Fenêtre autorisée autour du jour de l'entrée (en jours). */
export const MAX_PAST_DAYS = 31;
export const MAX_FUTURE_DAYS = 60;
/** Avant cette heure (00:00–03:59), « hier » et « demain » sont ambigus : la journée vécue n'est pas finie. */
export const NIGHT_END_HOUR = 4;

const NONE: WhenResult = { type: 'none' };
const UNKNOWN: WhenResult = { type: 'unknown' };

function result(certainty: WhenCertainty, days: DayKey[]): WhenResult {
  return { type: 'days', certainty, days };
}

/* ------------------------------------------------------------------ */
/* Calendrier                                                          */
/* ------------------------------------------------------------------ */

/** Index JavaScript : 0 = dimanche … 6 = samedi. */
export const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'] as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Jour calendaire existant au format AAAA-MM-JJ ? (« 2026-02-30 » → non) */
export function isDayKey(v: unknown): v is DayKey {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  return makeDay(y ?? 0, m ?? 0, d ?? 0) === v;
}

/** AAAA-MM-JJ si la date existe, sinon null. */
function makeDay(y: number, m: number, d: number): DayKey | null {
  if (!Number.isInteger(y) || y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 0 = dimanche … 6 = samedi. */
export function weekdayOf(day: DayKey): number {
  return parseDayKey(day).getDay();
}

/** Dernière occurrence du jour de semaine `wd` strictement avant `ref` (dit un lundi, « lundi » → 7 jours avant). */
export function previousWeekday(ref: DayKey, wd: number): DayKey {
  return addDays(ref, -((weekdayOf(ref) - wd + 7) % 7 || 7));
}

/** Prochaine occurrence de `wd` strictement après `ref`. */
export function nextWeekday(ref: DayKey, wd: number): DayKey {
  return addDays(ref, (wd - weekdayOf(ref) + 7) % 7 || 7);
}

/** Lundi de la semaine calendaire (lundi → dimanche) de `ref`. */
function mondayOf(ref: DayKey): DayKey {
  return addDays(ref, -((weekdayOf(ref) + 6) % 7));
}

function inWeekOf(monday: DayKey, wd: number): DayKey {
  return addDays(monday, (wd + 6) % 7);
}

/** Samedi et dimanche du dernier week-end terminé (jamais celui qui contient `ref`). */
export function lastWeekend(ref: DayKey): DayKey[] {
  const dow = weekdayOf(ref);
  if (dow === 6) return [addDays(ref, -7), addDays(ref, -6)];
  if (dow === 0) return [addDays(ref, -8), addDays(ref, -7)];
  return [addDays(ref, -(dow + 1)), addDays(ref, -dow)];
}

/** Samedi et dimanche du prochain week-end (jamais celui qui contient `ref`). */
export function nextWeekend(ref: DayKey): DayKey[] {
  const dow = weekdayOf(ref);
  if (dow === 6) return [addDays(ref, 7), addDays(ref, 8)];
  if (dow === 0) return [addDays(ref, 6), addDays(ref, 7)];
  return [addDays(ref, 6 - dow), addDays(ref, 7 - dow)];
}

/** Bornes de la fenêtre d'un jour d'entrée : [R − 31, R + 60]. */
export function windowOf(ref: DayKey): { min: DayKey; max: DayKey } {
  return { min: addDays(ref, -MAX_PAST_DAYS), max: addDays(ref, MAX_FUTURE_DAYS) };
}

/** Jour visable depuis l'entrée du jour `ref` : dans la fenêtre, et autre que `ref` (sauf `allowSame`). */
export function isInWindow(day: DayKey, ref: DayKey, allowSame = false): boolean {
  if (!isDayKey(day)) return false;
  if (day === ref) return allowSame;
  const { min, max } = windowOf(ref);
  return day >= min && day <= max;
}

/* ------------------------------------------------------------------ */
/* Normalisation du texte                                              */
/* ------------------------------------------------------------------ */

const UNITS = new Map<string, number>([
  ['un', 1],
  ['une', 1],
  ['deux', 2],
  ['trois', 3],
  ['quatre', 4],
  ['cinq', 5],
  ['six', 6],
  ['sept', 7],
  ['huit', 8],
  ['neuf', 9],
]);
const TEENS = new Map<string, number>([
  ['dix', 10],
  ['onze', 11],
  ['douze', 12],
  ['treize', 13],
  ['quatorze', 14],
  ['quinze', 15],
  ['seize', 16],
]);
const TENS = new Map<string, number>([
  ['vingt', 20],
  ['trente', 30],
  ['quarante', 40],
  ['cinquante', 50],
  ['soixante', 60],
]);

/** « trois » → 3, « vingt et un » → 21, « dix sept » → 17, « premier » → 1 (mots déjà repliés). */
function wordsToDigits(text: string): string {
  const t = text.split(' ');
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const w = t[i] ?? '';
    const next = t[i + 1] ?? '';
    const tens = TENS.get(w);
    if (tens !== undefined) {
      let n = tens;
      const unit = UNITS.get(next);
      if (next === 'et' && (t[i + 2] === 'un' || t[i + 2] === 'une')) {
        n += 1;
        i += 2;
      } else if (unit !== undefined) {
        n += unit;
        i += 1;
      }
      out.push(String(n));
      continue;
    }
    if (w === 'dix' && (next === 'sept' || next === 'huit' || next === 'neuf')) {
      out.push(String(10 + (UNITS.get(next) ?? 0)));
      i += 1;
      continue;
    }
    const simple = TEENS.get(w) ?? UNITS.get(w) ?? (w === 'premier' || w === 'premiere' ? 1 : undefined);
    out.push(simple !== undefined ? String(simple) : w);
  }
  return out.join(' ');
}

/**
 * Forme repliée d'un repère ou d'un texte : minuscules, sans accents, ponctuation et tirets
 * remplacés par des espaces, « 1er » → « 1 », nombres en lettres convertis en chiffres.
 * Sert à l'analyse ET à l'ancrage dans la transcription (les deux côtés repliés pareil).
 */
export function foldWhen(s: string): string {
  const base = s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(\d)(?:er|ere|eme|e)\b/g, '$1')
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim();
  return base ? wordsToDigits(base) : '';
}

/* ------------------------------------------------------------------ */
/* Grammaire                                                           */
/* ------------------------------------------------------------------ */

const MONTHS = new Map<string, number>([
  ['janvier', 1],
  ['janv', 1],
  ['fevrier', 2],
  ['fevr', 2],
  ['fev', 2],
  ['mars', 3],
  ['avril', 4],
  ['avr', 4],
  ['mai', 5],
  ['juin', 6],
  ['juillet', 7],
  ['juil', 7],
  ['aout', 8],
  ['septembre', 9],
  ['octobre', 10],
  ['oct', 10],
  ['novembre', 11],
  ['nov', 11],
  ['decembre', 12],
  ['dec', 12],
]);

const MONTH_NAMES = [...MONTHS.keys()].join('|');
const MONTH_DATE_RE = new RegExp(`\\b(\\d{1,2}) (${MONTH_NAMES})\\b(?: (\\d{4}))?`);
const SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/;
const WEEKDAY_NAMES = WEEKDAYS.join('|');
const WEEKDAY_RE = new RegExp(`\\b(${WEEKDAY_NAMES})\\b`);
const WEEKEND_RE = /\b(?:week end|weekend)\b/;
const AGO_RE = /\b(?:(?:il )?y a|ca fait) (\d{1,2}) (jours?|semaines?)\b/;
const AHEAD_RE = /\bdans (\d{1,2}) (jours?|semaines?)\b/;
/**
 * Après un nombre : ce n'est pas un jour du mois s'il est suivi d'une unité (« 10 h »,
 * « 18 heures », « 3 jours »…) ou d'un autre nombre (« 10 30 » = 10:30 replié).
 */
const NOT_A_DAY = String.raw`(?! ?(?:h|heures?|minutes?|min|mn|jours?|semaines?|mois|ans?|fois)\b| \d)`;
/** « le 3 » seul (pas « le 10 h », ni « le 3 jours »…). */
const DAY_ALONE_RE = new RegExp(String.raw`\ble (\d{1,2})\b${NOT_A_DAY}`);

/** Jour du mois (pas une heure) ou jour de la semaine : borne d'une période. */
const DAY_BOUND = String.raw`(?:\d{1,2}\b${NOT_A_DAY}|(?:${WEEKDAY_NAMES})\b)`;
/**
 * Périodes de plusieurs jours (« du 3 au 5 octobre », « entre le 3 et le 5 », « entre lundi et
 * mercredi », « de lundi à mercredi ») : rien à rattacher, comme les périodes floues.
 * « entre midi et deux » ou « entre 10 h et 12 h » ne sont pas des périodes de jours.
 */
const RANGE_RES = [
  new RegExp(String.raw`\bdu ${DAY_BOUND}.* au (?:le )?${DAY_BOUND}`),
  new RegExp(String.raw`\bentre (?:(?:le |les )\d{1,2}\b|(?:${WEEKDAY_NAMES})\b).* et (?:le )?${DAY_BOUND}`),
  new RegExp(String.raw`\bde (?:${WEEKDAY_NAMES}) au? (?:${WEEKDAY_NAMES})\b`),
];
/** « les 3 et 4 octobre » → « les 3 octobre et 4 octobre » : le mois vaut pour les deux jours. */
const SHARED_MONTH_RE = new RegExp(String.raw`\b(\d{1,2}) (et|ou) (le )?(\d{1,2}) (${MONTH_NAMES})\b((?: \d{4})?)`, 'g');
/** Alternative (« hier ou avant-hier ») ou énumération (« samedi et dimanche ») de repères. */
const JOIN_RE = / (?:ou|et) /;

/** Jour même, période floue ou repère sans jour précis : jamais rattaché. */
const VAGUE_RE = new RegExp(
  `\\b(?:${[
    'aujourd hui',
    'ce matin',
    'ce midi',
    'cet apres midi',
    'ce soir',
    'cette nuit',
    'la nuit derniere',
    'tout a l heure',
    'tantot',
    'maintenant',
    'a l instant',
    'cette semaine',
    'ce mois',
    'cette annee',
    'l autre jour',
    '1 de ces jours',
    'ces derniers jours',
    'ces jours ci',
    'recemment',
    'dernierement',
    'bientot',
    'prochainement',
    'plus tard',
    'quelques jours',
    'quelques semaines',
    '1 jour',
    'la semaine',
    'le mois',
    'l annee',
    'la veille',
    'le lendemain',
  ].join('|')})\\b`,
);

function hourOf(time: string): number {
  const m = /^(\d{1,2}):\d{2}/.exec(time);
  const h = m?.[1] !== undefined ? Number(m[1]) : Number.NaN;
  return Number.isFinite(h) ? h : 12;
}

function normYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/** Jour « J » du mois précédent, courant et suivant, dans la fenêtre. */
function dayOfMonthCandidates(n: number, ref: DayKey): DayKey[] {
  const y = Number(ref.slice(0, 4));
  const mo = Number(ref.slice(5, 7));
  const out: DayKey[] = [];
  for (const delta of [-1, 0, 1]) {
    let mm = mo + delta;
    let yy = y;
    if (mm < 1) {
      mm = 12;
      yy -= 1;
    } else if (mm > 12) {
      mm = 1;
      yy += 1;
    }
    const d = makeDay(yy, mm, n);
    if (d && isInWindow(d, ref)) out.push(d);
  }
  return out;
}

/** « 3 octobre [2026] », « 3/10[/26] » ; un éventuel jour de la semaine doit concorder. */
function explicitDate(f: string, ref: DayKey): WhenResult | null {
  let candidates: DayKey[] | null = null;
  const md = MONTH_DATE_RE.exec(f);
  const sd = md ? null : SLASH_DATE_RE.exec(f);
  const y0 = Number(ref.slice(0, 4));
  if (md) {
    const month = MONTHS.get(md[2] ?? '') ?? 0;
    const years = md[3] ? [Number(md[3])] : [y0 - 1, y0, y0 + 1];
    candidates = years.map((y) => makeDay(y, month, Number(md[1]))).filter((d): d is DayKey => d !== null);
  } else if (sd) {
    const years = sd[3] ? [normYear(Number(sd[3]))] : [y0 - 1, y0, y0 + 1];
    candidates = years
      .map((y) => makeDay(y, Number(sd[2]), Number(sd[1])))
      .filter((d): d is DayKey => d !== null);
  }
  if (!candidates) return null;
  const inWindow = candidates.filter((d) => isInWindow(d, ref));
  // Jour même (« le 8 octobre » dit le 8) ou hors de la fenêtre : rien à rattacher.
  if (inWindow.length === 0) return NONE;
  const wd = WEEKDAY_RE.exec(f)?.[1];
  if (wd !== undefined) {
    const fit = inWindow.filter((d) => WEEKDAYS[weekdayOf(d)] === wd);
    // « lundi 6 octobre » alors que le 6 est un mardi : on demande.
    if (fit.length === 0) return result('ask', inWindow);
    return result(fit.length === 1 ? 'sure' : 'pick', fit);
  }
  return result(inWindow.length === 1 ? 'sure' : 'pick', inWindow);
}

/** « hier », « demain »… ; la nuit (avant 4 h), deux jours possibles. */
function relative(ref: DayKey, delta: number, night: boolean): WhenResult {
  if (!night) return result('sure', [addDays(ref, delta)]);
  return delta < 0
    ? result('ask', [addDays(ref, delta), addDays(ref, delta - 1)])
    : result('ask', [addDays(ref, delta - 1), addDays(ref, delta)]);
}

/** « il y a N jours / semaines » (sign = -1) ou « dans N jours / semaines » (sign = +1). */
function offset(n: number, unit: string, sign: 1 | -1, ref: DayKey, night: boolean): WhenResult {
  if (n < 1) return NONE;
  if (unit.startsWith('semaine')) {
    if (n > 8) return NONE;
    // « une semaine » : 7 jours le plus souvent, parfois 8 → sûr seulement si le modèle concorde.
    return result('check', [addDays(ref, sign * 7 * n), addDays(ref, sign * (7 * n + 1))]);
  }
  // « huit jours » = une semaine, « quinze jours » = deux semaines (au jour près).
  if (n === 8) return result('check', [addDays(ref, sign * 7), addDays(ref, sign * 8)]);
  if (n === 15) return result('check', [addDays(ref, sign * 14), addDays(ref, sign * 15)]);
  return relative(ref, sign * n, night);
}

/** « le week-end dernier », « ce week-end », « le week-end prochain ». */
function weekend(f: string, ref: DayKey, modelDay: DayKey | undefined): WhenResult {
  if (/\b(?:dernier|passe)\b/.test(f)) return result('ask', lastWeekend(ref));
  if (/\bprochain\b/.test(f)) return result('ask', nextWeekend(ref));
  const dow = weekdayOf(ref);
  // Dit un samedi ou un dimanche : le week-end en cours contient le jour même.
  if (dow === 6 || dow === 0) return NONE;
  const past = lastWeekend(ref);
  const next = nextWeekend(ref);
  if (modelDay && past.includes(modelDay)) return result('ask', past);
  if (modelDay && next.includes(modelDay)) return result('ask', next);
  // Sans indice du modèle : du lundi au mercredi, celui qui vient de passer ; sinon le prochain.
  return result('ask', dow <= 3 ? past : next);
}

/** « lundi », « lundi dernier », « lundi prochain », « lundi de la semaine dernière », « lundi en huit ». */
function weekday(f: string, name: string, ref: DayKey): WhenResult {
  const wd = WEEKDAYS.indexOf(name as (typeof WEEKDAYS)[number]);
  // « lundi 5 », « lundi le 5 » ; pas « mardi 10 h » ni « dimanche 18 heures » (une heure).
  const num = new RegExp(String.raw`\b${name} (?:le )?(\d{1,2})\b${NOT_A_DAY}`).exec(f);
  if (num) {
    const all = dayOfMonthCandidates(Number(num[1]), ref);
    const fit = all.filter((d) => weekdayOf(d) === wd);
    if (fit.length === 1) return result('sure', fit);
    if (fit.length > 1) return result('pick', fit);
    return all.length > 0 ? result('ask', all) : NONE;
  }
  if (/\bsemaine (?:derniere|passee)\b/.test(f)) return result('sure', [inWeekOf(addDays(mondayOf(ref), -7), wd)]);
  if (/\bsemaine prochaine\b/.test(f)) return result('sure', [inWeekOf(addDays(mondayOf(ref), 7), wd)]);
  if (/\ben 8\b/.test(f)) return result('sure', [addDays(nextWeekday(ref, wd), 7)]);
  if (/\b(?:dernier|passe)\b/.test(f)) return result('check', [previousWeekday(ref, wd)]);
  if (/\b(?:prochain|qui vient)\b/.test(f)) {
    const next = nextWeekday(ref, wd);
    // Dans la semaine en cours (« samedi prochain » dit un jeudi) : celui-ci ou le suivant ?
    return next > addDays(mondayOf(ref), 6) ? result('check', [next]) : result('ask', [next, addDays(next, 7)]);
  }
  // « lundi » seul : passé ou à venir, selon le temps du verbe (le modèle départage).
  return result('pick', [previousWeekday(ref, wd), nextWeekday(ref, wd)]);
}

/**
 * Repère de temps → jours possibles, par rapport au jour `ref` et à l'heure `time` ('HH:mm') de
 * l'entrée. `modelDay` (date déjà validée du modèle) ne sert qu'à choisir un côté : celui d'un
 * « ce week-end », ou passé / à venir dans une alternative (« lundi ou mardi »). La fenêtre
 * ([R − 31, R + 60]) est appliquée ensuite par l'appelant, sauf pour les dates explicites
 * (l'année se déduit de la fenêtre).
 */
export function parseFrenchWhen(when: string, ref: DayKey, time = '12:00', modelDay?: DayKey): WhenResult {
  const f = foldWhen(when).replace(SHARED_MONTH_RE, '$1 $5$6 $2 $3$4 $5$6');
  if (!f || !isDayKey(ref)) return NONE;
  const night = hourOf(time) < NIGHT_END_HOUR;
  // Période de plusieurs jours : rien à rattacher.
  if (RANGE_RES.some((re) => re.test(f))) return NONE;
  return alternatives(f, ref, night, modelDay) ?? single(f, ref, night, modelDay);
}

/** Écart en jours entre deux jours (valeur absolue). */
function distance(a: DayKey, b: DayKey): number {
  return Math.abs(Math.round((parseDayKey(a).getTime() - parseDayKey(b).getTime()) / 86_400_000));
}

/**
 * « hier ou avant-hier », « samedi et dimanche », « les 3 et 4 octobre » : plusieurs jours, on
 * demande (jamais rattaché d'office). Dans une énumération (« et »), un repère qui n'est pas un
 * autre jour (« hier soir et ce matin ») est ignoré ; dans une alternative (« ou »), il laisse le
 * choix ouvert (« ce soir ou demain » → on demande). null : un seul repère.
 */
function alternatives(f: string, ref: DayKey, night: boolean, modelDay: DayKey | undefined): WhenResult | null {
  const parts = f.split(JOIN_RE).filter(Boolean);
  if (parts.length < 2) return null;
  const results = parts.map((p) => single(p, ref, night, modelDay));
  const found = results.filter((r): r is Extract<WhenResult, { type: 'days' }> => r.type === 'days');
  if (found.length === 0) return results.some((r) => r.type === 'unknown') ? UNKNOWN : NONE;
  const open = / ou /.test(f) && results.some((r) => r.type === 'none');
  const days: DayKey[] = [];
  for (const r of found) {
    let list = r.days;
    // « lundi ou mardi » : le temps du verbe (via la date du modèle) choisit passé ou à venir.
    if (r.certainty === 'pick' && modelDay) {
      const side = list.filter((d) => d < ref === modelDay < ref);
      if (side.length > 0) list = side;
    }
    for (const d of list) if (!days.includes(d)) days.push(d);
  }
  const [first] = found;
  // Un seul jour en jeu (« hier soir et ce matin », « hier ou hier soir ») : le repère tel quel.
  if (first && !open && (found.length === 1 || days.length === 1)) return first;
  // Les 3 jours les plus proches, dans l'ordre du calendrier.
  const nearest = [...days].sort((a, b) => distance(a, ref) - distance(b, ref)).slice(0, 3);
  return result('ask', nearest.sort());
}

/** Un seul repère (sans « ou » ni « et »). */
function single(f: string, ref: DayKey, night: boolean, modelDay: DayKey | undefined): WhenResult {
  const date = explicitDate(f, ref);
  if (date) return date;

  if (/\bavant avant hier\b/.test(f)) return relative(ref, -3, night);
  if (/\bavant hier\b/.test(f)) return relative(ref, -2, night);
  if (/\bapres demain\b/.test(f)) return relative(ref, 2, night);
  if (/\bhier\b/.test(f)) return relative(ref, -1, night);
  if (/\bdemain\b/.test(f)) return relative(ref, 1, night);

  const ago = AGO_RE.exec(f);
  if (ago) return offset(Number(ago[1]), ago[2] ?? '', -1, ref, night);
  const ahead = AHEAD_RE.exec(f);
  if (ahead) return offset(Number(ahead[1]), ahead[2] ?? '', 1, ref, night);

  if (WEEKEND_RE.test(f)) return weekend(f, ref, modelDay);

  const wd = WEEKDAY_RE.exec(f)?.[1];
  if (wd !== undefined) return weekday(f, wd, ref);

  const alone = DAY_ALONE_RE.exec(f);
  if (alone) {
    const c = dayOfMonthCandidates(Number(alone[1]), ref);
    // « le 3 » : ce mois-ci ou le suivant (ou le précédent) → sûr seulement si le modèle concorde.
    return c.length > 0 ? result('pick', c) : NONE;
  }

  if (VAGUE_RE.test(f)) return NONE;
  return UNKNOWN;
}
