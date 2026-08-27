/**
 * Deliver nowhere.
 *
 * Not a placeholder — it's how you try a pipeline out. Write the prompt, run it by hand,
 * read the answer in the history, and only then decide where the result should go. It is
 * also the honest sink for a pipeline whose whole job is to record something.
 */
import type { OutputSink } from '../pipeline/ports.js';

export class NoneOutputSink implements OutputSink {
  readonly kind = 'none' as const;

  async send(): Promise<void> {
    // Nothing to do. The answer is already in the run record.
  }
}
