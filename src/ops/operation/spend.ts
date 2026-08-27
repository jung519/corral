/**
 * What a turn spent, summed across every provider it tried.
 *
 * A turn is not one billable call. When a provider answers off-schema the runner moves on
 * to the next one, and the answer it threw away was already paid for — the tokens went out
 * and came back. Reporting only the provider that finally worked undercounts a failover by
 * however much the earlier attempts cost, on successful runs as much as on failed ones
 * (CRL-44).
 *
 * So both runners keep one of these for the whole turn and add to it at the one moment
 * that means "billed": a provider came back with something. What happens to that something
 * afterwards — parsed, rejected, discarded — changes nothing about the bill.
 */
import type { OperationSpend } from '../pipeline/ports.js';

export class SpendTally {
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;

  /**
   * Record one provider's reply.
   *
   * Call this as soon as the reply is in hand and before deciding whether it is usable.
   * Anything else re-creates the bug: the decision must not be able to skip the counting.
   */
  add(turn: { inputTokens?: number; outputTokens?: number; costUsd?: number }): void {
    this.inputTokens += turn.inputTokens ?? 0;
    this.outputTokens += turn.outputTokens ?? 0;
    this.costUsd += turn.costUsd ?? 0;
  }

  /** The running total, in the shape the port and the ceiling both read. */
  total(): Required<OperationSpend> {
    return {
      tokens: this.inputTokens + this.outputTokens,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
    };
  }
}
