<script lang="ts">
  import { onMount } from 'svelte';
  import { useApp } from '../lib/app.svelte';
  import { toAppError } from '../lib/errors';
  import type { LocalEntry } from '../lib/types';
  import { formatDuration, plural } from './helpers';
  import Icon from './Icon.svelte';

  // Lecteur audio natif. Audio local chargé tout de suite ; audio Drive téléchargé à la
  // demande (données mobiles). L'URL blob est révoquée en quittant l'écran.
  let { entry }: { entry: LocalEntry } = $props();
  const app = useApp();

  let url = $state<string | null>(null);
  let loading = $state(false);
  let error = $state('');

  const available = $derived(entry.local.hasLocalAudio || !!entry.audioFileId);
  const duration = $derived(entry.durationSec ? formatDuration(entry.durationSec) : '');
  const retention = $derived.by(() => {
    const d = app.settings.audioRetentionDays;
    return d === 365 ? '1 an' : d % 365 === 0 ? plural(d / 365, 'an', 'ans') : plural(d, 'jour', 'jours');
  });

  async function load(): Promise<void> {
    if (loading || url) return;
    loading = true;
    error = '';
    try {
      url = await app.audioUrl(entry);
      if (!url) error = "L'audio est introuvable.";
    } catch (e) {
      error = toAppError(e).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    const id = entry.id;
    if (entry.local.hasLocalAudio) void load();
    return () => app.releaseAudio(id);
  });
</script>

<div class="player">
  {#if entry.audioExpired}
    <p class="muted note">Audio supprimé après {retention} — la transcription, elle, reste.</p>
  {:else if !available}
    <p class="muted note">Audio indisponible sur cet appareil.</p>
  {:else if url}
    <audio controls preload="metadata" src={url}></audio>
    {#if duration}<span class="duration">Durée : {duration}</span>{/if}
  {:else}
    <button type="button" class="btn btn-secondary" disabled={loading || (!app.online && !entry.local.hasLocalAudio)} onclick={load}>
      {#if loading}
        <span class="spinner" aria-hidden="true"></span> Chargement…
      {:else}
        <Icon name="mic" size={18} /> Écouter{duration ? ` (${duration})` : ''}
      {/if}
    </button>
    {#if !app.online && !entry.local.hasLocalAudio}
      <span class="muted note">L'audio est dans ton Drive : connecte-toi à Internet pour l'écouter.</span>
    {/if}
  {/if}
  {#if error}<p class="notice notice-error" role="alert">{error}</p>{/if}
</div>

<style>
  .player {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  audio {
    width: 100%;
    height: 44px;
  }

  .duration,
  .note {
    font-size: 0.875rem;
  }

  .duration {
    color: var(--ink-muted);
  }
</style>
