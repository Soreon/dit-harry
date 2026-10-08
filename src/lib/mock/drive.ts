import type { AuthService, DriveClient, DriveFileMeta } from '../types';
import { AppError } from '../errors';
import { sleep } from '../util';
import { MOCK_EMAIL, MOCK_NAME } from './auth';

/** Base IndexedDB du faux Drive (distincte de la base locale de l'appli). */
export const MOCK_DRIVE_DB_NAME = 'dit-harry-mock-drive';

const DB_VERSION = 1;
const FILES = 'files';
const META = 'meta';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Alias Drive du dossier caché de l'appli. */
const APPDATA = 'appDataFolder';
/** Alias Drive de « Mon Drive ». */
const ROOT = 'root';

type Space = 'appDataFolder' | 'drive';

/** Fichier tel que stocké dans le faux Drive. */
interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  /** 'appDataFolder' = caché (drive.appdata) ; 'drive' = visible (drive.file). */
  space: Space;
  parents: string[];
  appProperties?: Record<string, string>;
  /** Contenu ; absent pour un dossier. */
  data?: ArrayBuffer;
}

/** Métadonnées étendues pour le débogage et les tests. */
export interface MockDriveFile extends DriveFileMeta {
  space: Space;
  parents: string[];
}

/** Client Drive simulé : contrat `DriveClient` + quelques outils de démo/test. */
export interface MockDriveClient extends DriveClient {
  /** Tous les fichiers (cachés et visibles, dossiers compris), sans contrôle d'accès. */
  listAll(): Promise<MockDriveFile[]>;
  /** Contenu texte d'un fichier, sans contrôle d'accès. */
  readText(fileId: string): Promise<string>;
  /** Petites valeurs propres au mode démo (ex. jeu de données déjà créé). */
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;
  /** Vide entièrement le faux Drive. */
  reset(): Promise<void>;
  /** Ferme la connexion IndexedDB (rouverte au besoin). */
  close(): void;
}

export interface MockDriveOptions {
  /** Nom de la base IndexedDB (défaut `dit-harry-mock-drive`). */
  dbName?: string;
  /** Si fourni, chaque appel exige un jeton, comme le vrai client (sinon accès libre). */
  auth?: Pick<AuthService, 'getToken' | 'markExpired'>;
  /** Latence simulée par appel (ms). Défaut 0. */
  latencyMs?: number;
  now?: () => Date;
}

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Identifiant au format Drive (33 caractères, commence par « 1 »). */
function driveId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '1';
  for (const b of bytes) s += ID_CHARS.charAt(b & 63);
  return s;
}

function notFound(fileId: string): AppError {
  return new AppError('other', `Fichier introuvable dans Google Drive (${fileId}).`, {
    status: 404,
    retryable: false,
  });
}

function notDownloadable(): AppError {
  return new AppError('other', 'Un dossier ne peut pas être téléchargé.', { status: 403, retryable: false });
}

function toMeta(f: StoredFile): MockDriveFile {
  const meta: MockDriveFile = {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    createdTime: f.createdTime,
    modifiedTime: f.modifiedTime,
    space: f.space,
    parents: [...f.parents],
  };
  // Comme l'API : `size` (chaîne) seulement pour les fichiers à contenu, `appProperties` si définies.
  if (f.data) meta.size = String(f.data.byteLength);
  if (f.appProperties) meta.appProperties = { ...f.appProperties };
  return meta;
}

/** Retire les champs étendus pour coller exactement à `DriveFileMeta`. */
function publicMeta(f: StoredFile): DriveFileMeta {
  const { space: _space, parents: _parents, ...meta } = toMeta(f);
  return meta;
}

function isFolder(f: StoredFile): boolean {
  return f.mimeType === FOLDER_MIME;
}

function toArrayBuffer(body: Blob | string): Promise<ArrayBuffer> {
  return new Blob([body]).arrayBuffer();
}

/**
 * Faux Google Drive persisté dans IndexedDB : identifiants, dates de création/modification,
 * appProperties, dossier caché `appDataFolder`, dossiers et fichiers visibles, 404 sur fichier absent.
 */
