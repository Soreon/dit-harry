import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors';
import { MAX_INLINE_AUDIO_BYTES, createGeminiClient, msUntilDailyQuotaReset } from '../src/lib/gemini';
import {
  ENTRY_AUDIO_PROMPT,
  ENTRY_AUDIO_SCHEMA,
  ENTRY_TEXT_PROMPT,
  ENTRY_TEXT_SCHEMA,
  SYNTHESIS_PROMPT,
  SYNTHESIS_SCHEMA,
  SYSTEM_INSTRUCTION,
} from '../src/lib/prompts';
import type { Entry, EntryContext } from '../src/lib/types';
import { formatDayFr } from '../src/lib/util';

/* ------------------------------------------------------------------ */
/* Faux fetch                                                          */
/* ------------------------------------------------------------------ */

const KEY = 'AIza-test-key';
const MODEL = 'gemini-3.5-flash-lite';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CTX: EntryContext = { day: '2026-10-08', time: '07:42' };

interface Call {
  url: string;
  init: RequestInit;
}

type Reply = Response | Error | (() => Response);

function fakeFetch(...replies: Reply[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = replies.shift();
    if (r === undefined) throw new Error('appel fetch inattendu');
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r;
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Réponse generateContent réussie dont le texte est `obj` sérialisé. */
function okModel(obj: unknown, extra: Record<string, unknown> = {}): Response {
  return json(200, {
    candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP', index: 0 }],
    modelVersion: MODEL,
    ...extra,
  });
}

function okParts(parts: unknown[], finishReason = 'STOP'): Response {
  return json(200, { candidates: [{ content: { role: 'model', parts }, finishReason }] });
}

function apiError(code: number, message: string, status: string, details?: unknown[]): Response {
  return json(code, { error: { code, message, status, ...(details ? { details } : {}) } });
}

const KEY_INVALID = (): Response =>
  apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', [
    {
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'API_KEY_INVALID',
      domain: 'googleapis.com',
      metadata: { service: 'generativelanguage.googleapis.com' },
    },
  ]);

interface SentPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}
interface SentBody {
  systemInstruction: { parts: { text: string }[] };
  contents: { role: string; parts: SentPart[] }[];
  generationConfig: {
    responseFormat?: { text: { mimeType: string; schema: unknown } };
    responseMimeType?: string;
    responseJsonSchema?: unknown;
    thinkingConfig?: { thinkingLevel: string };
  } & Record<string, unknown>;
  store?: boolean;
}

function bodyOf(call: Call | undefined): SentBody {
  expect(call).toBeDefined();
  return JSON.parse(String(call?.init.body)) as SentBody;
}

function header(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init.headers).get(name);
}

async function caught(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('une AppError était attendue');
}

const ANALYSIS = {
  title: 'Réveil difficile',
  summary: "Je me suis levé fatigué. J'ai bu un café.",
  mood: { score: -1, label: 'fatigué' },
  themes: ['sommeil'],
  people: ['Marie'],
  places: [],
  todos: ['appeler le plombier'],
};

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'e',
    day: '2026-10-08',
    createdAt: new Date(2026, 9, 8, 8, 0).toISOString(),
    updatedAt: new Date(2026, 9, 8, 8, 0).toISOString(),
    source: 'text',
    transcript: '',
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Requêtes                                                            */
/* ------------------------------------------------------------------ */

