<script lang="ts">
  /**
   * Getting Claude's subscription token, in one place with room to explain itself.
   *
   * ## Why a dialog
   *
   * This lived inside a provider card — one third of a row wide — and a three-step flow
   * does not fit there: the buttons were squeezed until their labels broke one character
   * per line, and the sign-in URL, printed in full, buried the one thing the reader had to
   * do. A card holds a value; a task this size gets a dialog (the shape `RunPrompt` uses).
   *
   * ## What the CLI actually requires
   *
   * Verified against the CLI's own bundle rather than assumed — the assumption is what
   * made this take four attempts (CRL-84):
   *
   *   - `claude setup-token` is an Ink TUI. With no tty it prints **nothing**, so corral
   *     lends it one through `expect`.
   *   - Sign-in redirects to a **remote** page (`platform.claude.com/oauth/code/callback`)
   *     which shows a code. There is no localhost callback and **no path that completes
   *     without that code** — the CLI sits in `waiting_for_login` until one is submitted.
   *   - The code is `<code>#<state>`; the CLI splits on `#` and rejects either half empty.
   *   - On success it prints the token to the screen, then exits.
   *
   * So the middle step is the user's: sign in, copy the code, paste it. The dialog's job
   * is to say that in the right order and to make each part one click.
   *
   * ## And when it cannot work
   *
   * `expect` is base-system on macOS, usually absent on Linux desktops, and never on
   * Windows. Any failure — no pty, no URL, a rejected code, a timeout — lands on the
   * manual panel with the reason named and the command one click from the clipboard. The
   * manual route is also reachable up front, for someone who already knows it.
   */
  import Button from './lib/Button.svelte';
  import CopyButton from './lib/CopyButton.svelte';
  import PasteButton from './lib/PasteButton.svelte';
  import { t } from './lib/i18n.svelte';

  interface Props {
    /** The token, once there is one. The caller stores it (service `anthropic:oauth`). */
    ontoken: (token: string) => void;
    onclose: () => void;
    /** Open straight on the manual panel — the "I know the command" entry. */
    manual?: boolean;
  }
  let { ontoken, onclose, manual = false }: Props = $props();

  const COMMAND = 'claude setup-token';

  type Phase = 'opening' | 'code' | 'submitting' | 'done' | 'manual';
  // Read once on purpose: `manual` picks the phase this dialog opens on. After that the
  // phase belongs to the flow, and re-deriving it from the prop would throw the user back.
  // svelte-ignore state_referenced_locally
  let phase = $state<Phase>(manual ? 'manual' : 'opening');
  let url = $state('');
  let code = $state('');
  let token = $state('');
  /** Why the driven route stopped, as an i18n key suffix. Empty when the user chose manual. */
  let reason = $state('');
  /** The HTTP status, when the refusal came back from the server rather than being caught
   *  locally. Shown because "the server said 400" and "you copied half the code" are
   *  different problems with different next steps. */
  let status = $state('');
  /** A code missing its `#` — caught here so it never costs a round trip. */
  let codeComplaint = $state(false);

  function toManual(why: string, httpStatus = ''): void {
    clearInterval(liveness);
    reason = why;
    status = httpStatus;
    phase = 'manual';
    url = '';
    code = '';
  }

  async function start(): Promise<void> {
    if (!window.corral) return toManual('no-bridge');
    try {
      const r = await window.corral.claudeTokenStart();
      if (!r.ok || !r.url) return toManual(r.reason ?? 'unknown');
      url = r.url;
      phase = 'code';
      watchSession();
    } catch {
      toManual('unknown');
    }
  }

  /**
   * Is the CLI still there while the user is off signing in?
   *
   * Signing in takes minutes, and the session can end underneath it. Discovering that on
   * submit means the user completed a browser login, copied a code, came back — and only
   * then learned it was for nothing. Asking every few seconds costs nothing and turns that
   * into a sentence they see while it still matters (CRL-84).
   */
  let liveness: ReturnType<typeof setInterval> | undefined;
  function watchSession(): void {
    clearInterval(liveness);
    liveness = setInterval(async () => {
      if (phase !== 'code') return;
      const r = await window.corral?.claudeTokenAlive().catch(() => ({ alive: true }));
      if (r && !r.alive) toManual('gone');
    }, 4000);
  }
  $effect(() => () => clearInterval(liveness));

  async function submit(): Promise<void> {
    codeComplaint = false;
    // The CLI's rule, applied before the round trip: `<code>#<state>`, neither half empty.
    const value = code.trim();
    const [a, b] = value.split('#');
    if (!a || !b) {
      codeComplaint = true;
      return;
    }
    phase = 'submitting';
    try {
      const r = await window.corral!.claudeTokenCode(value);
      if (r.ok && r.token) return finish(r.token);
      toManual(r.reason ?? 'unknown', r.error ?? '');
    } catch {
      toManual('unknown');
    }
  }

  function finish(value: string): void {
    clearInterval(liveness);
    token = value;
    phase = 'done';
    ontoken(value);
    // Long enough to read the ✓, short enough not to be a step of its own.
    setTimeout(onclose, 900);
  }

  function useManualToken(): void {
    const value = token.trim();
    if (!value) return;
    ontoken(value);
    onclose();
  }

  /** Failures a second attempt can fix, as opposed to "this machine cannot do it". */
  const RETRYABLE = new Set(['gone', 'timeout', 'invalid-code', 'refused', 'partial-code', 'unknown']);

  /** Fresh session, fresh address — the old code is bound to the run that issued it. */
  async function restart(): Promise<void> {
    await window.corral?.claudeTokenCancel().catch(() => undefined);
    reason = '';
    status = '';
    token = '';
    code = '';
    phase = 'opening';
  }

  async function cancel(): Promise<void> {
    clearInterval(liveness);
    await window.corral?.claudeTokenCancel().catch(() => undefined);
    onclose();
  }

  $effect(() => {
    if (phase === 'opening') void start();
  });
