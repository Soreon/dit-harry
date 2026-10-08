<script lang="ts">
  import { tick } from 'svelte';
  import { useApp } from '../lib/app.svelte';
  import type { DayKey } from '../lib/types';
  import { addDays } from '../lib/util';
  import DayLinks from './DayLinks.svelte';
  import EntryCard from './EntryCard.svelte';
  import { formatDayHeading, hrefDay, linksOfKind, plural, type DayGroup } from './helpers';
  import Icon from './Icon.svelte';
  import SynthesisCard from './SynthesisCard.svelte';

  // Page d'un jour : synthèse, choses prévues pour ce jour, entrées dans l'ordre chronologique,
  // faits racontés plus tard. `focusEntry` / `focusMention` (`#/jour/…?e=…&m=…`) : l'entrée, ou
  // la note d'une entrée, à mettre en évidence en arrivant (défilement, focus, surbrillance).
  let { day, focusEntry, focusMention }: { day: DayKey; focusEntry?: string; focusMention?: string } = $props();
  const app = useApp();

  const group = $derived(app.getDay(day));
  const planned = $derived(linksOfKind(group.links, 'future'));
  const added = $derived(linksOfKind(group.links, 'past'));
  const hasContent = (g: DayGroup): boolean => g.entries.length > 0 || (g.links?.length ?? 0) > 0;
  // app.days est trié du plus récent au plus ancien
  const prev = $derived(app.days.find((g) => g.day < day && hasContent(g))?.day);
  const next = $derived(app.days.findLast((g) => g.day > day && hasContent(g))?.day);
  const isToday = $derived(day === app.today);
  const isFuture = $derived(day > app.today);
  const kicker = $derived(
    isToday
      ? "Aujourd'hui"
      : day === addDays(app.today, -1)
        ? 'Hier'
        : day === addDays(app.today, 1)
          ? 'Demain'
          : isFuture
            ? 'À venir'
            : '',
  );

  /** Dernière mise en évidence faite (une seule fois par lien suivi). */
  let highlighted = '';
  const HIGHLIGHT_MS = 2600;

  function findTarget(): HTMLElement | null {
    if (!focusEntry) return null;
    if (focusMention) {
      const ref = `${focusEntry}/${focusMention}`;
      for (const el of document.querySelectorAll<HTMLElement>('[data-link-ref]')) {
        if (el.dataset['linkRef'] === ref) return el;
      }
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-entry-id]')) {
      if (el.dataset['entryId'] === focusEntry) return el;
    }
    return null;
  }

  function highlight(el: HTMLElement): void {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // Le titre de l'écran ne reprend pas le focus pendant la mise en évidence (Shell).
    el.dataset['routeFocus'] = '';
    el.classList.add('flash-target');
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    (el.querySelector<HTMLElement>('a[href], summary') ?? el).focus({ preventScroll: true });
    setTimeout(() => {
      el.classList.remove('flash-target');
      delete el.dataset['routeFocus'];
    }, HIGHLIGHT_MS);
  }

  $effect(() => {
    const key = focusEntry ? `${focusEntry}/${focusMention ?? ''}` : '';
    // Relu quand les données arrivent (démarrage à froid sur un lien profond).
    void group;
    if (!key || key === highlighted) return;
    void tick().then(() => {
      // Après le placement du focus sur le titre par Shell (même tour) : on passe juste après.
      requestAnimationFrame(() => {
        if (key === highlighted) return;
        const el = findTarget();
        if (!el) return;
        highlighted = key;
        highlight(el);
      });
    });
  });
</script>

<section class="screen" aria-labelledby="day-title">
  <header class="screen-header">
    <button type="button" class="icon-btn" aria-label="Retour au journal" onclick={() => app.goUp('#/journal')}>
      <Icon name="back" />
    </button>
    <div class="titles">
      {#if kicker}<p class="kicker">{kicker}</p>{/if}
      <h1 id="day-title">{formatDayHeading(day, app.today)}</h1>
    </div>
  </header>

  {#if !hasContent(group) && !group.synthesis}
    <div class="empty">
      <p class="muted">
        {isFuture
          ? 'Rien de prévu ce jour-là pour le moment.'
          : isToday
            ? "Pas encore d'entrée aujourd'hui."
            : 'Aucune entrée ce jour-là.'}
      </p>
      {#if isToday}<a class="btn btn-primary" href="#/">Enregistrer une entrée</a>{/if}
    </div>
  {:else}
    {#if group.entries.length > 0 || group.synthesis}
      <SynthesisCard {group} />
    {/if}

    {#if planned.length > 0}
      <DayLinks links={planned} kind="future" title={isToday || isFuture ? 'Prévu' : 'Prévu ce jour-là'} />
    {/if}

    {#if group.entries.length > 0}
      <h2 class="section-title list-title">{plural(group.entries.length, 'entrée', 'entrées')}</h2>
      <ol class="list">
        {#each group.entries as entry (entry.id)}
          <li data-entry-id={entry.id}><EntryCard {entry} lines={2} /></li>
        {/each}
      </ol>
    {:else if isToday}
      <!-- Aujourd'hui avec seulement des choses prévues : l'invitation à enregistrer reste là. -->
      <div class="empty no-entry">
        <p class="muted">Pas encore d'entrée aujourd'hui.</p>
        <a class="btn btn-primary" href="#/">Enregistrer une entrée</a>
      </div>
    {:else if !isFuture}
      <p class="muted no-entry">Aucune entrée ce jour-là.</p>
    {/if}

    {#if added.length > 0}
      <DayLinks
        links={added}
        kind="past"
        title="Ajouté plus tard"
        verdicts={group.synthesis?.mentionVerdicts}
      />
    {/if}
  {/if}

  <nav class="pager" aria-label="Jours voisins">
    {#if prev}
      <a class="btn btn-ghost" href={hrefDay(prev)}><Icon name="back" size={18} /> Jour précédent</a>
    {:else}
      <span></span>
    {/if}
    {#if next}
      <a class="btn btn-ghost" href={hrefDay(next)}>Jour suivant <Icon name="chevron" size={18} /></a>
    {/if}
  </nav>
</section>

<style>
  .screen-header {
    align-items: flex-start;
  }

  .titles {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 4px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 16px 0;
  }

  .list-title {
    margin: 24px 0 10px;
  }

  .no-entry {
    margin-top: 24px;
  }

  .empty.no-entry {
    padding: 0;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .list li {
    border-radius: var(--radius);
  }

  .pager {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 24px;
  }
</style>
