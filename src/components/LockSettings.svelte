<script lang="ts">
  import { tick } from 'svelte';
  import { useApp } from '../lib/app.svelte';
  import type { EnableResult, LockResult } from '../lib/lock.svelte';
  import { LOCK_DELAYS, PASSPHRASE_MIN_LENGTH, formatWait, passphraseWaitMs, validateNewPassphrase } from '../lib/lock';
  import Icon from './Icon.svelte';

  // Réglages › Verrouillage : activer (phrase de secours puis empreinte), délai, verrouiller
  // maintenant, changer la phrase, réenregistrer l'empreinte, désactiver. Les trois dernières
  // actions demandent d'abord une vérification (empreinte ou phrase actuelle).
  const app = useApp();
  const lock = app.lock;
  const uid = $props.id();

  type Action = 'disable' | 'change' | 'reenroll';
  type Step =
    | { name: 'idle' }
    | { name: 'enroll' }
    | { name: 'fallback'; message: string; retry: boolean }
    /** `again` : la confirmation a expiré en cours de route, les champs saisis sont gardés. */
    | { name: 'verify'; action: Action; again?: boolean }
    | { name: 'change' }
    | { name: 'reenroll' };

  const ACTION_LABELS: Record<Action, string> = {
    disable: 'désactiver le verrouillage',
    change: 'changer ta phrase de secours',
    reenroll: 'enregistrer ton empreinte',
  };

  let step = $state<Step>({ name: 'idle' });
  let first = $state('');
  let second = $state('');
  let current = $state('');
  let show = $state(false);
  let error = $state<string | null>(null);
  let saving = $state(false);
  /** L'empreinte est proposée par ce téléphone (null : vérification en cours). */
  let available = $state<boolean | null>(null);
  let now = $state(Date.now());

  let title = $state<HTMLElement>();
  let firstField = $state<HTMLInputElement>();
  let currentField = $state<HTMLInputElement>();
  let passkeyButton = $state<HTMLButtonElement>();
  let reenrollButton = $state<HTMLButtonElement>();

  const busy = $derived(saving || lock.passkeyPending || lock.passphrasePending);
  const waitMs = $derived(lock.waitMs(now));
  /** Attente imposée, fixe (zone `aria-live`) ; le décompte est sur le bouton « Confirmer ». */
  const lockoutMs = $derived(passphraseWaitMs(lock.attempts.failures));
  const statusText = $derived(
    lock.config?.credentialId ? 'Empreinte et phrase de secours' : 'Phrase de secours seule',
  );
  const demo = $derived(lock.authenticator.simulated ? ' (démo)' : '');

  // Verrouillée en plein parcours : la vérification ne vaut plus, on repart de zéro.
  $effect(() => {
    if (lock.locked) reset();
  });

  // Compte à rebours après trop d'essais (seulement pendant une vérification).
  $effect(() => {
    if (step.name !== 'verify') return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  function reset(): void {
    step = { name: 'idle' };
    first = '';
    second = '';
    current = '';
    show = false;
    error = null;
    lock.endVerification();
  }

  async function focusTitle(): Promise<void> {
    await tick();
    title?.focus({ preventScroll: true });
  }

  function done(message: string): void {
    reset();
    app.toast(message, 'success');
    void focusTitle();
  }

  function cancel(): void {
    reset();
    void focusTitle();
  }

  /* --- Activation ---------------------------------------------------- */

  async function startEnroll(): Promise<void> {
    reset();
    step = { name: 'enroll' };
    available = null;
    void lock.checkPasskeyAvailable().then((v) => (available = v));
    await tick();
    firstField?.focus();
  }

  function submitEnroll(event: SubmitEvent): void {
    event.preventDefault();
    if (busy) return;
    const invalid = validateNewPassphrase(first, second);
    if (invalid) {
      error = invalid;
      return;
    }
    error = null;
    if (available === false) {
      step = {
        name: 'fallback',
        retry: false,
        message:
          'Ce téléphone ne propose pas l’empreinte à Dit Harry : aucun verrouillage d’écran configuré, ou navigateur trop ancien.',
      };
      // Le bouton « Continuer » a disparu : le focus revient au titre de la section.
      void focusTitle();
      return;
    }
    // Directement dans l'envoi du formulaire : la fenêtre de création de la clé d'accès exige
    // un geste récent de l'utilisateur.
    void finishEnable(lock.enable(first, second, true));
  }

  function enableWith(withPasskey: boolean): void {
    if (busy) return;
    error = null;
    void finishEnable(lock.enable(first, second, withPasskey));
  }

  async function finishEnable(pending: Promise<EnableResult>): Promise<void> {
    const r = await pending;
    if (r.ok) {
      done(
        r.withPasskey
          ? 'Verrouillage activé : empreinte et phrase de secours.'
          : 'Verrouillage activé avec ta phrase de secours.',
      );
    } else if (r.reason === 'passkey') {
      step = { name: 'fallback', retry: true, message: r.message };
      void focusTitle();
    } else {
      error = r.message;
    }
  }

  /* --- Actions protégées ---------------------------------------------- */

  async function ask(action: Action): Promise<void> {
    reset();
    step = { name: 'verify', action };
    await focusVerify();
  }

  /** Le bouton activé a disparu : le focus va à la première façon de confirmer. */
  async function focusVerify(): Promise<void> {
    await tick();
    if (lock.passkeyUsable) passkeyButton?.focus();
    else currentField?.focus();
  }

  /**
   * Confirmation expirée (plus de 2 min, ex. parti noter la nouvelle phrase ailleurs) : on la
   * redemande, sans perdre ce qui a été saisi ; l'action reprend ensuite.
   */
  async function askAgain(action: Action): Promise<void> {
    error = null;
    current = '';
    step = { name: 'verify', action, again: true };
    await focusVerify();
  }

  function verifyWithPasskey(action: Action): void {
    if (busy) return;
    error = null;
    // Dans le clic : la fenêtre de l'empreinte s'ouvre avant toute attente.
    void lock.verifyWithPasskey().then((r) => afterVerify(action, r));
  }

  async function verifyWithPassphrase(event: SubmitEvent, action: Action): Promise<void> {
    event.preventDefault();
    if (busy || waitMs > 0) return;
    error = null;
    const r = await lock.verifyWithPassphrase(current);
    now = Date.now();
    current = '';
    await afterVerify(action, r);
  }

  async function afterVerify(action: Action, r: LockResult): Promise<void> {
    // Verrouillée pendant la vérification : elle ne vaut plus (le parcours est déjà annulé).
    if (lock.locked || step.name !== 'verify') return;
    if (!r.ok) {
      if (r.message) error = r.message;
      return;
    }
    error = null;
    const resume = step.again === true;
    if (action === 'disable') {
      saving = true;
      try {
        const res = await lock.disable();
        if (res.ok) done('Verrouillage désactivé.');
        else error = res.message ?? null;
      } finally {
        saving = false;
      }
    } else if (action === 'change') {
      step = { name: 'change' };
      // Reprise après une confirmation expirée : la phrase déjà saisie est enregistrée.
      if (resume) {
        await saveChange();
        return;
      }
      await tick();
      firstField?.focus();
    } else {
      // Reprise ou non : la création de la clé d'accès exige un nouvel appui (geste récent).
      step = { name: 'reenroll' };
      await tick();
      reenrollButton?.focus();
    }
  }

  function submitChange(event: SubmitEvent): void {
    event.preventDefault();
    if (busy) return;
    void saveChange();
  }

  async function saveChange(): Promise<void> {
    const invalid = validateNewPassphrase(first, second);
    if (invalid) {
      error = invalid;
      return;
    }
    if (!lock.verified) {
      await askAgain('change');
      return;
    }
    error = null;
    const r = await lock.changePassphrase(first, second);
    if (r.ok) done('Phrase de secours changée.');
    else if (r.message) error = r.message;
  }

  function reenroll(): void {
    if (busy) return;
    if (!lock.verified) {
      void askAgain('reenroll');
      return;
    }
    error = null;
    // Dans le clic : création de la clé d'accès.
    void lock.reenrollPasskey().then((r) => {
      if (r.ok) done('Empreinte enregistrée.');
      else if (r.message) error = r.message;
    });
  }

  async function changeDelay(value: string): Promise<void> {
    const r = await lock.setDelay(Number(value));
    if (r.ok) app.toast('Réglage enregistré.', 'success');
    else app.toast(r.message ?? 'Réglage non enregistré.', 'error');
  }
</script>

{#snippet newPassphraseFields()}
  <div class="field">
    <label class="field-label" for="{uid}-first">
      {step.name === 'change' ? 'Nouvelle phrase de secours' : 'Phrase de secours'}
    </label>
    <input
      id="{uid}-first"
      class="input"
      type={show ? 'text' : 'password'}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      minlength={PASSPHRASE_MIN_LENGTH}
      bind:this={firstField}
      bind:value={first}
      oninput={() => (error = null)}
    />
  </div>
  <div class="field">
    <label class="field-label" for="{uid}-second">Confirme la phrase</label>
    <input
      id="{uid}-second"
      class="input"
      type={show ? 'text' : 'password'}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      bind:value={second}
      oninput={() => (error = null)}
    />
    <span class="field-help">
      {PASSPHRASE_MIN_LENGTH} caractères au moins. Note-la dans un endroit sûr : sans elle ni ton
      empreinte, il faudrait effacer les données de l’appli sur ce téléphone.
    </span>
  </div>
  <label class="check-row">
    <input type="checkbox" bind:checked={show} />
    <span>Afficher la phrase</span>
  </label>
{/snippet}

{#snippet feedback()}
  <!-- Contenu fixe tant qu'il est affiché : annoncé une fois, pas à chaque seconde. -->
  <div aria-live="polite">
    {#if step.name === 'verify' && waitMs > 0}
      <p class="notice notice-warning">
        <Icon name="alert" size={18} />
        <span>Trop d’essais : attends {formatWait(lockoutMs)} avant de réessayer avec ta phrase.</span>
      </p>
    {:else if error}
      <p class="notice notice-error">
        <Icon name="alert" size={18} />
        <span>{error}</span>
      </p>
    {/if}
  </div>
{/snippet}

<section class="card group" aria-labelledby="{uid}-title">
  <h2 id="{uid}-title" class="section-title" tabindex="-1" bind:this={title}>Verrouillage</h2>

  {#if !lock.enabled}
    {#if step.name === 'idle'}
      <p class="field-help intro">
        Demande ton empreinte (ou le code de ton téléphone) pour ouvrir Dit Harry : ton journal
        reste à l’abri si quelqu’un utilise ton téléphone déverrouillé. Une phrase de secours sert
        si l’empreinte ne marche pas.
      </p>
      <button type="button" class="btn btn-primary" onclick={startEnroll}>
        <Icon name="lock" size={18} /> Activer le verrouillage
      </button>
    {:else if step.name === 'enroll'}
      <form class="stack-form" onsubmit={submitEnroll}>
        <p class="lead">
          Choisis d’abord ta phrase de secours. Elle sert si l’empreinte ne marche pas (doigt mouillé,
          clé d’accès supprimée…).
        </p>
        {@render newPassphraseFields()}
        {@render feedback()}
        <div class="row">
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {#if busy}
              <span class="spinner" aria-hidden="true"></span>
              {lock.passkeyPending ? 'Empreinte…' : 'Enregistrement…'}
            {:else}
              Continuer
            {/if}
          </button>
          <button type="button" class="btn btn-ghost" disabled={busy} onclick={cancel}>Annuler</button>
        </div>
        {#if available !== false}
          <p class="field-help">
            Ensuite, ton téléphone te demandera de créer une clé d’accès « Dit Harry — verrou » et de
            poser ton doigt{demo}.
          </p>
        {/if}
      </form>
    {:else if step.name === 'fallback'}
      <p class="notice notice-warning">
        <Icon name="alert" size={18} />
        <span>{step.message}</span>
      </p>
      <p class="field-help">
        Tu peux activer le verrouillage avec ta phrase de secours seule : il faudra la taper à chaque
        ouverture de l’appli.
      </p>
      {@render feedback()}
      <div class="column">
        <button type="button" class="btn btn-primary" disabled={busy} onclick={() => enableWith(false)}>
          {#if busy && !lock.passkeyPending}
            <span class="spinner" aria-hidden="true"></span> Enregistrement…
          {:else}
            Activer avec la phrase seule
          {/if}
        </button>
        {#if step.retry}
          <button type="button" class="btn btn-secondary" disabled={busy} onclick={() => enableWith(true)}>
            {#if lock.passkeyPending}
              <span class="spinner" aria-hidden="true"></span> Empreinte…
            {:else}
              <Icon name="fingerprint" size={18} /> Réessayer l’empreinte
            {/if}
          </button>
        {/if}
        <button type="button" class="btn btn-ghost" disabled={busy} onclick={cancel}>Annuler</button>
      </div>
    {/if}
  {:else}
    <p class="status">
      <span class="chip chip-ok"><Icon name="lock" size={14} /> Activé</span>
      <span>{statusText}</span>
    </p>
    {#if lock.rpMismatch}
      <p class="field-help">
        L’empreinte a été enregistrée pour {lock.config?.rpId} : ici, seule la phrase de secours
        fonctionne.
      </p>
    {/if}

    <div class="field">
      <label class="field-label" for="{uid}-delay">Verrouiller après</label>
      <select
        id="{uid}-delay"
        class="input delay"
        value={lock.delaySec}
        disabled={!lock.config}
        onchange={(e) => changeDelay(e.currentTarget.value)}
      >
        {#each LOCK_DELAYS as d (d.sec)}
          <option value={d.sec}>{d.label}</option>
        {/each}
      </select>
      <span class="field-help">
        Temps passé hors de l’appli avant qu’elle se verrouille. Ouverte, elle se verrouille aussi après
        5 minutes sans toucher l’écran, sauf pendant un enregistrement.
      </span>
    </div>

    {#if step.name === 'idle'}
      <div class="column">
        <button type="button" class="btn btn-primary" onclick={() => lock.lock()}>
          <Icon name="lock" size={18} /> Verrouiller maintenant
        </button>
        <button type="button" class="btn btn-secondary" onclick={() => ask('change')}>
          Changer la phrase de secours
        </button>
        {#if lock.authenticator.supported}
          <button type="button" class="btn btn-secondary" onclick={() => ask('reenroll')}>
            <Icon name="fingerprint" size={18} />
            {lock.config?.credentialId ? 'Réenregistrer l’empreinte' : 'Ajouter l’empreinte'}
          </button>
        {/if}
        <button type="button" class="btn btn-danger" onclick={() => ask('disable')}>
          Désactiver le verrouillage
        </button>
      </div>
    {:else if step.name === 'verify'}
      {@const action = step.action}
      <div class="panel">
        <p class="lead">
          {#if step.again}
            Ta confirmation a expiré (elle vaut 2 minutes) : confirme de nouveau que c’est toi pour
            {ACTION_LABELS[action]}.
          {:else}
            Confirme que c’est toi pour {ACTION_LABELS[action]}.
          {/if}
        </p>
        {#if lock.passkeyUsable}
          <button
            type="button"
            class="btn btn-primary"
            disabled={busy}
            bind:this={passkeyButton}
            onclick={() => verifyWithPasskey(action)}
          >
            {#if lock.passkeyPending}
              <span class="spinner" aria-hidden="true"></span> Vérification…
            {:else}
              <Icon name="fingerprint" size={18} /> Utiliser mon empreinte{demo}
            {/if}
          </button>
        {/if}
        <form class="stack-form" onsubmit={(e) => verifyWithPassphrase(e, action)}>
          <label class="field-label" for="{uid}-current">
            {lock.passkeyUsable ? 'Ou ta phrase de secours actuelle' : 'Ta phrase de secours actuelle'}
          </label>
          <input
            id="{uid}-current"
            class="input"
            type="password"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            bind:this={currentField}
            bind:value={current}
            oninput={() => (error = null)}
          />
          <div class="row">
            <button
              type="submit"
              class="btn btn-secondary"
              disabled={busy || waitMs > 0 || current.trim() === ''}
            >
              {#if lock.passphrasePending || saving}
                <span class="spinner" aria-hidden="true"></span> Vérification…
              {:else if waitMs > 0}
                Réessaie dans {formatWait(waitMs)}
              {:else}
                Confirmer
              {/if}
            </button>
            <button type="button" class="btn btn-ghost" disabled={busy} onclick={cancel}>Annuler</button>
          </div>
        </form>
        {@render feedback()}
      </div>
    {:else if step.name === 'change'}
      <form class="panel stack-form" onsubmit={submitChange}>
        {@render newPassphraseFields()}
        {@render feedback()}
        <div class="row">
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {#if busy}
              <span class="spinner" aria-hidden="true"></span> Enregistrement…
            {:else}
              Enregistrer
            {/if}
          </button>
          <button type="button" class="btn btn-ghost" disabled={busy} onclick={cancel}>Annuler</button>
        </div>
      </form>
    {:else if step.name === 'reenroll'}
      <div class="panel">
        <p class="lead">
          Ton téléphone va te demander de créer une nouvelle clé d’accès « Dit Harry — verrou » et de
          poser ton doigt{demo}. L’ancienne, si elle existe encore, sera retirée quand le téléphone le
          permet.
        </p>
        {@render feedback()}
        <div class="row">
          <button type="button" class="btn btn-primary" disabled={busy} bind:this={reenrollButton} onclick={reenroll}>
            {#if lock.passkeyPending}
              <span class="spinner" aria-hidden="true"></span> Empreinte…
            {:else}
              <Icon name="fingerprint" size={18} /> Enregistrer l’empreinte
            {/if}
          </button>
          <button type="button" class="btn btn-ghost" disabled={busy} onclick={cancel}>Annuler</button>
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .group {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .group .section-title {
    margin: 0;
  }

  .section-title[tabindex='-1']:focus {
    outline: none;
  }

  .group > .btn {
    align-self: flex-start;
  }

  .intro,
  .lead {
    font-size: 0.9375rem;
  }

  .intro {
    color: var(--ink);
  }

  .stack-form,
  .panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .panel {
    padding-top: 4px;
    border-top: 1px solid var(--line);
  }

  .panel > .btn {
    align-self: flex-start;
  }

  .column {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }

  .delay {
    max-width: 220px;
  }

  .check-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    cursor: pointer;
    font-size: 0.9375rem;
  }

  .check-row input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent-strong);
  }
</style>
