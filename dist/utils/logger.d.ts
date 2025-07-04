/**
 * Logger utility using Winston
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