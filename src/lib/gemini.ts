import { config } from '../config';
import { AppError, toAppError } from './errors';
import {
  SYNTHESIS_SCHEMA,
  SYSTEM_INSTRUCTION,
  audioSchemaFor,
  buildAudioRequestText,
  buildSynthesisRequestText,
  buildTextRequestText,
  inaudibleAnalysis,
  isInaudibleTranscript,
  normalizeAnalysis,
  normalizeSynthesis,
  normalizeTranscript,
  synthesisRefMap,
  synthesisSchemaFor,
  textSchemaFor,
} from './prompts';
import type { JsonSchema } from './prompts';
import type { AiClient, EntryAnalysis } from './types';
import { blobToBase64, stripMimeParams } from './util';

/**
 * Client Gemini (REST `generateContent`, v1beta) — voir docs/SPEC.md §6 et docs/api-notes.md §1.
 *
 * - Clé dans l'en-tête `x-goog-api-key` (jamais dans l'URL).
 * - Audio envoyé inline en base64 (pas de Files API), MIME sans paramètres.
 * - Sortie structurée via `generationConfig.responseFormat.text` ; repli unique sur l'ancien
 *   couple `responseMimeType` + `responseJsonSchema` si l'API refuse le champ.
 * - Jamais de `temperature`, `topP`, `topK`, `candidateCount`, `maxOutputTokens`.
 */

/** Au-delà, l'audio n'est pas envoyé (base64 ≈ ×4/3 : ~24 Mo de JSON). */
export const MAX_INLINE_AUDIO_BYTES = 18 * 1024 * 1024;

/** Délai max. d'une génération (un audio de 30 min peut prendre plus d'une minute). */
const GENERATE_TIMEOUT_MS = 5 * 60_000;
/** Délai max. de la vérification de clé. */
const CHECK_TIMEOUT_MS = 20_000;
/** Délai avant nouvel essai quand le crédit prépayé est épuisé (402). */
const CREDIT_RETRY_MS = 60 * 60_000;
/** Quota journalier : remis à zéro à minuit, heure du Pacifique (doc « rate limits »). */
const DAILY_QUOTA_TIME_ZONE = 'America/Los_Angeles';
/** Marge après la remise à zéro avant de retenter. */
const DAILY_RESET_MARGIN_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Titre d'une entrée texte vide (analysée sans appel à Gemini). */
const EMPTY_TEXT_TITLE = 'Entrée vide';

const MSG = {
  invalidKey: 'Clé Gemini refusée. Vérifie-la dans les réglages.',
  referrerBlocked:
    "Clé Gemini refusée depuis ce site : dans les restrictions de la clé, autorise l'origine du site suivie de « /* », sans le chemin de l'appli (le navigateur n'envoie que l'origine).",
  serviceDisabled: "L'API Gemini n'est pas activée pour le projet de cette clé.",
  quota: 'Quota Gemini atteint, nouvel essai plus tard.',
  credit: 'Crédit Gemini épuisé. Recharge-le dans AI Studio.',
  safety: "Gemini a refusé d'analyser ce contenu.",
  network: 'Gemini injoignable pour le moment.',
  timeout: 'Gemini met trop de temps à répondre. Nouvel essai plus tard.',
  empty: 'Réponse vide de Gemini. Nouvel essai plus tard.',
  truncated: 'Réponse de Gemini incomplète. Nouvel essai plus tard.',
  unreadable: 'Réponse de Gemini illisible. Nouvel essai plus tard.',
  noTranscript: 'Transcription absente de la réponse de Gemini. Nouvel essai plus tard.',
  restricted: 'Ton compte Gemini est restreint par Google : analyse impossible.',
  tooLong: 'Enregistrement trop long pour être analysé (plus de 18 Mo).',
  noEntries: 'Aucune entrée avec du texte à synthétiser pour ce jour.',
  noKey: 'Ajoute ta clé Gemini dans les réglages.',
  noModel: 'Aucun modèle Gemini choisi dans les réglages.',
} as const;

