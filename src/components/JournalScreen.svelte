<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import {
    dayMoodScore,
    formatMonth,
    hasSynthesisContent,
    hrefDay,
    moodEmoji,
    moodWord,
    plural,
    relativeDayLabel,
    type DayGroup,
  } from './helpers';
  import MoodStrip from './MoodStrip.svelte';

  // Journal : courbe d'humeur + liste des jours (récent → ancien), groupés par mois.
  const app = useApp();

  const PAGE = 60;
  let shown = $state(PAGE);

  const groups = $derived(app.days.filter((g) => g.entries.length > 0 || g.synthesis));
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
    return titles.join(' · ');
  }

  function statusLine(g: DayGroup): string {
    const n = plural(g.entries.length, 'entrée', 'entrées');
    if (g.synthesis) return n;
    // Seulement des enregistrements inaudibles : pas de synthèse à attendre
    if (!hasSynthesisContent(g.entries)) return n;
    if (g.day === app.today) return `${n} — synthèse demain`;
    if (g.entries.some((e) => e.local.needsAnalysis)) return `${n} — analyse en attente`;
    return `${n} — synthèse à la prochaine synchro`;
  }
</script>

<section class="screen journal" aria-labelledby="journal-title">
  <header class="screen-header">
    <h1 id="journal-title">Journal</h1>
  </header>

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
