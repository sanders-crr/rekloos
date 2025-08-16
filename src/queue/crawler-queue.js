const Queue = require('bull');
const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

class CrawlerQueue {
  constructor() {
    this.redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: config.redis.maxRetriesPerRequest
    });
    
    this.crawlQueue = new Queue('crawl jobs', {
      redis: config.redis.url,
      defaultJobOptions: config.queue.defaultJobOptions
    });

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.crawlQueue.on('completed', (job, result) => {
      logger.info('Job completed', { jobId: job.id, result });
    });

    this.crawlQueue.on('failed', (job, err) => {
      logger.error('Job failed', { jobId: job.id, error: err.message });
    });

    this.crawlQueue.on('stalled', (job) => {
      logger.warn('Job stalled', { jobId: job.id });
    });
  }

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

    const job = await this.crawlQueue.add('crawl-page', jobData, {
      priority: jobData.priority,
      delay: options.delay || 0,
      attempts: options.attempts || 3
    });

    logger.info('Added crawl job', { jobId: job.id, url });
    return job;
  }

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

    const addedJobs = await this.crawlQueue.addBulk(jobs);
    logger.info('Added bulk crawl jobs', { count: addedJobs.length });
    return addedJobs;
  }

  async getJobCounts() {
    return {
      active: await this.crawlQueue.getActive(),
      waiting: await this.crawlQueue.getWaiting(),
      completed: await this.crawlQueue.getCompleted(),
      failed: await this.crawlQueue.getFailed(),
      delayed: await this.crawlQueue.getDelayed()
    };
  }

  async pauseQueue() {
    await this.crawlQueue.pause();
    logger.info('Crawler queue paused');
  }

  async resumeQueue() {
    await this.crawlQueue.resume();
    logger.info('Crawler queue resumed');
  }

  async clearQueue() {
    await this.crawlQueue.empty();
    logger.info('Crawler queue cleared');
  }

  async close() {
    await this.crawlQueue.close();
    this.redis.disconnect();
  }
}

module.exports = new CrawlerQueue();