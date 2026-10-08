<script lang="ts">
  import { tick } from 'svelte';
  import { useApp } from '../lib/app.svelte';
  import { activeMentions } from '../lib/mentions';
  import AudioPlayer from './AudioPlayer.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import EntryMentions from './EntryMentions.svelte';
  import {
    entryStatus,
    entryTitle,
    formatDayHeading,
    formatDayLong,
    formatDuration,
    formatRelative,
    formatTime,
    hrefDay,
    moodEmoji,
    splitParagraphs,
  } from './helpers';
  import Icon from './Icon.svelte';
  import TagList from './TagList.svelte';

  // Détail d'une entrée : audio, transcription corrigeable, analyse, réessayer, supprimer.
  let { id }: { id: string } = $props();
  const app = useApp();

  const entry = $derived(app.getEntry(id));
  const status = $derived(entry ? entryStatus(entry, app.syncStatus) : null);
  const backTarget = $derived(entry && entry.day !== app.today ? hrefDay(entry.day) : '#/');
  const canEdit = $derived(!!entry && (entry.source === 'text' || entry.transcript.trim() !== ''));
  /** Message de suppression : les rattachements à d'autres jours disparaissent avec l'entrée. */
  const deleteMessage = $derived.by(() => {
    const base = "Elle sera effacée de ce téléphone et de ton Google Drive, audio compris. C'est définitif.";
    const days = entry && app.dayLinksOn ? [...new Set(activeMentions(entry).map((m) => m.day))].sort() : [];
    if (days.length === 0) return base;
    const list = days.map((d) => formatDayLong(d, app.today)).join(', ');
    return `${base} Ses ajouts à d'autres jours (${list}) disparaîtront aussi.`;
  });

  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let retrying = $state(false);
  let confirmDelete = $state(false);
  let textarea = $state<HTMLTextAreaElement>();
  const editId = $props.id();

  async function startEdit(): Promise<void> {
    if (!entry) return;
    draft = entry.transcript;
    editing = true;
    await tick();
    textarea?.focus();
  }

  async function saveEdit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    saving = true;
    try {
      if (await app.updateTranscript(id, draft)) editing = false;
    } finally {
      saving = false;
    }
  }

  async function retry(): Promise<void> {
    retrying = true;
    try {
      await app.retryEntry(id);
    } finally {
      retrying = false;
    }
  }

  function remove(): void {
    const target = backTarget;
    void app.deleteEntry(id);
    app.goUp(target);
  }
</script>

