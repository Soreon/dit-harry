<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import { linksSignature, settledLinks, splitSignature } from '../lib/mentions';
  import { entriesSignature } from '../lib/util';
  import type { DayGroup } from './helpers';
  import { formatRelative, hasSynthesisContent, moodEmoji, splitParagraphs } from './helpers';
  import Icon from './Icon.svelte';
  import TagList from './TagList.svelte';

  // Synthèse d'un jour (résumé, humeur, moments forts, à faire, thèmes)
  // + bouton « Générer maintenant » / « Régénérer ».
  let { group }: { group: DayGroup } = $props();
  const app = useApp();

  const s = $derived(group.synthesis);
  const requested = $derived(app.synthesisRequested.includes(group.day));
  // Entrées analysées ET avec du texte (les enregistrements inaudibles ne comptent pas)
  const analyzed = $derived(group.entries.filter((e) => e.analysis && e.transcript.trim() !== '').length);
  const content = $derived(hasSynthesisContent(group.entries));
  const waiting = $derived(group.entries.some((e) => e.local.needsAnalysis));

  /**
   * Notes d'autres jours (faits racontés plus tard, choses prévues) : intégrées à la synthèse
   * existante, ou à venir (même règle que la synchro : celles dites aujourd'hui, demain).
   */
  const linksNote = $derived.by(() => {
    const links = group.links ?? [];
    if (!s || links.length === 0 || group.day >= app.today) return '';
    const analyzedEntries = group.entries.filter((e) => e.analysis && e.transcript.trim() !== '');
    const base = entriesSignature(analyzedEntries);
    if (splitSignature(s.basedOn).base !== base) return '';
    const n = links.length;
    if (s.basedOn === linksSignature(base, links)) {
      return n === 1 ? "Tient compte d'une note d'un autre jour." : `Tient compte de ${n} notes d'autres jours.`;
    }
    return s.basedOn === linksSignature(base, settledLinks(links, app.today))
      ? "Mise à jour demain avec ce qui a été dit d'autres jours."
      : "Mise à jour à la prochaine synchronisation avec ce qui a été dit d'autres jours.";
  });

  /** Raison pour laquelle on ne peut pas générer maintenant (sinon ''). */
  const blocker = $derived.by(() => {
    if (!app.hasKey) return 'Ajoute ta clé Gemini dans les réglages pour obtenir une synthèse.';
    if (!app.online) return 'Reconnecte-toi à Internet pour générer la synthèse.';
    if (app.needsReconnect) return 'Reconnecte-toi à Google pour générer la synthèse.';
    if (analyzed === 0) return 'Attends que tes entrées soient analysées.';
    return '';
  });
</script>

<section class="synthesis card" aria-labelledby="synth-{group.day}" aria-busy={requested}>
  <header class="head">
    <h2 id="synth-{group.day}" class="section-title">
      <Icon name="sparkle" size={16} /> Synthèse du jour
    </h2>
    {#if s}
      <span class="mood">
        <span class="emoji" aria-hidden="true">{moodEmoji(s.mood.score)}</span>
        <span>{s.mood.label}</span>
      </span>
    {/if}
  </header>

  {#if s}
    <div class="prose summary">
      {#each splitParagraphs(s.summary) as p, i (i)}
        <p>{p}</p>
      {/each}
    </div>

    {#if s.highlights.length > 0}
      <h3 class="sub">Moments forts</h3>
      <ul class="bullets">
        {#each s.highlights as h, i (i)}<li>{h}</li>{/each}
      </ul>
    {/if}

    {#if s.todos.length > 0}
      <h3 class="sub">À faire</h3>
      <ul class="bullets todos">
        {#each s.todos as t, i (i)}<li>{t}</li>{/each}
      </ul>
    {/if}

    {#if s.themes.length > 0}
      <h3 class="sub">Thèmes</h3>
      <TagList items={s.themes} label="Thèmes du jour" />
    {/if}

    {#if waiting}
      <p class="notice notice-warning small">
        De nouvelles entrées attendent leur analyse : la synthèse sera mise à jour ensuite.
      </p>
    {/if}
    {#if linksNote}<p class="muted small">{linksNote}</p>{/if}
  {:else if requested}
    <p class="placeholder"><span class="spinner" aria-hidden="true"></span> J'écris la synthèse…</p>
  {:else if !content}
    <p class="placeholder">Pas de synthèse : rien n'a été entendu dans les entrées de ce jour.</p>
  {:else if group.day === app.today}
    <p class="placeholder">
      La synthèse de ta journée sera écrite demain, à ta première ouverture de l'appli.
    </p>
  {:else}
    <p class="placeholder">
      {waiting ? 'La synthèse sera écrite une fois tes entrées analysées.' : 'La synthèse sera écrite à la prochaine synchronisation.'}
    </p>
  {/if}

  <footer class="foot">
    {#if s}
      <span class="muted small">Écrite {formatRelative(s.generatedAt, app.now)}</span>
    {/if}
    {#if blocker && !s && content}
      <span class="muted small">{blocker}</span>
    {/if}
    {#if group.entries.length > 0 && content}
      <button
        type="button"
        class="btn btn-small {s ? 'btn-ghost' : 'btn-primary'}"
        disabled={requested || !!blocker}
        onclick={() => app.requestSynthesis(group.day)}
      >
        {#if requested}
          <span class="spinner" aria-hidden="true"></span> En cours…
        {:else}
          <Icon name={s ? 'retry' : 'sparkle'} size={16} />
          {s ? 'Régénérer' : 'Générer maintenant'}
        {/if}
      </button>
    {/if}
  </footer>
</section>

<style>
  .synthesis {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px;
    background:
      linear-gradient(var(--surface), var(--surface)) padding-box,
      linear-gradient(135deg, var(--accent-soft), var(--line)) border-box;
    border: 1px solid transparent;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .head .section-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }

  .mood {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.9375rem;
    color: var(--ink-muted);
  }

  .emoji {
    font-size: 1.5rem;
    line-height: 1;
  }

  .summary {
    font-family: var(--font-serif);
  }

  .sub {
    font-family: var(--font-sans);
    font-size: 0.875rem;
    font-weight: 700;
    color: var(--ink-muted);
    margin-top: 4px;
  }

  .bullets {
    margin: 0;
    padding-left: 1.2em;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .bullets li::marker {
    color: var(--accent);
  }

  .todos {
    list-style: '☐  ';
  }

  .placeholder {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--ink-muted);
    font-style: italic;
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 4px;
  }

  .foot .btn {
    margin-left: auto;
  }

  .small {
    font-size: 0.8125rem;
  }
</style>
