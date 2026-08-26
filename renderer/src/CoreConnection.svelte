<script lang="ts">
  import { onMount } from 'svelte';
  import Button from './lib/Button.svelte';
  import CopyButton from './lib/CopyButton.svelte';
  import PasteButton from './lib/PasteButton.svelte';
  import { t } from './lib/i18n.svelte';
  import type { TunnelConfig, TunnelStatus } from './corral-bridge';

  /** What to run on the machine that will host the engine, to get a pairing code. */
  const PAIR_COMMAND = 'node dist/main.js corral.yaml --control-plane 4410 --pair';

  /** Default control-plane port — the one the core binds when nothing overrides it. */
  const DEFAULT_PORT = 4410;

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

  // The app opens the tunnel itself (CRL-114). Off is for someone who already has one —
  // their own ssh, or an overlay network — and just wants the address used as-is.
  let useTunnel = $state(true);
  let sshTarget = $state('');
  let remotePort = $state(DEFAULT_PORT);
  let localPort = $state(DEFAULT_PORT);
  let identityFile = $state('');
  let showAdvanced = $state(false);
  let tunnelStatus = $state<TunnelStatus>({ state: 'off' });

  /**
   * What is actually saved, as of the last read. Choosing a radio changes the selection
   * above; it does not change this. Applying is what moves one to the other.
   *
   * Selecting used to save — and saving restarts the core and tears down the tunnel, which
   * is more than a radio click should mean. It also wrote the file with the other mode's
   * fields absent, so switching erased the remote setup (CRL-119).
   */
  let saved = $state<{ mode: 'local' | 'remote'; url: string; tunnel: string }>({
    mode: 'local',
    url: '',
    tunnel: '',
  });

  /** With a tunnel, the address is ours to derive — it is our end of the pipe. */
  const effectiveUrl = $derived(useTunnel ? `ws://127.0.0.1:${localPort}` : url.trim());
  const tunnelCfg = $derived.by((): TunnelConfig | undefined =>
    useTunnel && sshTarget.trim()
      ? {
          target: sshTarget.trim(),
          remotePort,
          localPort,
          identityFile: identityFile.trim() || undefined,
        }
      : undefined,
  );
  /** Enough to try with: a destination when we tunnel, an address when we don't. */
  const ready = $derived(useTunnel ? !!sshTarget.trim() : !!url.trim());

  /** Selection or values differ from what is saved — there is something to apply. */
  const dirty = $derived(
    mode !== saved.mode ||
      (mode === 'remote' && (effectiveUrl !== saved.url || JSON.stringify(tunnelCfg ?? null) !== saved.tunnel)),
  );
  /** Local needs nothing typed; remote needs somewhere to go. */
  const canApply = $derived(mode === 'local' ? dirty : ready);

  /** The command that does by hand what the app is trying to do — the named fallback. */
  const tunnelCommand = $derived(
    `ssh -N -T -L ${localPort}:127.0.0.1:${remotePort} ${sshTarget.trim() || 'user@host'}`,
  );

  /**
   * What to say about the tunnel.
   *
   * A failed tunnel must read as a failed tunnel. Before this, a missing tunnel showed up
   * as a socket that reconnected forever, so the screen said "reconnecting" about a port
   * that was never there.
   */
  const tunnelLine = $derived.by(() => {
    if (!useTunnel || mode !== 'remote') return '';
    if (tunnelStatus.state === 'up') return t('link.tunnelUp');
    if (tunnelStatus.state === 'starting') return t('link.tunnelStarting');
    if (tunnelStatus.state === 'off') return '';
    const key =
      tunnelStatus.code === 'ssh-not-found'
        ? 'link.tunnelErrNoSsh'
        : tunnelStatus.code === 'auth-failed'
          ? 'link.tunnelErrAuth'
          : tunnelStatus.code === 'forward-failed'
            ? 'link.tunnelErrForward'
            : tunnelStatus.code === 'timeout'
              ? 'link.tunnelErrTimeout'
              : 'link.tunnelErrExited';
    return t(key);
  });

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
    tunnelStatus = r.tunnelStatus ?? { state: 'off' };
    // No saved tunnel means the address was meant to be used as-is; don't second-guess it.
    useTunnel = !!r.tunnel;
    if (r.tunnel) {
      sshTarget = r.tunnel.target;
      remotePort = r.tunnel.remotePort;
      localPort = r.tunnel.localPort;
      identityFile = r.tunnel.identityFile ?? '';
    }
    saved = { mode: r.mode, url: r.url, tunnel: JSON.stringify(r.tunnel ?? null) };
  }

  onMount(() => {
    void refresh();
    // The remote link reconnects on its own; mirror that in the UI instead of making the
    // user reopen the screen.
    return window.corral?.remote.onState((s) => {
      linkState = s.state as typeof linkState;
      denial = s.denial;
      if (s.tunnelStatus) tunnelStatus = s.tunnelStatus;
    });
  });

  /**
   * Commit the selection. The only path that writes settings and restarts the core —
   * choosing a radio no longer does either.
   */
  async function apply() {
    if (!canApply) return;
    busy = true;
    error = '';
    try {
      if (mode === 'local') await window.corral!.remote.setMode('local');
      else await window.corral!.remote.setMode('remote', effectiveUrl, undefined, tunnelCfg);
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function pair() {
    if (!ready || !code.trim()) return;
    busy = true;
    error = '';
    try {
      // One button: it opens the tunnel and pairs through it. If the tunnel is the thing
      // that failed, say so by name rather than reporting a generic pairing failure.
      const r = await window.corral!.remote.pair(effectiveUrl, code.trim(), undefined, tunnelCfg);
      if (r.tunnelStatus) tunnelStatus = r.tunnelStatus;
      if (!r.ok) error = r.error === 'tunnel' ? '' : r.error === 'unreachable' ? t('link.unreachable') : (r.error ?? t('link.pairFailed'));
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
          <input
            type="radio"
            name="coreMode"
            checked={mode === 'local'}
            disabled={busy}
            onchange={() => (mode = 'local')}
          />
          <strong>{t('link.local')}</strong>
        </span>
        <span class="sub">{t('link.localHint')}</span>
      </label>
      <label class:on={mode === 'remote'}>
        <span class="head">
          <input
            type="radio"
            name="coreMode"
            checked={mode === 'remote'}
            disabled={busy}
            onchange={() => (mode = 'remote')}
          />
          <strong>{t('link.remote')}</strong>
        </span>
        <span class="sub">{t('link.remoteHint')}</span>
      </label>
    </div>

    {#if mode === 'remote'}
      <div class="remote">
        <!-- The app opens the tunnel (CRL-114). Unchecking is for someone who already has
             one — their own ssh, a VPN, an overlay network — and wants the address used
             as-is. Telling everyone else to "use a tunnel" and stopping there was the bug. -->
        <label class="check">
          <input type="checkbox" bind:checked={useTunnel} disabled={busy} />
          <span class="checkText">
            <strong>{t('link.useTunnel')}</strong>
            <span class="sub">{t('link.useTunnelHint')}</span>
          </span>
        </label>

        {#if useTunnel}
          <!-- Ask what the operator knows (which machine), not what we can work out
               (which loopback port our end of the tunnel landed on). -->
          <label class="field">
            <span>{t('link.sshTarget')}</span>
            <div class="row">
              <input
                type="text"
                bind:value={sshTarget}
                placeholder="user@your-server"
                spellcheck="false"
                disabled={busy}
              />
              <PasteButton onpaste={(v) => (sshTarget = v.trim())} />
            </div>
          </label>
          <details bind:open={showAdvanced}>
            <summary>{t('link.advanced')}</summary>
            <label class="field">
              <span>{t('link.corePort')}</span>
              <input type="number" bind:value={remotePort} min="1" max="65535" disabled={busy} />
            </label>
            <label class="field">
              <span>{t('link.localPort')}</span>
              <input type="number" bind:value={localPort} min="1" max="65535" disabled={busy} />
            </label>
            <label class="field">
              <span>{t('link.identityFile')}</span>
              <input
                type="text"
                bind:value={identityFile}
                placeholder="~/.ssh/id_ed25519"
                spellcheck="false"
                disabled={busy}
              />
            </label>
          </details>
        {:else}
          <label class="field">
            <span>{t('link.url')}</span>
            <input type="text" bind:value={url} placeholder="ws://127.0.0.1:4410" spellcheck="false" disabled={busy} />
          </label>
        {/if}

        <!-- A dead tunnel has to read as a dead tunnel. It used to show up as a socket
             reconnecting forever against a port that was never there. -->
        {#if tunnelLine}
          <p class="tunnel {tunnelStatus.state}">{tunnelLine}</p>
          {#if tunnelStatus.detail}<p class="hint detail">{tunnelStatus.detail}</p>{/if}
          {#if tunnelStatus.state === 'failed'}
            <details>
              <summary>{t('link.manualTunnel')}</summary>
              <p class="hint">{t('link.manualTunnelHint')}</p>
              <CopyButton value={tunnelCommand} label={t('link.copyTunnelCommand')} reveal />
            </details>
          {/if}
        {/if}

        {#if paired}
          <div class="row">
            <span class="state {linkState}">● {t(stateKey)}</span>
            <span class="spacer"></span>
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
            <PasteButton onpaste={(v) => (code = v.replace(/\D/g, '').slice(0, 6))} />
            <Button class="primary" onclick={pair} disabled={busy || !ready || !code.trim()}>
              {busy ? t('link.pairing') : t('link.pair')}
            </Button>
          </div>
          <!-- The code comes from a command on the *other* machine. Printing that command
               in full and leaving the reader to select it is work handed back; a copy
               button is the whole interaction. -->
          <details>
            <summary>{t('link.howToPair')}</summary>
            <p class="hint">{t('link.howToPairHint')}</p>
            <CopyButton value={PAIR_COMMAND} label={t('link.copyPairCommand')} reveal />
          </details>
        {/if}

        {#if error}<p class="hint err">{error}</p>{/if}
        {#if denial && !error}<p class="hint err">{denial}</p>{/if}
        <!-- A refusal that only says "failed" leaves nowhere to go. Name the three things
             that are actually wrong when pairing fails. -->
        {#if error || denial}<p class="hint">{t('link.pairFailHint')}</p>{/if}
      </div>
    {/if}

    <!-- The one path that writes settings and restarts the core. Outside the remote block
         on purpose: picking "this computer" has to be applicable too, and before this the
         button lived inside the remote branch where that selection could never reach it. -->
    <div class="row commit">
      {#if dirty}<span class="unapplied">{t('link.unapplied')}</span>{/if}
      <span class="spacer"></span>
      <Button class={dirty ? 'primary' : ''} onclick={apply} disabled={busy || !canApply}>
        {t('link.apply')}
      </Button>
    </div>
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
  .commit {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .unapplied {
    color: var(--warning);
    font-size: 12px;
  }
  .hint.detail {
    margin: 4px 0 0;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 11px;
    word-break: break-all;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin-bottom: 10px;
  }
  .checkText {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .checkText .sub {
    color: var(--text-dim);
    font-size: 12px;
  }
  /* The tunnel gets its own line: it is a different fact from the socket's state, and the
     one the operator can act on. */
  .tunnel {
    margin: 8px 0 0;
    font-size: 12px;
  }
  .tunnel.up {
    color: var(--green, #3fb950);
  }
  .tunnel.starting {
    color: var(--text-dim);
  }
  .tunnel.failed {
    color: var(--red, #f85149);
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
