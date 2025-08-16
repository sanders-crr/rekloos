const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');

// Mock dependencies
jest.mock('../../src/queue/crawler-queue', () => ({
  crawlQueue: {
    process: jest.fn(),
    close: jest.fn()
  },
  getJobCounts: jest.fn().mockResolvedValue({
    active: [],
    waiting: [],
    completed: [],
    failed: []
  })
}));

jest.mock('../../src/services/crawler', () => ({
  initialize: jest.fn(),
  shutdown: jest.fn(),
  crawlURL: jest.fn()
}));

jest.mock('../../src/services/url-manager', () => ({
  getNextURLs: jest.fn(),
  markURLCompleted: jest.fn()
}));

jest.mock('../../src/database/connection', () => require('../mocks/database'));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

const CrawlerWorker = require('../../src/worker');
const crawlerQueue = require('../../src/queue/crawler-queue');
const crawler = require('../../src/services/crawler');
const urlManager = require('../../src/services/url-manager');
const db = require('../../src/database/connection');

describe('CrawlerWorker', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new CrawlerWorker();
  });

  afterEach(async () => {
    if (worker && !worker.isShuttingDown) {
      worker.isShuttingDown = true;
    }
  });

  describe('start', () => {
    test('should initialize crawler and start processing', async () => {
      crawler.initialize.mockResolvedValueOnce();
      
      await worker.start();

      expect(crawler.initialize).toHaveBeenCalled();
      expect(crawlerQueue.crawlQueue.process).toHaveBeenCalledWith(
        'crawl-page',
        5, // maxConcurrent
        expect.any(Function)
      );
    });

    test('should handle initialization errors', async () => {
      crawler.initialize.mockRejectedValueOnce(new Error('Init failed'));
      
      // Mock process.exit to prevent actual exit
      const mockExit = jest.spyOn(process, 'exit').mockImplementation();

      await worker.start();

      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });
  });

  describe('processCrawlJob', () => {
    const mockJob = {
      id: 'bull-job-id',
      data: {
        url: 'https://example.com',
        depth: 1,
        maxDepth: 3,
        domainFilter: ['example.com'],
        crawlJobId: 'db-job-id'
      },
      progress: jest.fn()
    };

    test('should process successful crawl job', async () => {
      const mockCrawlResult = {
        success: true,
        wordCount: 100,
        linksFound: 5
      };

      crawler.crawlURL.mockResolvedValueOnce(mockCrawlResult);
      db.query.mockResolvedValue({ rows: [] });

      const result = await worker.processCrawlJob(mockJob);

      expect(crawler.crawlURL).toHaveBeenCalledWith({
        url: 'https://example.com',
        depth: 1,
        maxDepth: 3,
        domainFilter: ['example.com']
      });

      expect(mockJob.progress).toHaveBeenCalledWith(100);
      expect(result).toEqual(mockCrawlResult);

      // Should update job status to completed
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE crawl_jobs'),
        expect.arrayContaining(['db-job-id'])
      );
    });

    test('should handle failed crawl job', async () => {
      const mockCrawlResult = {
        success: false,
        reason: 'robots.txt'
      };

      crawler.crawlURL.mockResolvedValueOnce(mockCrawlResult);
      db.query.mockResolvedValue({ rows: [] });

      const result = await worker.processCrawlJob(mockJob);

      expect(result).toEqual(mockCrawlResult);

      // Should update job status to failed
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE crawl_jobs'),
        expect.arrayContaining(['db-job-id', 'robots.txt'])
      );
    });

    test('should handle crawl errors', async () => {
      const mockError = new Error('Crawl error');
      crawler.crawlURL.mockRejectedValueOnce(mockError);
      db.query.mockResolvedValue({ rows: [] });

      await expect(worker.processCrawlJob(mockJob)).rejects.toThrow('Crawl error');

      // Should update job status to failed with error message
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE crawl_jobs'),
        expect.arrayContaining(['db-job-id', 'Crawl error'])
      );
    });

    test('should track active jobs', async () => {
      const mockCrawlResult = { success: true };
      crawler.crawlURL.mockResolvedValueOnce(mockCrawlResult);
      db.query.mockResolvedValue({ rows: [] });

      expect(worker.activeJobs.has('bull-job-id')).toBe(false);

      const promise = worker.processCrawlJob(mockJob);
      
      expect(worker.activeJobs.has('bull-job-id')).toBe(true);

      await promise;

      expect(worker.activeJobs.has('bull-job-id')).toBe(false);
    });
  });

  describe('startURLProcessingLoop', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('should process URLs from queue', async () => {
      const mockUrls = [
        { id: 'url-1', url: 'https://example.com', depth: 1, job_id: 'job-1' },
        { id: 'url-2', url: 'https://test.com', depth: 2, job_id: 'job-2' }
      ];

      urlManager.getNextURLs
        .mockResolvedValueOnce(mockUrls)
        .mockResolvedValue([]);
      
      crawlerQueue.addCrawlJob = jest.fn().mockResolvedValue({ id: 'new-job' });
      urlManager.markURLCompleted.mockResolvedValue();

      worker.startURLProcessingLoop();

      // Let the first iteration run
      await Promise.resolve();

      expect(urlManager.getNextURLs).toHaveBeenCalledWith(10);
      expect(crawlerQueue.addCrawlJob).toHaveBeenCalledTimes(2);
      expect(urlManager.markURLCompleted).toHaveBeenCalledTimes(2);

      worker.isShuttingDown = true;
    });

    test('should handle empty URL queue', async () => {
      urlManager.getNextURLs.mockResolvedValue([]);

      worker.startURLProcessingLoop();
      await Promise.resolve();

      expect(urlManager.getNextURLs).toHaveBeenCalledWith(10);
      expect(crawlerQueue.addCrawlJob).not.toHaveBeenCalled();

      worker.isShuttingDown = true;
    });

    test('should handle processing errors and retry', async () => {
      urlManager.getNextURLs
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValue([]);

      worker.startURLProcessingLoop();
      await Promise.resolve();

      // Should continue despite error
      expect(urlManager.getNextURLs).toHaveBeenCalled();

      worker.isShuttingDown = true;
    });
  });

  describe('shutdown', () => {
    test('should shutdown gracefully with no active jobs', async () => {
      crawler.shutdown.mockResolvedValueOnce();
      crawlerQueue.close.mockResolvedValueOnce();
      
      const mockExit = jest.spyOn(process, 'exit').mockImplementation();

      await worker.shutdown();

      expect(worker.isShuttingDown).toBe(true);
      expect(crawler.shutdown).toHaveBeenCalled();
      expect(crawlerQueue.close).toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);

      mockExit.mockRestore();
    });

    test('should wait for active jobs to complete', async () => {
      jest.useFakeTimers();
      
      worker.activeJobs.add('job-1');
      crawler.shutdown.mockResolvedValueOnce();
      crawlerQueue.close.mockResolvedValueOnce();
      
      const mockExit = jest.spyOn(process, 'exit').mockImplementation();

      const shutdownPromise = worker.shutdown();

      // Simulate job completion after 2 seconds
      setTimeout(() => {
        worker.activeJobs.delete('job-1');
      }, 2000);

      jest.advanceTimersByTime(2000);
      await shutdownPromise;

      expect(mockExit).toHaveBeenCalledWith(0);

      jest.useRealTimers();
      mockExit.mockRestore();
    });

    test('should force shutdown after timeout', async () => {
      jest.useFakeTimers();
      
      worker.activeJobs.add('job-1'); // Job never completes
      crawler.shutdown.mockResolvedValueOnce();
      crawlerQueue.close.mockResolvedValueOnce();
      
      const mockExit = jest.spyOn(process, 'exit').mockImplementation();

      const shutdownPromise = worker.shutdown();

      jest.advanceTimersByTime(31000); // Exceed 30 second timeout
      await shutdownPromise;

      expect(mockExit).toHaveBeenCalledWith(0);
      expect(worker.activeJobs.size).toBe(1); // Job still active

      jest.useRealTimers();
      mockExit.mockRestore();
    });
  });

  describe('getStats', () => {
    test('should return worker statistics', async () => {
      worker.activeJobs.add('job-1');
      worker.activeJobs.add('job-2');

      const mockQueueCounts = {
        active: [{ id: 'active-1' }],
        waiting: [{ id: 'waiting-1' }, { id: 'waiting-2' }],
        completed: [],
        failed: []
      };

      const mockUrlStats = {
        pending: 5,
        processing: 2,
        completed: 100,
        failed: 3
      };

      crawlerQueue.getJobCounts.mockResolvedValueOnce(mockQueueCounts);
      urlManager.getQueueStats = jest.fn().mockResolvedValueOnce(mockUrlStats);

      const stats = await worker.getStats();

      expect(stats).toEqual({
        activeJobs: 2,
        queueCounts: {
          active: 1,
          waiting: 2,
          completed: 0,
          failed: 0,
          delayed: 0
        },
        urlQueue: mockUrlStats
      });
    });

    test('should handle stats errors gracefully', async () => {
      crawlerQueue.getJobCounts.mockRejectedValueOnce(new Error('Stats error'));

      const stats = await worker.getStats();

      expect(stats).toBeNull();
    });
  });
});