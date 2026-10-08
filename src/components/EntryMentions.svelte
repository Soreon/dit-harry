<script lang="ts">
  import { tick } from 'svelte';
  import { useApp } from '../lib/app.svelte';
  import { kindOf, readMentions } from '../lib/mentions';
  import type { DayMention, LocalEntry } from '../lib/types';
  import { windowOf } from '../lib/when';
  import { formatDayLong, formatDayShort, hrefDay } from './helpers';

  // Section « Rattaché à d'autres jours » de l'entrée : ce qu'elle a ajouté à d'autres jours
  // (fait passé, chose prévue), les jours à choisir, et les gestes (choisir, changer de jour,
  // modifier, retirer, rétablir). Toucher un rattachement ouvre le jour visé.
  let { entry }: { entry: LocalEntry } = $props();
  const app = useApp();
  const uid = $props.id();

  const mentions = $derived(readMentions(entry.analysis));
  const range = $derived(windowOf(entry.day));

  /** Formulaire ouvert (un seul à la fois) : changer de jour, ou corriger le texte. */
  let editing = $state<{ id: string; mode: 'day' | 'text' } | null>(null);
  let dayDraft = $state('');
  let textDraft = $state('');
  let error = $state('');
  let busy = $state(false);

  function label(m: DayMention): string {
    const day = formatDayLong(m.day, app.today);
    return kindOf(m.day, entry.day) === 'past' ? `Ajouté au ${day}` : `Prévu le ${day}`;
  }

  async function open(m: DayMention, mode: 'day' | 'text'): Promise<void> {
    editing = { id: m.id, mode };
    error = '';
    dayDraft = m.day || m.choices?.[0] || '';
    textDraft = m.text;
    await tick();
    document.getElementById(`${uid}-${m.id}-${mode}`)?.focus();
  }

  async function close(m: DayMention): Promise<void> {
    editing = null;
    error = '';
    // Le focus revient sur le premier bouton de la carte (le formulaire a disparu).
    await focusCard(m, '.actions button');
  }

  async function run(action: () => Promise<boolean>): Promise<boolean> {
    if (busy) return false;
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
    }
  }

  /** Après un geste, la carte change (boutons remplacés) : le focus va sur `selector` dans la carte. */
  async function focusCard(m: DayMention, selector: string): Promise<void> {
    await tick();
    document.getElementById(`${uid}-${m.id}`)?.querySelector<HTMLElement>(selector)?.focus();
  }

  /** Geste d'un appui (choisir, retirer, rétablir), puis focus dans la carte mise à jour. */
  async function act(m: DayMention, action: () => Promise<boolean>, selector = '.actions button'): Promise<void> {
    if (await run(action)) await focusCard(m, selector);
  }

  async function submitDay(event: SubmitEvent, m: DayMention): Promise<void> {
    event.preventDefault();
    const day = dayDraft;
    if (!day) {
      error = 'Choisis un jour.';
      return;
    }
    if (day === entry.day && !(m.choices ?? []).includes(day)) {
      error = "C'est le jour même de cette entrée : choisis-en un autre.";
      return;
    }
    if (day < range.min || day > range.max) {
      error = `Choisis un jour entre le ${formatDayLong(range.min, app.today)} et le ${formatDayLong(range.max, app.today)}.`;
      return;
    }
    if (await run(() => app.setMentionDay(entry.id, m.id, day))) await close(m);
  }

  async function submitText(event: SubmitEvent, m: DayMention): Promise<void> {
    event.preventDefault();
    if (!textDraft.trim()) {
      error = 'Le texte ne peut pas être vide.';
      return;
    }
    if (await run(() => app.editMentionText(entry.id, m.id, textDraft))) await close(m);
  }
</script>

