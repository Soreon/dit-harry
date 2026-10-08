/**
 * Installation de l'appli (PWA) : règles de décision pures, sans navigateur → testables seules.
 * L'état réactif et les écouteurs (`beforeinstallprompt`, `appinstalled`) sont dans
 * install.svelte.ts.
 */

/**
 * Préférence d'appareil : quand la carte « Installe Dit Harry » a été fermée, ou l'installation
 * refusée dans la fenêtre de Chrome (ms depuis 1970).
 */
export const LS_INSTALL_DISMISSED_AT = 'dh.ui.installDismissedAt';

/** Après une fermeture, la carte d'installation revient au bout de 30 jours. */
export const INSTALL_CARD_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** Issue d'une demande d'installation (`unavailable` : Chrome n'a rien proposé). */
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

export interface InstallFlags {
  /** Chrome a fourni un `beforeinstallprompt` encore inutilisé. */
  canPrompt: boolean;
  /** L'appli tourne déjà en fenêtre d'appli installée. */
  standalone: boolean;
  /** Installation constatée pendant cette visite (`appinstalled` ou proposition acceptée). */
  installed: boolean;
}

/** Bouton « Installer » utilisable : Chrome peut afficher sa fenêtre, et l'appli n'est pas installée. */
export function canOfferInstall(f: InstallFlags): boolean {
  return f.canPrompt && !f.standalone && !f.installed;
}

/**
 * Carte « Installe Dit Harry » de l'écran Aujourd'hui : jamais pendant un enregistrement, ni
 * pendant les 30 jours qui suivent une fermeture (croix, ou refus dans la fenêtre de Chrome,
 * qui renvoie aussitôt un `beforeinstallprompt`). Un écart d'horloge dans l'autre sens (date
 * enregistrée dans le futur) compte de la même façon : une valeur absurde ne la masque pas à vie.
 */
export function shouldShowInstallCard(
  s: InstallFlags & { recording: boolean; dismissedAt: number | null; now: number },
): boolean {
  if (!canOfferInstall(s) || s.recording) return false;
  if (s.dismissedAt === null) return true;
  return Math.abs(s.now - s.dismissedAt) >= INSTALL_CARD_SNOOZE_MS;
}

/** Valeur lue dans localStorage → date de fermeture, ou `null` si absente ou illisible. */
export function parseDismissedAt(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Section « Application » des réglages : déjà installée, bouton d'installation, ou mode d'emploi. */
export function installSectionMode(f: InstallFlags): 'installed' | 'prompt' | 'manual' {
  if (f.standalone || f.installed) return 'installed';
  return f.canPrompt ? 'prompt' : 'manual';
}

/**
 * Appli ouverte depuis son icône : fenêtre `standalone` (PWA installée), ou application Android
 * qui l'embarque (Trusted Web Activity : référent `android-app://…`).
 */
export function isStandaloneDisplay(displayModeStandalone: boolean, referrer: string): boolean {
  return displayModeStandalone || referrer.startsWith('android-app://');
}
