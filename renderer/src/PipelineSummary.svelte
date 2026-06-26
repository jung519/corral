<script lang="ts">
  import { t } from './lib/i18n.svelte';
  import type { WizardState } from './lib/wizard';

  let { s }: { s: WizardState } = $props();

  const TRACKER = { notion: 'Notion', github_issues: 'GitHub Issues', jira: 'Jira' } as const;
  const REPO = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' } as const;
  const PROVIDER = { claude: 'Claude', gemini: 'Gemini', gpt: 'GPT' } as const;

  // All repos same provider → that brand; mixed → neutral "Git".
  const repoValue = $derived.by(() => {
    const ps = new Set(s.repos.map((r) => r.provider));
    const name = ps.size === 1 ? REPO[[...ps][0] as keyof typeof REPO] : 'Git';
    return `${name} · ${s.repos.length}`;
  });
  const skillValue = $derived(s.referenceRepo.trim() ? s.referenceRepo.split('/').pop() || s.referenceRepo : t('pipe.none'));
  const provider = $derived(PROVIDER[s.provider]);

  // input nodes (sources the agents consume) + the per-stage agent nodes.
  const nodes = $derived([
    { kind: 'in', icon: '📋', label: t('pipe.tracker'), value: TRACKER[s.trackerKind], title: '' },
    { kind: 'in', icon: '📦', label: t('pipe.repos'), value: repoValue, title: '' },
    { kind: 'in', icon: '📚', label: t('pipe.skills'), value: skillValue, title: s.referenceRepo },
    { kind: 'ag', icon: '🔍', label: t('pipe.plan'), value: provider, title: `${t('pipe.model')}: ${s.planningModel}` },
    { kind: 'ag', icon: '🔧', label: t('pipe.build'), value: provider, title: `${t('pipe.model')}: ${s.implementationModel}` },
    { kind: 'ag', icon: '✅', label: t('pipe.review'), value: provider, title: `${t('pipe.model')}: ${s.reviewModel}` },
  ]);

  const chips = $derived(
    [
      { icon: s.backend === 'docker' ? '🐳' : '💻', text: s.backend === 'docker' ? 'Docker' : 'Local' },
      s.fallbacks.length ? { icon: '🔁', text: t('pipe.fallback').replace('{n}', String(s.fallbacks.length)) } : null,
      { icon: '🌐', text: s.language === 'ko' ? '한국어' : 'English' },
      { icon: '⚙️', text: t('pipe.concurrent').replace('{n}', String(s.maxActive)) },
    ].filter((c): c is { icon: string; text: string } => c !== null),
  );
</script>

<div class="pipe">
  <div class="row">
    {#each nodes as n, i (i)}
      {#if i > 0}
        <svg class="sep" class:accent={n.kind === 'ag'} viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
      {/if}
      <div class="node" title={n.title}>
        <span class="ico">{n.icon}</span>
        <span class="lbl">{n.label}</span>
        <span class="val" class:ag={n.kind === 'ag'}>{n.value}</span>
      </div>
    {/each}
  </div>

  <div class="chips">
    {#each chips as c (c.text)}
      <span class="chip">{c.icon} {c.text}</span>
    {/each}
  </div>
</div>

<style>
  .pipe {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 12px;
    margin-bottom: 16px;
  }
  .row {
    display: flex;
    align-items: stretch;
    gap: 5px;
  }
  .node {
    flex: 1;
    min-width: 0;
    text-align: center;
    padding: 10px 4px;
    border-radius: 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .ico {
    font-size: 18px;
    line-height: 1;
  }
  .lbl {
    display: block;
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 5px;
  }
  .val {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .val.ag {
    color: var(--accent);
  }
  .sep {
    width: 14px;
    flex: 0 0 auto;
    align-self: center;
    fill: none;
    stroke: var(--text-dim);
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .sep.accent {
    stroke: var(--accent);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .chip {
    font-size: 12px;
    padding: 4px 10px;
    border-radius: var(--radius);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-dim);
    white-space: nowrap;
  }
</style>
