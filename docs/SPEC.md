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
    mock/*.ts          INFRA         auth / drive / gemini / recorder simulés
public/
  sw.js, manifest.webmanifest, icons/*        INFRA
scripts/gen-icons.mjs                         INFRA
.github/workflows/deploy.yml                  INFRA
README.md, docs/SETUP.md                      INFRA
tests/*.test.ts                               chaque équipe teste ses modules
```

### Signatures exportées (contrat entre équipes)

```ts
// db.ts
export function createLocalDb(name?: string /* défaut 'dit-harry' */): LocalDb;

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

L'auth persiste dans `localStorage` (`dh.auth.email`, `dh.auth.name`) et le jeton dans
`sessionStorage` (`dh.auth.token` = `{token, expiresAt}`) — jamais dans IndexedDB.

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
  (« Crédit Gemini épuisé ») ; 429 → `quota` (retryAfterMs depuis `RetryInfo.retryDelay`) ;
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

1. **Analyse** (si `navigator.onLine` et clé Gemini non vide) — entrées `needsAnalysis` dont
   `retryAfter` est passé (ou `force`), plus récentes d'abord :
   - voix : audio depuis `db.getAudio(id)` ; sinon, si `audioFileId` et jeton → télécharger ;
     sinon erreur « audio introuvable ». Si `transcriptEdited` → `analyzeText(transcript)`, sinon
     `analyzeAudio` (remplace `transcript`).
   - texte : `analyzeText(transcript)`.
   - succès : `analysis`, `analysisModel`, `analyzedAt`, **`updatedAt = now`**, `needsAnalysis=false`,
     `attempts=0`, erreur effacée, `dirty=true`.
   - échec : `attempts++`, `error`, `errorKind`, `retryAfter = now + min(1 h, 30 s × 2^attempts)`
     (ou `retryAfterMs`). `invalid-key` → arrêter l'étape, `needsKey=true`. `quota`/`network` →
     arrêter l'étape. `safety` → pas de retry auto (`retryAfter` lointain : +100 ans), retry manuel
     possible. Au-delà de 5 tentatives → plus de retry auto.
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
     `remoteModifiedTime`, `dirty=false`.
   - audio local supprimé (`deleteAudio`, `hasLocalAudio=false`) quand `audioFileId` est défini
     **et** `needsAnalysis=false`.
   - synthèses `dirty`, réglages si `sync.settingsDirty`.
4. **Synthèse** (clé Gemini + en ligne) — jours candidats : `day < aujourd'hui` **ou** dans
   `sync.forceSynthesisDays`, ayant ≥ 1 entrée analysée et **aucune** entrée encore en attente
   d'analyse retentable. `sig = entriesSignature(entrées analysées)` ; si synthèse existante avec
   `basedOn === sig` → rien. Sinon générer (au plus `config.maxSynthesesPerRun` par cycle, jours
   les plus récents d'abord), `dirty=true`, puis push immédiat si jeton. Jour avec synthèse mais
   sans entrée → supprimer la synthèse (locale + `pendingDeletes`).
5. **Ménage** (1 fois par jour local, jeton requis) : fichiers `kind:'audio'` dont `createdTime`
   < now − `audioRetentionDays` → `deleteFile` ; l'entrée correspondante : `audioFileId=null`,
   `audioExpired=true`, `dirty=true` (sans toucher `updatedAt`) → push.
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
- Déclencheurs de `sync.run()` : démarrage, nouvelle entrée, événement `online`, passage à
  `signed-in`, retour au premier plan (si dernier cycle > 2 min), bouton « Synchroniser ».
- Nouvelle entrée voix : `putAudio` → `putEntry` (`dirty:true, needsAnalysis:true,
  hasLocalAudio:true, attempts:0`, `day = dayKey(startedAt)`, `createdAt = startedAt`) →
  `deleteChunks(recordingId)` → `sync.run()`.
- Entrée texte : `source:'text'`, `transcript = texte`, `needsAnalysis:true`.
- Correction : `transcript`, `transcriptEdited:true`, `updatedAt=now`, `dirty`, `needsAnalysis`.
- Suppression : supprimer en local (entrée + audio), ajouter `driveFileId` et `audioFileId` à
  `sync.pendingDeletes`, puis `sync.run()`.
- Réessayer : `attempts=0`, `retryAfter` effacé, `needsAnalysis=true` → `sync.run({force:true})`.
- Synthèse manuelle d'un jour : ajouter à `sync.forceSynthesisDays` → `sync.run()`.
- Lecture audio : blob local sinon `drive.downloadBlob(audioFileId)` → `URL.createObjectURL`
  (cache mémoire, révoqué à la sortie de l'écran).
- Le bouton « Se reconnecter » appelle `auth.signIn()` **directement** dans `onclick`.

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
  manque : message de configuration.
- **Clé Gemini manquante** : écran d'accueil de réglage (coller la clé, lien
  https://aistudio.google.com/apikey, bouton « Vérifier », « Plus tard »).
- **Aujourd'hui** : date du jour ; gros bouton rond d'enregistrement (appui = démarrer, appui =
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
  conservation audio (jours), Exporter (zip), Synchroniser maintenant + dernier cycle, version.
- **Bandeau d'état** (haut) : hors ligne ; session expirée + « Se reconnecter » ; clé manquante ;
  synchro en cours / N en attente.
- Humeur → emoji : -2 😞, -1 🙁, 0 😐, 1 🙂, 2 😄.

## 11. PWA

- `manifest.webmanifest` : URLs **relatives** (`start_url: "./"`, `scope: "./"`), `display:
  standalone`, `lang: fr`, icônes 192/512 PNG + 512 maskable + SVG.
- `sw.js` (écrit à la main, sans Workbox) : enregistré depuis `main.ts` en production avec
  `import.meta.env.BASE_URL + 'sw.js'`. Navigation → réseau d'abord, repli sur `index.html` en
  cache ; ressources même origine → cache d'abord (fichiers hashés) ; **jamais** de cache pour les
  autres origines (Google, Gemini) ni pour les requêtes non-GET. Nettoyage des anciens caches.

## 12. Mode démo (`npm run dev:mock`, `VITE_MOCK=1`)

`services.ts` fournit des mocks : auth (connexion instantanée, email `demo@exemple.fr`),
Drive persisté dans une base IndexedDB séparée `dit-harry-mock-drive`, Gemini simulé
(latence ~800 ms, analyse déterministe dérivée du texte, transcription factice pour l'audio),
enregistreur réel si micro disponible sinon simulé (blob silencieux + niveau oscillant). Les
mocks sont importés dynamiquement pour ne pas alourdir le build de production.

## 13. Sécurité

- CSP en `<meta>` injectée au build (voir `vite.config.ts`) ; toute nouvelle origine → l'ajouter.
- Aucun secret dans le dépôt. La clé Gemini est saisie par l'utilisateur, stockée en local
  (IndexedDB `kv.settings`) et dans `settings.json` (appDataFolder, lisible par l'appli seule).
- Dépendances d'exécution : **svelte uniquement**. Appels Google/Gemini en `fetch` natif.

## 14. Tests

Vitest (`tests/*.test.ts`, environnement node + `fake-indexeddb/auto` via `tests/setup.ts`).
Chaque module non-UI a ses tests : db, settings, sync (avec faux Drive/IA en mémoire), drive et
gemini (avec `fetchImpl` simulé), prompts/normalisation, recorder (`pickRecordingMimeType`),
markdown, zip (relecture des en-têtes + CRC), backup.
