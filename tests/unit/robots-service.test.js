const { describe, test, expect, beforeEach } = require('@jest/globals');
const axios = require('axios');

// Mock dependencies
jest.mock('axios');
jest.mock('../../src/database/connection', () => require('../mocks/database'));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

const robotsService = require('../../src/services/robots-service');
const db = require('../../src/database/connection');

describe('RobotsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear internal cache
    robotsService.robotsCache.clear();
  });

  describe('canCrawl', () => {
    test('should allow crawling when robots.txt allows', async () => {
      const robotsTxt = `
        User-agent: *
        Allow: /
        Crawl-delay: 2
      `;

      axios.get.mockResolvedValueOnce({ data: robotsTxt });
      db.query.mockResolvedValueOnce({ rows: [] });

      const result = await robotsService.canCrawl('https://example.com/page');

      expect(result).toEqual({
        allowed: true,
        delay: 2
      });
    });

    test('should disallow crawling when robots.txt disallows', async () => {
      const robotsTxt = `
        User-agent: *
        Disallow: /private/
        Allow: /
      `;

      axios.get.mockResolvedValueOnce({ data: robotsTxt });
      db.query.mockResolvedValueOnce({ rows: [] });

      const result = await robotsService.canCrawl('https://example.com/private/secret');

      expect(result).toEqual({
        allowed: false,
        delay: 1
      });
    });

    test('should use cached robots.txt', async () => {
      // First request
      const robotsTxt = 'User-agent: *\nAllow: /';
      axios.get.mockResolvedValueOnce({ data: robotsTxt });
      db.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await robotsService.canCrawl('https://example.com/page1');

      // Second request should use cache
      const result = await robotsService.canCrawl('https://example.com/page2');

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(result.allowed).toBe(true);
    });

    test('should use database cache', async () => {
      const cachedRobots = {
        robots_txt: 'User-agent: *\nAllow: /',
        crawl_delay: 3,
        last_updated: new Date(Date.now() - 60000) // 1 minute ago
      };

      db.query.mockResolvedValueOnce({ rows: [cachedRobots] });

      const result = await robotsService.canCrawl('https://example.com/page');

      expect(result).toEqual({
        allowed: true,
        delay: 3
      });
      expect(axios.get).not.toHaveBeenCalled();
    });

    test('should refresh expired cache', async () => {
      const expiredCache = {
        robots_txt: 'User-agent: *\nAllow: /',
        crawl_delay: 1,
        last_updated: new Date(Date.now() - 25 * 60 * 60 * 1000) // 25 hours ago
      };

      const newRobotsTxt = 'User-agent: *\nAllow: /\nCrawl-delay: 5';

      db.query
        .mockResolvedValueOnce({ rows: [expiredCache] })
        .mockResolvedValueOnce({ rows: [] });
      axios.get.mockResolvedValueOnce({ data: newRobotsTxt });

      const result = await robotsService.canCrawl('https://example.com/page');

      expect(result.delay).toBe(5);
      expect(axios.get).toHaveBeenCalled();
    });

    test('should handle robots.txt fetch errors gracefully', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });
      axios.get.mockRejectedValueOnce(new Error('Network error'));

      const result = await robotsService.canCrawl('https://example.com/page');

      expect(result).toEqual({
        allowed: true,
        delay: 1
      });
    });

    test('should handle 404 robots.txt gracefully', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });
      axios.get.mockRejectedValueOnce({ response: { status: 404 } });

      const result = await robotsService.canCrawl('https://example.com/page');

      expect(result).toEqual({
        allowed: true,
        delay: 1
      });
    });

    test('should handle invalid robots.txt format', async () => {
      const invalidRobotsTxt = 'This is not a valid robots.txt format';

      db.query.mockResolvedValueOnce({ rows: [] });
      axios.get.mockResolvedValueOnce({ data: invalidRobotsTxt });

      const result = await robotsService.canCrawl('https://example.com/page');

      expect(result).toEqual({
        allowed: true,
        delay: 1
      });
    });
  });

  describe('parseRobotsTxt', () => {
    test('should parse robots.txt correctly', () => {
      const robotsTxt = `
        User-agent: *
        Disallow: /private/
        Allow: /public/
        Crawl-delay: 3
        
        User-agent: WebCrawler
        Disallow: /admin/
        Crawl-delay: 5
      `;

      const result = robotsService.parseRobotsTxt(robotsTxt);

      expect(result.isAllowed('/public/page', 'WebCrawler')).toBe(true);
      expect(result.isAllowed('/private/page', 'WebCrawler')).toBe(false);
      expect(result.isAllowed('/admin/page', 'WebCrawler')).toBe(false);
      expect(result.getCrawlDelay('WebCrawler')).toBe(5);
      expect(result.getCrawlDelay('OtherBot')).toBe(3);
    });

    test('should handle empty robots.txt', () => {
      const result = robotsService.parseRobotsTxt('');
      
      expect(result.isAllowed('/any/path', 'AnyBot')).toBe(true);
      expect(result.getCrawlDelay('AnyBot')).toBe(null);
    });

    test('should handle robots.txt with comments', () => {
      const robotsTxt = `
        # This is a comment
        User-agent: *
        Disallow: /temp/  # Temporary files
        Allow: /  # Allow everything else
        Crawl-delay: 1
      `;

      const result = robotsService.parseRobotsTxt(robotsTxt);

      expect(result.isAllowed('/temp/file.txt', 'TestBot')).toBe(false);
      expect(result.isAllowed('/other/file.txt', 'TestBot')).toBe(true);
    });
  });

  describe('extractDomain', () => {
    test('should extract domain from URL', () => {
      expect(robotsService.extractDomain('https://example.com/path')).toBe('example.com');
      expect(robotsService.extractDomain('http://sub.example.com:8080/path')).toBe('sub.example.com');
      expect(robotsService.extractDomain('https://localhost:3000')).toBe('localhost');
    });

    test('should handle invalid URLs', () => {
      expect(robotsService.extractDomain('not-a-url')).toBeNull();
      expect(robotsService.extractDomain('')).toBeNull();
    });
  });

  describe('saveToCache', () => {
    test('should save robots.txt to database cache', async () => {
      await robotsService.saveToCache('example.com', 'User-agent: *\nAllow: /', 2);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO robots_cache'),
        ['example.com', 'User-agent: *\nAllow: /', 2]
      );
    });

    test('should handle database save errors', async () => {
      db.query.mockRejectedValueOnce(new Error('Database error'));

      await expect(
        robotsService.saveToCache('example.com', 'robots content', 1)
      ).resolves.not.toThrow();
    });
  });

  describe('clearCache', () => {
    test('should clear all caches', async () => {
      // Add something to memory cache
      robotsService.robotsCache.set('example.com', { data: 'test' });

      await robotsService.clearCache();

      expect(robotsService.robotsCache.size).toBe(0);
      expect(db.query).toHaveBeenCalledWith('DELETE FROM robots_cache');
    });
  });

  describe('getStats', () => {
    test('should return cache statistics', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ count: '5' }]
      });

      robotsService.robotsCache.set('example.com', { data: 'test' });

      const stats = await robotsService.getStats();

      expect(stats).toEqual({
        memoryCacheSize: 1,
        databaseCacheSize: 5
      });
    });
  });
});