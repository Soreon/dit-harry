import { AppError, isAppError, toAppError } from './errors';
import type { AuthService, DriveClient, DriveFileMeta } from './types';
import { newId } from './util';

/* ------------------------------------------------------------------ */
/* Constantes (voir docs/api-notes.md §3)                              */
/* ------------------------------------------------------------------ */

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

/** Champs toujours demandés (sinon Drive ne renvoie que kind,id,name,mimeType). */
export const FILE_FIELDS = 'id,name,mimeType,createdTime,modifiedTime,size,appProperties';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Au-delà de 5 Mo : envoi « resumable » (session puis PUT). */
export const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;

/** Garde-fou contre une pagination qui ne finirait jamais. */
const MAX_PAGES = 1000;

const QUOTA_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
]);

const MSG_NO_TOKEN = 'Session Google expirée : reconnecte-toi pour synchroniser ton journal.';
const MSG_QUOTA = 'Google Drive limite le nombre de requêtes. Nouvel essai automatique dans un moment.';
const MSG_DRIVE_FULL = 'Ton Google Drive est plein. Libère de la place pour que la sauvegarde reprenne.';
const MSG_SCOPE =
  'Autorisation Google Drive manquante : reconnecte-toi et coche les deux autorisations demandées.';
const MSG_NOT_FOUND = 'Fichier introuvable dans Google Drive.';
const MSG_SERVER = 'Google Drive ne répond pas pour le moment. Nouvel essai automatique plus tard.';
const MSG_BAD_JSON = 'Réponse illisible de Google Drive.';
const MSG_NO_SESSION = "Google Drive n'a pas ouvert la session d'envoi du fichier.";

/* ------------------------------------------------------------------ */
/* Aides                                                               */
/* ------------------------------------------------------------------ */

/** Échappe une valeur placée entre apostrophes dans un `q` Drive (\ d'abord, puis '). */
export function escapeQueryValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Taille réelle en octets (UTF-8 pour une chaîne). */
function byteSize(body: Blob | string): number {
  return typeof body === 'string' ? new TextEncoder().encode(body).length : body.size;
}

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function fileUrl(base: string, fileId: string): string {
  return `${base}/files/${encodeURIComponent(fileId)}`;
}

/** Corps multipart/related : métadonnées JSON puis contenu (CRLF, docs/api-notes.md §3.4). */
export function buildMultipartBody(
  metadata: Record<string, unknown>,
  body: Blob | string,
  mimeType: string,
  boundary: string,
): Blob {
  return new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    body,
    `\r\n--${boundary}--`,
  ]);
}

interface GoogleErrorInfo {
  /** `error.errors[0].reason` (clé principale chez Drive). */
  reason?: string;
  /** `ErrorInfo.reason` de `error.details[]` (format moderne, MAJUSCULES). */
  detailReason?: string;
}

