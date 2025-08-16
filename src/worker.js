const crawlerQueue = require('./queue/crawler-queue');
const crawler = require('./services/crawler');
const urlManager = require('./services/url-manager');
const db = require('./database/connection');
const logger = require('./utils/logger');
const config = require('./config');

class CrawlerWorker {
  constructor() {
    this.isShuttingDown = false;
    this.activeJobs = new Set();
  }

  async start() {
    try {
      // Initialize crawler (sets up Puppeteer and Elasticsearch)
      await crawler.initialize();
      
      // Process crawl jobs
      crawlerQueue.crawlQueue.process('crawl-page', config.crawler.maxConcurrent, async (job) => {
        logger.info('Bull queue received job', { 
          jobId: job.id, 
          url: job.data.url,
          depth: job.data.depth 
        });
        return this.processCrawlJob(job);
      });

      // Start URL processing loop
      this.startURLProcessingLoop();

      logger.info('Crawler worker started', { 
        maxConcurrent: config.crawler.maxConcurrent 
      });

      // Graceful shutdown handlers
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());

    } catch (error) {
      logger.error('Failed to start crawler worker', { error: error.message });
      process.exit(1);
    }
  }

  async processCrawlJob(job) {
    const { url, depth, maxDepth, domainFilter, crawlJobId } = job.data;
    const bullJobId = job.id;

    this.activeJobs.add(bullJobId);
    
    try {
      logger.info('Processing crawl job', { bullJobId, crawlJobId, url, depth });

      // Update database job status to 'in_progress'
      if (crawlJobId) {
        await db.query(`
          UPDATE crawl_jobs 
          SET status = 'in_progress', started_at = NOW()
          WHERE id = $1
        `, [crawlJobId]);
      }

      const result = await crawler.crawlURL({
        url,
        depth,
        maxDepth,
        domainFilter
      });

      if (result.success) {
        job.progress(100);
        
        // Update database job status to 'completed'
        if (crawlJobId) {
          await db.query(`
            UPDATE crawl_jobs 
            SET status = 'completed', completed_at = NOW(), pages_crawled = pages_crawled + 1
            WHERE id = $1
          `, [crawlJobId]);
        }
        
        logger.info('Crawl job completed', { 
          bullJobId,
          crawlJobId, 
          url, 
          skipped: result.skipped,
          wordCount: result.wordCount,
          linksFound: result.linksFound
        });
      } else {
        // Update database job status to 'failed'
        if (crawlJobId) {
          await db.query(`
            UPDATE crawl_jobs 
            SET status = 'failed', completed_at = NOW(), error_message = $2
            WHERE id = $1
          `, [crawlJobId, result.reason]);
        }
        
        logger.warn('Crawl job failed', { bullJobId, crawlJobId, url, reason: result.reason });
      }

      return result;

    } catch (error) {
      // Update database job status to 'failed'
      if (crawlJobId) {
        await db.query(`
          UPDATE crawl_jobs 
          SET status = 'failed', completed_at = NOW(), error_message = $2
          WHERE id = $1
        `, [crawlJobId, error.message]);
      }
      
      logger.error('Crawl job error', { bullJobId, crawlJobId, url, error: error.message });
      throw error;
    } finally {
      this.activeJobs.delete(bullJobId);
    }
  }

  async startURLProcessingLoop() {
    const processURLs = async () => {
      if (this.isShuttingDown) return;

      try {
        const urls = await urlManager.getNextURLs(10);
        
        if (urls.length > 0) {
          logger.debug('Processing URLs from queue', { count: urls.length });
          
          for (const urlData of urls) {
            if (this.isShuttingDown) break;
            
            // Add to Bull queue for processing
            await crawlerQueue.addCrawlJob(urlData.url, {
              depth: urlData.depth,
              maxDepth: 10, // Default max depth for discovered URLs
              domainFilter: [],
              priority: 5,
              crawlJobId: urlData.job_id
            });

            await urlManager.markURLCompleted(urlData.id, true);
          }
        }

        // Schedule next iteration
        setTimeout(processURLs, 5000); // Check every 5 seconds
        
      } catch (error) {
        logger.error('URL processing loop error', { error: error.message });
        setTimeout(processURLs, 10000); // Retry after 10 seconds on error
      }
    };

    processURLs();
  }

  async shutdown() {
    if (this.isShuttingDown) return;
    
    this.isShuttingDown = true;
    logger.info('Shutting down crawler worker...');

    try {
      // Wait for active jobs to complete (with timeout)
      const maxWaitTime = 30000; // 30 seconds
      const startTime = Date.now();
      
      while (this.activeJobs.size > 0 && (Date.now() - startTime) < maxWaitTime) {
        logger.info('Waiting for active jobs to complete', { 
          activeJobs: this.activeJobs.size 
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Force close if jobs are still running
      if (this.activeJobs.size > 0) {
        logger.warn('Force closing with active jobs', { 
          activeJobs: this.activeJobs.size 
        });
      }

      await crawlerQueue.close();
      await crawler.shutdown();
      
      logger.info('Crawler worker shutdown complete');
      process.exit(0);

    } catch (error) {
      logger.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
  }

  async getStats() {
    try {
      const queueCounts = await crawlerQueue.getJobCounts();
      const queueStats = await urlManager.getQueueStats();
      
      return {
        activeJobs: this.activeJobs.size,
        queueCounts: {
          active: queueCounts.active?.length || 0,
          waiting: queueCounts.waiting?.length || 0,
          completed: queueCounts.completed?.length || 0,
          failed: queueCounts.failed?.length || 0,
          delayed: queueCounts.delayed?.length || 0
        },
        urlQueue: queueStats
      };
    } catch (error) {
      logger.error('Error getting worker stats', { error: error.message });
      return null;
    }
  }
}

// Start worker if this file is run directly
if (require.main === module) {
  const worker = new CrawlerWorker();
  worker.start().catch(error => {
    logger.error('Worker startup failed', { error: error.message });
    process.exit(1);
  });
}

module.exports = CrawlerWorker;