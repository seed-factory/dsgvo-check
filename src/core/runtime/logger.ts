/** Minimal logger. Logs go to stderr; stdout is reserved for the console report. Never log cookie values. */
export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(
  level: LogLevel = 'warn',
  write: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): Logger {
  const at = (l: LogLevel) => (msg: string) => {
    if (ORDER[l] >= ORDER[level]) write(`[dsgvo-check] ${l}: ${msg}`);
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: Logger = createLogger('silent');
