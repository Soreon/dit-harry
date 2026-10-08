<script lang="ts">
  import { fly } from 'svelte/transition';
  import { prefersReducedMotion } from 'svelte/motion';
  import { useApp } from '../lib/app.svelte';
  import Icon from './Icon.svelte';

  // Notifications éphémères, en bas : au-dessus de la barre d'onglets (`tabbar`), du
  // bouton d'enregistrement sur l'écran Aujourd'hui (`dock`), ou du bord (`edge`).
  let { offset = 'tabbar' }: { offset?: 'edge' | 'tabbar' | 'dock' } = $props();
  const app = useApp();
</script>

<div class="toasts {offset}" role="status" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class="toast toast-{t.kind}" transition:fly={{ y: 16, duration: prefersReducedMotion.current ? 0 : 180 }}>
      {#if t.kind === 'success'}
        <Icon name="check" size={20} />
      {:else if t.kind === 'error'}
        <Icon name="alert" size={20} />
      {/if}
      <span class="msg">{t.message}</span>
      <button type="button" class="close" aria-label="Fermer la notification" onclick={() => app.dismissToast(t.id)}>
        <Icon name="close" size={18} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 12px);
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 0 var(--gutter);
    pointer-events: none;
  }

  .toasts.edge {
    bottom: calc(var(--safe-bottom) + 16px);
  }

  .toasts.dock {
    bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 210px);
  }

  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    max-width: 480px;
    min-height: 48px;
    padding: 6px 4px 6px 16px;
    border-radius: var(--radius);
    background: var(--ink);
    color: var(--bg);
    box-shadow: var(--shadow);
    font-size: 0.9375rem;
    line-height: 1.35;
  }

  .toast-error {
    background: var(--danger);
    color: var(--on-accent);
  }

  .msg {
    flex: 1;
    min-width: 0;
    padding: 6px 0;
  }

  .close {
    flex: none;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    opacity: 0.8;
  }

  .close:hover {
    opacity: 1;
  }
</style>
