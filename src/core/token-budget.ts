/**
 * One daily token ceiling, shared by both pillars.
 *
 * Shared infrastructure on purpose: the development AI and
 * the operational AI spend from the same account, so a limit that only one of them
 * counted would not be a limit. First come, first served — when the day's tokens are
 * gone, both stop. There is no sub-allocation; splitting the budget would mean one side
 * idles while the other is blocked, which is worse than either running out.
 *
 * **Tokens first, money alongside.** A price table belongs to a vendor and the vendor
 * changes it; token counts come back from the response itself and are exactly what was
 * spent. So tokens stay the figure of record — but a token count is not a number anyone
 * budgets in, and "800k tokens" answers neither "can I afford to run this tonight" nor
 * "is this issue worth the spend" (CRL-86). The money is an estimate carried next to the
 * count, never in place of it, and it is only as good as the table in `agent/pricing.ts`.
 *
 * The counter is per calendar day in local time — the operator's day — and lives on disk
 * so a restart mid-afternoon doesn't hand out the morning's tokens a second time.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bus } from './events.js';
import { DEFAULT_STATE_DIR } from './issue-state.js';
import { logger } from './logger.js';

export interface TokenLimits {
  /** Omitted or 0 = no ceiling on that side. */
  dailyInputTokens?: number;
  dailyOutputTokens?: number;
  /**
   * A ceiling in dollars, checked the same way and independently: whichever runs out first
   * stops the work. Estimated from the price table, so it is a guard rail, not an invoice.
   */
  dailyCostUsd?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Estimated dollars, where it could be estimated.
   *
   * Optional because absent is not zero: a counter file written before CRL-86 has a day's
   * tokens and no money at all, and saying `$0.00` about it would be a false statement
   * rather than a missing one. `unpricedCalls` says how much of the day is like that.
   */
  costUsd?: number;
}

export interface BudgetVerdict {
  ok: boolean;
  /** Which side is exhausted, in the operator's words. */
  reason?: string;
}

/**
 * Which pillar spent a call.
 *
 * The ceiling stays shared (D12, the operator's own decision — splitting it would leave
 * one side idle while the other is blocked). What was missing is *visibility*: the
 * operational design says the ceiling must be on screen at all times so that "the
 * development AI is eating the shared budget shows immediately", and with no attribution
 * the screen could only say the day was spent, never by whom. A quiet pipeline with a full
 * queue looked exactly like a quiet pipeline with no work (CRL-110).
 */
export type BudgetPillar = 'development' | 'operations';

/** Per-pillar tallies. Absent entries mean "spent before this was recorded", not zero. */
export type PillarUsage = Partial<Record<BudgetPillar, TokenUsage>>;

export interface BudgetSnapshot extends TokenUsage {
  date: string;
  /** What each pillar spent today, as far as it is known. */
  byPillar: PillarUsage;
  /**
   * Tokens today that predate attribution — a counter file written by an older build.
   *
   * Reported rather than folded into either side or silently treated as zero: showing
   * `development 0 / operations 0` against a total of 500k would be a false statement, and
   * the same reasoning as an absent `criteria` block (CRL-108) or an unreadable HEAD
   * (CRL-109). It disappears on its own when the day rolls over.
   */
  unattributed: TokenUsage;
  /**
   * Calls today that spent tokens without a price — an older counter file, or a transport
   * that reported a count but nothing to price it with. While this is above zero the money
   * figure is a floor, and the screen has to say so rather than present it as the total.
   */
  unpricedCalls: number;
  limits: TokenLimits;
  /** 0–1 of the tightest configured ceiling; 0 when none is set. */
  used: number;
}

/** Where a crossing is announced. Once each per day — a limit that shouts every call is
 *  noise, and noise is how people stop reading warnings. */
const THRESHOLDS = [50, 80, 100] as const;

interface Persisted extends TokenUsage {
  date: string;
  /** Thresholds already announced today. */
  announced: number[];
  /** Added in CRL-110; absent in a file written by an older build. */
  byPillar?: PillarUsage;
  /** Added in CRL-86; likewise absent in an older file. */
  unpricedCalls?: number;
}

