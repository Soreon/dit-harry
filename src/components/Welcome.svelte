<script lang="ts">
  import { config } from '../config';
  import { useApp } from '../lib/app.svelte';
  import Icon from './Icon.svelte';

  // Accueil non connecté : présentation + connexion Google.
  const app = useApp();

  const missingClientId = !config.mock && config.googleClientId.trim() === '';
  const busy = $derived(app.auth.status === 'signing-in' || app.auth.status === 'loading');
</script>

<div class="welcome">
  <div class="hero">
    <div class="mark" aria-hidden="true">
      <Icon name="mic" size={40} />
    </div>
    <h1>Dit Harry</h1>
    <p class="tagline">Ton journal intime, à voix haute.</p>
  </div>

  <ul class="points">
    <li>
      <span class="bullet" aria-hidden="true"><Icon name="mic" size={20} /></span>
      <span>Raconte ta journée quelques minutes : Harry transcrit, donne un titre et résume.</span>
    </li>
    <li>
      <span class="bullet" aria-hidden="true"><Icon name="sparkle" size={20} /></span>
      <span>Chaque lendemain, une synthèse de ta journée t'attend.</span>
    </li>
    <li>
      <span class="bullet" aria-hidden="true"><Icon name="book" size={20} /></span>
      <span>
        Ton journal est rangé dans ton Google Drive ; Gemini, l'IA de Google, le transcrit et
        l'analyse avec ta propre clé.
      </span>
    </li>
  </ul>

  <div class="actions">
    {#if missingClientId}
      <p class="notice notice-warning" role="alert">
        Identifiant client Google manquant (VITE_GOOGLE_CLIENT_ID) : ce build n'a pas été configuré.
        Suis docs/SETUP.md pour le renseigner.
      </p>
    {:else}
      {#if app.auth.status === 'error' && app.auth.error}
        <p class="notice notice-error" role="alert">{app.auth.error}</p>
      {/if}
      {#if app.deviceOwner}
        <p class="notice">
          <Icon name="user" size={18} />
          <span>
            Ce téléphone garde le journal de <strong class="owner">{app.deviceOwner}</strong> :
            connecte-toi avec ce compte pour le retrouver.
          </span>
        </p>
      {/if}
      <button type="button" class="btn btn-primary btn-block big" disabled={busy} onclick={() => app.signIn()}>
        {#if busy}
          <span class="spinner" aria-hidden="true"></span>
          {app.auth.status === 'loading' ? 'Chargement…' : 'Connexion…'}
        {:else}
          Se connecter avec Google
        {/if}
      </button>
      <p class="fine">
        Google te demandera deux autorisations Drive : un dossier caché réservé à l'appli, et le
        dossier «&nbsp;Dit Harry&nbsp;» où tu retrouveras une copie lisible. Coche bien les deux.
      </p>
    {/if}
  </div>
</div>

<style>
  .welcome {
    min-height: 100dvh;
    max-width: 480px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 32px;
    padding: calc(32px + var(--safe-top)) calc(24px + var(--safe-right)) calc(32px + var(--safe-bottom))
      calc(24px + var(--safe-left));
  }

  .hero {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }

  .mark {
    width: 88px;
    height: 88px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: 0 0 0 12px var(--accent-soft);
    margin-bottom: 18px;
  }

  h1 {
    font-size: 2.5rem;
  }

  .tagline {
    font-family: var(--font-serif);
    font-size: 1.2rem;
    font-style: italic;
    color: var(--ink-muted);
  }

  .points {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .points li {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }

  .bullet {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--surface-sunk);
    color: var(--accent-strong);
  }

  .points li span:last-child {
    padding-top: 6px;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .big {
    min-height: 52px;
    font-size: 1.0625rem;
  }

  .fine {
    font-size: 0.875rem;
    color: var(--ink-muted);
    text-align: center;
  }

  .owner {
    overflow-wrap: anywhere;
  }
</style>
