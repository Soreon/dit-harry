<script lang="ts">
  // Liste de pastilles (thèmes, personnes, lieux).
  let { items, label }: { items: readonly string[]; label: string } = $props();
</script>

<ul class="tags" aria-label={label}>
  {#each items as item, i (i)}
    <li class="tag">{item}</li>
  {/each}
</ul>