/** finishReason traités comme un blocage par les filtres. */
const SAFETY_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);
/** finishReason « normaux ». */
const OK_FINISH = new Set(['STOP', 'FINISH_REASON_UNSPECIFIED']);

/** Message d'erreur 400 indiquant que le champ de sortie structurée est refusé (api-notes §1.4). */
const STRUCTURED_FIELD_RE = /response_?format|responseFormat|response_mime_type|mime_type/i;

/** MIME acceptés par Gemini pour quelques alias courants (api-notes §1.2). */
const AUDIO_MIME_ALIASES: Record<string, string> = {
  'audio/mp4': 'audio/m4a',
  'audio/x-m4a': 'audio/m4a',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
};

/* ------------------------------------------------------------------ */
/* Types de l'API (champs utiles seulement)                            */
/* ------------------------------------------------------------------ */

type RequestPart = { text: string } | { inlineData: { mimeType: string; data: string } };

interface GenerationConfig {
  responseFormat?: { text: { mimeType: 'APPLICATION_JSON'; schema: JsonSchema } };
  responseMimeType?: 'application/json';
  responseJsonSchema?: JsonSchema;
  thinkingConfig?: { thinkingLevel: string };
}

interface GenerateContentRequest {
  systemInstruction: { parts: { text: string }[] };
  contents: { role: 'user'; parts: RequestPart[] }[];
  generationConfig: GenerationConfig;
  store: false;
}

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/* ------------------------------------------------------------------ */
/* Lecture des erreurs (google.rpc.Status)                             */
/* ------------------------------------------------------------------ */

function errorDetails(body: unknown): Rec[] {
  const err = isRecord(body) ? body['error'] : undefined;
  const details = isRecord(err) ? err['details'] : undefined;
  return Array.isArray(details) ? details.filter(isRecord) : [];
}

function apiMessage(body: unknown): string {
  if (typeof body === 'string') return body;
  const err = isRecord(body) ? body['error'] : undefined;
  const msg = isRecord(err) ? err['message'] : undefined;
  return typeof msg === 'string' ? msg : '';
}

