<script lang="ts">
  import { useApp } from '../lib/app.svelte';
  import Icon from './Icon.svelte';

  // Barre d'onglets du bas : Aujourd'hui · Journal · Réglages.
  const app = useApp();

  const active = $derived.by((): 'today' | 'journal' | 'settings' => {
    const r = app.route;
    switch (r.name) {
      case 'today':
        return 'today';
      case 'settings':
        return 'settings';
      case 'entry':
        return app.getEntry(r.id)?.day === app.today ? 'today' : 'journal';
      case 'day':
        return r.day === app.today ? 'today' : 'journal';
      default:
        return 'journal';
    }
  });
</script>

<nav class="tabbar" aria-label="Navigation principale">
  <a href="#/" class:active={active === 'today'} aria-current={active === 'today' ? 'page' : undefined}>
    <Icon name="mic" />
    <span>Aujourd'hui</span>
  </a>
  <a href="#/journal" class:active={active === 'journal'} aria-current={active === 'journal' ? 'page' : undefined}>
    <Icon name="book" />
    <span>Journal</span>
  </a>
  <a href="#/reglages" class:active={active === 'settings'} aria-current={active === 'settings' ? 'page' : undefined}>
    <Icon name="sliders" />
    <span>Réglages</span>
  </a>
</nav>

<style>
  .tabbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    display: flex;
    justify-content: center;
    gap: 4px;
    height: calc(var(--tabbar-h) + var(--safe-bottom));
    padding: 6px calc(8px + var(--safe-right)) calc(6px + var(--safe-bottom)) calc(8px + var(--safe-left));
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    border-top: 1px solid var(--line);
    backdrop-filter: blur(10px);
  }

  a {
    flex: 1;
    max-width: 180px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    border-radius: 14px;
    color: var(--ink-muted);
    text-decoration: none;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  a:hover {
    color: var(--ink);
  }

  a.active {
    color: var(--accent-strong);
    background: var(--accent-soft);
  }
</style>
