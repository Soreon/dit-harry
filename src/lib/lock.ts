/**
 * Verrouillage de l'appli : règles et vérifications pures, sans état ni navigateur obligatoire
 * (WebCrypto suffit, Node compris) → testables seules. L'état réactif, les écouteurs et les
 * cérémonies WebAuthn sont dans lock.svelte.ts ; l'accès à `navigator.credentials` dans
 * passkey.ts. Voir docs/SPEC.md §15.
 *
 * Modèle de menace : quelqu'un qui tient le téléphone déverrouillé. Le verrou est une barrière
 * d'interface, pas un chiffrement : les données restent lisibles dans IndexedDB et dans Drive.
 */

/* ------------------------------------------------------------------ */
/* Stockage                                                            */
/* ------------------------------------------------------------------ */

/** Configuration complète du verrou (IndexedDB `kv`, propre à l'appareil, jamais envoyée à Drive). */
export const KV_LOCK_CONFIG = 'lock.config';
/** Essais de phrase de secours manqués (survit à un redémarrage de l'appli). */
export const KV_LOCK_ATTEMPTS = 'lock.attempts';
/**
 * Drapeau synchrone lu au démarrage (`'1'` = verrou actif) : l'écran de verrouillage s'affiche
 * avant tout contenu du journal, sans attendre IndexedDB. Effacé par `db.clearAll()`.
 */
export const LS_LOCK_ENABLED = 'dh.lock.enabled';
/** Nom de la base locale du vrai mode (db.ts). */
const MAIN_DB_NAME = 'dit-harry';

/**
 * Drapeau propre à une base locale : sur localhost, le vrai mode et la démo partagent l'origine
 * (donc localStorage) mais pas leur base ; leurs verrous ne doivent pas se mélanger.
 */
export function lockFlagKey(dbName: string): string {
  return dbName === MAIN_DB_NAME ? LS_LOCK_ENABLED : `${LS_LOCK_ENABLED}.${dbName}`;
}

/** Empreinte PBKDF2 de la phrase de secours. */
export interface PassphraseHash {
  /** Sel aléatoire de 16 octets, base64. */
  salt: string;
  /** PBKDF2-SHA256, 32 octets, base64. */
  hash: string;
  iterations: number;
}

export interface LockConfig {
  enabled: true;
  /** Clé d'accès (passkey) : identifiant, base64url. Absent → verrou par phrase seule. */
  credentialId?: string;
  /** Clé publique SubjectPublicKeyInfo (`getPublicKey()`), base64. */
  publicKeySpki?: string;
  /** Algorithme COSE (`getPublicKeyAlgorithm()`) : -7 (ES256) ou -257 (RS256). */
  alg?: number;
  /** Domaine pour lequel la clé d'accès a été créée (`location.hostname`). */
  rpId?: string;
  passphrase: PassphraseHash;
  /** Temps passé hors de l'appli avant verrouillage (s) : 0, 60, 300 ou 900. */
  delaySec: number;
  createdAt: string;
}

/** Essais manqués de phrase de secours. */
export interface LockAttempts {
  failures: number;
  /** Pas de nouvel essai avant cette date (ms depuis 1970), 0 si aucune attente. */
  retryAt: number;
}

/* ------------------------------------------------------------------ */
/* Réglages                                                            */
/* ------------------------------------------------------------------ */

export const LOCK_DELAYS: readonly { sec: number; label: string }[] = [
  { sec: 0, label: 'Immédiat' },
  { sec: 60, label: '1 minute' },
  { sec: 300, label: '5 minutes' },
  { sec: 900, label: '15 minutes' },
];
export const DEFAULT_LOCK_DELAY_SEC = 60;
/** Sans toucher l'écran pendant ce temps (appli au premier plan) → verrouillage. */
export const LOCK_INACTIVITY_MS = 5 * 60 * 1000;

