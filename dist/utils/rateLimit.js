"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = void 0;
/**
 * Rate limiter utility for API requests
 */
class RateLimiter {
    constructor(config) {
        this.maxTokens = config.burstLimit;
        this.tokens = this.maxTokens;
        this.refillRate = config.requestsPerMinute / 60; // convert to per second
        this.lastRefill = Date.now();
    }
    /**
     * Acquire a token, waiting if necessary
     */
    async acquire() {
        this.refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }
        // Wait for next token
        const waitTime = (1 - this.tokens) / this.refillRate * 1000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        this.refill();
        this.tokens -= 1;
    }
    /**
     * Refill tokens based on elapsed time
     */
    refill() {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        const tokensToAdd = elapsed * this.refillRate;
        this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
        this.lastRefill = now;
    }
    /**
     * Check if a request can be made immediately
     */
    canMakeRequest() {
        this.refill();
        return this.tokens >= 1;
    }
    /**
     * Get current token count
     */
    getTokenCount() {
        this.refill();
        return this.tokens;
    }
}
exports.RateLimiter = RateLimiter;
exports.default = RateLimiter;
//# sourceMappingURL=rateLimit.js.map