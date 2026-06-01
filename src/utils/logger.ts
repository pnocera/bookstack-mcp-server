import winston, { Logger as WinstonLogger } from 'winston';
import { parseBooleanEnv } from './env';

/**
 * Logger utility using Winston.
 * When VERBOSE=1/true/True/TRUE is set, the effective log level is forced to
 * "debug" regardless of LOG_LEVEL, so that verbose request/response logs are
 * always emitted.
 */
export class Logger {
  private static instance: Logger;
  private logger: WinstonLogger;

  private constructor() {
    const verbose = parseBooleanEnv(process.env.VERBOSE);
    const level = verbose ? 'debug' : (process.env.LOG_LEVEL || 'info');
    const format = process.env.LOG_FORMAT || 'pretty';

    const logFormat = format === 'json' 
      ? winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json()
        )
      : winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.errors({ stack: true }),
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp} [${level}] ${message}${metaStr}`;
          })
        );

    this.logger = winston.createLogger({
      level,
      format: logFormat,
      transports: [
        new winston.transports.Console({ stderrLevels: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] }),
      ],
    });
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  debug(message: string, meta?: any): void {
    this.logger.debug(message, meta);
  }

  info(message: string, meta?: any): void {
    this.logger.info(message, meta);
  }

  warn(message: string, meta?: any): void {
    this.logger.warn(message, meta);
  }

  error(message: string, meta?: any): void {
    this.logger.error(message, meta);
  }

  child(meta: any): Logger {
    const childLogger = new Logger();
    childLogger.logger = this.logger.child(meta);
    return childLogger;
  }
}

export default Logger;