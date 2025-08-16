const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');
const request = require('supertest');
const express = require('express');

// Mock all dependencies
jest.mock('../../src/database/connection', () => require('../mocks/database'));
jest.mock('@elastic/elasticsearch', () => require('../mocks/elasticsearch'));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

// Mock services
jest.mock('../../src/services/elasticsearch-service', () => ({
  searchDocuments: jest.fn(),
  getStats: jest.fn().mockResolvedValue({ documentCount: 100, indexSize: '1 MB' })
}));

jest.mock('../../src/queue/crawler-queue', () => ({
  addCrawlJob: jest.fn().mockResolvedValue({ id: 'test-job-id' }),
  getJobCounts: jest.fn().mockResolvedValue({
    active: [],
    waiting: [],
    completed: [],
    failed: []
  })
}));

jest.mock('../../src/worker', () => ({
  getStats: jest.fn().mockResolvedValue({
    activeJobs: 0,
    queueCounts: { active: 0, waiting: 0 }
  })
}));

const db = require('../../src/database/connection');
const elasticsearchService = require('../../src/services/elasticsearch-service');
const crawlerQueue = require('../../src/queue/crawler-queue');

describe('API Routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create express app with routes
    app = express();
    app.use(express.json());
    app.use('/api', require('../../src/api/routes'));
  });

  describe('POST /api/crawl', () => {
    test('should initiate crawl job successfully', async () => {
      const mockJobId = 'test-job-uuid';
      db.query.mockResolvedValueOnce({
        rows: [{ id: mockJobId }]
      });

      const response = await request(app)
        .post('/api/crawl')
        .send({
          url: 'https://example.com',
          maxDepth: 2,
          domainFilter: ['example.com']
        })
        .expect(200);

      expect(response.body).toMatchObject({
        jobId: mockJobId,
        url: 'https://example.com',
        maxDepth: 2,
        domainFilter: ['example.com'],
        status: 'queued'
      });

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO crawl_jobs'),
        expect.arrayContaining(['https://example.com', 2, ['example.com']])
      );

      expect(crawlerQueue.addCrawlJob).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          maxDepth: 2,
          domainFilter: ['example.com'],
          crawlJobId: mockJobId
        })
      );
    });

    test('should use default values for optional parameters', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'test-job-uuid' }]
      });

      const response = await request(app)
        .post('/api/crawl')
        .send({ url: 'https://example.com' })
        .expect(200);

      expect(response.body).toMatchObject({
        maxDepth: 3,
        domainFilter: [],
        priority: 5
      });
    });

    test('should validate required URL parameter', async () => {
      const response = await request(app)
        .post('/api/crawl')
        .send({})
        .expect(400);

      expect(response.body).toMatchObject({
        error: 'URL is required'
      });
    });

    test('should validate URL format', async () => {
      const response = await request(app)
        .post('/api/crawl')
        .send({ url: 'not-a-url' })
        .expect(400);

      expect(response.body).toMatchObject({
        error: 'Invalid URL format'
      });
    });

    test('should handle database errors', async () => {
      db.query.mockRejectedValueOnce(new Error('Database error'));

      const response = await request(app)
        .post('/api/crawl')
        .send({ url: 'https://example.com' })
        .expect(500);

      expect(response.body).toMatchObject({
        error: 'Failed to create crawl job'
      });
    });
  });

  describe('GET /api/crawl/status/:jobId', () => {
    test('should return job status successfully', async () => {
      const mockJob = {
        id: 'test-job-id',
        url: 'https://example.com',
        status: 'completed',
        priority: 5,
        depth: 0,
        max_depth: 3,
        created_at: '2023-01-01T00:00:00Z',
        completed_at: '2023-01-01T00:01:00Z',
        pages_crawled: 5,
        pages_indexed: 5
      };

      db.query.mockResolvedValueOnce({ rows: [mockJob] });

      const response = await request(app)
        .get('/api/crawl/status/test-job-id')
        .expect(200);

      expect(response.body).toEqual(mockJob);
    });

    test('should return 404 for non-existent job', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .get('/api/crawl/status/non-existent-id')
        .expect(404);

      expect(response.body).toMatchObject({
        error: 'Job not found'
      });
    });
  });

  describe('GET /api/search', () => {
    test('should perform search successfully', async () => {
      const mockSearchResults = {
        total: 2,
        results: [
          { url: 'https://example.com', title: 'Test Page 1', score: 1.0 },
          { url: 'https://test.com', title: 'Test Page 2', score: 0.8 }
        ]
      };

      elasticsearchService.searchDocuments.mockResolvedValueOnce(mockSearchResults);

      const response = await request(app)
        .get('/api/search?q=test&domain=example.com&size=10&from=0')
        .expect(200);

      expect(response.body).toEqual(mockSearchResults);
      expect(elasticsearchService.searchDocuments).toHaveBeenCalledWith('test', {
        domain: 'example.com',
        size: 10,
        from: 0
      });
    });

    test('should require search query', async () => {
      const response = await request(app)
        .get('/api/search')
        .expect(400);

      expect(response.body).toMatchObject({
        error: 'Search query is required'
      });
    });

    test('should handle search errors', async () => {
      elasticsearchService.searchDocuments.mockRejectedValueOnce(new Error('Search failed'));

      const response = await request(app)
        .get('/api/search?q=test')
        .expect(500);

      expect(response.body).toMatchObject({
        error: 'Search failed'
      });
    });
  });

  describe('GET /api/jobs', () => {
    test('should list crawl jobs successfully', async () => {
      const mockJobs = [
        {
          id: 'job-1',
          url: 'https://example.com',
          status: 'completed',
          created_at: '2023-01-01T00:00:00Z'
        },
        {
          id: 'job-2',
          url: 'https://test.com',
          status: 'pending',
          created_at: '2023-01-01T00:05:00Z'
        }
      ];

      db.query.mockResolvedValueOnce({ rows: mockJobs });

      const response = await request(app)
        .get('/api/jobs?limit=10&offset=0')
        .expect(200);

      expect(response.body).toEqual(mockJobs);
    });

    test('should filter jobs by status', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .get('/api/jobs?status=completed')
        .expect(200);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE status = $1'),
        expect.arrayContaining(['completed'])
      );
    });
  });

  describe('DELETE /api/crawl/:jobId', () => {
    test('should cancel pending job successfully', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{ status: 'pending' }] })
        .mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .delete('/api/crawl/test-job-id')
        .expect(200);

      expect(response.body).toMatchObject({
        message: 'Job cancelled successfully'
      });
    });

    test('should not cancel completed jobs', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ status: 'completed' }] });

      const response = await request(app)
        .delete('/api/crawl/test-job-id')
        .expect(400);

      expect(response.body).toMatchObject({
        error: 'Cannot cancel completed job'
      });
    });

    test('should return 404 for non-existent job', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      const response = await request(app)
        .delete('/api/crawl/non-existent-id')
        .expect(404);

      expect(response.body).toMatchObject({
        error: 'Job not found'
      });
    });
  });

  describe('GET /api/stats', () => {
    test('should return system statistics', async () => {
      const response = await request(app)
        .get('/api/stats')
        .expect(200);

      expect(response.body).toMatchObject({
        elasticsearch: {
          documentCount: 100,
          indexSize: '1 MB'
        },
        queue: {
          active: 0,
          waiting: 0,
          completed: 0,
          failed: 0
        },
        worker: {
          activeJobs: 0
        }
      });
    });
  });
});