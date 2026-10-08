import { describe, expect, it } from 'vitest';
import {
  ENTRY_AUDIO_PROMPT,
  ENTRY_AUDIO_SCHEMA,
  ENTRY_TEXT_PROMPT,
  ENTRY_TEXT_SCHEMA,
  INAUDIBLE_TITLE,
  SYNTHESIS_PROMPT,
  SYNTHESIS_SCHEMA,
  SYSTEM_INSTRUCTION,
  buildSynthesisInput,
  buildTextRequestText,
  formatEntryContext,
  isInaudibleTranscript,
  normalizeAnalysis,
  normalizeSynthesis,
  normalizeTranscript,
} from '../src/lib/prompts';
import type { JsonSchema } from '../src/lib/prompts';
import type { Entry } from '../src/lib/types';
import { formatDayFr } from '../src/lib/util';

/** Date ISO correspondant à une heure LOCALE du 8 octobre 2026 (indépendant du fuseau). */
function at(h: number, m: number): string {
  return new Date(2026, 9, 8, h, m).toISOString();
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    day: '2026-10-08',
    createdAt: at(8, 15),
    updatedAt: at(8, 20),
    source: 'text',
    transcript: 'Bonjour.',
    ...over,
  };
}

/** Mots-clés JSON Schema acceptés par Gemini (api-notes §1.4). */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'minimum',
  'maximum',
]);

function walk(schema: JsonSchema, visit: (s: JsonSchema, path: string) => void, path = '$'): void {
  visit(schema, path);
  for (const [k, sub] of Object.entries(schema.properties ?? {})) walk(sub, visit, `${path}.${k}`);
  if (schema.items) walk(schema.items, visit, `${path}[]`);
}

