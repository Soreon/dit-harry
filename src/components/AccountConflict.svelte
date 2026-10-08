<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { plural } from './helpers';
  import Icon from './Icon.svelte';

  // Écran bloquant : le compte Google connecté n'est pas celui à qui appartiennent les données
  // de ce téléphone. La synchronisation Drive est en pause jusqu'au choix de l'utilisateur.
  const app = useApp();

  let confirmErase = $state(false);

  const owner = $derived(app.accountConflict?.owner ?? '');
  const current = $derived(app.accountConflict?.current ?? '');
  const busy = $derived(app.resolvingConflict);
  const pending = $derived(app.pendingCount);
</script>

<div class="conflict">
  <div class="head">
    <div class="mark" aria-hidden="true"><Icon name="user" size={32} /></div>
    <h1>Un autre journal est sur ce téléphone</h1>
    {#if owner}
      <p>
        Ce téléphone garde le journal de <strong class="email">{owner}</strong>. Tu viens de te
        connecter avec <strong class="email">{current}</strong>. Pour ne pas mélanger les deux, la
        synchronisation est en pause.
      </p>
    {:else}
      <p>
        Ce téléphone garde déjà un journal, mais je ne sais pas à quel compte Google il appartient.
        Tu es connecté avec <strong class="email">{current}</strong> : la synchronisation est en pause
        en attendant ta réponse.
      </p>
    {/if}
  </div>

  {#if pending > 0}
    <p class="notice notice-warning" role="alert">
      <Icon name="alert" size={18} />
      <span>
        {plural(pending, 'entrée n’est', 'entrées ne sont')} pas encore dans un Google Drive{#if owner}&nbsp;:
          reconnecte-toi avec {owner} pour {pending > 1 ? 'les' : 'la'} sauver{/if}.
      </span>
    </p>
  {/if}

  <div class="actions">
    {#if !owner}
      <button type="button" class="btn btn-primary btn-block" disabled={busy} onclick={() => app.adoptDeviceData()}>
        C'est mon journal : continuer avec {current}
      </button>
    {/if}
    <button
      type="button"
      class="btn btn-block {owner ? 'btn-primary' : 'btn-secondary'}"
      disabled={busy}
      onclick={() => app.cancelAccountSwitch()}
    >
      {owner ? `Annuler — revenir à ${owner}` : 'Annuler et me déconnecter'}
    </button>
    <button type="button" class="btn btn-danger btn-block" disabled={busy} onclick={() => (confirmErase = true)}>
      {#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
      Effacer les données de cet appareil
    </button>
  </div>
</div>

<ConfirmDialog
  bind:open={confirmErase}
  title="Effacer les données de ce téléphone ?"
  message={owner
    ? `Le journal de ${owner} sera effacé de ce téléphone (il reste dans son Google Drive). Tu continueras avec ${current}.`
    : `Le journal de ce téléphone sera effacé (ce qui est déjà dans un Google Drive y reste). Tu continueras avec ${current}.`}
  confirmLabel="Effacer et continuer"
  danger
  onconfirm={() => app.eraseDeviceForNewAccount()}
>
  {#if pending > 0}
    <p class="notice notice-warning">
      {plural(pending, 'entrée n’est', 'entrées ne sont')} pas encore dans un Google Drive :
      {pending > 1 ? 'elles seront perdues' : 'elle sera perdue'}.
    </p>
  {/if}
</ConfirmDialog>

<style>
  .conflict {
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
    gap: 10px;
  }

  .mark {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--warning-soft);
    color: var(--warning);
    margin-bottom: 8px;
  }

  h1 {
    font-size: 1.75rem;
  }

  .email {
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* Les adresses email peuvent être longues : le libellé passe à la ligne. */
  .actions .btn {
    white-space: normal;
    text-align: center;
    padding-top: 10px;
    padding-bottom: 10px;
    overflow-wrap: anywhere;
  }
</style>
