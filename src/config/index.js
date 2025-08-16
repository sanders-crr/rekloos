require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    maxRetriesPerRequest: 3
  },
  
  database: {
    url: process.env.DATABASE_URL || 'postgresql://crawler:crawler_pass@localhost:5432/crawler_db'
  },
  
  elasticsearch: {
    url: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
    index: 'crawled_pages',
    maxRetries: 3,
    requestTimeout: 30000
  },
  
  crawler: {
    maxConcurrent: process.env.MAX_CONCURRENT_CRAWLS || 5,
    requestTimeout: 30000,
    maxRetries: 3,
    delayBetweenRequests: 1000,
    maxDepth: 10,
    userAgent: 'WebCrawler/1.0 (+http://localhost:3000)',
    respectRobotsTxt: true,
    maxPageSize: 5 * 1024 * 1024, // 5MB
    allowedContentTypes: [
      'text/html',
      'text/plain',
      'application/pdf',
      'application/json'
    ]
  },
  
  queue: {
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 50,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000
      }
    }
  },
  
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'logs/crawler.log'
  },
  
  migrations: {
    enabled: process.env.MIGRATIONS_ENABLED !== 'false',
    directory: process.env.MIGRATIONS_DIR || 'src/database/migrations',
    tableName: process.env.MIGRATIONS_TABLE || 'migrations'
  }
};