import { describe, expect, it } from 'vitest';
import {
  dayMoodScore,
  entrySnippet,
  entryStatus,
  entryTitle,
  formatDayHeading,
  formatDayLong,
  formatDayShort,
  formatRelative,
  groupDays,
  hasSynthesisContent,
  hrefDay,
  hrefEntry,
  lastNDays,
  linksOfKind,
  moodEmoji,
  parseRoute,
  plural,
  relativeDayLabel,
  routeHash,
  saidAt,
  sameScreen,
  splitParagraphs,
  toMoodScore,
  truncate,
} from '../src/components/helpers';
import type { DayLink, EntryAnalysis, LocalEntry, LocalSynthesis, SyncStatus } from '../src/lib/types';

function entry(over: Partial<LocalEntry> & { id: string; createdAt: string }): LocalEntry {
  return {
    day: over.createdAt.slice(0, 10),
    updatedAt: over.createdAt,
    source: 'voice',
    transcript: '',
    ...over,
    local: { dirty: false, needsAnalysis: false, hasLocalAudio: false, attempts: 0, ...over.local },
  };
}

function analysis(score: EntryAnalysis['mood']['score'], title = 'Titre'): EntryAnalysis {
  return {
    title,
    summary: `Résumé ${title}`,
    mood: { score, label: 'x' },
    themes: [],
    people: [],
    places: [],
    todos: [],
  };
}

function synthesis(day: string, score: LocalSynthesis['mood']['score']): LocalSynthesis {
  return {
    day,
    generatedAt: `${day}T23:00:00.000Z`,
    model: 'm',
    basedOn: 'sig',
    summary: 'Journée',
    mood: { score, label: 'y' },
    highlights: [],
    themes: [],
    todos: [],
    local: { dirty: false },
  };
}

const idle: Pick<SyncStatus, 'running' | 'phase'> = { running: false, phase: 'idle' };

describe('parseRoute / routeHash', () => {
  it('reconnaît les routes connues', () => {
    expect(parseRoute('')).toEqual({ name: 'today' });
    expect(parseRoute('#/')).toEqual({ name: 'today' });
    expect(parseRoute('#/journal')).toEqual({ name: 'journal' });
    expect(parseRoute('#/journal/')).toEqual({ name: 'journal' });
    expect(parseRoute('#/reglages')).toEqual({ name: 'settings' });
    expect(parseRoute('#/jour/2026-10-08')).toEqual({ name: 'day', day: '2026-10-08' });
    expect(parseRoute('#/entree/abc-123')).toEqual({ name: 'entry', id: 'abc-123' });
  });

  it('rejette les jours invalides et les routes inconnues', () => {
    expect(parseRoute('#/jour/2026-13-40')).toEqual({ name: 'journal' });
    expect(parseRoute('#/jour/2026-02-30')).toEqual({ name: 'journal' });
    expect(parseRoute('#/jour/hier')).toEqual({ name: 'journal' });
    expect(parseRoute('#/entree/')).toEqual({ name: 'today' });
    expect(parseRoute('#/nimporte')).toEqual({ name: 'today' });
  });

  it('fait l’aller-retour avec routeHash, ids encodés', () => {
    const id = 'a b/c';
    expect(hrefEntry(id)).toBe('#/entree/a%20b%2Fc');
    expect(parseRoute(hrefEntry(id))).toEqual({ name: 'entry', id });
    for (const r of [
      { name: 'today' },
      { name: 'journal' },
      { name: 'settings' },
      { name: 'day', day: '2026-01-31' },
      { name: 'entry', id: 'x' },
    ] as const) {
      expect(parseRoute(routeHash(r))).toEqual(r);
    }
  });
});