describe('createGeminiClient — requêtes', () => {
  it('refuse une clé vide', () => {
    expect(() => createGeminiClient({ apiKey: '  ', model: MODEL })).toThrow(AppError);
    try {
      createGeminiClient({ apiKey: '', model: MODEL });
    } catch (e) {
      expect((e as AppError).kind).toBe('invalid-key');
    }
  });

  it('analyzeText : URL, en-têtes, corps (sortie structurée, pas de réflexion ni d’échantillonnage)', async () => {
    const { fetchImpl, calls } = fakeFetch(okModel(ANALYSIS));
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl });
    const res = await ai.analyzeText('  Ce matin, réveil difficile.  ', CTX);
    expect(res).toEqual(ANALYSIS);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/models/${MODEL}:generateContent`);
    expect(call?.url).not.toContain('key=');
    expect(call?.url).not.toContain(KEY);
    expect(call?.init.method).toBe('POST');
    expect(header(call, 'x-goog-api-key')).toBe(KEY);
    expect(header(call, 'content-type')).toBe('application/json');

    const body = bodyOf(call);
    expect(body.systemInstruction.parts[0]?.text).toBe(SYSTEM_INSTRUCTION);
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]?.role).toBe('user');
    const text = body.contents[0]?.parts[0]?.text ?? '';
    expect(text.startsWith(ENTRY_TEXT_PROMPT)).toBe(true);
    expect(text).toContain(`Date : ${formatDayFr('2026-10-08')}, heure : 07:42`);
    expect(text).toContain('<entree>\nCe matin, réveil difficile.\n</entree>');
    expect(body.generationConfig).toEqual({
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: ENTRY_TEXT_SCHEMA } },
    });
    expect(body.store).toBe(false);

    const raw = String(call?.init.body);
    for (const banned of ['temperature', 'topP', 'topK', 'candidateCount', 'maxOutputTokens', 'thinkingConfig']) {
      expect(raw).not.toContain(`"${banned}"`);
    }
  });

  it('analyzeAudio : audio inline en base64, MIME sans paramètres, schéma audio', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 82, 73, 70, 70]);
    const blob = new Blob([bytes], { type: 'audio/webm;codecs=opus' });
    const { fetchImpl, calls } = fakeFetch(
      okModel({ transcript: '  Ce matin, réveil difficile.\n\n\nPuis café.  ', ...ANALYSIS }),
    );
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl });
    const res = await ai.analyzeAudio(blob, 'audio/webm;codecs=opus', CTX);

    expect(res.transcript).toBe('Ce matin, réveil difficile.\n\nPuis café.');
    expect(res.analysis).toEqual(ANALYSIS);

    const body = bodyOf(calls[0]);
    const parts = body.contents[0]?.parts ?? [];
    expect(parts).toHaveLength(2);
    expect(parts[0]?.inlineData).toEqual({
      mimeType: 'audio/webm',
      data: btoa(String.fromCharCode(...bytes)),
    });
    expect(parts[1]?.text).toBe(`${ENTRY_AUDIO_PROMPT}\n\nDate : ${formatDayFr('2026-10-08')}, heure : 07:42`);
    expect(body.generationConfig).toEqual({
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: ENTRY_AUDIO_SCHEMA } },
    });
    expect(body.store).toBe(false);
  });

  it('analyzeAudio : MIME pris sur le blob si absent, alias audio/mp4 → audio/m4a', async () => {
    const { fetchImpl, calls } = fakeFetch(
      okModel({ transcript: 'Un.', ...ANALYSIS }),
      okModel({ transcript: 'Deux.', ...ANALYSIS }),
    );
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl });
    await ai.analyzeAudio(new Blob([new Uint8Array([1])], { type: 'audio/ogg;codecs=opus' }), '', CTX);
    await ai.analyzeAudio(new Blob([new Uint8Array([1])]), 'audio/mp4', CTX);
    expect(bodyOf(calls[0]).contents[0]?.parts[0]?.inlineData?.mimeType).toBe('audio/ogg');
    expect(bodyOf(calls[1]).contents[0]?.parts[0]?.inlineData?.mimeType).toBe('audio/m4a');
  });

  it('analyzeAudio : refuse un audio de plus de 18 Mo sans appeler Gemini', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl });
    const big = new Blob([new Uint8Array(MAX_INLINE_AUDIO_BYTES + 1)], { type: 'audio/webm' });
    const err = await caught(ai.analyzeAudio(big, 'audio/webm', CTX));
    expect(err.kind).toBe('other');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/trop long/);
    expect(calls).toHaveLength(0);
  });

  it('analyzeAudio : audio vide ou inaudible → transcription vide et titre imposé', async () => {
    const { fetchImpl, calls } = fakeFetch(
      okModel({ ...ANALYSIS, transcript: '' }),
      okModel({ ...ANALYSIS, transcript: ' [inaudible] ' }),
    );
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl });
    const inaudible = {
      title: 'Enregistrement inaudible',
      summary: '',
      mood: { score: 0, label: 'neutre' },
      themes: [],
      people: [],
      places: [],
      todos: [],
    };
    // blob vide : aucun appel
    expect(await ai.analyzeAudio(new Blob([]), 'audio/webm', CTX)).toEqual({ transcript: '', analysis: inaudible });
    expect(calls).toHaveLength(0);
    const blob = new Blob([new Uint8Array([1, 2])], { type: 'audio/webm' });
    expect(await ai.analyzeAudio(blob, 'audio/webm', CTX)).toEqual({ transcript: '', analysis: inaudible });
    expect(await ai.analyzeAudio(blob, 'audio/webm', CTX)).toEqual({ transcript: '', analysis: inaudible });
    expect(calls).toHaveLength(2);
  });

  it('analyzeAudio : transcription absente → bad-response', async () => {
    const { fetchImpl } = fakeFetch(okModel(ANALYSIS));
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl });
    const err = await caught(ai.analyzeAudio(new Blob([new Uint8Array([1])]), 'audio/webm', CTX));
    expect(err.kind).toBe('bad-response');
    expect(err.retryable).toBe(true);
  });

  it('analyzeText : texte vide → analyse locale, aucun appel', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl });
    const a = await ai.analyzeText('   ', CTX);
    expect(a.title).toBe('Entrée vide');
    expect(a.mood).toEqual({ score: 0, label: 'neutre' });
    expect(calls).toHaveLength(0);
  });

  it('synthesizeDay : réflexion envoyée, seules les entrées avec texte, triées', async () => {
    const { fetchImpl, calls } = fakeFetch(
      okModel({
        summary: "J'ai eu une journée chargée.",
        mood: { score: 1, label: 'content' },
        highlights: ['Déjeuner avec Marie'],
        themes: ['travail'],
        todos: ['appeler le plombier'],
      }),
    );
    const ai = createGeminiClient({ apiKey: KEY, model: 'gemini-3.8-flash', thinkingLevel: 'low', fetchImpl });
    const res = await ai.synthesizeDay('2026-10-08', [
      entry({ id: 'b', createdAt: new Date(2026, 9, 8, 12, 30).toISOString(), transcript: 'Déjeuner avec Marie.' }),
      entry({ id: 'x', createdAt: new Date(2026, 9, 8, 9, 0).toISOString(), transcript: '   ' }),
      entry({ id: 'a', createdAt: new Date(2026, 9, 8, 7, 15).toISOString(), transcript: 'Réveil.' }),
    ]);
    expect(res).toEqual({
      summary: "J'ai eu une journée chargée.",
      mood: { score: 1, label: 'content' },
      highlights: ['Déjeuner avec Marie'],
      themes: ['travail'],
      todos: ['appeler le plombier'],
    });

    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/models/gemini-3.8-flash:generateContent`);
    const body = bodyOf(call);
    expect(body.generationConfig).toEqual({
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: SYNTHESIS_SCHEMA } },
      thinkingConfig: { thinkingLevel: 'low' },
    });
    const text = body.contents[0]?.parts[0]?.text ?? '';
    expect(text.startsWith(SYNTHESIS_PROMPT)).toBe(true);
    expect(text).toContain(formatDayFr('2026-10-08'));
    expect(text).toContain('(2 entrées,');
    expect(text).not.toContain('09:00');
    expect(text.indexOf('07:15 — Sans titre\nRéveil.')).toBeGreaterThan(0);
    expect(text.indexOf('12:30 — Sans titre\nDéjeuner avec Marie.')).toBeGreaterThan(text.indexOf('07:15'));
  });

  it('synthesizeDay : aucune entrée avec texte → AppError other, aucun appel', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl });
    const err = await caught(ai.synthesizeDay('2026-10-08', [entry({ transcript: '' })]));
    expect(err.kind).toBe('other');
    expect(err.retryable).toBe(false);
    expect(await caught(ai.synthesizeDay('2026-10-08', [])).then((e) => e.kind)).toBe('other');
    expect(calls).toHaveLength(0);
  });

  it('baseUrl personnalisée (slash final ignoré), préfixe models/ toléré', async () => {
    const { fetchImpl, calls } = fakeFetch(okModel(ANALYSIS));
    const ai = createGeminiClient({
      apiKey: KEY,
      model: ' models/gemini-x ',
      baseUrl: 'https://proxy.test/v1beta/',
      fetchImpl,
    });
    await ai.analyzeText('Bonjour', CTX);
    expect(calls[0]?.url).toBe('https://proxy.test/v1beta/models/gemini-x:generateContent');
  });
});