{#if mentions.length > 0}
  <section class="block" aria-labelledby="{uid}-t">
    <h2 id="{uid}-t" class="section-title">Rattaché à d'autres jours</h2>
    {#if !app.dayLinksOn}
      <p class="field-help">
        « Rattacher aux autres jours » est désactivé dans les réglages : ces notes n'apparaissent pas
        sur les autres jours.
      </p>
    {/if}
    <ul class="list">
      {#each mentions as m (m.id)}
        {@const isEditing = editing?.id === m.id}
        <li
          id="{uid}-{m.id}"
          class="mention card"
          class:dismissed={m.status === 'dismissed'}
          class:proposed={m.status === 'proposed'}
          class:future={m.status !== 'proposed' && m.day !== '' && kindOf(m.day, entry.day) === 'future'}
        >
          {#if m.status === 'proposed'}
            <p class="head">
              <strong>À quel jour rattacher ceci ?</strong>{#if m.when}<span class="when">« {m.when} »</span>{/if}
            </p>
            <p class="text">{m.text}</p>
            {#if !isEditing}
              <div class="row actions" role="group" aria-label="Jours possibles">
                {#each m.choices ?? [] as d (d)}
                  <button
                    type="button"
                    class="btn btn-small {d === m.modelDay ? 'btn-primary' : 'btn-secondary'}"
                    disabled={busy}
                    onclick={() => act(m, () => app.setMentionDay(entry.id, m.id, d), '.day-link')}
                  >
                    {formatDayShort(d)}{#if d === m.modelDay}<span class="sr-only">, suggéré</span>{/if}
                  </button>
                {/each}
                <button type="button" class="btn btn-small btn-ghost" disabled={busy} onclick={() => open(m, 'day')}>
                  Autre…
                </button>
                <button
                  type="button"
                  class="btn btn-small btn-ghost"
                  disabled={busy}
                  onclick={() => act(m, () => app.dismissMention(entry.id, m.id))}
                >
                  Ne pas ajouter
                </button>
              </div>
            {/if}
          {:else if m.status === 'dismissed'}
            <!-- Au passé : « Retiré du lundi 5 octobre », jamais « Retiré · Ajouté au … ». -->
            <p class="head">
              {#if m.day}
                <span><span class="chip">Retiré</span> du {formatDayLong(m.day, app.today)}</span>
              {:else}
                <span class="chip">Non rattaché</span>
              {/if}{#if m.when}<span class="when">« {m.when} »</span>{/if}
            </p>
            <p class="text">{m.text}</p>
            <div class="row actions">
              <button
                type="button"
                class="btn btn-small btn-ghost"
                disabled={busy}
                onclick={() => act(m, () => app.restoreMention(entry.id, m.id))}
              >
                Rétablir
              </button>
            </div>
          {:else}
            <p class="head">
              <a
                class="day-link"
                class:stretched-link={!isEditing}
                href={hrefDay(m.day, { entry: entry.id, mention: m.id })}
              >
                {#if kindOf(m.day, entry.day) === 'future'}<span aria-hidden="true">📌</span>{' '}{/if}{label(m)}
              </a>{#if m.when}<span class="when">« {m.when} »</span>{/if}
            </p>
            <p class="text">{m.text}</p>
            {#if !isEditing}
              <div class="row actions">
                <button type="button" class="btn btn-small btn-ghost" disabled={busy} onclick={() => open(m, 'day')}>
                  Changer de jour
                </button>
                <button type="button" class="btn btn-small btn-ghost" disabled={busy} onclick={() => open(m, 'text')}>
                  Modifier
                </button>
                <button
                  type="button"
                  class="btn btn-small btn-ghost"
                  disabled={busy}
                  onclick={() => act(m, () => app.dismissMention(entry.id, m.id))}
                >
                  Retirer
                </button>
              </div>
            {/if}
          {/if}

          {#if isEditing && editing?.mode === 'day'}
            <form class="edit" onsubmit={(e) => submitDay(e, m)}>
              <label class="field-label" for="{uid}-{m.id}-day">Rattacher au jour</label>
              <input
                id="{uid}-{m.id}-day"
                class="input"
                type="date"
                min={range.min}
                max={range.max}
                bind:value={dayDraft}
                aria-describedby="{uid}-{m.id}-help"
              />
              <span class="field-help" id="{uid}-{m.id}-help">
                Du {formatDayLong(range.min, app.today)} au {formatDayLong(range.max, app.today)}.
              </span>
              {#if error}<p class="error" role="alert">{error}</p>{/if}
              <div class="row form-actions">
                <button type="button" class="btn btn-small btn-secondary" onclick={() => close(m)}>Annuler</button>
                <button type="submit" class="btn btn-small btn-primary" disabled={busy}>Rattacher</button>
              </div>
            </form>
          {:else if isEditing && editing?.mode === 'text'}
            <form class="edit" onsubmit={(e) => submitText(e, m)}>
              <label class="field-label" for="{uid}-{m.id}-text">Texte de la note</label>
              <textarea id="{uid}-{m.id}-text" class="textarea" rows="3" maxlength="300" bind:value={textDraft}></textarea>
              {#if error}<p class="error" role="alert">{error}</p>{/if}
              <div class="row form-actions">
                <button type="button" class="btn btn-small btn-secondary" onclick={() => close(m)}>Annuler</button>
                <button type="submit" class="btn btn-small btn-primary" disabled={busy || textDraft.trim() === ''}>
                  Enregistrer
                </button>
              </div>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .block .section-title {
    margin: 0;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .mention {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    border-left: 3px solid var(--line-strong);
  }

  .mention.future {
    border-left-color: var(--accent);
  }

  .mention.proposed {
    border-left-color: var(--warning);
    background: color-mix(in srgb, var(--warning-soft) 45%, var(--surface));
  }

  /* Retiré : bord en pointillés, texte barré en --ink-muted (contraste AA sur la carte, sans
     opacité qui ferait tomber le contraste) ; « Rétablir » garde sa pleine force. */
  .mention.dismissed {
    border-left-style: dashed;
  }

  .mention.dismissed .text {
    text-decoration: line-through;
    color: var(--ink-muted);
  }

  .mention:has(.stretched-link:focus-visible) {
    outline: 3px solid var(--focus-ring);
    outline-offset: 2px;
  }

  .stretched-link:focus-visible {
    outline: none;
  }

  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 6px;
    font-size: 0.9375rem;
  }

  .day-link {
    font-weight: 600;
    color: var(--accent-strong);
    text-decoration: none;
  }

  .when {
    color: var(--ink-muted);
    font-style: italic;
  }

  .text {
    font-family: var(--font-serif);
    font-size: 1.0625rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  /* Boutons et formulaires au-dessus du lien qui couvre la carte */
  .actions,
  .edit {
    position: relative;
    z-index: 1;
  }

  .actions {
    gap: 4px 6px;
    margin: 2px -8px 0;
  }

  .edit {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 6px;
  }

  .form-actions {
    justify-content: flex-end;
  }

  .error {
    color: var(--danger);
    font-size: 0.875rem;
  }
</style>
