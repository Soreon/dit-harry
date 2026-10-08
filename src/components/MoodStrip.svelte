<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import { dayMoodScore, hrefDay, lastNDays, moodEmoji, moodWord, relativeDayLabel, type MoodScore } from './helpers';

  // Courbe d'humeur des 30 derniers jours : un point par jour (position = humeur),
  // reliés quand les jours se suivent. Toucher un jour ouvre sa page.
  const app = useApp();

  const DAYS = 30;
  const HEIGHT = 84;
  const PAD = 10;
  const MOOD_VAR: Record<MoodScore, string> = {
    [-2]: 'var(--mood-n2)',
    [-1]: 'var(--mood-n1)',
    0: 'var(--mood-0)',
    1: 'var(--mood-p1)',
    2: 'var(--mood-p2)',
  };

  function y(score: number): number {
    return PAD + ((2 - score) * (HEIGHT - 2 * PAD)) / 4;
  }

  const byDay = $derived(new Map(app.days.map((g) => [g.day, g])));
  const cells = $derived(
    lastNDays(app.today, DAYS).map((day) => {
      const group = byDay.get(day);
      const hasEntries = !!group && group.entries.length > 0;
      return { day, hasEntries, score: group ? dayMoodScore(group) : undefined };
    }),
  );

  /** Segments de jours consécutifs ayant une humeur (points SVG « x,y »). */
  const segments = $derived.by(() => {
    const out: string[] = [];
    let current: string[] = [];
    cells.forEach((c, i) => {
      if (c.score === undefined) {
        if (current.length > 1) out.push(current.join(' '));
        current = [];
      } else {
        current.push(`${i + 0.5},${y(c.score)}`);
      }
    });
    if (current.length > 1) out.push(current.join(' '));
    return out;
  });

  const known = $derived(cells.filter((c) => c.score !== undefined).length);

  function describe(day: string, score: MoodScore | undefined): string {
    const label = relativeDayLabel(day, app.today);
    return score === undefined ? `${label} : pas encore d'humeur` : `${label} : ${moodWord(score)} ${moodEmoji(score)}`;
  }
</script>

<figure class="strip card">
  <figcaption>
    <span class="section-title">Humeur des 30 derniers jours</span>
    {#if known === 0}<span class="muted empty-note">Elle se dessinera au fil de tes entrées.</span>{/if}
  </figcaption>

  <div class="chart">
    <div class="y-axis" aria-hidden="true">
      <span>{moodEmoji(2)}</span>
      <span>{moodEmoji(0)}</span>
      <span>{moodEmoji(-2)}</span>
    </div>

    <div class="plot" style:height="{HEIGHT}px">
      <svg viewBox="0 0 {DAYS} {HEIGHT}" preserveAspectRatio="none" aria-hidden="true">
        <line class="mid" x1="0" x2={DAYS} y1={y(0)} y2={y(0)} vector-effect="non-scaling-stroke" />
        {#each segments as points, i (i)}
          <polyline class="curve" {points} vector-effect="non-scaling-stroke" />
        {/each}
      </svg>

      <ol class="cols" aria-label="Humeur jour par jour">
        {#each cells as c (c.day)}
          {#if c.hasEntries}
            <li>
              <a href={hrefDay(c.day)} class:today={c.day === app.today} title={describe(c.day, c.score)} aria-label={describe(c.day, c.score)}>
                {#if c.score !== undefined}
                  <span class="dot" style:top="{y(c.score)}px" style:background={MOOD_VAR[c.score]}></span>
                {:else}
                  <span class="dot dot-unknown" style:top="{y(0)}px"></span>
                {/if}
              </a>
            </li>
          {:else}
            <li aria-hidden="true" class:today={c.day === app.today}></li>
          {/if}
        {/each}
      </ol>
    </div>
  </div>

  <div class="x-axis" aria-hidden="true">
    <span>il y a 30 jours</span>
    <span>aujourd'hui</span>
  </div>
</figure>

<style>
  .strip {
    margin: 0;
    padding: 14px 14px 10px;
  }

  figcaption {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 8px;
  }

  figcaption .section-title {
    margin: 0;
  }

  .empty-note {
    font-size: 0.875rem;
  }

  .chart {
    display: flex;
    gap: 6px;
  }

  .y-axis {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-size: 0.8rem;
    line-height: 1;
    padding: 4px 0;
  }

  .plot {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .mid {
    stroke: var(--line-strong);
    stroke-width: 1;
    stroke-dasharray: 3 4;
  }

  .curve {
    fill: none;
    stroke: var(--ink-faint);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
    opacity: 0.6;
  }

  .cols {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: repeat(30, 1fr);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .cols li {
    position: relative;
    min-width: 0;
  }

  .cols li.today,
  .cols a.today {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border-radius: 6px;
  }

  .cols a {
    position: absolute;
    inset: 0;
    display: block;
    border-radius: 6px;
  }

  .cols a:hover {
    background: var(--surface-sunk);
  }

  .cols a:focus-visible {
    outline-offset: 0;
  }

  .dot {
    position: absolute;
    left: 50%;
    width: 10px;
    height: 10px;
    margin: -5px 0 0 -5px;
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--surface);
  }

  .dot-unknown {
    background: transparent;
    border: 2px dashed var(--ink-faint);
    box-shadow: none;
  }

  .x-axis {
    display: flex;
    justify-content: space-between;
    margin: 6px 0 0 22px;
    font-size: 0.75rem;
    color: var(--ink-muted);
  }
</style>
