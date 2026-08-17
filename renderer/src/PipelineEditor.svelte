<script lang="ts">
  /**
   * Building a pipeline without writing YAML.
   *
   * One step per part of a pipeline: where work arrives, where the details come from,
   * what the model does, where the answer goes. That is the same four-way split the
   * schema has (`trigger` / `input` / `agent` / `output`), so a field path from the core
   * names its own step and nothing has to be mapped.
   *
   * **Fetching the details used to be folded into step one and it was a mistake.** The
   * original design said four steps would make a pipeline look more complicated than it
   * is (D22) — but a pipeline genuinely has four parts, and collapsing one of them did
   * not simplify anything, it hid the fetch-back that is the whole point of D6. The
   * person who designed it could not find it. A required decision behind a disclosure
   * triangle is more friction than an honest extra step.
   *
   * Nothing here validates the definition itself. The core does that on save and answers
   * with dotted field paths — one definition of what is valid, in the place that has to
   * load it.
   */
  import Button from './lib/Button.svelte';
  import * as api from './lib/api';
  import { t } from './lib/i18n.svelte';

  interface Props {
    onclose: () => void;
    onsaved: (key: string) => void;
  }
  let { onclose, onsaved }: Props = $props();

  let step = $state(0);
  let saving = $state(false);
  let issues = $state<api.SaveIssue[]>([]);

  // ── the definition being built ──────────────────────────────────────────────────
  let key = $state('');
  let description = $state('');

  let triggerKind = $state<'manual' | 'schedule' | 'pubsub'>('manual');
  let topic = $state('');
  let subscription = $state('');

  // ── when a schedule runs ────────────────────────────────────────────────────────
  // Picked by default, typed if you'd rather. Either way what gets saved is a cron
  // expression — the file keeps the format it always had, and someone who opens the YAML
  // sees the same five fields whichever way it was written here.
  let cronMode = $state<'pick' | 'manual'>('pick');
  let cron = $state('0 3 * * *');
  let every = $state<'hour' | 'day' | 'week' | 'month'>('day');
  let atMinute = $state(0);
  let atHour = $state(9);
  let onWeekday = $state(1);
  let onDay = $state(1);
  /**
   * Which clock the time above is on. Defaults to this computer's, and is always written —
   * a schedule set here should keep meaning the same hour after the core moves to a server
   * whose clock is almost certainly UTC.
   */
  let timezone = $state(localZone());

  function localZone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  /** Every zone the runtime knows. A long list, but typing jumps straight to a name. */
  const ZONES: string[] = (() => {
    try {
      const all = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
      if (all?.length) return all;
    } catch {
      /* older runtime — fall through */
    }
    return [localZone(), 'UTC'].filter((z, i, a) => a.indexOf(z) === i);
  })();

  const WEEKDAYS = ['weekday.sun', 'weekday.mon', 'weekday.tue', 'weekday.wed', 'weekday.thu', 'weekday.fri', 'weekday.sat'];
  const pad = (n: number) => String(n).padStart(2, '0');

  /** The picked schedule, as the cron it will be saved as. */
  const pickedCron = $derived(
    every === 'hour'
      ? `${atMinute} * * * *`
      : every === 'day'
        ? `${atMinute} ${atHour} * * *`
        : every === 'week'
          ? `${atMinute} ${atHour} * * ${onWeekday}`
          : `${atMinute} ${atHour} ${onDay} * *`,
  );
  /** What actually goes in the file. */
  const cronToSave = $derived(cronMode === 'pick' ? pickedCron : cron);

  let inputKind = $state<'none' | 'http'>('none');
  let inputUrl = $state('');
  let inputMethod = $state<'GET' | 'POST'>('GET');

  // ── how the fetch authenticates ───────────────────────────────────────────────────
  // Two separate things on purpose. Headers are ordinary text and go in the file. The
  // secret never does: the definition names a credential, and the value is written to
  // the credential store — the same one the wizard uses, which routes to the OS keychain
  // locally and to the core's own store when the core is on another machine.
  let inputHeaders = $state<Array<{ name: string; value: string }>>([]);
  let credService = $state('');
  let credAccount = $state('default');
  let credValue = $state('');
  let credSaved = $state(false);
  let authHeader = $state('authorization');
  let authPrefix = $state('Bearer ');

  const hasBridge = typeof window !== 'undefined' && !!window.corral;

  function addHeader(): void {
    inputHeaders = [...inputHeaders, { name: '', value: '' }];
  }
  function removeHeader(i: number): void {
    inputHeaders = inputHeaders.filter((_, j) => j !== i);
  }

  // ── trying the fetch before saving ────────────────────────────────────────────────
  let sampleEvent = $state('{ "id": "1" }');
  let testing = $state(false);
  let testResult = $state<{ ok: boolean; error?: string; body?: unknown; fields?: Record<string, unknown> } | null>(null);

  async function testFetch(): Promise<void> {
    testing = true;
    testResult = null;
    try {
      let event: unknown = {};
      try {
        event = JSON.parse(sampleEvent || '{}');
      } catch {
        testResult = { ok: false, error: t('editor.testBadEvent') };
        return;
      }
      const headers: Record<string, string> = {};
      for (const h of inputHeaders) if (h.name.trim()) headers[h.name.trim()] = h.value;
      const request: Record<string, unknown> = { method: inputMethod, url: inputUrl, headers };
      if (credService.trim()) {
        request.credential = { service: credService.trim(), account: credAccount.trim() || 'default' };
        request.auth = { header: authHeader.trim() || 'authorization', prefix: authPrefix };
      }
      testResult = await api.testFetch(request, event, parsePairs(selectText));
    } catch (err) {
      testResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      testing = false;
    }
  }

  /** Whether this ref already holds a secret, so an operator knows not to retype it. */
  async function refreshCredSaved(): Promise<void> {
    if (!hasBridge || !credService.trim()) {
      credSaved = false;
      return;
    }
    try {
      credSaved = await window.corral!.secret.has(credService.trim(), credAccount.trim() || 'default');
    } catch {
      credSaved = false;
    }
  }
  let selectText = $state('');
  let requireText = $state('');

  let provider = $state('');
  let maxTokens = $state(4096);
  let systemPrompt = $state('');
  let userTemplate = $state('');
  let schemaText = $state('{\n  "type": "object",\n  "properties": {\n    "items": { "type": "array" }\n  },\n  "required": ["items"]\n}');
  let maxItemsField = $state('');
  let maxItemsLimit = $state(4);
  let confidenceField = $state('');
  let confidenceThreshold = $state(0.7);

  let outputKind = $state<'none' | 'http' | 'pubsub'>('none');
  let outputUrl = $state('');
  let outputMethod = $state<'POST' | 'PATCH' | 'PUT'>('PATCH');
  let outputBody = $state('');
  let outputTopic = $state('');

  const STEPS = [t('editor.step1'), t('editor.step2'), t('editor.step3'), t('editor.step4')];
  const LAST = STEPS.length - 1;

  /** Which step owns a field path. One step per schema section, so this is a lookup. */
  function stepOf(path: string): number {
    if (path.startsWith('input')) return 1;
    if (path.startsWith('agent')) return 2;
    if (path.startsWith('output') || path.startsWith('on_low_confidence')) return 3;
    return 0; // key, description, trigger
  }
  const issuesFor = (index: number) => issues.filter((i) => stepOf(i.path) === index);

  /** `a: b` per line → an object. The compact way to type a handful of field mappings. */
  function parsePairs(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const at = line.indexOf(':');
      if (at < 1) continue;
      const name = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (name && value) out[name] = value;
    }
    return out;
  }

  function buildDefinition(): Record<string, unknown> {
    const trigger =
      triggerKind === 'schedule'
        ? { kind: 'schedule', cron: cronToSave, timezone }
        : triggerKind === 'pubsub'
          ? { kind: 'pubsub', topic, subscription }
          : { kind: 'manual' };

    const select = parsePairs(selectText);
    const require = requireText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const headers: Record<string, string> = {};
    for (const h of inputHeaders) if (h.name.trim()) headers[h.name.trim()] = h.value;
    const request: Record<string, unknown> = { method: inputMethod, url: inputUrl, headers };
    if (credService.trim()) {
      // A pointer, never the value.
      request.credential = { service: credService.trim(), account: credAccount.trim() || 'default' };
      request.auth = { header: authHeader.trim() || 'authorization', prefix: authPrefix };
    }
    const input =
      inputKind === 'http' ? { kind: 'http', request, select, require } : { kind: 'none', select, require };

    const validate: Record<string, unknown> = {};
    if (maxItemsField) validate.max_items = { field: maxItemsField, limit: maxItemsLimit };
    if (confidenceField) validate.min_confidence = { field: confidenceField, threshold: confidenceThreshold };

    let schema: unknown;
    try {
      schema = JSON.parse(schemaText);
    } catch {
      // Left as-is so the core reports it against `agent.schema` like any other problem,
      // rather than this editor inventing a second place where things can be wrong.
      schema = schemaText;
    }

    const output =
      outputKind === 'http'
        ? {
            kind: 'http',
            request: { method: outputMethod, url: outputUrl, body: parsePairs(outputBody) },
          }
        : outputKind === 'pubsub'
          ? { kind: 'pubsub', topic: outputTopic }
          : { kind: 'none' };

    return {
      key,
      description: description || undefined,
      trigger,
      input,
      agent: {
        provider: provider || undefined,
        max_tokens: maxTokens,
        prompt: { system: systemPrompt, user_template: userTemplate },
        schema,
        validate,
      },
      output,
    };
  }

  async function save() {
    saving = true;
    issues = [];
    try {
      // Before the definition, and to a different place: the file gets the reference, the
      // store gets the secret. Typing it again is only needed to change it.
      if (hasBridge && credService.trim() && credValue) {
        await window.corral!.secret.set(credService.trim(), credAccount.trim() || 'default', credValue);
        credValue = '';
        await refreshCredSaved();
      }
      const result = await api.savePipeline(buildDefinition());
      if (result.ok) {
        onsaved(key);
        return;
      }
      issues = result.issues ?? [];
      // Land on the first step that has something wrong, so the fix is on screen.
      const first = STEPS.map((_, i) => i).find((i) => issuesFor(i).length > 0);
      if (first !== undefined) step = first;
    } finally {
      saving = false;
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={onclose}
  onkeydown={(e) => {
    if (e.key === 'Escape') onclose();
  }}
>
  <div class="modal" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <h2>{t('editor.title')}</h2>

    <div class="steps">
      {#each STEPS as label, i}
        <button class="tab" class:on={step === i} class:bad={issuesFor(i).length > 0} onclick={() => (step = i)}>
          <span class="num">{i + 1}</span>{label}
        </button>
      {/each}
    </div>

    <div class="body">
      {#if step === 0}
        <label class="field">
          <span>{t('editor.key')}</span>
          <input bind:value={key} placeholder="classify-record" spellcheck="false" />
          <!-- It is an identifier, not a title: it becomes the file name, the history key
               and the URL. Saying so beats being refused on save. -->
          <small>{t('editor.keyHint')}</small>
        </label>
        <label class="field"><span>{t('editor.description')}</span><input bind:value={description} /></label>

        <label class="field">
          <span>{t('editor.trigger')}</span>
          <select bind:value={triggerKind}>
            <option value="manual">{t('editor.trigger.manual')}</option>
            <option value="schedule">{t('editor.trigger.schedule')}</option>
            <option value="pubsub">{t('editor.trigger.pubsub')}</option>
          </select>
        </label>
        {#if triggerKind === 'schedule'}
          <div class="sched">
            <div class="tabs">
              <button class="tab" class:on={cronMode === 'pick'} onclick={() => (cronMode = 'pick')}>{t('editor.cron.pick')}</button>
              <button class="tab" class:on={cronMode === 'manual'} onclick={() => (cronMode = 'manual')}>{t('editor.cron.manual')}</button>
            </div>

            {#if cronMode === 'pick'}
              <div class="row">
                <label class="field"
                  ><span>{t('editor.every')}</span>
                  <select bind:value={every}>
                    <option value="hour">{t('editor.every.hour')}</option>
                    <option value="day">{t('editor.every.day')}</option>
                    <option value="week">{t('editor.every.week')}</option>
                    <option value="month">{t('editor.every.month')}</option>
                  </select></label
                >
                {#if every === 'week'}
                  <label class="field"
                    ><span>{t('editor.onWeekday')}</span>
                    <select bind:value={onWeekday}>
                      {#each WEEKDAYS as day, i}<option value={i}>{t(day)}</option>{/each}
                    </select></label
                  >
                {:else if every === 'month'}
                  <label class="field"
                    ><span>{t('editor.onDay')}</span>
                    <select bind:value={onDay}>
                      {#each Array.from({ length: 31 }, (_, i) => i + 1) as d}<option value={d}>{d}</option>{/each}
                    </select></label
                  >
                {/if}
                {#if every !== 'hour'}
                  <label class="field narrow"
                    ><span>{t('editor.atHour')}</span>
                    <select bind:value={atHour}>
                      {#each Array.from({ length: 24 }, (_, i) => i) as h}<option value={h}>{pad(h)}</option>{/each}
                    </select></label
                  >
                {/if}
                <label class="field narrow"
                  ><span>{t('editor.atMinute')}</span>
                  <select bind:value={atMinute}>
                    {#each Array.from({ length: 60 }, (_, i) => i) as m}<option value={m}>{pad(m)}</option>{/each}
                  </select></label
                >
              </div>
              <!-- The file is the source of truth, so show what will land in it. -->
              <p class="built">cron <code>{pickedCron}</code></p>
            {:else}
              <label class="field"><span>{t('editor.cronExpr')}</span><input bind:value={cron} spellcheck="false" placeholder="0 9 * * *" /></label>
              <p class="hint">{t('editor.cronExprHint')}</p>
            {/if}

            <label class="field">
              <span>{t('editor.timezone')}</span>
              <select bind:value={timezone}>
                {#each ZONES as zone}<option value={zone}>{zone}</option>{/each}
              </select>
              <small>{t('editor.timezoneHint')}</small>
            </label>
          </div>
        {:else if triggerKind === 'pubsub'}
          <label class="field"><span>topic</span><input bind:value={topic} spellcheck="false" /></label>
          <label class="field"><span>subscription</span><input bind:value={subscription} spellcheck="false" placeholder="projects/p/subscriptions/s" /></label>
        {/if}

      {:else if step === 1}
        <!-- Its own step now. An event usually carries an identifier and nothing else, so
             "where do the details come from" is a question every pipeline has to answer —
             not an optional detail behind a triangle. -->
        <label class="field">
          <span>{t('editor.input.kind')}</span>
          <select bind:value={inputKind}>
            <option value="none">{t('editor.input.none')}</option>
            <option value="http">{t('editor.input.http')}</option>
          </select>
        </label>
        {#if inputKind === 'http'}
          <p class="hint">{t('editor.input.httpHint')}</p>
          <div class="two">
            <label class="field"><span>method</span><select bind:value={inputMethod}><option>GET</option><option>POST</option></select></label>
            <label class="field wide"><span>URL</span><input bind:value={inputUrl} spellcheck="false" placeholder="https://api.example.com/records/&#123;&#123;id&#125;&#125;" /></label>
          </div>

          <div class="block">
            <p class="blockTitle">{t('editor.headers')}</p>
            {#each inputHeaders as header, i}
              <div class="row">
                <input class="hname" bind:value={header.name} spellcheck="false" placeholder="x-tenant" />
                <input bind:value={header.value} spellcheck="false" placeholder="acme" />
                <button class="minus" onclick={() => removeHeader(i)} aria-label={t('editor.headerRemove')}>−</button>
              </div>
            {/each}
            <button class="plus" onclick={addHeader}>{t('editor.headerAdd')}</button>
            <p class="hint">{t('editor.headersHint')}</p>
          </div>

          <div class="block">
            <p class="blockTitle">{t('editor.credential')}</p>
            <p class="hint">{t('editor.credentialHint')}</p>
            <div class="row">
              <label class="field"
                ><span>{t('editor.credService')}</span>
                <input bind:value={credService} spellcheck="false" placeholder="backend" onblur={refreshCredSaved} /></label
              >
              <label class="field narrow"
                ><span>{t('editor.credAccount')}</span>
                <input bind:value={credAccount} spellcheck="false" placeholder="default" onblur={refreshCredSaved} /></label
              >
            </div>
            {#if credService.trim()}
              <label class="field">
                <span>{t('editor.credValue')}{#if credSaved}<span class="saved">{t('editor.credSaved')}</span>{/if}</span>
                <input type="password" bind:value={credValue} spellcheck="false" placeholder={credSaved ? '••••••••' : ''} />
              </label>
              <div class="row">
                <label class="field"><span>{t('editor.authHeader')}</span><input bind:value={authHeader} spellcheck="false" /></label>
                <label class="field"><span>{t('editor.authPrefix')}</span><input bind:value={authPrefix} spellcheck="false" /></label>
              </div>
              <p class="built">{authHeader.trim() || 'authorization'}: <code>{authPrefix}••••</code></p>
            {/if}
          </div>
        {:else}
          <p class="hint">{t('editor.input.noneHint')}</p>
        {/if}
        <label class="field">
          <span>{t('editor.select')}</span>
          <textarea bind:value={selectText} rows="3" spellcheck="false" placeholder={'title: data.title\ndetail: data.description'}></textarea>
        </label>
        <label class="field"><span>{t('editor.require')}</span><input bind:value={requireText} spellcheck="false" placeholder="title" /></label>

        {#if inputKind === 'http'}
          <!-- Paths are guesses until something proves them, and the only proof available
               today costs a model turn. This is the half that doesn't. -->
          <div class="block">
            <p class="blockTitle">{t('editor.test')}</p>
            <label class="field"
              ><span>{t('editor.testEvent')}</span>
              <input class="mono" bind:value={sampleEvent} spellcheck="false" /></label
            >
            <button class="plus" onclick={testFetch} disabled={testing || !inputUrl.trim()}>
              {testing ? t('editor.testing') : t('editor.testRun')}
            </button>

            {#if testResult && !testResult.ok}
              <p class="testErr">{testResult.error}</p>
            {:else if testResult}
              {#if Object.keys(testResult.fields ?? {}).length}
                <p class="blockTitle mt">{t('editor.testFields')}</p>
                <pre class="out">{JSON.stringify(testResult.fields, null, 2)}</pre>
              {/if}
              <p class="blockTitle mt">{t('editor.testBody')}</p>
              <pre class="out">{JSON.stringify(testResult.body, null, 2)}</pre>
            {/if}
          </div>
        {/if}
      {:else if step === 2}
        <div class="two">
          <label class="field">
            <span>{t('editor.provider')}</span>
            <select bind:value={provider}>
              <option value="">{t('ops.defaultProvider')}</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="gpt">GPT</option>
            </select>
          </label>
          <label class="field"><span>max_tokens</span><input type="number" bind:value={maxTokens} /></label>
        </div>

        <label class="field"><span>{t('editor.system')}</span><textarea bind:value={systemPrompt} rows="3"></textarea></label>
        <label class="field">
          <span>{t('editor.userTemplate')}</span>
          <textarea bind:value={userTemplate} rows="3" placeholder={'제목: {{title}}'}></textarea>
        </label>
        <label class="field">
          <span>{t('editor.schema')}</span>
          <textarea class="mono" bind:value={schemaText} rows="7" spellcheck="false"></textarea>
        </label>

        <details>
          <summary>{t('editor.validate')}</summary>
          <p class="hint">{t('editor.validateHint')}</p>
          <div class="two">
            <label class="field"><span>{t('editor.maxItems')}</span><input bind:value={maxItemsField} spellcheck="false" placeholder="items" /></label>
            <label class="field"><span>limit</span><input type="number" bind:value={maxItemsLimit} /></label>
          </div>
          <div class="two">
            <label class="field"><span>{t('editor.minConfidence')}</span><input bind:value={confidenceField} spellcheck="false" placeholder="confidence" /></label>
            <label class="field"><span>threshold</span><input type="number" step="0.05" min="0" max="1" bind:value={confidenceThreshold} /></label>
          </div>
        </details>
      {:else}
        <label class="field">
          <span>{t('editor.output')}</span>
          <select bind:value={outputKind}>
            <option value="none">{t('editor.output.none')}</option>
            <option value="http">{t('editor.output.http')}</option>
            <option value="pubsub">{t('editor.output.pubsub')}</option>
          </select>
        </label>
        {#if outputKind === 'http'}
          <div class="two">
            <label class="field"><span>method</span><select bind:value={outputMethod}><option>PATCH</option><option>POST</option><option>PUT</option></select></label>
            <label class="field wide"><span>URL</span><input bind:value={outputUrl} spellcheck="false" placeholder="https://api.example.com/records/&#123;&#123;id&#125;&#125;" /></label>
          </div>
          <label class="field">
            <span>{t('editor.body')}</span>
            <textarea bind:value={outputBody} rows="3" spellcheck="false" placeholder={'labels: {{items}}'}></textarea>
          </label>
        {:else if outputKind === 'pubsub'}
          <label class="field"><span>topic</span><input bind:value={outputTopic} spellcheck="false" placeholder="projects/p/topics/results" /></label>
        {:else}
          <p class="hint">{t('editor.output.noneHint')}</p>
        {/if}
      {/if}

      {#each issuesFor(step) as issue}
        <p class="issue"><code>{issue.path}</code> {issue.message}</p>
      {/each}
    </div>

    <div class="actions">
      {#if issues.length > 0 && issuesFor(step).length === 0}
        <span class="elsewhere">{t('editor.elsewhere')}</span>
      {/if}
      <span class="spacer"></span>
      <button class="ghost" onclick={onclose}>{t('editor.cancel')}</button>
      {#if step > 0}<button class="ghost" onclick={() => (step -= 1)}>{t('editor.back')}</button>{/if}
      {#if step < LAST}
        <Button onclick={() => (step += 1)}>{t('editor.next')}</Button>
      {:else}
        <Button class="primary" onclick={save} disabled={saving}>{t('editor.save')}</Button>
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    width: 640px;
    max-height: 82vh;
    display: flex;
    flex-direction: column;
  }
  h2 {
    font-size: 15px;
    margin: 0 0 12px;
  }
  .steps {
    display: flex;
    gap: 6px;
    margin-bottom: 14px;
  }
  .tab {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 7px;
    justify-content: center;
    padding: 7px 10px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
  }
  .tab.on {
    border-color: var(--accent);
    color: var(--text);
  }
  .tab.bad {
    border-color: var(--red, #f85149);
    color: var(--red, #f85149);
  }
  .num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--surface-2);
    font-size: 10px;
  }
  .body {
    flex: 1;
    overflow: auto;
    padding-right: 4px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 10px;
  }
  .field input,
  .field select,
  .field textarea {
    width: 100%;
    box-sizing: border-box;
  }
  .mono {
    font-family: var(--mono, ui-monospace, Menlo, monospace);
    font-size: 12px;
  }
  .field small {
    color: var(--text-dim);
    font-size: 11px;
    opacity: 0.85;
  }
  /* The schedule picker. Its own block so the tabs, the selects and the cron it builds
     read as one control rather than four stacked fields. */
  .sched {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    margin-bottom: 10px;
  }
  .sched .tabs {
    display: flex;
    gap: 6px;
    margin-bottom: 12px;
  }
  .sched .row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: flex-start;
  }
  .sched .row .field {
    flex: 1;
    min-width: 110px;
  }
  .sched .row .narrow {
    flex: 0 0 84px;
    min-width: 0;
  }
  /* A named group inside a step — headers, then the credential. Without the box they
     read as more loose fields in a list of loose fields. */
  .block {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
    margin-bottom: 10px;
  }
  .blockTitle {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--text);
  }
  .block .row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    margin-bottom: 8px;
  }
  .block .row input {
    flex: 1;
    min-width: 0;
  }
  .block .row .field {
    flex: 1;
    margin-bottom: 0;
  }
  .block .row .narrow {
    flex: 0 0 130px;
  }
  .hname {
    flex: 0 0 180px !important;
  }
  .plus,
  .minus {
    padding: 5px 10px;
    font-size: 12px;
    flex-shrink: 0;
  }
  .mt {
    margin-top: 12px;
  }
  .out {
    margin: 0;
    max-height: 220px;
    overflow: auto;
    padding: 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: var(--mono, ui-monospace, Menlo, monospace);
    font-size: 11px;
    color: var(--text);
    white-space: pre;
  }
  .testErr {
    margin: 10px 0 0;
    font-size: 12px;
    color: var(--red, #f85149);
  }
  .saved {
    margin-left: 6px;
    color: var(--accent);
    font-size: 11px;
  }
  .built {
    margin: 4px 0 12px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .built code {
    color: var(--text);
    background: var(--surface-2);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .two {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 10px;
  }
  .two .wide {
    grid-column: auto;
  }
  details {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
    margin-bottom: 10px;
  }
  summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--text-dim);
  }
  details[open] summary {
    margin-bottom: 10px;
  }
  .hint {
    color: var(--text-dim);
    font-size: 12px;
    margin: 0 0 10px;
  }
  .issue {
    color: var(--red, #f85149);
    font-size: 12px;
    margin: 6px 0 0;
  }
  .issue code {
    font-family: var(--mono, ui-monospace, Menlo, monospace);
    margin-right: 6px;
  }
  .elsewhere {
    color: var(--red, #f85149);
    font-size: 12px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .spacer {
    flex: 1;
  }
</style>
