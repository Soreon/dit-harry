import { AppError } from './errors';

/**
 * Écriture d'une archive zip « stockée » (méthode 0, sans compression), suffisante pour
 * l'export (texte + JSON). Noms de fichiers en UTF-8 (bit 11 du champ « general purpose »).
 * Pas de ZIP64 : au-delà de 4 Go ou de 65 535 fichiers, on lève une erreur.
 */

export interface ZipInput {
  /** Chemin dans l'archive, séparateur '/' (ex. 'markdown/2026/2026-10-08.md'). */
  path: string;
  /** Contenu : octets bruts, ou texte encodé en UTF-8. */
  data: Uint8Array | string;
  /** Date de modification (heure locale) ; par défaut 1980-01-01 00:00 (valeur fixe). */
  date?: Date;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
/** Version 2.0 : nécessaire pour l'extraction, et « créé par » (attributs MS-DOS). */
const ZIP_VERSION = 20;
/** Bit 11 : noms et commentaires encodés en UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const MAX_UINT32 = 0xffffffff;
const MAX_UINT16 = 0xffff;

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 (polynôme IEEE 802.3, celui du format zip), entier non signé. */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (table[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Date/heure au format MS-DOS (heure locale, précision 2 s, années 1980..2107). */
function dosDateTime(date: Date | undefined): { time: number; date: number } {
  if (!date || Number.isNaN(date.getTime())) {
    // 1980-01-01 00:00:00
    return { time: 0, date: (1 << 5) | 1 };
  }
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Chemin propre : séparateurs '/', sans '/' initial. */
function normalizePath(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p) {
    throw new AppError('other', "Nom de fichier vide dans l'archive.", { retryable: false });
  }
  return p;
}

function tooBig(): AppError {
  return new AppError('other', 'Export trop volumineux pour un fichier zip (4 Go maximum).', {
    retryable: false,
  });
}

/** Crée une archive zip (non compressée). */
export function createZip(files: ZipInput[]): Blob {
  if (files.length > MAX_UINT16) {
    throw new AppError('other', 'Trop de fichiers pour un fichier zip (65 535 maximum).', {
      retryable: false,
    });
  }

  const encoder = new TextEncoder();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(normalizePath(file.path));
    const data: Uint8Array<ArrayBuffer> =
      typeof file.data === 'string'
        ? encoder.encode(file.data)
        : file.data.buffer instanceof ArrayBuffer
          ? (file.data as Uint8Array<ArrayBuffer>)
          : new Uint8Array(file.data);
    if (name.length > MAX_UINT16) {
      throw new AppError('other', 'Nom de fichier trop long pour un fichier zip.', { retryable: false });
    }
    if (data.length > MAX_UINT32 || offset > MAX_UINT32) throw tooBig();

    const crc = crc32(data);
    const dt = dosDateTime(file.date);

    // En-tête local
    const local = new Uint8Array(LOCAL_HEADER_SIZE + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER_SIG, true);
    lv.setUint16(4, ZIP_VERSION, true); // version nécessaire
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, METHOD_STORED, true);
    lv.setUint16(10, dt.time, true);
    lv.setUint16(12, dt.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // taille compressée
    lv.setUint32(22, data.length, true); // taille d'origine
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // champ « extra »
    local.set(name, LOCAL_HEADER_SIZE);

    // En-tête du répertoire central
    const cen = new Uint8Array(CENTRAL_HEADER_SIZE + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, CENTRAL_HEADER_SIG, true);
    cv.setUint16(4, ZIP_VERSION, true); // créé par (MS-DOS, v2.0)
    cv.setUint16(6, ZIP_VERSION, true); // version nécessaire
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, METHOD_STORED, true);
    cv.setUint16(12, dt.time, true);
    cv.setUint16(14, dt.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // commentaire
    cv.setUint16(34, 0, true); // disque de départ
    cv.setUint16(36, 0, true); // attributs internes
    cv.setUint32(38, 0, true); // attributs externes
    cv.setUint32(42, offset, true); // position de l'en-tête local
    cen.set(name, CENTRAL_HEADER_SIZE);

    parts.push(local, data);
    central.push(cen);
    offset += local.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  if (centralOffset > MAX_UINT32 || centralOffset + centralSize + EOCD_SIZE > MAX_UINT32) throw tooBig();

  // Fin du répertoire central
  const eocd = new Uint8Array(EOCD_SIZE);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(4, 0, true); // numéro de ce disque
  ev.setUint16(6, 0, true); // disque du répertoire central
  ev.setUint16(8, files.length, true); // entrées sur ce disque
  ev.setUint16(10, files.length, true); // entrées au total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // commentaire

  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}
