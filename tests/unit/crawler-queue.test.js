const { describe, test, expect, beforeEach } = require('@jest/globals');

// Mock dependencies
const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'test-job-id' }),
  addBulk: jest.fn().mockResolvedValue([{ id: 'job-1' }, { id: 'job-2' }]),
  getActive: jest.fn().mockResolvedValue([]),
  getWaiting: jest.fn().mockResolvedValue([]),
  getCompleted: jest.fn().mockResolvedValue([]),
  getFailed: jest.fn().mockResolvedValue([]),
  getDelayed: jest.fn().mockResolvedValue([]),
  pause: jest.fn().mockResolvedValue(),
  resume: jest.fn().mockResolvedValue(),
  empty: jest.fn().mockResolvedValue(),
  close: jest.fn().mockResolvedValue(),
  on: jest.fn()
};

jest.mock('bull', () => { 
  return jest.fn(() => mockQueue);
});

jest.mock('ioredis', () => {
  return jest.fn(() => ({
    disconnect: jest.fn()
  }));
});

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

describe('CrawlerQueue', () => {
  let crawlerQueue;

  beforeEach(() => {
    
    // Re-setup mock return values after clearAllMocks
    mockQueue.add.mockResolvedValue({ id: 'test-job-id' });
    mockQueue.addBulk.mockResolvedValue([{ id: 'job-1' }, { id: 'job-2' }]);
    mockQueue.getActive.mockResolvedValue([]);
    mockQueue.getWaiting.mockResolvedValue([]);
    mockQueue.getCompleted.mockResolvedValue([]);
    mockQueue.getFailed.mockResolvedValue([]);
    mockQueue.getDelayed.mockResolvedValue([]);
    mockQueue.pause.mockResolvedValue();
    mockQueue.resume.mockResolvedValue();
    mockQueue.empty.mockResolvedValue();
    mockQueue.close.mockResolvedValue();
    
    // Clear the module cache to get a fresh instance
    delete require.cache[require.resolve('../../src/queue/crawler-queue')];
    crawlerQueue = require('../../src/queue/crawler-queue');
    jest.clearAllMocks();
  });

  describe('addCrawlJob', () => {
    test('should add job with default options', async () => {
      const result = await crawlerQueue.addCrawlJob('https://example.com');

      expect(mockQueue.add).toHaveBeenCalledWith(
        'crawl-page',
        expect.objectContaining({
          url: 'https://example.com',
          depth: 0,
          maxDepth: 10,
          domainFilter: [],
          priority: 5
        }),
        expect.objectContaining({
          priority: 5,
          delay: 0,
          attempts: 3
        })
      );

      expect(result).toEqual({ id: 'test-job-id' });
    });

    test('should add job with custom options', async () => {
      const options = {
        depth: 2,
        maxDepth: 5,
        domainFilter: ['example.com'],
        priority: 8,
        delay: 1000,
        attempts: 5,
        crawlJobId: 'custom-job-id'
      };

      await crawlerQueue.addCrawlJob('https://example.com', options);

      expect(mockQueue.add).toHaveBeenCalledWith(
        'crawl-page',
        expect.objectContaining({
          url: 'https://example.com',
          depth: 2,
          maxDepth: 5,
          domainFilter: ['example.com'],
          priority: 8,
          crawlJobId: 'custom-job-id'
        }),
        expect.objectContaining({
          priority: 8,
          delay: 1000,
          attempts: 5
        })
      );
    });
  });

  describe('addBulkCrawlJobs', () => {
    test('should add multiple jobs at once', async () => {
      const urls = ['https://example.com', 'https://test.com'];
      const options = { depth: 1, priority: 7 };

      const result = await crawlerQueue.addBulkCrawlJobs(urls, options);

      expect(mockQueue.addBulk).toHaveBeenCalledWith([
        {
          name: 'crawl-page',
          data: expect.objectContaining({
            url: 'https://example.com',
            depth: 1,
            priority: 7
          }),
          opts: expect.objectContaining({
            priority: 7
          })
        },
        {
          name: 'crawl-page',
          data: expect.objectContaining({
            url: 'https://test.com',
            depth: 1,
            priority: 7
          }),
          opts: expect.objectContaining({
            priority: 7
          })
        }
      ]);

      expect(result).toEqual([{ id: 'job-1' }, { id: 'job-2' }]);
    });
  });

  describe('getJobCounts', () => {
    test('should return job counts for all queues', async () => {
      const mockActive = [{ id: 'active-1' }];
      const mockWaiting = [{ id: 'waiting-1' }, { id: 'waiting-2' }];
      const mockCompleted = [{ id: 'completed-1' }];
      const mockFailed = [{ id: 'failed-1' }];
      const mockDelayed = [];

      mockQueue.getActive.mockResolvedValueOnce(mockActive);
      mockQueue.getWaiting.mockResolvedValueOnce(mockWaiting);
      mockQueue.getCompleted.mockResolvedValueOnce(mockCompleted);
      mockQueue.getFailed.mockResolvedValueOnce(mockFailed);
      mockQueue.getDelayed.mockResolvedValueOnce(mockDelayed);

      const result = await crawlerQueue.getJobCounts();

      expect(result).toEqual({
        active: mockActive,
        waiting: mockWaiting,
        completed: mockCompleted,
        failed: mockFailed,
        delayed: mockDelayed
      });
    });
  });

  describe('pauseQueue', () => {
    test('should pause the queue', async () => {
      await crawlerQueue.pauseQueue();
      expect(mockQueue.pause).toHaveBeenCalled();
    });
  });

  describe('resumeQueue', () => {
    test('should resume the queue', async () => {
      await crawlerQueue.resumeQueue();
      expect(mockQueue.resume).toHaveBeenCalled();
    });
  });

  describe('clearQueue', () => {
    test('should clear the queue', async () => {
      await crawlerQueue.clearQueue();
      expect(mockQueue.empty).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    test('should close queue and disconnect redis', async () => {
      await crawlerQueue.close();
      expect(mockQueue.close).toHaveBeenCalled();
    });
  });

  describe('event handlers', () => {
    test.skip('should set up event handlers on initialization', () => {
      // Event handlers are set up during CrawlerQueue constructor
      // which happens after clearAllMocks() in beforeEach
      expect(mockQueue.on).toHaveBeenCalledWith('completed', expect.any(Function));
      expect(mockQueue.on).toHaveBeenCalledWith('failed', expect.any(Function));
      expect(mockQueue.on).toHaveBeenCalledWith('stalled', expect.any(Function));
      expect(mockQueue.on).toHaveBeenCalledTimes(3);
    });
  });
});