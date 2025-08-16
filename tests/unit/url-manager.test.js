const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');

// Mock dependencies
jest.mock('../../src/database/connection', () => require('../mocks/database'));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

const URLManager = require('../../src/services/url-manager');
const db = require('../../src/database/connection');

describe('URLManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('normalizeURL', () => {
    test('should normalize URLs correctly', () => {
      const testCases = [
        {
          input: 'https://example.com/path/',
          expected: 'https://example.com/path'
        },
        {
          input: 'https://example.com/path?b=2&a=1',
          expected: 'https://example.com/path?a=1&b=2'
        },
        {
          input: 'https://example.com/path#fragment',
          expected: 'https://example.com/path'
        },
        {
          input: 'https://example.com/',
          expected: 'https://example.com/'
        }
      ];

      testCases.forEach(({ input, expected }) => {
        expect(URLManager.normalizeURL(input)).toBe(expected);
      });
    });

    test('should return null for invalid URLs', () => {
      const invalidUrls = [
        'not-a-url',
        'ftp://example.com',
        null,
        undefined,
        ''
      ];

      invalidUrls.forEach(url => {
        expect(URLManager.normalizeURL(url)).toBeNull();
      });
    });
  });

  describe('isValidURL', () => {
    test('should validate HTTP/HTTPS URLs correctly', () => {
      const validUrls = [
        'https://example.com',
        'http://example.com',
        'https://sub.example.com/path',
        'http://localhost:3000'
      ];

      const invalidUrls = [
        'ftp://example.com',
        'file:///path/to/file',
        'not-a-url',
        '',
        null
      ];

      validUrls.forEach(url => {
        expect(URLManager.isValidURL(url)).toBe(true);
      });

      invalidUrls.forEach(url => {
        expect(URLManager.isValidURL(url)).toBe(false);
      });
    });
  });

  describe('extractDomain', () => {
    test('should extract domain correctly', () => {
      const testCases = [
        {
          input: 'https://example.com/path',
          expected: 'example.com'
        },
        {
          input: 'https://sub.example.com:8080/path',
          expected: 'sub.example.com'
        },
        {
          input: 'http://localhost:3000',
          expected: 'localhost'
        }
      ];

      testCases.forEach(({ input, expected }) => {
        expect(URLManager.extractDomain(input)).toBe(expected);
      });
    });

    test('should return null for invalid URLs', () => {
      expect(URLManager.extractDomain('invalid-url')).toBeNull();
    });
  });

  describe('shouldCrawlDomain', () => {
    test('should allow all domains when no filter provided', () => {
      expect(URLManager.shouldCrawlDomain('https://example.com')).toBe(true);
      expect(URLManager.shouldCrawlDomain('https://other.com', [])).toBe(true);
    });

    test('should filter domains correctly', () => {
      const allowedDomains = ['example.com', 'allowed.org'];

      expect(URLManager.shouldCrawlDomain('https://example.com/path', allowedDomains)).toBe(true);
      expect(URLManager.shouldCrawlDomain('https://sub.example.com/path', allowedDomains)).toBe(true);
      expect(URLManager.shouldCrawlDomain('https://forbidden.com/path', allowedDomains)).toBe(false);
    });
  });

  describe('addURLToQueue', () => {
    test('should add valid URL to queue', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      const result = await URLManager.addURLToQueue(
        'https://example.com',
        'https://parent.com',
        1,
        'job-id'
      );

      expect(result).toBe(true);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO url_queue'),
        ['https://example.com/', 'https://parent.com', 1, 'job-id']
      );
    });

    test('should reject invalid URLs', async () => {
      const result = await URLManager.addURLToQueue('invalid-url');
      expect(result).toBe(false);
      expect(db.query).not.toHaveBeenCalled();
    });

    test('should handle duplicate URLs', async () => {
      // First call - URL is new
      const result1 = await URLManager.addURLToQueue('https://example.com');
      expect(result1).toBe(true);

      // Second call - URL already seen
      const result2 = await URLManager.addURLToQueue('https://example.com');
      expect(result2).toBe(false);
    });
  });

  describe('getNextURLs', () => {
    test('should fetch and update pending URLs', async () => {
      const mockUrls = [
        { id: '1', url: 'https://example.com', depth: 0, job_id: 'job-1' },
        { id: '2', url: 'https://test.com', depth: 1, job_id: 'job-2' }
      ];

      db.query
        .mockResolvedValueOnce({ rows: mockUrls })
        .mockResolvedValueOnce({ rows: [] });

      const result = await URLManager.getNextURLs(10);

      expect(result).toEqual(mockUrls);
      expect(db.query).toHaveBeenCalledTimes(2);
      expect(db.query).toHaveBeenNthCalledWith(2,
        expect.stringContaining('UPDATE url_queue'),
        [['1', '2']]
      );
    });

    test('should handle empty queue', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      const result = await URLManager.getNextURLs(10);

      expect(result).toEqual([]);
      expect(db.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('extractURLsFromContent', () => {
    test('should extract URLs from HTML content', () => {
      const htmlContent = `
        <html>
          <body>
            <a href="https://example.com/page1">Link 1</a>
            <a href="/relative/path">Relative Link</a>
            <a href="mailto:test@example.com">Email</a>
            <a href="https://example.com/page2">Link 2</a>
          </body>
        </html>
      `;

      const baseUrl = 'https://example.com';
      const urls = URLManager.extractURLsFromContent(htmlContent, baseUrl);

      expect(urls).toContain('https://example.com/page1');
      expect(urls).toContain('https://example.com/page2');
      expect(urls).toContain('https://example.com/relative/path');
      expect(urls).not.toContain('mailto:test@example.com');
    });

    test('should remove duplicate URLs', () => {
      const htmlContent = `
        <a href="https://example.com">Link 1</a>
        <a href="https://example.com">Link 2</a>
      `;

      const urls = URLManager.extractURLsFromContent(htmlContent, 'https://example.com');
      expect(urls).toEqual(['https://example.com/']);
    });
  });
});