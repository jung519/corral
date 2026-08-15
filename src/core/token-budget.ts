/**
 * One daily token ceiling, shared by both pillars.
 *
 * Shared infrastructure on purpose (docs/module-boundaries.md): the development AI and
 * the operational AI spend from the same account, so a limit that only one of them
 * counted would not be a limit. First come, first served — when the day's tokens are
 * gone, both stop. There is no sub-allocation; splitting the budget would mean one side
 * idles while the other is blocked, which is worse than either running out.
 *
 * **Why tokens and not money.** A price table belongs to a vendor and the vendor changes
 * it. Token counts come back from the response itself and are exactly what was spent.
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
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface BudgetVerdict {
  ok: boolean;
  /** Which side is exhausted, in the operator's words. */
  reason?: string;
}

export interface BudgetSnapshot extends TokenUsage {
  date: string;
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
    const fresh = (): Persisted => ({ date: today(this.now()), inputTokens: 0, outputTokens: 0, announced: [] });
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Persisted;
      // Yesterday's tally is not today's. A stale file is a new day, not a spent one.
      return saved.date === today(this.now()) ? saved : fresh();
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
      this.state = { date, inputTokens: 0, outputTokens: 0, announced: [] };
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
    return { ok: true };
  }

  /** Add what a call actually spent, from whichever pillar spent it. */
  record(usage: Partial<TokenUsage>): void {
    this.roll();
    this.state.inputTokens += usage.inputTokens ?? 0;
    this.state.outputTokens += usage.outputTokens ?? 0;
    this.save();
    this.announce();
  }

  /** Fraction of the tightest configured ceiling, 0 when nothing is configured. */
  private ratio(): number {
    const { dailyInputTokens, dailyOutputTokens } = this.limits;
    const ratios = [
      dailyInputTokens ? this.state.inputTokens / dailyInputTokens : 0,
      dailyOutputTokens ? this.state.outputTokens / dailyOutputTokens : 0,
    ];
    return Math.max(...ratios);
  }

  /** Announce each threshold the day has newly crossed, once. */
  private announce(): void {
    const percent = this.ratio() * 100;
    for (const mark of THRESHOLDS) {
      if (percent < mark || this.state.announced.includes(mark)) continue;
      this.state.announced.push(mark);
      const spent = `in ${this.state.inputTokens} / out ${this.state.outputTokens}`;
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
      limits: this.limits,
      used: this.ratio(),
    };
  }

  /** Whether any ceiling is configured at all. */
  get configured(): boolean {
    return Boolean(this.limits.dailyInputTokens || this.limits.dailyOutputTokens);
  }
}
