# Dit Harry — Spécification technique (v1)

Journal intime vocal personnel. PWA statique (GitHub Pages), connexion Google, stockage
Google Drive (dossier caché `appDataFolder` + copie Markdown visible), Gemini pour la
transcription, l'analyse et les synthèses. Utilisateur unique, francophone, **Android (Chrome)**.

Le contrat de types est dans [`src/lib/types.ts`](../src/lib/types.ts) ; les erreurs dans
[`src/lib/errors.ts`](../src/lib/errors.ts) ; utilitaires partagés dans
[`src/lib/util.ts`](../src/lib/util.ts) ; configuration dans [`src/config.ts`](../src/config.ts) ;
assemblage dans [`src/lib/services.ts`](../src/lib/services.ts).
**Ces 5 fichiers sont figés** : ne pas les modifier. Si un changement est indispensable, le
signaler dans le compte rendu au lieu de l'appliquer.
Seule évolution depuis (rétrocompatible) : `types.ts` ajoute `AccountConflict` et le champ
facultatif `SyncStatus.accountConflict` (garde-fou de compte Google, §8 étape 0).

## 1. Décisions produit (validées par l'utilisateur)

| Sujet | Décision |
|---|---|
| Mode d'interaction | **Dictée** : j'enregistre, Gemini transcrit + analyse. Pas de conversation. |
| Analyse par entrée | transcription nettoyée, titre, résumé, humeur (-2..+2 + libellé), thèmes, personnes, lieux, choses à faire |
| Synthèse du jour | générée **automatiquement à la première ouverture d'un jour suivant** (jamais le jour même automatiquement) ; bouton manuel « Générer maintenant » disponible |
| Audio | conservé dans Drive **365 jours glissants** (réglable), puis supprimé |
| Saisie clavier | oui (entrée « texte ») |
| Correction de transcription | oui → ré-analyse automatique à partir du texte corrigé |
| Sauvegarde | **les deux** : export zip manuel + copie Markdown automatique dans un dossier Drive visible « Dit Harry » |
| Rappels | aucun |
| Confidentialité Gemini | offre gratuite acceptée par l'utilisateur |
| Plateforme | Android / Chrome uniquement (iOS non ciblé) |
| Langue | interface et contenus **en français** |
| Verrouillage | facultatif : empreinte (clé d'accès de plateforme) + phrase de secours obligatoire, propre à l'appareil, délai 1 min par défaut (§15) |

## 2. Architecture & propriété des fichiers

```
src/
  config.ts            (figé)        configuration publique
  main.ts              UI            montage + enregistrement du service worker
  App.svelte           UI            shell, routage hash, garde d'auth
  app.css              UI            styles globaux, thèmes clair/sombre
  components/*.svelte  UI            écrans et composants
  lib/
    types.ts           (figé)        contrat
    errors.ts          (figé)        AppError
    util.ts            (figé)        dates, ids, signature, base64…
    app.svelte.ts      UI            contrôleur réactif (runes) utilisé par les composants
    install.svelte.ts  UI            installation PWA : beforeinstallprompt, état réactif
    install.ts         UI            installation PWA : règles de décision pures
    lock.ts            UI            verrou : règles pures, WebAuthn (vérification locale), PBKDF2
    lock.svelte.ts     UI            verrou : état réactif, verrouillage automatique, cérémonies
    passkey.ts         UI            verrou : accès à navigator.credentials (réel ou démo)
    db.ts              CORE          IndexedDB (createLocalDb)
    settings.ts        CORE          réglages : défauts, chargement, sauvegarde, fusion
    sync.ts            CORE          moteur de synchronisation (createSyncEngine)
    auth.ts            GOOGLE        Google Identity Services (createGoogleAuth)
    drive.ts           GOOGLE        Drive REST v3 (createDriveClient)
    gemini.ts          GEMINI        Gemini REST (createGeminiClient)
    prompts.ts         GEMINI        prompts français + schémas JSON
    recorder.ts        MEDIA         MediaRecorder (createVoiceRecorder)
    markdown.ts        MEDIA         rendu Markdown d'un jour (renderDayMarkdown)
    zip.ts             MEDIA         écriture zip « store » (createZip)
    backup.ts          MEDIA         export zip manuel (buildExportZip, downloadBlob)
    services.ts        (figé)        createServices() : réel ou mock
    mock/*.ts          INFRA         auth / drive / gemini / recorder / clé d'accès simulés
public/
  sw.js, manifest.webmanifest, icons/*        INFRA
  screenshots/*.png                           INFRA  captures du manifeste (mode démo)
scripts/gen-icons.mjs                         INFRA
.github/workflows/deploy.yml                  INFRA
README.md, docs/SETUP.md                      INFRA
tests/*.test.ts                               chaque équipe teste ses modules
```

### Signatures exportées (contrat entre équipes)

```ts
// db.ts
export function createLocalDb(name?: string /* défaut 'dit-harry' */): LocalDb;
// Lectures-modifications-écritures sérialisées (contrôleur ET synchro), jamais d'appel réseau
// dedans. Seule imbrication permise : withEntryLock → withKvLock/updateKv (jamais l'inverse).
export function withKvLock<T>(db: LocalDb, fn: () => Promise<T>): Promise<T>;
export function updateKv<T>(db: LocalDb, key: string, fn: (current: unknown) => T): Promise<T>;
export function withEntryLock<T>(db: LocalDb, fn: () => Promise<T>): Promise<T>;
export function updateEntry(db: LocalDb, id: string,
  fn: (cur: LocalEntry) => LocalEntry | null): Promise<LocalEntry | undefined>;

// settings.ts
export const DEFAULT_SETTINGS: Settings;               // updatedAt = '1970-01-01T00:00:00.000Z'
export function loadSettings(db: LocalDb): Promise<Settings>;           // kv 'settings' ∪ défauts
export function saveSettings(db: LocalDb, patch: Partial<Settings>): Promise<Settings>;
//   → updatedAt = now, écrit kv 'settings', positionne kv 'sync.settingsDirty' = true
export function mergeSettings(local: Settings, remote: Settings): Settings; // LWW sur updatedAt

// sync.ts
export interface SyncDeps {
  db: LocalDb;
  drive: DriveClient;
  auth: Pick<AuthService, 'getToken' | 'markExpired'>;
  createAi: (settings: Settings, which: 'entry' | 'synthesis') => AiClient;
  now?: () => Date;
  isOnline?: () => boolean;
}
export function createSyncEngine(deps: SyncDeps): SyncEngine;
export function pendingCountOf(entries: LocalEntry[]): number;
export const KV_DEVICE_OWNER: 'device.ownerEmail';
/** Entrées, synthèses, suppressions en attente ou trace d'une synchro passée (réglages exclus). */
export function hasLocalJournal(db: LocalDb): Promise<boolean>;

// auth.ts
export function createGoogleAuth(opts: { clientId: string; scopes: readonly string[] }): AuthService;

// drive.ts
export function createDriveClient(
  auth: Pick<AuthService, 'getToken' | 'markExpired'>,
  fetchImpl?: typeof fetch,
): DriveClient;

// gemini.ts
export function createGeminiClient(opts: {
  apiKey: string;
  model: string;
  /** 'minimal' | 'low' | 'medium' | 'high' ; undefined = défaut du modèle */
  thinkingLevel?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): AiClient;
/** ms jusqu'au prochain minuit à Los Angeles (remise à zéro des quotas journaliers). */
export function msUntilDailyQuotaReset(nowMs?: number): number;

// prompts.ts
export const ENTRY_AUDIO_PROMPT: string; export const ENTRY_TEXT_PROMPT: string;
export const SYNTHESIS_PROMPT: string;  export const SYSTEM_INSTRUCTION: string;
export const ENTRY_AUDIO_SCHEMA: object; export const ENTRY_TEXT_SCHEMA: object;
export const SYNTHESIS_SCHEMA: object;
export function buildSynthesisInput(day: DayKey, entries: Entry[]): string;
export function normalizeAnalysis(raw: unknown): EntryAnalysis;      // valide + borne les valeurs
export function normalizeSynthesis(raw: unknown): Pick<DaySynthesis,'summary'|'mood'|'highlights'|'themes'|'todos'>;

// recorder.ts
export function pickRecordingMimeType(isTypeSupported: (t: string) => boolean): string;
export function createVoiceRecorder(db: LocalDb, opts?: {
  audioBitsPerSecond?: number; maxDurationSec?: number; timesliceMs?: number;
}): VoiceRecorder;

// markdown.ts
export function renderDayMarkdown(day: DayKey, entries: Entry[], synthesis?: DaySynthesis): string;

// zip.ts
export function createZip(files: { path: string; data: Uint8Array | string; date?: Date }[]): Blob;

// backup.ts
export function buildExportZip(db: LocalDb, now?: Date): Promise<{ blob: Blob; filename: string }>;
export function downloadBlob(blob: Blob, filename: string): void;

// services.ts (déjà écrit — figé)
export function createAiFromSettings(settings: Settings, which: 'entry' | 'synthesis'): AiClient;
export function createServices(): Promise<Services>;

// mock/index.ts (INFRA)
export function createMockServices(): Promise<Services>;

// lock.ts / lock.svelte.ts / passkey.ts (verrou, §15)
export function verifyAssertion(a: PasskeyAssertion, x: AssertionExpectations): Promise<AssertionCheck>;
export function ecdsaDerToRaw(der: Uint8Array, size?: number): Uint8Array;
export function hashPassphrase(p: string, opts?: { iterations?: number; salt?: Uint8Array }): Promise<PassphraseHash>;
export function verifyPassphrase(p: string, stored: PassphraseHash): Promise<boolean>;
export class LockController { constructor(deps: LockDeps); /* … */ }
export function createLockEnvironment(): Promise<{ authenticator: PasskeyAuthenticator; flagKey: string }>;
// app.svelte.ts : new AppController(services, { authenticator?, lockFlagKey? }) → `app.lock`
```

## 3. Stockage

### 3.1 Drive — `appDataFolder` (scope `drive.appdata`, caché)

Fichiers à plat (pas de sous-dossiers), `appProperties` pour les retrouver :

| Fichier | MIME | appProperties |
|---|---|---|
| `entry-<id>.json` | application/json | `{kind:'entry', day, entryId}` |
| `audio-<id>.<ext>` | MIME audio sans paramètres | `{kind:'audio', day, entryId}` |
| `day-<YYYY-MM-DD>.json` | application/json | `{kind:'synthesis', day}` |
| `settings.json` | application/json | `{kind:'settings'}` |

Le JSON d'une entrée = `Entry` **sans** le champ `local`. Synthèse = `DaySynthesis` sans `local`.

### 3.2 Drive — copie visible (scope `drive.file`)

`Mon Drive/Dit Harry/<YYYY>/<YYYY-MM-DD>.md` (text/markdown). Créée et mise à jour par l'appli
uniquement. Un jour qui n'a plus ni entrée ni synthèse → son fichier est supprimé.

### 3.3 IndexedDB (`dit-harry`)

Stores : `entries` (clé `id`, index `day`), `syntheses` (clé `day`), `audio` (clé = entryId,
valeur Blob), `chunks` (clé composite `[recordingId, index]`, index `recordingId`), `kv`.

Clés `kv` réservées :

| Clé | Contenu | Propriétaire |
|---|---|---|
| `settings` | `Settings` | settings.ts |
| `sync.settingsDirty` | boolean | settings.ts / sync.ts |
| `sync.settingsFileId` / `sync.settingsModifiedTime` | string | sync.ts |
| `sync.lastSyncAt` | ISODate | sync.ts |
| `sync.pendingDeletes` | `string[]` (ids de fichiers Drive à supprimer) | sync.ts + contrôleur |
| `sync.forceSynthesisDays` | `DayKey[]` (synthèse demandée manuellement) | sync.ts + contrôleur |
| `sync.lastHousekeeping` | DayKey | sync.ts |
| `mirror.state` | `{ rootId?: string; yearIds: Record<string,string>; days: Record<DayKey,{fileId:string; sig:string}> }` | sync.ts |
| `sync.synthesisBackoff` | `Record<DayKey,{sig; attempts; retryAfter}>` (interne) | sync.ts |
| `device.ownerEmail` | email du compte Google à qui appartiennent les données de l'appareil (posé au premier cycle connecté d'un appareil vierge ; effacé par `clearAll`) | sync.ts + contrôleur |
| `lock.config` | `LockConfig` du verrou (§15) — propre à l'appareil, **jamais** envoyé à Drive | lock.svelte.ts |
| `lock.attempts` | `{ failures, retryAt }` : phrases de secours fausses (survit au redémarrage) | lock.svelte.ts |

