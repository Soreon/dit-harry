<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import Icon from './Icon.svelte';

  // Feuille de saisie au clavier (dialogue natif). Le brouillon est gardé dans le
  // contrôleur : fermer la feuille ne perd pas le texte.
  let { open = $bindable(false) }: { open?: boolean } = $props();
  const app = useApp();
  const titleId = $props.id();

  let dialog = $state<HTMLDialogElement>();
  let textarea = $state<HTMLTextAreaElement>();
  let saving = $state(false);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      textarea?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    saving = true;
    try {
      if (await app.addTextEntry(app.textDraft)) open = false;
    } finally {
      saving = false;
    }
  }
</script>

<dialog class="sheet" bind:this={dialog} aria-labelledby={titleId} onclose={() => (open = false)}>
  <form onsubmit={save}>
    <header>
      <h2 id={titleId}>Écrire une entrée</h2>
      <button type="button" class="icon-btn" aria-label="Fermer" onclick={() => (open = false)}>
        <Icon name="close" />
      </button>
    </header>
    <label class="sr-only" for="{titleId}-text">Ton texte</label>
    <textarea
      id="{titleId}-text"
      class="textarea"
      rows="8"
      placeholder="Qu'est-ce qui t'a marqué aujourd'hui ?"
      bind:this={textarea}
      bind:value={app.textDraft}
    ></textarea>
    <div class="actions">
      <span class="muted count">{app.textDraft.trim() ? `${app.textDraft.trim().split(/\s+/).length} mots` : ''}</span>
      <button type="submit" class="btn btn-primary" disabled={saving || app.textDraft.trim() === ''}>
        {#if saving}<span class="spinner" aria-hidden="true"></span>{/if}
        Enregistrer
      </button>
    </div>
  </form>
</dialog>

<style>
  .sheet {
    width: min(100%, var(--content-max));
    max-width: 100%;
    margin: auto auto 0;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    border-bottom: 0;
    padding-bottom: var(--safe-bottom);
  }

  @media (min-width: 600px) {
    .sheet {
      margin: auto;
      border-radius: var(--radius-lg);
      border-bottom: 1px solid var(--line);
    }
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 16px 16px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .textarea {
    min-height: 40dvh;
    background: var(--bg);
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .count {
    font-size: 0.875rem;
  }
</style>