/* ------------------------------------------------------------------ */
/* Lecture des réponses                                                */
/* ------------------------------------------------------------------ */

describe('createGeminiClient — réponses', () => {
  async function analyze(res: Response) {
    const { fetchImpl } = fakeFetch(res);
    return createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl }).analyzeText('Bonjour', CTX);
  }

  it('ignore les parties de réflexion et concatène les parties de réponse', async () => {
    const full = JSON.stringify(ANALYSIS);
    const res = await analyze(
      okParts([
        { text: 'Je réfléchis à la réponse…', thought: true },
        { text: full.slice(0, 20), thoughtSignature: 'CiQB' },
        { text: full.slice(20) },
      ]),
    );
    expect(res).toEqual(ANALYSIS);
  });

  it('tolère des balises de code et du texte autour du JSON', async () => {
    expect(await analyze(okParts([{ text: '```json\n' + JSON.stringify(ANALYSIS) + '\n```' }]))).toEqual(ANALYSIS);
    expect(await analyze(okParts([{ text: 'Voici : ' + JSON.stringify(ANALYSIS) + ' Fin.' }]))).toEqual(ANALYSIS);
  });

  it('normalise une analyse partielle', async () => {
    const res = await analyze(okModel({ title: 'Titre', mood: { score: 9 } }));
    expect(res).toEqual({
      title: 'Titre',
      summary: '',
      mood: { score: 2, label: 'très bien' },
      themes: [],
      people: [],
      places: [],
      todos: [],
    });
  });

  it('JSON illisible → bad-response retentable', async () => {
    const err = await caught(analyze(okParts([{ text: '{"title": "Tit' }])));
    expect(err.kind).toBe('bad-response');
    expect(err.retryable).toBe(true);
  });

  it('JSON qui n’est pas un objet → bad-response', async () => {
    expect((await caught(analyze(okParts([{ text: '[1,2]' }])))).kind).toBe('bad-response');
  });

  it('corps HTTP non JSON → bad-response', async () => {
    const err = await caught(analyze(new Response('<html>proxy</html>', { status: 200 })));
    expect(err.kind).toBe('bad-response');
  });

  it('aucun candidat ou texte vide → bad-response', async () => {
    expect((await caught(analyze(json(200, { candidates: [] })))).kind).toBe('bad-response');
    expect((await caught(analyze(okParts([{ text: 'pensée', thought: true }])))).kind).toBe('bad-response');
  });

  it('promptFeedback.blockReason → safety non retentable', async () => {
    const err = await caught(analyze(json(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })));
    expect(err.kind).toBe('safety');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("Gemini a refusé d'analyser ce contenu.");
  });

  it.each(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'])(
    'finishReason %s → safety',
    async (reason) => {
      const err = await caught(analyze(okParts([{ text: '{}' }], reason)));
      expect(err.kind).toBe('safety');
      expect(err.retryable).toBe(false);
    },
  );

  it('finishReason MAX_TOKENS / OTHER → bad-response retentable', async () => {
    for (const reason of ['MAX_TOKENS', 'OTHER', 'MALFORMED_RESPONSE']) {
      const err = await caught(analyze(okParts([{ text: '{"title":"x"' }], reason)));
      expect(err.kind).toBe('bad-response');
      expect(err.retryable).toBe(true);
    }
  });

  it('finishReason PUP_LIMITED_DISABLED → other non retentable', async () => {
    const err = await caught(analyze(okParts([{ text: '{}' }], 'PUP_LIMITED_DISABLED')));
    expect(err.kind).toBe('other');
    expect(err.retryable).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Erreurs HTTP / réseau                                               */
/* ------------------------------------------------------------------ */

describe('createGeminiClient — erreurs', () => {
  async function failWith(...replies: Reply[]): Promise<{ err: AppError; calls: Call[] }> {
    const { fetchImpl, calls } = fakeFetch(...replies);
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, thinkingLevel: 'low', fetchImpl });
    const err = await caught(ai.analyzeText('Bonjour', CTX));
    return { err, calls };
  }

  it('400 API_KEY_INVALID → invalid-key, sans nouvel essai', async () => {
    const { err, calls } = await failWith(KEY_INVALID());
    expect(err.kind).toBe('invalid-key');
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Clé Gemini refusée. Vérifie-la dans les réglages.');
    expect(calls).toHaveLength(1);
  });

  it('401 / 403 → invalid-key', async () => {
    for (const r of [
      apiError(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED'),
      apiError(403, "Method doesn't allow unregistered callers.", 'PERMISSION_DENIED'),
    ]) {
      const { err } = await failWith(r);
      expect(err.kind).toBe('invalid-key');
      expect(err.retryable).toBe(false);
    }
  });

  it('403 API_KEY_HTTP_REFERRER_BLOCKED → invalid-key avec message dédié', async () => {
    const { err } = await failWith(
      apiError(403, 'Requests from referer are blocked.', 'PERMISSION_DENIED', [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_HTTP_REFERRER_BLOCKED' },
      ]),
    );
    expect(err.kind).toBe('invalid-key');
    expect(err.message).toMatch(/restrictions de la clé/);
  });

  it('referrer bloqué : le message donne l’origine à autoriser (le chemin de l’appli n’est jamais envoyé)', async () => {
    vi.stubGlobal('location', { origin: 'https://soreon.github.io', href: 'https://soreon.github.io/dit-harry/#/' });
    try {
      const { err } = await failWith(
        apiError(403, 'Requests from referer https://soreon.github.io/ are blocked.', 'PERMISSION_DENIED', [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_HTTP_REFERRER_BLOCKED' },
        ]),
      );
      expect(err.message).toContain('« https://soreon.github.io/* »');
      expect(err.message).toMatch(/depuis ce site/); // reconnu par le contrôleur (message précis gardé)
      expect(err.message).not.toContain('/dit-harry');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('429 + RetryInfo → quota avec retryAfterMs', async () => {
    const details = (delay: string) => [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay },
    ];
    const a = await failWith(apiError(429, 'You exceeded your current quota.', 'RESOURCE_EXHAUSTED', details('17s')));
    expect(a.err.kind).toBe('quota');
    expect(a.err.retryable).toBe(true);
    expect(a.err.retryAfterMs).toBe(17_000);
    expect(a.err.message).toBe('Quota Gemini atteint, nouvel essai plus tard.');
    expect(a.calls).toHaveLength(1);

    const b = await failWith(apiError(429, 'quota', 'RESOURCE_EXHAUSTED', details('1.500s')));
    expect(b.err.retryAfterMs).toBe(1_500);

    const c = await failWith(apiError(429, 'quota', 'RESOURCE_EXHAUSTED'));
    expect(c.err.kind).toBe('quota');
    expect(c.err.retryAfterMs).toBeUndefined();
  });

  it('429 quota JOURNALIER (QuotaFailure …PerDay…) → nouvel essai après minuit, heure du Pacifique', async () => {
    const daily = [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          },
        ],
      },
      // Le RetryInfo (quelques secondes) ne vaut que pour la minute : il doit être ignoré.
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' },
    ];
    const before = Date.now();
    const { err } = await failWith(apiError(429, 'You exceeded your current quota.', 'RESOURCE_EXHAUSTED', daily));
    expect(err.kind).toBe('quota');
    expect(err.message).toMatch(/^Quota quotidien Gemini atteint : reprise automatique vers \d{1,2} h\.$/);
    const expected = msUntilDailyQuotaReset(before) + 5 * 60_000;
    expect(err.retryAfterMs).toBeGreaterThan(expected - 5_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(expected);

    // Quota par minute : RetryInfo gardé
    const perMinute = [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' },
    ];
    const m = await failWith(apiError(429, 'quota', 'RESOURCE_EXHAUSTED', perMinute));
    expect(m.err.retryAfterMs).toBe(42_000);
    expect(m.err.message).toBe('Quota Gemini atteint, nouvel essai plus tard.');
  });

  it('msUntilDailyQuotaReset : temps restant jusqu’à minuit à Los Angeles (heure d’été et d’hiver)', () => {
    expect(msUntilDailyQuotaReset(Date.UTC(2026, 9, 8, 20, 0, 0))).toBe(11 * 3_600_000); // 13 h PDT
    expect(msUntilDailyQuotaReset(Date.UTC(2026, 9, 8, 7, 0, 0))).toBe(24 * 3_600_000); // minuit PDT
    expect(msUntilDailyQuotaReset(Date.UTC(2026, 11, 1, 8, 30, 0))).toBe(23.5 * 3_600_000); // 0 h 30 PST
  });

  it('402 (et ancien 429 « prepayment credits are depleted ») → quota « Crédit Gemini épuisé »', async () => {
    const msg = 'Your prepayment credits are depleted. Please go to AI Studio.';
    for (const r of [apiError(402, msg, 'RESOURCE_EXHAUSTED'), apiError(429, msg, 'RESOURCE_EXHAUSTED')]) {
      const { err } = await failWith(r);
      expect(err.kind).toBe('quota');
      expect(err.message).toMatch(/^Crédit Gemini épuisé/);
      expect(err.retryAfterMs).toBeGreaterThanOrEqual(3_600_000);
    }
  });

  it('5xx et 408 → network retentable', async () => {
    for (const code of [500, 503, 504, 408]) {
      const { err } = await failWith(apiError(code, 'The service is currently unavailable.', 'UNAVAILABLE'));
      expect(err.kind).toBe('network');
      expect(err.retryable).toBe(true);
      expect(err.status).toBe(code);
      expect(err.message).toBe('Gemini injoignable pour le moment.');
    }
  });

  it('404 → other (modèle introuvable), non retentable', async () => {
    const { err } = await failWith(apiError(404, 'models/x is not found', 'NOT_FOUND'));
    expect(err.kind).toBe('other');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain(MODEL);
  });

  it('autre 400 → other, sans nouvel essai', async () => {
    const { err, calls } = await failWith(
      apiError(400, 'User location is not supported for the API use.', 'FAILED_PRECONDITION'),
    );
    expect(err.kind).toBe('other');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('User location is not supported');
    expect(calls).toHaveLength(1);
  });

  it('fetch rejeté (TypeError) → network', async () => {
    const { err } = await failWith(new TypeError('Failed to fetch'));
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('Gemini injoignable pour le moment.');
  });

  it('délai dépassé (TimeoutError) → network', async () => {
    const { err } = await failWith(new DOMException('signal timed out', 'TimeoutError'));
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/trop de temps/);
  });

  it('passe un signal d’expiration à fetch', async () => {
    const { fetchImpl, calls } = fakeFetch(okModel(ANALYSIS));
    await createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl }).analyzeText('Bonjour', CTX);
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
});

