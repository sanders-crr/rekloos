const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');

// Mock dependencies
jest.mock('@elastic/elasticsearch', () => require('../mocks/elasticsearch'));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

const { mockElasticsearchClient } = require('../mocks/elasticsearch');

describe('ElasticsearchService', () => {
  let elasticsearchService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear the module cache to get a fresh instance
    delete require.cache[require.resolve('../../src/services/elasticsearch-service')];
    elasticsearchService = require('../../src/services/elasticsearch-service');
  });

  describe('initialize', () => {
    test('should initialize successfully when index exists', async () => {
      mockElasticsearchClient.ping.mockResolvedValueOnce(true);
      mockElasticsearchClient.indices.exists.mockResolvedValueOnce(true);

      await expect(elasticsearchService.initialize()).resolves.not.toThrow();
      
      expect(mockElasticsearchClient.ping).toHaveBeenCalled();
      expect(mockElasticsearchClient.indices.exists).toHaveBeenCalled();
    });

    test('should create index when it does not exist', async () => {
      mockElasticsearchClient.ping.mockResolvedValueOnce(true);
      mockElasticsearchClient.indices.exists.mockResolvedValueOnce(false);
      mockElasticsearchClient.indices.create.mockResolvedValueOnce({ acknowledged: true });

      await expect(elasticsearchService.initialize()).resolves.not.toThrow();
      
      expect(mockElasticsearchClient.indices.create).toHaveBeenCalled();
    });

    test('should throw error when Elasticsearch is not available', async () => {
      mockElasticsearchClient.ping.mockRejectedValueOnce(new Error('Connection failed'));

      await expect(elasticsearchService.initialize()).rejects.toThrow('Connection failed');
    });
  });

  describe('indexDocument', () => {
    const mockDocument = {
      url: 'https://example.com',
      title: 'Test Page',
      content: 'Test content',
      wordCount: 2,
      domain: 'example.com'
    };

    test('should index document successfully', async () => {
      mockElasticsearchClient.index.mockResolvedValueOnce({
        _id: 'test-id',
        result: 'created'
      });

      const result = await elasticsearchService.indexDocument(mockDocument);

      expect(result).toEqual({ _id: 'test-id', result: 'created' });
      expect(mockElasticsearchClient.index).toHaveBeenCalledWith({
        index: 'crawled_pages',
        id: expect.any(String),
        document: expect.objectContaining({
          url: 'https://example.com',
          title: 'Test Page',
          crawl_date: expect.any(String)
        })
      });
    });

    test('should handle indexing errors', async () => {
      mockElasticsearchClient.index.mockRejectedValueOnce(new Error('Index error'));

      await expect(elasticsearchService.indexDocument(mockDocument))
        .rejects.toThrow('Index error');
    });

    test('should generate document ID from URL', async () => {
      await elasticsearchService.indexDocument(mockDocument);

      const indexCall = mockElasticsearchClient.index.mock.calls[0][0];
      expect(indexCall.id).toBe(Buffer.from('https://example.com').toString('base64'));
    });
  });

  describe('searchDocuments', () => {
    test('should search documents successfully', async () => {
      const mockSearchResults = {
        hits: {
          total: { value: 2 },
          hits: [
            {
              _source: { url: 'https://example.com', title: 'Test 1' },
              _score: 1.0
            },
            {
              _source: { url: 'https://test.com', title: 'Test 2' },
              _score: 0.8
            }
          ]
        }
      };

      mockElasticsearchClient.search.mockResolvedValueOnce(mockSearchResults);

      const result = await elasticsearchService.searchDocuments('test query');

      expect(result).toEqual({
        total: 2,
        results: [
          { url: 'https://example.com', title: 'Test 1', score: 1.0 },
          { url: 'https://test.com', title: 'Test 2', score: 0.8 }
        ]
      });

      expect(mockElasticsearchClient.search).toHaveBeenCalledWith({
        index: 'crawled_pages',
        query: {
          multi_match: {
            query: 'test query',
            fields: ['title^3', 'content^2', 'description', 'keywords'],
            fuzziness: 'AUTO'
          }
        },
        highlight: {
          fields: {
            title: {},
            content: { fragment_size: 150, number_of_fragments: 3 }
          }
        },
        size: 20,
        from: 0
      });
    });

    test('should handle search with options', async () => {
      mockElasticsearchClient.search.mockResolvedValueOnce({
        hits: { total: { value: 0 }, hits: [] }
      });

      await elasticsearchService.searchDocuments('query', {
        domain: 'example.com',
        size: 10,
        from: 5
      });

      const searchCall = mockElasticsearchClient.search.mock.calls[0][0];
      expect(searchCall.size).toBe(10);
      expect(searchCall.from).toBe(5);
      expect(searchCall.query.bool.filter).toContainEqual({
        term: { domain: 'example.com' }
      });
    });

    test('should handle search errors', async () => {
      mockElasticsearchClient.search.mockRejectedValueOnce(new Error('Search error'));

      await expect(elasticsearchService.searchDocuments('query'))
        .rejects.toThrow('Search error');
    });
  });

  describe('getDocumentById', () => {
    test('should get document by ID successfully', async () => {
      const mockDoc = {
        _source: { url: 'https://example.com', title: 'Test' }
      };

      mockElasticsearchClient.get = jest.fn().mockResolvedValueOnce(mockDoc);

      const result = await elasticsearchService.getDocumentById('test-id');

      expect(result).toEqual({ url: 'https://example.com', title: 'Test' });
      expect(mockElasticsearchClient.get).toHaveBeenCalledWith({
        index: 'crawled_pages',
        id: 'test-id'
      });
    });

    test('should handle document not found', async () => {
      mockElasticsearchClient.get = jest.fn().mockRejectedValueOnce({
        meta: { statusCode: 404 }
      });

      const result = await elasticsearchService.getDocumentById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('deleteDocument', () => {
    test('should delete document successfully', async () => {
      mockElasticsearchClient.delete = jest.fn().mockResolvedValueOnce({
        result: 'deleted'
      });

      const result = await elasticsearchService.deleteDocument('test-id');

      expect(result).toEqual({ result: 'deleted' });
      expect(mockElasticsearchClient.delete).toHaveBeenCalledWith({
        index: 'crawled_pages',
        id: 'test-id'
      });
    });
  });

  describe('getStats', () => {
    test('should get index statistics', async () => {
      mockElasticsearchClient.indices.stats = jest.fn().mockResolvedValueOnce({
        indices: {
          'crawled_pages': {
            total: {
              docs: { count: 100 },
              store: { size_in_bytes: 1024000 }
            }
          }
        }
      });

      const stats = await elasticsearchService.getStats();

      expect(stats).toEqual({
        documentCount: 100,
        indexSize: '1000.0 KB'
      });
    });
  });

  describe('close', () => {
    test('should close client connection', async () => {
      await elasticsearchService.close();
      expect(mockElasticsearchClient.close).toHaveBeenCalled();
    });
  });
});