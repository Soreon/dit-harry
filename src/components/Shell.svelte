<script lang="ts">
  import { provideApp, type AppController } from '../lib/app.svelte';
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
</script>

{#if !app.hasAccount}
  {#if app.auth.status === 'loading'}
    <Splash />
  {:else}
    <Welcome />
  {/if}
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

<Toasts offset={!app.hasAccount || app.showKeySetup ? 'edge' : route.name === 'today' ? 'dock' : 'tabbar'} />

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
</style>