/* ------------------------------------------------------------------ */
/* Replis : réflexion, sortie structurée                               */
/* ------------------------------------------------------------------ */

describe('createGeminiClient — replis', () => {
  const THINKING_400 = (): Response =>
    apiError(400, 'Thinking level MINIMAL is not supported for this model.', 'INVALID_ARGUMENT');

  it('400 mentionnant la réflexion → un nouvel essai sans thinkingConfig, retenu ensuite', async () => {
    const synth = { summary: 'Résumé.', mood: { score: 0, label: 'calme' }, highlights: [], themes: [], todos: [] };
    const { fetchImpl, calls } = fakeFetch(THINKING_400(), okModel(synth), okModel(synth));
    const ai = createGeminiClient({ apiKey: KEY, model: 'gemini-3.8-flash', thinkingLevel: 'minimal', fetchImpl });
    const day = [entry({ transcript: 'Texte.' })];

    expect((await ai.synthesizeDay('2026-10-08', day)).summary).toBe('Résumé.');
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0]).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    expect(bodyOf(calls[1]).generationConfig.thinkingConfig).toBeUndefined();
    expect(bodyOf(calls[1]).generationConfig.responseFormat).toBeDefined();

    // appel suivant : directement sans réflexion
    await ai.synthesizeDay('2026-10-08', day);
    expect(calls).toHaveLength(3);
    expect(bodyOf(calls[2]).generationConfig.thinkingConfig).toBeUndefined();
  });

  it('un seul nouvel essai : second refus → AppError other', async () => {
    const { fetchImpl, calls } = fakeFetch(THINKING_400(), THINKING_400());
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, thinkingLevel: 'minimal', fetchImpl });
    const err = await caught(ai.synthesizeDay('2026-10-08', [entry({ transcript: 'Texte.' })]));
    expect(err.kind).toBe('other');
    expect(calls).toHaveLength(2);
  });

  it('sans thinkingLevel, un 400 « thinking » n’entraîne pas de nouvel essai', async () => {
    const { fetchImpl, calls } = fakeFetch(THINKING_400());
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl });
    expect((await caught(ai.analyzeText('Bonjour', CTX))).kind).toBe('other');
    expect(calls).toHaveLength(1);
  });

  it('champ responseFormat refusé → un nouvel essai avec responseMimeType + responseJsonSchema', async () => {
    const { fetchImpl, calls } = fakeFetch(
      apiError(
        400,
        `Invalid value at 'generation_config.response_format.text.mime_type' (TYPE_ENUM), "APPLICATION_JSON"`,
        'INVALID_ARGUMENT',
      ),
      okModel(ANALYSIS),
      okModel(ANALYSIS),
    );
    const ai = createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl });
    expect(await ai.analyzeText('Bonjour', CTX)).toEqual(ANALYSIS);
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[1]).generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema: ENTRY_TEXT_SCHEMA,
    });
    // le repli est retenu pour la suite
    await ai.analyzeText('Encore', CTX);
    expect(calls).toHaveLength(3);
    expect(bodyOf(calls[2]).generationConfig.responseFormat).toBeUndefined();
    expect(bodyOf(calls[2]).generationConfig.responseMimeType).toBe('application/json');
  });
});

