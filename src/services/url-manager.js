const URL = require('url-parse');
const db = require('../database/connection');
const logger = require('../utils/logger');

// Manages URL queue operations and validation for web crawling with deduplication and retry logic. Handles URL normalization to prevent duplicate crawling of equivalent URLs.
class URLManager {
  constructor() {
    // In-memory Set for fast duplicate detection during a crawling session
    this.seenUrls = new Set();
  }

  normalizeURL(url) {
    try {
      const parsed = new URL(url, true);
      
      // Remove fragment
      parsed.set('hash', '');
      
      // Sort query parameters alphabetically to treat ?a=1&b=2 and ?b=2&a=1 as identical URLs
      const sortedQuery = Object.keys(parsed.query)
        .sort()
        .reduce((result, key) => {
          result[key] = parsed.query[key];
          return result;
        }, {});
      
      parsed.set('query', sortedQuery);
      
      // Remove trailing slash to treat /page and /page/ as the same URL
      if (parsed.pathname.endsWith('/') && parsed.pathname.length > 1) {
        parsed.set('pathname', parsed.pathname.slice(0, -1));
      }
      
      return parsed.toString();
    } catch (error) {
      logger.error('URL normalization failed', { url, error: error.message });
      return null;
    }
  }

  // Validates URLs to ensure they use web protocols and have valid structure
  isValidURL(url) {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  extractDomain(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return null;
    }
  }

  // Domain whitelist validation supporting exact matches and subdomain patterns
  shouldCrawlDomain(url, allowedDomains = []) {
    if (allowedDomains.length === 0) return true;
    
    const domain = this.extractDomain(url);
    if (!domain) return false;
    
    // Match exact domain or subdomains (blog.example.com matches example.com)
    return allowedDomains.some(allowed => 
      domain === allowed || domain.endsWith('.' + allowed)
    );
  }

  async isURLCrawled(url) {
    const normalizedUrl = this.normalizeURL(url);
    if (!normalizedUrl) return true;

    try {
      const result = await db.query(
        'SELECT id, last_crawled FROM crawled_pages WHERE url = $1',
        [normalizedUrl]
      );
      return result.rows.length > 0;
    } catch (error) {
      logger.error('Error checking if URL is crawled', { url, error: error.message });
      return false;
    }
  }

  async addURLToQueue(url, parentUrl = null, depth = 0, jobId = null) {
    const normalizedUrl = this.normalizeURL(url);
    if (!normalizedUrl) return false;

    // Check memory cache first for fast duplicate detection within this session
    if (this.seenUrls.has(normalizedUrl)) {
      return false;
    }

    this.seenUrls.add(normalizedUrl);

    try {
      // Insert with conflict handling - prevents database errors from duplicate URLs across sessions
      await db.query(`
        INSERT INTO url_queue (url, parent_url, depth, job_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (url) DO NOTHING
      `, [normalizedUrl, parentUrl, depth, jobId]);
      
      logger.info('Added URL to queue', { 
        normalizedUrl, 
        parentUrl, 
        depth, 
        jobId 
      });
      return true;
    } catch (error) {
      logger.error('Error adding URL to queue', { url, error: error.message });
      return false;
    }
  }

  async getNextURLs(limit = 10) {
    try {
      // Fetch URLs ready for processing with retry limit and priority/FIFO ordering
      const result = await db.query(`
        SELECT id, url, parent_url, depth, job_id
        FROM url_queue
        WHERE status = 'pending' 
        AND scheduled_at <= NOW()
        AND attempts < 3
        ORDER BY priority DESC, created_at ASC
        LIMIT $1
      `, [limit]);

      // Atomically mark selected URLs as processing and increment attempt counter
      if (result.rows.length > 0) {
        const ids = result.rows.map(row => row.id);
        await db.query(`
          UPDATE url_queue 
          SET status = 'processing', attempts = attempts + 1
          WHERE id = ANY($1)
        `, [ids]);
      }

      return result.rows;
    } catch (error) {
      logger.error('Error getting next URLs', { error: error.message });
      return [];
    }
  }

  // Updates queue item status after crawl attempt with optional error details
  async markURLCompleted(urlId, success = true, errorMessage = null) {
    try {
      const status = success ? 'completed' : 'failed';
      await db.query(`
        UPDATE url_queue 
        SET status = $1, error_message = $2
        WHERE id = $3
      `, [status, errorMessage, urlId]);
    } catch (error) {
      logger.error('Error marking URL completed', { urlId, error: error.message });
    }
  }

  async rescheduleFailedURLs(delayMinutes = 60) {
    try {
      // Reset failed URLs to pending with future schedule time for exponential backoff
      const result = await db.query(`
        UPDATE url_queue 
        SET status = 'pending', 
            scheduled_at = NOW() + INTERVAL '${delayMinutes} minutes'
        WHERE status = 'failed' 
        AND attempts < 3
        RETURNING COUNT(*)
      `);
      
      logger.info('Rescheduled failed URLs', { count: result.rows[0].count });
    } catch (error) {
      logger.error('Error rescheduling failed URLs', { error: error.message });
    }
  }

  // Extracts URLs from HTML content using regex pattern matching on anchor tags
  extractURLsFromContent(content, baseUrl) {
    const urls = [];
    // Regex captures href attribute values from anchor tags with flexible spacing
    const urlRegex = /<a[^>]+href\s*=\s*['"](.*?)['"][^>]*>/gi;
    let match;

    while ((match = urlRegex.exec(content)) !== null) {
      try {
        const href = match[1];
        const absoluteUrl = new URL(href, baseUrl).toString();
        
        if (this.isValidURL(absoluteUrl)) {
          urls.push(absoluteUrl);
        }
      } catch (error) {
        // Invalid URL, skip
      }
    }

    // Convert to Set and back to Array for efficient duplicate removal
    return [...new Set(urls)];
  }

  async getQueueStats() {
    try {
      const result = await db.query(`
        SELECT 
          status,
          COUNT(*) as count
        FROM url_queue 
        GROUP BY status
      `);

      // Transform database rows into status->count object for easy consumption
      return result.rows.reduce((stats, row) => {
        stats[row.status] = parseInt(row.count);
        return stats;
      }, {});
    } catch (error) {
      logger.error('Error getting queue stats', { error: error.message });
      return {};
    }
  }
}

module.exports = new URLManager();