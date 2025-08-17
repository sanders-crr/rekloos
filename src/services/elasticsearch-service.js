const { Client } = require('@elastic/elasticsearch');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

// Elasticsearch is a distributed search engine that indexes and searches text documents at scale. This service manages web crawler data storage and search functionality.
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
    // An index in Elasticsearch is like a database table that stores documents with a defined structure. Check if our crawler index already exists before creating it.
    const indexExists = await this.client.indices.exists({
      index: this.indexName
    });

    if (!indexExists) {
      // Mappings define the data types and search behavior for each field in the index. Think of it as a schema that tells Elasticsearch how to handle different types of data.
      const mapping = {
        mappings: {
          properties: {
            url: {
              // 'keyword' fields are stored exactly as-is for filtering and sorting, while 'text' fields are analyzed for full-text search. URLs need exact matching so we use keyword type.
              type: 'keyword',
              index: true
            },
            title: {
              type: 'text',
              // Analyzers break text into searchable tokens, removing punctuation and lowercasing words. The 'standard' analyzer works well for most languages and content types.
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
              // 'nested' type allows complex objects with their own properties to be indexed and searched independently. Each link can have its own URL, text, and title that can be queried separately.
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
          // Shards split data across nodes for performance; replicas create copies for redundancy. For small crawlers, 1 shard with 0 replicas is sufficient.
          number_of_shards: 1,
          number_of_replicas: 0,
          analysis: {
            analyzer: {
              content_analyzer: {
                type: 'standard',
                // Stopwords like 'the', 'and', 'is' are filtered out during indexing to improve search relevance. '_english_' removes common English words that don't add meaning.
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

  // Bulk operations process multiple documents in a single request, which is much faster than individual operations. Use this for indexing large batches of crawled pages.
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

        // Elasticsearch bulk API requires pairs: action metadata followed by document data for each operation
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
        // 'wait_for' makes the operation wait until documents are searchable, ensuring consistency. Without this, newly indexed documents might not appear in immediate searches.
        refresh: 'wait_for'
      });

      // Bulk operations can partially succeed, so check each item for errors. Some documents might index successfully while others fail due to validation or format issues.
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
          // Bool queries combine multiple query clauses with logical operators (must, should, filter). 'should' means any matching clause increases the relevance score.
          bool: {
            should: [
              {
                multi_match: {
                  query: query,
                  // Boost values (^N) prioritize fields: title gets 3x weight, description 2x, content 1x (default)
                  fields: ['title^3', 'description^2', 'content'],
                  type: 'best_fields',
                  // Fuzziness allows matching similar words with typos (AUTO adjusts based on term length). This helps users find content even with spelling mistakes.
                  fuzziness: 'AUTO'
                }
              },
              {
                // match_phrase requires terms to appear in exact order, useful for finding specific phrases or quotes. This complements the fuzzy multi_match above.
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

      // Add filters if provided - filters narrow results without affecting relevance scores
      if (options.filters) {
        const filters = [];
        
        // Term filters perform exact matches on keyword fields (case-sensitive, must match completely)
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
        
        // Range filters work with dates/numbers using boundary operators (gte: >=, lte: <=)
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

        // Combine all filters using AND logic - documents must match ALL specified filters
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

  // Check if a document exists without retrieving its content, which is faster than a full search. Useful for avoiding duplicate indexing of already-crawled pages.
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

  // Refresh makes recently indexed documents immediately searchable instead of waiting for automatic refresh. Use sparingly as it can impact performance on busy systems.
  async refreshIndex() {
    try {
      await this.client.indices.refresh({
        index: this.indexName
      });
    } catch (error) {
      logger.error('Index refresh failed', { error: error.message });
    }
  }

  // Generate consistent document IDs from URLs using SHA-256 hash to ensure fixed length under Elasticsearch's 512-byte limit. This ensures the same URL always gets the same ID for updates/deduplication.
  generateDocumentId(url) {
    return crypto.createHash('sha256').update(url).digest('hex');
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