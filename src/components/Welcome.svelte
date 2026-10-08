<script lang="ts">
  import { fade } from 'svelte/transition';
  import { prefersReducedMotion } from 'svelte/motion';
  import { config } from '../config';
  import { useApp } from '../lib/app.svelte';
  import { canOfferInstall } from '../lib/install';
  import { install } from '../lib/install.svelte';
  import Icon from './Icon.svelte';

  // Accueil non connecté : présentation + connexion Google (+ installation si Chrome la propose).
  const app = useApp();

  const missingClientId = !config.mock && config.googleClientId.trim() === '';
  const busy = $derived(app.auth.status === 'signing-in' || app.auth.status === 'loading');
  const offerInstall = $derived(canOfferInstall(install));

  let title = $state<HTMLElement>();
  let signInButton = $state<HTMLButtonElement>();

  function installNow(): void {
    // prompt() d'abord, dans le clic (Chrome exige un appui récent). Le bouton disparaît aussitôt
    // (événement à usage unique) : le focus passe à la connexion, sinon il retomberait sur <body>.
    app.installApp();
    if (signInButton?.isConnected && !signInButton.disabled) signInButton.focus({ preventScroll: true });
    else title?.focus({ preventScroll: true });
  }
</script>

<div class="welcome">
  <div class="hero">
    <div class="mark" aria-hidden="true">
      <Icon name="mic" size={40} />
    </div>
    <h1 tabindex="-1" bind:this={title}>Dit Harry</h1>
    <p class="tagline">Ton journal intime, à voix haute.</p>
    <!-- Sous l'accroche, visible sans faire défiler même sur un petit téléphone (barre d'adresse
         de Chrome comprise) : en bas de l'écran, personne ne la voyait. -->
    {#if offerInstall}
      <button
        type="button"
        class="btn btn-secondary install"
        transition:fade={{ duration: prefersReducedMotion.current ? 0 : 160 }}
        onclick={installNow}
      >
        <Icon name="download" size={18} /> Installer Dit Harry
      </button>
    {/if}
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
      <button
        type="button"
        class="btn btn-primary btn-block big"
        disabled={busy}
        bind:this={signInButton}
        onclick={() => app.signIn()}
      >
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

  .install {
    margin-top: 6px;
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

  /* Petits téléphones (≈ 360×740, moins la barre d'adresse) : tout tient sur un écran,
     connexion comprise, même avec la mention du propriétaire de l'appareil. */
  @media (max-height: 760px) {
    .welcome {
      gap: 20px;
      padding-top: calc(20px + var(--safe-top));
      padding-bottom: calc(20px + var(--safe-bottom));
    }

    .hero {
      gap: 6px;
    }

    .mark {
      width: 64px;
      height: 64px;
      box-shadow: 0 0 0 8px var(--accent-soft);
      margin-bottom: 12px;
    }

    h1 {
      font-size: 2.1rem;
    }

    .tagline {
      font-size: 1.1rem;
    }

    .points {
      gap: 10px;
      font-size: 0.9375rem;
    }

    .bullet {
      width: 32px;
      height: 32px;
    }

    .points li span:last-child {
      padding-top: 4px;
    }

    .actions {
      gap: 10px;
    }
  }
</style>
