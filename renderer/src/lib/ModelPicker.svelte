<script lang="ts">
  /**
   * Which model runs a stage. Two transports ask two different questions, so this is two
   * different controls.
   *
   * **cli** — a closed list. The provider's CLI resolves its own aliases (`opus`,
   * `flash`), which is why `MODELS` holds aliases rather than version numbers: a pinned
   * version goes stale within weeks and the CLI's alias never does. Nothing else is
   * valid, so a dropdown is the honest shape.
   *
   * **api** — an open one. The REST APIs want a concrete id, and corral translates the
   * aliases with a small table it carries itself (`src/agent/claude-api.ts`,
   * `google-api.ts`). That table pins a generation, so the day a newer model ships a
   * dropdown of aliases is a wall: the id exists, the API would take it, and there is
   * nowhere to type it. Hand-editing the config is not a way around — `agent.models` is a
   * block the wizard rewrites, so the next save erases it (CRL-81).
   *
   * So on api this is a text box with the aliases offered as *suggestions*. Type an alias
   * and the table maps it; type an id and it goes through untouched.
   *
   * Label and layout stay with the caller — the wizard already styles its own rows, and
   * scoped CSS would not reach in here anyway.
   */
  import { MODELS, type Provider } from './wizard';
  import { t } from './i18n.svelte';

  interface Props {
    value: string;
    provider: Provider;
    /** The transport this model will be called through. */
    transport: 'api' | 'cli';
    /** Distinguishes the suggestion lists of several pickers on one screen. */
    id: string;
  }
  let { value = $bindable(), provider, transport, id }: Props = $props();

  const listId = $derived(`models-${provider}-${id}`);

  /**
   * The list, plus whatever the config already says when that is not on it.
   *
   * A `<select>` bound to a value it has no option for selects nothing, and the next save
   * writes the nothing. So a config naming a concrete id — written on api, or by hand —
   * would lose its model the first time somebody opened this screen on cli.
   */
  const options = $derived(MODELS[provider].includes(value) || !value ? MODELS[provider] : [value, ...MODELS[provider]]);
</script>

{#if transport === 'api'}
  <input
    bind:value
    list={listId}
    spellcheck="false"
    autocomplete="off"
    placeholder={t('model.idPlaceholder')}
    title={t('model.idHint')}
  />
  <datalist id={listId}>
    {#each MODELS[provider] as m}<option value={m}></option>{/each}
  </datalist>
{:else}
  <select bind:value>
    {#each options as m}<option value={m}>{m}</option>{/each}
  </select>
{/if}
