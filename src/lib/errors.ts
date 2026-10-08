import type { ErrorKind } from './types';

/** Erreur applicative typée. `message` est TOUJOURS en français, lisible par l'utilisateur. */
export class AppError extends Error {
  readonly kind: ErrorKind;
  /** Peut être retentée automatiquement plus tard. */
  readonly retryable: boolean;
  /** Statut HTTP éventuel. */
  readonly status?: number;
  /** Délai suggéré avant nouvel essai (ms), ex. Retry-After. */
  readonly retryAfterMs?: number;

  constructor(
    kind: ErrorKind,
    message: string,
    opts: { retryable?: boolean; status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.kind = kind;
    this.retryable = opts.retryable ?? (kind === 'network' || kind === 'quota' || kind === 'auth');
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Convertit n'importe quelle erreur en AppError (message français générique si inconnu). */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof TypeError) {
    // fetch() rejette avec TypeError en cas d'échec réseau
    return new AppError('network', 'Connexion impossible. Réessai automatique plus tard.', { cause: e });
  }
  if (e instanceof DOMException && e.name === 'AbortError') {
    return new AppError('network', 'La requête a été interrompue.', { cause: e });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new AppError('other', `Erreur inattendue : ${msg}`, { retryable: false, cause: e });
}
