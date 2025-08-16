const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const apiRoutes = require('./api/routes');
const elasticsearchService = require('./services/elasticsearch-service');
const migrationRunner = require('./database/migration-runner');
const CrawlerWorker = require('./worker');

const app = express();

// Trust proxy for Docker environment
app.set('trust proxy', true);

// Security middleware
app.use(helmet());
app.use(cors());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info('HTTP Request', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// API routes
app.use('/api', apiRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'web-crawler',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Serve static files (for React frontend when built)
if (config.nodeEnv === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/build/index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Express error', { 
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method
  });

  res.status(500).json({
    error: config.nodeEnv === 'development' ? err.message : 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

async function startServer() {
  try {
    // Run database migrations
    logger.info('Running database migrations...');
    await migrationRunner.runAllPendingMigrations();
    
    // Initialize Elasticsearch
    await elasticsearchService.initialize();
    
    // Start crawler worker
    const worker = new CrawlerWorker();
    await worker.start();
    logger.info('Crawler worker started');
    
    // Start server
    const server = app.listen(config.port, () => {
      logger.info('Server started', {
        port: config.port,
        env: config.nodeEnv,
        pid: process.pid
      });
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info('Shutdown signal received', { signal });
      
      server.close(async () => {
        try {
          await elasticsearchService.close();
          logger.info('Server shutdown complete');
          process.exit(0);
        } catch (error) {
          logger.error('Error during shutdown', { error: error.message });
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return server;

  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
}

// Start server if this file is run directly
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };