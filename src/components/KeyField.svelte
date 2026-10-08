<script lang="ts">
  import { useApp, type KeyCheckResult } from '../lib/app.svelte';
  import Icon from './Icon.svelte';

  // Champ « clé Gemini » masqué + bouton Vérifier (enregistre si la clé est acceptée).
  let { onresult }: { onresult?: (r: KeyCheckResult) => void } = $props();
  const app = useApp();
  const inputId = $props.id();

  let value = $derived(app.settings.geminiApiKey);
  let visible = $state(false);
  let checking = $state(false);
  let result = $state<KeyCheckResult | null>(null);

  async function verify(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (checking) return;
    checking = true;
    result = null;
    try {
      result = await app.checkGeminiKey(value);
      onresult?.(result);
    } finally {
      checking = false;
    }
  }
</script>

<form class="key-field" onsubmit={verify}>
  <label class="field-label" for={inputId}>Clé API Gemini</label>
  <div class="input-row">
    <input
      id={inputId}
      class="input"
      type={visible ? 'text' : 'password'}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      placeholder="Colle ta clé ici"
      bind:value
      oninput={() => (result = null)}
    />
    <button
      type="button"
      class="icon-btn"
      aria-label={visible ? 'Masquer la clé' : 'Afficher la clé'}
      aria-pressed={visible}
      onclick={() => (visible = !visible)}
    >
      <Icon name={visible ? 'eye-off' : 'eye'} size={22} />
    </button>
  </div>
  <button type="submit" class="btn btn-primary" disabled={checking || value.trim() === ''}>
    {#if checking}
      <span class="spinner" aria-hidden="true"></span> Vérification…
    {:else}
      Vérifier
    {/if}
  </button>
  <div aria-live="polite">
    {#if result}
      <p class="notice {result.ok ? 'notice-success' : 'notice-error'}">
        <Icon name={result.ok ? 'check' : 'alert'} size={20} />
        <span>{result.message}</span>
      </p>
    {/if}
  </div>
</form>

<style>
  .key-field {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .input-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .input-row .input {
    font-family: ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;
    font-size: 0.9375rem;
  }
</style>
