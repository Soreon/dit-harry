<script lang="ts">
  import { config } from '../config';
  import { useApp } from '../lib/app.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { formatRelative, plural } from './helpers';
  import Icon from './Icon.svelte';
  import KeyField from './KeyField.svelte';

  // Réglages : compte, Gemini, sauvegarde, synchronisation, à propos.
  const app = useApp();
  const uid = $props.id();

  const MIN_RETENTION = 7;
  const MAX_RETENTION = 3650;

  // Valeurs éditables : suivent les réglages, modifiables localement jusqu'à l'enregistrement
  let entryModel = $derived(app.settings.entryModel);
  let synthesisModel = $derived(app.settings.synthesisModel);
  let retention = $derived(app.settings.audioRetentionDays);

  let confirmSignOut = $state(false);
  let clearDevice = $state(false);
  let syncing = $state(false);

  const s = $derived(app.syncStatus);
  const defaultModels = $derived(
    app.settings.entryModel === config.defaultEntryModel &&
      app.settings.synthesisModel === config.defaultSynthesisModel,
  );
  const accountLabel = $derived(app.auth.name || app.auth.email || 'Compte Google');
  const initial = $derived((app.auth.name || app.auth.email || '?').charAt(0).toUpperCase());

  async function saveModel(which: 'entryModel' | 'synthesisModel', value: string): Promise<void> {
    const v = value.trim();
    if (!v) {
      // Champ vidé : on revient à la valeur enregistrée
      if (which === 'entryModel') entryModel = app.settings.entryModel;
      else synthesisModel = app.settings.synthesisModel;
      return;
    }
    if (v !== app.settings[which]) await app.saveSettings({ [which]: v });
  }

  async function resetModels(): Promise<void> {
    await app.saveSettings({
      entryModel: config.defaultEntryModel,
      synthesisModel: config.defaultSynthesisModel,
    });
  }

  async function saveRetention(): Promise<void> {
    // Champ vidé : bind:value donne null → on revient à la valeur enregistrée
    const raw: unknown = retention;
    const n = raw === null || raw === undefined || raw === '' ? Number.NaN : Math.round(Number(raw));
    if (!Number.isFinite(n)) {
      retention = app.settings.audioRetentionDays;
      return;
    }
    const clamped = Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, n));
    retention = clamped;
    if (clamped !== app.settings.audioRetentionDays) await app.saveSettings({ audioRetentionDays: clamped });
  }

  async function syncNow(): Promise<void> {
    syncing = true;
    try {
      await app.syncNow();
    } finally {
      syncing = false;
    }
  }

  function openSignOut(): void {
    clearDevice = false;
    confirmSignOut = true;
  }
</script>