describe('humeur', () => {
  it('borne et arrondit les scores', () => {
    expect(toMoodScore(5)).toBe(2);
    expect(toMoodScore(-3)).toBe(-2);
    expect(toMoodScore(0.4)).toBe(0);
    expect(Object.is(toMoodScore(-0.4), 0)).toBe(true);
    expect(toMoodScore(1.5)).toBe(2);
  });

  it('associe les emoji', () => {
    expect([-2, -1, 0, 1, 2].map(moodEmoji)).toEqual(['😞', '🙁', '😐', '🙂', '😄']);
  });
});

describe('groupDays / dayMoodScore', () => {
  const e1 = entry({ id: '1', createdAt: '2026-10-07T20:00:00.000Z', day: '2026-10-07', analysis: analysis(2) });
  const e2 = entry({ id: '2', createdAt: '2026-10-07T08:00:00.000Z', day: '2026-10-07', analysis: analysis(-1) });
  const e3 = entry({ id: '3', createdAt: '2026-10-08T09:00:00.000Z', day: '2026-10-08' });

  it('regroupe par jour (récent d’abord), entrées en ordre chronologique', () => {
    const groups = groupDays([e1, e3, e2], { '2026-10-07': synthesis('2026-10-07', 1) });
    expect(groups.map((g) => g.day)).toEqual(['2026-10-08', '2026-10-07']);
    expect(groups[1]?.entries.map((e) => e.id)).toEqual(['2', '1']);
    expect(groups[1]?.synthesis?.day).toBe('2026-10-07');
  });

  it('garde un jour qui n’a qu’une synthèse', () => {
    const groups = groupDays([], { '2026-10-01': synthesis('2026-10-01', 0) });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toEqual([]);
  });

  it('humeur : synthèse prioritaire, sinon moyenne des entrées analysées', () => {
    expect(dayMoodScore({ day: '2026-10-07', entries: [e1, e2], synthesis: synthesis('2026-10-07', -2) })).toBe(-2);
    expect(dayMoodScore({ day: '2026-10-07', entries: [e1, e2] })).toBe(1); // (2 - 1) / 2 = 0,5 → 1
    expect(dayMoodScore({ day: '2026-10-08', entries: [e3] })).toBeUndefined();
  });

  it('lastNDays : du plus ancien à aujourd’hui, à travers les mois', () => {
    const days = lastNDays('2026-10-02', 4);
    expect(days).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(lastNDays('2026-10-08', 30)).toHaveLength(30);
  });
});

describe('hasSynthesisContent', () => {
  const at = '2026-10-07T20:00:00.000Z';
  const inaudible = entry({ id: 'i', createdAt: at, analysis: analysis(0, 'Enregistrement inaudible') });
  it('faux quand toutes les entrées analysées sont inaudibles (ou sans entrée)', () => {
    expect(hasSynthesisContent([])).toBe(false);
    expect(hasSynthesisContent([inaudible])).toBe(false);
  });
  it('vrai dès qu’une entrée a du texte analysé, ou attend son analyse', () => {
    expect(hasSynthesisContent([inaudible, entry({ id: 't', createdAt: at, transcript: 'Bonjour', analysis: analysis(1) })])).toBe(true);
    expect(hasSynthesisContent([inaudible, entry({ id: 'p', createdAt: at, local: { dirty: true, needsAnalysis: true, hasLocalAudio: true, attempts: 0 } })])).toBe(true);
  });
});

