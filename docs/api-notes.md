# Dit Harry — API notes (verified 2026-10-08)

Reference sheet for the **GOOGLE** team (`auth.ts`, `drive.ts`) and the **GEMINI** team
(`gemini.ts`, `prompts.ts`). Everything below was checked against the official docs on
2026-10-08, and where possible **live** with `curl`, using fake credentials only. Each item is
tagged:

- **[LIVE]**: observed on the real endpoint today.
- **[DOC]**: stated in official documentation (sources in §5).
- **[SRC]**: read in Google's own shipped code (`accounts.google.com/gsi/client`, official samples).
- **[REC]**: our recommendation, not a documented fact.

---

## 0. Read this first: surprises and traps

1. **Gemini structured output.** The current field is
   `generationConfig.responseFormat.text = { mimeType, schema }`. `mimeType` is a **proto
   enum**, so send `"APPLICATION_JSON"`. The value `"application/json"` printed in the
   official guide's REST sample is **rejected with HTTP 400** **[LIVE]**. It is **not**
   `{type:'json_schema', jsonSchema:…}` (also rejected, 400 "Unknown name") **[LIVE]**.
   `responseSchema` and `_responseJsonSchema` are marked *deprecated* in the reference
   **[DOC]**, but `responseMimeType + responseJsonSchema` still parses **[LIVE]**. Use it as a
   one-shot fallback (§1.4).
2. **An invalid Gemini key returns HTTP 400**, not 401 or 403: status `INVALID_ARGUMENT` with
   ErrorInfo reason `API_KEY_INVALID` **[LIVE]**. A **missing** key returns **403**
   `PERMISSION_DENIED` **[LIVE]**. Other 400s are ordinary request errors, for example a bad
   schema or bad thinking level. Map a 400 to `invalid-key` **only** when the reason is
   `API_KEY_INVALID`.
3. **Gemini 402 (prepay credit depleted) has `status: "RESOURCE_EXHAUSTED"`**, the same status
   as a 429. Branch on the **HTTP code**, not on `status`. Before 2026-09-18 the same condition
   came back as a **429** whose message contains `prepayment credits are depleted`. Treat that
   message as the 402 case.
4. **Gemini parses the JSON body before it checks the key** **[LIVE]**. With a fake key,
   `API_KEY_INVALID` means "body accepted" and `BadRequest … Cannot find field` means "body
   malformed". That is how the shapes in this file were validated.
5. **`gemini-3.8-flash` rejects `thinkingLevel: "minimal"`.** Valid levels are
   `low | medium (default) | high`. **`gemini-3.5-flash-lite`** accepts
   `minimal (default) | low | medium | high` **[DOC]**.
6. **Gemini CORS exposes only** `vary, content-encoding, date, server, content-length`
   (observed on an error response) **[LIVE]**. Do not rely on reading `Retry-After` from a
   browser. Take the delay from the body
   (`google.rpc.RetryInfo.retryDelay`, e.g. `"55s"`).
7. **`google.accounts.oauth2.revoke()` POSTs to `https://oauth2.googleapis.com/revoke`**
   **[SRC]**. That origin must be in CSP `connect-src` (§4).
8. **Drive `files.create` / `files.update` return only `kind,id,name,mimeType`** unless you pass
   `fields=` **[DOC]**. Always pass
   `fields=id,name,mimeType,createdTime,modifiedTime,size,appProperties`.
9. **Do not set `Content-Length` in `fetch`.** It is a forbidden header, so the browser drops it
   and computes it itself. The official Drive JS snippets set it anyway, and it has no effect.
