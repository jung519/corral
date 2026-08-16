/**
 * The escape hatch.
 *
 * The question that matters is not "can a plugin run" — it is **"does a plugin change
 * anything else"**. A step written in code has to be subject to the same budget, the same
 * `require`/`skip_if`, the same outcomes and the same history as a built-in one, or the
 * escape hatch quietly becomes a way around the rules.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenBudget } from '../../core/token-budget.js';
import { startOpsHost } from '../ops-host.js';
import type { OperationRunner } from '../pipeline/ports.js';

let dir: string;

/** Answers without a model, so a test never depends on a provider. */
const stubModel: OperationRunner = {
  run: async () => ({ answer: { items: ['news'], confidence: 0.9 }, tokens: 900, inputTokens: 800, outputTokens: 100 }),
};

function writePlugin(name: string, source: string): void {
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  writeFileSync(join(dir, 'plugins', name), source);
}

function writePipeline(body: string): void {
  mkdirSync(join(dir, 'pipelines'), { recursive: true });
  writeFileSync(join(dir, 'pipelines', 'p.yaml'), body);
}

const DEFINITION = (extra: string): string => `
key: classify
trigger: { kind: manual }
input: { kind: none, select: { title: "title" }, require: [title] }
agent:
  prompt: { system: s, user_template: "{{title}}" }
  schema:
    type: object
    properties: { items: { type: array }, confidence: { type: number } }
    required: [items, confidence]
${extra}
output: { kind: none }
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'corral-plugin-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('replacing only the check', () => {
  const REJECTING_CHECK = `
    export default (options) => ({
      async check(step, answer) {
        if ((answer.items ?? []).includes(options.forbidden)) {
          return { ok: false, reasons: ['the plugin said no: ' + options.forbidden] };
        }
        return { ok: true, answer };
      },
    });
  `;

  it('runs the pipeline with the code check in place of the rules', async () => {
    writePlugin('check.js', REJECTING_CHECK);
    writePipeline(DEFINITION('  validate:\n    plugin: { module: check.js, options: { forbidden: sport } }'));
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    const { run } = await host.runManually('classify', { title: 'a record' });

    expect(run?.outcome).toBe('completed');
  });

  it('lets the plugin reject an answer, and the run ends the way any rejection does', async () => {
    writePlugin('check.js', REJECTING_CHECK);
    writePipeline(DEFINITION('  validate:\n    plugin: { module: check.js, options: { forbidden: news } }'));
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    const { run } = await host.runManually('classify', { title: 'a record' });

    // Same outcome, same stage, same shape as the built-in rules produce.
    expect(run).toMatchObject({ outcome: 'rejected', stage: 'validate' });
    expect(run?.reason).toBe('the plugin said no: news');
  });

  it('can hold an answer back, and `on_low_confidence` still decides what that means', async () => {
    writePlugin(
      'doubt.js',
      `export default () => ({
         async check(step, answer) {
           return { ok: false, lowConfidence: true, reasons: ['not sure'], answer };
         },
       });`,
    );
    writePipeline(
      `${DEFINITION('  validate:\n    plugin: { module: doubt.js }')}on_low_confidence: { action: report, review_url: "https://example.test/r" }\n`,
    );
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    const { run } = await host.runManually('classify', { title: 'a record' });

    // The plugin says "doubtful"; what happens next is still the pipeline's decision.
    expect(run).toMatchObject({ outcome: 'reported', lowConfidence: true, reviewUrl: 'https://example.test/r' });
  });
});

describe('a plugin is not a way around the rules', () => {
  it('does not get to skip `require` — the lifecycle checks before any step runs', async () => {
    writePlugin('check.js', 'export default () => ({ async check(s, a) { return { ok: true, answer: a }; } });');
    writePipeline(DEFINITION('  validate:\n    plugin: { module: check.js }'));
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    const { run } = await host.runManually('classify', {}); // no title

    expect(run).toMatchObject({ outcome: 'skipped', stage: 'input' });
  });

  it('is stopped by the shared token ceiling like anything else', async () => {
    const budget = new TokenBudget({ dailyInputTokens: 10 }, dir);
    budget.record({ inputTokens: 50, outputTokens: 0 });
    writePlugin('model.js', 'export default () => ({ async run() { return { answer: { items: [] }, tokens: 1 }; } });');
    writePipeline(DEFINITION('  plugin: { module: model.js }'));
    const host = await startOpsHost({ stateDir: dir, budget });

    const { run } = await host.runManually('classify', { title: 'a record' });

    // Checked before the step, so a plugin cannot spend past the ceiling by being code.
    expect(run?.outcome).toBe('over_budget');
  });

  it('has whatever it spent counted, and lands in the history', async () => {
    const budget = new TokenBudget({ dailyInputTokens: 10_000 }, dir);
    writePlugin(
      'model.js',
      `export default () => ({
         async run() {
           return { answer: { items: ['news'], confidence: 1 }, tokens: 300, inputTokens: 250, outputTokens: 50, provider: 'plugin' };
         },
       });`,
    );
    writePipeline(DEFINITION('  plugin: { module: model.js }'));
    const host = await startOpsHost({ stateDir: dir, budget });

    const { run } = await host.runManually('classify', { title: 'a record' });

    expect(run).toMatchObject({ outcome: 'completed', tokens: 300, provider: 'plugin' });
    expect(budget.snapshot().inputTokens).toBe(250);
    expect((await host.history.list({ days: 1 }))[0]).toMatchObject({ outcome: 'completed', tokens: 300 });
    expect((await host.history.countsByPipeline(1)).classify).toMatchObject({ runs: 1, tokens: 300 });
  });
});

describe('replacing the other steps', () => {
  it('takes the input from code', async () => {
    writePlugin(
      'input.js',
      `export default (options) => ({
         kind: 'plugin',
         async resolve(input, event) {
           const raw = { title: options.prefix + event.id, labels: [] };
           return { raw, fields: { title: raw.title } };
         },
       });`,
    );
    writePipeline(`