describe('libellés et statut des entrées', () => {
  it('titre : analyse, sinon état', () => {
    expect(entryTitle(entry({ id: 'a', createdAt: '2026-10-08T09:00:00Z', analysis: analysis(0, 'Balade') }))).toBe(
      'Balade',
    );
    expect(entryTitle(entry({ id: 'a', createdAt: '2026-10-08T09:00:00Z', local: pending() }))).toBe(
      'Analyse en cours…',
    );
    expect(
      entryTitle(entry({ id: 'a', createdAt: '2026-10-08T09:00:00Z', local: { ...pending(), error: 'Oups' } })),
    ).toBe('Analyse impossible');
    expect(entryTitle(entry({ id: 'a', createdAt: '2026-10-08T09:00:00Z', source: 'text', transcript: 'Bonjour' }))).toBe(
      'Bonjour',
    );
  });

  it('aperçu : résumé, sinon texte tronqué', () => {
    const long = 'mot '.repeat(100);
    const snip = entrySnippet(entry({ id: 'a', createdAt: '2026-10-08T09:00:00Z', transcript: long }));
    expect(snip.length).toBeLessThanOrEqual(140);
    expect(snip.endsWith('…')).toBe(true);
  });

  it('statut', () => {
    const base = { id: 'a', createdAt: '2026-10-08T09:00:00Z' };
    expect(entryStatus(entry({ ...base, local: pending() }), idle).kind).toBe('pending');
    expect(entryStatus(entry({ ...base, local: pending() }), { running: true, phase: 'analyzing' }).kind).toBe(
      'analyzing',
    );
    expect(entryStatus(entry({ ...base, local: { ...pending(), error: 'x' } }), idle).kind).toBe('error');
    expect(entryStatus(entry({ ...base, local: { ...pending(), needsAnalysis: false, dirty: true } }), idle).kind).toBe(
      'unsent',
    );
    expect(
      entryStatus(entry({ ...base, local: { ...pending(), needsAnalysis: false, hasLocalAudio: true } }), idle).kind,
    ).toBe('unsent');
    expect(entryStatus(entry(base), idle).kind).toBe('ok');
  });
});

describe('textes et dates', () => {
  it('pluriel à la française', () => {
    expect(plural(0, 'entrée', 'entrées')).toBe('0 entrée');
    expect(plural(1, 'entrée', 'entrées')).toBe('1 entrée');
    expect(plural(3, 'entrée', 'entrées')).toBe('3 entrées');
  });

  it('paragraphes et troncature', () => {
    expect(splitParagraphs('Un.\n\nDeux.\nTrois.\n\n  ')).toEqual(['Un.', 'Deux.', 'Trois.']);
    expect(truncate('  a   b  ', 10)).toBe('a b');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });

  it('titres de jours', () => {
    expect(formatDayHeading('2026-10-08', '2026-10-08')).toBe('Jeudi 8 octobre');
    expect(formatDayHeading('2025-12-31', '2026-10-08')).toBe('Mercredi 31 décembre 2025');
    expect(relativeDayLabel('2026-10-08', '2026-10-08')).toBe("Aujourd'hui");
    expect(relativeDayLabel('2026-10-07', '2026-10-08')).toBe('Hier');
  });

  it('dates relatives', () => {
    const now = new Date(2026, 9, 8, 15, 0);
    const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
    expect(formatRelative(undefined, now)).toBe('jamais');
    expect(formatRelative(ago(0), now)).toBe("à l'instant");
    expect(formatRelative(ago(5), now)).toBe('il y a 5 min');
    expect(formatRelative(ago(120), now)).toBe('il y a 2 h');
    expect(formatRelative(new Date(2026, 9, 8, 7, 5).toISOString(), now)).toBe("aujourd'hui à 07:05");
    expect(formatRelative(new Date(2026, 9, 7, 21, 4).toISOString(), now)).toBe('hier à 21:04');
    expect(formatRelative(new Date(2026, 9, 3, 10, 0).toISOString(), now)).toBe('le 3 octobre à 10:00');
  });
});

function pending(): LocalEntry['local'] {
  return { dirty: true, needsAnalysis: true, hasLocalAudio: false, attempts: 0 };
}

