<script lang="ts">
  // Écran d'attente minimal (démarrage) ; peut aussi afficher une erreur fatale.
  let {
    message = '',
    detail = '',
    onretry,
  }: { message?: string; detail?: string; onretry?: () => void } = $props();
</script>

<div class="splash" role="status" aria-live="polite">
  <div class="mark" aria-hidden="true">
    <span class="dot"></span>
  </div>
  <p class="name">Dit Harry</p>
  {#if message}
    <p class="message">{message}</p>
    {#if detail}<p class="detail">{detail}</p>{/if}
    {#if onretry}
      <button type="button" class="btn btn-primary" onclick={onretry}>Réessayer</button>
    {/if}
  {:else}
    <p class="sr-only">Chargement…</p>
  {/if}
</div>

<style>
  .splash {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: calc(24px + var(--safe-top)) 24px calc(24px + var(--safe-bottom));
    text-align: center;
  }

  .mark {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: var(--accent-soft);
    display: grid;
    place-items: center;
  }

  .dot {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent);
    animation: breathe 2.4s ease-in-out infinite;
  }

  .name {
    font-family: var(--font-serif);
    font-size: 1.75rem;
    font-weight: 600;
  }

  .message {
    font-weight: 600;
  }

  .detail {
    color: var(--ink-muted);
    max-width: 32ch;
  }

  @keyframes breathe {
    50% {
      transform: scale(1.18);
      opacity: 0.85;
    }
  }
</style>
