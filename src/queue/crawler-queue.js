const Queue = require('bull');
const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

// Redis-backed job queue using Bull for managing crawler tasks with priority, retry, and bulk operations. Provides distributed task coordination across multiple worker instances.
class CrawlerQueue {
  constructor() {
    // Direct Redis connection for queue operations and health monitoring
    this.redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: config.redis.maxRetriesPerRequest
    });
    
    // Bull queue instance for job management with Redis persistence and distributed processing
    this.crawlQueue = new Queue('crawl jobs', {
      redis: config.redis.url,
      defaultJobOptions: config.queue.defaultJobOptions
    });

    this.setupEventHandlers();
  }

  // Event-driven monitoring of job lifecycle for debugging and metrics collection
  setupEventHandlers() {
    this.crawlQueue.on('completed', (job, result) => {
      logger.info('Job completed', { jobId: job.id, result });
    });

    this.crawlQueue.on('failed', (job, err) => {
      logger.error('Job failed', { jobId: job.id, error: err.message });
    });

    // Stalled jobs indicate worker timeouts or crashes requiring intervention
    this.crawlQueue.on('stalled', (job) => {
      logger.warn('Job stalled', { jobId: job.id });
    });
  }

  // Adds single crawl job with configurable options for depth-limited crawling and priority scheduling
  async addCrawlJob(url, options = {}) {
    const jobData = {
      url,
      depth: options.depth || 0,
      maxDepth: options.maxDepth || config.crawler.maxDepth,
      domainFilter: options.domainFilter || [],
      priority: options.priority || 5,
      parentJobId: options.parentJobId || null,
      ...options
    };

    // Bull job creation with priority queue ordering and retry configuration
    const job = await this.crawlQueue.add('crawl-page', jobData, {
      priority: jobData.priority,
      delay: options.delay || 0,
      attempts: options.attempts || 3
    });

    logger.info('Added crawl job', { jobId: job.id, url });
    return job;
  }

  // Bulk job addition for efficient batch processing of multiple URLs with shared configuration
  async addBulkCrawlJobs(urls, options = {}) {
    const jobs = urls.map(url => ({
      name: 'crawl-page',
      data: {
        url,
        depth: options.depth || 0,
        maxDepth: options.maxDepth || config.crawler.maxDepth,
        domainFilter: options.domainFilter || [],
        priority: options.priority || 5,
        ...options
      },
      opts: {
        priority: options.priority || 5,
        delay: options.delay || 0
      }
    }));

    // Single Redis transaction for atomic bulk insertion, more efficient than individual adds
    const addedJobs = await this.crawlQueue.addBulk(jobs);
    logger.info('Added bulk crawl jobs', { count: addedJobs.length });
    return addedJobs;
  }

  // Queue monitoring: retrieves job counts across all states for dashboard and health checks
  async getJobCounts() {
    return {
      active: await this.crawlQueue.getActive(),
      waiting: await this.crawlQueue.getWaiting(),
      completed: await this.crawlQueue.getCompleted(),
      failed: await this.crawlQueue.getFailed(),
      delayed: await this.crawlQueue.getDelayed()
    };
  }

  // Queue control: pause prevents new job processing while allowing current jobs to complete
  async pauseQueue() {
    await this.crawlQueue.pause();
    logger.info('Crawler queue paused');
  }

  // Resume restarts job processing from the waiting queue
  async resumeQueue() {
    await this.crawlQueue.resume();
    logger.info('Crawler queue resumed');
  }

  // Removes all pending jobs from queue (does not affect active jobs)
  async clearQueue() {
    await this.crawlQueue.empty();
    logger.info('Crawler queue cleared');
  }

  // Graceful shutdown: closes Bull queue and Redis connections for clean process termination
  async close() {
    await this.crawlQueue.close();
    this.redis.disconnect();
  }
}

module.exports = new CrawlerQueue();