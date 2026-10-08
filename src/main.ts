import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Élément #app introuvable');

const app = mount(App, { target });

// Service worker : production uniquement (en dev, il mettrait en cache les modules Vite)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(import.meta.env.BASE_URL + 'sw.js')
      .catch((e: unknown) => console.warn('[sw] enregistrement impossible', e));
  });
}

export default app;
