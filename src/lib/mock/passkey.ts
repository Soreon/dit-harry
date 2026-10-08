/**
 * Mode démo : authentificateur de plateforme simulé pour le verrou. Il se comporte comme une
 * vraie clé d'accès ES256 (paire ECDSA P-256 générée par WebCrypto, signature DER, données
 * d'authentificateur avec présence + vérification de l'utilisateur) : la vérification locale
 * de lock.ts est donc réellement exercée. Le « doigt » est reconnu au bout de ~500 ms.
 * Importé à la demande par passkey.ts : absent du build de production.
 */
import {
  AUTH_DATA_UP,
  AUTH_DATA_UV,
  COSE_ES256,
  base64Encode,
  base64urlEncode,
  concatBytes,
  ecdsaRawToDer,
  randomBytes,
  sha256,
  toBytes,
  utf8,
  type PasskeyAuthenticator,
} from '../lock';
import { sleep } from '../util';

/** Clés simulées (clé privée JWK) : localStorage du mode démo, distinct du vrai mode. */
const STORAGE_KEY = 'dh.mock.passkeys';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface StoredKey {
  rpId: string;
  privateJwk: JsonWebKey;
  signCount: number;
}

export interface SimulatedAuthenticatorOptions {
  /** Temps de « reconnaissance du doigt » (ms). */
  delayMs?: number;
  storage?: Store;
  /** Origine écrite dans `clientDataJSON` (défaut : `location.origin`). */
  origin?: () => string;
  /** Authentificateur absent (pour montrer le repli « phrase seule »). */
  available?: boolean;
}

function defaultStorage(): Store {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // stockage indisponible : repli en mémoire
  }
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  };
}

function notAllowed(message: string): DOMException {
  return new DOMException(message, 'NotAllowedError');
}

export function createSimulatedAuthenticator(opts: SimulatedAuthenticatorOptions = {}): PasskeyAuthenticator {
  const delayMs = opts.delayMs ?? 500;
  const storage = opts.storage ?? defaultStorage();
  const origin = opts.origin ?? (() => location.origin);
  const available = opts.available ?? true;

  function load(): Record<string, StoredKey> {
    try {
      const raw: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
      return typeof raw === 'object' && raw !== null ? (raw as Record<string, StoredKey>) : {};
    } catch {
      return {};
    }
  }

  function save(keys: Record<string, StoredKey>): void {
    storage.setItem(STORAGE_KEY, JSON.stringify(keys));
  }

  return {
    simulated: true,
    supported: true,
    isAvailable: async () => available,

    async create(options) {
      if (!available) throw notAllowed('Aucun authentificateur (démo).');
      const sel = options.authenticatorSelection;
      if (sel?.authenticatorAttachment !== 'platform' || sel.userVerification !== 'required') {
        throw new DOMException('Options de création inattendues (démo).', 'NotSupportedError');
      }
      if (!options.pubKeyCredParams.some((p) => p.alg === COSE_ES256)) {
        throw new DOMException('ES256 non demandé (démo).', 'NotSupportedError');
      }
      const rpId = options.rp.id ?? location.hostname;
      await sleep(delayMs);
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
      const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      const credentialId = base64urlEncode(randomBytes(16));
      save({ ...load(), [credentialId]: { rpId, privateJwk, signCount: 0 } });
      return { credentialId, publicKeySpki: base64Encode(spki), alg: COSE_ES256 };
    },

    async get(options) {
      await sleep(delayMs);
      const keys = load();
      const rpId = options.rpId ?? location.hostname;
      const allowed = (options.allowCredentials ?? []).map((c) => base64urlEncode(toBytes(c.id)));
      const credentialId = allowed.find((id) => keys[id]?.rpId === rpId);
      const stored = credentialId ? keys[credentialId] : undefined;
      if (!credentialId || !stored) throw notAllowed('Aucune clé d’accès pour ce site (démo).');

      const key = await crypto.subtle.importKey('jwk', stored.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
      ]);
      const clientDataJSON = utf8(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: base64urlEncode(toBytes(options.challenge)),
          origin: origin(),
          crossOrigin: false,
        }),
      );
      const signCount = stored.signCount + 1;
      keys[credentialId] = { ...stored, signCount };
      save(keys);
      const counter = new Uint8Array(4);
      new DataView(counter.buffer).setUint32(0, signCount);
      const authenticatorData = concatBytes(
        await sha256(utf8(rpId)),
        new Uint8Array([AUTH_DATA_UP | AUTH_DATA_UV]),
        counter,
      );
      const signed = concatBytes(authenticatorData, await sha256(clientDataJSON));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signed));
      // Comme un vrai authentificateur : signature ES256 encodée en DER.
      return { credentialId, clientDataJSON, authenticatorData, signature: ecdsaRawToDer(raw) };
    },

    async forget(_rpId, credentialId) {
      const keys = load();
      if (!(credentialId in keys)) return;
      delete keys[credentialId];
      save(keys);
    },
  };
}
