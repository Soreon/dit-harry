<script lang="ts">
  import { tick } from 'svelte';
  import { provideApp, type AppController } from '../lib/app.svelte';
  import { routeHash } from './helpers';
  import AccountConflict from './AccountConflict.svelte';
  import Splash from './Splash.svelte';
  import Welcome from './Welcome.svelte';
  import KeySetup from './KeySetup.svelte';
  import StatusBanner from './StatusBanner.svelte';
  import TabBar from './TabBar.svelte';
  import Toasts from './Toasts.svelte';
  import TodayScreen from './TodayScreen.svelte';
  import JournalScreen from './JournalScreen.svelte';
  import DayScreen from './DayScreen.svelte';
  import EntryScreen from './EntryScreen.svelte';
  import SettingsScreen from './SettingsScreen.svelte';

  // Coquille : garde d'authentification, écrans d'accueil, routage hash.
  let { app }: { app: AppController } = $props();
  // Le contrôleur est créé une seule fois par App.svelte : capturer sa valeur initiale suffit
  // svelte-ignore state_referenced_locally
  provideApp(app);

  const route = $derived(app.route);

  /** Écran affiché : change → le focus passe au titre du nouvel écran (lecteurs d'écran). */
  const screenKey = $derived(
    !app.hasAccount
      ? app.auth.status === 'loading'
        ? 'splash'
        : 'welcome'
      : app.showAccountConflict
        ? 'conflict'
        : app.showKeySetup
          ? 'key'
          : routeHash(route),
  );
  let firstScreen = true;

  $effect(() => {
    void screenKey;
    // Premier affichage : le navigateur place déjà la lecture en haut de la page.
    if (firstScreen) {
      firstScreen = false;
      return;
    }
    void tick().then(focusScreenTitle);
  });

  /**
   * Après un changement d'écran, l'élément activé (lien, carte…) a souvent disparu : sans cela,
   * TalkBack repart d'une position imprévisible et le nouveau titre n'est pas annoncé.
   */
  function focusScreenTitle(): void {
    if (document.querySelector('dialog[open]')) return;
    const active = document.activeElement;
    // Un écran qui a placé lui-même le focus dans un champ le garde.
    if (active instanceof HTMLElement && active.isConnected && active.matches('input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    const title = document.querySelector<HTMLElement>('h1');
    if (!title) return;
    if (!title.hasAttribute('tabindex')) title.setAttribute('tabindex', '-1');
    title.focus({ preventScroll: true });
  }
</script>

{#if !app.hasAccount}
  {#if app.auth.status === 'loading'}
    <Splash />
  {:else}
    <Welcome />
  {/if}
{:else if app.showAccountConflict}
  <AccountConflict />
{:else if app.showKeySetup}
  <KeySetup />
{:else}
  <div class="app">
    <StatusBanner />
    <main id="main" tabindex="-1">
      {#if route.name === 'today'}
        <TodayScreen />
      {:else if route.name === 'journal'}
        <JournalScreen />
      {:else if route.name === 'day'}
        {#key route.day}
          <DayScreen day={route.day} />
        {/key}
      {:else if route.name === 'entry'}
        {#key route.id}
          <EntryScreen id={route.id} />
        {/key}
      {:else if route.name === 'settings'}
        <SettingsScreen />
      {/if}
    </main>
    <TabBar />
  </div>
{/if}

<Toasts
  offset={!app.hasAccount || app.showAccountConflict || app.showKeySetup
    ? 'edge'
    : route.name === 'today'
      ? 'dock'
      : 'tabbar'}
/>

<style>
  .app {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }

  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding-bottom: calc(var(--tabbar-h) + var(--safe-bottom));
  }

  main:focus {
    outline: none;
  }

  /* Titre d'écran focalisé par programme (pas un élément interactif) : pas d'anneau. */
  :global(h1[tabindex='-1']:focus) {
    outline: none;
  }
</style>