L'auth persiste dans `localStorage` (`dh.auth.email`, `dh.auth.name`) et le jeton dans
`sessionStorage` (`dh.auth.token` = `{token, expiresAt}`) — jamais dans IndexedDB.
Le verrou pose `dh.lock.enabled = '1'` dans `localStorage` (lu de façon synchrone au démarrage ;
`dh.lock.enabled.<base>` pour une autre base que `dit-harry`, ex. la démo) ; `clearAll()` le
retire avec la base.

`navigator.storage.persist()` est demandé au démarrage (contrôleur).

## 4. Authentification (auth.ts)

- Google Identity Services, **token model** : `google.accounts.oauth2.initTokenClient`.
  Script `https://accounts.google.com/gsi/client` chargé dynamiquement par `init()`
  (attendre `onload`; état `loading` jusque-là). Pas de backend → pas de refresh token.
- Scopes : `config.scopes` (drive.appdata + drive.file). Pas d'openid : après obtention du
  jeton, `signIn()` appelle lui-même `GET https://www.googleapis.com/drive/v3/about?fields=user`
  pour remplir `email`/`name` (mémorisés dans `localStorage`).
- `signIn()` : appelé **synchroniquement** dans le gestionnaire de clic. Le client GIS est
  initialisé dans `init()` pour que `requestAccessToken()` parte dans le même tick.
  Premier passage : `prompt: 'consent'` si aucun email mémorisé ; sinon `prompt: ''` +
  `login_hint: email` (popup qui se referme seule).
