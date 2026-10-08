<script lang="ts">
  import { fade } from 'svelte/transition';
  import { prefersReducedMotion } from 'svelte/motion';
  import { useApp } from '../lib/app.svelte';
  import { shouldShowInstallCard } from '../lib/install';
  import { dismissInstallCard, install } from '../lib/install.svelte';
  import Icon from './Icon.svelte';

  // Carte discrète de l'écran Aujourd'hui : proposer l'installation quand Chrome le permet.
  // Placée SOUS le contenu (juste au-dessus du bouton d'enregistrement) : son arrivée, souvent
  // une seconde après l'affichage, ne déplace rien de ce qui est déjà à l'écran, donc aucun appui
  // destiné à une entrée ne tombe dessus. Fermée ou refusée → revient au bout de 30 jours.
  // Jamais pendant un enregistrement.
  let {
    onhide,
  }: {
    /** La carte va disparaître sous le doigt (Installer, ×) : le parent replace le focus. */
    onhide: () => void;
  } = $props();
  const app = useApp();

  const visible = $derived(
    shouldShowInstallCard({
      canPrompt: install.canPrompt,
      standalone: install.standalone,
      installed: install.installed,
      recording: app.recording.status !== 'idle',
      dismissedAt: install.dismissedAt,
      now: app.now.getTime(),
    }),
  );

  function installNow(): void {
    // prompt() d'abord, dans le clic (Chrome exige un appui récent), puis le focus
    app.installApp();
    onhide();
  }

  function hide(): void {
    dismissInstallCard();
    onhide();
  }
</script>

{#if visible}
  <!-- Fondu seulement : une hauteur animée décalerait la mise en page sur plusieurs images -->
  <div class="install" transition:fade={{ duration: prefersReducedMotion.current ? 0 : 160 }}>
    <p class="text">Installe Dit Harry sur ton écran d'accueil</p>
    <button type="button" class="btn btn-primary go" onclick={installNow}>Installer</button>
    <button type="button" class="icon-btn close" aria-label="Masquer la proposition d'installation" onclick={hide}>
      <Icon name="close" size={18} />
    </button>
  </div>
{/if}

<style>
  .install {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 4px;
    margin-top: 16px;
    padding: 6px 2px 6px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .text {
    font-size: 0.9375rem;
    line-height: 1.35;
    padding-right: 6px;
  }

  .go {
    padding: 0 16px;
  }

  .close {
    color: var(--ink-muted);
  }
</style>
