const axios = require('axios');
const robotsParser = require('robots-parser');
const db = require('../database/connection');
const logger = require('../utils/logger');
const config = require('../config');

// Service for managing robots.txt compliance with two-tier caching (memory + database). Implements fail-safe approach where crawling is allowed if robots.txt cannot be retrieved.
class RobotsService {
  constructor() {
    // Memory cache for fast access to recently fetched robots.txt data. Database cache provides persistence across service restarts.
    this.cache = new Map();
    this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
  }

  // Checks if a URL can be crawled according to robots.txt rules for the given user agent. Returns crawl permission and recommended delay between requests.
  async canCrawl(url, userAgent = config.crawler.userAgent) {
    if (!config.crawler.respectRobotsTxt) {
      return { allowed: true, delay: 0 };
    }

    try {
      const domain = new URL(url).hostname;
      const robots = await this.getRobotsTxt(domain);
      
      if (!robots) {
        return { allowed: true, delay: 1 };
      }

      const allowed = robots.isAllowed(url, userAgent);
      const delay = robots.getCrawlDelay(userAgent) || 1;

      return { allowed, delay };
    } catch (error) {
      logger.error('Error checking robots.txt', { url, error: error.message });
      return { allowed: true, delay: 1 };
    }
  }

  async getRobotsTxt(domain) {
    try {
      // Check memory cache first for fastest access to recently used robots.txt data. Memory cache expires after 24 hours to ensure freshness.
      const cached = this.cache.get(domain);
      if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
        return cached.robots;
      }

      // Check database cache as fallback when memory cache misses. Database cache persists across service restarts and reduces external HTTP requests.
      const dbResult = await db.query(
        'SELECT robots_txt, crawl_delay, last_updated FROM robots_cache WHERE domain = $1',
        [domain]
      );

      if (dbResult.rows.length > 0) {
        const row = dbResult.rows[0];
        const lastUpdated = new Date(row.last_updated);
        
        // Validate that cached data is still fresh (less than 24 hours old). Expired cache triggers fresh fetch to respect robots.txt updates.
        if ((Date.now() - lastUpdated.getTime()) < this.cacheExpiry) {
          const robots = robotsParser(`https://${domain}/robots.txt`, row.robots_txt);
          this.cache.set(domain, { robots, timestamp: Date.now() });
          return robots;
        }
      }

      // Fetch fresh robots.txt when cache is stale or missing. New data will be cached in both memory and database for future requests.
      const robots = await this.fetchRobotsTxt(domain);
      
      // Cache in memory
      this.cache.set(domain, { robots, timestamp: Date.now() });
      
      // Cache in database
      const robotsText = robots ? robots.toString() : '';
      const crawlDelay = robots ? (robots.getCrawlDelay('*') || 1) : 1;
      
      // UPSERT operation that either inserts new robots.txt cache data or updates existing cache entries for the domain. This ensures the database cache always has the most recent robots.txt data.
      await db.query(`
        INSERT INTO robots_cache (domain, robots_txt, crawl_delay, last_updated)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (domain) 
        DO UPDATE SET 
          robots_txt = EXCLUDED.robots_txt,
          crawl_delay = EXCLUDED.crawl_delay,
          last_updated = NOW()
      `, [domain, robotsText, crawlDelay]);

      return robots;
    } catch (error) {
      logger.error('Error getting robots.txt', { domain, error: error.message });
      return null;
    }
  }

  async fetchRobotsTxt(domain) {
    const robotsUrl = `https://${domain}/robots.txt`;
    
    try {
      const response = await axios.get(robotsUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': config.crawler.userAgent
        },
        validateStatus: (status) => status < 500 // Accept 4xx responses (like 404) as valid since missing robots.txt means no restrictions. Only treat 5xx as errors since they indicate server problems.
      });

      if (response.status === 200 && response.data) {
        logger.debug('Fetched robots.txt', { domain, size: response.data.length });
        return robotsParser(robotsUrl, response.data);
      }

      return null;
    } catch (error) {
      // Handle missing robots.txt (DNS errors or 404) as normal case, not an error. Missing robots.txt means no crawling restrictions apply to the domain.
      if (error.code === 'ENOTFOUND' || error.response?.status === 404) {
        logger.debug('No robots.txt found', { domain });
        return null;
      }
      
      logger.warn('Failed to fetch robots.txt', { 
        domain, 
        error: error.message,
        status: error.response?.status 
      });
      return null;
    }
  }

  async getSitemaps(domain) {
    try {
      const robots = await this.getRobotsTxt(domain);
      
      if (!robots) {
        return [];
      }

      const sitemaps = robots.getSitemaps();
      logger.debug('Found sitemaps in robots.txt', { domain, count: sitemaps.length });
      
      return sitemaps;
    } catch (error) {
      logger.error('Error getting sitemaps', { domain, error: error.message });
      return [];
    }
  }

  async getCrawlDelay(domain, userAgent = config.crawler.userAgent) {
    try {
      const robots = await this.getRobotsTxt(domain);
      
      if (!robots) {
        return 1; // Default 1 second delay
      }

      return robots.getCrawlDelay(userAgent) || 1;
    } catch (error) {
      logger.error('Error getting crawl delay', { domain, error: error.message });
      return 1;
    }
  }

  clearCache() {
    this.cache.clear();
    logger.info('Robots.txt cache cleared');
  }

  async clearDatabaseCache() {
    try {
      // Remove cache entries older than 24 hours to prevent stale robots.txt data from accumulating. This cleanup maintains cache freshness and manages database size.
      await db.query('DELETE FROM robots_cache WHERE last_updated < NOW() - INTERVAL \'24 hours\'');
      logger.info('Cleared old robots.txt database cache');
    } catch (error) {
      logger.error('Error clearing robots.txt database cache', { error: error.message });
    }
  }
}

module.exports = new RobotsService();