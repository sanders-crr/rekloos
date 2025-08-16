const URL = require('url-parse');
const db = require('../database/connection');
const logger = require('../utils/logger');

class URLManager {
  constructor() {
    this.seenUrls = new Set();
  }

  normalizeURL(url) {
    try {
      const parsed = new URL(url, true);
      
      // Remove fragment
      parsed.set('hash', '');
      
      // Sort query parameters for consistency
      const sortedQuery = Object.keys(parsed.query)
        .sort()
        .reduce((result, key) => {
          result[key] = parsed.query[key];
          return result;
        }, {});
      
      parsed.set('query', sortedQuery);
      
      // Remove trailing slash for consistency
      if (parsed.pathname.endsWith('/') && parsed.pathname.length > 1) {
        parsed.set('pathname', parsed.pathname.slice(0, -1));
      }
      
      return parsed.toString();
    } catch (error) {
      logger.error('URL normalization failed', { url, error: error.message });
      return null;
    }
  }

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

  shouldCrawlDomain(url, allowedDomains = []) {
    if (allowedDomains.length === 0) return true;
    
    const domain = this.extractDomain(url);
    if (!domain) return false;
    
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

    if (this.seenUrls.has(normalizedUrl)) {
      return false;
    }

    this.seenUrls.add(normalizedUrl);

    try {
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
      const result = await db.query(`
        SELECT id, url, parent_url, depth, job_id
        FROM url_queue
        WHERE status = 'pending' 
        AND scheduled_at <= NOW()
        AND attempts < 3
        ORDER BY priority DESC, created_at ASC
        LIMIT $1
      `, [limit]);

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

  extractURLsFromContent(content, baseUrl) {
    const urls = [];
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

    return [...new Set(urls)]; // Remove duplicates
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