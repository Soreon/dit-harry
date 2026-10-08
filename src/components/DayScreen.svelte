<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import type { DayKey } from '../lib/types';
  import { addDays } from '../lib/util';
  import EntryCard from './EntryCard.svelte';
  import { formatDayHeading, hrefDay, plural } from './helpers';
  import Icon from './Icon.svelte';
  import SynthesisCard from './SynthesisCard.svelte';

  // Page d'un jour : synthèse + entrées dans l'ordre chronologique.
  let { day }: { day: DayKey } = $props();
  const app = useApp();

  const group = $derived(app.getDay(day));
  // app.days est trié du plus récent au plus ancien
  const prev = $derived(app.days.find((g) => g.day < day && g.entries.length > 0)?.day);
  const next = $derived(app.days.findLast((g) => g.day > day && g.entries.length > 0)?.day);
  const isToday = $derived(day === app.today);
</script>

<section class="screen" aria-labelledby="day-title">
  <header class="screen-header">
    <button type="button" class="icon-btn" aria-label="Retour au journal" onclick={() => app.goUp('#/journal')}>
      <Icon name="back" />
    </button>
    <div class="titles">
      {#if isToday}<p class="kicker">Aujourd'hui</p>{:else if day === addDays(app.today, -1)}<p class="kicker">Hier</p>{/if}
      <h1 id="day-title">{formatDayHeading(day, app.today)}</h1>
    </div>
  </header>

  {#if group.entries.length === 0 && !group.synthesis}
    <div class="empty">
      <p class="muted">Aucune entrée ce jour-là.</p>
      {#if isToday}<a class="btn btn-primary" href="#/">Enregistrer une entrée</a>{/if}
    </div>
  {:else}
    <SynthesisCard {group} />

    {#if group.entries.length > 0}
      <h2 class="section-title list-title">{plural(group.entries.length, 'entrée', 'entrées')}</h2>
      <ol class="list">
        {#each group.entries as entry (entry.id)}
          <li><EntryCard {entry} lines={2} /></li>
        {/each}
      </ol>
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

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .pager {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 24px;
  }
</style>
