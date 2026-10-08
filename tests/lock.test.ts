import { describe, expect, it } from 'vitest';
import {
  AUTH_DATA_UP,
  AUTH_DATA_UV,
  COSE_ES256,
  COSE_RS256,
  DEFAULT_LOCK_DELAY_SEC,
  LOCK_INACTIVITY_MS,
  LS_LOCK_ENABLED,
  PBKDF2_ITERATIONS,
  base64Decode,
  base64Encode,
  base64urlDecode,
  base64urlEncode,
  buildCreationOptions,
  buildRequestOptions,
  concatBytes,
  ecdsaDerToRaw,
  ecdsaRawToDer,
  formatWait,
  hashPassphrase,
  isMediaPlaying,
  lockFlagKey,
  normalizeAttempts,
  normalizeLockConfig,
  parseAuthenticatorData,
  pauseAllMedia,
  passphraseWaitMs,
  randomBytes,
  remainingWaitMs,
  sha256,
  shouldLockForInactivity,
  shouldLockOnReturn,
  toBytes,
  utf8,
  validateNewPassphrase,
  verifyAssertion,
  verifyPassphrase,
  type Bytes,
  type PasskeyAssertion,
} from '../src/lib/lock';

/* ------------------------------------------------------------------ */
/* Fabrique d'assertions (ce que renverrait un authentificateur)       */
/* ------------------------------------------------------------------ */

const ORIGIN = 'https://soreon.github.io';
const RP_ID = 'soreon.github.io';
const CRED_ID = base64urlEncode(new Uint8Array([1, 2, 3, 250, 251, 252]));

interface AssertionSpec {
  privateKey: CryptoKey;
  alg?: number;
  challenge: Uint8Array;
  type?: string;
  origin?: string;
  crossOrigin?: boolean;
  rpId?: string;
  flags?: number;
  credentialId?: string;
}

async function makeAssertion(spec: AssertionSpec): Promise<PasskeyAssertion> {
  const clientDataJSON = utf8(
    JSON.stringify({
      type: spec.type ?? 'webauthn.get',
      challenge: base64urlEncode(spec.challenge),
      origin: spec.origin ?? ORIGIN,
      crossOrigin: spec.crossOrigin ?? false,
    }),
  );
  const authenticatorData = concatBytes(
    await sha256(utf8(spec.rpId ?? RP_ID)),
    new Uint8Array([spec.flags ?? AUTH_DATA_UP | AUTH_DATA_UV]),
    new Uint8Array([0, 0, 0, 7]),
  );
  const signed = concatBytes(authenticatorData, await sha256(clientDataJSON));
  const rsa = (spec.alg ?? COSE_ES256) === COSE_RS256;
  const raw = new Uint8Array(
    await crypto.subtle.sign(rsa ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' }, spec.privateKey, signed),
  );
  return {
    credentialId: spec.credentialId ?? CRED_ID,
    clientDataJSON,
    authenticatorData,
    // ES256 : les authentificateurs signent en DER
    signature: rsa ? raw : ecdsaRawToDer(raw),
  };
}

async function ecKeys(): Promise<{ privateKey: CryptoKey; spki: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = base64Encode(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
  return { privateKey: pair.privateKey, spki };
}

async function rsaKeys(): Promise<{ privateKey: CryptoKey; spki: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = base64Encode(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
  return { privateKey: pair.privateKey, spki };
}

function expectations(challenge: Uint8Array, spki: string, alg = COSE_ES256) {
  return { challenge, origin: ORIGIN, rpId: RP_ID, credentialId: CRED_ID, publicKeySpki: spki, alg };
}

/* ------------------------------------------------------------------ */

describe('encodages', () => {
  it('base64url sans remplissage, aller-retour', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x10]);
    const s = base64urlEncode(bytes);
    expect(s).toBe('-_-_ABA');
    expect(s).not.toMatch(/[+/=]/);
    expect([...base64urlDecode(s)]).toEqual([...bytes]);
    // Remplissage toléré à la lecture
    expect([...base64urlDecode('-_-_ABA=')]).toEqual([...bytes]);
    expect(() => base64urlDecode('a+b/')).toThrow();
    for (let n = 0; n < 40; n++) {
      const r = randomBytes(n);
      expect([...base64urlDecode(base64urlEncode(r))]).toEqual([...r]);
      expect([...base64Decode(base64Encode(r))]).toEqual([...r]);
    }
  });

  it('toBytes copie un ArrayBuffer ou une vue partielle', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    expect([...toBytes(buf.buffer)]).toEqual([1, 2, 3, 4, 5]);
    expect([...toBytes(buf.subarray(1, 3))]).toEqual([2, 3]);
  });

  it('drapeau localStorage propre à chaque base locale', () => {
    expect(lockFlagKey('dit-harry')).toBe(LS_LOCK_ENABLED);
    expect(LS_LOCK_ENABLED).toBe('dh.lock.enabled');
    expect(lockFlagKey('dit-harry-demo')).toBe('dh.lock.enabled.dit-harry-demo');
  });
});

