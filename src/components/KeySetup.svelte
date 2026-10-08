<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import Icon from './Icon.svelte';
  import KeyField from './KeyField.svelte';

  // Accueil « clé Gemini manquante » : coller la clé, vérifier, ou remettre à plus tard.
  const app = useApp();
</script>

<div class="setup">
  <div class="head">
    <div class="mark" aria-hidden="true"><Icon name="key" size={32} /></div>
    <p class="kicker">Dernière étape</p>
    <h1>Ta clé Gemini</h1>
    <p class="muted">
      Harry utilise Gemini, l'IA de Google, pour transcrire et analyser tes entrées. Il lui faut une
      clé personnelle, gratuite.
    </p>
  </div>

  <ol class="steps">
    <li>
      Ouvre
      <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
        Google AI Studio <Icon name="external" size={16} />
      </a>
      avec ton compte Google.
    </li>
    <li>Appuie sur « Create API key » puis copie la clé.</li>
    <li>Colle-la ci-dessous et vérifie.</li>
  </ol>

  <KeyField onresult={(r) => r.ok && app.toast(r.message, 'success')} />

  <button type="button" class="btn btn-ghost later" onclick={() => app.dismissKeySetup()}>Plus tard</button>
</div>

<style>
  .setup {
    min-height: 100dvh;
    max-width: 480px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 24px;
    padding: calc(32px + var(--safe-top)) calc(24px + var(--safe-right)) calc(32px + var(--safe-bottom))
      calc(24px + var(--safe-left));
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .mark {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent-soft);
    color: var(--accent-strong);
    margin-bottom: 8px;
  }

  h1 {
    font-size: 2rem;
  }

  .steps {
    margin: 0;
    padding-left: 1.4em;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .steps a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
  }

  .later {
    align-self: center;
  }
</style>
