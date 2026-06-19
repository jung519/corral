/** Runnable headless entrypoint. Loads config, wires adapters, prints a status
 * summary, and exits. (The orchestrator run loop is lifted in S2.)
 *
 *   pnpm dev [path/to/corral.yaml]   # default: ./corral.yaml
 */
import { bootstrapFromFile } from './bootstrap.js';

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? 'corral.yaml';
  const app = await bootstrapFromFile(configPath);

  await app.channel.start();
  await app.orchestrator.start(); // recovers any in-flight issues; no polling

  const lines = [
    `corral — config loaded from ${configPath}`,
    `  profile      lang=${app.profile.language}, stack=${app.profile.stack.id}`,
    `  tracker      ${app.tracker.kind}`,
    `  repositories ${app.repositories.map((r) => `${r.key} (${r.kind})`).join(', ')}`,
    `  agent        ${app.agent.kind} (${app.config.agent.transport})`,
    `  workspace    ${app.workspace.kind}`,
    `  channel      ${app.channel.kind}`,
    '',
    'Orchestrator ready. Drive it via the control plane (dashboard lands in S3).',
  ];
  console.log(lines.join('\n'));
}

main().catch((err: unknown) => {
  console.error(`corral: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