describe('signatures ECDSA : DER ↔ brut', () => {
  const r = new Uint8Array(32).fill(0x11);
  r[0] = 0x80; // bit de poids fort → 0x00 de tête en DER
  const s = new Uint8Array(32).fill(0x22);
  s[0] = 0;
  s[1] = 0;
  s[2] = 0x05; // zéros de tête → entier DER plus court
  const raw = concatBytes(r, s);

  it('encode puis décode à l’identique (zéros de tête, bit de poids fort)', () => {
    const der = ecdsaRawToDer(raw);
    expect(der[0]).toBe(0x30);
    expect(der[1]).toBe(der.length - 2);
    // r : 02 21 00 80 …
    expect([...der.subarray(2, 5)]).toEqual([0x02, 0x21, 0x00]);
    expect(der[5]).toBe(0x80);
    // s : 02 1e 05 … (30 octets)
    const sAt = 2 + 2 + 33;
    expect([...der.subarray(sAt, sAt + 3)]).toEqual([0x02, 30, 0x05]);
    expect([...ecdsaDerToRaw(der)]).toEqual([...raw]);
  });

  it('entiers d’un seul octet', () => {
    const tiny = new Uint8Array(64);
    tiny[31] = 1;
    tiny[63] = 2;
    const der = ecdsaRawToDer(tiny);
    expect([...der]).toEqual([0x30, 6, 0x02, 1, 1, 0x02, 1, 2]);
    expect([...ecdsaDerToRaw(der)]).toEqual([...tiny]);
  });

  it('aller-retour sur des signatures quelconques', () => {
    for (let i = 0; i < 50; i++) {
      const x = randomBytes(64);
      expect([...ecdsaDerToRaw(ecdsaRawToDer(x))]).toEqual([...x]);
    }
  });

  it('rejette un DER mal formé', () => {
    const der = ecdsaRawToDer(raw);
    expect(() => ecdsaDerToRaw(new Uint8Array([0x31, ...der.subarray(1)]))).toThrow(); // pas une séquence
    expect(() => ecdsaDerToRaw(concatBytes(der, new Uint8Array([0])))).toThrow(); // octet en trop
    expect(() => ecdsaDerToRaw(der.subarray(0, der.length - 1))).toThrow(); // tronqué
    expect(() => ecdsaDerToRaw(new Uint8Array([0x30, 6, 0x02, 1, 0x81, 0x02, 1, 1]))).toThrow(); // négatif
    // Entier de 33 octets significatifs : trop grand pour P-256
    const big = concatBytes(new Uint8Array([0x02, 33, 0x01]), new Uint8Array(32).fill(1));
    const small = new Uint8Array([0x02, 1, 1]);
    expect(() => ecdsaDerToRaw(concatBytes(new Uint8Array([0x30, big.length + small.length]), big, small))).toThrow();
    expect(() => ecdsaDerToRaw(new Uint8Array([]))).toThrow();
  });
});