- Après chaque réponse : vérifier `google.accounts.oauth2.hasGrantedAllScopes(resp, ...scopes)` ;
  si un scope manque (consentement granulaire) → état `error` avec message français expliquant
  qu'il faut cocher les deux autorisations, et rejeter.
- `error_callback` (popup fermée/bloquée) → rejeter avec AppError('auth', message FR), état
  `expired` si email connu, sinon `signed-out`.
- `expires_in` → `expiresAt = Date.now() + expires_in*1000`. `getToken()` renvoie null si
  `Date.now() > expiresAt - config.tokenExpiryMarginMs` et passe l'état à `expired`.
- Au démarrage : jeton `sessionStorage` encore valide → `signed-in` ; email connu mais pas de
  jeton → `expired` ; sinon `signed-out`.
- `signOut()` : `google.accounts.oauth2.revoke(token)`, efface localStorage/sessionStorage auth,
  état `signed-out`. (Le contrôleur décide d'effacer ou non la base locale.)
- Si `clientId` vide : état `error` « Identifiant client Google manquant (VITE_GOOGLE_CLIENT_ID) ».

## 5. Drive (drive.ts)

- REST v3 via `fetch`, en-tête `Authorization: Bearer <token>` obtenu par `auth.getToken()`
  à chaque appel ; pas de jeton → `AppError('auth')`.
- `listAppData` : `GET /drive/v3/files?spaces=appDataFolder&pageSize=1000&fields=nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size,appProperties)&q=trashed=false`, pagination.
- Création : `POST /upload/drive/v3/files?uploadType=multipart&fields=...` avec
  `parents:['appDataFolder']` ; si le corps > 5 Mo → `uploadType=resumable` (session puis PUT).
- `updateFileContent` : `PATCH /upload/drive/v3/files/{id}?uploadType=media` (resumable si > 5 Mo).
- Téléchargement : `GET /drive/v3/files/{id}?alt=media`.
- `deleteFile` : `DELETE /drive/v3/files/{id}` (404 = succès).
- `ensureFolder(name, parentId?)` : chercher `mimeType='application/vnd.google-apps.folder' and name='<échappé>' and trashed=false and '<parent|root>' in parents` (avec drive.file, seuls les
  dossiers créés par l'appli sont visibles) ; sinon créer.
- `upsertTextFile` : si `existingId` → PATCH contenu ; si 404 → créer ; sinon chercher par nom
  dans le parent, puis créer (multipart).
- Mapping erreurs : 401 → `auth.markExpired()` + `AppError('auth')` ; 403 `rateLimitExceeded` /
  `userRateLimitExceeded` / 429 → `quota` ; 403 `storageQuotaExceeded` → `other` (« Ton Google
  Drive est plein ») ; 404 → `AppError('other', …, {status:404})` ; 5xx → `network` ;
  `TypeError` fetch → `network`.

## 6. Gemini (gemini.ts + prompts.ts)

- Endpoint : `POST {baseUrl}/models/{model}:generateContent`, en-tête `x-goog-api-key`.
  **generateContent** (ne stocke pas les requêtes). Pas d'Interactions API, pas de Files API :
  audio envoyé **inline en base64** (`inlineData`), MIME **sans paramètres** (`audio/webm`).
  Garde-fou : si l'audio dépasse 18 Mo → `AppError('other', 'Enregistrement trop long…')`.
- Sortie structurée JSON via le champ **actuel** de l'API (voir `docs/api-notes.md`), avec les
  schémas de `prompts.ts`. Ne jamais envoyer `temperature`, `topP`, `topK`, `candidateCount`.
- Réflexion : `thinkingLevel` optionnel ; entrée → non envoyé (défaut du modèle) ; synthèse →
  `'low'`. Si l'API répond 400 en mentionnant la réflexion/thinking → réessayer une fois sans.
- Modèles par défaut : entrée `gemini-3.5-flash-lite`, synthèse `gemini-3.8-flash`
  (modifiables dans les réglages).
- Prompts (français) :
  - **Audio** : transcrire fidèlement en français ; nettoyer (supprimer « euh », hésitations,
    faux départs, répétitions involontaires), ponctuer, paragraphes ; **ne pas reformuler, ne
    pas résumer, garder les mots et le style de l'auteur**. Si l'audio est vide/inaudible :
    transcript `''` et titre « Enregistrement inaudible ».
  - **Analyse** : `title` ≤ 8 mots ; `summary` 1 à 3 phrases **à la première personne** ;
    `mood.score` entier -2..2 et `mood.label` 1 à 3 mots (ex. « serein », « fatigué mais
    content ») ; `themes` 1–5 mots courts en minuscules ; `people` prénoms/noms cités ;
    `places` lieux cités ; `todos` intentions/actions à faire mentionnées, à l'infinitif.
    Ne rien inventer : listes vides si rien.
  - **Synthèse du jour** : entrée = liste horodatée (heure, titre, transcription) ;
    `summary` 3 à 6 phrases à la première personne ; `mood` global ; `highlights` 2–5 moments
    forts ; `themes` ; `todos` consolidés et dédoublonnés.
  - Contexte : date en toutes lettres + heure de l'entrée.
- `normalizeAnalysis` / `normalizeSynthesis` : tolèrent champs manquants (listes vides,
  `mood` neutre `{score:0,label:'neutre'}`), bornent le score, tronquent les chaînes trop longues,
  suppriment doublons et chaînes vides.
- Erreurs : 400 `API_KEY_INVALID` / 401 / 403 → `invalid-key` (non retentable) ; 402 → `quota`
  (« Crédit Gemini épuisé ») ; 429 → `quota` (retryAfterMs depuis `RetryInfo.retryDelay`) —
  sauf quota **journalier** (`QuotaFailure.violations[].quotaId` contenant `PerDay`/`Daily`) :
  `retryAfterMs` = jusqu'au prochain minuit heure du Pacifique + 5 min, message « Quota quotidien
  Gemini atteint : reprise automatique vers H h. » ; 403 `API_KEY_HTTP_REFERRER_BLOCKED` →
  message qui indique l'ORIGINE à autoriser (« https://…/* » : le navigateur n'envoie pas le chemin) ;
  5xx → `network` ; `promptFeedback.blockReason` ou `finishReason` ∈ {SAFETY, PROHIBITED_CONTENT,
  BLOCKLIST, SPII, RECITATION} → `safety` (non retentable automatiquement) ; JSON illisible →
  `bad-response` (retentable) ; `TypeError` → `network`.
- `checkKey()` : `GET {baseUrl}/models/{model}` avec la clé.

## 7. Enregistrement (recorder.ts)

- `pickRecordingMimeType` : premier supporté parmi `audio/webm;codecs=opus`, `audio/webm`,
  `audio/mp4;codecs=mp4a.40.2`, `audio/mp4`, `audio/ogg;codecs=opus` ; sinon `''` (défaut navigateur).
- `getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}})`.
  Refus → `AppError('other', 'Accès au micro refusé…', {retryable:false})` ; pas de micro → message dédié.
- `MediaRecorder` avec `audioBitsPerSecond` (32 kbit/s) et `timeslice` (5 s) : chaque morceau est
  écrit dans le store `chunks` **au fil de l'eau** (récupération après crash).
- Niveau sonore via `AudioContext` + `AnalyserNode` (RMS lissé 0..1, ~20 Hz) → `onLevel`.
- `onTick` chaque seconde. Limite `maxDurationSec` (30 min) → arrêt auto (`interrupted:true`).
- **Wake Lock** écran pendant l'enregistrement (`navigator.wakeLock.request('screen')`, échec
  silencieux), ré-acquis au retour au premier plan, relâché à l'arrêt.