describe('prompts', () => {
  it('sont en français et couvrent les consignes de SPEC §6', () => {
    for (const p of [SYSTEM_INSTRUCTION, ENTRY_AUDIO_PROMPT, ENTRY_TEXT_PROMPT, SYNTHESIS_PROMPT]) {
      expect(p.length).toBeGreaterThan(200);
    }
    expect(SYSTEM_INSTRUCTION).toMatch(/n'invente jamais/);
    expect(ENTRY_AUDIO_PROMPT).toContain('« euh »');
    expect(ENTRY_AUDIO_PROMPT).toMatch(/Ne reformule pas, ne résume pas/);
    expect(ENTRY_AUDIO_PROMPT).toContain(INAUDIBLE_TITLE);
    expect(ENTRY_AUDIO_PROMPT).toContain('transcript = ""');
    for (const p of [ENTRY_AUDIO_PROMPT, ENTRY_TEXT_PROMPT]) {
      expect(p).toContain('8 mots au maximum');
      expect(p).toContain('première personne');
      expect(p).toContain("à l'infinitif");
      expect(p).toMatch(/-2, -1, 0, 1, 2/);
      expect(p).toContain('liste vide');
    }
    expect(SYNTHESIS_PROMPT).toContain('3 à 6 phrases');
    expect(SYNTHESIS_PROMPT).toContain('2 à 5 moments forts');
    expect(SYNTHESIS_PROMPT).toMatch(/dédoublonn|fusionne/);
  });

  it('formatEntryContext : date en toutes lettres + heure', () => {
    expect(formatEntryContext({ day: '2026-10-08', time: '07:42' })).toBe(
      `Date : ${formatDayFr('2026-10-08')}, heure : 07:42`,
    );
    expect(formatEntryContext({ day: '2026-10-08', time: '07:42' })).toContain('8 octobre 2026');
  });

  it('buildTextRequestText délimite le texte de l’entrée', () => {
    const t = buildTextRequestText('  Mon texte.  ', { day: '2026-10-08', time: '21:05' });
    expect(t.startsWith(ENTRY_TEXT_PROMPT)).toBe(true);
    expect(t).toContain('heure : 21:05');
    expect(t).toContain('<entree>\nMon texte.\n</entree>');
  });
});

describe('schémas JSON', () => {
  it('n’utilisent que des mots-clés acceptés par Gemini', () => {
    for (const schema of [ENTRY_AUDIO_SCHEMA, ENTRY_TEXT_SCHEMA, SYNTHESIS_SCHEMA]) {
      walk(schema, (s, path) => {
        for (const k of Object.keys(s)) expect(ALLOWED_KEYWORDS.has(k), `${path}.${k}`).toBe(true);
        if (s.type === 'object') {
          // tout champ déclaré est requis
          expect([...(s.required ?? [])].sort(), path).toEqual(Object.keys(s.properties ?? {}).sort());
        }
      });
      // sérialisable tel quel
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    }
  });

  it('audio : transcription en premier, puis les champs d’analyse', () => {
    expect(Object.keys(ENTRY_AUDIO_SCHEMA.properties ?? {})).toEqual([
      'transcript',
      'title',
      'summary',
      'mood',
      'themes',
      'people',
      'places',
      'todos',
    ]);
    const score = ENTRY_AUDIO_SCHEMA.properties?.['mood']?.properties?.['score'];
    expect(score?.type).toBe('integer');
    expect(score?.enum).toEqual([-2, -1, 0, 1, 2]);
    expect(ENTRY_AUDIO_SCHEMA.properties?.['themes']?.maxItems).toBe(5);
  });

  it('texte : analyse seule (pas de transcription)', () => {
    expect(Object.keys(ENTRY_TEXT_SCHEMA.properties ?? {})).toEqual([
      'title',
      'summary',
      'mood',
      'themes',
      'people',
      'places',
      'todos',
    ]);
  });

  it('synthèse : résumé, humeur, moments forts, thèmes, à faire', () => {
    expect(Object.keys(SYNTHESIS_SCHEMA.properties ?? {})).toEqual([
      'summary',
      'mood',
      'highlights',
      'themes',
      'todos',
    ]);
    expect(SYNTHESIS_SCHEMA.properties?.['highlights']?.maxItems).toBe(5);
  });
});

describe('buildSynthesisInput', () => {
  it('liste horodatée triée chronologiquement, jour en toutes lettres', () => {
    const entries: Entry[] = [
      entry({
        id: 'b',
        createdAt: at(18, 30),
        transcript: 'Soirée calme.\n\n\n\nJe lis.',
        analysis: {
          title: 'Soirée lecture',
          summary: '',
          mood: { score: 1, label: 'serein' },
          themes: [],
          people: [],
          places: [],
          todos: [],
        },
      }),
      entry({
        id: 'a',
        createdAt: at(7, 5),
        transcript: 'Réveil difficile.',
        analysis: {
          title: 'Réveil',
          summary: '',
          mood: { score: -1, label: 'fatigué' },
          themes: [],
          people: [],
          places: [],
          todos: [],
        },
      }),
      entry({ id: 'c', createdAt: at(12, 0), transcript: 'Déjeuner avec Marie.' }),
    ];
    const out = buildSynthesisInput('2026-10-08', entries);
    expect(out).toContain(formatDayFr('2026-10-08'));
    expect(out).toContain('3 entrées');
    const i1 = out.indexOf('07:05 — Réveil\nRéveil difficile.');
    const i2 = out.indexOf('12:00 — Sans titre\nDéjeuner avec Marie.');
    const i3 = out.indexOf('18:30 — Soirée lecture\nSoirée calme.\n\nJe lis.');
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    // l'entrée d'origine n'est pas modifiée (tri sur une copie)
    expect(entries.map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('singulier pour une seule entrée', () => {
    expect(buildSynthesisInput('2026-10-08', [entry()])).toContain('(1 entrée,');
  });
});

describe('normalizeAnalysis', () => {
  it('valeurs par défaut pour une entrée illisible', () => {
    for (const raw of [null, undefined, 'texte', 42, [1, 2], {}]) {
      expect(normalizeAnalysis(raw)).toEqual({
        title: 'Sans titre',
        summary: '',
        mood: { score: 0, label: 'neutre' },
        themes: [],
        people: [],
        places: [],
        todos: [],
      });
    }
  });

  it('garde une analyse correcte telle quelle', () => {
    const a = {
      title: 'Déjeuner avec Marie',
      summary: "J'ai déjeuné avec Marie. C'était bien.",
      mood: { score: 1, label: 'content' },
      themes: ['amitié', 'travail'],
      people: ['Marie'],
      places: ['Lyon'],
      todos: ['rappeler Paul'],
    };
    expect(normalizeAnalysis(a)).toEqual(a);
  });

  it('borne et arrondit le score', () => {
    const score = (s: unknown) => normalizeAnalysis({ mood: { score: s, label: 'x' } }).mood.score;
    expect(score(5)).toBe(2);
    expect(score(-7)).toBe(-2);
    expect(score(1.6)).toBe(2);
    expect(score(-0.4)).toBe(0);
    expect(Object.is(score(-0.4), -0)).toBe(false);
    expect(score('1')).toBe(1);
    expect(score('-1,2')).toBe(-1);
    expect(score('beaucoup')).toBe(0);
    expect(score(Number.NaN)).toBe(0);
    expect(score(null)).toBe(0);
  });

  it('libellé d’humeur : rogné, minuscules, défaut selon le score', () => {
    expect(normalizeAnalysis({ mood: { score: 2, label: '  Fatigué   mais CONTENT. ' } }).mood).toEqual({
      score: 2,
      label: 'fatigué mais content',
    });
    expect(normalizeAnalysis({ mood: { score: -2 } }).mood).toEqual({ score: -2, label: 'très mal' });
    expect(normalizeAnalysis({ mood: 1 }).mood).toEqual({ score: 1, label: 'plutôt bien' });
    expect(normalizeAnalysis({ mood: 'serein' }).mood).toEqual({ score: 0, label: 'serein' });
    expect(normalizeAnalysis({ mood: { score: 0, label: 'x'.repeat(100) } }).mood.label.length).toBeLessThanOrEqual(40);
  });

  it('rogne, dédoublonne (casse et accents ignorés), retire vides et non-chaînes', () => {
    const a = normalizeAnalysis({
      title: '  « Une   journée\n chargée. »  ',
      summary: '  Ligne   un.\r\n\r\n\r\nLigne deux.  ',
      themes: ['Travail', ' travail ', '#Famille', 'famille', '', '   ', null, 3],
      people: ['Éric', 'eric', 'Marie', { nom: 'x' }],
      places: 'Paris',
      todos: ['- Appeler le plombier.', 'appeler le plombier', '2. réserver le train'],
    });
    expect(a.title).toBe('Une journée chargée');
    expect(a.summary).toBe('Ligne un.\n\nLigne deux.');
    expect(a.themes).toEqual(['travail', 'famille', '3']);
    expect(a.people).toEqual(['Éric', 'Marie']);
    expect(a.places).toEqual(['Paris']);
    expect(a.todos).toEqual(['Appeler le plombier.', 'réserver le train']);
  });

  it('borne le nombre d’éléments et la longueur des chaînes', () => {
    const many = Array.from({ length: 30 }, (_, i) => `élément ${i}`);
    const a = normalizeAnalysis({
      title: 'mot '.repeat(60),
      summary: 'phrase longue '.repeat(200),
      themes: many,
      people: many,
      places: many,
      todos: many,
    });
    expect(a.title.length).toBeLessThanOrEqual(80);
    expect(a.title.endsWith('…')).toBe(true);
    expect(a.summary.length).toBeLessThanOrEqual(800);
    expect(a.themes).toHaveLength(5);
    expect(a.people).toHaveLength(10);
    expect(a.places).toHaveLength(10);
    expect(a.todos).toHaveLength(15);
    const longTodo = normalizeAnalysis({ todos: ['a'.repeat(500)] }).todos[0] ?? '';
    expect(longTodo.length).toBeLessThanOrEqual(160);
  });

  it('ne coupe pas un émoji en deux', () => {
    const title = `${'a'.repeat(78)}😄😄`;
    const out = normalizeAnalysis({ title }).title;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });
});

describe('normalizeSynthesis', () => {
  it('valeurs par défaut', () => {
    expect(normalizeSynthesis(undefined)).toEqual({
      summary: '',
      mood: { score: 0, label: 'neutre' },
      highlights: [],
      themes: [],
      todos: [],
    });
  });

  it('normalise et borne', () => {
    const s = normalizeSynthesis({
      summary: '  Une belle journée.  ',
      mood: { score: '3', label: 'Ravi' },
      highlights: ['A', 'a', 'B', 'C', 'D', 'E', 'F'],
      themes: ['Sport', 'SPORT', 'Lecture'],
      todos: ['Appeler maman', 'appeler maman.', 'Payer le loyer'],
      extra: 'ignoré',
    });
    expect(s).toEqual({
      summary: 'Une belle journée.',
      mood: { score: 2, label: 'ravi' },
      highlights: ['A', 'B', 'C', 'D', 'E'],
      themes: ['sport', 'lecture'],
      todos: ['Appeler maman', 'Payer le loyer'],
    });
  });
});

describe('transcription', () => {
  it('normalizeTranscript conserve les paragraphes', () => {
    expect(normalizeTranscript('  Bonjour   toi.\r\n\r\n\r\n  Suite.  ')).toBe('Bonjour toi.\n\nSuite.');
    expect(normalizeTranscript(undefined)).toBe('');
  });

  it('isInaudibleTranscript', () => {
    expect(isInaudibleTranscript('')).toBe(true);
    expect(isInaudibleTranscript(' [inaudible] … [Inaudible]. ')).toBe(true);
    expect(isInaudibleTranscript('Bonjour [inaudible].')).toBe(false);
  });
});
