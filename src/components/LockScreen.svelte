<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { useApp } from '../lib/app.svelte';
  import { formatWait, passphraseWaitMs } from '../lib/lock';
  import Icon from './Icon.svelte';

  // Écran de verrouillage : plein écran opaque au-dessus de tout. L'appli reste montée derrière
  // (inerte, cachée aux lecteurs d'écran) : un enregistrement ou une synchro continuent.
  const app = useApp();
  const lock = app.lock;
  const uid = $props.id();

  let title = $state<HTMLElement>();
  let field = $state<HTMLInputElement>();
  let wantsPassphrase = $state(false);
  let passphrase = $state('');
  let visible = $state(false);
  /** Horloge du compte à rebours après trop d'essais. */
  let now = $state(Date.now());

  const showPasskey = $derived(lock.loaded && lock.passkeyUsable);
  const showForm = $derived(lock.loaded && !!lock.config && (wantsPassphrase || !lock.passkeyUsable));
  const waitMs = $derived(lock.waitMs(now));
  /**
   * Attente imposée, fixe : c'est elle qu'annonce la zone `aria-live` (une seule fois). Le
   * décompte, qui change chaque seconde, est sur le bouton, hors de cette zone.
   */
  const lockoutMs = $derived(passphraseWaitMs(lock.attempts.failures));
  const recording = $derived(app.recording.status !== 'idle');
  const subtitle = $derived(
    !lock.loaded
      ? ''
      : showForm
        ? 'Saisis ta phrase de secours pour ouvrir ton journal.'
        : 'Déverrouille avec ton empreinte pour ouvrir ton journal.',
  );

  onMount(() => {
    // TalkBack annonce l'écran ; aucun clavier ne s'ouvre (titre, pas un champ).
    void tick().then(() => title?.focus({ preventScroll: true }));
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  function unlockWithPasskey(): void {
    // Appel direct dans le clic : la fenêtre du téléphone s'ouvre avant toute attente.
    void lock.unlockWithPasskey();
  }

  async function showPassphrase(): Promise<void> {
    wantsPassphrase = true;
    lock.unlockError = null;
    await tick();
    field?.focus();
  }

  async function backToPasskey(): Promise<void> {
    wantsPassphrase = false;
    lock.unlockError = null;
    passphrase = '';
    await tick();
    title?.focus({ preventScroll: true });
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (lock.passphrasePending || waitMs > 0) return;
    now = Date.now();
    const ok = await lock.unlockWithPassphrase(passphrase);
    now = Date.now();
    if (ok) return;
    passphrase = '';
    await tick();
    field?.focus();
  }
</script>

<section class="lock-screen" aria-labelledby="{uid}-title">
  <div class="inner">
    <div class="mark" aria-hidden="true">
      <Icon name="lock" size={38} />
    </div>
    <h1 id="{uid}-title" tabindex="-1" bind:this={title}>Dit Harry est verrouillée</h1>
    {#if subtitle}<p class="subtitle">{subtitle}</p>{/if}

    {#if recording}
      <p class="notice notice-warning">
        <Icon name="mic" size={18} />
        <span>Un enregistrement est en cours : il continue. Déverrouille pour l’arrêter.</span>
      </p>
    {/if}

    {#if lock.loadError}
      <p class="notice notice-error" role="alert">
        <Icon name="alert" size={18} />
        <span>{lock.loadError} Réessaie, ou relance l’appli.</span>
      </p>
      <button type="button" class="btn btn-secondary" onclick={() => lock.load()}>Réessayer</button>
    {/if}

    <div class="actions">
      {#if showPasskey && !wantsPassphrase}
        <button
          type="button"
          class="btn btn-primary btn-block big"
          disabled={lock.passkeyPending}
          onclick={unlockWithPasskey}
        >
          {#if lock.passkeyPending}
            <span class="spinner" aria-hidden="true"></span> Vérification…
          {:else}
            <Icon name="fingerprint" size={22} />
            Déverrouiller{lock.authenticator.simulated ? ' (démo)' : ''}
          {/if}
        </button>
        <button type="button" class="btn btn-ghost" onclick={showPassphrase}>Utiliser ma phrase de secours</button>
      {/if}

      {#if showForm}
        {#if lock.rpMismatch}
          <p class="field-help">
            L’empreinte a été enregistrée pour {lock.config?.rpId}. Ici ({lock.hostname || 'cette adresse'}),
            seule ta phrase de secours fonctionne.
          </p>
        {:else if !lock.passkeyUsable && lock.config?.credentialId}
          <p class="field-help">L’empreinte n’est pas disponible dans ce navigateur : utilise ta phrase de secours.</p>
        {/if}
        <form class="form" onsubmit={submit}>
          <label class="field-label" for="{uid}-passphrase">Phrase de secours</label>
          <div class="input-row">
            <input
              id="{uid}-passphrase"
              class="input"
              type={visible ? 'text' : 'password'}
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              enterkeyhint="done"
              bind:this={field}
              bind:value={passphrase}
            />
            <button
              type="button"
              class="icon-btn"
              aria-label={visible ? 'Masquer la phrase' : 'Afficher la phrase'}
              aria-pressed={visible}
              onclick={() => (visible = !visible)}
            >
              <Icon name={visible ? 'eye-off' : 'eye'} size={22} />
            </button>
          </div>
          <button
            type="submit"
            class="btn btn-primary btn-block big"
            disabled={lock.passphrasePending || waitMs > 0 || passphrase.trim() === ''}
          >
            {#if lock.passphrasePending}
              <span class="spinner" aria-hidden="true"></span> Vérification…
            {:else if waitMs > 0}
              Réessaie dans {formatWait(waitMs)}
            {:else}
              Déverrouiller
            {/if}
          </button>
        </form>
        {#if showPasskey}
          <button type="button" class="btn btn-ghost" onclick={backToPasskey}>Utiliser mon empreinte</button>
        {/if}
      {/if}

      <!-- Contenu fixe tant qu'il est affiché : annoncé une fois, pas à chaque seconde. -->
      <div class="status" aria-live="polite">
        {#if showForm && waitMs > 0}
          <p class="notice notice-warning">
            <Icon name="alert" size={18} />
            <span>Trop d’essais : attends {formatWait(lockoutMs)} avant de réessayer.</span>
          </p>
        {:else if lock.unlockError}
          <p class="notice notice-error">
            <Icon name="alert" size={18} />
            <span>{lock.unlockError}</span>
          </p>
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  .lock-screen {
    position: fixed;
    inset: 0;
    z-index: 100;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--bg);
    color: var(--ink);
  }

  /* Rien ne défile derrière l'écran de verrouillage. */
  :global(html:has(.lock-screen)) {
    overflow: hidden;
  }

  .inner {
    min-height: 100%;
    max-width: 420px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: calc(32px + var(--safe-top)) calc(24px + var(--safe-right)) calc(32px + var(--safe-bottom))
      calc(24px + var(--safe-left));
    text-align: center;
  }

  .mark {
    width: 84px;
    height: 84px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: 0 0 0 12px var(--accent-soft);
    margin-bottom: 14px;
  }

  h1 {
    font-size: 1.75rem;
  }

  h1:focus {
    outline: none;
  }

  .subtitle {
    color: var(--ink-muted);
    max-width: 30ch;
  }

  .actions {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
  }

  .big {
    min-height: 52px;
    font-size: 1.0625rem;
  }

  .form {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-align: left;
  }

  .input-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .status {
    width: 100%;
    text-align: left;
  }

  .notice {
    text-align: left;
  }
</style>