- Passage en arrière-plan (`visibilitychange` → hidden) ou piste terminée (`track.onended`) →
  arrêt auto, résultat livré via `onAutoStop` (`interrupted:true`).
- `stop()` : attend le dernier `dataavailable` + `stop`, assemble `Blob` (type = MIME sans
  paramètres), arrête **toutes les pistes**, ferme l'AudioContext. **Ne supprime pas** les
  morceaux (le contrôleur le fait après avoir enregistré l'entrée).
- `cancel()` : arrête tout et supprime les morceaux.
- Durée = horloge écoulée (pas `audio.duration`, souvent `Infinity` pour du WebM live).

## 8. Synchronisation (sync.ts)

`run()` : une seule exécution à la fois ; un appel pendant une exécution programme **une**
ré-exécution à la fin. Étapes, dans l'ordre :

0. **Compte** (en ligne + jeton) — `drive.about()` (une fois par jeton) donne l'email du jeton ;
   comparé (sans casse) à `kv device.ownerEmail`. Pas de propriétaire et `hasLocalJournal` faux
   → le compte est adopté. Propriétaire différent, ou données locales sans propriétaire →
   **conflit** : `status.accountConflict = { owner?, current }`, aucune étape distante (2→6), aucun
   téléchargement d'audio ; l'analyse (1) continue. Le conflit disparaît avec le jeton. Email vide
   → erreur notée, étapes distantes suspendues. Garde-fou : chaque appel Drive (hors `about`)
   vérifie que le jeton courant est celui vérifié ; sinon arrêt des étapes distantes (sans
   `markExpired`) et nouveau cycle (le compte est revérifié). Les données d'un compte ne partent
   jamais dans le Drive d'un autre ; aucune suppression n'est déduite du Drive d'un autre compte.
1. **Analyse** (si `navigator.onLine` et clé Gemini non vide) — entrées `needsAnalysis` dont
   `retryAfter` est passé (ou `force`), plus récentes d'abord :
   - voix : audio depuis `db.getAudio(id)` ; sinon, si `audioFileId` et jeton → télécharger ;
     sinon erreur « audio introuvable ». Si `transcriptEdited` → `analyzeText(transcript)`, sinon
     `analyzeAudio` (remplace `transcript`).
   - texte : `analyzeText(transcript)`.
   - succès : `analysis`, `analysisModel`, `analyzedAt`, **`updatedAt = now`**, `needsAnalysis=false`,
     `attempts=0`, erreur effacée, `dirty=true`.
   - échec : `attempts++`, `error`, `errorKind`, `retryAfter = now + min(1 h, 30 s × 2^(attempts+1))`
     (ou `retryAfterMs`). `invalid-key` → arrêter l'étape, `needsKey=true`. `quota`/`network` →
     arrêter l'étape, **sans** `attempts++` (échec passager : seul le délai s'applique — un quota
     journalier ne doit pas user les essais). `safety` → pas de retry auto (`retryAfter` lointain :
     +100 ans), retry manuel possible. Au-delà de 5 tentatives → plus de retry auto.
     Même règle pour les synthèses (`sync.synthesisBackoff`).
   - Toute lecture-modification-écriture d'une entrée (synchro ou contrôleur) passe par
     `withEntryLock`/`updateEntry` : une correction de l'utilisateur n'est jamais écrasée.
2. **Pull** (jeton requis ; sinon `needsAuth=true` et on saute 2→6) — `listAppData()` :
   - `settings` : si `modifiedTime` ≠ connu → télécharger → `mergeSettings`.
   - entrées : distante inconnue → créer en local (`needsAnalysis = !analysis`, `dirty=false`) ;
     connue avec `modifiedTime` différent → si locale non `dirty` → prendre la distante (garder
     `local.hasLocalAudio`) ; si `dirty` → LWW sur `updatedAt` (égalité → garder la locale).
   - entrée locale avec `driveFileId`, non `dirty`, absente à distance → supprimée ailleurs →
     supprimer en local (+ audio local). Si `dirty` → oublier `driveFileId` (sera recréée).
   - synthèses : même logique, clé `day`.
