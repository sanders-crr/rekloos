const axios = require('axios');
const robotsParser = require('robots-parser');
const db = require('../database/connection');
const logger = require('../utils/logger');
const config = require('../config');

class RobotsService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
  }

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
      // Check memory cache first
      const cached = this.cache.get(domain);
      if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
        return cached.robots;
      }

      // Check database cache
      const dbResult = await db.query(
        'SELECT robots_txt, crawl_delay, last_updated FROM robots_cache WHERE domain = $1',
        [domain]
      );

      if (dbResult.rows.length > 0) {
        const row = dbResult.rows[0];
        const lastUpdated = new Date(row.last_updated);
        
        if ((Date.now() - lastUpdated.getTime()) < this.cacheExpiry) {
          const robots = robotsParser(`https://${domain}/robots.txt`, row.robots_txt);
          this.cache.set(domain, { robots, timestamp: Date.now() });
          return robots;
        }
      }

      // Fetch fresh robots.txt
      const robots = await this.fetchRobotsTxt(domain);
      
      // Cache in memory
      this.cache.set(domain, { robots, timestamp: Date.now() });
      
      // Cache in database
      const robotsText = robots ? robots.toString() : '';
      const crawlDelay = robots ? (robots.getCrawlDelay('*') || 1) : 1;
      
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
        validateStatus: (status) => status < 500 // Accept 4xx responses
      });

      if (response.status === 200 && response.data) {
        logger.debug('Fetched robots.txt', { domain, size: response.data.length });
        return robotsParser(robotsUrl, response.data);
      }

      return null;
    } catch (error) {
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
      await db.query('DELETE FROM robots_cache WHERE last_updated < NOW() - INTERVAL \'24 hours\'');
      logger.info('Cleared old robots.txt database cache');
    } catch (error) {
      logger.error('Error clearing robots.txt database cache', { error: error.message });
    }
  }
}

module.exports = new RobotsService();