10. **Resumable upload from a browser works.** The `Location` header of the session start is
    readable cross-origin (Google's own CORS sample calls `getResponseHeader('Location')`)
    **[SRC]**. Send the follow-up `PUT` to the session URI **without** an `Authorization`
    header **[SRC]**.

---

## 1. Gemini API — `generateContent` (v1beta)

### 1.1 Endpoints and headers

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
GET  https://generativelanguage.googleapis.com/v1beta/models/{model}          (models.get → checkKey)

x-goog-api-key: <clé>              ← header, never ?key= in the URL
Content-Type: application/json
```

The CORS preflight allows `content-type,x-goog-api-key` from any origin **[LIVE]**.

Model IDs, both GA and stable **[DOC]**:

| Model ID | Inputs | Input / output token limits | Thinking levels (default **bold**) |
|---|---|---|---|
| `gemini-3.5-flash-lite` | text, image, video, **audio**, PDF | 1,048,576 / 65,536 | **minimal**, low, medium, high |
| `gemini-3.8-flash` | text, image, video, **audio**, PDF | 1,048,576 / 65,536 | low, **medium**, high. `minimal` → **error** |

Both model pages list *Structured outputs: Supported* and *Thinking: Supported*.

### 1.2 Request: voice entry (inline audio + text + system instruction)

```json
{
  "systemInstruction": { "parts": [ { "text": "<SYSTEM_INSTRUCTION>" } ] },
  "contents": [
    {
      "role": "user",
      "parts": [
        { "inlineData": { "mimeType": "audio/webm", "data": "<base64 sans préfixe data:>" } },
        { "text": "<ENTRY_AUDIO_PROMPT>\n\nDate : mercredi 8 octobre 2026, 07:42." }
      ]
    }
  ],
  "generationConfig": {
    "responseFormat": {
      "text": { "mimeType": "APPLICATION_JSON", "schema": { "…": "ENTRY_AUDIO_SCHEMA" } }
    }
  },
  "store": false
}
```

This exact shape parses **[LIVE]**. Notes:

- **JSON naming.** Use camelCase (`inlineData`, `mimeType`, `systemInstruction`). The API also
  accepts snake_case (`inline_data`, `system_instruction`) **[LIVE]**. Pick one style and stick
  to it.
- **`data`.** Standard base64 of the raw bytes. `blobToBase64()` from `util.ts` is correct.
- **Audio MIME types** officially supported **[DOC]**: `audio/wav`, `audio/mp3`, `audio/aiff`,
  `audio/aac`, `audio/ogg`, `audio/flac`, `audio/mpeg`, `audio/m4a`, `audio/l16`, `audio/opus`,
  `audio/alaw`, `audio/mulaw`, **`audio/webm`**. The `Blob.mimeType` reference also says
  `audio/*`. Chrome Android records `audio/webm;codecs=opus`; send `audio/webm` (no
  parameters), as `SPEC.md` already requires. `audio/mp4` is not in the list; `audio/m4a` is.
- **Part order.** The API accepts audio then text, or text then audio. Official samples put the
  text first. This is not critical.
- **Audio facts** **[DOC]**: 32 tokens per second of audio (30 min ≈ 57,600 tokens). The audio is
  downmixed to mono and downsampled to 16 kbps. Maximum 9.5 h of audio per prompt.
- **`store: false`** **[DOC]**. generateContent does not log requests by default, but logging
  can be switched on per project in AI Studio, and `store` on the request takes precedence. Send
  `false` explicitly **[REC]**.
- **Do not send** `temperature`, `topP`, `topK` (deprecated since 2026-07-21) or
  `candidateCount` (unsupported on Gemini 3+) **[DOC]**.
- **Do not set `maxOutputTokens`** **[REC]**. It caps thinking **plus** output tokens. A cap that
  is too low returns `finishReason: MAX_TOKENS` with a truncated JSON body **[DOC]**. The model
  default is the full 65,536.
- **`safetySettings` are not needed.** The default threshold is `OFF` for Gemini 2.5 and 3
  models **[DOC]**. Built-in model safety can still block (§1.7).

#### Inline size limit: the docs disagree

- The *File input methods* page and the 2026-01-08 changelog ("increased from 20MB to 100MB")
  say: **100 MB per request/payload** **[DOC]**.
- The *Audio* page still says: "maximum request size is 20 MB" **[DOC, stale]**.

Base64 inflates the bytes by 4/3. `SPEC.md` guards raw audio above 18 MB, which is about 24 MB of
JSON: under 100 MB, but over the stale 20 MB figure. In practice, 32 kbit/s × 30 min ≈ **7.2 MB
raw ≈ 9.6 MB base64**, which is under both. No change is needed.

### 1.3 Request: text entry and day synthesis

```json
{
  "systemInstruction": { "parts": [ { "text": "<SYSTEM_INSTRUCTION>" } ] },
  "contents": [ { "role": "user", "parts": [ { "text": "<PROMPT>\n\n<texte ou buildSynthesisInput(...)>" } ] } ],
  "generationConfig": {
    "responseFormat": { "text": { "mimeType": "APPLICATION_JSON", "schema": { "…": "SCHEMA" } } },
    "thinkingConfig": { "thinkingLevel": "low" }
  },
  "store": false
}
```

Include `thinkingConfig` **only** when `thinkingLevel` is defined (synthesis → `'low'`). Omit
the key otherwise, which gives the model's default.

### 1.4 Structured output: exact field and fallback

Reference **[DOC]**:
`GenerationConfig.responseFormat: ResponseFormatConfig { text?: TextResponseFormat, audio?, image? }`
and `TextResponseFormat { mimeType: enum MimeType (MIME_TYPE_UNSPECIFIED | APPLICATION_JSON | TEXT_PLAIN), schema: JSON Schema value }`.
`responseSchema` → "Deprecated. Use `responseFormat` instead." `_responseJsonSchema` →
"Deprecated. Use `responseFormat` instead." `responseMimeType` is not marked deprecated in the
REST reference (the JS SDK says it is).

Live parser results, using a fake key (`API_KEY_INVALID` means the body was accepted):

| `generationConfig` fragment | Result |
|---|---|
| `"responseFormat":{"text":{"mimeType":"APPLICATION_JSON","schema":S}}` | ✅ accepted |
| `"responseFormat":{"text":{"mimeType":"application_json","schema":S}}` | ✅ accepted (case-insensitive enum) |
| `"responseFormat":{"text":{"schema":S}}` (no mimeType) | ✅ accepted, but avoid it |
| `"responseFormat":{"text":{"mimeType":"application/json","schema":S}}` (the guide's sample) | ❌ 400 `Invalid value at 'generation_config.response_format.text.mime_type' (…TextResponseFormat.MimeType), "application/json"` |
| `"responseFormat":{"type":"json_schema","jsonSchema":S}` | ❌ 400 `Unknown name "type" / "jsonSchema" at 'generation_config.response_format'` |
| `"responseMimeType":"application/json","responseJsonSchema":S` (legacy) | ✅ accepted |
| `"responseMimeType":"application/json","responseSchema":{OpenAPI}` (legacy) | ✅ accepted |

The parser checks syntax only; semantic support was not testable without a real key.
**[REC]** Send `responseFormat` (enum form). If the API returns **400 `INVALID_ARGUMENT`** with a
message matching `/response_?format|responseFormat|response_mime_type|mime_type/i`, retry
**once** with the legacy pair:

```json
"generationConfig": { "responseMimeType": "application/json", "responseJsonSchema": { "…": "SCHEMA" } }
```

Never send both forms in the same request.

**JSON Schema subset** (unsupported keywords are ignored) **[DOC]**:

- **Types:** `type` = `string | number | integer | boolean | object | array | null`, or an array
  such as `["string","null"]`.
- **object:** `properties`, `required`, `additionalProperties`.
- **string:** `enum`, `format` (`date-time`, `date`, `time`).
- **number / integer:** `enum`, `minimum`, `maximum`.
- **array:** `items`, `prefixItems`, `minItems`, `maxItems`.
- **Descriptive:** `title`, `description`.
- **Composition and references:** `anyOf` / `oneOf` (treated alike), `$defs` / `$ref`.

The output follows **the key order of the schema** **[DOC]**. Put `transcript` before the
analysis fields. Very large or deeply nested schemas may be rejected **[DOC]**.

Example schema fragment, not binding (`prompts.ts` owns the real one):

```json
{
  "type": "object",
  "properties": {
    "transcript": { "type": "string", "description": "Transcription nettoyée, en français." },
    "title":   { "type": "string" },
    "summary": { "type": "string" },
    "mood": {
      "type": "object",
      "properties": {
        "score": { "type": "integer", "enum": [-2, -1, 0, 1, 2] },
        "label": { "type": "string" }
      },
      "required": ["score", "label"]
    },
    "themes": { "type": "array", "items": { "type": "string" }, "maxItems": 5 },
    "people": { "type": "array", "items": { "type": "string" } },
    "places": { "type": "array", "items": { "type": "string" } },
    "todos":  { "type": "array", "items": { "type": "string" } }
  },
  "required": ["transcript", "title", "summary", "mood", "themes", "people", "places", "todos"]
}
```

### 1.5 Thinking

```json
"generationConfig": { "thinkingConfig": { "thinkingLevel": "low" } }
```

- **`ThinkingConfig`** **[DOC]**: `{ includeThoughts?: boolean, thinkingBudget?: integer, thinkingLevel?: enum }`.
- **Enum values:** `THINKING_LEVEL_UNSPECIFIED | MINIMAL | LOW | MEDIUM | HIGH`. The lowercase
  forms `"low"` and `"minimal"` are accepted **[LIVE]**, and the docs use them. A value such as
  `"bogus"` gets 400 `Invalid value at 'generation_config.thinking_config.thinking_level'`
  **[LIVE]**.
- **Per-model levels:** see the §1.1 table. `minimal` on `gemini-3.8-flash` returns an error
  **[DOC]**. The exact message was not testable, so match `/thinking/i` on the 400 message, as
  `SPEC.md` says.
- **`thinkingBudget`:** do not use it. It is for Gemini 2.5; on Gemini 3 it exists only for
  backward compatibility **[DOC]**.
- **Thinking cannot be fully turned off** on 3.x Flash or Flash-Lite. `minimal` is the closest
  setting **[DOC]**.

### 1.6 Response shape and text extraction

Field names from the reference **[DOC]**; values are illustrative:

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          { "text": "{\"transcript\":\"Ce matin…\",\"title\":\"…\"}", "thoughtSignature": "CiQB…" }
        ]
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 1312, "candidatesTokenCount": 402, "thoughtsTokenCount": 180,
    "totalTokenCount": 1894,
    "promptTokensDetails": [ { "modality": "AUDIO", "tokenCount": 1216 }, { "modality": "TEXT", "tokenCount": 96 } ]
  },
  "modelVersion": "gemini-3.5-flash-lite",
  "responseId": "…"
}
```

- **`Part`** fields **[DOC]**: `text`, `inlineData`, …, `thought?: boolean`,
  `thoughtSignature?: string` (base64). Gemini 3 **may attach `thoughtSignature` to any part,
  including the answer's text part**. That is harmless: just read `text`.
- **Thought parts** have `thought: true`. They appear only if `includeThoughts: true`, which we
  never send. Skip them anyway.
- **`finishMessage`:** present when `finishReason` is set.
- **Blocked prompt:** `promptFeedback.blockReason` is set and **`candidates` is absent**
  **[DOC]**.

```ts
interface GeminiPart { text?: string; thought?: boolean; thoughtSignature?: string }
interface GeminiCandidate { content?: { parts?: GeminiPart[]; role?: string }; finishReason?: string; finishMessage?: string }
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
  modelVersion?: string;
}

/** Concatène le texte « réponse » (ignore les parties de réflexion). */
function extractText(resp: GeminiResponse): string {
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}
```

**[REC]** Before `JSON.parse`, defensively strip a leading ```` ```json ```` and a trailing
```` ``` ````. Then validate with `normalizeAnalysis` / `normalizeSynthesis`; structured output
guarantees valid syntax, not correct values **[DOC]**.

### 1.7 Block and finish reasons

- **`BlockReason`** (in `promptFeedback`) **[DOC]**: `SAFETY`, `OTHER`, `BLOCKLIST`,
  `PROHIBITED_CONTENT`, `IMAGE_SAFETY`.
- **`FinishReason`** **[DOC]**: `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `LANGUAGE`,
  `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `MALFORMED_FUNCTION_CALL`, `IMAGE_SAFETY`,
  `IMAGE_PROHIBITED_CONTENT`, `IMAGE_OTHER`, `NO_IMAGE`, `IMAGE_RECITATION`,
  `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `MISSING_THOUGHT_SIGNATURE`,
  `MALFORMED_RESPONSE`, `ESCALATION`, `PUP_LIMITED_DISABLED`.

Mapping (`SPEC.md` + **[REC]** for the cases `SPEC.md` does not list):

| Condition | ErrorKind |
|---|---|
| `promptFeedback.blockReason` set (any value) | `safety` |
| `finishReason` ∈ {SAFETY, PROHIBITED_CONTENT, BLOCKLIST, SPII, RECITATION} | `safety` |
| `finishReason` = `MAX_TOKENS`, or no candidate / empty text / JSON that will not parse | `bad-response` (retryable) **[REC]** |
| `finishReason` ∈ {LANGUAGE, OTHER, MALFORMED_RESPONSE, ESCALATION} | `bad-response` **[REC]** |
| `finishReason` = `PUP_LIMITED_DISABLED` (account limited for policy violation) | `other`, not retryable **[REC]** |

### 1.8 Errors

The body is a `google.rpc.Status` in JSON. Real captures from 2026-10-08 **[LIVE]** follow.

**Invalid key** (both `generateContent` and `models.get` return exactly this):

```json
HTTP/1.1 400 Bad Request
{
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "API_KEY_INVALID",
        "domain": "googleapis.com",
        "metadata": { "service": "generativelanguage.googleapis.com" }
      },
      {
        "@type": "type.googleapis.com/google.rpc.LocalizedMessage",
        "locale": "en-US",
        "message": "API key not valid. Please pass a valid API key."
      }
    ]
  }
}
```

**No key at all:**

```json
HTTP/1.1 403 Forbidden
{ "error": { "code": 403,
  "message": "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
  "status": "PERMISSION_DENIED" } }
```

**Malformed body:**

```json
HTTP/1.1 400 Bad Request
{ "error": { "code": 400,
  "message": "Invalid JSON payload received. Unknown name \"bogusField\" at 'generation_config': Cannot find field.",
  "status": "INVALID_ARGUMENT",
  "details": [ { "@type": "type.googleapis.com/google.rpc.BadRequest",
    "fieldViolations": [ { "field": "generation_config", "description": "Invalid JSON payload received. Unknown name \"bogusField\" at 'generation_config': Cannot find field." } ] } ] } }
```

**429 rate limit** (from Google's `gemini-cli` issue #8437 **[DOC/observed]**):

```json
HTTP/1.1 429 Too Many Requests
{ "error": { "code": 429,
  "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
  "status": "RESOURCE_EXHAUSTED",
  "details": [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure",
      "violations": [ { "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                        "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
                        "quotaDimensions": { "location": "global", "model": "gemini-2.5-flash-preview-image" } } ] },
    { "@type": "type.googleapis.com/google.rpc.Help",
      "links": [ { "description": "Learn more about Gemini API quotas", "url": "https://ai.google.dev/gemini-api/docs/rate-limits" } ] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "55s" } ] } }
```

**402 prepay depleted** (Google staff announcement, 2026-09-18; previously a 429):

```json
HTTP/1.1 402 Payment Required
{ "error": { "code": 402,
  "message": "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing. Learn more at https://ai.google.dev/gemini-api/docs/billing#prepay.",
  "status": "RESOURCE_EXHAUSTED" } }
```

The docs say not to retry 400, 402 or 403, and to retry 408, 429 and 5xx with exponential
backoff plus jitter **[DOC]**.

`retryDelay` is a `google.protobuf.Duration` in JSON: a decimal number of seconds followed by
`s`, e.g. `"3s"`, `"1.500s"`, `"55s"` **[DOC]**.

```ts
function retryDelayMs(body: unknown): number | undefined {
  const details = (body as { error?: { details?: Array<Record<string, unknown>> } } | null)?.error?.details;
  const info = details?.find((d) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
  const raw = info?.['retryDelay'];
  const m = typeof raw === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(raw) : null;
  return m?.[1] !== undefined ? Math.ceil(parseFloat(m[1]) * 1000) : undefined;
}
function errorInfoReason(body: unknown): string | undefined {
  const details = (body as { error?: { details?: Array<Record<string, unknown>> } } | null)?.error?.details;
  const info = details?.find((d) => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
  return typeof info?.['reason'] === 'string' ? info['reason'] : undefined;
}
```

HTTP → `ErrorKind` (`SPEC.md` §6, with the details it leaves open):

| HTTP | `status` / detail | ErrorKind | Note |
|---|---|---|---|
| 400 | ErrorInfo `API_KEY_INVALID` | `invalid-key` (not retryable) | **[LIVE]** |
| 400 | message `/thinking/i` | retry once without `thinkingConfig` | `SPEC.md` |
| 400 | message `/response_?format\|mime_type/i` | retry once with the legacy structured-output pair | **[REC]** §1.4 |
| 400 | `FAILED_PRECONDITION` (e.g. billing or region) or anything else | `other` (not retryable) | **[REC]** |
| 401 | `UNAUTHENTICATED` | `invalid-key` | `SPEC.md` |
| 402 | `RESOURCE_EXHAUSTED` | `quota`: « Crédit Gemini épuisé » | Docs: "Don't retry". **[REC]** use a long `retryAfterMs` (≥ 1 h) |
| 403 | `PERMISSION_DENIED`: no key, `API_KEY_SERVICE_BLOCKED`, `API_KEY_HTTP_REFERRER_BLOCKED`, `SERVICE_DISABLED`, unrestricted standard key | `invalid-key` | Since 2026, unrestricted standard keys are rejected. New AI Studio keys are restricted "auth keys" and work. |
| 404 | `NOT_FOUND` (unknown model ID) | `other`: « Modèle Gemini introuvable : … » (not retryable) | **[REC]**: in `checkKey()`, do **not** report this as a bad key |
| 429 | `RESOURCE_EXHAUSTED` + RetryInfo | `quota`, `retryAfterMs = retryDelayMs(body)` | if the message contains `prepayment credits are depleted`, handle as 402 |
| 5xx | `INTERNAL` / `UNAVAILABLE` / `DEADLINE_EXCEEDED` | `network` | |
| — | `fetch` `TypeError` / `AbortError` | `network` | `toAppError` already handles both |

### 1.9 `checkKey()` → `models.get`

```
GET https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite
x-goog-api-key: <clé>
```

The request body must be empty. With a bad key it returns the same 400 `API_KEY_INVALID` as
above **[LIVE]**. On success it returns a `Model` (fields per the reference **[DOC]**; values
taken from the model page):

```json
{
  "name": "models/gemini-3.5-flash-lite",
  "baseModelId": "gemini-3.5-flash-lite",
  "version": "…",
  "displayName": "Gemini 3.5 Flash-Lite",
  "description": "…",
  "inputTokenLimit": 1048576,
  "outputTokenLimit": 65536,
  "supportedGenerationMethods": ["generateContent", "countTokens", "…"],
  "thinking": true
}
```

---

## 2. Google Identity Services — token model (`google.accounts.oauth2`)

### 2.1 Loading

```ts
function loadGis(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; // auto-hébergement non supporté [DOC]
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('GIS indisponible'));
    document.head.appendChild(s);
  });
}
```

Google Cloud Console → OAuth client "Web application" → **Authorized JavaScript origins**: add
`https://<user>.github.io` (an origin, no path). For development, add **both**
`http://localhost` and `http://localhost:<port>` **[DOC]**.

### 2.2 Minimal ambient types (no `@types` dependency)

Put these in a module file, such as `auth.ts`, because `declare global` requires a module. The
snippets in this file type-check with the project's `tsconfig` flags (`strict`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).

```ts
interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;    // secondes (≈ 3599) — coercer avec Number()
  scope?: string;                  // scopes accordés, séparés par des espaces
  token_type?: string;             // 'Bearer'
  prompt?: string; hd?: string; state?: string;
  error?: string;                  // ex. 'access_denied'
  error_description?: string; error_uri?: string;
}
interface GisNonOAuthError {       // objet Error avec .type [SRC]
  type: 'popup_failed_to_open' | 'popup_closed' | 'missing_required_parameter' | 'unknown' | (string & {});
  message?: string;
}
interface GisOverridableConfig {
  scope?: string; include_granted_scopes?: boolean; prompt?: string; login_hint?: string; state?: string;
}
interface GisTokenClientConfig extends GisOverridableConfig {
  client_id: string;
  scope: string;
  callback: (r: GisTokenResponse) => void;
  error_callback?: (e: GisNonOAuthError) => void;
  hd?: string;
}
interface GisTokenClient { requestAccessToken(overrideConfig?: GisOverridableConfig): void }
interface GisOAuth2 {
  initTokenClient(config: GisTokenClientConfig): GisTokenClient;
  hasGrantedAllScopes(r: GisTokenResponse, firstScope: string, ...restScopes: string[]): boolean;
  hasGrantedAnyScope(r: GisTokenResponse, firstScope: string, ...restScopes: string[]): boolean;
  revoke(accessToken: string, done?: (r: { successful: boolean; error?: string; error_description?: string }) => void): void;
}
declare global { interface Window { google?: { accounts: { oauth2: GisOAuth2 } } } }
```

### 2.3 `initTokenClient(config)`: `TokenClientConfig` [DOC]

| Field | Required | Meaning |
|---|---|---|
| `client_id` | ✔ | OAuth client ID |
| `scope` | ✔ | **Space-delimited** scopes: `config.scopes.join(' ')` |
| `callback` | ✔ | Receives the `TokenResponse`, **for both success and OAuth errors** (`{error:'access_denied'}`) |
| `error_callback` | | Non-OAuth errors: `err.type` ∈ `popup_failed_to_open`, `popup_closed`, `unknown`, plus `missing_required_parameter` **[SRC]** |
| `prompt` | | Default `'select_account'`. `''` = prompt only the first time (the library then sends no `prompt` param **[SRC]**). `'consent'` = always show consent. `'none'` = never show UI. |
| `include_granted_scopes` | | Default `true` |
| `login_hint` | | Email or ID-token `sub`; skips the account chooser. `hint` is a legacy alias **[SRC]** |
| `hd`, `state` | | Not used here |
| `enable_granular_consent`, `enable_serial_consent` | | **Deprecated, no effect.** Granular (per-scope checkbox) consent is always on. |

`requestAccessToken(overrideConfig?)` takes the overridable subset: `scope`,
`include_granted_scopes`, `prompt`, `login_hint`, `state` **[DOC]**. The `callback` cannot be
overridden, so keep a "pending" `{resolve, reject}` slot inside `auth.ts`.

### 2.4 `TokenResponse` [DOC]

`access_token`, `expires_in` (seconds), `hd`, `prompt`, `token_type`, `scope`, `state`, `error`,
`error_description`, `error_uri`.

### 2.5 Helpers [DOC]

```ts
google.accounts.oauth2.hasGrantedAllScopes(tokenResponse, 'https://www.googleapis.com/auth/drive.appdata',
                                                          'https://www.googleapis.com/auth/drive.file'); // boolean
google.accounts.oauth2.revoke(accessToken, (r) => { /* r.successful, r.error ('invalid_token' | 'invalid_request'), r.error_description */ });
```

`hasGrantedAllScopes` parses `tokenResponse.scope`. It returns `false` when `scope` is missing
**[SRC]**. `revoke` → `POST https://oauth2.googleapis.com/revoke` **[SRC]**. An
`invalid_token` result means "already expired or revoked": treat it as success.

### 2.6 Flow sketch (matches `SPEC.md` §4)

```ts
// init(): après loadGis()
client = google.accounts.oauth2.initTokenClient({
  client_id, scope: scopes.join(' '),
  callback: (r) => {
    if (r.error) { pending?.reject(/* AppError('auth', …) */); return; }
    if (!google.accounts.oauth2.hasGrantedAllScopes(r, scopes[0]!, ...scopes.slice(1))) { /* état 'error', rejeter */ return; }
    const expiresAt = Date.now() + Number(r.expires_in ?? 0) * 1000;
    // … puis GET drive/v3/about?fields=user → email/name
  },
  error_callback: (e) => { pending?.reject(/* AppError('auth', e.type === 'popup_failed_to_open' ? 'Popup bloquée…' : 'Connexion annulée.') */); },
});

// signIn(): SYNCHRONE dans le onclick — aucun await avant requestAccessToken
client.requestAccessToken(email ? { prompt: '', login_hint: email } : { prompt: 'consent' });
```

### 2.7 Pitfalls

- **A user gesture is required.** The docs show `requestAccessToken()` inside `onclick`
  **[DOC]**. Chrome blocks popups opened without transient user activation. Call it before any
  `await` in the handler, and have the client created in `init()`.
- **Closing the popup.** "Users may close the account chooser or sign-in windows, in which case
  your callback function won't be invoked" **[DOC]**. Only `error_callback({type:'popup_closed'})`
  fires, detected by polling `popup.closed` **[SRC]**. **[REC]** If a token still arrives after
  a `popup_closed`, accept it: store it and switch to `signed-in`.
- **No refresh token.** Tokens last about 1 h. Getting a new one needs a user gesture **[DOC]**.
- **Consent is remembered** per user and client ID. Use `prompt: 'consent'` to force the screen
  again **[DOC]**.
- **COOP.** GitHub Pages sends no `Cross-Origin-Opener-Policy`, which is fine. Do not add
  `same-origin` (COOP cannot be set through `<meta>` anyway).

---

## 3. Google Drive API v3

### 3.1 Common rules

- **Base URLs:** metadata at `https://www.googleapis.com/drive/v3`; content uploads at
  `https://www.googleapis.com/upload/drive/v3`.
- **Headers:** `Authorization: Bearer <access_token>` on every call, except the `PUT` to a
  resumable session URI.
- **Query strings:** `URLSearchParams` is fine. Drive accepts `+` for spaces (`name+%3d+%27hello%27`)
  **[DOC]**.
- **`fields`:** always pass it. The default for `files.*` is only `kind,id,name,mimeType`, and
  `about.get` **requires** `fields` **[DOC]**.
- **Field types:** `size` is an **int64 string**. Times are RFC 3339 UTC with milliseconds, e.g.
  `"2026-10-08T07:12:04.101Z"`.

```ts
const FILE_FIELDS = 'id,name,mimeType,createdTime,modifiedTime,size,appProperties';
```

### 3.2 `about.get`

```
GET https://www.googleapis.com/drive/v3/about?fields=user
```

```json
{ "user": { "kind": "drive#user", "displayName": "Jean Bachelet", "photoLink": "https://lh3.googleusercontent.com/…",
            "me": true, "permissionId": "01234567890123456789", "emailAddress": "jean@example.com" } }
```

The call works with `drive.appdata` or `drive.file` **[DOC]**. `emailAddress` "may not be
present in certain contexts", so fall back to `''`. `fields=user(displayName,emailAddress)` also
works.

### 3.3 `files.list` (appDataFolder, paginated)

```
GET https://www.googleapis.com/drive/v3/files
      ?spaces=appDataFolder
      &pageSize=1000
      &fields=nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,appProperties)
      &q=trashed%20%3D%20false
      [&pageToken=<nextPageToken>]
```

```json
{
  "nextPageToken": "~!!~AI9FV7Q…",
  "files": [
    { "id": "1aBcD…", "name": "entry-6f1c2b7e-….json", "mimeType": "application/json",
      "createdTime": "2026-10-08T07:12:03.512Z", "modifiedTime": "2026-10-08T07:12:04.101Z",
      "size": "1834", "appProperties": { "kind": "entry", "day": "2026-10-08", "entryId": "6f1c2b7e-…" } }
  ]
}
```

- **Pagination:** loop while `nextPageToken` is present. `pageSize` max is 1000.
- **Bad page token:** if a token is rejected, restart from page 1 **[DOC]**.
- **`size`:** absent for folders.
- **appDataFolder files cannot be trashed** (`notSupportedForAppDataFolderFiles`) **[DOC]**.
  `trashed = false` is harmless; to remove a file, use `DELETE`.

Other `q` forms **[DOC]**:

- `'appDataFolder' in parents`
- `appProperties has { key='kind' and value='entry' }`

### 3.4 Create (multipart, ≤ 5 MB)

```
POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=<FILE_FIELDS>
Authorization: Bearer …
Content-Type: multipart/related; boundary=dh-2f0c…
```

Body: CRLF line endings, **metadata first, media second** **[DOC]**:

```
--dh-2f0c…
Content-Type: application/json; charset=UTF-8

{"name":"entry-6f1c….json","mimeType":"application/json","parents":["appDataFolder"],"appProperties":{"kind":"entry","day":"2026-10-08","entryId":"6f1c…"}}
--dh-2f0c…
Content-Type: application/json

{…contenu du fichier…}
--dh-2f0c…--
```

```ts
function multipart(metadata: object, body: Blob | string, mimeType: string): { body: Blob; contentType: string } {
  const boundary = `dh-${crypto.randomUUID()}`;
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    body: new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      body,
      `\r\n--${boundary}--`,
    ]),
  };
}
// taille réelle (octets UTF-8) pour le seuil 5 Mo :
const byteSize = (b: Blob | string) => (typeof b === 'string' ? new Blob([b]).size : b.size);
```

- **Response:** `200 OK` with the `File` JSON (the requested `fields`).
- **Metadata `mimeType`:** set it explicitly, e.g. `application/json`, `audio/webm`,
  `text/markdown`. Give the name a file extension **[DOC]**.
- **Visible copy (`drive.file`):** use `parents: [folderId]` instead of `['appDataFolder']`.
- **`appProperties` limits** **[DOC]**: at most 30 private properties per app per file, and
  **124 bytes per property (key + value, UTF-8)**. A UUID `entryId` is 7 + 36 = 43 bytes, which
  is fine.

### 3.5 Resumable (> 5 MB): create and update

**1. Start the session.** Use `POST` to create, `PATCH …/files/{id}` to update:

```
POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=<FILE_FIELDS>
   | PATCH https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=resumable&fields=<FILE_FIELDS>
Authorization: Bearer …
Content-Type: application/json; charset=UTF-8
X-Upload-Content-Type: audio/webm          (optionnel)
X-Upload-Content-Length: 7340032           (optionnel)

{"name":"audio-6f1c….webm","mimeType":"audio/webm","parents":["appDataFolder"],"appProperties":{…}}
```

For an update, the body can be empty: omit it and do not send `Content-Type`.

**2. Read the response:**

```
HTTP/1.1 200 OK
Location: https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=xa298sd_sdlkj2
Content-Length: 0
```

Read the session URI with `res.headers.get('Location')`. The body is **empty**. The URI is valid
for **one week** **[DOC]**.

**3. Upload the bytes:**

```
PUT <Location>
Content-Type: audio/webm
<bytes>
```

Send it **without** `Authorization` **[SRC]**. The server replies `200 OK` or `201 Created` with
the `File` JSON **[DOC]**. Use a single request: no `Content-Range` is needed for a one-shot `PUT`.

- **Chunked uploads:** chunks must be multiples of 256 KiB, with
  `Content-Range: bytes a-b/total`; `308` means "continue". This is not needed at our sizes.
- **Interrupted upload or 5xx on `PUT`:** send `PUT <Location>` with an empty body and
  `Content-Range: bytes */<total>`. A `308` response carries a `Range` header (resume after it);
  a `200`/`201` means the upload is done **[DOC]**. **[REC]** It is simpler to restart the whole
  upload on failure.
- **[REC]** Put `fields` on the session-start URL. If the final JSON lacks `modifiedTime`, follow
  up with `GET /drive/v3/files/{id}?fields=<FILE_FIELDS>`.

### 3.6 Replace content (simple media upload)

```
PATCH https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=media&fields=<FILE_FIELDS>
Authorization: Bearer …
Content-Type: application/json            (ou text/markdown, audio/webm…)

<nouveau contenu>
```

The response is `200` with the `File` JSON. The `PATCH` verb is documented for
`files.update` **[DOC]**. A 404 means the file is gone (deleted elsewhere).

### 3.7 Download

```
GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media
Authorization: Bearer …
```

The raw bytes come back with the file's `Content-Type`. Use `res.json()` or `res.blob()`.
`fetch` follows redirects by default; the official `curl` sample uses `-L` **[DOC]**.

### 3.8 Delete (permanent, no trash)

```
DELETE https://www.googleapis.com/drive/v3/files/{fileId}
Authorization: Bearer …
```

Success is a 2xx with an empty body (in practice `204 No Content`; the reference says "empty JSON
object"). **Do not call `res.json()`.** Treat 404 as success, as `SPEC.md` requires. Deleting a
folder also deletes its descendants **[DOC]**.

### 3.9 Folders and query escaping (visible copy, `drive.file`)

**Find a folder:**

```
GET https://www.googleapis.com/drive/v3/files?q=<encodé>&fields=files(id,name)&pageSize=10
q = mimeType = 'application/vnd.google-apps.folder' and name = 'Dit Harry' and trashed = false and 'root' in parents
```

**Create a folder** (metadata only):

```
POST https://www.googleapis.com/drive/v3/files?fields=id
Authorization: Bearer …
Content-Type: application/json; charset=UTF-8

{"name":"Dit Harry","mimeType":"application/vnd.google-apps.folder","parents":["root"]}
```

- **The `root` alias** works "anywhere a file ID is provided" **[DOC]**. Omitting `parents` also
  puts the file at the root of My Drive.
- **Escaping in `q`:** wrap string values in single quotes. Escape `'` as `\'` and `\` as `\\`,
  e.g. `name contains 'quinn\'s paper\\essay'` **[DOC]**. Escape the backslash first:

```ts
const escapeQ = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapeQ(name)}' and trashed = false and '${escapeQ(parentId ?? 'root')}' in parents`;
```

- **Scope:** with only `drive.file`, list results contain **only the files and folders this app
  created or opened** **[DOC]**, which is what `SPEC.md` relies on.
- **Markdown file:** multipart create with metadata
  `{"name":"2026-10-08.md","mimeType":"text/markdown","parents":["<yearFolderId>"]}` and a media
  part `Content-Type: text/markdown`. To update it, use §3.6.
- **Find a file by name:** `name = '2026-10-08.md' and '<parentId>' in parents and trashed = false`.

### 3.10 Errors

The live 401 responses below show that Drive v3 sends **both** the legacy
`errors[].reason` (camelCase) and the modern `status` / `details[]` (ErrorInfo, UPPER_CASE).
**Use `error.errors?.[0]?.reason` as the primary key.**

**401, invalid or expired token** **[LIVE]**. The `WWW-Authenticate` header carries
`error="invalid_token"`.

```json
{ "error": { "code": 401,
  "message": "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
  "errors": [ { "message": "Invalid Credentials", "domain": "global", "reason": "authError",
                "location": "Authorization", "locationType": "header" } ],
  "status": "UNAUTHENTICATED" } }
```

**401, no token** **[LIVE]**:

```json
{ "error": { "code": 401,
  "message": "Request is missing required authentication credential. …",
  "errors": [ { "message": "Login Required.", "domain": "global", "reason": "required",
                "location": "Authorization", "locationType": "header" } ],
  "status": "UNAUTHENTICATED",
  "details": [ { "@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "CREDENTIALS_MISSING",
                 "domain": "googleapis.com",
                 "metadata": { "method": "google.apps.drive.v3.DriveAbout.Get", "service": "drive.googleapis.com" } } ] } }
```

**403 / 429 samples** from the Drive error guide **[DOC]**:

```json
{ "error": { "errors": [ { "domain": "usageLimits", "reason": "rateLimitExceeded", "message": "Rate Limit Exceeded" } ],
             "code": 403, "message": "Rate Limit Exceeded" } }
{ "error": { "errors": [ { "domain": "usageLimits", "reason": "userRateLimitExceeded", "message": "User Rate Limit Exceeded" } ],
             "code": 403, "message": "User Rate Limit Exceeded" } }
{ "error": { "errors": [ { "domain": "global", "reason": "storageQuotaExceeded", "message": "The user's Drive storage quota has been exceeded." } ],
             "code": 403, "message": "The user's Drive storage quota has been exceeded." } }
{ "error": { "errors": [ { "domain": "global", "reason": "notFound", "message": "File not found {fileId}" } ],
             "code": 404, "message": "File not found: {fileId}" } }
{ "error": { "errors": [ { "domain": "usageLimits", "reason": "rateLimitExceeded", "message": "Rate Limit Exceeded" } ],
             "code": 429, "message": "Rate Limit Exceeded" } }
```

| HTTP | `errors[0].reason` | ErrorKind (`SPEC.md` §5) |
|---|---|---|
| 401 | `authError`, `required` | `auth.markExpired()` + `auth` |
| 403 | `rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded` | `quota` |
| 403 | `storageQuotaExceeded` | `other`: « Ton Google Drive est plein » |
| 403 | `insufficientPermissions` (ErrorInfo `ACCESS_TOKEN_SCOPE_INSUFFICIENT`): a scope was unchecked | **[REC]** `auth` (re-consent needed). Not listed in `SPEC.md`. |
| 403 | `appNotAuthorizedToFile`, other | `other` |
| 404 | `notFound` | `other` with `{status:404}` |
| 429 | `rateLimitExceeded` | `quota` |
| 500 / 502 / 503 / 504 | `backendError`, … | `network` |

The Drive quota is 325,000 quota units per minute per user per project **[DOC]**. The docs
recommend truncated exponential backoff: `min(2^n s + jitter, max)`.

### 3.11 CORS (checked from origin `https://example.github.io`) [LIVE]

- **Preflights:** `/drive/v3/files…` (GET, DELETE, PATCH) and `/upload/drive/v3/files…` (POST,
  PATCH) answer `Access-Control-Allow-Methods: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT` and echo
  the requested headers (`authorization`, `content-type`, `x-upload-content-type`,
  `x-upload-content-length`).
- **Exposed headers:** `Access-Control-Expose-Headers` is computed per response. A 401 on the
  upload endpoint exposed
  `Content-Length, Date, Server, Transfer-Encoding, X-GUploader-UploadID, X-Google-Trace, …, www-authenticate`.
  A successful session start exposes `Location`; Google's browser upload sample reads it with
  `getResponseHeader('Location')` **[SRC]**.
- **Not testable:** a preflight against a fake `upload_id` returns 404. A real session URI
  accepts the `PUT`, as Google's browser sample shows.

---

## 4. CSP origins needed (for INFRA, `vite.config.ts`)

```
script-src  'self' https://accounts.google.com/gsi/client
connect-src 'self' https://www.googleapis.com https://generativelanguage.googleapis.com
                   https://oauth2.googleapis.com https://accounts.google.com/gsi/
frame-src   https://accounts.google.com/gsi/
style-src   'self' https://accounts.google.com/gsi/style
media-src   'self' blob:
img-src     'self' data: blob:
```

- **GIS directives** come from the GIS setup guide **[DOC]**: `script-src …/gsi/client`,
  `connect-src` / `frame-src https://accounts.google.com/gsi/`, `style-src …/gsi/style`.
- **`oauth2.googleapis.com`** is used by `revoke()` **[SRC]**.
- **Drive uploads and downloads,** including session URIs, all live on `www.googleapis.com`.

---

## 5. Sources

**Gemini:**

- https://ai.google.dev/gemini-api/docs/generate-content/structured-output — `responseFormat.text` samples (note: their `"application/json"` is rejected live)
- https://ai.google.dev/api/generate-content — `GenerationConfig`, `ResponseFormatConfig`, `TextResponseFormat.MimeType`, `ThinkingConfig`, `ThinkingLevel`, `Part`, `Blob`, `Candidate`, `FinishReason`, `PromptFeedback`, `BlockReason`, `UsageMetadata`, `store`
- https://ai.google.dev/gemini-api/docs/generate-content/thinking — thinking-level × model table
- https://ai.google.dev/gemini-api/docs/latest-model — 3.8 Flash: default `medium`, `minimal` unsupported
- https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite and …/gemini-3.8-flash — model IDs and limits
- https://ai.google.dev/gemini-api/docs/generate-content/audio — supported audio MIME types, 32 tokens/s, (stale) 20 MB
- https://ai.google.dev/gemini-api/docs/generate-content/file-input-methods — inline 100 MB per payload
- https://ai.google.dev/gemini-api/docs/changelog — 2026-01-08 (20→100 MB), 2026-07-21 (sampling params deprecated), 2026-09-02 (3.8 Flash GA)
- https://ai.google.dev/api/models — `models.get`, `Model`
- https://ai.google.dev/gemini-api/docs/troubleshooting — retry policy (400 / 402 / 403: do not retry)
- https://ai.google.dev/gemini-api/docs/billing — prepay depleted → HTTP 402
- https://discuss.ai.google.dev/t/api-update-depleted-prepay-credits-now-return-http-402-instead-of-429/183654 — 402 body (2026-09-18)
- https://github.com/google-gemini/gemini-cli/issues/8437 — real 429 body with `RetryInfo`
- https://ai.google.dev/gemini-api/docs/api-key — unrestricted standard keys rejected; auth keys
- https://ai.google.dev/gemini-api/docs/logs-datasets — `store`
- https://ai.google.dev/gemini-api/docs/safety-settings — default threshold `OFF`
- https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto — ErrorInfo reasons
- https://github.com/googleapis/googleapis/blob/master/google/rpc/error_details.proto and https://protobuf.dev/reference/protobuf/google.protobuf/#duration — `RetryInfo` / Duration JSON

**Google Identity Services:**

- https://developers.google.com/identity/oauth2/web/reference/js-reference
- https://developers.google.com/identity/oauth2/web/guides/use-token-model
- https://developers.google.com/identity/oauth2/web/guides/error
- https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid — origins, CSP, COOP
- https://accounts.google.com/gsi/client — live library, inspected for `revoke` URL, error types, `prompt` / `hint` handling

**Drive v3:**

- https://developers.google.com/workspace/drive/api/guides/manage-uploads
- https://developers.google.com/workspace/drive/api/guides/appdata
- https://developers.google.com/workspace/drive/api/guides/search-files and …/ref-search-terms — `q` syntax and escaping
- https://developers.google.com/workspace/drive/api/guides/folder — folders, `root` alias
- https://developers.google.com/workspace/drive/api/guides/properties — `appProperties` limits
- https://developers.google.com/workspace/drive/api/guides/fields-parameter
- https://developers.google.com/workspace/drive/api/guides/manage-downloads
- https://developers.google.com/workspace/drive/api/guides/handle-errors
- https://developers.google.com/workspace/drive/api/guides/limits
- https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get, …/User, …/files/list, …/files/create, …/files/update, …/files/get, …/files/delete
- https://github.com/googleworkspace/drive-utils/blob/main/upload/upload.js — Google's browser CORS resumable sample (reads `Location`, `PUT` without auth)

FYI, out of scope: since 2026-08-26 Google also offers dedicated speech-to-text models
(`gemini-3.5-transcribe`). `SPEC.md` keeps the single-call `generateContent` design, and nothing
here requires changing it.