export function createMockDriveClient(opts: MockDriveOptions = {}): MockDriveClient {
  const dbName = opts.dbName ?? MOCK_DRIVE_DB_NAME;
  const latencyMs = opts.latencyMs ?? 0;
  const now = opts.now ?? (() => new Date());
  let dbPromise: Promise<IDBDatabase> | null = null;
  let lastStampMs = 0;

  function openDb(): Promise<IDBDatabase> {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Un autre onglet supprime/met à jour la base : on libère la connexion.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error('IndexedDB indisponible'));
      };
    });
    return dbPromise;
  }

  /** Exécute `fn` dans une transaction et résout à la fin de celle-ci. */
  async function tx<T>(
    store: string,
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> {
    const db = await openDb();
    return new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = () => reject(t.error ?? new Error('Erreur IndexedDB'));
      t.onabort = () => reject(t.error ?? new Error('Transaction IndexedDB annulée'));
    });
  }

  const getFile = (id: string) => tx<StoredFile | undefined>(FILES, 'readonly', (s) => s.get(id));
  const putFile = (f: StoredFile) => tx(FILES, 'readwrite', (s) => void s.put(f)).then(() => undefined);
  const allFiles = async () => (await tx<StoredFile[]>(FILES, 'readonly', (s) => s.getAll())) ?? [];

  /** Horodatage ISO strictement croissant (deux écritures dans la même ms restent distinguables). */
  function stamp(): string {
    lastStampMs = Math.max(now().getTime(), lastStampMs + 1);
    return new Date(lastStampMs).toISOString();
  }

  /** Contrôles communs à chaque appel « réseau » : jeton, connexion, latence. */
  async function call(): Promise<void> {
    if (opts.auth && !opts.auth.getToken()) {
      throw new AppError('auth', 'Session Google expirée : reconnecte-toi.');
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new AppError('network', 'Pas de connexion : Google Drive est injoignable.');
    }
    if (latencyMs > 0) await sleep(latencyMs);
  }

  async function requireFolder(parentId: string): Promise<void> {
    if (parentId === ROOT) return;
    const parent = await getFile(parentId);
    if (!parent || parent.space !== 'drive' || !isFolder(parent)) throw notFound(parentId);
  }

  async function updateContent(f: StoredFile, body: Blob | string, mimeType: string): Promise<StoredFile> {
    const next: StoredFile = { ...f, data: await toArrayBuffer(body), mimeType, modifiedTime: stamp() };
    await putFile(next);
    return next;
  }

  async function createVisibleFile(
    parentId: string,
    name: string,
    mimeType: string,
    data?: ArrayBuffer,
  ): Promise<StoredFile> {
    const t = stamp();
    const f: StoredFile = {
      id: driveId(),
      name,
      mimeType,
      createdTime: t,
      modifiedTime: t,
      space: 'drive',
      parents: [parentId],
    };
    if (data) f.data = data;
    await putFile(f);
    return f;
  }

  async function download(fileId: string): Promise<StoredFile & { data: ArrayBuffer }> {
    const f = await getFile(fileId);
    if (!f) throw notFound(fileId);
    if (!f.data) throw notDownloadable();
    return { ...f, data: f.data };
  }

  return {
    async about() {
      await call();
      return { email: MOCK_EMAIL, name: MOCK_NAME };
    },

    async listAppData() {
      await call();
      return (await allFiles())
        .filter((f) => f.space === APPDATA)
        .sort((a, b) => (a.createdTime < b.createdTime ? -1 : a.createdTime > b.createdTime ? 1 : 0))
        .map(publicMeta);
    },

    async downloadJson<T>(fileId: string): Promise<T> {
      await call();
      const f = await download(fileId);
      try {
        return JSON.parse(new TextDecoder().decode(f.data)) as T;
      } catch (e) {
        throw new AppError('other', `Fichier Drive illisible (${f.name}).`, { retryable: false, cause: e });
      }
    },

    async downloadBlob(fileId) {
      await call();
      const f = await download(fileId);
      return new Blob([f.data], { type: f.mimeType });
    },

    async createAppDataFile(name, body, mimeType, appProperties) {
      await call();
      const t = stamp();
      const f: StoredFile = {
        id: driveId(),
        name,
        mimeType,
        createdTime: t,
        modifiedTime: t,
        space: APPDATA,
        parents: [APPDATA],
        appProperties: { ...appProperties },
        data: await toArrayBuffer(body),
      };
      await putFile(f);
      return publicMeta(f);
    },

    async updateFileContent(fileId, body, mimeType) {
      await call();
      const f = await getFile(fileId);
      if (!f) throw notFound(fileId);
      if (isFolder(f)) throw notDownloadable();
      return publicMeta(await updateContent(f, body, mimeType));
    },

    async deleteFile(fileId) {
      await call();
      // Suppression définitive ; un dossier emporte son contenu (comme Drive). Absent = succès.
      const all = await allFiles();
      if (!all.some((f) => f.id === fileId)) return;
      const doomed = new Set([fileId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of all) {
          if (!doomed.has(f.id) && f.parents.some((p) => doomed.has(p))) {
            doomed.add(f.id);
            grew = true;
          }
        }
      }
      await tx(FILES, 'readwrite', (s) => {
        for (const id of doomed) s.delete(id);
      });
    },

    async ensureFolder(name, parentId) {
      await call();
      const parent = parentId ?? ROOT;
      await requireFolder(parent);
      const existing = (await allFiles()).find(
        (f) => f.space === 'drive' && isFolder(f) && f.name === name && f.parents.includes(parent),
      );
      if (existing) return existing.id;
      return (await createVisibleFile(parent, name, FOLDER_MIME)).id;
    },

    async upsertTextFile(parentId, name, content, mimeType, existingId) {
      await call();
      if (existingId) {
        const f = await getFile(existingId);
        if (f && !isFolder(f)) return (await updateContent(f, content, mimeType)).id;
        // 404 : on retombe sur la recherche par nom puis la création.
      }
      await requireFolder(parentId);
      const same = (await allFiles()).find(
        (f) => f.space === 'drive' && !isFolder(f) && f.name === name && f.parents.includes(parentId),
      );
      if (same) return (await updateContent(same, content, mimeType)).id;
      return (await createVisibleFile(parentId, name, mimeType, await toArrayBuffer(content))).id;
    },

    async listAll() {
      return (await allFiles()).map(toMeta);
    },

    async readText(fileId) {
      const f = await download(fileId);
      return new TextDecoder().decode(f.data);
    },

    async getMeta<T>(key: string) {
      return tx<T | undefined>(META, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
    },

    async setMeta<T>(key: string, value: T) {
      await tx(META, 'readwrite', (s) => void s.put(value, key));
    },

    async reset() {
      await tx(FILES, 'readwrite', (s) => void s.clear());
      await tx(META, 'readwrite', (s) => void s.clear());
    },

    close() {
      void dbPromise?.then((db) => db.close()).catch(() => undefined);
      dbPromise = null;
    },
  };
}
