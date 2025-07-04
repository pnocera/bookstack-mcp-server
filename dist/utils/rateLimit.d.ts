/**
 * Rate limiter utility for API requests
 */
export declare class RateLimiter {
    private tokens;
    private maxTokens;
    private refillRate;
    private lastRefill;
    constructor(config: {
        requestsPerMinute: number;
        burstLimit: number;
    });
    /**
     * Acquire a token, waiting if necessary
     */
    acquire(): Promise<void>;
    /**
     * Refill tokens based on elapsed time
     */
    private refill;
    /**
     * Check if a request can be made immediately
     */
    canMakeRequest(): boolean;
    /**
     * Get current token count
     */
    getTokenCount(): number;
}
export default RateLimiter;
//# sourceMappingURL=rateLimit.d.ts.map