describe('authenticatorData', () => {
  it('lit le hash du domaine, les drapeaux et le compteur', async () => {
    const rpHash = await sha256(utf8(RP_ID));
    const data = concatBytes(rpHash, new Uint8Array([0x45]), new Uint8Array([0, 0, 1, 2]), new Uint8Array([9, 9]));
    const parsed = parseAuthenticatorData(data);
    expect([...parsed.rpIdHash]).toEqual([...rpHash]);
    expect(parsed.flags).toBe(0x45);
    expect(parsed.userPresent).toBe(true);
    expect(parsed.userVerified).toBe(true);
    expect(parsed.signCount).toBe(258);
    expect(parseAuthenticatorData(concatBytes(rpHash, new Uint8Array([0x01, 0, 0, 0, 0]))).userVerified).toBe(false);
    expect(() => parseAuthenticatorData(new Uint8Array(36))).toThrow();
  });
});

describe('verifyAssertion', () => {
  it('ES256 : assertion valide (signature DER convertie en r‖s)', async () => {
    const { privateKey, spki } = await ecKeys();
    const challenge = randomBytes(32);
    const a = await makeAssertion({ privateKey, challenge });
    expect(await verifyAssertion(a, expectations(challenge, spki))).toEqual({ ok: true });
  });

  it('RS256 : assertion valide, signature modifiée refusée', async () => {
    const { privateKey, spki } = await rsaKeys();
    const challenge = randomBytes(32);
    const a = await makeAssertion({ privateKey, challenge, alg: COSE_RS256 });
    expect(await verifyAssertion(a, expectations(challenge, spki, COSE_RS256))).toEqual({ ok: true });
    const sig = new Uint8Array(a.signature);
    sig[10] = (sig[10] ?? 0) ^ 0xff;
    expect(await verifyAssertion({ ...a, signature: sig }, expectations(challenge, spki, COSE_RS256))).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('refuse un mauvais défi, une autre origine, un autre domaine, un autre type', async () => {
    const { privateKey, spki } = await ecKeys();
    const challenge = randomBytes(32);
    const x = expectations(challenge, spki);
    const reason = async (a: PasskeyAssertion) => verifyAssertion(a, x);

    expect(await reason(await makeAssertion({ privateKey, challenge: randomBytes(32) }))).toEqual({
      ok: false,
      reason: 'challenge',
    });
    expect(await reason(await makeAssertion({ privateKey, challenge, origin: 'https://evil.github.io' }))).toEqual({
      ok: false,
      reason: 'origin',
    });
    expect(await reason(await makeAssertion({ privateKey, challenge, crossOrigin: true }))).toEqual({
      ok: false,
      reason: 'origin',
    });
    expect(await reason(await makeAssertion({ privateKey, challenge, rpId: 'github.io' }))).toEqual({
      ok: false,
      reason: 'rp-id',
    });
    expect(await reason(await makeAssertion({ privateKey, challenge, type: 'webauthn.create' }))).toEqual({
      ok: false,
      reason: 'type',
    });
    expect(await reason(await makeAssertion({ privateKey, challenge, credentialId: 'AAAA' }))).toEqual({
      ok: false,
      reason: 'credential',
    });
  });

  it('exige la présence ET la vérification de l’utilisateur', async () => {
    const { privateKey, spki } = await ecKeys();
    const challenge = randomBytes(32);
    const x = expectations(challenge, spki);
    expect(await verifyAssertion(await makeAssertion({ privateKey, challenge, flags: AUTH_DATA_UP }), x)).toEqual({
      ok: false,
      reason: 'user-verification',
    });
    expect(await verifyAssertion(await makeAssertion({ privateKey, challenge, flags: AUTH_DATA_UV }), x)).toEqual({
      ok: false,
      reason: 'user-presence',
    });
  });

  it('refuse une signature fausse, une autre clé, des données modifiées après signature', async () => {
    const { privateKey, spki } = await ecKeys();
    const other = await ecKeys();
    const challenge = randomBytes(32);
    const a = await makeAssertion({ privateKey, challenge });
    const x = expectations(challenge, spki);

    expect(await verifyAssertion(a, { ...x, publicKeySpki: other.spki })).toEqual({ ok: false, reason: 'signature' });

    const raw = ecdsaDerToRaw(a.signature);
    raw[40] = (raw[40] ?? 0) ^ 0x01;
    expect(await verifyAssertion({ ...a, signature: ecdsaRawToDer(raw) }, x)).toEqual({
      ok: false,
      reason: 'signature',
    });
    // Signature brute (non DER) : illisible
    expect(await verifyAssertion({ ...a, signature: ecdsaDerToRaw(a.signature) }, x)).toEqual({
      ok: false,
      reason: 'signature',
    });
    // Compteur modifié après signature
    const authenticatorData = new Uint8Array(a.authenticatorData);
    authenticatorData[36] = 99;
    expect(await verifyAssertion({ ...a, authenticatorData }, x)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuse des données client illisibles, un algorithme inconnu, une clé publique invalide', async () => {
    const { privateKey, spki } = await ecKeys();
    const challenge = randomBytes(32);
    const a = await makeAssertion({ privateKey, challenge });
    const x = expectations(challenge, spki);
    expect(await verifyAssertion({ ...a, clientDataJSON: utf8('pas du JSON') }, x)).toEqual({
      ok: false,
      reason: 'client-data',
    });
    expect(await verifyAssertion({ ...a, authenticatorData: new Uint8Array(10) }, x)).toEqual({
      ok: false,
      reason: 'auth-data',
    });
    expect(await verifyAssertion(a, { ...x, alg: -8 })).toEqual({ ok: false, reason: 'algorithm' });
    expect(await verifyAssertion(a, { ...x, publicKeySpki: base64Encode(new Uint8Array([1, 2, 3])) })).toEqual({
      ok: false,
      reason: 'public-key',
    });
  });
});

describe('options WebAuthn', () => {
  it('création : clé de plateforme, vérification de l’utilisateur, ES256 puis RS256', () => {
    const userId = randomBytes(16);
    const challenge = randomBytes(32);
    const o = buildCreationOptions({ rpId: RP_ID, userId, challenge });
    expect(o.rp).toEqual({ id: RP_ID, name: 'Dit Harry' });
    expect(o.user).toEqual({ id: userId, name: 'Dit Harry — verrou', displayName: 'Dit Harry (verrou)' });
    expect(o.challenge).toBe(challenge);
    expect(o.pubKeyCredParams.map((p) => p.alg)).toEqual([COSE_ES256, COSE_RS256]);
    expect(o.authenticatorSelection).toEqual({
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    });
    expect(o.attestation).toBe('none');
    expect(o.hints).toEqual(['client-device']);
    expect(o.timeout).toBe(60_000);
  });

  it('vérification : la clé enregistrée seulement, vérification de l’utilisateur exigée', () => {
    const challenge = randomBytes(32);
    const o = buildRequestOptions({ rpId: RP_ID, credentialId: CRED_ID, challenge });
    expect(o.rpId).toBe(RP_ID);
    expect(o.userVerification).toBe('required');
    expect(o.hints).toEqual(['client-device']);
    expect(o.allowCredentials).toHaveLength(1);
    const id = o.allowCredentials?.[0]?.id as Bytes;
    expect(base64urlEncode(toBytes(id))).toBe(CRED_ID);
  });
});

describe('phrase de secours', () => {
  it('PBKDF2 : bonne phrase acceptée, mauvaise refusée, sel aléatoire', async () => {
    const h = await hashPassphrase('mon chat Félix', { iterations: 1000 });
    expect(h.iterations).toBe(1000);
    expect(base64Decode(h.salt)).toHaveLength(16);
    expect(base64Decode(h.hash)).toHaveLength(32);
    expect(await verifyPassphrase('mon chat Félix', h)).toBe(true);
    expect(await verifyPassphrase('mon chat felix', h)).toBe(false);
    const again = await hashPassphrase('mon chat Félix', { iterations: 1000 });
    expect(again.salt).not.toBe(h.salt);
    expect(again.hash).not.toBe(h.hash);
  });

  it('espaces autour ignorés, Unicode normalisé (NFC)', async () => {
    const h = await hashPassphrase('  café crème ', { iterations: 1000 });
    expect(await verifyPassphrase('café crème', h)).toBe(true);
    // « é » décomposé (e + accent combinant)
    expect(await verifyPassphrase('café crème', h)).toBe(true);
  });

  it('les itérations enregistrées sont celles utilisées pour vérifier', async () => {
    const h = await hashPassphrase('phrase secrète', { iterations: 1500 });
    expect(await verifyPassphrase('phrase secrète', { ...h, iterations: 1499 })).toBe(false);
    expect(await verifyPassphrase('phrase secrète', { ...h, salt: 'pas du base64 !' })).toBe(false);
  });

  it('600 000 itérations par défaut', async () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    const salt = randomBytes(16);
    const h = await hashPassphrase('par défaut', { salt });
    expect(h.iterations).toBe(600_000);
    expect(h.salt).toBe(base64Encode(salt));
  });

  it('choix : 6 caractères au moins, confirmation identique', () => {
    expect(validateNewPassphrase('abc', 'abc')).toMatch(/au moins 6 caractères/);
    expect(validateNewPassphrase('  abcde  ', 'abcde')).toMatch(/au moins 6/);
    expect(validateNewPassphrase('abcdef', 'abcdeg')).toMatch(/pas identiques/);
    expect(validateNewPassphrase('abcdef', ' abcdef ')).toBeNull();
    expect(validateNewPassphrase('😀😀😀😀😀😀', '😀😀😀😀😀😀')).toBeNull();
    expect(validateNewPassphrase('x'.repeat(300), 'x'.repeat(300))).toMatch(/trop longue/);
  });

  it('attente après 5 échecs : 30 s, doublée, plafonnée à 30 min', () => {
    expect([0, 1, 4].map(passphraseWaitMs)).toEqual([0, 0, 0]);
    expect(passphraseWaitMs(5)).toBe(30_000);
    expect(passphraseWaitMs(6)).toBe(60_000);
    expect(passphraseWaitMs(7)).toBe(120_000);
    expect(passphraseWaitMs(12)).toBe(30 * 60 * 1000);
    expect(passphraseWaitMs(1e9)).toBe(30 * 60 * 1000);
    expect(passphraseWaitMs(Number.NaN)).toBe(0);
  });

  it('attente restante : bornée même si la date de reprise est absurde', () => {
    const now = 1_000_000;
    expect(remainingWaitMs({ failures: 5, retryAt: now + 10_000 }, now)).toBe(10_000);
    expect(remainingWaitMs({ failures: 5, retryAt: now - 1 }, now)).toBe(0);
    expect(remainingWaitMs({ failures: 5, retryAt: now + 1e12 }, now)).toBe(30_000);
    expect(remainingWaitMs({ failures: 2, retryAt: now + 50_000 }, now)).toBe(0);
  });

  it('durée affichée en français', () => {
    expect(formatWait(30_000)).toBe('30 s');
    expect(formatWait(29_100)).toBe('30 s');
    expect(formatWait(90_000)).toBe('1 min 30 s');
    expect(formatWait(240_000)).toBe('4 min');
    expect(formatWait(0)).toBe('1 s');
  });

  it('essais lus dans kv : valeurs absurdes ignorées', () => {
    expect(normalizeAttempts(undefined)).toEqual({ failures: 0, retryAt: 0 });
    expect(normalizeAttempts({ failures: 3, retryAt: 42 })).toEqual({ failures: 3, retryAt: 42 });
    expect(normalizeAttempts({ failures: -1, retryAt: 'x' })).toEqual({ failures: 0, retryAt: 0 });
    expect(normalizeAttempts({ failures: 2.5, retryAt: Infinity })).toEqual({ failures: 0, retryAt: 0 });
  });
});

describe('configuration', () => {
  const passphrase = { salt: base64Encode(randomBytes(16)), hash: base64Encode(randomBytes(32)), iterations: 600_000 };
  const passkey = {
    credentialId: CRED_ID,
    publicKeySpki: base64Encode(randomBytes(91)),
    alg: COSE_ES256,
    rpId: RP_ID,
  };

  it('configuration complète conservée', () => {
    const raw = { enabled: true, ...passkey, passphrase, delaySec: 300, createdAt: '2026-10-08T10:00:00.000Z' };
    expect(normalizeLockConfig(raw)).toEqual(raw);
  });

  it('absente, désactivée ou sans phrase de secours valide → pas de verrou', () => {
    expect(normalizeLockConfig(undefined)).toBeNull();
    expect(normalizeLockConfig({ enabled: false, passphrase, delaySec: 60 })).toBeNull();
    expect(normalizeLockConfig({ enabled: true, delaySec: 60 })).toBeNull();
    expect(normalizeLockConfig({ enabled: true, passphrase: { ...passphrase, iterations: 0 } })).toBeNull();
    expect(normalizeLockConfig({ enabled: true, passphrase: { ...passphrase, hash: '' } })).toBeNull();
  });

  it('clé d’accès incomplète ou d’algorithme inconnu → phrase seule ; délai inconnu → 1 minute', () => {
    const c = normalizeLockConfig({ enabled: true, ...passkey, alg: -8, passphrase, delaySec: 42 });
    expect(c?.credentialId).toBeUndefined();
    expect(c?.rpId).toBeUndefined();
    expect(c?.delaySec).toBe(DEFAULT_LOCK_DELAY_SEC);
    expect(normalizeLockConfig({ enabled: true, ...passkey, publicKeySpki: undefined, passphrase })?.credentialId).toBeUndefined();
  });
});

describe('verrouillage automatique', () => {
  const t = 1_000_000_000;

  it('au retour : verrouillé si l’absence a duré au moins le délai', () => {
    expect(shouldLockOnReturn(null, t, 60)).toBe(false);
    expect(shouldLockOnReturn(t - 59_999, t, 60)).toBe(false);
    expect(shouldLockOnReturn(t - 60_000, t, 60)).toBe(true);
    expect(shouldLockOnReturn(t, t, 0)).toBe(true);
    expect(shouldLockOnReturn(t - 5 * 60_000, t, 900)).toBe(false);
    // Horloge légèrement recalée : pas de surprise ; nettement en arrière : verrouillé
    expect(shouldLockOnReturn(t + 5_000, t, 60)).toBe(false);
    expect(shouldLockOnReturn(t + 10 * 60_000, t, 900)).toBe(true);
  });

  it('inactivité : 5 minutes sans toucher l’écran, jamais pendant un enregistrement', () => {
    expect(LOCK_INACTIVITY_MS).toBe(5 * 60_000);
    expect(shouldLockForInactivity({ lastActivity: t - LOCK_INACTIVITY_MS, now: t, busy: false })).toBe(true);
    expect(shouldLockForInactivity({ lastActivity: t - LOCK_INACTIVITY_MS + 1, now: t, busy: false })).toBe(false);
    expect(shouldLockForInactivity({ lastActivity: t - 3_600_000, now: t, busy: true })).toBe(false);
    expect(shouldLockForInactivity({ lastActivity: t + 1_000, now: t, busy: false })).toBe(false);
  });
});

describe('audio et vidéo de la page', () => {
  function media(paused: boolean, ended = false) {
    const m = {
      paused,
      ended,
      pauses: 0,
      pause() {
        m.paused = true;
        m.pauses++;
      },
    };
    return m;
  }

  it('écoute en cours : lecture ni en pause ni terminée', () => {
    const playing = media(false);
    expect(isMediaPlaying({ querySelectorAll: () => [media(true), playing] })).toBe(true);
    expect(isMediaPlaying({ querySelectorAll: () => [media(true), media(false, true)] })).toBe(false);
    expect(isMediaPlaying({ querySelectorAll: () => [] })).toBe(false);
    // Environnement sans DOM (tests, rendu hors navigateur)
    expect(isMediaPlaying(null)).toBe(false);
    expect(isMediaPlaying({} as Parameters<typeof isMediaPlaying>[0])).toBe(false);
  });

  it('verrouillage : tout ce qui joue est mis en pause', () => {
    const a = media(false);
    const b = media(true);
    let selector = '';
    pauseAllMedia({
      querySelectorAll: (s: string) => {
        selector = s;
        return [a, b];
      },
    });
    expect(selector).toBe('audio, video');
    expect(a).toMatchObject({ paused: true, pauses: 1 });
    expect(b.pauses).toBe(0);
    expect(() => pauseAllMedia(undefined)).not.toThrow();
  });
});