key: classify
trigger: { kind: manual }
input:
  kind: plugin
  plugin: { module: input.js, options: { prefix: "record-" } }
  require: [title]
agent:
  prompt: { system: s, user_template: "{{title}}" }
  schema: { type: object, properties: { items: { type: array } }, required: [items] }
output: { kind: none }
`);
    const seen: Array<Record<string, unknown>> = [];
    const host = await startOpsHost({
      stateDir: dir,
      operation: { run: async (_s, fields) => (seen.push(fields), { answer: { items: [] } }) },
    });

    const { run } = await host.runManually('classify', { id: 42 });

    expect(run?.outcome).toBe('completed');
    expect(seen[0]).toEqual({ title: 'record-42' });
  });

  it('sends the answer through code', async () => {
    writePlugin(
      'sink.js',
      `import { writeFileSync } from 'node:fs';
       export default (options) => ({
         kind: 'plugin',
         async send(output, fields) { writeFileSync(options.file, JSON.stringify(fields)); },
       });`,
    );
    const target = join(dir, 'delivered.json');
    writePipeline(`
key: classify
trigger: { kind: manual }
input: { kind: none, select: { title: "title" } }
agent:
  prompt: { system: s, user_template: "{{title}}" }
  schema: { type: object, properties: { items: { type: array } }, required: [items] }
output:
  kind: plugin
  plugin: { module: sink.js, options: { file: ${JSON.stringify(target)} } }
`);
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    const { run } = await host.runManually('classify', { title: 'a record' });

    expect(run?.outcome).toBe('completed');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ title: 'a record', items: ['news'] });
  });
});

describe('a plugin that will not load', () => {
  it('fails the step it belongs to, with the file name', async () => {
    writePipeline(DEFINITION('  validate:\n    plugin: { module: missing.js }'));
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    const { run } = await host.runManually('classify', { title: 'a record' });

    // Not a crash and not a silent pass. Refused rather than passed, for the same reason
    // an unreachable vocabulary is: with no way to check, letting it through defeats the
    // check at exactly the moment it matters.
    expect(run).toMatchObject({ outcome: 'rejected', stage: 'validate' });
    expect(run?.reason).toMatch(/no plugin file at .*missing\.js/);
  });

  it('is refused when it exports the wrong shape', async () => {
    writePlugin('wrong.js', 'export default () => ({ nope: true });');
    writePipeline(DEFINITION('  validate:\n    plugin: { module: wrong.js }'));
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    // Caught when it is built, with its file name — not at 3am as an undefined call.
    expect((await host.runManually('classify', { title: 'a record' })).run?.reason).toMatch(
      /"wrong\.js" did not return a usable answer check/,
    );
  });

  it('refuses a module outside the plugins folder', async () => {
    writePipeline(DEFINITION('  validate:\n    plugin: { module: "../../etc/passwd" }'));
    const host = await startOpsHost({ stateDir: dir, operation: stubModel });

    // A definition that reaches outside its folder is one you cannot move or review.
    expect((await host.runManually('classify', { title: 'a record' })).run?.reason).toMatch(
      /must be a file name inside the plugins folder/,
    );
  });
});
