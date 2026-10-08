<script lang="ts">
  import { config } from '../config';
  import { useApp } from '../lib/app.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { formatDuration } from './helpers';
  import Icon from './Icon.svelte';

  // Gros bouton rond d'enregistrement (appui = démarrer, appui = arrêter), halo animé
  // selon le niveau sonore, chrono, « Annuler » pendant l'enregistrement, « Écrire » sinon.
  let { onwrite }: { onwrite: () => void } = $props();
  const app = useApp();

  const rec = $derived(app.recording);
  const isRecording = $derived(rec.status === 'recording');
  const busy = $derived(rec.status === 'starting' || rec.status === 'stopping');
  const level = $derived(isRecording ? Math.min(1, Math.max(0, rec.level)) : 0);
  const nearLimit = $derived(isRecording && rec.seconds >= config.maxRecordingSec - 5 * 60);

  let confirmCancel = $state(false);

  function toggle(): void {
    if (isRecording) void app.stopRecording();
    else if (rec.status === 'idle') void app.startRecording();
  }

  function askCancel(): void {
    // Moins de 5 s : rien d'important à perdre, pas de confirmation
    if (rec.seconds < 5) void app.cancelRecording();
    else confirmCancel = true;
  }

  const label = $derived(
    rec.status === 'starting'
      ? 'Démarrage…'
      : rec.status === 'stopping'
        ? 'Enregistrement…'
        : isRecording
          ? "Arrêter et garder l'enregistrement"
          : 'Commencer un enregistrement',
  );
</script>

<div class="dock" class:recording={isRecording}>
  <div class="side left">
    {#if isRecording || rec.status === 'starting'}
      <button type="button" class="btn btn-secondary" onclick={askCancel}>Annuler</button>
    {/if}
  </div>

  <div class="center" style:--level={level}>
    <span class="halo halo-outer" aria-hidden="true"></span>
    <span class="halo halo-inner" aria-hidden="true"></span>
    <button
      type="button"
      class="record"
      class:busy
      aria-label={label}
      disabled={busy || !app.ready}
      onclick={toggle}
    >
      {#if busy}
        <span class="spinner big-spinner" aria-hidden="true"></span>
      {:else}
        <Icon name={isRecording ? 'stop' : 'mic'} size={48} />
      {/if}
    </button>
  </div>

  <div class="side right">
    {#if !isRecording && !busy}
      <button type="button" class="btn btn-secondary" onclick={onwrite}>
        <Icon name="pen" size={18} /> Écrire
      </button>
    {/if}
  </div>

  <div class="under">
    {#if isRecording}
      <span class="timer" role="timer" aria-label="Durée enregistrée">
        <span class="rec-dot" aria-hidden="true"></span>
        {formatDuration(rec.seconds)}
      </span>
      {#if nearLimit}
        <span class="hint">Arrêt automatique à {formatDuration(config.maxRecordingSec)}</span>
      {/if}
    {:else if rec.status === 'stopping'}
      <span class="hint">Je garde ça précieusement…</span>
    {:else if rec.status === 'starting'}
      <span class="hint">J'ouvre le micro…</span>
    {:else}
      <span class="hint">Appuie pour parler</span>
    {/if}
  </div>
  <p class="sr-only" aria-live="polite">
    {isRecording ? 'Enregistrement en cours' : rec.status === 'stopping' ? 'Enregistrement terminé' : ''}
  </p>
</div>

<ConfirmDialog
  bind:open={confirmCancel}
  title="Abandonner l'enregistrement ?"
  message="Ce que tu viens de dire ne sera pas gardé."
  confirmLabel="Abandonner"
  cancelLabel="Continuer"
  danger
  onconfirm={() => void app.cancelRecording()}
/>

<style>
  .dock {
    position: sticky;
    bottom: calc(var(--tabbar-h) + var(--safe-bottom));
    z-index: 10;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    grid-template-rows: auto auto;
    align-items: center;
    column-gap: 12px;
    padding: 26px 0 14px;
    margin-top: auto;
    background: linear-gradient(to bottom, transparent, var(--bg) 22%);
  }

  .side {
    display: flex;
  }

  .left {
    justify-content: flex-end;
  }

  .right {
    justify-content: flex-start;
  }

  .center {
    position: relative;
    width: 120px;
    height: 120px;
    display: grid;
    place-items: center;
  }

  .halo {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--accent);
    pointer-events: none;
  }

  .halo-outer {
    opacity: 0.12;
    transform: scale(calc(1.08 + var(--level) * 0.55));
    transition: transform 0.09s linear;
  }

  .halo-inner {
    opacity: 0.18;
    transform: scale(calc(1.02 + var(--level) * 0.3));
    transition: transform 0.07s linear;
  }

  .dock:not(.recording) .halo-outer {
    animation: breathe 3.2s ease-in-out infinite;
  }

  @keyframes breathe {
    50% {
      transform: scale(1.16);
      opacity: 0.08;
    }
  }

  .record {
    position: relative;
    width: 120px;
    height: 120px;
    border-radius: 50%;
    border: 0;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--on-accent);
    box-shadow:
      0 10px 28px color-mix(in srgb, var(--accent) 40%, transparent),
      inset 0 -4px 0 rgb(0 0 0 / 0.08);
    transition:
      transform 0.12s ease,
      background-color 0.2s ease;
  }

  .record:active:not(:disabled) {
    transform: scale(0.95);
  }

  .record:disabled {
    cursor: progress;
  }

  .recording .record {
    background: var(--accent-strong);
  }

  .record:focus-visible {
    outline-offset: 6px;
  }

  .big-spinner {
    width: 40px;
    height: 40px;
    border-width: 3px;
  }

  .under {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    margin-top: 14px;
    min-height: 2.6em;
  }

  .timer {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 1.5rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }

  .rec-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    animation: blink 1.2s ease-in-out infinite;
  }

  @keyframes blink {
    50% {
      opacity: 0.25;
    }
  }

  .hint {
    color: var(--ink-muted);
    font-size: 0.9375rem;
  }

  /* Mouvement réduit : le halo suit le niveau par son opacité, sans changer d'échelle */
  @media (prefers-reduced-motion: reduce) {
    .halo-outer,
    .halo-inner {
      transform: scale(1.12);
      animation: none !important;
    }

    .halo-outer {
      opacity: calc(0.08 + var(--level) * 0.4);
    }

    .halo-inner {
      opacity: calc(0.12 + var(--level) * 0.3);
      transform: scale(1.05);
    }
  }
</style>
