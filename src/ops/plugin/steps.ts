/**
 * Which of a pipeline's steps are written in code.
 *
 * Reads the definition, builds what it names, and hands it to the lifecycle. Nothing here
 * decides anything about a run — it answers "is there a plugin for this step" and the
 * lifecycle does the rest, exactly as it does for a built-in adapter.
 */
import type { AnswerValidator, InputResolver, OperationRunner, OutputSink } from '../pipeline/ports.js';
import type { PluginSteps } from '../pipeline/run.js';
import type { Pipeline } from '../pipeline/schema.js';
import { isAnswerValidator, isInputResolver, isOperationRunner, isOutputSink, type PluginHost } from './host.js';

export class PluginStepProvider implements PluginSteps {
  constructor(private readonly host: PluginHost) {}

  async input(pipeline: Pipeline): Promise<InputResolver | undefined> {
    if (pipeline.input.kind !== 'plugin') return undefined;
    return this.host.build(pipeline.input.plugin, isInputResolver, 'input resolver');
  }

  async operation(pipeline: Pipeline): Promise<OperationRunner | undefined> {
    const ref = pipeline.agent.plugin;
    return ref ? this.host.build(ref, isOperationRunner, 'model step') : undefined;
  }

  async validator(pipeline: Pipeline): Promise<AnswerValidator | undefined> {
    const ref = pipeline.agent.validate.plugin;
    return ref ? this.host.build(ref, isAnswerValidator, 'answer check') : undefined;
  }

  async sink(pipeline: Pipeline): Promise<OutputSink | undefined> {
    if (pipeline.output.kind !== 'plugin') return undefined;
    return this.host.build(pipeline.output.plugin, isOutputSink, 'output sink');
  }
}
