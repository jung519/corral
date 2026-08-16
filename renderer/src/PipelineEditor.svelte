<script lang="ts">
  /**
   * Building a pipeline without writing YAML.
   *
   * Three steps, matching the three questions a pipeline answers: where does work arrive,
   * what should the model do with it, and where does the answer go.
   *
   * **Fetching the input is folded into step one, not given its own.** It is part of
   * "where does work arrive" — a queue that carries an identifier and a call that turns it
   * into a record are the same thought. A fourth step would make the shape of a pipeline
   * look more complicated than it is (D22).
   *
   * Nothing here validates the definition itself. The core does that on save and answers
   * with dotted field paths, which this maps back to the step that owns them — one
   * definition of what is valid, in the place that has to load it.
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
  let cron = $state('0 3 * * *');
  let topic = $state('');
  let subscription = $state('');

  let inputKind = $state<'none' | 'http'>('none');
  let inputUrl = $state('');
  let inputMethod = $state<'GET' | 'POST'>('GET');
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

  const STEPS = [t('editor.step1'), t('editor.step2'), t('editor.step3')];

  /** Which step owns a field path, so a save failure lands where the field is. */
  function stepOf(path: string): number {
    if (path.startsWith('agent')) return 1;
    if (path.startsWith('output') || path.startsWith('on_low_confidence')) return 2;
    return 0; // key, description, trigger, input
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
        ? { kind: 'schedule', cron }
        : triggerKind === 'pubsub'
          ? { kind: 'pubsub', topic, subscription }
          : { kind: 'manual' };

    const select = parsePairs(selectText);
    const require = requireText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const input =
      inputKind === 'http'
        ? { kind: 'http', request: { method: inputMethod, url: inputUrl }, select, require }
        : { kind: 'none', select, require };

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
      const result = await api.savePipeline(buildDefinition());
      if (result.ok) {
        onsaved(key);
        return;
      }
      issues = result.issues ?? [];
      // Land on the first step that has something wrong, so the fix is on screen.
      const first = [0, 1, 2].find((i) => issuesFor(i).length > 0);
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
        <label class="field"><span>{t('editor.key')}</span><input bind:value={key} placeholder="classify-record" spellcheck="false" /></label>
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
          <label class="field"><span>cron</span><input bind:value={cron} spellcheck="false" /></label>
        {:else if triggerKind === 'pubsub'}
          <label class="field"><span>topic</span><input bind:value={topic} spellcheck="false" /></label>
          <label class="field"><span>subscription</span><input bind:value={subscription} spellcheck="false" placeholder="projects/p/subscriptions/s" /></label>
        {/if}

        <!-- Folded in rather than given its own step: fetching the record is part of
             "where does work arrive", not a separate stage of the pipeline. -->
        <details open={inputKind === 'http'}>
          <summary>{t('editor.input')}</summary>
          <label class="field">
            <span>{t('editor.input.kind')}</span>
            <select bind:value={inputKind}>
              <option value="none">{t('editor.input.none')}</option>
              <option value="http">{t('editor.input.http')}</option>
            </select>
          </label>
          {#if inputKind === 'http'}
            <div class="two">
              <label class="field"><span>method</span><select bind:value={inputMethod}><option>GET</option><option>POST</option></select></label>
              <label class="field wide"><span>URL</span><input bind:value={inputUrl} spellcheck="false" placeholder="https://api.example.com/records/&#123;&#123;id&#125;&#125;" /></label>
            </div>
          {/if}
          <label class="field">
            <span>{t('editor.select')}</span>
            <textarea bind:value={selectText} rows="3" spellcheck="false" placeholder={'title: data.title\ndetail: data.description'}></textarea>
          </label>
          <label class="field"><span>{t('editor.require')}</span><input bind:value={requireText} spellcheck="false" placeholder="title" /></label>
        </details>
      {:else if step === 1}
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
      {#if step < 2}
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
