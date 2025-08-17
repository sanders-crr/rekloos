const axios = require('axios');
const puppeteer = require('puppeteer');
const mime = require('mime-types');
const URL = require('url-parse');
const db = require('../database/connection');
const logger = require('../utils/logger');
const config = require('../config');
const contentExtractor = require('./content-extractor');
const elasticsearchService = require('./elasticsearch-service');
const robotsService = require('./robots-service');
const rateLimiter = require('./rate-limiter');
const urlManager = require('./url-manager');

// Main crawler orchestrating the crawl process with dual-mode fetching (HTTP vs Puppeteer) and queue-driven URL discovery. Manages the complete lifecycle from URL validation to content indexing.
class Crawler {
  constructor() {
    this.browser = null;
    this.isShuttingDown = false;
  }

  // Initialize Puppeteer browser instance with headless mode and optimized flags for server environments
  async initialize() {
    try {
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      });
      
      logger.info('Crawler initialized');
    } catch (error) {
      logger.error('Failed to initialize crawler', { error: error.message });
      throw error;
    }
  }

  async crawlURL(urlData) {
    const { url, depth = 0, maxDepth = 3, domainFilter = [] } = urlData;
    
    try {
      logger.info('Starting crawl', { url, depth, maxDepth });

      // Recrawl prevention: skip URLs crawled within threshold to avoid duplicate work
      if (await this.isRecentlyCrawled(url)) {
        logger.debug('URL recently crawled, skipping', { url });
        return { success: true, skipped: true };
      }

      // Check robots.txt
      const robotsCheck = await robotsService.canCrawl(url);
      if (!robotsCheck.allowed) {
        logger.warn('URL disallowed by robots.txt', { url });
        await this.markURLProcessed(url, false, 'Disallowed by robots.txt');
        return { success: false, reason: 'robots.txt' };
      }

      // Apply rate limiting
      const domain = new URL(url).hostname;
      await rateLimiter.setDomainDelay(domain, robotsCheck.delay * 1000);
      await rateLimiter.wait(domain);

      // Crawl the page
      const crawlResult = await this.fetchPage(url);
      if (!crawlResult.success) {
        await this.markURLProcessed(url, false, crawlResult.error);
        return crawlResult;
      }

      // Extract content
      const extractedContent = contentExtractor.extractContent(
        crawlResult.content,
        crawlResult.contentType,
        url
      );

      if (!extractedContent) {
        logger.warn('Failed to extract content', { url });
        await this.markURLProcessed(url, false, 'Content extraction failed');
        return { success: false, reason: 'extraction' };
      }

      // Save to database
      await this.saveCrawledPage(url, extractedContent, crawlResult);

      // Index in Elasticsearch
      const document = {
        url,
        ...extractedContent,
        contentType: crawlResult.contentType,
        lastModified: crawlResult.lastModified ? new Date(crawlResult.lastModified).toISOString() : null
      };

      await elasticsearchService.indexDocument(document);

      // Depth-limited URL discovery: prevents infinite crawling while building comprehensive site maps
      if (depth < maxDepth && extractedContent.links) {
        await this.queueNewURLs(extractedContent.links, url, depth + 1, domainFilter);
      }

      await this.markURLProcessed(url, true);
      
      logger.info('Successfully crawled URL', { 
        url, 
        wordCount: extractedContent.wordCount,
        linksFound: extractedContent.links?.length || 0
      });

      return { 
        success: true, 
        wordCount: extractedContent.wordCount,
        linksFound: extractedContent.links?.length || 0
      };

    } catch (error) {
      logger.error('Crawl failed', { url, error: error.message });
      await this.markURLProcessed(url, false, error.message);
      return { success: false, error: error.message };
    }
  }

  async fetchPage(url) {
    try {
      const startTime = Date.now();
      
      // HTTP-first strategy: faster and more efficient for static content before falling back to Puppeteer
      const httpResult = await this.fetchWithHTTP(url);
      if (httpResult.success) {
        logger.debug('Fetched with HTTP', { 
          url, 
          duration: Date.now() - startTime,
          size: httpResult.content?.length || 0
        });
        return httpResult;
      }

      // Puppeteer fallback: handles JavaScript-rendered content that HTTP requests can't access
      const puppeteerResult = await this.fetchWithPuppeteer(url);
      logger.debug('Fetched with Puppeteer', { 
        url, 
        duration: Date.now() - startTime,
        size: puppeteerResult.content?.length || 0
      });
      
      return puppeteerResult;

    } catch (error) {
      logger.error('Page fetch failed', { url, error: error.message });
      return { success: false, error: error.message };
    }
  }

  // HTTP fetching: lightweight and fast for static HTML content using axios with proper headers
  async fetchWithHTTP(url) {
    try {
      const response = await axios.get(url, {
        timeout: config.crawler.requestTimeout,
        maxContentLength: config.crawler.maxPageSize,
        // Browser-like headers to avoid being blocked by anti-bot measures
        headers: {
          'User-Agent': config.crawler.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive'
        },
        validateStatus: (status) => status < 400
      });

      const contentType = response.headers['content-type'] || 'text/html';
      const mimeType = mime.lookup(contentType) || contentType.split(';')[0];

      if (!config.crawler.allowedContentTypes.includes(mimeType)) {
        return { success: false, error: 'Unsupported content type' };
      }

      return {
        success: true,
        content: response.data,
        contentType: mimeType,
        statusCode: response.status,
        lastModified: response.headers['last-modified'],
        headers: response.headers
      };

    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        return { success: false, error: 'Connection failed' };
      }
      
      if (error.response?.status >= 400) {
        return { success: false, error: `HTTP ${error.response.status}` };
      }

      return { success: false, error: error.message };
    }
  }

  // Puppeteer fetching: full browser automation for JavaScript-heavy sites with resource blocking for performance
  async fetchWithPuppeteer(url) {
    let page = null;
    
    try {
      if (!this.browser) {
        await this.initialize();
      }

      page = await this.browser.newPage();
      
      await page.setUserAgent(config.crawler.userAgent);
      await page.setViewport({ width: 1366, height: 768 });
      
      // Resource blocking: disable images, CSS, fonts to speed up crawling and focus on text content
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.crawler.requestTimeout
      });

      const statusCode = response.status();
      if (statusCode >= 400) {
        return { success: false, error: `HTTP ${statusCode}` };
      }

      // Fixed delay to allow JavaScript rendering and AJAX requests to complete
      await page.waitForTimeout(2000);

      const content = await page.content();
      const contentType = response.headers()['content-type'] || 'text/html';

      return {
        success: true,
        content,
        contentType: contentType.split(';')[0],
        statusCode,
        lastModified: response.headers()['last-modified']
      };

    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  async isRecentlyCrawled(url, hoursThreshold = 24) {
    try {
      const result = await db.query(`
        SELECT last_crawled 
        FROM crawled_pages 
        WHERE url = $1 
        AND last_crawled > NOW() - INTERVAL '${hoursThreshold} hours'
      `, [url]);

      return result.rows.length > 0;
    } catch (error) {
      logger.error('Error checking if recently crawled', { url, error: error.message });
      return false;
    }
  }

  async saveCrawledPage(url, extractedContent, crawlResult) {
    try {
      const domain = new URL(url).hostname;
      
      await db.query(`
        INSERT INTO crawled_pages (
          url, title, content_hash, last_crawled, last_modified,
          status_code, content_type, word_count, domain, indexed
        )
        VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, true)
        ON CONFLICT (url) 
        DO UPDATE SET
          title = EXCLUDED.title,
          content_hash = EXCLUDED.content_hash,
          last_crawled = NOW(),
          last_modified = EXCLUDED.last_modified,
          status_code = EXCLUDED.status_code,
          content_type = EXCLUDED.content_type,
          word_count = EXCLUDED.word_count,
          indexed = EXCLUDED.indexed,
          error_count = 0
      `, [
        url,
        extractedContent.title,
        extractedContent.contentHash,
        crawlResult.lastModified || null,
        crawlResult.statusCode,
        crawlResult.contentType,
        extractedContent.wordCount,
        domain
      ]);

    } catch (error) {
      logger.error('Error saving crawled page', { url, error: error.message });
      throw error;
    }
  }

  // Queue management: validates and filters discovered URLs before adding to crawl queue for breadth-first traversal
  async queueNewURLs(links, parentUrl, depth, domainFilter) {
    const validUrls = [];
    
    // Multi-stage filtering: URL format → domain whitelist → duplicate check
    for (const link of links) {
      if (!urlManager.isValidURL(link.url)) continue;
      if (!urlManager.shouldCrawlDomain(link.url, domainFilter)) continue;
      if (await urlManager.isURLCrawled(link.url)) continue;
      
      validUrls.push(link.url);
    }

    // Batch queue operations: add valid URLs with parent tracking for link graph reconstruction
    if (validUrls.length > 0) {
      for (const url of validUrls) {
        await urlManager.addURLToQueue(url, parentUrl, depth);
      }
      
      logger.debug('Queued new URLs', { 
        parentUrl, 
        count: validUrls.length,
        depth 
      });
    }
  }

  // Queue status management: updates URL processing status for worker coordination and retry logic
  async markURLProcessed(url, success, errorMessage = null) {
    try {
      const status = success ? 'completed' : 'failed';
      await db.query(`
        UPDATE url_queue 
        SET status = $1, error_message = $2
        WHERE url = $3
      `, [status, errorMessage, url]);
    } catch (error) {
      logger.error('Error marking URL processed', { url, error: error.message });
    }
  }

  async shutdown() {
    this.isShuttingDown = true;
    
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      
      await rateLimiter.close();
      logger.info('Crawler shutdown complete');
    } catch (error) {
      logger.error('Error during crawler shutdown', { error: error.message });
    }
  }
}

module.exports = new Crawler();