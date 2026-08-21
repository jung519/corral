/**
 * Which agent routings can execute under which workspace backend.
 *
 * One rule, in one place, because two places ask it: the orchestrator cancels a stage
 * before dispatch, and the setup wizard warns while you are still choosing. It used to be
 * written as "gemini cannot run under docker", which reads like a fact about the provider
 * and is not one — it is a fact about `gemini:cli`.
 *
 * The cli transports spawn the provider's CLI **inside the container**, so that CLI needs
 * a login in there. claude has one (`CLAUDE_CODE_OAUTH_TOKEN` / an API key / the mounted
 * `~/.claude`), gpt has one (the base64 `~/.codex/auth.json`), gemini has none — nothing
 * the wizard can collect ends up as a gemini login in the image.
 *
 * The api transports never enter the container. The core holds the key and calls the
 * provider over HTTPS itself; only the model's *tools* reach the workspace, through
 * `WorkspaceIO` (`docker exec`). So `gemini:api` under docker asks nothing of the
 * container that `claude:api` does not, and blocking it left Gemini unusable on any
 * remote/VM setup — where docker is the whole point (CRL-80).
 */

/** Just enough of an agent routing to answer the question. */
export interface RoutingShape {
  provider: string;
  transport: string;
}

/** The provider that cannot execute under `backend`, or null when the routing is fine. */
export function unrunnableProvider(routing: RoutingShape, backend: string): string | null {
  if (backend !== 'docker') return null;
  // Only the in-container path is constrained; see the header.
  if (routing.transport !== 'cli') return null;
  return routing.provider === 'gemini' ? routing.provider : null;
}
