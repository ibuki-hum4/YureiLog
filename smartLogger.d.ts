declare module '@ibuki-hum4/yureilog.js' {
  export interface RotationOptions { size: number; maxFiles?: number }
  export interface RemoteOptions { url: string; intervalMs?: number; batchSize?: number; headers?: Record<string,string>; timeoutMs?: number; maxBuffer?: number }
  export interface SmartLoggerOptions {
    level?: 'error'|'warn'|'info'|'debug';
    env?: string;
    label?: string;
    colors?: boolean;
    json?: boolean;
    file?: string;
    rotation?: RotationOptions;
    remote?: RemoteOptions;
  }
  export default class SmartLogger {
    constructor(options?: SmartLoggerOptions);
    info(msg: any, ...args: any[]): void;
    warn(msg: any, ...args: any[]): void;
    error(msg: any, ...args: any[]): void;
    debug(msg: any, ...args: any[]): void;
    log(level: 'error'|'warn'|'info'|'debug', msg: any, ...args: any[]): void;
    child(overrides?: Partial<SmartLoggerOptions>): SmartLogger;
    setLevel(level: 'error'|'warn'|'info'|'debug'): void;
    close(): void;
    flushRemote(): Promise<void>;
  }
}
