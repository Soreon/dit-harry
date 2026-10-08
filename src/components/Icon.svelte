<script lang="ts" module>
  export type IconName =
    | 'mic'
    | 'stop'
    | 'pen'
    | 'sun'
    | 'book'
    | 'sliders'
    | 'back'
    | 'chevron'
    | 'close'
    | 'trash'
    | 'retry'
    | 'sync'
    | 'cloud-off'
    | 'key'
    | 'user'
    | 'check'
    | 'alert'
    | 'download'
    | 'eye'
    | 'eye-off'
    | 'sparkle'
    | 'external'
    | 'people'
    | 'pin'
    | 'lock'
    | 'fingerprint';
</script>

<script lang="ts">
  // Icônes en SVG inline (trait 1,8 px, angles arrondis), décoratives par défaut.
  let { name, size = 24 }: { name: IconName; size?: number } = $props();
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === 'mic'}
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  {:else if name === 'stop'}
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none" />
  {:else if name === 'pen'}
    <path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  {:else if name === 'sun'}
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
  {:else if name === 'book'}
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
    <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19" />
    <path d="M9 7.5h6" />
  {:else if name === 'sliders'}
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  {:else if name === 'back'}
    <path d="M15 5l-7 7 7 7" />
  {:else if name === 'chevron'}
    <path d="M9 5l7 7-7 7" />
  {:else if name === 'close'}
    <path d="M6 6l12 12M18 6L6 18" />
  {:else if name === 'trash'}
    <path d="M4 7h16" />
    <path d="M9.5 7V4.5h5V7" />
    <path d="M6 7l1 13h10l1-13" />
    <path d="M10 11v5.5M14 11v5.5" />
  {:else if name === 'retry'}
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v5h-5" />
  {:else if name === 'sync'}
    <path d="M4.5 10a8 8 0 0 1 14-3L20 8.5" />
    <path d="M20 4v4.5h-4.5" />
    <path d="M19.5 14a8 8 0 0 1-14 3L4 15.5" />
    <path d="M4 20v-4.5h4.5" />
  {:else if name === 'cloud-off'}
    <path d="M3 3l18 18" />
    <path d="M9 6.3A5.5 5.5 0 0 1 17.5 10h.5a3.5 3.5 0 0 1 2.2 6.2" />
    <path d="M16.5 19H7a4.5 4.5 0 0 1-1.6-8.7" />
  {:else if name === 'key'}
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2L20 3M16 7l3 3M13.5 9.5l2 2" />
  {:else if name === 'user'}
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
  {:else if name === 'check'}
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  {:else if name === 'alert'}
    <path d="M12 3.5L21.5 20h-19z" />
    <path d="M12 10v4.5M12 17.2v.3" />
  {:else if name === 'download'}
    <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
  {:else if name === 'eye'}
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  {:else if name === 'eye-off'}
    <path d="M3 3l18 18" />
    <path d="M10.6 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.7 3.4M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-.9" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  {:else if name === 'sparkle'}
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  {:else if name === 'external'}
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  {:else if name === 'people'}
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
  {:else if name === 'pin'}
    <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" />
    <circle cx="12" cy="10" r="2.5" />
  {:else if name === 'lock'}
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    <path d="M12 14.5v2.2" />
  {:else if name === 'fingerprint'}
    <path d="M4.8 9.6A7.6 7.6 0 0 1 17.3 6.4" />
    <path d="M19.3 9.8c.2.6.3 1.2.3 1.8v1c0 1.9-.2 3.7-.7 5.4" />
    <path d="M6.3 17.2c.4-1.4.6-2.9.6-4.4v-1.2a5.1 5.1 0 0 1 8.6-3.7" />
    <path d="M16.9 10.4c.1.4.2.8.2 1.2v1.2c0 2.6-.4 5-1.3 7.2" />
    <path d="M9.4 11.6a2.6 2.6 0 0 1 5.2 0v1.2c0 3-.6 5.8-1.8 8.2" />
    <path d="M12 12.4v.4c0 2.6-.5 5.1-1.5 7.4" />
    <path d="M9.3 15.5c-.2 1.6-.6 3.1-1.3 4.5" />
  {/if}
</svg>

<style>
  .icon {
    flex: none;
    display: block;
  }
</style>
