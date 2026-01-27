/**
 * ⬛⬜🛣️ BlackRoad Support Center - Logger Utility
 * Structured logging with levels and context
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  requestId?: string;
  jobId?: string;
  repo?: string;
  action?: string;
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private minLevel: LogLevel;
  private context: LogContext;

  constructor(minLevel: LogLevel = 'info', context: LogContext = {}) {
    this.minLevel = minLevel;
    this.context = context;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private formatEntry(entry: LogEntry): string {
    return JSON.stringify(entry);
  }

  private log(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.context, ...context },
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    const formatted = this.formatEntry(entry);

    switch (level) {
      case 'debug':
      case 'info':
        console.log(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.log('error', message, context, error);
  }

  child(additionalContext: LogContext): Logger {
    return new Logger(this.minLevel, { ...this.context, ...additionalContext });
  }

  static fromEnv(env: { LOG_LEVEL?: string }, context?: LogContext): Logger {
    const level = (env.LOG_LEVEL as LogLevel) || 'info';
    return new Logger(level, context);
  }
}

// Singleton for quick access
let defaultLogger: Logger | null = null;

export function getLogger(env?: { LOG_LEVEL?: string }, context?: LogContext): Logger {
  if (!defaultLogger) {
    defaultLogger = Logger.fromEnv(env || {}, context);
  }
  return defaultLogger;
}

export function createLogger(env: { LOG_LEVEL?: string }, context?: LogContext): Logger {
  return Logger.fromEnv(env, context);
}