<section class="screen settings" aria-labelledby="settings-title">
  <header class="screen-header">
    <h1 id="settings-title">Réglages</h1>
  </header>

  <!-- Compte -->
  <section class="card group" aria-labelledby="{uid}-account">
    <h2 id="{uid}-account" class="section-title">Compte Google</h2>
    <div class="account">
      <span class="avatar" aria-hidden="true">{initial}</span>
      <div class="who">
        <span class="name">{accountLabel}</span>
        {#if app.auth.email && app.auth.name}<span class="muted email">{app.auth.email}</span>{/if}
        <span class="state">
          {#if app.auth.status === 'signed-in'}
            <span class="chip chip-ok"><Icon name="check" size={14} /> Connecté</span>
          {:else if app.auth.status === 'signing-in'}
            <span class="chip">Connexion…</span>
          {:else if app.auth.status === 'loading'}
            <span class="chip">Chargement…</span>
          {:else}
            <span class="chip chip-pending">Session expirée</span>
          {/if}
        </span>
      </div>
    </div>
    <div class="row">
      {#if app.needsReconnect}
        <button type="button" class="btn btn-primary" onclick={() => app.signIn()}>Se reconnecter</button>
      {/if}
      <button type="button" class="btn btn-secondary" onclick={openSignOut}>Se déconnecter</button>
    </div>
  </section>

  <!-- Gemini -->
  <section class="card group" aria-labelledby="{uid}-gemini">
    <h2 id="{uid}-gemini" class="section-title">Gemini</h2>
    <KeyField />
    <p class="field-help">
      Pas encore de clé ?
      <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
        Crée-la sur Google AI Studio
      </a>.
    </p>

    <div class="field">
      <label class="field-label" for="{uid}-entry-model">Modèle pour les entrées</label>
      <input
        id="{uid}-entry-model"
        class="input"
        list="{uid}-models"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        bind:value={entryModel}
        onchange={() => saveModel('entryModel', entryModel)}
      />
      <span class="field-help">Transcription et analyse de chaque entrée.</span>
    </div>
    <div class="field">
      <label class="field-label" for="{uid}-synth-model">Modèle pour les synthèses</label>
      <input
        id="{uid}-synth-model"
        class="input"
        list="{uid}-models"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        bind:value={synthesisModel}
        onchange={() => saveModel('synthesisModel', synthesisModel)}
      />
      <span class="field-help">Synthèse de chaque journée.</span>
    </div>
    <datalist id="{uid}-models">
      <option value={config.defaultEntryModel}></option>
      <option value={config.defaultSynthesisModel}></option>
    </datalist>
    {#if !defaultModels}
      <button type="button" class="btn btn-ghost btn-small reset" onclick={resetModels}>
        Rétablir les modèles par défaut
      </button>
    {/if}
  </section>

  <!-- Sauvegarde -->
  <section class="card group" aria-labelledby="{uid}-backup">
    <h2 id="{uid}-backup" class="section-title">Sauvegarde</h2>

    <label class="switch-row" for="{uid}-mirror">
      <span class="switch-text">
        <span class="field-label">Copie lisible dans Google Drive</span>
        <span class="field-help">Un fichier par jour dans Mon Drive › <span class="nowrap">{config.mirrorFolderName}</span>.</span>
      </span>
      <input
        id="{uid}-mirror"
        class="switch"
        type="checkbox"
        role="switch"
        checked={app.settings.mirrorEnabled}
        onchange={(e) => app.saveSettings({ mirrorEnabled: e.currentTarget.checked })}
      />
    </label>

    <div class="field">
      <label class="field-label" for="{uid}-retention">Conservation de l'audio (jours)</label>
      <input
        id="{uid}-retention"
        class="input retention"
        type="number"
        inputmode="numeric"
        min={MIN_RETENTION}
        max={MAX_RETENTION}
        step="1"
        bind:value={retention}
        onchange={saveRetention}
      />
      <span class="field-help">
        Passé ce délai, l'audio est supprimé de ton Drive ; la transcription et l'analyse restent.
      </span>
    </div>

    <div class="field">
      <button type="button" class="btn btn-secondary" disabled={app.exporting} onclick={() => app.exportZip()}>
        {#if app.exporting}
          <span class="spinner" aria-hidden="true"></span> Préparation…
        {:else}
          <Icon name="download" size={18} /> Exporter tout (zip)
        {/if}
      </button>
      <span class="field-help">Toutes tes entrées et synthèses, en Markdown et en JSON (sans l'audio).</span>
    </div>
  </section>

  <!-- Synchronisation -->
  <section class="card group" aria-labelledby="{uid}-sync">
    <h2 id="{uid}-sync" class="section-title">Synchronisation</h2>
    <dl class="facts">
      <div>
        <dt>Dernier cycle</dt>
        <dd>{formatRelative(s.lastSyncAt, app.now)}</dd>
      </div>
      <div>
        <dt>En attente</dt>
        <dd>{app.pendingCount === 0 ? 'rien' : plural(app.pendingCount, 'entrée', 'entrées')}</dd>
      </div>
      {#if !app.online}
        <div>
          <dt>Réseau</dt>
          <dd>hors ligne</dd>
        </div>
      {/if}
    </dl>
    {#if s.lastError && !s.running}
      <p class="notice notice-error"><Icon name="alert" size={18} /> <span>{s.lastError}</span></p>
    {/if}
    <button type="button" class="btn btn-primary" disabled={syncing || s.running || !app.online} onclick={syncNow}>
      {#if syncing || s.running}
        <span class="spinner" aria-hidden="true"></span> Synchronisation…
      {:else}
        <Icon name="sync" size={18} /> Synchroniser maintenant
      {/if}
    </button>
  </section>

  <!-- À propos -->
  <section class="about" aria-label="À propos">
    <p><strong>{config.appName}</strong> · version {config.version}</p>
    <p class="muted">Construite le {new Date(config.buildTime).toLocaleDateString('fr-FR')}</p>
    {#if config.mock}<p class="chip chip-pending">Mode démo : Google et Gemini simulés</p>{/if}
  </section>
</section>

<ConfirmDialog
  bind:open={confirmSignOut}
  title="Se déconnecter ?"
  message="Tes entrées restent dans ton Google Drive. Tu pourras te reconnecter à tout moment."
  confirmLabel={clearDevice ? 'Déconnecter et effacer' : 'Se déconnecter'}
  danger={clearDevice}
  onconfirm={() => app.signOut(clearDevice)}
>
  <label class="check-row">
    <input type="checkbox" bind:checked={clearDevice} />
    <span>Effacer aussi les données de cet appareil</span>
  </label>
  {#if clearDevice && app.pendingCount > 0}
    <p class="notice notice-warning">
      Attention : {plural(app.pendingCount, 'entrée n’est', 'entrées ne sont')} pas encore dans ton Drive.
      {app.pendingCount > 1 ? 'Elles seront perdues.' : 'Elle sera perdue.'}
    </p>
  {/if}
</ConfirmDialog>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .screen-header {
    margin-bottom: 4px;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .group .section-title {
    margin: 0;
  }

  .account {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .avatar {
    flex: none;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-family: var(--font-serif);
    font-size: 1.4rem;
    font-weight: 600;
  }

  .who {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .email {
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }

  .state {
    margin-top: 4px;
  }

  .reset {
    align-self: flex-start;
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 44px;
    cursor: pointer;
  }

  .switch-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* Interrupteur : case à cocher native restylée (role="switch") */
  .switch {
    appearance: none;
    flex: none;
    position: relative;
    width: 52px;
    height: 32px;
    margin: 0;
    border-radius: var(--radius-pill);
    background: var(--line-strong);
    cursor: pointer;
    transition: background-color 0.2s ease;
  }

  .switch::after {
    content: '';
    position: absolute;
    top: 4px;
    left: 4px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--knob);
    box-shadow: var(--shadow-sm);
    transition: transform 0.2s ease;
  }

  .switch:checked {
    background: var(--accent-strong);
  }

  .switch:checked::after {
    transform: translateX(20px);
  }

  .retention {
    max-width: 140px;
  }

  .nowrap {
    white-space: nowrap;
  }

  .field .btn {
    align-self: flex-start;
  }

  .facts {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 10px;
  }

  .facts div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  dt {
    font-size: 0.8125rem;
    color: var(--ink-muted);
  }

  dd {
    margin: 0;
    font-weight: 600;
  }

  .group > .btn {
    align-self: flex-start;
  }

  .about {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px 0 8px;
    font-size: 0.875rem;
    text-align: center;
  }

  .check-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    cursor: pointer;
  }

  .check-row input {
    width: 20px;
    height: 20px;
    accent-color: var(--danger);
  }
</style>
