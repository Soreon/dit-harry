import { describe, expect, it } from 'vitest';
import { renderDayMarkdown } from '../src/lib/markdown';
import type { DaySynthesis, Entry, Mood } from '../src/lib/types';

/** Date ISO correspondant à une heure LOCALE du 8 octobre 2026 (indépendant du fuseau). */
function at(h: number, m: number, s = 0): string {
  return new Date(2026, 9, 8, h, m, s).toISOString();
}

function voiceEntry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e-voice',
    day: '2026-10-08',
    createdAt: at(8, 15),
    updatedAt: at(8, 20),
    source: 'voice',
    durationSec: 192,
    audioMime: 'audio/webm',
    audioFileId: 'f1',
    transcript: 'Réveil difficile ce matin.\n\nMais le café était bon.',
    analysis: {
      title: 'Un matin lent',
      summary: 'Je me suis levé difficilement.',
      mood: { score: 1, label: 'plutôt content' },
      themes: ['matin', 'café'],
      people: ['Marie'],
      places: ['Lyon'],
      todos: ['appeler le plombier'],
    },
    ...over,
  };
}

function textEntry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'e-text',
    day: '2026-10-08',
    createdAt: at(21, 5),
    updatedAt: at(21, 5),
    source: 'text',
    transcript: 'Soirée calme.',
    analysis: {
      title: 'Soirée calme',
      summary: 'Une soirée tranquille.',
      mood: { score: 0, label: 'serein' },
      themes: [],
      people: [],
      places: [],
      todos: [],
    },
    ...over,
  };
}

const pending: Entry = {
  id: 'e-pending',
  day: '2026-10-08',
  createdAt: at(12, 0),
  updatedAt: at(12, 0),
  source: 'voice',
  durationSec: 65,
  transcript: '',
};

const synthesis: DaySynthesis = {
  day: '2026-10-08',
  generatedAt: '2026-10-09T06:00:00.000Z',
  model: 'gemini-3.8-flash',
  basedOn: '2-abc',
  summary: 'Une journée lente puis calme.\nJ’ai pris le temps.',
  mood: { score: 2, label: 'heureux' },
  highlights: ['Le café du matin', 'La soirée calme'],
  themes: ['repos', 'café'],
  todos: ['appeler le plombier'],
};

const EXPECTED_FULL = `# Jeudi 8 octobre 2026

**Humeur du jour** : 😄 heureux

## Synthèse

Une journée lente puis calme.

J’ai pris le temps.

**Moments forts**

- Le café du matin
- La soirée calme

**À faire**

- appeler le plombier

**Thèmes** : repos, café

## Entrées

### 08:15 — Un matin lent

Humeur : 🙂 plutôt content · Durée : 3:12 · Thèmes : matin, café · Personnes : Marie · Lieux : Lyon

Réveil difficile ce matin.

Mais le café était bon.

**À faire**

- appeler le plombier

### 12:00 — (analyse en attente)

Durée : 1:05

*(transcription en attente)*

### 21:05 — Soirée calme

Écrite au clavier · Humeur : 😐 serein

Soirée calme.
`;

describe('renderDayMarkdown', () => {
  it('rend une journée complète (synthèse + entrées chronologiques)', () => {
    const md = renderDayMarkdown('2026-10-08', [textEntry(), voiceEntry(), pending], synthesis);
    expect(md).toBe(EXPECTED_FULL);
  });

  it('est déterministe et indépendant de l’ordre des entrées', () => {
    const a = renderDayMarkdown('2026-10-08', [voiceEntry(), pending, textEntry()], synthesis);
    const b = renderDayMarkdown('2026-10-08', [textEntry(), pending, voiceEntry()], synthesis);
    const c = renderDayMarkdown('2026-10-08', [textEntry(), pending, voiceEntry()], synthesis);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('ne modifie pas le tableau reçu', () => {
    const list = [textEntry(), voiceEntry()];
    renderDayMarkdown('2026-10-08', list);
    expect(list.map((e) => e.id)).toEqual(['e-text', 'e-voice']);
  });

  it('se termine par un unique saut de ligne', () => {
    for (const md of [
      renderDayMarkdown('2026-10-08', [voiceEntry()]),
      renderDayMarkdown('2026-10-08', [], synthesis),
      renderDayMarkdown('2026-10-08', [pending]),
    ]) {
      expect(md.endsWith('\n')).toBe(true);
      expect(md.endsWith('\n\n')).toBe(false);
      expect(md).not.toMatch(/\n{3,}/);
    }
  });

  it('sans synthèse : ni humeur du jour ni section Synthèse', () => {
    const md = renderDayMarkdown('2026-10-08', [voiceEntry()]);
    expect(md.startsWith('# Jeudi 8 octobre 2026\n\n## Entrées\n\n### 08:15 — Un matin lent\n')).toBe(true);
    expect(md).not.toContain('Synthèse');
    expect(md).not.toContain('Humeur du jour');
  });

  it('synthèse sans entrée', () => {
    const md = renderDayMarkdown('2026-10-08', [], synthesis);
    expect(md.endsWith('## Entrées\n\n*Aucune entrée.*\n')).toBe(true);
  });

  it('associe chaque score d’humeur à son emoji', () => {
    const emojis: [Mood['score'], string][] = [
      [-2, '😞'],
      [-1, '🙁'],
      [0, '😐'],
      [1, '🙂'],
      [2, '😄'],
    ];
    for (const [score, emoji] of emojis) {
      const md = renderDayMarkdown('2026-10-08', [], { ...synthesis, mood: { score, label: 'x' } });
      expect(md).toContain(`**Humeur du jour** : ${emoji} x\n`);
    }
  });

  it('neutralise ce qui casserait la structure, sans produire de HTML', () => {
    const tricky = voiceEntry({
      transcript: '# pas un titre\n```\n<script>alert(1)</script>\n> pas une citation\nTexte normal < 3',
      analysis: {
        ...voiceEntry().analysis!,
        title: 'Titre\nsur deux lignes <b>gras</b>',
        todos: ['# tâche', '  ', 'faire\nles courses'],
        themes: ['', 'a'],
      },
    });
    const md = renderDayMarkdown('2026-10-08', [tricky]);
    expect(md).toContain('### 08:15 — Titre sur deux lignes \\<b>gras\\</b>\n');
    expect(md).toContain('\n\\# pas un titre\n');
    expect(md).toContain('\n\\```\n');
    expect(md).toContain('\n\\<script>alert(1)\\</script>\n');
    expect(md).toContain('\n\\> pas une citation\n');
    expect(md).toContain('\nTexte normal < 3\n');
    expect(md).toContain('**À faire**\n\n- \\# tâche\n- faire les courses\n');
    expect(md).toContain('Thèmes : a ·');
    expect(md).not.toMatch(/(^|[^\\])<[a-z/]/i);
  });

  it('entrée texte sans analyse et entrée vocale inaudible', () => {
    const md = renderDayMarkdown('2026-10-08', [
      textEntry({ analysis: undefined }),
      voiceEntry({ transcript: '', analysis: { ...voiceEntry().analysis!, title: 'Enregistrement inaudible', todos: [] } }),
    ]);
    expect(md).toContain('### 21:05 — (analyse en attente)\n\nÉcrite au clavier\n\nSoirée calme.\n');
    expect(md).toContain('### 08:15 — Enregistrement inaudible\n');
    expect(md).toContain('*(aucun texte)*');
  });
});
