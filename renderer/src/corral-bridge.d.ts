/** Ambient type for the preload IPC bridge (desktop/src/preload.ts). Present only
 * inside the Electron app — undefined in a plain browser (the wizard degrades). */
export {};

declare global {
  interface Window {
    corral?: {
      platform: string;
      config: {
        exists(): Promise<boolean>;
        read(): Promise<string | null>;
        write(yaml: string): Promise<void>;
      };
      draft: {
        read(): Promise<string | null>;
        write(json: string): Promise<void>;
        clear(): Promise<void>;
      };
      secret: {
        set(service: string, account: string, value: string): Promise<void>;
        has(service: string, account: string): Promise<boolean>;
        delete(service: string, account: string): Promise<void>;
      };
      detectDocker(): Promise<{ available: boolean; version?: string }>;
      detectCli(provider: string): Promise<{ installed: boolean; version?: string }>;
      claudeSetupToken(): Promise<{ ok: boolean; token?: string; error?: string }>;
      notify(title: string, body: string): Promise<void>;
      validate: {
        notion(token: string): Promise<{ ok: boolean; detail?: string }>;
        github(token: string): Promise<{ ok: boolean; detail?: string }>;
        agent(provider: string, key: string): Promise<{ ok: boolean; detail?: string }>;
      };
      notion: {
        schema(
          token: string,
          dbId: string,
        ): Promise<{ ok: boolean; properties?: Array<{ name: string; type: string; options: string[] }>; detail?: string }>;
      };
      test: {
        repo(input: {
          kind: 'github' | 'gitlab' | 'bitbucket';
          repo: string;
          token: string;
          host?: string;
          username?: string;
        }): Promise<{ ok: boolean; detail?: string }>;
        tracker(input: {
          kind: 'notion' | 'github_issues' | 'jira';
          token: string;
          databaseId?: string;
          repo?: string;
          host?: string;
          email?: string;
          project?: string;
        }): Promise<{ ok: boolean; detail?: string }>;
        reference(repo: string, token: string): Promise<{ ok: boolean; detail?: string }>;
      };
      startOrchestrator(): Promise<{ ok: boolean }>;
      core: {
        call(method: string, args?: Record<string, unknown>): Promise<unknown>;
        onEvent(cb: (event: unknown) => void): () => void;
      };
    };
  }
}
