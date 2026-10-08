<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import { activeMentions, pendingProposals } from '../lib/mentions';
  import type { LocalEntry } from '../lib/types';
  import {
    entrySnippet,
    entryStatus,
    entryTitle,
    formatDayShort,
    formatDuration,
    formatTime,
    hrefEntry,
    moodEmoji,
    plural,
  } from './helpers';
  import Icon from './Icon.svelte';

  // Carte d'une entrée : heure, source, humeur, titre, résumé, rattachements à d'autres jours,
  // statut (+ Réessayer).
  let { entry, lines = 2 }: { entry: LocalEntry; lines?: 1 | 2 | 3 } = $props();
  const app = useApp();

  const status = $derived(entryStatus(entry, app.syncStatus));
  const snippet = $derived(entrySnippet(entry));
  const linked = $derived(app.dayLinksOn ? activeMentions(entry) : []);
  const toChoose = $derived(app.dayLinksOn ? pendingProposals(entry).length : 0);
  let retrying = $state(false);

  async function retry(): Promise<void> {
    retrying = true;
    try {
      await app.retryEntry(entry.id);
    } finally {
      retrying = false;
    }
  }
</script>

<article class="entry card" class:waiting={!entry.analysis}>
  <div class="meta">
    <span class="time">{formatTime(entry.createdAt)}</span>
    <span class="source">
      <Icon name={entry.source === 'voice' ? 'mic' : 'pen'} size={15} />
      {#if entry.source === 'voice'}
        {entry.durationSec ? formatDuration(entry.durationSec) : 'Vocal'}
      {:else}
        Écrit
      {/if}
    </span>
    {#if entry.analysis}
      <span class="mood" role="img" aria-label="Humeur : {entry.analysis.mood.label}" title={entry.analysis.mood.label}>
        {moodEmoji(entry.analysis.mood.score)}
      </span>
    {/if}
  </div>

  <h3 class="title"><a class="stretched-link" href={hrefEntry(entry.id)}>{entryTitle(entry)}</a></h3>

  {#if snippet}
    <p class="snippet" style:-webkit-line-clamp={lines} style:line-clamp={lines}>{snippet}</p>
  {/if}

  {#if linked.length > 0 || toChoose > 0}
    <p class="links">
      {#each linked.slice(0, 2) as m (m.id)}
        <span class="chip" class:chip-future={m.kind === 'future'}>
          <span aria-hidden="true">{m.kind === 'past' ? '↪' : '📌'}</span>
          <span class="sr-only">{m.kind === 'past' ? 'Ajouté au' : 'Prévu le'}</span>
          {formatDayShort(m.day)}
        </span>
      {/each}
      {#if linked.length > 2}<span class="chip">+{linked.length - 2}</span>{/if}
      {#if toChoose > 0}
        <span class="chip chip-pending">{plural(toChoose, 'jour à choisir', 'jours à choisir')}</span>
      {/if}
    </p>
  {/if}

  {#if status.kind !== 'ok'}
    <div class="status">
      <span class="chip chip-{status.kind}">
        {#if status.kind === 'analyzing'}<span class="spinner" aria-hidden="true"></span>{/if}
        {status.label}
      </span>
      {#if status.kind === 'error'}
        <span class="error-text">{entry.local.error}</span>
        <button type="button" class="btn btn-small btn-ghost retry" disabled={retrying} onclick={retry}>
          <Icon name="retry" size={16} /> Réessayer
        </button>
      {/if}
    </div>
  {/if}
</article>

<style>
  .entry {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 16px;
    transition:
      border-color 0.15s ease,
      transform 0.1s ease;
  }

  .entry:hover {
    border-color: var(--line-strong);
  }

  .entry:active {
    transform: scale(0.99);
  }

  .entry:has(.stretched-link:focus-visible) {
    outline: 3px solid var(--focus-ring);
    outline-offset: 2px;
  }

  .stretched-link:focus-visible {
    outline: none;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.8125rem;
    color: var(--ink-muted);
    font-variant-numeric: tabular-nums;
  }

  .time {
    font-weight: 700;
    color: var(--ink);
  }

  .source {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .mood {
    margin-left: auto;
    font-size: 1.35rem;
    line-height: 1;
  }

  .title {
    font-size: 1.125rem;
  }

  .title a {
    color: var(--ink);
    text-decoration: none;
  }

  .waiting .title a {
    color: var(--ink-muted);
    font-style: italic;
  }

  .snippet {
    color: var(--ink-muted);
    font-size: 0.9375rem;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip-future {
    background: var(--accent-soft);
    color: var(--accent-strong);
  }

  .status {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 2px;
  }

  .error-text {
    flex: 1 1 160px;
    font-size: 0.8125rem;
    color: var(--danger);
  }

  .retry {
    position: relative;
    z-index: 1;
  }
</style>
