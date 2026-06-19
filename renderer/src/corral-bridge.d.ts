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
      secret: {
        set(service: string, account: string, value: string): Promise<void>;
        has(service: string, account: string): Promise<boolean>;
        delete(service: string, account: string): Promise<void>;
      };
      detectDocker(): Promise<{ available: boolean; version?: string }>;
      startOrchestrator(): Promise<{ ok: boolean; port: number }>;
    };
  }
}
