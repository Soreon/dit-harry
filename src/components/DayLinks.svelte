<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import type { DayLink, MentionVerdict } from '../lib/types';
  import { hrefDay, saidAt } from './helpers';
  import Icon from './Icon.svelte';

  // Notes d'autres jours qui visent ce jour : « 📌 Prévu » (annoncé plus tôt) ou « Ajouté plus
  // tard » (raconté après coup). Toucher une carte ouvre le jour où la note a été dite, avec
  // l'entrée mise en évidence. Un fait déjà raconté ce jour-là (verdict de la synthèse) ou par
  // une entrée précédente est replié sur une ligne, jamais supprimé.
  let {
    links,
    kind,
    title,
    verdicts,
    flush = false,
  }: {
    links: DayLink[];
    kind: 'past' | 'future';
    title: string;
    verdicts?: Record<string, MentionVerdict>;
    /** Sans espace au-dessus (en tête d'écran). */
    flush?: boolean;
  } = $props();
  const app = useApp();
  const uid = $props.id();

  /** Ligne repliée (« Tu y es revenu hier à 21:04 »), ou null si la note s'affiche en entier. */
  function folded(l: DayLink): string | null {
    const said = saidAt(l.sourceDay, l.sourceCreatedAt, app.today);
    if (verdicts?.[l.ref] === 'deja') return `Tu y es revenu ${said}`;
    if (l.repeatOf) return `${kind === 'past' ? 'Raconté' : 'Annoncé'} aussi ${said}`;
    return null;
  }
</script>

<section class="links" class:flush aria-labelledby="{uid}-t">
  <h2 id="{uid}-t" class="section-title">
    {#if kind === 'future'}<span aria-hidden="true">📌</span>{' '}{/if}{title}
  </h2>
  <ol class="list">
    {#each links as l, i (l.ref)}
      {@const line = folded(l)}
      {@const href = hrefDay(l.sourceDay, { entry: l.entryId })}
      <li data-link-ref={l.ref}>
        {#if line}
          <!-- Repliée : toute la carte se déplie (chevron visible) ; le fait s'affiche en entier une fois ouverte. -->
          <details class="link card folded">
            <summary>
              <span class="fold-head">
                <span><span aria-hidden="true">↩</span> {line}</span>{#if l.mention.when}<span class="when">· « {l.mention.when} »</span>{/if}
              </span>
              <span class="preview">{l.mention.text}</span>
              <span class="chevron" aria-hidden="true"><Icon name="chevron" size={18} /></span>
            </summary>
            <div class="fold-body">
              <p class="text">{l.mention.text}</p>
              <a class="see" {href}>Voir le jour où tu l'as dit</a>
            </div>
          </details>
        {:else}
          <article class="link card" class:future={kind === 'future'}>
            <p class="meta" id="{uid}-m{i}">
              {kind === 'past' ? 'Dit' : 'Annoncé'}
              {saidAt(l.sourceDay, l.sourceCreatedAt, app.today)}{#if l.mention.when}{' · '}<span class="when">« {l.mention.when} »</span>{/if}
            </p>
            <a class="text stretched-link" {href} aria-describedby="{uid}-m{i}">{l.mention.text}</a>
            {#if kind === 'past' && verdicts?.[l.ref] === 'complete'}
              <span class="chip complete">Complète ce jour-là</span>
            {/if}
          </article>
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .links {
    margin-top: 24px;
  }

  .links.flush {
    margin-top: 0;
  }

  .links .section-title {
    margin-bottom: 10px;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .link {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 16px;
    border-left: 3px solid var(--line-strong);
  }

  .link.future {
    border-left-color: var(--accent);
  }

  .link:hover {
    border-color: var(--line-strong);
  }

  .link:has(.stretched-link:focus-visible) {
    outline: 3px solid var(--focus-ring);
    outline-offset: 2px;
  }

  .stretched-link:focus-visible {
    outline: none;
  }

  .meta {
    font-size: 0.8125rem;
    color: var(--ink-muted);
  }

  .when {
    font-style: italic;
  }

  .text {
    color: var(--ink);
    text-decoration: none;
    font-family: var(--font-serif);
    font-size: 1.0625rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .complete {
    align-self: flex-start;
  }

  /* La ligne repliée occupe toute la carte : un appui n'importe où la déplie. */
  .folded {
    gap: 0;
    padding: 0;
  }

  .folded summary {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 48px;
    padding: 12px 44px 12px 16px;
    border-radius: inherit;
    list-style: none;
    font-size: 0.9375rem;
    color: var(--ink-muted);
    cursor: pointer;
  }

  .folded summary::-webkit-details-marker {
    display: none;
  }

  .folded summary::marker {
    content: '';
  }

  .fold-head {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 6px;
  }

  /* Aperçu du fait sur une ligne, masqué une fois la carte ouverte (le texte entier suit). */
  .preview {
    color: var(--ink);
    font-family: var(--font-serif);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .folded[open] .preview {
    display: none;
  }

  .chevron {
    position: absolute;
    top: 50%;
    right: 14px;
    display: inline-flex;
    color: var(--ink-muted);
    transform: translateY(-50%) rotate(90deg);
    transition: transform 0.15s ease;
  }

  .folded[open] .chevron {
    transform: translateY(-50%) rotate(-90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }

  .fold-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 16px 10px;
  }

  .see {
    align-self: flex-start;
    font-size: 0.875rem;
    font-weight: 600;
    padding: 8px 0;
  }
</style>