3. **Push** :
   - `sync.pendingDeletes` → `deleteFile` chacun (retirer de la liste au succès).
   - audio : entrées voix avec `hasLocalAudio` et sans `audioFileId` → `createAppDataFile`
     → `audioFileId` ; `dirty=true` **sans** modifier `updatedAt` (champ technique).
   - entrées `dirty` → update (ou create si pas d'id / 404) → `driveFileId`,
     `remoteModifiedTime`, `dirty=false`. Entrée disparue localement pendant l'envoi → seul un
     fichier **créé** par cet envoi va dans `pendingDeletes` (l'id existant a déjà été mis en
     attente par celui qui a supprimé l'entrée ; s'il ne l'a pas été — base effacée pendant
     l'envoi —, le supprimer effacerait une entrée intacte de tous les appareils). Idem synthèses.
   - audio local supprimé (`deleteAudio`, `hasLocalAudio=false`) quand `audioFileId` est défini
     **et** `needsAnalysis=false`.
   - synthèses `dirty`, réglages si `sync.settingsDirty`.
4. **Synthèse** (clé Gemini + en ligne) — jours candidats : `day < aujourd'hui` **ou** dans
   `sync.forceSynthesisDays`, ayant ≥ 1 entrée analysée et **aucune** entrée encore en attente
   d'analyse retentable. `sig = entriesSignature(entrées analysées)` ; si synthèse existante avec
   `basedOn === sig` → rien. Sinon générer (au plus `config.maxSynthesesPerRun` par cycle, jours
   les plus récents d'abord), `dirty=true`, puis push immédiat si jeton. Jour avec synthèse mais
   sans entrée → supprimer la synthèse (locale + `pendingDeletes`).
5. **Ménage** (1 fois par jour local, jeton requis ; sauté si `settings.json` n'a pas pu être
   lu ce cycle) : fichiers `kind:'audio'` dont `createdTime` < now − `audioRetentionDays` →
   `deleteFile` ; l'entrée correspondante : `audioFileId=null`, `audioExpired=true`, `dirty=true`
   (sans toucher `updatedAt`) → push. **Exceptions** : l'audio d'une entrée encore
   `needsAnalysis`, ou sans analyse ni transcription, est gardé (seule copie de son contenu) ;
   entrée inconnue ici mais présente (ou peut-être présente : pull incomplet) dans Drive →
   gardé, et le ménage sera refait au cycle suivant. Doublon ou orphelin → supprimé.
6. **Miroir** (`mirrorEnabled` + jeton) : pour chaque jour, `md = renderDayMarkdown(...)`,
   `sig = fnv1a(md)` ; si ≠ `mirror.state.days[day].sig` → `ensureFolder` (racine « Dit Harry »
   puis année) → `upsertTextFile` → mémoriser. Jour disparu → supprimer le fichier. Si un id de
   dossier mis en cache renvoie 404 → vider le cache et réessayer une fois.
7. `lastSyncAt`, statut, `onDataChanged`.

Erreur `auth` pendant 2→6 → `auth.markExpired()`, `needsAuth=true`, on arrête les étapes
distantes. Erreur réseau → arrêt, `lastError`. Erreur sur un élément → on la note et on continue.

`pendingCountOf(entries)` = nb d'entrées avec `needsAnalysis` **ou** `dirty` **ou**
(voix + `hasLocalAudio` + pas d'`audioFileId`).

## 9. Contrôleur UI (app.svelte.ts) — comportements

- Démarrage : `navigator.storage.persist()`, `auth.init()`, chargement des réglages et des
  données, **récupération** des enregistrements interrompus (`db.listRecordingIds()` → assembler
  les morceaux triés → créer une entrée voix « récupérée » → `deleteChunks`) puis `sync.run()`.
  Échec de récupération → toast (« libère de la place, puis relance l'appli »).
  Données locales sans `device.ownerEmail` mais email de compte connu → attribuées à ce compte.
- `auth.init()` est relancé (sans effet si le script GIS est déjà là) sur `online`, au retour au
  premier plan (en ligne) et au passage à `expired` : après un démarrage hors ligne, « Se
  reconnecter » ouvre la popup dès le premier appui.
- Déclencheurs de `sync.run()` : démarrage, nouvelle entrée, événement `online`, passage à
  `signed-in`, retour au premier plan (si dernier cycle > 2 min), bouton « Synchroniser ».
- Nouvelle entrée voix : `putAudio` → `putEntry` (`dirty:true, needsAnalysis:true,
  hasLocalAudio:true, attempts:0`, `day = dayKey(startedAt)`, `createdAt = startedAt`) →
  `deleteChunks(recordingId)` → `sync.run()`. Échec d'écriture (stockage plein) → le résultat
  reste en mémoire (`unsavedRecording`) : bandeau « Réessayer » / « Télécharger » (puis « Fermer »).
- Entrée texte : `source:'text'`, `transcript = texte`, `needsAnalysis:true`.
- Correction : `transcript`, `transcriptEdited:true`, `updatedAt=now`, `dirty`, `needsAnalysis`.
- Suppression (sous `withEntryLock`) : ajouter `driveFileId` et `audioFileId` à
  `sync.pendingDeletes` **puis** supprimer en local (entrée + audio), puis `sync.run()`.
- Déconnexion avec « Effacer les données de cet appareil » : si en ligne avec un jeton du bon
  compte, `sync.run()` d'abord (borné à 60 s : suppressions en attente et entrées envoyées),
  puis `auth.signOut()`, attente de la fin du cycle en cours (bornée), puis `db.clearAll()`.
  Le dialogue prévient des entrées non envoyées ET des suppressions pas encore appliquées.
- Conflit de compte (`syncStatus.accountConflict`, compte connecté) : écran bloquant « Un autre
  journal est sur ce téléphone » (jamais pendant un enregistrement) : « Annuler — revenir à
  {owner} » (`auth.signOut()`, données gardées) ; « Effacer les données de cet appareil »
  (confirmation, `clearAll()`, puis synchro : le compte connecté est adopté) ; propriétaire
  inconnu → aussi « C'est mon journal : continuer avec {current} » (`device.ownerEmail = current`).
- Réessayer : `attempts=0`, `retryAfter` effacé, `needsAnalysis=true` → `sync.run({force:true})`.
- Synthèse manuelle d'un jour : ajouter à `sync.forceSynthesisDays` → `sync.run()`.
- Lecture audio : blob local sinon `drive.downloadBlob(audioFileId)` → `URL.createObjectURL`
  (cache mémoire, révoqué à la sortie de l'écran).
- Le bouton « Se reconnecter » appelle `auth.signIn()` **directement** dans `onclick`.
- Verrou (§15) : `app.lock` (`LockController`) est construit avec le contrôleur (drapeau lu tout
  de suite), démarré en premier dans `start()` ; l'inactivité ne verrouille jamais pendant un
  enregistrement ni pendant la lecture d'un `<audio>` (`isBusy`). Effacement des données de
  l'appareil → `lock.forgetAndReset()` (relecture si l'effacement a échoué). `toast()` pendant le
  verrouillage : minuterie mise en attente, lancée au déverrouillage (`onUnlock`).

## 10. Interface

- Mobile d'abord (360–430 px), plein écran PWA, `env(safe-area-inset-*)`, cibles tactiles ≥ 44 px,
  thèmes clair/sombre (`prefers-color-scheme`). Ambiance : carnet chaleureux et calme (papier
  crème, encre brun-noir, accent terracotta). Polices système uniquement (CSP `font-src 'self'`) :
  titres en serif (`ui-serif, Georgia, serif`), texte en `system-ui`.
- **Aucun `{@html}`** ni `innerHTML` : tout contenu (transcriptions, sorties Gemini) est rendu
  en texte.
- Routage hash : `#/` (Aujourd'hui), `#/journal`, `#/jour/<YYYY-MM-DD>`, `#/entree/<id>`,
  `#/reglages`. Barre d'onglets en bas : Aujourd'hui · Journal · Réglages.
- **Accueil (non connecté)** : nom, accroche, bouton « Se connecter avec Google ». Si l'id client
  manque : message de configuration. Si l'appareil garde le journal d'un compte : « Ce téléphone
  garde le journal de {email} : connecte-toi avec ce compte pour le retrouver. » Bouton
  secondaire « Installer Dit Harry » **sous l'accroche** si l'installation est possible (§11) :
  visible sans défiler sur un petit téléphone (mise en page resserrée si hauteur ≤ 760 px).
- **Clé Gemini manquante** : écran d'accueil de réglage (coller la clé, lien
  https://aistudio.google.com/apikey, bouton « Vérifier », « Plus tard »). Jamais affiché pendant
  un enregistrement (il remplacerait le bouton Arrêter).
- Changement d'écran : le focus passe au `<h1>` du nouvel écran (`tabindex=-1`), sauf si un
  champ de saisie a déjà le focus ou qu'un dialogue est ouvert (lecteurs d'écran).
- Champs et interrupteur éteint : bordure/piste `--control-border` (≥ 3:1, WCAG 1.4.11).
- **Aujourd'hui** : date du jour ; carte discrète « Installe Dit Harry sur ton écran d'accueil »
  (« Installer » + × « Masquer la proposition d'installation ») si l'installation est possible,
  **sous le contenu, juste au-dessus du bouton d'enregistrement** (son arrivée tardive ne déplace
  rien de ce qui est à l'écran : pas d'appui détourné), fondu sans animation de hauteur, jamais
  pendant un enregistrement, revient 30 jours après une fermeture ou un refus dans la fenêtre de
  Chrome (`dh.ui.installDismissedAt`) ; gros bouton rond d'enregistrement (appui = démarrer, appui =
  arrêter), anneau animé selon le niveau, chrono, bouton « Annuler » pendant l'enregistrement ;
  bouton « Écrire » (saisie texte) ; liste des entrées du jour (heure, titre ou « Analyse en
  cours… », emoji d'humeur, résumé, statut : en attente / analyse / non envoyé / erreur + Réessayer).
- **Journal** : bande d'humeur des 30 derniers jours ; liste des jours (récent → ancien) :
  date, emoji, résumé de synthèse (ou « N entrées — synthèse à la prochaine ouverture demain »).
- **Jour** : synthèse (résumé, moments forts, à faire, thèmes, humeur) + bouton « Générer
  maintenant » / « Régénérer » ; liste des entrées.
- **Entrée** : titre, date/heure, durée, lecteur audio (ou « Audio supprimé après 1 an »),
  transcription éditable (Enregistrer → ré-analyse), analyse (résumé, humeur, thèmes, personnes,
  lieux, à faire), Réessayer, Supprimer (confirmation).
- **Réglages** : compte (email, Se déconnecter, option « Effacer les données de cet appareil »),
  clé Gemini (masquée, Vérifier), modèles d'entrée/synthèse, copie visible Drive (on/off),
  conservation audio (jours), Exporter (zip), Synchroniser maintenant + dernier cycle,
  Verrouillage (§15), Application (« Dit Harry est installée sur cet appareil. », sinon bouton
  « Installer sur l'écran d'accueil », sinon mode d'emploi du menu ⋮ de Chrome), version.
- **Écran de verrouillage** (§15) : plein écran opaque au-dessus de tout (z-index 100).
- **Bandeau d'état** (haut) : hors ligne ; session expirée + « Se reconnecter » ; clé manquante ;
  synchro en cours / N en attente.
- Humeur → emoji : -2 😞, -1 🙁, 0 😐, 1 🙂, 2 😄.

## 11. PWA

- `manifest.webmanifest` : URLs **relatives** (`start_url: "./"`, `scope: "./"`), `display:
  standalone`, `lang: fr`, icônes 192/512 PNG + 512 maskable + SVG, captures d'écran `narrow`
  780×1688 (`public/screenshots/`, tirées du mode démo) pour la fenêtre d'installation enrichie
  d'Android. **`id`** ajouté au build par `vite.config.ts` = `base` (`/dit-harry/`) : le
  navigateur résout `id` contre l'**origine** de `start_url`, donc `"./"` désignerait
  `https://soreon.github.io/`, une autre appli ; `base` redonne exactement l'identité d'avant
  (`start_url` résolu). Ne pas écrire d'`id` relatif dans le fichier source.
- Installation dans l'appli (`lib/install.svelte.ts`, règles pures dans `lib/install.ts`) :
  `beforeinstallprompt` capturé dans `main.ts` **avant le montage**, `preventDefault()` (pas de
  mini-barre de Chrome, qui disparaît des mois une fois fermée), événement gardé pour les boutons ;
  `prompt()` appelé **dans le clic** (`app.installApp()`), à usage unique. Refus dans la fenêtre
  de Chrome → carte d'Aujourd'hui en sommeil 30 jours comme la croix (Chrome renvoie aussitôt un
  `beforeinstallprompt`) ; accueil et réglages gardent leur bouton. Le bouton activé disparaît :
  le focus va au `<h1>` (Aujourd'hui), au titre « Application » (réglages) ou au bouton de
  connexion (accueil), jamais sur `<body>`. `appinstalled` →
  installée ; fenêtre d'appli détectée par `(display-mode: standalone)` ou un référent
  `android-app://`. Acceptée → toast « Dit Harry est installée. Tu la trouveras sur ton écran
  d'accueil. ».
- `sw.js` (écrit à la main, sans Workbox) : enregistré depuis `main.ts` en production avec
  `import.meta.env.BASE_URL + 'sw.js'`. Navigation → réseau d'abord **en `cache: 'no-cache'`**
  (jamais une ancienne page du cache HTTP après un déploiement), repli sur `index.html` en
  cache ; ressources même origine → cache d'abord (fichiers hashés) ; **jamais** de cache pour les
  autres origines (Google, Gemini) ni pour les requêtes non-GET. Précache **atomique** : page ou
  fichier `assets/` manquant → l'installation échoue (l'ancien worker et son cache restent) ; la
  page est mise en cache en dernier. Nettoyage des anciens caches à l'activation.

## 12. Mode démo (`npm run dev:mock`, `VITE_MOCK=1`)

`services.ts` fournit des mocks : auth (connexion instantanée, email `demo@exemple.fr`),
Drive persisté dans une base IndexedDB séparée `dit-harry-mock-drive`, Gemini simulé
(latence ~800 ms, analyse déterministe dérivée du texte, transcription factice pour l'audio),
enregistreur réel si micro disponible sinon simulé (blob silencieux + niveau oscillant), clé
d'accès simulée pour le verrou (`mock/passkey.ts` : vraie paire ECDSA P-256 WebCrypto, clé
privée dans `localStorage` `dh.mock.passkeys`, signature DER, « doigt reconnu » en ~500 ms ;
boutons libellés « (démo) »). Les mocks sont importés dynamiquement pour ne pas alourdir le build
de production.

## 13. Sécurité

- CSP en `<meta>` injectée au build (voir `vite.config.ts`) ; toute nouvelle origine → l'ajouter.
- Aucun secret dans le dépôt. La clé Gemini est saisie par l'utilisateur, stockée en local
  (IndexedDB `kv.settings`) et dans `settings.json` (appDataFolder, lisible par l'appli seule).
- Dépendances d'exécution : **svelte uniquement**. Appels Google/Gemini en `fetch` natif.
- Verrou de l'appli (§15) : barrière d'interface contre l'accès occasionnel au téléphone
  déverrouillé, **pas un chiffrement**.

## 14. Tests

Vitest (`tests/*.test.ts`, environnement node + `fake-indexeddb/auto` via `tests/setup.ts`).
Chaque module non-UI a ses tests : db, settings, sync (avec faux Drive/IA en mémoire), drive et
gemini (avec `fetchImpl` simulé), prompts/normalisation, recorder (`pickRecordingMimeType`),
markdown, zip (relecture des en-têtes + CRC), backup, verrou (`lock.test.ts` : clés générées
par la WebCrypto de Node, signatures DER construites à partir des signatures brutes, assertions
refusées pour défi / origine / domaine / drapeaux / signature ; `lock-controller.test.ts` :
authentificateur simulé, horloge et visibilité simulées).

## 15. Verrouillage (lock.ts, lock.svelte.ts, passkey.ts)

**Modèle de menace** : quelqu'un qui tient le téléphone déverrouillé (accès occasionnel). Le
verrou est une **barrière d'interface** ; les données ne sont pas chiffrées (IndexedDB, Drive).
Aucun serveur : la clé d'accès est vérifiée localement. **Hors de portée** (documenté dans
SETUP §8) : qui connaît le code du téléphone (`userVerification: 'required'` l'accepte à la
place de l'empreinte ; WebAuthn n'a pas d'option « biométrie seule ») ; qui efface les données
du site `soreon.github.io` puis se reconnecte au compte Google du téléphone (journal complet
rapatrié de Drive, audio compris).

- **Déverrouillage** : clé d'accès WebAuthn **de plateforme** (empreinte, visage ou code du
  téléphone), ou **phrase de secours** obligatoire.
- **Stockage, propre à l'appareil** (jamais dans Drive) : kv `lock.config` =
  `{ enabled, credentialId? (base64url), publicKeySpki? (base64, getPublicKey()), alg? (-7 | -257),
  rpId?, passphrase: { salt, hash, iterations }, delaySec, createdAt }` + drapeau `localStorage`
  `dh.lock.enabled` lu **de façon synchrone** à la construction du contrôleur : l'écran de
  verrouillage est dans le premier rendu de `Shell`, avant tout contenu du journal. Drapeau sans
  configuration valide → déverrouillé et drapeau retiré ; configuration sans drapeau → verrouillé
  à la lecture et drapeau rétabli ; lecture impossible avec drapeau → reste verrouillé
  (« Réessayer »). L'état déverrouillé ne vit qu'en mémoire : rechargement ou démarrage à froid =
  verrouillé. `db.clearAll()` retire aussi le drapeau ; le contrôleur appelle ensuite
  `lock.forgetAndReset()` : plus de verrou, et la clé d'accès devenue inutile est signalée au
  gestionnaire de mots de passe (sinon une seconde « Dit Harry — verrou » s'ajouterait à la
  prochaine activation).
- **Phrase de secours** : 6 caractères au moins (après `trim()` et normalisation NFC), saisie
  deux fois ; PBKDF2-SHA256, 600 000 itérations (enregistrées avec l'empreinte ; injectables dans
  les tests), sel aléatoire de 16 octets, 32 octets. 5 essais libres puis attente de 30 s,
  doublée à chaque échec (plafond 30 min), conservée dans kv `lock.attempts` ; même compteur pour
  les vérifications des réglages. Un succès (phrase ou empreinte) remet le compteur à zéro.
- **Activation** (Réglages › Verrouillage › « Activer le verrouillage ») : disponibilité vérifiée
  d'abord (`isUserVerifyingPlatformAuthenticatorAvailable()`), puis phrase ×2 → « Continuer » :
  `navigator.credentials.create()` part **dans le gestionnaire de l'envoi** (geste de
  l'utilisateur), PBKDF2 calculé pendant ce temps. Options : `rp { id: location.hostname, name:
  'Dit Harry' }`, `user { id: 16 octets aléatoires, name: 'Dit Harry — verrou', displayName: 'Dit
  Harry (verrou)' }`, défi de 32 octets, `pubKeyCredParams` ES256 puis RS256,
  `authenticatorSelection { authenticatorAttachment: 'platform', residentKey: 'preferred',
  userVerification: 'required' }`, `attestation: 'none'`, `hints: ['client-device']`, 60 s.
  Indisponible, annulée ou en échec → explication + « Activer avec la phrase seule » (et
  « Réessayer l'empreinte » après un échec).
- **Vérification de l'assertion** (`verifyAssertion`, WebCrypto) : `rawId` = clé enregistrée ;
  `clientDataJSON.type === 'webauthn.get'`, `challenge` = défi généré (base64url),
  `origin === location.origin`, pas `crossOrigin` ; `authenticatorData` : `rpIdHash ===
  SHA-256(rpId)`, drapeaux UP (0x01) **et** UV (0x04) ; signature sur
  `authenticatorData ‖ SHA-256(clientDataJSON)` avec la SPKI : ES256 → DER converti en r‖s
  (P1363) pour ECDSA P-256/SHA-256 ; RS256 → RSASSA-PKCS1-v1_5/SHA-256.
- **Écran de verrouillage** (`LockScreen.svelte`) : opaque, au-dessus de tout ; l'appli reste
  montée derrière, `inert` + `aria-hidden` (saisie, enregistrement et synchro intacts) ; toasts
  non rendus, et ceux émis pendant le verrouillage gardent leur minuterie en attente jusqu'au
  déverrouillage (`onUnlock`) : ils ne disparaissent pas sans avoir été vus ; dialogues modaux
  ouverts fermés au verrouillage (la couche supérieure passerait au-dessus et rendrait le bouton
  inerte), focus retiré ; **audio et vidéo mis en pause** (`pauseAllMedia`) et toute reprise
  bloquée tant que l'écran est là (écouteur `play` en capture : `inert` n'arrête ni le bouton du
  casque ni les commandes multimédia d'Android). Logo, « Dit Harry est verrouillée »,
  « Déverrouiller » (+ « (démo) »), « Utiliser ma phrase de secours » → champ + « Déverrouiller »,
  avertissement si un enregistrement continue. Après trop d'essais : la zone `aria-live` annonce
  une fois l'attente imposée (texte fixe) ; le décompte, qui change chaque seconde, est sur le
  bouton désactivé (« Réessaie dans 28 s »), hors de cette zone. Le message d'erreur est retiré
  pendant chaque calcul : une même erreur répétée est de nouveau annoncée.
  `config.rpId !== location.hostname` (ex. clé créée en local) ou WebAuthn absent → phrase seule,
  avec une phrase d'explication. Focus sur le titre à l'apparition ; au déverrouillage, sur le
  `<h1>` de l'écran courant.
- **Lancement automatique** de la clé d'accès, une fois par apparition de l'écran (démarrage à
  froid, retour au premier plan), page visible **et** active (`document.hasFocus()`, sinon au
  premier `focus`) ; échec silencieux (ex. activation exigée) : le bouton reste. Pas de
  lancement après « Verrouiller maintenant » ni après l'inactivité (`lock()` le désarme, comme
  le déverrouillage et un appui sur « Déverrouiller »). Jamais réarmé pendant une cérémonie, ni
  au retour d'une page cachée pendant une cérémonie (code du téléphone en plein écran) : une
  demande annulée ne se rouvre pas d'elle-même, en boucle.
- **Verrouillage automatique** : `visibilitychange` caché → `hiddenAt` (délai « Immédiat » :
  verrouillage tout de suite, pour la vignette des applis récentes, au mieux) ; visible →
  verrouillé si `now - hiddenAt >= delaySec` (horloge murale ; recul d'horloge > 1 min →
  verrouillé). Premier plan sans appui, touche, molette ni défilement pendant 5 min → verrouillé,
  **jamais pendant un enregistrement ni pendant l'écoute d'une entrée** (statut ≠ `idle` ou
  `<audio>` en lecture : le compte repart). Le verrou n'arrête jamais un enregistrement ni une
  synchro. Délais : Immédiat (0), 1 minute (60, défaut), 5 minutes, 15 minutes.
- **Cérémonie WebAuthn en cours** (fenêtre système, qui peut cacher la page) : ni inactivité, ni
  verrouillage immédiat au passage en arrière-plan ; `hiddenAt` est noté, la décision est
  reportée. Fin de la cérémonie (`endCeremony`) : réussie → la personne est là, l'absence est
  oubliée ; échouée ou annulée avec la page **toujours cachée** → vrai départ (Accueil, appel,
  écran éteint) : « Immédiat » verrouille aussitôt, sinon le retour décide. Retour pendant une
  cérémonie : une absence de plus de 2 min (2 × le délai WebAuthn) verrouille quand même
  (cérémonie bloquée).
- **Réglages, verrou actif** : état (« Empreinte et phrase de secours » / « Phrase de secours
  seule »), délai, « Verrouiller maintenant », « Changer la phrase de secours », « Réenregistrer
  l'empreinte » (« Ajouter l'empreinte » en phrase seule), « Désactiver le verrouillage ». Les
  trois dernières exigent une **vérification fraîche** (empreinte ou phrase actuelle, valable
  2 min, annulée au verrouillage) contrôlée par `LockController` lui-même : chaque `lock()`
  change une époque ; une vérification, un changement de phrase ou un réenregistrement commencé
  avant ne vaut plus à son terme (rien n'est enregistré, la clé créée pour rien est signalée), et
  aucune de ces actions n'est possible verrouillée. Confirmation expirée en cours de route
  (étape « nouvelle phrase » ou « enregistrer l'empreinte ») → elle est redemandée, champs saisis
  gardés, puis l'action reprend (la création d'une clé d'accès exige un nouvel appui).
  Réenregistrement et désactivation signalent l'ancienne clé au gestionnaire de mots de passe
  (`PublicKeyCredential.signalUnknownCredential`, si disponible).
- **Démo** : authentificateur simulé injecté (`createLockEnvironment()`), voir §12.
