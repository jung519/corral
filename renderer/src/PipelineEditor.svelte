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
  import { onMount } from 'svelte';
  import Button from './lib/Button.svelte';
  import * as api from './lib/api';
  import { t } from './lib/i18n.svelte';

  interface Props {
    onclose: () => void;
    onsaved: (key: string) => void;
    /**
     * A pipeline to open instead of a blank one.
     *
     * The definition is fetched here rather than passed in, so the caller only has to know
     * a key — and so what is loaded is what the runtime is actually holding.
     */
    editing?: string;
  }
  let { onclose, onsaved, editing }: Props = $props();

  /**
   * The definition as it was opened, or undefined when creating.
   *
   * Kept for two jobs. It tells save to overwrite rather than refuse, and it holds the
   * parts of a request this editor has no field for — see `carriedOver`.
   */
  /**
   * `raw` rather than deep-reactive, and that is load-bearing rather than a nicety. A
   * `$state` proxy cannot be structured-cloned, and this object's leaves travel back out
   * through the IPC bridge on save — with a plain `$state` the save failed with "an object
   * could not be cloned" and no issue to show for it. Nothing here is ever mutated either;
   * it is a record of what was opened.
   */
  let original = $state.raw<Record<string, unknown> | undefined>(undefined);
  /** Why an existing definition could not be opened, if so. */
  let blocked = $state('');

  let step = $state(0);
  let saving = $state(false);
  let issues = $state<api.SaveIssue[]>([]);

  // ── the definition being built ──────────────────────────────────────────────────
  let key = $state('');
  let description = $state('');
  /** Concurrent runs of THIS pipeline. Start at one and raise once you have measured. */
  let maxConcurrent = $state(1);

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

  // Headers for everything that is not authentication — `Accept`, a tenant id, a request
  // id. Authentication has its own box below, because a secret typed here would be written
  // into the pipeline file in plain text and this is the only place a user could put one
  // (CRL-82).
  let inputHeaders = $state<Array<{ name: string; value: string }>>([]);

  /**
   * How a request authenticates: a named secret in the store, and where it goes on the
   * wire. The definition carries the *name*; the value goes to the store the wizard
   * already uses — the OS keychain locally, the core's 0600 file when the core is
   * elsewhere. `value` is only ever what someone just typed; it is cleared after a save
   * and never read back out of the store.
   *
   * One per block, not one shared: a pipeline that reads from one API and writes to
   * another authenticates twice, with two different secrets.
   */
  interface HttpAuth {
    service: string;
    account: string;
    value: string;
    saved: boolean;
    header: string;
    prefix: string;
  }
  const AUTH_HEADER = 'authorization';
  const AUTH_PREFIX = 'Bearer ';
  function newAuth(): HttpAuth {
    return { service: '', account: 'default', value: '', saved: false, header: AUTH_HEADER, prefix: AUTH_PREFIX };
  }
  let inputAuth = $state<HttpAuth>(newAuth());
  let outputAuth = $state<HttpAuth>(newAuth());

  const hasBridge = typeof window !== 'undefined' && !!window.corral;

  function addHeader(): void {
    inputHeaders = [...inputHeaders, { name: '', value: '' }];
  }
  function removeHeader(i: number): void {
    inputHeaders = inputHeaders.filter((_, j) => j !== i);
  }

  // ── trying the fetch before saving ────────────────────────────────────────────────
  let sampleEvent = $state('{ "id": "1" }');
  /** Which slot is in flight, '' for none. */
  let testing = $state('');
  interface FetchResult {
    ok: boolean;
    error?: string;
    body?: unknown;
    fields?: Record<string, unknown>;
    missing?: string[];
    selectError?: string;
  }
  let results = $state<Record<string, FetchResult | null>>({});
  const testResult = $derived(results.input ?? null);

  /**
   * Try one fetch and keep its answer under `slot`.
   *
   * Keyed rather than single, because a step can declare several lists now and each of them
   * is a separate guess to prove. The input fetch keeps the slot it always had (`input`).
   */
  async function tryFetch(slot: string, request: Record<string, unknown>, select: Record<string, string>): Promise<void> {
    testing = slot;
    results = { ...results, [slot]: null };
    try {
      let event: unknown = {};
      try {
        event = JSON.parse(sampleEvent || '{}');
      } catch {
        results = { ...results, [slot]: { ok: false, error: t('editor.testBadEvent') } };
        return;
      }
      results = { ...results, [slot]: await api.testFetch(request, event, select) };
    } catch (err) {
      results = { ...results, [slot]: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    } finally {
      testing = '';
    }
  }

  const testFetch = (): Promise<void> => tryFetch('input', inputRequest(), parsePairs(selectText));

  /**
   * Bring an answer into view the moment it is rendered.
   *
   * The trial buttons sit at the bottom of a body taller than the window, so an answer
   * drawn below them lands off-screen and the button reads as broken — pressed, nothing
   * happened. It cost a verification run's worth of digging to find out the fetch had
   * been working all along (CRL-75).
   *
   * `nearest` rather than `center`: if the answer already fits, nothing moves. Attached
   * rather than called after the fetch, because the element does not exist until Svelte
   * has drawn it.
   */
  function reveal(el: HTMLElement): void {
    el.scrollIntoView({ block: 'nearest' });
  }

  /** A context row's fetch, described the same way the input's is. */
  function contextRequest(row: { url: string }): Record<string, unknown> {
    return { method: 'GET', url: row.url, headers: {}, timeout_ms: inputTimeout };
  }

  /**
   * The row's own path, as a `select` map the trial can run.
   *
   * Keyed by the row's name so "found nothing" names the list the way the person writing
   * it does. An empty path is not a path: the response itself is then the list, and
   * asking for `{}` back is how the trial says so.
   */
  function contextSelect(row: { name: string; select: string }): Record<string, string> {
    const path = row.select.trim();
    return path ? { [row.name.trim()]: path } : {};
  }

  /**
   * What a run would say about this list, or '' if it would accept it.
   *
   * The trial fetches through the same code the pipeline uses, but the pipeline asks one
   * more thing of the answer than a fetch does: `ContextStore.list` refuses anything that
   * is not an array. Checking it here is the difference between "your path is wrong" now
   * and a run that ends `agent_failed` at 3am (CRL-71).
   */
  function listComplaint(row: { name: string; select: string }, r: FetchResult): string {
    const path = row.select.trim();
    // No path: the body IS the list, so the body is what has to be one.
    const picked = path ? r.fields?.[row.name.trim()] : r.body;
    if (path && picked === undefined) return t('editor.contextPathEmpty');
    return Array.isArray(picked) ? '' : t('editor.contextNotList');
  }

  /** Whether a ref already holds a secret, so an operator knows not to retype it. */
  async function secretExists(service: string, account: string): Promise<boolean> {
    if (!hasBridge || !service.trim()) return false;
    try {
      return await window.corral!.secret.has(service.trim(), account.trim() || 'default');
    } catch {
      return false;
    }
  }

  async function refreshPubCredSaved(): Promise<void> {
    pubCredSaved = await secretExists(pubCredService, pubCredAccount);
  }

  /** Read one request's credential + auth placement into editor state. */
  function loadAuth(request: Record<string, unknown>): HttpAuth {
    const a = newAuth();
    const cred = obj(request.credential);
    if (cred.service) {
      a.service = String(cred.service);
      a.account = String(cred.account ?? 'default');
    }
    const auth = obj(request.auth);
    if (auth.header !== undefined) a.header = String(auth.header);
    if (auth.prefix !== undefined) a.prefix = String(auth.prefix);
    return a;
  }

  async function refreshAuthSaved(a: HttpAuth): Promise<void> {
    a.saved = await secretExists(a.service, a.account);
  }

  /**
   * The credential + auth leaves of a request, or nothing.
   *
   * `auth` is written only when it differs from the default. Most APIs want
   * `Authorization: Bearer`, and a file that repeats the default everywhere is a file
   * where the one line that matters does not stand out.
   */
  function authFields(a: HttpAuth): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!a.service.trim()) return out;
    out.credential = { service: a.service.trim(), account: a.account.trim() || 'default' };
    if (a.header.trim().toLowerCase() !== AUTH_HEADER || a.prefix !== AUTH_PREFIX) {
      out.auth = { header: a.header.trim() || AUTH_HEADER, prefix: a.prefix };
    }
    return out;
  }

  /** A secret typed into the auth box goes to the store — never into the definition. */
  async function persistAuth(a: HttpAuth): Promise<void> {
    if (!hasBridge || !a.service.trim() || !a.value) return;
    await window.corral!.secret.set(a.service.trim(), a.account.trim() || 'default', a.value);
    a.value = '';
    await refreshAuthSaved(a);
  }

  let selectText = $state('');
  let requireText = $state('');
  let inputTimeout = $state(15000);
  // The redelivery guard (D6). A queue redelivers, and a redelivery must not cost a second
  // model turn or overwrite an answer that was already good.
  let skipField = $state('');
  let skipIs = $state<'non_empty' | 'empty'>('non_empty');

  // Only what this core can actually ask — a provider on the `cli` transport or without a
  // key is not offered, because picking one would build a pipeline whose model step can
  // never run. The list comes from the core, not from a table in the window.
  let agents = $state<Array<{ provider: string; models: string[]; defaultModel?: string }>>([]);
  let provider = $state('');
  let model = $state('');
  let maxTokens = $state(4096);

  const chosenAgent = $derived(agents.find((a) => a.provider === provider));
  /** Models the config named for the chosen provider. */
  const models = $derived(chosenAgent?.models ?? []);

  onMount(async () => {
    try {
      const r = await api.getOpsAgents();
      agents = r.agents ?? [];
      if (agents.length === 1) provider = agents[0]!.provider;
    } catch {
      agents = [];
    }
    if (editing) await open(editing);
  });

  /** Load an existing definition, or say why it cannot be shown here. */
  async function open(pipelineKey: string): Promise<void> {
    let r: Awaited<ReturnType<typeof api.getDefinition>>;
    try {
      r = await api.getDefinition(pipelineKey);
    } catch (err) {
      blocked = `${t('editor.loadFailed')} ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    if (!r.ok || !r.definition) {
      blocked = `${t('editor.loadFailed')} ${r.error ?? pipelineKey}`;
      return;
    }
    const cannot = unrepresentable(r.definition);
    if (cannot) {
      blocked = `${t('editor.cannotOpen')} ${cannot}`;
      return;
    }
    load(r.definition);
    // Set last: it is what makes save an overwrite, so nothing is armed until the boxes
    // actually hold the definition.
    original = r.definition;
  }

  // Changing the provider invalidates a model that belonged to the previous one.
  $effect(() => {
    if (model && !models.includes(model)) model = '';
  });
  let systemPrompt = $state('');
  let userTemplate = $state('');
  // `confidence` is here because the checks below offer a confidence rule, and a rule
  // naming a field the schema does not declare is refused at load — the defaults have to
  // agree with each other or the first save fails on the editor's own suggestions.
  let schemaText = $state(
    '{\n  "type": "object",\n  "properties": {\n    "items": { "type": "array" },\n    "confidence": { "type": "number" }\n  },\n  "required": ["items", "confidence"]\n}',
  );
  // The headline rule: values outside the list are dropped and recorded, never sent on.
  // The list is either written here or fetched, because a vocabulary that changes daily
  // should not mean editing the pipeline.
  /**
   * Material the prompt needs, fetched before the turn.
   *
   * Declared above the prompt rather than below it: you name a list, then write the sentence
   * that uses it, and reading the screen top to bottom is the same order.
   */
  let contextRows = $state<Array<{ name: string; url: string; select: string }>>([]);

  function addContext(): void {
    contextRows = [...contextRows, { name: '', url: '', select: '' }];
  }

  function removeContext(i: number): void {
    contextRows = contextRows.filter((_, j) => j !== i);
    // A tab pointing at a list that no longer exists would save a `from` the loader
    // refuses, so the choice goes back to the one that is always available.
    if (!namedContexts().length) allowedFrom = 'inline';
  }

  /** Rows complete enough to be referred to by name. */
  function namedContexts(): string[] {
    return contextRows.filter((r) => r.name.trim() && r.url.trim()).map((r) => r.name.trim());
  }

  let allowedField = $state('');
  let allowedFrom = $state<'inline' | 'source' | 'context'>('inline');
  let allowedFromName = $state('');
  let allowedValues = $state('');
  let allowedUrl = $state('');
  let allowedSelect = $state('');
  let maxItemsField = $state('');
  let maxItemsLimit = $state(4);
  let confidenceField = $state('');
  let confidenceThreshold = $state(0.7);

  let outputKind = $state<'none' | 'http' | 'pubsub'>('none');
  let outputUrl = $state('');
  let outputMethod = $state<'POST' | 'PATCH' | 'PUT'>('PATCH');
  let outputBody = $state('');
  let outputTimeout = $state(15000);
  let outputHeaders = $state<Array<{ name: string; value: string }>>([]);
  let outputTopic = $state('');
  let outputMessage = $state('');
  let pubCredService = $state('');
  let pubCredAccount = $state('default');
  let pubCredValue = $state('');
  let pubCredSaved = $state(false);

  /** An auth header written by hand wins over the credential (the `??=` in http.ts), and
   *  does it silently — so say so where both boxes are visible. Declared here because it
   *  reads both header lists, which are state declared above. */
  const inputAuthShadowed = $derived(
    !!inputAuth.service.trim() && inputHeaders.some((h) => h.name.trim().toLowerCase() === inputAuth.header.trim().toLowerCase()),
  );
  const outputAuthShadowed = $derived(
    !!outputAuth.service.trim() && outputHeaders.some((h) => h.name.trim().toLowerCase() === outputAuth.header.trim().toLowerCase()),
  );

  /**
   * What happens to a doubtful answer (D14). `report` is the default because an answer the
   * checks distrusted, written into someone's system, is worse than no answer — but a hold
   * only helps if it says where a person can look, and until now nothing here set that.
   */
  let lowAction = $state<'report' | 'skip' | 'send'>('report');
  let reviewUrl = $state('');

  function addOutputHeader(): void {
    outputHeaders = [...outputHeaders, { name: '', value: '' }];
  }
  function removeOutputHeader(i: number): void {
    outputHeaders = outputHeaders.filter((_, j) => j !== i);
  }

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

  function headerMap(rows: Array<{ name: string; value: string }>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const h of rows) if (h.name.trim()) out[h.name.trim()] = h.value;
    return out;
  }

  /**
   * The fetch, built once.
   *
   * Both the trial and the saved definition come from here. Two places assembling the same
   * request is two places to drift, and the whole worth of the trial is that what was tried
   * is what will run.
   */
  /** A record, or an empty one — every block below is optional in some shape. */
  function obj(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  /** `{ name: 'path' }` back to the `name: path` lines the boxes hold. */
  function formatPairs(map: unknown): string {
    return Object.entries(obj(map))
      .map(([name, value]) => `${name}: ${String(value)}`)
      .join('\n');
  }

  function headerRows(map: unknown): Array<{ name: string; value: string }> {
    return Object.entries(obj(map)).map(([name, value]) => ({ name, value: String(value) }));
  }

  /**
   * Why this definition cannot be opened here, or '' if it can.
   *
   * The file format is wider than this editor. Every box holds a string, so a definition
   * using a shape a box cannot hold would come back flattened the moment it was saved —
   * a `truncate` silently gone, a GraphQL query turned into text, an inline vocabulary
   * dropped. Refusing to open is the only answer that cannot lose someone's work; the file
   * is still there to edit, which is what it was always for.
   *
   * Each message names the field, in the same dotted form the loader uses, so it reads
   * like the errors the core already sends back.
   */
  function unrepresentable(d: Record<string, unknown>): string {
    const bad: string[] = [];

    const input = obj(d.input);
    for (const [name, selector] of Object.entries(obj(input.select))) {
      // `{ path, truncate, limit }` — a cap this editor has no box for.
      if (typeof selector !== 'string') bad.push(`input.select.${name}`);
    }
    const request = obj(input.request);
    if (input.kind === 'http' && !['GET', 'POST'].includes(String(request.method))) {
      bad.push('input.request.method');
    }

    for (const [name, source] of Object.entries(obj(obj(d.agent).context))) {
      const c = obj(source);
      // An inline list has no row to live in — the row is a name, a URL and a path.
      if (c.values) bad.push(`agent.context.${name}.values`);
      const from = obj(c.source);
      if (c.source && String(from.method) !== 'GET') bad.push(`agent.context.${name}.source.method`);
      if (Object.keys(obj(from.headers)).length) bad.push(`agent.context.${name}.source.headers`);
      if (from.body) bad.push(`agent.context.${name}.source.body`);
    }

    const output = obj(d.output);
    const outRequest = obj(output.request);
    if (output.kind === 'http' && !['POST', 'PATCH', 'PUT'].includes(String(outRequest.method))) {
      bad.push('output.request.method');
    }
    // The body and message boxes are `name: value` lines, so only flat text survives them.
    for (const [where, map] of [
      ['output.request.body', outRequest.body],
      ['output.message', output.message],
    ] as const) {
      for (const [name, value] of Object.entries(obj(map))) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          bad.push(`${where}.${name}`);
        }
      }
    }

    return bad.join(', ');
  }

  /**
   * Fill every box from a definition the core handed over.
   *
   * The mirror of `buildDefinition`, and it has to stay one: a field this misses is a field
   * that silently reverts to the editor's default when someone presses save. `unrepresentable`
   * above is what keeps "misses" from meaning "loses".
   *
   * A schedule opens in the typed box rather than the picker. The file holds a cron
   * expression, and any expression can be shown that way — reading one back into "every
   * week, Tuesday, 09:00" only works for the few shapes the picker can make, and guessing
   * wrong would rewrite somebody's schedule.
   */
  function load(d: Record<string, unknown>): void {
    key = String(d.key ?? '');
    description = String(d.description ?? '');
    maxConcurrent = Number(d.max_concurrent ?? 1);

    const trigger = obj(d.trigger);
    triggerKind = trigger.kind === 'schedule' || trigger.kind === 'pubsub' ? trigger.kind : 'manual';
    if (trigger.kind === 'schedule') {
      cronMode = 'manual';
      cron = String(trigger.cron ?? '');
      timezone = String(trigger.timezone ?? localZone());
    } else if (trigger.kind === 'pubsub') {
      topic = String(trigger.topic ?? '');
      subscription = String(trigger.subscription ?? '');
      loadCredential(trigger.credential);
    }

    const input = obj(d.input);
    inputKind = input.kind === 'http' ? 'http' : 'none';
    selectText = formatPairs(input.select);
    requireText = (Array.isArray(input.require) ? input.require : []).join(', ');
    const skip = obj(input.skip_if);
    skipField = String(skip.field ?? '');
    skipIs = skip.is === 'empty' ? 'empty' : 'non_empty';
    if (input.kind === 'http') {
      const request = obj(input.request);
      inputMethod = request.method === 'POST' ? 'POST' : 'GET';
      inputUrl = String(request.url ?? '');
      inputHeaders = headerRows(request.headers);
      inputTimeout = Number(request.timeout_ms ?? 15000);
      inputAuth = loadAuth(request);
      void refreshAuthSaved(inputAuth);
    }

    const agent = obj(d.agent);
    provider = String(agent.provider ?? '');
    model = String(agent.model ?? '');
    maxTokens = Number(agent.max_tokens ?? 4096);
    const prompt = obj(agent.prompt);
    systemPrompt = String(prompt.system ?? '');
    userTemplate = String(prompt.user_template ?? '');
    schemaText = JSON.stringify(agent.schema ?? {}, null, 2);
    contextRows = Object.entries(obj(agent.context)).map(([name, source]) => ({
      name,
      url: String(obj(obj(source).source).url ?? ''),
      select: String(obj(source).select ?? ''),
    }));

    const validate = obj(agent.validate);
    const allowed = obj(validate.allowed_values);
    allowedField = String(allowed.field ?? '');
    // Which of the three the file used decides the tab, so the one that is filled in is
    // the one shown — the schema already refuses more than one.
    allowedFrom = allowed.from ? 'context' : allowed.source ? 'source' : 'inline';
    allowedFromName = String(allowed.from ?? '');
    allowedValues = (Array.isArray(allowed.values) ? allowed.values : []).join(', ');
    allowedUrl = String(obj(allowed.source).url ?? '');
    allowedSelect = String(allowed.select ?? '');
    const maxItems = obj(validate.max_items);
    maxItemsField = String(maxItems.field ?? '');
    if (maxItems.limit) maxItemsLimit = Number(maxItems.limit);
    const confidence = obj(validate.min_confidence);
    confidenceField = String(confidence.field ?? '');
    if (confidence.threshold !== undefined) confidenceThreshold = Number(confidence.threshold);

    const output = obj(d.output);
    outputKind = output.kind === 'http' || output.kind === 'pubsub' ? output.kind : 'none';
    if (output.kind === 'http') {
      const request = obj(output.request);
      outputMethod = request.method === 'POST' ? 'POST' : request.method === 'PUT' ? 'PUT' : 'PATCH';
      outputUrl = String(request.url ?? '');
      outputHeaders = headerRows(request.headers);
      outputBody = formatPairs(request.body);
      outputTimeout = Number(request.timeout_ms ?? 15000);
      outputAuth = loadAuth(request);
      void refreshAuthSaved(outputAuth);
    } else if (output.kind === 'pubsub') {
      outputTopic = String(output.topic ?? '');
      outputMessage = formatPairs(output.message);
      loadCredential(output.credential);
    }

    const low = obj(d.on_low_confidence);
    lowAction = low.action === 'skip' || low.action === 'send' ? low.action : 'report';
    reviewUrl = String(low.review_url ?? '');
  }

  /** A credential reference names a secret the store already holds; the value is not shown. */
  function loadCredential(ref: unknown): void {
    const c = obj(ref);
    if (!c.service) return;
    pubCredService = String(c.service);
    pubCredAccount = String(c.account ?? 'default');
    void refreshPubCredSaved();
  }

  /**
   * What the opened definition keeps that this editor has no field for.
   *
   * An input request can carry a body (a GraphQL query, per D7), which the editor does not
   * offer — and "not offered" must not mean "deleted", so it goes back out exactly as it
   * came in. `enabled` is the same: a pipeline turned off in its file must not come back on
   * because someone fixed a typo in its prompt.
   *
   * `credential` and `auth` used to be carried this way too. They are edited here now
   * (CRL-82), so carrying them would put a stale copy underneath the live one.
   */
  function carriedOver(block: 'input' | 'output'): Record<string, unknown> {
    const request = obj(obj(obj(original)[block]).request);
    const kept: Record<string, unknown> = {};
    if (request.body !== undefined) kept.body = request.body;
    return kept;
  }

  function inputRequest(): Record<string, unknown> {
    const request: Record<string, unknown> = {
      // What the editor does not own comes first, so the fields it does own win.
      ...carriedOver('input'),
      method: inputMethod,
      url: inputUrl,
      headers: headerMap(inputHeaders),
      ...authFields(inputAuth),
      timeout_ms: inputTimeout,
    };
    return request;
  }

  function buildDefinition(): Record<string, unknown> {
    const trigger =
      triggerKind === 'schedule'
        ? { kind: 'schedule', cron: cronToSave, timezone }
        : triggerKind === 'pubsub'
          ? {
              kind: 'pubsub',
              topic,
              subscription,
              // The same reference the output writes. Leaving it off is how a pipeline came
              // out subscribed to nothing: it saved, it loaded, the dashboard lit up, and
              // the loop stopped on its first line (CRL-46).
              credential: pubCredService.trim()
                ? { service: pubCredService.trim(), account: pubCredAccount.trim() || 'default' }
                : undefined,
            }
          : { kind: 'manual' };

    const select = parsePairs(selectText);
    const require = requireText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const request = inputRequest();
    const skip_if = skipField.trim() ? { field: skipField.trim(), is: skipIs } : undefined;
    const input =
      inputKind === 'http'
        ? { kind: 'http', request, select, require, skip_if }
        : { kind: 'none', select, require, skip_if };

    const context: Record<string, unknown> = {};
    for (const row of contextRows) {
      if (!row.name.trim() || !row.url.trim()) continue;
      context[row.name.trim()] = { source: { url: row.url.trim() }, select: row.select.trim() || undefined };
    }

    const validate: Record<string, unknown> = {};
    if (allowedField.trim()) {
      const field = allowedField.trim();
      validate.allowed_values =
        allowedFrom === 'context'
          ? { field, from: allowedFromName.trim() }
          : allowedFrom === 'inline'
            ? {
                field,
                values: allowedValues
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean),
              }
            : { field, source: { url: allowedUrl }, select: allowedSelect || undefined };
    }
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

    const outRequest: Record<string, unknown> = {
      ...carriedOver('output'),
      method: outputMethod,
      url: outputUrl,
      headers: headerMap(outputHeaders),
      ...authFields(outputAuth),
      body: parsePairs(outputBody),
      timeout_ms: outputTimeout,
    };
    const output =
      outputKind === 'http'
        ? { kind: 'http', request: outRequest }
        : outputKind === 'pubsub'
          ? {
              kind: 'pubsub',
              topic: outputTopic,
              message: parsePairs(outputMessage),
              credential: pubCredService.trim()
                ? { service: pubCredService.trim(), account: pubCredAccount.trim() || 'default' }
                : undefined,
            }
          : { kind: 'none' };

    return {
      key,
      // A pipeline turned off in its file stays off through an edit. The editor has no
      // switch for it — the list does — so it travels as it arrived.
      enabled: original ? original.enabled : undefined,
      description: description || undefined,
      max_concurrent: maxConcurrent,
      trigger,
      input,
      agent: {
        context: Object.keys(context).length ? context : undefined,
        provider: provider || undefined,
        model: model.trim() || undefined,
        max_tokens: maxTokens,
        prompt: { system: systemPrompt, user_template: userTemplate },
        schema,
        validate,
      },
      output,
      on_low_confidence: { action: lowAction, review_url: reviewUrl.trim() || undefined },
    };
  }

  async function save() {
    saving = true;
    issues = [];
    try {
      // Before the definition, and to a different place: the file gets the reference, the
      // store gets the secret. Typing it again is only needed to change it.
      // Pub/Sub is the one that cannot be a header: it wants a service-account JSON key
      // that gets signed into a JWT, so the value goes to the store.
      if (hasBridge && pubCredService.trim() && pubCredValue) {
        await window.corral!.secret.set(pubCredService.trim(), pubCredAccount.trim() || 'default', pubCredValue);
        pubCredValue = '';
        await refreshPubCredSaved();
      }
      // The same split for the HTTP steps: the store gets the secret, the file gets the name.
      if (inputKind === 'http') await persistAuth(inputAuth);
      if (outputKind === 'http') await persistAuth(outputAuth);
      // Overwrite only when editing. Creating still refuses to land on an existing key —
      // that check is what stops a new pipeline from replacing one that is running.
      const result = await api.savePipeline(buildDefinition(), !!original);
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

<!--
  The Google credential, in the one shape it takes.

  Written once and used from both the trigger step and the output step, bound to the same
  state either way. A pipeline that subscribes and publishes does both with one service
  account, so asking twice would be asking the same question twice — and two copies of this
  markup would be one place to fix a problem and one place to forget (CRL-46).
-->
{#snippet pubsubCredential()}
  <div class="block">
    <p class="blockTitle">{t('editor.credential')}</p>
    <p class="hint">{t('editor.credentialHint')}</p>
    <div class="row">
      <label class="field"
        ><span>{t('editor.credService')}</span>
        <input bind:value={pubCredService} spellcheck="false" placeholder="gcp" onblur={refreshPubCredSaved} /></label
      >
      <label class="field narrow"
        ><span>{t('editor.credAccount')}</span>
        <input bind:value={pubCredAccount} spellcheck="false" placeholder="default" onblur={refreshPubCredSaved} /></label
      >
    </div>
    {#if pubCredService.trim()}
      <label class="field">
        <span>{t('editor.credValue')}{#if pubCredSaved}<span class="saved">{t('editor.credSaved')}</span>{/if}</span>
        <textarea bind:value={pubCredValue} rows="2" spellcheck="false" placeholder={pubCredSaved ? '••••••••' : t('editor.credPubPlaceholder')}></textarea>
      </label>
    {/if}
  </div>
{/snippet}

<!--
  How an HTTP step authenticates.

  Same split as the Pub/Sub box above and for the same reason: the **name** goes in the
  file, the **value** goes to the store. Before this, the only place a user could put an
  API secret was the header box, which writes it into the pipeline definition in plain
  text — while the runtime and the schema both say a definition never holds one (CRL-82).

  The placement fields are here because "Bearer in Authorization" is a convention, not a
  rule; an internal API asking for `X-API-Key` should not send anybody back to the file.
-->
{#snippet httpAuth(a: HttpAuth, shadowed: boolean)}
  <div class="block">
    <p class="blockTitle">{t('editor.auth')}</p>
    <p class="hint">{t('editor.authHint')}</p>
    <div class="row">
      <label class="field"
        ><span>{t('editor.credService')}</span>
        <input bind:value={a.service} spellcheck="false" placeholder="my-api" onblur={() => refreshAuthSaved(a)} /></label
      >
      <label class="field narrow"
        ><span>{t('editor.credAccount')}</span>
        <input bind:value={a.account} spellcheck="false" placeholder="default" onblur={() => refreshAuthSaved(a)} /></label
      >
    </div>
    {#if a.service.trim()}
      <label class="field">
        <span>{t('editor.credValue')}{#if a.saved}<span class="saved">{t('editor.credSaved')}</span>{/if}</span>
        <input type="password" bind:value={a.value} spellcheck="false" placeholder={a.saved ? '••••••••' : t('editor.authValuePlaceholder')} />
      </label>
      <div class="row">
        <label class="field"
          ><span>{t('editor.authHeader')}</span>
          <input bind:value={a.header} spellcheck="false" placeholder="authorization" /></label
        >
        <label class="field narrow"
          ><span>{t('editor.authPrefix')}</span>
          <input bind:value={a.prefix} spellcheck="false" placeholder="Bearer " /></label
        >
      </div>
      <p class="hint">{t('editor.authPlacementHint')}</p>
      {#if shadowed}<p class="hint warn">{t('editor.authShadowed')}</p>{/if}
    {/if}
  </div>
{/snippet}


<div
  class="overlay"
  role="presentation"
  onclick={onclose}
  onkeydown={(e) => {
    if (e.key === 'Escape') onclose();
  }}
>
  <div class="modal" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <h2>{original || editing ? t('editor.editTitle') : t('editor.title')}</h2>

    {#if !blocked}
      <div class="steps">
        {#each STEPS as label, i}
          <button class="tab" class:on={step === i} class:bad={issuesFor(i).length > 0} onclick={() => (step = i)}>
            <span class="num">{i + 1}</span>{label}
          </button>
        {/each}
      </div>
    {/if}

    <div class="body">
      {#if blocked}
        <!-- Nothing is filled in, so nothing can be saved over: the boxes stay empty and
             `original` stays unset, which leaves the save button building a new pipeline
             rather than replacing the one that could not be shown. -->
        <p class="testErr">{blocked}</p>
      {:else if step === 0}
        <label class="field">
          <span>{t('editor.key')}</span>
          <!-- Read-only while editing. The key is what history, the file name and past runs
               are filed under; changing it here would leave the runs behind under a name
               nothing answers to any more, and write a second file besides. Renaming is a
               thing to do to the file, deliberately, not a side effect of fixing a prompt. -->
          <input bind:value={key} placeholder="classify-record" spellcheck="false" readonly={!!original} />
          <!-- It is an identifier, not a title: it becomes the file name, the history key
               and the URL. Saying so beats being refused on save. -->
          <small>{original ? t('editor.keyFixed') : t('editor.keyHint')}</small>
        </label>
        <label class="field"><span>{t('editor.description')}</span><input bind:value={description} /></label>
        <label class="field narrow">
          <span>{t('editor.maxConcurrent')}</span>
          <input type="number" bind:value={maxConcurrent} min="1" />
          <small>{t('editor.maxConcurrentHint')}</small>
        </label>

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
          {@render pubsubCredential()}
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
          <label class="field narrow"><span>{t('editor.timeout')}</span><input type="number" bind:value={inputTimeout} min="1" /></label>

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
          {@render httpAuth(inputAuth, inputAuthShadowed)}

        {:else}
          <p class="hint">{t('editor.input.noneHint')}</p>
        {/if}
        <label class="field">
          <!-- Same field, two sources: with `http` it reads the response, without it the
               event body. One name for both would be wrong half the time. -->
          <span>{t(inputKind === 'http' ? 'editor.selectHttp' : 'editor.selectNone')}</span>
          <textarea bind:value={selectText} rows="3" spellcheck="false" placeholder={'title: data.title\ndetail: data.description'}></textarea>
        </label>
        <label class="field"><span>{t('editor.require')}</span><input bind:value={requireText} spellcheck="false" placeholder="title" /></label>

        <!-- Not optional politeness: a queue redelivers, and without this the same record
             is processed twice — a second turn paid for, and a good answer overwritten. -->
        <div class="row">
          <label class="field"
            ><span>{t('editor.skipIf')}</span>
            <input bind:value={skipField} spellcheck="false" placeholder="data.labels" /></label
          >
          <label class="field narrow"
            ><span>{t('editor.skipIs')}</span>
            <select bind:value={skipIs}>
              <option value="non_empty">{t('editor.skipIs.nonEmpty')}</option>
              <option value="empty">{t('editor.skipIs.empty')}</option>
            </select></label
          >
        </div>
        <p class="hint">{t('editor.skipIfHint')}</p>

        {#if inputKind === 'http'}
          <!-- Paths are guesses until something proves them, and the only proof available
               today costs a model turn. This is the half that doesn't. -->
          <div class="block">
            <p class="blockTitle">{t('editor.test')}</p>
            <label class="field"
              ><span>{t('editor.testEvent')}</span>
              <input class="mono" bind:value={sampleEvent} spellcheck="false" /></label
            >
            <button class="plus" onclick={testFetch} disabled={!!testing || !inputUrl.trim()}>
              {testing === 'input' ? t('editor.testing') : t('editor.testRun')}
            </button>

            {#if testResult && !testResult.ok}
              <p class="testErr" {@attach reveal}>{testResult.error}</p>
            {:else if testResult}
              <div {@attach reveal}>
              {#if testResult.selectError}
                <p class="testErr">{t('editor.testSelectBad')} {testResult.selectError}</p>
              {/if}
              <!-- Shown even when nothing came out. An absent block was the symptom: a
                   mistyped path produced no fields, so the section vanished and left the
                   response to be compared by eye. -->
              {#if !testResult.selectError && (Object.keys(testResult.fields ?? {}).length || testResult.missing?.length)}
                <p class="blockTitle mt">{t('editor.testFields')}</p>
                <pre class="out">{JSON.stringify(testResult.fields, null, 2)}</pre>
                {#if testResult.missing?.length}
                  <p class="testNote">{t('editor.testMissing')} {testResult.missing.join(', ')}</p>
                {/if}
              {/if}
              <p class="blockTitle mt">{t('editor.testBody')}</p>
              <pre class="out">{JSON.stringify(testResult.body, null, 2)}</pre>
              </div>
            {/if}
          </div>
        {/if}
      {:else if step === 2}
        {#if agents.length === 0}
          <p class="testErr">{t('editor.noAgents')}</p>
        {/if}
        <div class="two">
          <label class="field">
            <span>{t('editor.provider')}</span>
            <select bind:value={provider} disabled={agents.length === 0}>
              <option value="">{t('ops.defaultProvider')}</option>
              {#each agents as a}<option value={a.provider}>{a.provider}</option>{/each}
            </select>
          </label>
          <label class="field">
            <span>{t('editor.model')}</span>
            <select bind:value={model} disabled={!provider || models.length === 0}>
              <option value="">{chosenAgent?.defaultModel ? `${t('editor.modelDefault')} (${chosenAgent.defaultModel})` : t('editor.modelDefault')}</option>
              {#each models as m}<option value={m}>{m}</option>{/each}
            </select>
          </label>
        </div>
        <label class="field narrow"><span>max_tokens</span><input type="number" bind:value={maxTokens} /></label>

        <!-- Above the prompt, because that is the order you write it in: name the list,
             then write the sentence that uses it. -->
        <div class="block">
          <p class="blockTitle">{t('editor.context')}</p>
          <p class="hint">{t('editor.contextHint')}</p>
          {#each contextRows as row, i}
            <div class="row">
              <label class="field"
                ><span>{t('editor.contextName')}</span>
                <input bind:value={row.name} spellcheck="false" placeholder="allowed" /></label
              >
              <label class="field"><span>URL</span><input bind:value={row.url} spellcheck="false" placeholder="https://api.example.com/vocabulary" /></label>
              <label class="field"
                ><span>{t('editor.allowedSelect')}</span>
                <input bind:value={row.select} spellcheck="false" placeholder="data.values" /></label
              >
              <button class="minus" onclick={() => removeContext(i)} aria-label={t('editor.contextRemove')}>−</button>
            </div>
            {#if row.name.trim() && row.url.trim()}
              <button
                class="plus"
                onclick={() => tryFetch(`context:${row.name.trim()}`, contextRequest(row), contextSelect(row))}
                disabled={!!testing}
              >
                {testing === `context:${row.name.trim()}` ? t('editor.testing') : t('editor.contextTest')}
              </button>
              {@const r = results[`context:${row.name.trim()}`]}
              {#if r && !r.ok}
                <p class="testErr">{r.error}</p>
              {:else if r}
                {@const complaint = listComplaint(row, r)}
                <div {@attach reveal}>
                  {#if row.select.trim()}
                    <!-- The path is the guess worth proving. The response is often nested
                         and long, and reading `majors[].minors[].key` off it by eye is not
                         checking it — which is what this button existed to do (CRL-71). -->
                    <p class="blockTitle mt">{t('editor.contextPicked')}</p>
                    <pre class="out">{JSON.stringify(r.fields?.[row.name.trim()], null, 2)}</pre>
                  {/if}
                  {#if complaint}<p class="testErr">{complaint}</p>{/if}
                  <!-- Kept even when the path worked: the list goes to the prompt as it
                       arrives, and the rest of the response is how you find the next path. -->
                  <p class="blockTitle mt">{t('editor.contextGot')}</p>
                  <pre class="out">{JSON.stringify(r.body, null, 2)}</pre>
                </div>
              {/if}
            {/if}
          {/each}
          <button class="plus" onclick={addContext}>{t('editor.contextAdd')}</button>
        </div>

        <!-- Both go to the model as one turn. "User" is the chat role, not the person
             using Corral — saying so here saves guessing at the label. -->
        <div class="block">
          <p class="blockTitle">{t('editor.prompts')}</p>
          <p class="hint">{t('editor.promptsHint')}</p>
          <label class="field"><span>{t('editor.system')}</span><textarea bind:value={systemPrompt} rows="3"></textarea></label>
          <label class="field">
            <span>{t('editor.userTemplate')}</span>
            <textarea bind:value={userTemplate} rows="3" placeholder={'제목: {{title}}'}></textarea>
          </label>
        </div>

        <label class="field">
          <span>{t('editor.schema')}</span>
          <textarea class="mono" bind:value={schemaText} rows="7" spellcheck="false"></textarea>
          <small>{t('editor.schemaHint')}</small>
        </label>

        <details>
          <summary>{t('editor.validate')}</summary>
          <p class="hint">{t('editor.validateHint')}</p>
          <div class="block">
            <p class="blockTitle">{t('editor.allowed')}</p>
            <div class="row">
              <label class="field"
                ><span>{t('editor.allowedField')}</span>
                <input bind:value={allowedField} spellcheck="false" placeholder="items" /></label
              >
            </div>
            {#if allowedField.trim()}
              <div class="tabs">
                <button class="tab" class:on={allowedFrom === 'inline'} onclick={() => (allowedFrom = 'inline')}>{t('editor.allowed.inline')}</button>
                <button class="tab" class:on={allowedFrom === 'source'} onclick={() => (allowedFrom = 'source')}>{t('editor.allowed.source')}</button>
                <!-- Offered only when there is something to point at. A `from` naming
                     nothing is refused at load, so the choice should not exist yet. -->
                {#if namedContexts().length}
                  <button class="tab" class:on={allowedFrom === 'context'} onclick={() => (allowedFrom = 'context')}>{t('editor.allowed.context')}</button>
                {/if}
              </div>
              {#if allowedFrom === 'context'}
                <label class="field"
                  ><span>{t('editor.allowedFromName')}</span>
                  <select bind:value={allowedFromName}>
                    <option value="">—</option>
                    {#each namedContexts() as name}<option value={name}>{name}</option>{/each}
                  </select>
                  <small>{t('editor.allowedFromHint')}</small></label
                >
              {:else if allowedFrom === 'inline'}
                <label class="field"
                  ><span>{t('editor.allowedValues')}</span>
                  <input bind:value={allowedValues} spellcheck="false" placeholder="news, sport, culture" /></label
                >
              {:else}
                <label class="field"><span>URL</span><input bind:value={allowedUrl} spellcheck="false" placeholder="https://api.example.com/vocabulary" /></label>
                <label class="field"
                  ><span>{t('editor.allowedSelect')}</span>
                  <input bind:value={allowedSelect} spellcheck="false" placeholder="data.values" /></label
                >
                <p class="hint">{t('editor.allowedSourceHint')}</p>
              {/if}
            {/if}
          </div>

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
          <label class="field narrow"><span>{t('editor.timeout')}</span><input type="number" bind:value={outputTimeout} min="1" /></label>

          <!-- Same as the fetch: headers for everything that is not authentication,
               and the auth box below for what is. This one writes, so if either side
               needs a key it is this one. -->
          <div class="block">
            <p class="blockTitle">{t('editor.headers')}</p>
            {#each outputHeaders as header, i}
              <div class="row">
                <input class="hname" bind:value={header.name} spellcheck="false" placeholder="x-tenant" />
                <input bind:value={header.value} spellcheck="false" placeholder="acme" />
                <button class="minus" onclick={() => removeOutputHeader(i)} aria-label={t('editor.headerRemove')}>−</button>
              </div>
            {/each}
            <button class="plus" onclick={addOutputHeader}>{t('editor.headerAdd')}</button>
            <p class="hint">{t('editor.headersHint')}</p>
          </div>
          {@render httpAuth(outputAuth, outputAuthShadowed)}
        {:else if outputKind === 'pubsub'}
          <label class="field"><span>topic</span><input bind:value={outputTopic} spellcheck="false" placeholder="projects/p/topics/results" /></label>
          <label class="field">
            <span>{t('editor.message')}</span>
            <textarea bind:value={outputMessage} rows="3" spellcheck="false" placeholder={'labels: {{items}}'}></textarea>
          </label>
          <p class="hint">{t('editor.messageHint')}</p>
          {@render pubsubCredential()}
        {:else}
          <p class="hint">{t('editor.output.noneHint')}</p>
        {/if}

        <!-- D14. The hold-back already worked; nothing here ever set the link, so a held
             run had nowhere to send a person. -->
        <div class="block">
          <p class="blockTitle">{t('editor.lowConfidence')}</p>
          <p class="hint">{t('editor.lowConfidenceHint')}</p>
          <label class="field">
            <span>{t('editor.lowAction')}</span>
            <select bind:value={lowAction}>
              <option value="report">{t('editor.lowAction.report')}</option>
              <option value="skip">{t('editor.lowAction.skip')}</option>
              <option value="send">{t('editor.lowAction.send')}</option>
            </select>
          </label>
          {#if lowAction === 'report'}
            <label class="field"
              ><span>{t('editor.reviewUrl')}</span>
              <input bind:value={reviewUrl} spellcheck="false" placeholder="https://admin.example.com/records/&#123;&#123;id&#125;&#125;" /></label
            >
          {/if}
        </div>
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
      {#if !blocked}
        {#if step > 0}<button class="ghost" onclick={() => (step -= 1)}>{t('editor.back')}</button>{/if}
        {#if step < LAST}
          <Button onclick={() => (step += 1)}>{t('editor.next')}</Button>
        {:else}
          <Button class="primary" onclick={save} disabled={saving}>{t('editor.save')}</Button>
        {/if}
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
  /* The children carry `flex: 1`, so the row was always the intent — but the rule only
     existed under `.sched`, which left the allowed-values tabs stacked full width. Hoisted
     rather than duplicated, so both places lay out the same way. */
  .tabs {
    display: flex;
    gap: 6px;
  }
  .sched .tabs {
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
  /* A path that found nothing is worth pointing at, but it is not a failure — the sample
     may simply not carry that field. Muted rather than red. */
  .testNote {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--muted, #8b949e);
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
  /* A hint that is a caution — the header shadowing the credential is silent otherwise. */
  .hint.warn {
    color: var(--warning);
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
