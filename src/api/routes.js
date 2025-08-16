const express = require('express');
const rateLimit = require('express-rate-limit');
const crawlerQueue = require('../queue/crawler-queue');
const elasticsearchService = require('../services/elasticsearch-service');
const urlManager = require('../services/url-manager');
const db = require('../database/connection');
const logger = require('../utils/logger');

const router = express.Router();

// Rate limiting
const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many search requests, please try again later'
});

const crawlLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 crawl requests per windowMs
  message: 'Too many crawl requests, please try again later'
});

// Search endpoints
router.get('/search', searchLimiter, async (req, res) => {
  try {
    const { q, from = 0, size = 10, domain, contentType, language, dateFrom, dateTo } = req.query;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    const filters = {};
    if (domain) filters.domain = domain;
    if (contentType) filters.contentType = contentType;
    if (language) filters.language = language;
    if (dateFrom || dateTo) {
      filters.dateRange = {};
      if (dateFrom) filters.dateRange.from = dateFrom;
      if (dateTo) filters.dateRange.to = dateTo;
    }

    const results = await elasticsearchService.search(q, {
      from: parseInt(from),
      size: parseInt(size),
      filters
    });

    res.json({
      query: q,
      total: results.total,
      hits: results.hits,
      from: parseInt(from),
      size: parseInt(size)
    });

  } catch (error) {
    logger.error('Search API error', { error: error.message, query: req.query });
    res.status(500).json({ error: 'Search failed' });
  }
});

router.get('/suggest', searchLimiter, async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json({ suggestions: [] });
    }

    // Simple suggestion implementation
    // In production, you might want to use Elasticsearch completion suggester
    const results = await elasticsearchService.search(q, { size: 5 });
    
    const suggestions = results.hits.map(hit => ({
      text: hit.source.title,
      url: hit.source.url
    }));

    res.json({ suggestions });

  } catch (error) {
    logger.error('Suggest API error', { error: error.message, query: req.query });
    res.status(500).json({ error: 'Suggestion failed' });
  }
});

// Crawl management endpoints
router.post('/crawl', crawlLimiter, async (req, res) => {
  try {
    const { url, maxDepth = 3, domainFilter = [], priority = 5 } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Check if domain is allowed (if filter is specified)
    if (domainFilter.length > 0 && !urlManager.shouldCrawlDomain(url, domainFilter)) {
      return res.status(400).json({ error: 'Domain not allowed' });
    }

    // Create database crawl job first
    const dbResult = await db.query(`
      INSERT INTO crawl_jobs (url, max_depth, domain_filter, priority, status)
      VALUES ($1, $2, $3, $4, 'pending')
      RETURNING id
    `, [url, maxDepth, domainFilter, priority]);
    
    const crawlJobId = dbResult.rows[0].id;

    // Add to Bull queue with reference to database job
    const job = await crawlerQueue.addCrawlJob(url, {
      maxDepth,
      domainFilter,
      priority,
      crawlJobId
    });

    // Also add to URL queue for processing
    await urlManager.addURLToQueue(url, null, 0, crawlJobId);

    res.json({
      jobId: crawlJobId,
      bullJobId: job.id,
      url,
      maxDepth,
      domainFilter,
      priority,
      status: 'queued'
    });

  } catch (error) {
    logger.error('Crawl API error', { error: error.message, body: req.body });
    res.status(500).json({ error: 'Failed to start crawl' });
  }
});

router.get('/crawl/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    const job = await crawlerQueue.crawlQueue.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const state = await job.getState();
    const progress = job.progress();

    res.json({
      jobId,
      state,
      progress,
      data: job.data,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason
    });

  } catch (error) {
    logger.error('Crawl status API error', { error: error.message, jobId: req.params.jobId });
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

// Statistics endpoints
router.get('/stats', async (req, res) => {
  try {
    const [queueStats, docCount, crawlStats] = await Promise.all([
      urlManager.getQueueStats(),
      elasticsearchService.getDocumentCount(),
      getCrawlStats()
    ]);

    res.json({
      urlQueue: queueStats,
      documentsIndexed: docCount,
      crawlStats
    });

  } catch (error) {
    logger.error('Stats API error', { error: error.message });
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

async function getCrawlStats() {
  try {
    const result = await db.query(`
      SELECT 
        COUNT(*) as total_pages,
        COUNT(*) FILTER (WHERE indexed = true) as indexed_pages,
        COUNT(*) FILTER (WHERE last_crawled > NOW() - INTERVAL '24 hours') as crawled_today,
        COUNT(DISTINCT domain) as unique_domains,
        AVG(word_count) as avg_word_count
      FROM crawled_pages
    `);

    const stats = result.rows[0];
    return {
      totalPages: parseInt(stats.total_pages),
      indexedPages: parseInt(stats.indexed_pages),
      crawledToday: parseInt(stats.crawled_today),
      uniqueDomains: parseInt(stats.unique_domains),
      avgWordCount: Math.round(parseFloat(stats.avg_word_count) || 0)
    };
  } catch (error) {
    logger.error('Error getting crawl stats', { error: error.message });
    return {};
  }
}

// Document management endpoints
router.delete('/documents/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    
    // Decode URL from document ID
    const url = Buffer.from(documentId, 'base64url').toString();
    
    // Delete from Elasticsearch
    await elasticsearchService.deleteDocument(url);
    
    // Mark as not indexed in database
    await db.query(
      'UPDATE crawled_pages SET indexed = false WHERE url = $1',
      [url]
    );

    res.json({ message: 'Document deleted successfully' });

  } catch (error) {
    logger.error('Delete document API error', { 
      error: error.message, 
      documentId: req.params.documentId 
    });
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// Health check endpoint
router.get('/health', async (req, res) => {
  try {
    // Check database connection
    await db.query('SELECT 1');
    
    // Check Elasticsearch connection
    await elasticsearchService.client.ping();

    res.json({ 
      status: 'healthy',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(503).json({ 
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;