/** Recommandation OWASP 2023 pour PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;
const MAX_ITERATIONS = 10_000_000;
export const PASSPHRASE_MIN_LENGTH = 6;
const PASSPHRASE_MAX_LENGTH = 256;

/** Essais libres avant la première attente. */
export const PASSPHRASE_FREE_ATTEMPTS = 5;
const PASSPHRASE_FIRST_WAIT_MS = 30_000;
const PASSPHRASE_MAX_WAIT_MS = 30 * 60 * 1000;

/** Algorithmes COSE acceptés à la création de la clé d'accès. */
export const COSE_ES256 = -7;
export const COSE_RS256 = -257;

/* ------------------------------------------------------------------ */
/* Octets et encodages                                                 */
/* ------------------------------------------------------------------ */

export type Bytes = Uint8Array<ArrayBuffer>;

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** ArrayBuffer ou vue → copie d'octets. */
export function toBytes(src: BufferSource): Bytes {
  if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0));
  return new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function utf8(s: string): Bytes {
  return new TextEncoder().encode(s) as Bytes;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Lève une erreur si la chaîne n'est pas du base64 valide. */
export function base64Decode(s: string): Bytes {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** base64url sans remplissage (RFC 4648 §5), comme `clientDataJSON.challenge`. */
export function base64urlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error('base64url invalide');
  const b64 = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  return base64Decode(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function sha256(data: BufferSource): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/* ------------------------------------------------------------------ */
/* Signatures ECDSA : DER ↔ brut (r‖s)                                 */
/* ------------------------------------------------------------------ */

/** Longueur DER (formes courte et longue) à `pos` → [longueur, position après]. */
function readDerLength(der: Uint8Array, pos: number): [number, number] {
  const first = der[pos];
  if (first === undefined) throw new Error('DER tronqué');
  if (first < 0x80) return [first, pos + 1];
  const count = first & 0x7f;
  if (count === 0 || count > 2) throw new Error('longueur DER non prise en charge');
  let len = 0;
  for (let i = 1; i <= count; i++) {
    const b = der[pos + i];
    if (b === undefined) throw new Error('DER tronqué');
    len = (len << 8) | b;
  }
  if (len < 0x80) throw new Error('longueur DER non minimale');
  return [len, pos + 1 + count];
}

function readDerInteger(der: Uint8Array, pos: number, size: number): [Bytes, number] {
  if (der[pos] !== 0x02) throw new Error('entier DER attendu');
  const [len, start] = readDerLength(der, pos + 1);
  const end = start + len;
  if (len === 0 || end > der.length) throw new Error('entier DER invalide');
  let value = der.subarray(start, end);
  // Entier positif : un 0x00 de tête n'est permis que devant un octet ≥ 0x80.
  if ((value[0] ?? 0) & 0x80) throw new Error('entier DER négatif');
  while (value.length > 1 && value[0] === 0) value = value.subarray(1);
  if (value.length > size) throw new Error('entier DER trop grand');
  const out = new Uint8Array(size);
  out.set(value, size - value.length);
  return [out, end];
}

/**
 * Signature ECDSA encodée en DER (WebAuthn, ES256) → r‖s bruts (IEEE P1363), seul format
 * accepté par WebCrypto. `size` = 32 octets par entier pour P-256.
 */
export function ecdsaDerToRaw(der: Uint8Array, size = 32): Bytes {
  if (der[0] !== 0x30) throw new Error('séquence DER attendue');
  const [seqLen, start] = readDerLength(der, 1);
  if (start + seqLen !== der.length) throw new Error('longueur DER incohérente');
  const [r, afterR] = readDerInteger(der, start, size);
  const [s, afterS] = readDerInteger(der, afterR, size);
  if (afterS !== der.length) throw new Error('octets en trop après la signature');
  return concatBytes(r, s);
}

function derInteger(value: Uint8Array): Bytes {
  let v = value;
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  const body = (v[0] ?? 0) & 0x80 ? concatBytes(new Uint8Array([0]), v) : new Uint8Array(v);
  return concatBytes(new Uint8Array([0x02, body.length]), body);
}

/** r‖s bruts → DER (ce que produit un authentificateur ; sert à la démo et aux tests). */
export function ecdsaRawToDer(raw: Uint8Array): Bytes {
  if (raw.length === 0 || raw.length % 2 !== 0) throw new Error('signature brute invalide');
  const half = raw.length / 2;
  const body = concatBytes(derInteger(raw.subarray(0, half)), derInteger(raw.subarray(half)));
  if (body.length >= 0x80) throw new Error('signature trop longue');
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

/* ------------------------------------------------------------------ */
/* WebAuthn : options et vérification de l'assertion                   */
/* ------------------------------------------------------------------ */

/** Options WebAuthn avec `hints` (niveau 3, pris en charge par Chrome ; absent de lib.dom). */
export type CreationOptions = PublicKeyCredentialCreationOptions & { hints?: string[] };
export type RequestOptions = PublicKeyCredentialRequestOptions & { hints?: string[] };

/** Résultat d'une création de clé d'accès, prêt à enregistrer. */
export interface PasskeyRegistration {
  credentialId: string;
  publicKeySpki: string;
  alg: number;
}

/** Réponse brute d'un `navigator.credentials.get()`. */
export interface PasskeyAssertion {
  /** `rawId`, base64url. */
  credentialId: string;
  clientDataJSON: Bytes;
  authenticatorData: Bytes;
  signature: Bytes;
}

/**
 * Accès à l'authentificateur de la plateforme (empreinte, visage, code du téléphone).
 * Réel : passkey.ts ; démo : mock/passkey.ts.
 */
export interface PasskeyAuthenticator {
  /** Démo : authentificateur simulé (libellé « (démo) »). */
  readonly simulated: boolean;
  /** L'API WebAuthn existe dans ce navigateur. */
  readonly supported: boolean;
  /** Un authentificateur de plateforme vérifiant l'utilisateur est disponible. */
  isAvailable(): Promise<boolean>;
  /** `navigator.credentials.create()` : à appeler DANS le gestionnaire du clic. */
  create(options: CreationOptions): Promise<PasskeyRegistration>;
  /** `navigator.credentials.get()`. */
  get(options: RequestOptions): Promise<PasskeyAssertion>;
  /** Signale au gestionnaire de mots de passe une clé qui ne sert plus (au mieux). */
  forget?(rpId: string, credentialId: string): Promise<void>;
}

/** Durée maximale d'une fenêtre de clé d'accès (création ou vérification). */
export const WEBAUTHN_TIMEOUT_MS = 60_000;

export function buildCreationOptions(p: {
  rpId: string;
  userId: Bytes;
  challenge: Bytes;
}): CreationOptions {
  return {
    rp: { id: p.rpId, name: 'Dit Harry' },
    user: { id: p.userId, name: 'Dit Harry — verrou', displayName: 'Dit Harry (verrou)' },
    challenge: p.challenge,
    pubKeyCredParams: [
      { type: 'public-key', alg: COSE_ES256 },
      { type: 'public-key', alg: COSE_RS256 },
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    },
    attestation: 'none',
    hints: ['client-device'],
    timeout: WEBAUTHN_TIMEOUT_MS,
  };
}

export function buildRequestOptions(p: {
  rpId: string;
  credentialId: string;
  challenge: Bytes;
}): RequestOptions {
  return {
    challenge: p.challenge,
    rpId: p.rpId,
    allowCredentials: [{ type: 'public-key', id: base64urlDecode(p.credentialId) }],
    userVerification: 'required',
    hints: ['client-device'],
    timeout: WEBAUTHN_TIMEOUT_MS,
  };
}

export const AUTH_DATA_UP = 0x01;
export const AUTH_DATA_UV = 0x04;

export interface AuthenticatorData {
  rpIdHash: Bytes;
  flags: number;
  signCount: number;
  userPresent: boolean;
  userVerified: boolean;
}

/** `authenticatorData` : SHA-256(rpId) (32 o) ‖ drapeaux (1 o) ‖ compteur (4 o, gros-boutiste) ‖ … */
export function parseAuthenticatorData(data: Uint8Array): AuthenticatorData {
  if (data.length < 37) throw new Error('authenticatorData trop court');
  const flags = data[32] ?? 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    rpIdHash: new Uint8Array(data.subarray(0, 32)),
    flags,
    signCount: view.getUint32(33),
    userPresent: (flags & AUTH_DATA_UP) !== 0,
    userVerified: (flags & AUTH_DATA_UV) !== 0,
  };
}

export type AssertionFailure =
  | 'credential'
  | 'client-data'
  | 'type'
  | 'challenge'
  | 'origin'
  | 'auth-data'
  | 'rp-id'
  | 'user-presence'
  | 'user-verification'
  | 'algorithm'
  | 'public-key'
  | 'signature';

export type AssertionCheck = { ok: true } | { ok: false; reason: AssertionFailure };

export interface AssertionExpectations {
  /** Défi envoyé à `get()`. */
  challenge: Uint8Array;
  /** `location.origin`. */
  origin: string;
  rpId: string;
  credentialId: string;
  publicKeySpki: string;
  alg: number;
}

function fail(reason: AssertionFailure): AssertionCheck {
  return { ok: false, reason };
}

/**
 * Vérifie localement une assertion WebAuthn (pas de serveur) : type, défi, origine, domaine,
 * présence ET vérification de l'utilisateur, puis la signature sur
 * `authenticatorData ‖ SHA-256(clientDataJSON)` avec la clé publique enregistrée.
 */
export async function verifyAssertion(a: PasskeyAssertion, x: AssertionExpectations): Promise<AssertionCheck> {
  if (a.credentialId !== x.credentialId) return fail('credential');

  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(a.clientDataJSON));
    if (typeof parsed !== 'object' || parsed === null) return fail('client-data');
    client = parsed as typeof client;
  } catch {
    return fail('client-data');
  }
  if (client.type !== 'webauthn.get') return fail('type');
  if (typeof client.challenge !== 'string' || client.challenge.replace(/=+$/, '') !== base64urlEncode(x.challenge)) {
    return fail('challenge');
  }
  if (client.origin !== x.origin || client.crossOrigin === true) return fail('origin');

  let auth: AuthenticatorData;
  try {
    auth = parseAuthenticatorData(a.authenticatorData);
  } catch {
    return fail('auth-data');
  }
  if (!bytesEqual(auth.rpIdHash, await sha256(utf8(x.rpId)))) return fail('rp-id');
  if (!auth.userPresent) return fail('user-presence');
  if (!auth.userVerified) return fail('user-verification');

  let algorithm: EcdsaParams | AlgorithmIdentifier;
  let importParams: EcKeyImportParams | RsaHashedImportParams;
  let signature: Bytes;
  if (x.alg === COSE_ES256) {
    importParams = { name: 'ECDSA', namedCurve: 'P-256' };
    algorithm = { name: 'ECDSA', hash: 'SHA-256' };
    try {
      signature = ecdsaDerToRaw(a.signature, 32);
    } catch {
      return fail('signature');
    }
  } else if (x.alg === COSE_RS256) {
    importParams = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    algorithm = { name: 'RSASSA-PKCS1-v1_5' };
    signature = a.signature;
  } else {
    return fail('algorithm');
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('spki', base64Decode(x.publicKeySpki), importParams, false, ['verify']);
  } catch {
    return fail('public-key');
  }
  const signed = concatBytes(a.authenticatorData, await sha256(a.clientDataJSON));
  try {
    return (await crypto.subtle.verify(algorithm, key, signature, signed)) ? { ok: true } : fail('signature');
  } catch {
    return fail('signature');
  }
}

/* ------------------------------------------------------------------ */
/* Phrase de secours                                                   */
/* ------------------------------------------------------------------ */

/**
 * Forme comparée : espaces de début et de fin retirés (le clavier en ajoute parfois un après
 * une suggestion), Unicode NFC (un « é » saisi de deux façons reste le même).
 */
export function normalizePassphrase(p: string): string {
  return p.trim().normalize('NFC');
}

/** Phrase choisie et sa confirmation → message d'erreur en français, ou null si elle convient. */
export function validateNewPassphrase(p: string, confirm: string): string | null {
  const n = normalizePassphrase(p);
  const len = [...n].length;
  if (len < PASSPHRASE_MIN_LENGTH) {
    return `La phrase de secours doit faire au moins ${PASSPHRASE_MIN_LENGTH} caractères.`;
  }
  if (len > PASSPHRASE_MAX_LENGTH) return `La phrase de secours est trop longue (${PASSPHRASE_MAX_LENGTH} caractères au plus).`;
  if (n !== normalizePassphrase(confirm)) return 'Les deux phrases ne sont pas identiques.';
  return null;
}

async function pbkdf2(passphrase: string, salt: Bytes, iterations: number): Promise<Bytes> {
  const material = await crypto.subtle.importKey('raw', utf8(normalizePassphrase(passphrase)), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256);
  return new Uint8Array(bits);
}

/** PBKDF2-SHA256, sel aléatoire de 16 octets ; `iterations` réduit dans les tests. */
export async function hashPassphrase(
  passphrase: string,
  opts: { iterations?: number; salt?: Bytes } = {},
): Promise<PassphraseHash> {
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const salt = opts.salt ?? randomBytes(16);
  const hash = await pbkdf2(passphrase, salt, iterations);
  return { salt: base64Encode(salt), hash: base64Encode(hash), iterations };
}

export async function verifyPassphrase(passphrase: string, stored: PassphraseHash): Promise<boolean> {
  let salt: Bytes;
  let expected: Bytes;
  try {
    salt = base64Decode(stored.salt);
    expected = base64Decode(stored.hash);
  } catch {
    return false;
  }
  const actual = await pbkdf2(passphrase, salt, stored.iterations);
  return bytesEqual(actual, expected);
}

/**
 * Attente imposée après `failures` essais manqués : aucune pendant les 5 premiers, puis 30 s,
 * doublée à chaque nouvel échec, plafonnée à 30 min.
 */
export function passphraseWaitMs(failures: number): number {
  if (!Number.isFinite(failures) || failures < PASSPHRASE_FREE_ATTEMPTS) return 0;
  const doublings = Math.min(failures - PASSPHRASE_FREE_ATTEMPTS, 20);
  return Math.min(PASSPHRASE_FIRST_WAIT_MS * 2 ** doublings, PASSPHRASE_MAX_WAIT_MS);
}

/**
 * Attente restante (ms). Une date de reprise absurde (horloge recalée) est bornée par l'attente
 * normale pour ce nombre d'échecs : jamais bloqué plus longtemps que prévu.
 */
export function remainingWaitMs(attempts: LockAttempts, now: number): number {
  const left = attempts.retryAt - now;
  if (left <= 0) return 0;
  return Math.min(left, passphraseWaitMs(attempts.failures));
}

/** 30 000 → « 30 s », 90 000 → « 1 min 30 s », 240 000 → « 4 min ». */
export function formatWait(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return sec ? `${min} min ${sec} s` : `${min} min`;
}

export function normalizeAttempts(raw: unknown): LockAttempts {
  const r = isRecord(raw) ? raw : {};
  const failures = typeof r.failures === 'number' && Number.isInteger(r.failures) && r.failures > 0 ? r.failures : 0;
  const retryAt = typeof r.retryAt === 'number' && Number.isFinite(r.retryAt) && r.retryAt > 0 ? r.retryAt : 0;
  return { failures, retryAt };
}

/* ------------------------------------------------------------------ */
/* Configuration et délais                                             */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isBase64(v: unknown, decoder: (s: string) => Uint8Array): v is string {
  if (typeof v !== 'string' || v === '') return false;
  try {
    return decoder(v).length > 0;
  } catch {
    return false;
  }
}

export function isLockDelay(sec: unknown): sec is number {
  return LOCK_DELAYS.some((d) => d.sec === sec);
}

/**
 * Valeur lue dans `kv` → configuration valide, ou null (absente, désactivée ou illisible : pas de
 * verrou). Une clé d'accès incomplète est ignorée (verrou par phrase seule).
 */
export function normalizeLockConfig(raw: unknown): LockConfig | null {
  if (!isRecord(raw) || raw.enabled !== true) return null;
  const p = raw.passphrase;
  if (
    !isRecord(p) ||
    !isBase64(p.salt, base64Decode) ||
    !isBase64(p.hash, base64Decode) ||
    typeof p.iterations !== 'number' ||
    !Number.isInteger(p.iterations) ||
    p.iterations < 1 ||
    p.iterations > MAX_ITERATIONS
  ) {
    return null;
  }
  const config: LockConfig = {
    enabled: true,
    passphrase: { salt: p.salt, hash: p.hash, iterations: p.iterations },
    delaySec: isLockDelay(raw.delaySec) ? raw.delaySec : DEFAULT_LOCK_DELAY_SEC,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
  };
  if (
    isBase64(raw.credentialId, base64urlDecode) &&
    isBase64(raw.publicKeySpki, base64Decode) &&
    (raw.alg === COSE_ES256 || raw.alg === COSE_RS256) &&
    typeof raw.rpId === 'string' &&
    raw.rpId !== ''
  ) {
    config.credentialId = raw.credentialId;
    config.publicKeySpki = raw.publicKeySpki;
    config.alg = raw.alg;
    config.rpId = raw.rpId;
  }
  return config;
}

/** La configuration contient une clé d'accès complète. */
export function hasPasskey(c: LockConfig | null): c is LockConfig & Required<Pick<LockConfig, 'credentialId' | 'publicKeySpki' | 'alg' | 'rpId'>> {
  return !!c?.credentialId && !!c.publicKeySpki && c.alg !== undefined && !!c.rpId;
}

/** Recul d'horloge au-delà duquel on verrouille par prudence au retour. */
const CLOCK_BACKWARD_TOLERANCE_MS = 60_000;

/**
 * Retour au premier plan : verrouiller si l'appli est restée cachée au moins `delaySec`.
 * Horloge (murale : elle avance aussi pendant la veille du téléphone) nettement recalée en
 * arrière pendant l'absence → verrouiller, par prudence.
 */
export function shouldLockOnReturn(hiddenAt: number | null, now: number, delaySec: number): boolean {
  if (hiddenAt === null) return false;
  const elapsed = now - hiddenAt;
  if (elapsed < -CLOCK_BACKWARD_TOLERANCE_MS) return true;
  return Math.max(0, elapsed) >= delaySec * 1000;
}

/* ------------------------------------------------------------------ */
/* Audio et vidéo de la page                                           */
/* ------------------------------------------------------------------ */

type MediaLike = Pick<HTMLMediaElement, 'paused' | 'ended' | 'pause'>;
/** `document` (ou un faux, dans les tests). */
export interface MediaRoot {
  querySelectorAll(selectors: string): Iterable<unknown>;
}

function mediaOf(root: MediaRoot | null | undefined): Iterable<MediaLike> {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return root.querySelectorAll('audio, video') as Iterable<MediaLike>;
}

/** Une entrée est en cours d'écoute : ce n'est pas de l'inactivité. */
export function isMediaPlaying(root: MediaRoot | null | undefined): boolean {
  for (const m of mediaOf(root)) if (!m.paused && !m.ended) return true;
  return false;
}

/** Verrouillage : un enregistrement du journal ne continue pas à voix haute derrière l'écran. */
export function pauseAllMedia(root: MediaRoot | null | undefined): void {
  for (const m of mediaOf(root)) if (!m.paused) m.pause();
}

/**
 * Premier plan sans toucher l'écran depuis `inactivityMs` → verrouiller. Jamais pendant un
 * enregistrement. Un recul d'horloge ne compte pas comme du temps écoulé.
 */
export function shouldLockForInactivity(p: {
  lastActivity: number;
  now: number;
  busy: boolean;
  inactivityMs?: number;
}): boolean {
  if (p.busy) return false;
  return p.now - p.lastActivity >= (p.inactivityMs ?? LOCK_INACTIVITY_MS);
}