</script>

<div class="overlay" onclick={cancel} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
    <div class="phead">
      <strong>{t('oauth.title')}</strong>
      <button class="x" onclick={cancel} aria-label={t('editor.cancel')}>✕</button>
    </div>

    {#if phase === 'opening'}
      <p class="lead">{t('oauth.opening')}</p>
      <div class="actions"><Button onclick={cancel}>{t('editor.cancel')}</Button></div>
    {:else if phase === 'code' || phase === 'submitting'}
      <!-- Numbered because the middle step is the user's, and the failure this replaces was
           a screen that said "waiting" while waiting on them. -->
      <ol class="steps">
        <li>{t('oauth.step1')}</li>
        <li>{t('oauth.step2')}</li>
        <li>{t('oauth.step3')}</li>
      </ol>
      <div class="row">
        <input
          bind:value={code}
          spellcheck="false"
          placeholder={t('oauth.codePlaceholder')}
          disabled={phase === 'submitting'}
        />
        <PasteButton onpaste={(v) => ((code = v), (codeComplaint = false))} />
      </div>
      {#if codeComplaint}<p class="warn">{t('oauth.partialCode')}</p>{/if}
      {#if phase === 'submitting'}<p class="lead">{t('oauth.checking')}</p>{/if}
      <div class="actions">
        <Button class="primary" onclick={submit} disabled={phase === 'submitting' || !code.trim()}>
          {t('oauth.codeSubmit')}
        </Button>
        <Button onclick={cancel}>{t('editor.cancel')}</Button>
      </div>
      <details>
        <summary>{t('oauth.noBrowser')}</summary>
        <p class="hint">{t('oauth.noBrowserHint')}</p>
        <CopyButton value={url} label={t('oauth.copyUrl')} />
      </details>
      <details>
        <summary>{t('oauth.manualSummary')}</summary>
        <p class="hint">{t('oauth.manualHint')}</p>
        <CopyButton value={COMMAND} label={t('oauth.copyCommand')} reveal />
      </details>
    {:else if phase === 'done'}
      <p class="ok">{t('oauth.done')}</p>
    {:else}
      {#if reason}<p class="warn">{t(`oauth.reason.${reason}`)}</p>{/if}
      <!-- The status, when the refusal came from the server. Not the CLI's sentence: it
           is drawn across frames and would arrive mangled. -->
      {#if status}<p class="said">{t('oauth.httpStatus')} {status}</p>{/if}
      <p class="lead">{t('oauth.manualHint')}</p>
      <div class="row"><CopyButton value={COMMAND} label={t('oauth.copyCommand')} reveal /></div>
      <div class="row">
        <input type="password" bind:value={token} spellcheck="false" placeholder="sk-ant-oat…" />
        <PasteButton onpaste={(v) => (token = v)} />
      </div>
      <div class="actions">
        <!-- Retrying is the shorter road for anything that was a timing accident — an
             expired code, a session that ended while the browser was open. Offered as a
             button so it is not a paragraph telling someone to press the other button. -->
        {#if RETRYABLE.has(reason)}<Button onclick={restart}>{t('oauth.restart')}</Button>{/if}
        <Button class="primary" onclick={useManualToken} disabled={!token.trim()}>{t('oauth.manualSave')}</Button>
        <Button onclick={cancel}>{t('editor.cancel')}</Button>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 24px;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: min(560px, 100%);
    padding: 16px 18px;
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .x {
    margin-left: auto;
    background: none;
    border: 0;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 14px;
  }
  .lead {
    margin: 0 0 10px;
    font-size: 13px;
    color: var(--text);
  }
  .hint {
    margin: 6px 0;
    font-size: 12px;
    color: var(--text-dim);
  }
  .steps {
    margin: 0 0 12px;
    padding-left: 20px;
    font-size: 13px;
    color: var(--text);
  }
  .steps li {
    margin-bottom: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
  .warn {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--warning);
  }
  .said {
    margin: -4px 0 10px;
    font-size: 11px;
    color: var(--text-dim);
    user-select: text;
  }
  .ok {
    margin: 0;
    font-size: 13px;
    color: var(--accent);
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }
  summary {
    font-size: 12px;
    color: var(--text-dim);
    cursor: pointer;
    margin-top: 8px;
  }
</style>
