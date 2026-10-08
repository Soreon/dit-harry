<script lang="ts">
  import { onMount } from 'svelte';
  import { createServices } from './lib/services';
  import { AppController } from './lib/app.svelte';
  import { toAppError } from './lib/errors';
  import Shell from './components/Shell.svelte';
  import Splash from './components/Splash.svelte';

  // Les services se créent de façon asynchrone (mocks importés à la demande) :
  // un écran d'accueil minimal s'affiche en attendant.
  let controller = $state<AppController | null>(null);
  let bootError = $state<string | null>(null);

  onMount(() => {
    let disposed = false;
    let created: AppController | null = null;
    createServices().then(
      (services) => {
        if (disposed) return;
        created = new AppController(services);
        controller = created;
        void created.start();
      },
      (e: unknown) => {
        console.error('[démarrage]', e);
        bootError = toAppError(e).message;
      },
    );
    return () => {
      disposed = true;
      created?.destroy();
    };
  });
</script>

{#if controller}
  <Shell app={controller} />
{:else if bootError}
  <Splash message="Impossible de démarrer Dit Harry." detail={bootError} onretry={() => location.reload()} />
{:else}
  <Splash />
{/if}
