/** Ambient type for the preload IPC bridge (desktop/src/preload.ts). Present only
 * inside the Electron app — undefined in a plain browser (the wizard degrades). */
export {};

declare global {
  interface Window {
    corral?: {
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
      startOrchestrator(): Promise<{ ok: boolean; port: number }>;
    };
  }
}