<section class="screen entry" aria-labelledby="entry-title">
  <header class="screen-header">
    <button type="button" class="icon-btn" aria-label="Retour" onclick={() => app.goUp(backTarget)}>
      <Icon name="back" />
    </button>
    {#if entry}
      <div class="titles">
        <p class="kicker">{formatDayHeading(entry.day, app.today)} · {formatTime(entry.createdAt)}</p>
        <h1 id="entry-title" class:waiting={!entry.analysis}>{entryTitle(entry)}</h1>
      </div>
    {:else}
      <h1 id="entry-title">Entrée</h1>
    {/if}
  </header>

  {#if !entry}
    <div class="stack">
      {#if app.ready}
        <p class="muted">Cette entrée n'existe plus (supprimée, peut-être depuis un autre appareil).</p>
        <a class="btn btn-secondary" href="#/journal">Aller au journal</a>
      {:else}
        <p class="muted"><span class="spinner" aria-hidden="true"></span> Chargement…</p>
      {/if}
    </div>
  {:else}
    <div class="meta row">
      <span class="chip">
        <Icon name={entry.source === 'voice' ? 'mic' : 'pen'} size={15} />
        {entry.source === 'voice' ? `Vocal${entry.durationSec ? ` · ${formatDuration(entry.durationSec)}` : ''}` : 'Écrit'}
      </span>
      {#if entry.analysis}
        <span class="chip mood-chip">
          <span class="emoji" aria-hidden="true">{moodEmoji(entry.analysis.mood.score)}</span>
          {entry.analysis.mood.label}
        </span>
      {/if}
      {#if status && status.kind !== 'ok' && status.kind !== 'error'}
        <span class="chip chip-{status.kind}">
          {#if status.kind === 'analyzing'}<span class="spinner" aria-hidden="true"></span>{/if}
          {status.label}
        </span>
      {/if}
    </div>

    {#if entry.local.error && entry.local.needsAnalysis}
      <div class="notice notice-error error-box" role="alert">
        <Icon name="alert" size={20} />
        <span class="grow">{entry.local.error}</span>
        <button type="button" class="btn btn-small btn-secondary" disabled={retrying} onclick={retry}>
          <Icon name="retry" size={16} /> Réessayer
        </button>
      </div>
    {/if}

    {#if entry.source === 'voice'}
      <section class="block" aria-label="Enregistrement">
        <AudioPlayer {entry} />
      </section>
    {/if}

    {#if entry.analysis?.summary}
      <blockquote class="summary">{entry.analysis.summary}</blockquote>
    {/if}

    <section class="block" aria-labelledby="{editId}-t">
      <div class="block-head">
        <h2 id="{editId}-t" class="section-title">{entry.source === 'voice' ? 'Transcription' : 'Texte'}</h2>
        {#if !editing && canEdit}
          <button type="button" class="btn btn-small btn-ghost" onclick={startEdit}>
            <Icon name="pen" size={16} /> Corriger
          </button>
        {/if}
      </div>

      {#if editing}
        <form class="edit" onsubmit={saveEdit}>
          <label class="sr-only" for="{editId}-area">Texte corrigé</label>
          <textarea id="{editId}-area" class="textarea" rows="10" bind:this={textarea} bind:value={draft}></textarea>
          <p class="field-help">Ta correction relancera l'analyse (titre, résumé, humeur…).</p>
          <div class="row actions">
            <button type="button" class="btn btn-secondary" onclick={() => (editing = false)}>Annuler</button>
            <button type="submit" class="btn btn-primary" disabled={saving || draft.trim() === ''}>
              {#if saving}<span class="spinner" aria-hidden="true"></span>{/if}
              Enregistrer
            </button>
          </div>
        </form>
      {:else if entry.transcript.trim()}
        <div class="prose">
          {#each splitParagraphs(entry.transcript) as p, i (i)}
            <p>{p}</p>
          {/each}
        </div>
        {#if entry.transcriptEdited}<p class="muted small">Corrigée à la main.</p>{/if}
      {:else if entry.local.needsAnalysis}
        <p class="muted placeholder">La transcription arrivera avec l'analyse.</p>
      {:else}
        <p class="muted placeholder">Rien n'a été entendu dans cet enregistrement.</p>
      {/if}
    </section>

    {#if entry.analysis}
      {@const a = entry.analysis}
      {#if a.themes.length > 0}
        <section class="block">
          <h2 class="section-title">Thèmes</h2>
          <TagList items={a.themes} label="Thèmes" />
        </section>
      {/if}
      {#if a.people.length > 0 || a.places.length > 0}
        <section class="block two">
          {#if a.people.length > 0}
            <div>
              <h2 class="section-title with-icon"><Icon name="people" size={16} /> Personnes</h2>
              <TagList items={a.people} label="Personnes citées" />
            </div>
          {/if}
          {#if a.places.length > 0}
            <div>
              <h2 class="section-title with-icon"><Icon name="pin" size={16} /> Lieux</h2>
              <TagList items={a.places} label="Lieux cités" />
            </div>
          {/if}
        </section>
      {/if}
      {#if a.todos.length > 0}
        <section class="block">
          <h2 class="section-title">À faire</h2>
          <ul class="todos">
            {#each a.todos as t, i (i)}<li>{t}</li>{/each}
          </ul>
        </section>
      {/if}
      <EntryMentions {entry} />
      {#if entry.analyzedAt}
        <p class="muted small">
          Analysée {formatRelative(entry.analyzedAt, app.now)}{entry.analysisModel ? ` avec ${entry.analysisModel}` : ''}.
        </p>
      {/if}
    {/if}

    <div class="danger-zone">
      <button type="button" class="btn btn-danger" onclick={() => (confirmDelete = true)}>
        <Icon name="trash" size={18} /> Supprimer l'entrée
      </button>
    </div>

    <ConfirmDialog
      bind:open={confirmDelete}
      title="Supprimer cette entrée ?"
      message={deleteMessage}
      confirmLabel="Supprimer"
      danger
      onconfirm={remove}
    />
  {/if}
</section>

<style>
  .entry {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .screen-header {
    align-items: flex-start;
    margin-bottom: 0;
  }

  .titles {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 4px;
    min-width: 0;
  }

  .titles .kicker {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
  }

  h1.waiting {
    color: var(--ink-muted);
    font-style: italic;
  }

  .meta {
    gap: 6px;
  }

  .mood-chip {
    color: var(--ink);
  }

  .emoji {
    font-size: 1.1rem;
    line-height: 1;
  }

  .error-box {
    align-items: center;
    flex-wrap: wrap;
  }

  .grow {
    flex: 1 1 160px;
  }

  .summary {
    margin: 0;
    padding: 4px 0 4px 16px;
    border-left: 3px solid var(--accent);
    font-family: var(--font-serif);
    font-size: 1.125rem;
    font-style: italic;
    line-height: 1.55;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .block-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .block-head .section-title {
    margin: 0;
  }

  .section-title.with-icon {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .two {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 16px 24px;
  }

  .edit {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .actions {
    justify-content: flex-end;
  }

  .placeholder {
    font-style: italic;
  }

  .small {
    font-size: 0.8125rem;
  }

  .todos {
    margin: 0;
    padding-left: 1.4em;
    list-style: '☐  ';
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .danger-zone {
    margin-top: 12px;
    padding-top: 18px;
    border-top: 1px solid var(--line);
  }
</style>
