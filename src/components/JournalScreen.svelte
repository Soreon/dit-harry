<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import {
    dayMoodScore,
    formatMonth,
    hasSynthesisContent,
    hrefDay,
    linksOfKind,
    moodEmoji,
    moodWord,
    plural,
    relativeDayLabel,
    type DayGroup,
  } from './helpers';
  import MoodStrip from './MoodStrip.svelte';

  // Journal : choses prévues à venir, courbe d'humeur, liste des jours (récent → ancien), groupés
  // par mois. Un jour qui n'a que des notes d'autres jours (« Ajouté plus tard », « Prévu »)
  // apparaît aussi.
  const app = useApp();

  const PAGE = 60;
  let shown = $state(PAGE);

  const groups = $derived(
    app.days.filter(
      (g) => g.day <= app.today && (g.entries.length > 0 || !!g.synthesis || (g.links?.length ?? 0) > 0),
    ),
  );
  const months = $derived.by(() => {
    const out: { key: string; label: string; days: DayGroup[] }[] = [];
    for (const g of groups.slice(0, shown)) {
      const key = g.day.slice(0, 7);
      const last = out[out.length - 1];
      if (last && last.key === key) last.days.push(g);
      else out.push({ key, label: formatMonth(g.day), days: [g] });
    }
    return out;
  });

  function fallbackLine(g: DayGroup): string {
    const titles = g.entries.flatMap((e) => (e.analysis?.title ? [e.analysis.title] : []));
    if (titles.length > 0) return titles.join(' · ');
    // Jour sans entrée : ce qui y a été rattaché depuis d'autres jours.
    return (g.links ?? []).map((l) => l.mention.text).join(' · ');
  }

  /** « 1 ajout · 1 chose prévue » : notes d'autres jours rattachées à ce jour (même mot que « À venir »). */
  function linksLine(g: DayGroup): string {
    const added = linksOfKind(g.links, 'past').length;
    const planned = linksOfKind(g.links, 'future').length;
    return [
      added > 0 ? plural(added, 'ajout', 'ajouts') : '',
      planned > 0 ? plural(planned, 'chose prévue', 'choses prévues') : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function statusLine(g: DayGroup): string {
    const links = linksLine(g);
    if (g.entries.length === 0) {
      if (g.day === app.today) return links ? `${links} — pas encore d'entrée` : "pas encore d'entrée";
      return links ? `${links} — aucune entrée ce jour-là` : 'aucune entrée';
    }
    const n = [plural(g.entries.length, 'entrée', 'entrées'), links].filter(Boolean).join(' · ');
    if (g.synthesis) return n;
    // Seulement des enregistrements inaudibles : pas de synthèse à attendre
    if (!hasSynthesisContent(g.entries)) return n;
    if (g.day === app.today) return `${n} — synthèse demain`;
    if (g.entries.some((e) => e.local.needsAnalysis)) return `${n} — analyse en attente`;
    return `${n} — synthèse à la prochaine synchro`;
  }

  /** Choses prévues d'un jour à venir, en une ligne. */
  function plannedLine(g: DayGroup): string {
    return linksOfKind(g.links, 'future')
      .map((l) => l.mention.text)
      .join(' · ');
  }
</script>

<section class="screen journal" aria-labelledby="journal-title">
  <header class="screen-header">
    <h1 id="journal-title">Journal</h1>
  </header>

  {#if app.upcomingDays.length > 0}
    <section class="month upcoming" aria-labelledby="upcoming-title">
      <h2 id="upcoming-title" class="month-title"><span aria-hidden="true">📌</span>{' '}À venir</h2>
      <ol class="days">
        {#each app.upcomingDays as g (g.day)}
          {@const n = linksOfKind(g.links, 'future').length}
          <li>
            <a class="day card planned" href={hrefDay(g.day)}>
              <span class="day-head">
                <span class="date">{relativeDayLabel(g.day, app.today)}</span>
              </span>
              <span class="summary">{plannedLine(g)}</span>
              <span class="status">{plural(n, 'chose prévue', 'choses prévues')}</span>
            </a>
          </li>
        {/each}
      </ol>
    </section>
  {/if}

  <MoodStrip />

  {#if groups.length === 0}
    <div class="empty">
      <p class="invite">Ton journal est encore vierge.</p>
      <p class="muted">Ta première page t'attend sur l'écran <a href="#/">Aujourd'hui</a>.</p>
    </div>
  {:else}
    {#each months as m (m.key)}
      <section class="month" aria-labelledby="m-{m.key}">
        <h2 id="m-{m.key}" class="month-title">{m.label}</h2>
        <ol class="days">
          {#each m.days as g (g.day)}
            {@const score = dayMoodScore(g)}
            {@const line = g.synthesis?.summary ?? fallbackLine(g)}
            <li>
              <a class="day card" href={hrefDay(g.day)}>
                <span class="day-head">
                  <span class="date">{relativeDayLabel(g.day, app.today)}</span>
                  {#if score !== undefined}
                    <span class="emoji" role="img" aria-label="Humeur : {g.synthesis?.mood.label ?? moodWord(score)}">
                      {moodEmoji(score)}
                    </span>
                  {/if}
                </span>
                {#if line}<span class="summary">{line}</span>{/if}
                <span class="status">{statusLine(g)}</span>
              </a>
            </li>
          {/each}
        </ol>
      </section>
    {/each}

    {#if groups.length > shown}
      <button type="button" class="btn btn-secondary more" onclick={() => (shown += PAGE)}>
        Afficher les jours plus anciens
      </button>
    {/if}
  {/if}
</section>

<style>
  .journal {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .screen-header {
    margin-bottom: 0;
  }

  .empty {
    padding: 32px 8px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .invite {
    font-family: var(--font-serif);
    font-size: 1.4rem;
    font-style: italic;
  }

  .month-title {
    font-size: 1.1rem;
    color: var(--ink-muted);
    margin: 4px 0 10px;
  }

  .days {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .day {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: inherit;
    text-decoration: none;
    padding: 14px 16px;
  }

  .day:hover {
    border-color: var(--line-strong);
  }

  .day.planned {
    border-left: 3px solid var(--accent);
  }

  .day-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .date {
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: 1.1rem;
  }

  .emoji {
    font-size: 1.35rem;
    line-height: 1;
  }

  .summary {
    color: var(--ink);
    font-size: 0.9375rem;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }

  .status {
    font-size: 0.8125rem;
    color: var(--ink-muted);
  }

  .more {
    align-self: center;
  }
</style>
