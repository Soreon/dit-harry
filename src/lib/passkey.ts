/**
 * Clé d'accès (passkey) du verrou : accès à WebAuthn (`navigator.credentials`), sans serveur.
 * La vérification des assertions est faite localement (lock.ts). En mode démo, un
 * authentificateur simulé le remplace (mock/passkey.ts, importé à la demande).
 */
import { base64Encode, base64urlEncode, lockFlagKey, LS_LOCK_ENABLED, type PasskeyAuthenticator } from './lock';

/** Signal API (Chrome 132+), absente de lib.dom : retirer une clé d'accès devenue inutile. */
interface SignalCapable {
  signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>;
}

function webAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials
  );
}

function notSupported(): Promise<never> {
  return Promise.reject(new DOMException('WebAuthn indisponible dans ce navigateur.', 'NotSupportedError'));
}

/** Authentificateur de la plateforme : empreinte, visage ou code de verrouillage du téléphone. */
export function createWebAuthnAuthenticator(): PasskeyAuthenticator {
  const supported = webAuthnSupported();
  return {
    simulated: false,
    supported,

    async isAvailable() {
      if (!supported) return false;
      try {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch {
        return false;
      }
    },

    create(publicKey) {
      if (!supported) return notSupported();
      let pending: Promise<Credential | null>;
      try {
        // Appel synchrone : on est encore dans le clic (activation de l'utilisateur).
        pending = navigator.credentials.create({ publicKey });
      } catch (e) {
        return Promise.reject(e);
      }
      return pending.then((cred) => {
        if (!(cred instanceof PublicKeyCredential)) {
          throw new DOMException('Aucune clé d’accès créée.', 'NotAllowedError');
        }
        const response = cred.response as AuthenticatorAttestationResponse;
        const spki = typeof response.getPublicKey === 'function' ? response.getPublicKey() : null;
        const alg = typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : Number.NaN;
        if (!spki) throw new DOMException('Clé publique illisible.', 'NotSupportedError');
        return {
          credentialId: base64urlEncode(new Uint8Array(cred.rawId)),
          publicKeySpki: base64Encode(new Uint8Array(spki)),
          alg,
        };
      });
    },

    get(publicKey) {
      if (!supported) return notSupported();
      let pending: Promise<Credential | null>;
      try {
        pending = navigator.credentials.get({ publicKey });
      } catch (e) {
        return Promise.reject(e);
      }
      return pending.then((cred) => {
        if (!(cred instanceof PublicKeyCredential)) {
          throw new DOMException('Aucune clé d’accès utilisée.', 'NotAllowedError');
        }
        const response = cred.response as AuthenticatorAssertionResponse;
        return {
          credentialId: base64urlEncode(new Uint8Array(cred.rawId)),
          clientDataJSON: new Uint8Array(response.clientDataJSON),
          authenticatorData: new Uint8Array(response.authenticatorData),
          signature: new Uint8Array(response.signature),
        };
      });
    },

    async forget(rpId, credentialId) {
      const api = (supported ? window.PublicKeyCredential : undefined) as unknown as SignalCapable | undefined;
      if (typeof api?.signalUnknownCredential !== 'function') return;
      try {
        await api.signalUnknownCredential({ rpId, credentialId });
      } catch (e) {
        console.warn('[verrou] clé d’accès non signalée', e);
      }
    },
  };
}

/** Ce que le contrôleur reçoit au démarrage pour le verrou. */
export interface LockEnvironment {
  authenticator: PasskeyAuthenticator;
  /** Drapeau localStorage propre à la base locale utilisée (voir `lockFlagKey`). */
  flagKey: string;
}

/** Authentificateur réel, ou simulé en mode démo (`VITE_MOCK=1`). */
export async function createLockEnvironment(): Promise<LockEnvironment> {
  // Condition écrite sur import.meta.env pour que Vite élimine la démo du build de production.
  if (import.meta.env.VITE_MOCK === '1') {
    const [{ createSimulatedAuthenticator }, { MOCK_LOCAL_DB_NAME }] = await Promise.all([
      import('./mock/passkey'),
      import('./mock/index'),
    ]);
    return { authenticator: createSimulatedAuthenticator(), flagKey: lockFlagKey(MOCK_LOCAL_DB_NAME) };
  }
  return { authenticator: createWebAuthnAuthenticator(), flagKey: LS_LOCK_ENABLED };
}