describe('notes d’autres jours — routes, regroupement, libellés', () => {
  it('route d’un jour avec un élément à mettre en évidence (?e=…&m=…)', () => {
    expect(parseRoute('#/jour/2026-10-06?e=abc')).toEqual({ name: 'day', day: '2026-10-06', entry: 'abc' });
    expect(parseRoute('#/jour/2026-10-06?e=abc&m=f00d1234')).toEqual({
      name: 'day',
      day: '2026-10-06',
      entry: 'abc',
      mention: 'f00d1234',
    });
    // `m` sans `e` : ignoré ; jour invalide : journal
    expect(parseRoute('#/jour/2026-10-06?m=x')).toEqual({ name: 'day', day: '2026-10-06' });
    expect(parseRoute('#/jour/2026-02-30?e=x')).toEqual({ name: 'journal' });
    expect(hrefDay('2026-10-06')).toBe('#/jour/2026-10-06');
    expect(hrefDay('2026-10-06', { entry: 'a b', mention: 'm1' })).toBe('#/jour/2026-10-06?e=a+b&m=m1');
    for (const r of [
      { name: 'day', day: '2026-10-06', entry: 'e1' },
      { name: 'day', day: '2026-10-06', entry: 'a b', mention: 'm1' },
    ] as const) {
      expect(parseRoute(routeHash(r))).toEqual(r);
    }
  });

  it('sameScreen ignore la mise en évidence', () => {
    expect(sameScreen(parseRoute('#/jour/2026-10-06?e=x'), parseRoute('#/jour/2026-10-06'))).toBe(true);
    expect(sameScreen(parseRoute('#/jour/2026-10-06'), parseRoute('#/jour/2026-10-07'))).toBe(false);
    expect(sameScreen(parseRoute('#/entree/a'), parseRoute('#/entree/a'))).toBe(true);
    expect(sameScreen(parseRoute('#/journal'), parseRoute('#/'))).toBe(false);
  });

  it('groupDays : notes rattachées à leur jour, jours qui n’ont que des notes (passés ou à venir)', () => {
    const e = entry({ id: 's', createdAt: '2026-10-08T09:00:00.000Z', day: '2026-10-08' });
    const link = (day: string, kind: 'past' | 'future'): DayLink => ({
      entryId: 's',
      sourceDay: '2026-10-08',
      sourceCreatedAt: e.createdAt,
      mention: { id: day, kind, day, when: 'x', text: 'Fait.', status: 'auto' },
      ref: `s/${day}`,
    });
    const links = new Map([
      ['2026-10-08', []],
      ['2026-10-06', [link('2026-10-06', 'past')]],
      ['2026-10-12', [link('2026-10-12', 'future')]],
    ]);
    const groups = groupDays([e], {}, links);
    expect(groups.map((g) => g.day)).toEqual(['2026-10-12', '2026-10-08', '2026-10-06']);
    expect(groups[0]?.entries).toEqual([]);
    expect(groups[0]?.links?.map((l) => l.ref)).toEqual(['s/2026-10-12']);
    expect('links' in (groups[1] ?? {})).toBe(false);
    expect(linksOfKind(groups[2]?.links, 'past')).toHaveLength(1);
    expect(linksOfKind(groups[2]?.links, 'future')).toEqual([]);
    expect(linksOfKind(undefined, 'past')).toEqual([]);
  });

  it('libellés de jours', () => {
    expect(relativeDayLabel('2026-10-09', '2026-10-08')).toBe('Demain');
    expect(formatDayLong('2026-10-06', '2026-10-08')).toBe('mardi 6 octobre');
    expect(formatDayLong('2025-12-31', '2026-01-02')).toBe('mercredi 31 décembre 2025');
    expect(formatDayShort('2026-10-03')).toBe('Sam. 3 oct.');
    const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString();
    expect(saidAt('2026-10-08', at(8, 7, 42), '2026-10-08')).toBe("aujourd'hui à 07:42");
    expect(saidAt('2026-10-07', at(7, 21, 4), '2026-10-08')).toBe('hier à 21:04');
    expect(saidAt('2026-10-05', at(5, 9, 0), '2026-10-08')).toBe('le lundi 5 octobre à 09:00');
  });
});
