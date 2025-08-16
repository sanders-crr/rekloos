const { Client } = require('@elastic/elasticsearch');
const config = require('../config');
const logger = require('../utils/logger');

class ElasticsearchService {
  constructor() {
    this.client = new Client({
      node: config.elasticsearch.url,
      maxRetries: config.elasticsearch.maxRetries,
      requestTimeout: config.elasticsearch.requestTimeout
    });
    
    this.indexName = config.elasticsearch.index;
    this.initialized = false;
  }

  async initialize() {
    try {
      await this.createIndexIfNotExists();
      this.initialized = true;
      logger.info('Elasticsearch service initialized');
    } catch (error) {
      logger.error('Failed to initialize Elasticsearch', { error: error.message });
      throw error;
    }
  }

  async createIndexIfNotExists() {
    const indexExists = await this.client.indices.exists({
      index: this.indexName
    });

    if (!indexExists) {
      const mapping = {
        mappings: {
          properties: {
            url: {
              type: 'keyword',
              index: true
            },
            title: {
              type: 'text',
              analyzer: 'standard'
            },
            content: {
              type: 'text',
              analyzer: 'standard'
            },
            description: {
              type: 'text',
              analyzer: 'standard'
            },
            keywords: {
              type: 'keyword'
            },
            domain: {
              type: 'keyword'
            },
            crawl_date: {
              type: 'date'
            },
            last_modified: {
              type: 'date'
            },
            content_type: {
              type: 'keyword'
            },
            language: {
              type: 'keyword'
            },
            word_count: {
              type: 'integer'
            },
            content_hash: {
              type: 'keyword'
            },
            links: {
              type: 'nested',
              properties: {
                url: { type: 'keyword' },
                text: { type: 'text' },
                title: { type: 'text' }
              }
            },
            metadata: {
              type: 'object',
              enabled: false
            }
          }
        },
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
          analysis: {
            analyzer: {
              content_analyzer: {
                type: 'standard',
                stopwords: '_english_'
              }
            }
          }
        }
      };

      await this.client.indices.create({
        index: this.indexName,
        body: mapping
      });

      logger.info('Created Elasticsearch index', { index: this.indexName });
    }
  }

  async indexDocument(document) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const doc = {
        url: document.url,
        title: document.title || '',
        content: document.content || '',
        description: document.description || '',
        keywords: document.keywords || [],
        domain: this.extractDomain(document.url),
        crawl_date: new Date(),
        last_modified: document.lastModified || new Date(),
        content_type: document.contentType || 'text/html',
        language: document.language || 'en',
        word_count: document.wordCount || 0,
        content_hash: document.contentHash,
        links: document.links || [],
        metadata: document.metadata || {}
      };

      const response = await this.client.index({
        index: this.indexName,
        id: this.generateDocumentId(document.url),
        body: doc
      });

      logger.debug('Document indexed', { 
        url: document.url, 
        id: response._id,
        result: response.result 
      });

      return response;
    } catch (error) {
      logger.error('Failed to index document', { 
        url: document.url, 
        error: error.message 
      });
      throw error;
    }
  }

  async bulkIndexDocuments(documents) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (documents.length === 0) return;

    try {
      const body = [];
      
      documents.forEach(document => {
        const doc = {
          url: document.url,
          title: document.title || '',
          content: document.content || '',
          description: document.description || '',
          keywords: document.keywords || [],
          domain: this.extractDomain(document.url),
          crawl_date: new Date(),
          last_modified: document.lastModified || new Date(),
          content_type: document.contentType || 'text/html',
          language: document.language || 'en',
          word_count: document.wordCount || 0,
          content_hash: document.contentHash,
          links: document.links || [],
          metadata: document.metadata || {}
        };

        body.push({
          index: {
            _index: this.indexName,
            _id: this.generateDocumentId(document.url)
          }
        });
        body.push(doc);
      });

      const response = await this.client.bulk({
        body: body,
        refresh: 'wait_for'
      });

      const errors = response.items.filter(item => item.index.error);
      if (errors.length > 0) {
        logger.warn('Bulk indexing had errors', { 
          errorCount: errors.length,
          totalCount: documents.length 
        });
      }

      logger.info('Bulk indexed documents', { 
        count: documents.length,
        errors: errors.length 
      });

      return response;
    } catch (error) {
      logger.error('Bulk indexing failed', { 
        count: documents.length,
        error: error.message 
      });
      throw error;
    }
  }

  async search(query, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const searchBody = {
        query: {
          bool: {
            should: [
              {
                multi_match: {
                  query: query,
                  fields: ['title^3', 'description^2', 'content'],
                  type: 'best_fields',
                  fuzziness: 'AUTO'
                }
              },
              {
                match_phrase: {
                  content: {
                    query: query,
                    boost: 2
                  }
                }
              }
            ]
          }
        },
        highlight: {
          fields: {
            title: {},
            content: {
              fragment_size: 150,
              number_of_fragments: 3
            },
            description: {}
          }
        },
        from: options.from || 0,
        size: options.size || 10
      };

      // Add filters if provided
      if (options.filters) {
        const filters = [];
        
        if (options.filters.domain) {
          filters.push({
            term: { domain: options.filters.domain }
          });
        }
        
        if (options.filters.contentType) {
          filters.push({
            term: { content_type: options.filters.contentType }
          });
        }
        
        if (options.filters.language) {
          filters.push({
            term: { language: options.filters.language }
          });
        }
        
        if (options.filters.dateRange) {
          filters.push({
            range: {
              crawl_date: {
                gte: options.filters.dateRange.from,
                lte: options.filters.dateRange.to
              }
            }
          });
        }

        if (filters.length > 0) {
          searchBody.query.bool.filter = filters;
        }
      }

      const response = await this.client.search({
        index: this.indexName,
        body: searchBody
      });

      return {
        total: response.hits.total.value,
        hits: response.hits.hits.map(hit => ({
          id: hit._id,
          score: hit._score,
          source: hit._source,
          highlight: hit.highlight
        }))
      };
    } catch (error) {
      logger.error('Search failed', { query, error: error.message });
      throw error;
    }
  }

  async documentExists(url) {
    try {
      const response = await this.client.exists({
        index: this.indexName,
        id: this.generateDocumentId(url)
      });
      return response;
    } catch (error) {
      logger.error('Document exists check failed', { url, error: error.message });
      return false;
    }
  }

  async deleteDocument(url) {
    try {
      const response = await this.client.delete({
        index: this.indexName,
        id: this.generateDocumentId(url)
      });
      
      logger.debug('Document deleted', { url, result: response.result });
      return response;
    } catch (error) {
      logger.error('Document deletion failed', { url, error: error.message });
      throw error;
    }
  }

  async getDocumentCount() {
    try {
      const response = await this.client.count({
        index: this.indexName
      });
      return response.count;
    } catch (error) {
      logger.error('Document count failed', { error: error.message });
      return 0;
    }
  }

  async refreshIndex() {
    try {
      await this.client.indices.refresh({
        index: this.indexName
      });
    } catch (error) {
      logger.error('Index refresh failed', { error: error.message });
    }
  }

  generateDocumentId(url) {
    return Buffer.from(url).toString('base64url');
  }

  extractDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return 'unknown';
    }
  }

  async close() {
    await this.client.close();
  }
}

module.exports = new ElasticsearchService();