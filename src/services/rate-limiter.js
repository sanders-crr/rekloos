const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

// Rate limiter prevents overwhelming websites by enforcing delays between requests to the same domain. Uses Redis for shared state across multiple crawler instances and persistence across restarts.
class RateLimiter {
  constructor() {
    // Redis is an in-memory database used here as shared storage for rate limiting data. Multiple crawler instances can coordinate through Redis to respect the same rate limits.
    this.redis = new Redis(config.redis.url);
    this.defaultDelay = config.crawler.delayBetweenRequests;
    this.domainDelays = new Map();
  }

  async setDomainDelay(domain, delayMs) {
    this.domainDelays.set(domain, delayMs);
    
    // Store in Redis for persistence across instances using setex (SET with EXpiration). The 3600 seconds (1 hour) expiration prevents stale delay settings from persisting indefinitely.
    await this.redis.setex(`delay:${domain}`, 3600, delayMs);
    
    logger.debug('Set domain delay', { domain, delayMs });
  }

  async getDomainDelay(domain) {
    // Check memory cache first for fastest access, then fall back to Redis if not found. This two-tier caching reduces Redis calls while maintaining shared state across instances.
    if (this.domainDelays.has(domain)) {
      return this.domainDelays.get(domain);
    }

    // Check Redis cache using get operation to retrieve stored delay value. Redis returns null if the key doesn't exist or has expired.
    const cached = await this.redis.get(`delay:${domain}`);
    if (cached) {
      const delay = parseInt(cached);
      this.domainDelays.set(domain, delay);
      return delay;
    }

    return this.defaultDelay;
  }

  async shouldWait(domain) {
    // Redis keys use colon notation as a naming convention to create namespaces. The 'lastRequest:' prefix groups all last request timestamps together for easy management.
    const key = `lastRequest:${domain}`;
    // Date.now() returns current time in milliseconds since January 1, 1970 (Unix epoch). We use milliseconds for precise timing calculations in rate limiting.
    const now = Date.now();
    
    try {
      const lastRequest = await this.redis.get(key);
      
      if (!lastRequest) {
        await this.redis.setex(key, 3600, now); // Cache for 1 hour
        return 0;
      }

      const lastRequestTime = parseInt(lastRequest);
      const delay = await this.getDomainDelay(domain);
      const timeSinceLastRequest = now - lastRequestTime;
      
      // Calculate if enough time has passed since the last request to this domain. If not enough time has passed, return how long to wait before the next request is allowed.
      if (timeSinceLastRequest < delay) {
        const waitTime = delay - timeSinceLastRequest;
        logger.debug('Rate limiting applied', { domain, waitTime });
        return waitTime;
      }

      await this.redis.setex(key, 3600, now);
      return 0;
    } catch (error) {
      // Graceful degradation: if Redis fails, return default delay instead of crashing. This ensures the crawler continues working even when Redis is unavailable.
      logger.error('Rate limiter error', { domain, error: error.message });
      return this.defaultDelay;
    }
  }

  async wait(domain) {
    const waitTime = await this.shouldWait(domain);
    
    if (waitTime > 0) {
      // Common Node.js pattern to create a delay using Promise with setTimeout. The Promise resolves after the specified waitTime, effectively pausing execution.
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  async updateLastRequest(domain) {
    const key = `lastRequest:${domain}`;
    await this.redis.setex(key, 3600, Date.now());
  }

  async getStats() {
    try {
      // Redis keys() with wildcard pattern '*' finds all keys matching the pattern. This gets all domains that have rate limiting data stored.
      const keys = await this.redis.keys('lastRequest:*');
      const stats = {};
      
      for (const key of keys) {
        const domain = key.replace('lastRequest:', '');
        const lastRequest = await this.redis.get(key);
        const delay = await this.getDomainDelay(domain);
        
        stats[domain] = {
          lastRequest: parseInt(lastRequest),
          delay,
          nextAllowedRequest: parseInt(lastRequest) + delay
        };
      }
      
      return stats;
    } catch (error) {
      logger.error('Error getting rate limiter stats', { error: error.message });
      return {};
    }
  }

  async clearDomainLimits(domain) {
    try {
      await this.redis.del(`lastRequest:${domain}`);
      await this.redis.del(`delay:${domain}`);
      this.domainDelays.delete(domain);
      
      logger.info('Cleared rate limits for domain', { domain });
    } catch (error) {
      logger.error('Error clearing domain limits', { domain, error: error.message });
    }
  }

  async close() {
    this.redis.disconnect();
  }
}

// Export a single instance (singleton pattern) so all parts of the application share the same rate limiter. The 'new' keyword creates the instance immediately when this module is first required.
module.exports = new RateLimiter();