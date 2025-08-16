const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

class RateLimiter {
  constructor() {
    this.redis = new Redis(config.redis.url);
    this.defaultDelay = config.crawler.delayBetweenRequests;
    this.domainDelays = new Map();
  }

  async setDomainDelay(domain, delayMs) {
    this.domainDelays.set(domain, delayMs);
    
    // Store in Redis for persistence across instances
    await this.redis.setex(`delay:${domain}`, 3600, delayMs); // Cache for 1 hour
    
    logger.debug('Set domain delay', { domain, delayMs });
  }

  async getDomainDelay(domain) {
    // Check memory cache first
    if (this.domainDelays.has(domain)) {
      return this.domainDelays.get(domain);
    }

    // Check Redis cache
    const cached = await this.redis.get(`delay:${domain}`);
    if (cached) {
      const delay = parseInt(cached);
      this.domainDelays.set(domain, delay);
      return delay;
    }

    return this.defaultDelay;
  }

  async shouldWait(domain) {
    const key = `lastRequest:${domain}`;
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
      
      if (timeSinceLastRequest < delay) {
        const waitTime = delay - timeSinceLastRequest;
        logger.debug('Rate limiting applied', { domain, waitTime });
        return waitTime;
      }

      await this.redis.setex(key, 3600, now);
      return 0;
    } catch (error) {
      logger.error('Rate limiter error', { domain, error: error.message });
      return this.defaultDelay;
    }
  }

  async wait(domain) {
    const waitTime = await this.shouldWait(domain);
    
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  async updateLastRequest(domain) {
    const key = `lastRequest:${domain}`;
    await this.redis.setex(key, 3600, Date.now());
  }

  async getStats() {
    try {
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

module.exports = new RateLimiter();