/* ------------------------------------------------------------------ */
/* checkKey                                                            */
/* ------------------------------------------------------------------ */

describe('createGeminiClient — checkKey', () => {
  it('GET models/{model} avec la clé en en-tête', async () => {
    const { fetchImpl, calls } = fakeFetch(json(200, { name: `models/${MODEL}`, thinking: true }));
    await createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl }).checkKey();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/models/${MODEL}`);
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(header(calls[0], 'x-goog-api-key')).toBe(KEY);
    expect(calls[0]?.url).not.toContain(KEY);
  });

  it('clé refusée → invalid-key', async () => {
    const { fetchImpl } = fakeFetch(KEY_INVALID());
    const err = await caught(createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl }).checkKey());
    expect(err.kind).toBe('invalid-key');
  });

  it('modèle inconnu → other (pas une mauvaise clé)', async () => {
    const { fetchImpl } = fakeFetch(apiError(404, 'models/foo is not found', 'NOT_FOUND'));
    const err = await caught(createGeminiClient({ apiKey: KEY, model: 'foo', fetchImpl }).checkKey());
    expect(err.kind).toBe('other');
    expect(err.message).toContain('foo');
  });

  it('réseau indisponible → network', async () => {
    const { fetchImpl } = fakeFetch(new TypeError('Failed to fetch'));
    const err = await caught(createGeminiClient({ apiKey: KEY, model: MODEL, fetchImpl }).checkKey());
    expect(err.kind).toBe('network');
  });
});