/** `ErrorInfo.reason` (ex. 'API_KEY_INVALID'). */
function errorInfoReason(body: unknown): string | undefined {
  const info = errorDetails(body).find((d) => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
  const reason = info?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** `RetryInfo.retryDelay` (Duration JSON, ex. "17s", "1.500s") → ms. */
function retryDelayMs(body: unknown): number | undefined {
  const info = errorDetails(body).find((d) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
  const raw = info?.['retryDelay'];
  const m = typeof raw === 'string' ? /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(raw) : null;
  return m?.[1] !== undefined ? Math.ceil(parseFloat(m[1]) * 1000) : undefined;
}

/** Problème de clé dans une réponse 400 (la clé invalide renvoie 400, pas 401/403). */
function isKeyProblem(reason: string | undefined, message: string): boolean {
  return (reason?.startsWith('API_KEY_') ?? false) || /api key (not valid|expired|invalid)/i.test(message);
}

/**
 * Clé limitée à certains sites. La page envoie `Referrer-Policy: strict-origin-when-cross-origin`
 * (index.html, et défaut de Chrome) : Google ne reçoit que l'ORIGINE (ex.
 * `https://soreon.github.io/`), jamais le chemin. Une restriction sur l'adresse complète de
 * l'appli (`…/dit-harry/*`) ne correspond donc jamais : on indique la valeur qui marche.
 */
function referrerBlockedMessage(): string {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  if (!origin || origin === 'null') return MSG.referrerBlocked;
  return `Clé Gemini refusée depuis ce site : dans les restrictions de la clé, autorise « ${origin}/* » (le navigateur n'envoie que l'origine du site, sans le chemin de l'appli).`;
}

function keyError(reason: string | undefined, status: number, body: unknown): AppError {
  let message: string = MSG.invalidKey;
  if (reason === 'API_KEY_HTTP_REFERRER_BLOCKED') message = referrerBlockedMessage();
  else if (reason === 'SERVICE_DISABLED') message = MSG.serviceDisabled;
  return new AppError('invalid-key', message, { retryable: false, status, cause: body });
}

/** `QuotaFailure.violations[].quotaId` (ex. 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'). */
function quotaIds(body: unknown): string[] {
  const ids: string[] = [];
  for (const d of errorDetails(body)) {
    if (d['@type'] !== 'type.googleapis.com/google.rpc.QuotaFailure') continue;
    const violations = d['violations'];
    if (!Array.isArray(violations)) continue;
    for (const v of violations) {
      if (isRecord(v) && typeof v['quotaId'] === 'string') ids.push(v['quotaId']);
    }
  }
  return ids;
}

/** ms jusqu'au prochain minuit à Los Angeles (remise à zéro des quotas journaliers). */
export function msUntilDailyQuotaReset(nowMs: number = Date.now()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: DAILY_QUOTA_TIME_ZONE,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(nowMs));
    const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const elapsed = (((part('hour') % 24) * 60 + part('minute')) * 60 + part('second')) * 1000 + (nowMs % 1000);
    // Jours de changement d'heure (23 h / 25 h) : au pire une heure d'écart, sans conséquence.
    return Math.max(60_000, DAY_MS - elapsed);
  } catch {
    return CREDIT_RETRY_MS; // fuseaux horaires indisponibles : nouvel essai dans une heure
  }
}

/** 429 d'un quota JOURNALIER : nouvel essai seulement après la remise à zéro. */
function dailyQuotaError(status: number, body: unknown): AppError {
  const nowMs = Date.now();
  const retryAfterMs = msUntilDailyQuotaReset(nowMs) + DAILY_RESET_MARGIN_MS;
  const hour = new Date(nowMs + retryAfterMs).getHours();
  return new AppError('quota', `Quota quotidien Gemini atteint : reprise automatique vers ${hour} h.`, {
    status,
    retryAfterMs,
    cause: body,
  });
}

/** Extrait court (et sûr) du message de l'API, pour les erreurs inattendues. */
function detail(message: string): string {
  const m = message.replace(/\s+/g, ' ').trim();
  if (!m) return '.';
  return ` : ${m.length > 160 ? `${m.slice(0, 159)}…` : m}`;
}

/** Statut HTTP d'erreur → AppError (SPEC §6, api-notes §1.8). */
function httpError(status: number, body: unknown, model: string): AppError {
  const message = apiMessage(body);
  const reason = errorInfoReason(body);
  if (status === 400) {
    if (isKeyProblem(reason, message)) return keyError(reason, status, body);
    return new AppError('other', `Gemini a refusé la requête${detail(message)}`, {
      retryable: false,
      status,
      cause: body,
    });
  }
  if (status === 401 || status === 403) return keyError(reason, status, body);
  // Crédit prépayé épuisé : 402 depuis le 2026-09-18, 429 avec ce message avant.
  if (status === 402 || (status === 429 && /prepayment credits? (are|is) depleted/i.test(message))) {
    return new AppError('quota', MSG.credit, { status, retryAfterMs: CREDIT_RETRY_MS, cause: body });
  }
  if (status === 429) {
    // Quota du jour épuisé : le RetryInfo (quelques secondes) ne vaut que pour la minute en cours.
    if (quotaIds(body).some((id) => /PerDay|Daily/i.test(id))) return dailyQuotaError(status, body);
    const retryAfterMs = retryDelayMs(body);
    return new AppError('quota', MSG.quota, {
      status,
      cause: body,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (status === 404) {
    return new AppError('other', `Modèle Gemini introuvable : « ${model} ». Vérifie son nom dans les réglages.`, {
      retryable: false,
      status,
      cause: body,
    });
  }
  if (status === 408 || status >= 500) return new AppError('network', MSG.network, { status, cause: body });
  return new AppError('other', `Erreur Gemini inattendue (HTTP ${status})${detail(message)}`, {
    retryable: false,
    status,
    cause: body,
  });
}

function isNamedError(e: unknown, name: string): boolean {
  return isRecord(e) && e['name'] === name;
}

/** Échec de fetch() ou de lecture du corps → AppError('network'). */
function transportError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (isNamedError(e, 'TimeoutError')) return new AppError('network', MSG.timeout, { cause: e });
  if (e instanceof TypeError || isNamedError(e, 'AbortError')) {
    return new AppError('network', MSG.network, { cause: e });
  }
  return toAppError(e);
}

function badResponse(message: string, cause?: unknown): AppError {
  return new AppError('bad-response', message, { retryable: true, cause });
}

/* ------------------------------------------------------------------ */
/* Lecture des réponses                                                */
/* ------------------------------------------------------------------ */

/** Texte « réponse » du premier candidat (les parties de réflexion sont ignorées). */
function extractText(candidate: Rec): string {
  const content = candidate['content'];
  const parts = isRecord(content) ? content['parts'] : undefined;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(isRecord)
    .filter((p) => p['thought'] !== true && typeof p['text'] === 'string')
    .map((p) => p['text'] as string)
    .join('');
}

/** JSON objet depuis le texte du modèle (tolère des balises ```json et du texte autour). */
function parseJsonObject(text: string): Rec {
  const fenced = /^\s*```[\w-]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text);
  const cleaned = (fenced?.[1] ?? text).trim();
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        value = JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        value = undefined;
      }
    }
  }
  if (!isRecord(value)) throw badResponse(MSG.unreadable, text.slice(0, 500));
  return value;
}

/** Réponse generateContent → objet JSON produit par le modèle (ou AppError). */
function readGenerateResponse(body: unknown): Rec {
  if (!isRecord(body)) throw badResponse(MSG.unreadable, body);

  const feedback = body['promptFeedback'];
  const blockReason = isRecord(feedback) ? feedback['blockReason'] : undefined;
  if (typeof blockReason === 'string' && blockReason !== '' && blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
    throw new AppError('safety', MSG.safety, { cause: blockReason });
  }

  const candidates = body['candidates'];
  const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
  if (!isRecord(candidate)) throw badResponse(MSG.empty, body);

  const finish = typeof candidate['finishReason'] === 'string' ? candidate['finishReason'] : undefined;
  if (finish && SAFETY_FINISH.has(finish)) throw new AppError('safety', MSG.safety, { cause: finish });
  if (finish === 'PUP_LIMITED_DISABLED') {
    throw new AppError('other', MSG.restricted, { retryable: false, cause: finish });
  }
  if (finish && !OK_FINISH.has(finish)) {
    throw badResponse(finish === 'MAX_TOKENS' ? MSG.truncated : MSG.unreadable, finish);
  }

  const text = extractText(candidate);
  if (!text.trim()) throw badResponse(MSG.empty, body);
  return parseJsonObject(text);
}

/** Corps de réponse : JSON si possible, sinon texte brut. */
async function readBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw transportError(e);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** MIME audio à déclarer à Gemini : sans paramètres, alias normalisés. */
function geminiAudioMime(mime: string): string {
  const base = stripMimeParams(mime) || 'audio/webm';
  return AUDIO_MIME_ALIASES[base] ?? base;
}

/** Analyse d'un texte vide (aucun appel à Gemini). */
function emptyTextAnalysis(): EntryAnalysis {
  return { ...inaudibleAnalysis(), title: EMPTY_TEXT_TITLE };
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export function createGeminiClient(opts: {
  apiKey: string;
  model: string;
  /** 'minimal' | 'low' | 'medium' | 'high' ; undefined = défaut du modèle */
  thinkingLevel?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): AiClient {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new AppError('invalid-key', MSG.noKey, { retryable: false });
  const model = opts.model.trim().replace(/^models\//, '');
  if (!model) throw new AppError('other', MSG.noModel, { retryable: false });

  const thinkingLevel = opts.thinkingLevel?.trim() || undefined;
  const baseUrl = (opts.baseUrl ?? config.geminiBaseUrl).replace(/\/+$/, '');
  const modelUrl = `${baseUrl}/models/${encodeURIComponent(model)}`;
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  // Replis appris par ce client (ne pas répéter une requête déjà refusée).
  let thinkingRejected = false;
  let legacyStructured = false;

  async function send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      const signal = timeoutSignal(timeoutMs);
      return await doFetch(url, signal ? { ...init, signal } : init);
    } catch (e) {
      throw transportError(e);
    }
  }

  function buildRequest(
    parts: RequestPart[],
    schema: JsonSchema,
    withThinking: boolean,
    legacy: boolean,
  ): GenerateContentRequest {
    const generationConfig: GenerationConfig = legacy
      ? { responseMimeType: 'application/json', responseJsonSchema: schema }
      : { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema } } };
    if (withThinking && thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };
    return {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts }],
      generationConfig,
      store: false,
    };
  }

  /** generateContent avec sortie JSON ; gère les replis « réflexion » et « sortie structurée ». */
  async function generate(parts: RequestPart[], schema: JsonSchema): Promise<Rec> {
    let withThinking = thinkingLevel !== undefined && !thinkingRejected;
    let legacy = legacyStructured;
    for (;;) {
      const res = await send(
        `${modelUrl}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(buildRequest(parts, schema, withThinking, legacy)),
        },
        GENERATE_TIMEOUT_MS,
      );
      const body = await readBody(res);
      if (res.ok) {
        const out = readGenerateResponse(body);
        if (legacy) legacyStructured = true;
        return out;
      }
      if (res.status === 400) {
        const message = apiMessage(body);
        if (!isKeyProblem(errorInfoReason(body), message)) {
          // Niveau de réflexion refusé par ce modèle → un seul nouvel essai sans réflexion.
          if (withThinking && /thinking/i.test(message)) {
            withThinking = false;
            thinkingRejected = true;
            continue;
          }
          // Champ de sortie structurée refusé → un seul nouvel essai avec l'ancien couple.
          if (!legacy && STRUCTURED_FIELD_RE.test(message)) {
            legacy = true;
            continue;
          }
        }
      }
      throw httpError(res.status, body, model);
    }
  }

  return {
    async analyzeAudio(audio, mimeType, ctx) {
      if (audio.size > MAX_INLINE_AUDIO_BYTES) {
        throw new AppError('other', MSG.tooLong, { retryable: false });
      }
      if (audio.size === 0) return { transcript: '', analysis: inaudibleAnalysis() };

      const data = await blobToBase64(audio);
      const out = await generate(
        [
          { inlineData: { mimeType: geminiAudioMime(mimeType || audio.type), data } },
          { text: buildAudioRequestText(ctx) },
        ],
        audioSchemaFor(ctx),
      );
      if (typeof out['transcript'] !== 'string') throw badResponse(MSG.noTranscript, out);
      const transcript = normalizeTranscript(out['transcript']);
      if (isInaudibleTranscript(transcript)) return { transcript: '', analysis: inaudibleAnalysis() };
      // Mentions d'autres jours : ancrées dans la transcription renvoyée.
      return { transcript, analysis: normalizeAnalysis(out, ctx, transcript) };
    },

    async analyzeText(text, ctx) {
      if (!text.trim()) return emptyTextAnalysis();
      const out = await generate([{ text: buildTextRequestText(text, ctx) }], textSchemaFor(ctx));
      return normalizeAnalysis(out, ctx, text);
    },

    async synthesizeDay(day, entries, links) {
      const usable = entries.filter((e) => typeof e.transcript === 'string' && e.transcript.trim() !== '');
      if (usable.length === 0) throw new AppError('other', MSG.noEntries, { retryable: false });
      if (!links || links.length === 0) {
        // Sans note d'un autre jour : requête identique à celle d'avant la fonctionnalité.
        const out = await generate([{ text: buildSynthesisRequestText(day, usable) }], SYNTHESIS_SCHEMA);
        return normalizeSynthesis(out);
      }
      const out = await generate(
        [{ text: buildSynthesisRequestText(day, usable, links) }],
        synthesisSchemaFor(links),
      );
      return normalizeSynthesis(out, synthesisRefMap(links));
    },

    async checkKey() {
      const res = await send(
        modelUrl,
        { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
        CHECK_TIMEOUT_MS,
      );
      const body = await readBody(res);
      if (!res.ok) throw httpError(res.status, body, model);
    },
  };
}