function today(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class TokenBudget {
  private readonly file: string;
  private readonly now: () => number;
  private state: Persisted;

  constructor(
    private readonly limits: TokenLimits = {},
    stateDir: string = DEFAULT_STATE_DIR,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.file = resolve(stateDir, 'token-budget.json');
    this.state = this.load();
  }

  private load(): Persisted {
    const fresh = (): Persisted => ({
      date: today(this.now()),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      announced: [],
      byPillar: {},
      unpricedCalls: 0,
    });
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Persisted;
      // Yesterday's tally is not today's. A stale file is a new day, not a spent one.
      if (saved.date !== today(this.now())) return fresh();
      // A file written before CRL-86 has today's tokens and no money at all. Reading that
      // as `$0.00, nothing unpriced` would state that the morning was free; it says the
      // opposite — everything so far is unpriced, so the day's figure is a floor.
      if (saved.costUsd === undefined && (saved.inputTokens > 0 || saved.outputTokens > 0)) {
        saved.unpricedCalls = saved.unpricedCalls ?? 1;
      }
      return saved;
    } catch {
      return fresh();
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state), 'utf8');
    } catch (err) {
      // Losing the tally to a write error must not stop work; it re-reads as zero at
      // worst, and that is a smaller problem than a core that won't run.
      logger.warn(`token budget: could not persist (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /** Start a new day if the clock has rolled over. */
  private roll(): void {
    const date = today(this.now());
    if (this.state.date !== date) {
      this.state = { date, inputTokens: 0, outputTokens: 0, costUsd: 0, announced: [], byPillar: {}, unpricedCalls: 0 };
      this.save();
    }
  }

  /**
   * Whether another call may be made. Checked BEFORE spending, never after — a limit
   * enforced afterwards has already been exceeded.
   */
  check(): BudgetVerdict {
    this.roll();
    const { dailyInputTokens, dailyOutputTokens } = this.limits;
    if (dailyInputTokens && this.state.inputTokens >= dailyInputTokens) {
      return { ok: false, reason: `daily input token limit reached (${this.state.inputTokens}/${dailyInputTokens})` };
    }
    if (dailyOutputTokens && this.state.outputTokens >= dailyOutputTokens) {
      return { ok: false, reason: `daily output token limit reached (${this.state.outputTokens}/${dailyOutputTokens})` };
    }
    // The money ceiling stops work on the same terms as the token ones, and it is checked
    // against what has actually been priced — an under-count stops late, never early.
    const { dailyCostUsd } = this.limits;
    const spent = this.state.costUsd ?? 0;
    if (dailyCostUsd && spent >= dailyCostUsd) {
      return { ok: false, reason: `daily cost limit reached ($${spent.toFixed(2)}/$${dailyCostUsd.toFixed(2)})` };
    }
    return { ok: true };
  }

  /**
   * Add what a call actually spent, and which pillar spent it.
   *
   * The pillar is tallied alongside the total, never instead of it — the ceiling is still
   * checked against the shared figure, so nothing about when work stops changes here.
   */
  record(usage: Partial<TokenUsage>, pillar: BudgetPillar): void {
    this.roll();
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cost = usage.costUsd ?? 0;
    this.state.inputTokens += input;
    this.state.outputTokens += output;
    this.state.costUsd = (this.state.costUsd ?? 0) + cost;
    // Tokens with no price attached: counted so the money figure can be labelled a floor
    // instead of passing itself off as the day's total.
    if (usage.costUsd === undefined && (input > 0 || output > 0)) {
      this.state.unpricedCalls = (this.state.unpricedCalls ?? 0) + 1;
    }
    const byPillar = (this.state.byPillar ??= {});
    const side = (byPillar[pillar] ??= { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    side.inputTokens += input;
    side.outputTokens += output;
    side.costUsd = (side.costUsd ?? 0) + cost;
    this.save();
    this.announce();
  }

  /** Today's spend that no pillar claims — written before attribution existed. */
  private unattributed(): TokenUsage {
    const claimed = Object.values(this.state.byPillar ?? {}).reduce<Required<TokenUsage>>(
      (a, u) => ({
        inputTokens: a.inputTokens + u.inputTokens,
        outputTokens: a.outputTokens + u.outputTokens,
        costUsd: a.costUsd + (u.costUsd ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
    return {
      inputTokens: Math.max(0, this.state.inputTokens - claimed.inputTokens),
      outputTokens: Math.max(0, this.state.outputTokens - claimed.outputTokens),
      costUsd: Math.max(0, (this.state.costUsd ?? 0) - claimed.costUsd),
    };
  }

  /** `development 120k/4k $0.84 · operations 30k/2k $0.19 · unattributed 350k/9k` — omitting empty parts. */
  private breakdown(): string {
    // Omitted at zero rather than printed as `$0.00`, which beside a real token count
    // reads as a side that ran for free instead of one whose calls went unpriced.
    const money = (u: TokenUsage): string => ((u.costUsd ?? 0) > 0 ? ` $${u.costUsd!.toFixed(2)}` : '');
    const parts = Object.entries(this.state.byPillar ?? {}).map(
      ([k, u]) => `${k} ${u.inputTokens}/${u.outputTokens}${money(u)}`,
    );
    const un = this.unattributed();
    if (un.inputTokens > 0 || un.outputTokens > 0) parts.push(`unattributed ${un.inputTokens}/${un.outputTokens}`);
    return parts.join(' · ');
  }

  /**
   * `in 1200 / out 300 · ~$0.84` — the day's total, with the money only where it means
   * something.
   *
   * Omitted when nothing has been priced, because `$0.00` next to a spent day reads as a
   * free day rather than an unmeasured one; marked `≥` while any call went unpriced, since
   * what is shown is then a floor (CRL-86).
   */
  private spentLine(): string {
    const tokens = `in ${this.state.inputTokens} / out ${this.state.outputTokens}`;
    const cost = this.state.costUsd ?? 0;
    const unpriced = this.state.unpricedCalls ?? 0;
    const money = cost > 0 ? ` · ${unpriced > 0 ? '≥' : '~'}$${cost.toFixed(2)}` : '';
    return `${tokens}${money} — ${this.breakdown()}`;
  }

  /** Fraction of the tightest configured ceiling, 0 when nothing is configured. */
  private ratio(): number {
    const { dailyInputTokens, dailyOutputTokens } = this.limits;
    const { dailyCostUsd } = this.limits;
    const ratios = [
      dailyInputTokens ? this.state.inputTokens / dailyInputTokens : 0,
      dailyOutputTokens ? this.state.outputTokens / dailyOutputTokens : 0,
      dailyCostUsd ? (this.state.costUsd ?? 0) / dailyCostUsd : 0,
    ];
    return Math.max(...ratios);
  }

  /** Announce each threshold the day has newly crossed, once. */
  private announce(): void {
    const percent = this.ratio() * 100;
    for (const mark of THRESHOLDS) {
      if (percent < mark || this.state.announced.includes(mark)) continue;
      this.state.announced.push(mark);
      // Who spent it, not just how much. Without this the operator sees a stopped pipeline
      // and a spent day with nothing connecting the two (CRL-110).
      const spent = this.spentLine();
      bus.emitEvent({
        identifier: 'token-budget',
        kind: mark >= 100 ? 'error' : 'notice',
        label:
          mark >= 100
            ? `🛑 daily token limit reached (${spent}) — AI calls are paused until tomorrow`
            : `⚠️ ${mark}% of the daily token limit used (${spent})`,
        data: { threshold: mark, ...this.state },
      });
      logger.warn(`token budget: ${mark}% used (${spent})`);
    }
    this.save();
  }

  snapshot(): BudgetSnapshot {
    this.roll();
    return {
      date: this.state.date,
      inputTokens: this.state.inputTokens,
      outputTokens: this.state.outputTokens,
      costUsd: this.state.costUsd ?? 0,
      unpricedCalls: this.state.unpricedCalls ?? 0,
      limits: this.limits,
      used: this.ratio(),
      byPillar: { ...this.state.byPillar },
      unattributed: this.unattributed(),
    };
  }

  /** Whether any ceiling is configured at all. */
  get configured(): boolean {
    return Boolean(this.limits.dailyInputTokens || this.limits.dailyOutputTokens || this.limits.dailyCostUsd);
  }
}
