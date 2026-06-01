/**
 * Logger utility using Winston.
 * When VERBOSE=1/true/True/TRUE is set, the effective log level is forced to
 * "debug" regardless of LOG_LEVEL, so that verbose request/response logs are
 * always emitted.
 */
export declare class Logger {
    private static instance;
    private logger;
    private constructor();
    static getInstance(): Logger;
    debug(message: string, meta?: any): void;
    info(message: string, meta?: any): void;
    warn(message: string, meta?: any): void;
    error(message: string, meta?: any): void;
    child(meta: any): Logger;
}
export default Logger;
//# sourceMappingURL=logger.d.ts.map