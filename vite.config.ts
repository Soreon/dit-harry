/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * GitHub Pages ne permet pas d'en-têtes HTTP : la CSP est injectée en <meta>
 * (build uniquement — en dev, Vite injecte des styles/scripts inline).
 * Toute nouvelle origine appelée par l'appli doit être ajoutée ici.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "connect-src 'self' https://www.googleapis.com https://generativelanguage.googleapis.com https://oauth2.googleapis.com https://accounts.google.com/gsi/",
  'frame-src https://accounts.google.com/gsi/',
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "media-src 'self' blob:",
  "font-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'dit-harry-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

// BASE_PATH est fourni par la GitHub Action (sortie de actions/configure-pages) :
// "/" pour un site à la racine (https://<compte>.github.io/), "/<repo>/" pour un site de projet
// (ici https://soreon.github.io/dit-harry/ → "/dit-harry/").
const base = process.env.BASE_PATH ? process.env.BASE_PATH.replace(/\/?$/, '/') : '/';

export default defineConfig({
  base,
  plugins: [svelte(), cspMeta()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
