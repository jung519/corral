<script lang="ts">
  import { onMount } from 'svelte';
  import Button from './lib/Button.svelte';
  import { t } from './lib/i18n.svelte';

  const hasBridge = typeof window !== 'undefined' && !!window.corral;

  // Where the core runs. `local` forks it here (the default); `remote` attaches to one on
  // another machine over WebSocket — pairing once with a code from that core's log.
  let mode = $state<'local' | 'remote'>('local');
  let url = $state('');
  let paired = $state(false);
  let linkState = $state<'connected' | 'connecting' | 'disconnected'>('disconnected');
  let denial = $state<string | undefined>();
  let code = $state('');
  let busy = $state(false);
  let error = $state('');

  const stateKey = $derived(
    linkState === 'connected' ? 'link.connected' : linkState === 'connecting' ? 'link.connecting' : 'link.disconnected',
  );

  async function refresh() {
    if (!hasBridge) return;
    const r = await window.corral!.remote.get();
    mode = r.mode;
    url = r.url;
    paired = r.paired;
    linkState = r.state;
    denial = r.denial;
  }

  onMount(() => {
    void refresh();
    // The remote link reconnects on its own; mirror that in the UI instead of making the
    // user reopen the screen.
    return window.corral?.remote.onState((s) => {
      linkState = s.state as typeof linkState;
      denial = s.denial;
    });
  });

  async function useLocal() {
    busy = true;
    error = '';
    try {
      await window.corral!.remote.setMode('local');
      await refresh();
    } finally {
      busy = false;
    }
  }

  /** Already paired: just switch to remote — the stored token authenticates us. */
  async function useRemote() {
    if (!url.trim()) return;
    busy = true;
    error = '';
    try {
      await window.corral!.remote.setMode('remote', url.trim());
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function pair() {
    if (!url.trim() || !code.trim()) return;
    busy = true;
    error = '';
    try {
      const r = await window.corral!.remote.pair(url.trim(), code.trim());
      if (!r.ok) error = r.error ?? t('link.pairFailed');
      else code = '';
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function unpair() {
    busy = true;
    error = '';
    try {
      await window.corral!.remote.unpair();
      await refresh();
    } finally {
      busy = false;
    }
  }
</script>

<div class="card">
  <h2>{t('link.title')}</h2>
  <p class="hint">{t('link.hint')}</p>

  {#if !hasBridge}
    <p class="hint warn">{t('link.browserNote')}</p>
  {:else}
    <!-- Two cards side by side, not a list: this is a choice between two, and it stays a
         choice between two. The same shape the mode picker and the wizard's workspace
         backend already use. -->
    <div class="modes">
      <label class:on={mode === 'local'}>
        <span class="head">
          <input type="radio" checked={mode === 'local'} disabled={busy} onchange={useLocal} />
          <strong>{t('link.local')}</strong>
        </span>
        <span class="sub">{t('link.localHint')}</span>
      </label>
      <label class:on={mode === 'remote'}>
        <span class="head">
          <input type="radio" checked={mode === 'remote'} disabled={busy} onchange={() => (mode = 'remote')} />
          <strong>{t('link.remote')}</strong>
        </span>
        <span class="sub">{t('link.remoteHint')}</span>
      </label>
    </div>

    {#if mode === 'remote'}
      <div class="remote">
        <label class="field">
          <span>{t('link.url')}</span>
          <input type="text" bind:value={url} placeholder="ws://127.0.0.1:4410" spellcheck="false" disabled={busy} />
        </label>

        {#if paired}
          <div class="row">
            <span class="state {linkState}">● {t(stateKey)}</span>
            <span class="spacer"></span>
            <Button onclick={useRemote} disabled={busy || !url.trim()}>{t('link.apply')}</Button>
            <Button onclick={unpair} disabled={busy}>{t('link.unpair')}</Button>
          </div>
        {:else}
          <p class="pairHint">{t('link.pairHint')}</p>
          <div class="row">
            <input
              class="code"
              type="text"
              bind:value={code}
              placeholder="000000"
              inputmode="numeric"
              maxlength="6"
              spellcheck="false"
              disabled={busy}
            />
            <Button class="primary" onclick={pair} disabled={busy || !url.trim() || !code.trim()}>
              {busy ? t('link.pairing') : t('link.pair')}
            </Button>
          </div>
        {/if}

        {#if error}<p class="hint err">{error}</p>{/if}
        {#if denial && !error}<p class="hint err">{denial}</p>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 18px;
    margin-bottom: 12px;
  }
  h2 {
    font-size: 14px;
    margin: 0 0 4px;
    color: var(--text);
  }
  .hint {
    color: var(--text-dim);
    font-size: 12px;
    margin: 0 0 12px;
  }
  .hint.warn {
    color: var(--amber, #d29922);
  }
  .hint.err {
    color: var(--red, #f85149);
    margin: 8px 0 0;
  }
  /* Two columns, unconditionally — the same rule the mode picker and the wizard's
     two-way choices use. This is a choice between two and it stays a choice between two,
     so there is nothing for a breakpoint to decide. */
  .modes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    align-items: stretch;
  }
  .modes label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
  }
  .modes label:hover {
    border-color: var(--accent);
  }
  .modes label.on {
    border-color: var(--accent);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .head input {
    flex-shrink: 0;
    margin: 0;
  }
  .head strong {
    color: var(--text);
    font-weight: 500;
  }
  .sub {
    color: var(--text-dim);
    font-size: 12px;
  }
  .remote {
    margin-top: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .field input {
    width: 100%;
    box-sizing: border-box;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  .row .spacer {
    flex: 1;
  }
  .code {
    width: 120px;
    font-family: var(--mono, ui-monospace, Menlo, monospace);
    letter-spacing: 2px;
  }
  .pairHint {
    color: var(--text-dim);
    font-size: 12px;
    margin: 10px 0 0;
  }
  .state {
    font-size: 12px;
    color: var(--text-dim);
  }
  .state.connected {
    color: var(--green, #3fb950);
  }
  .state.connecting {
    color: var(--amber, #d29922);
  }
  .state.disconnected {
    color: var(--red, #f85149);
  }
</style>