async function readGoogleError(res: Response): Promise<GoogleErrorInfo> {
  try {
    const data = JSON.parse(await res.text()) as unknown;
    const err = (data as { error?: unknown } | null)?.error;
    if (!err || typeof err !== 'object') return {};
    const { errors, details } = err as { errors?: unknown; details?: unknown };
    const out: GoogleErrorInfo = {};
    if (Array.isArray(errors)) {
      const reason = (errors[0] as { reason?: unknown } | undefined)?.reason;
      if (typeof reason === 'string') out.reason = reason;
    }
    if (Array.isArray(details)) {
      for (const d of details as unknown[]) {
        const rec = d as { '@type'?: unknown; reason?: unknown } | null;
        if (rec?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && typeof rec.reason === 'string') {
          out.detailReason = rec.reason;
          break;
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** En-tête Retry-After en secondes (s'il est exposé par CORS). */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('Retry-After');
  if (!raw) return undefined;
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 ? Math.ceil(sec * 1000) : undefined;
}

function isNotFound(e: unknown): boolean {
  return isAppError(e) && e.status === 404;
}

function isFileMeta(v: unknown): v is DriveFileMeta {
  return !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string';
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/**
 * Client Drive REST v3. Le jeton est relu via `auth.getToken()` à chaque appel ;
 * sans jeton → AppError('auth'). Un 401 invalide le jeton (`auth.markExpired()`).
 */
export function createDriveClient(
  auth: Pick<AuthService, 'getToken' | 'markExpired'>,
  fetchImpl?: typeof fetch,
): DriveClient {
  const doFetch: typeof fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);

  /** Traduit une réponse HTTP en erreur (tableau de SPEC.md §5). */
  async function toDriveError(res: Response): Promise<AppError> {
    const status = res.status;
    const { reason, detailReason } = await readGoogleError(res);
    if (status === 401) {
      auth.markExpired();
      return new AppError('auth', MSG_NO_TOKEN, { status });
    }
    if (status === 429 || (status === 403 && reason !== undefined && QUOTA_REASONS.has(reason))) {
      const opts: { status: number; retryAfterMs?: number } = { status };
      const delay = retryAfterMs(res);
      if (delay !== undefined) opts.retryAfterMs = delay;
      return new AppError('quota', MSG_QUOTA, opts);
    }
    if (status === 403 && reason === 'storageQuotaExceeded') {
      return new AppError('other', MSG_DRIVE_FULL, { status });
    }
    if (
      status === 403 &&
      (reason === 'insufficientPermissions' || detailReason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')
    ) {
      // Une autorisation a été décochée/retirée : il faut repasser par le consentement
      auth.markExpired();
      return new AppError('auth', MSG_SCOPE, { status });
    }
    if (status === 404) return new AppError('other', MSG_NOT_FOUND, { status });
    if (status >= 500 || status === 408) return new AppError('network', MSG_SERVER, { status });
    const detail = reason ?? detailReason;
    return new AppError(
      'other',
      `Google Drive a refusé la requête (erreur ${status}${detail ? ` : ${detail}` : ''}).`,
      { status },
    );
  }

  /** Requête Drive (jeton ajouté sauf `authenticated:false`) ; lève une AppError si non 2xx. */
  async function send(url: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated) {
      const token = auth.getToken();
      if (!token) throw new AppError('auth', MSG_NO_TOKEN);
      headers.set('Authorization', `Bearer ${token}`);
    }
    let res: Response;
    try {
      res = await doFetch(url, { ...init, headers });
    } catch (e) {
      // TypeError (hors ligne, CORS…) → network
      throw toAppError(e);
    }
    if (!res.ok) throw await toDriveError(res);
    return res;
  }

  async function readText(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch (e) {
      throw toAppError(e);
    }
  }

  async function readJson<T>(res: Response): Promise<T> {
    const text = await readText(res);
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new AppError('bad-response', MSG_BAD_JSON, { status: res.status, retryable: true, cause: e });
    }
  }

  async function getMeta(fileId: string): Promise<DriveFileMeta> {
    const res = await send(`${fileUrl(API, fileId)}?${qs({ fields: FILE_FIELDS })}`);
    const data = await readJson<unknown>(res);
    if (!isFileMeta(data)) throw new AppError('bad-response', MSG_BAD_JSON, { retryable: true });
    return data;
  }

  /** Valide une réponse fichier ; si des champs manquent, relit les métadonnées. */
  async function completeMeta(res: Response): Promise<DriveFileMeta> {
    const data = await readJson<unknown>(res);
    if (!isFileMeta(data)) throw new AppError('bad-response', MSG_BAD_JSON, { retryable: true });
    if (!data.modifiedTime || !data.createdTime || !data.name || !data.mimeType) return getMeta(data.id);
    return data;
  }

  /** Envoi resumable : ouverture de session (POST création / PATCH mise à jour) puis PUT unique. */
  async function resumableUpload(
    method: 'POST' | 'PATCH',
    baseUrl: string,
    metadata: Record<string, unknown> | null,
    body: Blob | string,
    mimeType: string,
    size: number,
  ): Promise<DriveFileMeta> {
    const headers: Record<string, string> = {
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(size),
    };
    const init: RequestInit = { method, headers };
    if (metadata) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      init.body = JSON.stringify(metadata);
    }
    const start = await send(`${baseUrl}?${qs({ uploadType: 'resumable', fields: FILE_FIELDS })}`, init);
    const location = start.headers.get('Location');
    if (!location) throw new AppError('bad-response', MSG_NO_SESSION, { retryable: true });
    // PUT vers l'URI de session SANS en-tête Authorization (docs/api-notes.md §3.5)
    const res = await send(location, { method: 'PUT', headers: { 'Content-Type': mimeType }, body }, false);
    return completeMeta(res);
  }

  /** Création : multipart (≤ 5 Mo) ou resumable (au-delà). */
  async function createFile(
    metadata: Record<string, unknown>,
    body: Blob | string,
    mimeType: string,
  ): Promise<DriveFileMeta> {
    const size = byteSize(body);
    if (size > RESUMABLE_THRESHOLD) {
      return resumableUpload('POST', `${UPLOAD_API}/files`, metadata, body, mimeType, size);
    }
    const boundary = `dh-${newId()}`;
    const res = await send(`${UPLOAD_API}/files?${qs({ uploadType: 'multipart', fields: FILE_FIELDS })}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: buildMultipartBody(metadata, body, mimeType, boundary),
    });
    return completeMeta(res);
  }

  async function updateFileContent(fileId: string, body: Blob | string, mimeType: string): Promise<DriveFileMeta> {
    const size = byteSize(body);
    const url = fileUrl(UPLOAD_API, fileId);
    if (size > RESUMABLE_THRESHOLD) return resumableUpload('PATCH', url, null, body, mimeType, size);
    const res = await send(`${url}?${qs({ uploadType: 'media', fields: FILE_FIELDS })}`, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body,
    });
    return completeMeta(res);
  }

  /** Premier fichier (le plus ancien) correspondant à `q`, hors appDataFolder. */
  async function findFirst(q: string): Promise<string | undefined> {
    const res = await send(
      `${API}/files?${qs({ q, fields: 'files(id,name)', pageSize: '10', orderBy: 'createdTime' })}`,
    );
    const data = await readJson<{ files?: unknown[] } | null>(res);
    const first = (data?.files ?? []).find(isFileMeta);
    return first?.id;
  }

  async function listAppData(): Promise<DriveFileMeta[]> {
    let files: DriveFileMeta[] = [];
    let pageToken: string | undefined;
    let restarted = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = {
        spaces: 'appDataFolder',
        pageSize: '1000',
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        q: 'trashed = false',
      };
      if (pageToken) params['pageToken'] = pageToken;
      let data: { files?: unknown[]; nextPageToken?: unknown } | null;
      try {
        data = await readJson<{ files?: unknown[]; nextPageToken?: unknown } | null>(
          await send(`${API}/files?${qs(params)}`),
        );
      } catch (e) {
        // Jeton de page refusé : reprendre une fois depuis la première page (docs/api-notes.md §3.3)
        if (pageToken && !restarted && isAppError(e) && e.status === 400) {
          restarted = true;
          files = [];
          pageToken = undefined;
          continue;
        }
        throw e;
      }
      for (const f of data?.files ?? []) if (isFileMeta(f)) files.push(f);
      const next = data?.nextPageToken;
      if (typeof next !== 'string' || !next) return files;
      pageToken = next;
    }
    throw new AppError('bad-response', 'Liste des fichiers Google Drive anormalement longue.', {
      retryable: true,
    });
  }

  return {
    async about() {
      const data = await readJson<{ user?: { emailAddress?: unknown; displayName?: unknown } } | null>(
        await send(`${API}/about?${qs({ fields: 'user' })}`),
      );
      const email = data?.user?.emailAddress;
      const name = data?.user?.displayName;
      return { email: typeof email === 'string' ? email : '', name: typeof name === 'string' ? name : '' };
    },

    listAppData,

    async downloadJson<T>(fileId: string): Promise<T> {
      return readJson<T>(await send(`${fileUrl(API, fileId)}?${qs({ alt: 'media' })}`));
    },

    async downloadBlob(fileId: string): Promise<Blob> {
      const res = await send(`${fileUrl(API, fileId)}?${qs({ alt: 'media' })}`);
      try {
        return await res.blob();
      } catch (e) {
        throw toAppError(e);
      }
    },

    createAppDataFile(name, body, mimeType, appProperties) {
      return createFile({ name, mimeType, parents: ['appDataFolder'], appProperties }, body, mimeType);
    },

    updateFileContent,

    async deleteFile(fileId) {
      try {
        await send(fileUrl(API, fileId), { method: 'DELETE' });
      } catch (e) {
        // Déjà supprimé ailleurs : c'est le résultat voulu
        if (isNotFound(e)) return;
        throw e;
      }
    },

    async ensureFolder(name, parentId) {
      const parent = parentId ?? 'root';
      // Avec drive.file, seuls les dossiers créés par l'appli sont visibles
      const found = await findFirst(
        `mimeType = '${FOLDER_MIME}' and name = '${escapeQueryValue(name)}' and trashed = false and '${escapeQueryValue(parent)}' in parents`,
      );
      if (found) return found;
      const res = await send(`${API}/files?${qs({ fields: 'id' })}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
      });
      const data = await readJson<unknown>(res);
      if (!isFileMeta(data)) throw new AppError('bad-response', MSG_BAD_JSON, { retryable: true });
      return data.id;
    },

    async upsertTextFile(parentId, name, content, mimeType, existingId) {
      if (existingId) {
        try {
          return (await updateFileContent(existingId, content, mimeType)).id;
        } catch (e) {
          // Supprimé entre-temps → recréer
          if (!isNotFound(e)) throw e;
        }
      }
      // Un fichier du même nom existe peut-être déjà (autre appareil, cache local perdu)
      const found = await findFirst(
        `name = '${escapeQueryValue(name)}' and '${escapeQueryValue(parentId)}' in parents and mimeType != '${FOLDER_MIME}' and trashed = false`,
      );
      if (found && found !== existingId) return (await updateFileContent(found, content, mimeType)).id;
      return (await createFile({ name, mimeType, parents: [parentId] }, content, mimeType)).id;
    },
  };
}
