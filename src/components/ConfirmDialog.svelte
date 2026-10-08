<script lang="ts">
  import type { Snippet } from 'svelte';

  // Dialogue de confirmation natif (<dialog> modal) : Échap ou « Annuler » ferment.
  let {
    open = $bindable(false),
    title,
    message = '',
    confirmLabel = 'Confirmer',
    cancelLabel = 'Annuler',
    danger = false,
    onconfirm,
    children,
  }: {
    open?: boolean;
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onconfirm: () => void;
    children?: Snippet;
  } = $props();

  let dialog = $state<HTMLDialogElement>();
  const titleId = $props.id();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });

  function confirm(): void {
    open = false;
    onconfirm();
  }
</script>

<dialog bind:this={dialog} aria-labelledby={titleId} onclose={() => (open = false)}>
  <div class="body">
    <h2 id={titleId}>{title}</h2>
    {#if message}<p class="message">{message}</p>{/if}
    {@render children?.()}
  </div>
  <div class="actions">
    <button type="button" class="btn btn-secondary" onclick={() => (open = false)}>{cancelLabel}</button>
    <button type="button" class="btn {danger ? 'btn-danger-solid' : 'btn-primary'}" onclick={confirm}>
      {confirmLabel}
    </button>
  </div>
</dialog>

<style>
  .body {
    padding: 22px 22px 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .message {
    color: var(--ink-muted);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    padding: 14px 22px 20px;
  }
</style>
