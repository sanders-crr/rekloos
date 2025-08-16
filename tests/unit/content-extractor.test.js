const { describe, test, expect, beforeEach } = require('@jest/globals');

// Mock dependencies
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

const contentExtractor = require('../../src/services/content-extractor');

describe('ContentExtractor', () => {
  describe('extractContent', () => {
    test('should extract content from HTML', () => {
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Test Page</title>
            <meta name="description" content="A test page">
            <meta name="keywords" content="test, page, html">
          </head>
          <body>
            <h1>Main Title</h1>
            <p>This is a paragraph with some content.</p>
            <a href="https://example.com">Example Link</a>
            <a href="/relative">Relative Link</a>
            <script>console.log('script');</script>
            <style>body { color: red; }</style>
          </body>
        </html>
      `;

      const result = contentExtractor.extractContent(htmlContent, 'text/html', 'https://test.com');

      expect(result.title).toBe('Test Page');
      expect(result.description).toBe('A test page');
      expect(result.keywords).toEqual(['test', 'page', 'html']);
      expect(result.content).toContain('Main Title');
      expect(result.content).toContain('This is a paragraph');
      expect(result.content).not.toContain('<script>');
      expect(result.content).not.toContain('<style>');
      expect(result.wordCount).toBeGreaterThan(0);
      expect(result.links).toEqual([
        { url: 'https://example.com', text: 'Example Link' },
        { url: 'https://test.com/relative', text: 'Relative Link' }
      ]);
      expect(result.contentHash).toBeDefined();
      expect(result.domain).toBe('test.com');
    });

    test('should extract content from plain text', () => {
      const textContent = 'This is plain text content with multiple words.';
      
      const result = contentExtractor.extractContent(textContent, 'text/plain', 'https://test.com');

      expect(result.title).toBe('');
      expect(result.content).toBe(textContent);
      expect(result.wordCount).toBe(8);
      expect(result.links).toEqual([]);
      expect(result.contentHash).toBeDefined();
    });

    test('should handle JSON content', () => {
      const jsonContent = JSON.stringify({
        title: 'API Response',
        data: { value: 123, text: 'hello world' }
      });

      const result = contentExtractor.extractContent(jsonContent, 'application/json', 'https://api.test.com');

      expect(result.content).toContain('API Response');
      expect(result.content).toContain('hello world');
      expect(result.wordCount).toBeGreaterThan(0);
    });

    test('should return null for unsupported content types', () => {
      const result = contentExtractor.extractContent('content', 'image/jpeg', 'https://test.com');
      expect(result).toBeNull();
    });

    test('should handle malformed HTML gracefully', () => {
      const malformedHtml = '<html><head><title>Test</title><body><p>Unclosed paragraph';
      
      const result = contentExtractor.extractContent(malformedHtml, 'text/html', 'https://test.com');

      expect(result).not.toBeNull();
      expect(result.title).toBe('Test');
      expect(result.content).toContain('Unclosed paragraph');
    });

    test('should handle empty content', () => {
      const result = contentExtractor.extractContent('', 'text/html', 'https://test.com');
      
      expect(result.content).toBe('');
      expect(result.wordCount).toBe(0);
      expect(result.links).toEqual([]);
    });
  });

  describe('cleanText', () => {
    test('should clean text properly', () => {
      const dirtyText = '   Multiple   spaces\n\nand\t\ttabs   ';
      const cleaned = contentExtractor.cleanText(dirtyText);
      
      expect(cleaned).toBe('Multiple spaces and tabs');
    });
  });

  describe('extractLinks', () => {
    test('should extract links from Cheerio object', () => {
      const cheerio = require('cheerio');
      const html = `
        <div>
          <a href="https://example.com">External Link</a>
          <a href="/internal">Internal Link</a>
          <a href="mailto:test@example.com">Email</a>
          <a href="#">Anchor</a>
        </div>
      `;
      const $ = cheerio.load(html);
      
      const links = contentExtractor.extractLinks($, 'https://test.com');
      
      expect(links).toEqual([
        { url: 'https://example.com', text: 'External Link' },
        { url: 'https://test.com/internal', text: 'Internal Link' }
      ]);
    });
  });

  describe('generateContentHash', () => {
    test('should generate consistent hash for same content', () => {
      const content = 'Same content';
      const hash1 = contentExtractor.generateContentHash(content);
      const hash2 = contentExtractor.generateContentHash(content);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex length
    });

    test('should generate different hashes for different content', () => {
      const hash1 = contentExtractor.generateContentHash('Content 1');
      const hash2 = contentExtractor.generateContentHash('Content 2');
      
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('countWords', () => {
    test('should count words correctly', () => {
      expect(contentExtractor.countWords('Hello world')).toBe(2);
      expect(contentExtractor.countWords('One   two    three')).toBe(3);
      expect(contentExtractor.countWords('')).toBe(0);
      expect(contentExtractor.countWords('   ')).toBe(0);
      expect(contentExtractor.countWords('Single')).toBe(1);
    });
  });
});