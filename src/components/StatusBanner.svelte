<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import type { SyncPhase } from '../lib/types';
  import { formatDuration, plural } from './helpers';
  import Icon from './Icon.svelte';

  // Bandeau d'état en haut : enregistrement en cours, hors ligne, session expirée,
  // clé manquante, erreur de synchro, synchro en cours / entrées en attente.
  const app = useApp();

  const PHASES: Record<SyncPhase, string> = {
    idle: 'Synchronisation…',
    analyzing: 'Analyse de tes entrées…',
    pulling: 'Récupération depuis Drive…',
    pushing: 'Envoi vers Drive…',
    synthesizing: 'Écriture des synthèses…',
    housekeeping: 'Petit ménage…',
    mirroring: 'Copie lisible dans Drive…',
  };

  const s = $derived(app.syncStatus);
  const recordingElsewhere = $derived(app.recording.status === 'recording' && app.route.name !== 'today');
  const keyIssue = $derived(!app.hasKey || s.needsKey);
  const showKeyRow = $derived(keyIssue && app.route.name !== 'settings');
  const showError = $derived(
    app.online &&
      !s.running &&
      !!s.lastError &&
      !s.needsAuth &&
      !s.needsKey &&
      s.lastErrorKind !== 'auth' &&
      s.lastErrorKind !== 'invalid-key',
  );
  const pendingText = $derived(app.pendingCount > 0 ? plural(app.pendingCount, 'entrée en attente', 'entrées en attente') : '');
  // Ligne texte seulement s'il y a des entrées en attente (sinon, la fine barre de
  // progression suffit : pas de saut de mise en page à chaque synchro)
  const showSyncRow = $derived(
    app.online && !app.needsReconnect && !showError && app.pendingCount > 0 && (s.running || !keyIssue),
  );
</script>

<div class="banner">
  {#if s.running}
    <div class="progress" aria-hidden="true"></div>
  {/if}
  <p class="sr-only" aria-live="polite">{s.running ? PHASES[s.phase] : ''}</p>

  {#if recordingElsewhere}
    <a class="bar bar-rec" href="#/">
      <span class="rec-dot" aria-hidden="true"></span>
      <span class="text">Enregistrement en cours · {formatDuration(app.recording.seconds)}</span>
      <span class="link">Revenir</span>
    </a>
  {/if}

  {#if app.unsavedRecording}
    <div class="bar bar-error" role="alert">
      <Icon name="alert" size={20} />
      <span class="text">
        {app.unsavedRecording.downloaded
          ? 'Audio téléchargé. Libère de la place puis réessaie pour en faire une entrée.'
          : "Enregistrement pas encore gardé (stockage plein). Libère de la place puis réessaie, ou télécharge l'audio."}
      </span>
      <span class="bar-actions">
        <button type="button" class="btn btn-small btn-secondary" onclick={() => app.retryUnsavedRecording()}>
          Réessayer
        </button>
        {#if app.unsavedRecording.downloaded}
          <button type="button" class="btn btn-small btn-ghost" onclick={() => app.dismissUnsavedRecording()}>
            Fermer
          </button>
        {:else}
          <button type="button" class="btn btn-small btn-ghost" onclick={() => app.downloadUnsavedRecording()}>
            Télécharger
          </button>
        {/if}
      </span>
    </div>
  {/if}

  {#if !app.online}
    <div class="bar bar-neutral">
      <Icon name="cloud-off" size={20} />
      <span class="text">
        Hors ligne — tout reste gardé sur ton téléphone{pendingText ? ` · ${pendingText}` : ''}.
      </span>
    </div>
  {/if}

  {#if app.needsReconnect}
    <div class="bar bar-warning" role="alert">
      <Icon name="user" size={20} />
      <span class="text">
        {app.auth.status === 'error' && app.auth.error ? app.auth.error : 'Ta session Google a expiré.'}
      </span>
      <button
        type="button"
        class="btn btn-small btn-primary"
        disabled={app.auth.status === 'signing-in'}
        onclick={() => app.signIn()}
      >
        Se reconnecter
      </button>
    </div>
  {/if}

  {#if showKeyRow}
    <div class="bar bar-warning">
      <Icon name="key" size={20} />
      <span class="text">
        {app.hasKey ? 'Gemini refuse ta clé : les analyses attendent.' : 'Clé Gemini manquante : les analyses attendent.'}
      </span>
      <a class="btn btn-small btn-secondary" href="#/reglages">{app.hasKey ? 'Changer' : 'Ajouter'}</a>
    </div>
  {/if}

  {#if showError}
    <div class="bar bar-error">
      <Icon name="alert" size={20} />
      <span class="text">{s.lastError}</span>
      <button type="button" class="btn btn-small btn-secondary" onclick={() => app.syncNow()}>Réessayer</button>
    </div>
  {/if}

  {#if showSyncRow}
    <div class="bar bar-quiet">
      {#if s.running}
        <span class="spinner" aria-hidden="true"></span>
        <span class="text">{PHASES[s.phase]}{pendingText ? ` · ${pendingText}` : ''}</span>
      {:else}
        <Icon name="sync" size={18} />
        <span class="text">{pendingText}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .banner {
    position: sticky;
    top: 0;
    z-index: 20;
    padding-top: var(--safe-top);
    background: var(--bg);
  }

  .progress {
    position: absolute;
    top: var(--safe-top);
    left: 0;
    right: 0;
    height: 3px;
    overflow: hidden;
    background: var(--accent-soft);
  }

  .progress::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 40%;
    background: var(--accent);
    border-radius: 3px;
    animation: slide 1.4s ease-in-out infinite;
  }

  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(250%);
    }
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    max-width: var(--content-max);
    margin: 0 auto;
    padding: 6px calc(var(--gutter) + var(--safe-right)) 6px calc(var(--gutter) + var(--safe-left));
    font-size: 0.875rem;
    line-height: 1.35;
    text-decoration: none;
    color: inherit;
  }

  .bar + .bar {
    border-top: 1px solid var(--line);
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  .bar-neutral {
    background: var(--surface-sunk);
    color: var(--ink);
    max-width: none;
  }

  .bar-warning {
    background: var(--warning-soft);
    color: var(--warning);
    max-width: none;
  }

  .bar-error {
    background: var(--danger-soft);
    color: var(--danger);
    max-width: none;
  }

  .bar-rec {
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-weight: 600;
    max-width: none;
  }

  .bar-quiet {
    color: var(--ink-muted);
    min-height: 36px;
  }

  .link {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .rec-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  .bar .btn {
    flex: none;
  }

  .bar-actions {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
</style>
