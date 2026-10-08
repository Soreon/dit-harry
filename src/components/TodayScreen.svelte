<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import DayLinks from './DayLinks.svelte';
  import EntryCard from './EntryCard.svelte';
  import { formatDayHeading, hrefDay, plural } from './helpers';
  import InstallCard from './InstallCard.svelte';
  import RecorderDock from './RecorderDock.svelte';
  import TextEntrySheet from './TextEntrySheet.svelte';

  // Aujourd'hui : date, entrées du jour, bouton d'enregistrement, saisie texte.
  const app = useApp();

  let writing = $state(false);
  let title = $state<HTMLElement>();

  const entries = $derived(app.todayEntries);
  const greeting = $derived.by(() => {
    const h = app.now.getHours();
    if (h < 5) return 'Encore debout ?';
    if (h < 12) return 'Bonjour';
    if (h < 18) return 'Bon après-midi';
    return 'Bonsoir';
  });
</script>

<section class="screen today" aria-labelledby="today-title">
  <header class="head">
    <p class="kicker">{greeting}</p>
    <h1 id="today-title" tabindex="-1" bind:this={title}>{formatDayHeading(app.today, app.today)}</h1>
  </header>

  {#if app.ready && app.todayPlanned.length > 0}
    <!-- Ce qui avait été annoncé pour aujourd'hui dans des entrées précédentes -->
    <div class="planned">
      <DayLinks links={app.todayPlanned} kind="future" title="Prévu aujourd'hui" flush />
    </div>
  {/if}

  {#if !app.ready}
    <p class="muted loading"><span class="spinner" aria-hidden="true"></span> Chargement de ton journal…</p>
  {:else if entries.length === 0}
    <div class="empty">
      <p class="invite">Raconte-moi ta journée…</p>
      <p class="muted">
        Appuie sur le bouton et parle librement, quelques secondes ou un quart d'heure. Tu peux aussi
        écrire.
      </p>
    </div>
  {:else}
    <div class="list-head">
      <h2 class="section-title">{plural(entries.length, 'entrée', 'entrées')} aujourd'hui</h2>
      <a class="see-day" href={hrefDay(app.today)}>Voir la journée</a>
    </div>
    <ol class="list">
      {#each entries as entry (entry.id)}
        <li><EntryCard {entry} lines={1} /></li>
      {/each}
    </ol>
  {/if}

  <!-- Sous le contenu : son arrivée tardive ne déplace ni la liste ni le bouton d'enregistrement.
       Elle disparaît sous le doigt : le focus revient au titre (sinon il retombe sur <body>). -->
  <InstallCard onhide={() => title?.focus({ preventScroll: true })} />

  <RecorderDock onwrite={() => (writing = true)} />
</section>

<TextEntrySheet bind:open={writing} />

<style>
  .today {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding-bottom: 0;
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 20px;
  }

  .head h1 {
    font-size: 2rem;
  }

  .planned {
    margin-bottom: 20px;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .empty {
    margin: auto 0;
    padding: 24px 8px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .invite {
    font-family: var(--font-serif);
    font-size: 1.6rem;
    font-style: italic;
    color: var(--ink);
  }

  .empty .muted {
    max-width: 34ch;
    margin: 0 auto;
  }

  .list-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .see-day {
    font-size: 0.875rem;
    font-weight: 600;
    padding: 10px 0;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
</style>
