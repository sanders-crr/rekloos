# Web Crawler Service

A comprehensive web crawling system built with Node.js that indexes pages in Elasticsearch for fast search capabilities.

## Features

- **Distributed Crawling**: Queue-based architecture with Redis for job management
- **Content Extraction**: Smart content extraction from HTML, PDF, and plain text
- **Search Integration**: Full-text search powered by Elasticsearch
- **Rate Limiting**: Respectful crawling with robots.txt compliance
- **Scalable Architecture**: Horizontally scalable worker processes
- **Real-time Monitoring**: API endpoints for statistics and job tracking

## Architecture

- **Crawler Service**: Core crawling engine with Puppeteer support
- **Queue System**: Redis-backed job queue using Bull
- **Database**: PostgreSQL for metadata and crawl history
- **Search Index**: Elasticsearch for document indexing and search
- **API Server**: Express.js REST API for search and management

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for local development)

### Using Docker (Recommended)

1. Clone the repository
2. Copy environment configuration:
   ```bash
   cp .env.example .env
   ```

3. Start all services:
   ```bash
   docker-compose up -d
   ```

4. Check service health:
   ```bash
   curl http://localhost:3000/health
   ```

5. Start a crawl job:
   ```bash
   curl -X POST http://localhost:3000/api/crawl \
     -H "Content-Type: application/json" \
     -d '{"url": "https://example.com", "maxDepth": 2}'
   ```

### Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start infrastructure services:
   ```bash
   docker-compose up -d redis postgres elasticsearch
   ```

3. Set up environment variables in `.env`

4. Start the API server:
   ```bash
   npm start
   ```

5. Start the crawler worker:
   ```bash
   npm run worker
   ```

## API Endpoints

### Search
- `GET /api/search?q=query` - Search indexed content
- `GET /api/suggest?q=partial` - Get search suggestions

### Crawl Management
- `POST /api/crawl` - Start new crawl job
- `GET /api/crawl/status/:jobId` - Check crawl job status
- `GET /api/stats` - System statistics

### Document Management
- `DELETE /api/documents/:documentId` - Remove indexed document

## Configuration

Key environment variables:

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string  
- `ELASTICSEARCH_URL` - Elasticsearch endpoint
- `MAX_CONCURRENT_CRAWLS` - Number of concurrent crawl workers
- `USER_AGENT` - User agent string for HTTP requests

## Scaling

The system is designed for horizontal scaling:

1. **Multiple Workers**: Run multiple worker processes
2. **Load Balancing**: Use nginx for API load balancing
3. **Database Scaling**: PostgreSQL read replicas
4. **Search Scaling**: Elasticsearch cluster with sharding

## Monitoring

- Health checks: `GET /health` and `GET /api/health`
- Statistics: `GET /api/stats`
- Logs: Structured JSON logging with Winston
- Queue monitoring: Bull dashboard (optional)

## Security Features

- Rate limiting on API endpoints
- Input validation and sanitization
- Helmet.js security headers
- Robots.txt compliance
- Content type filtering

## Development

### Running Tests
```bash
npm test
```

### Linting
```bash
npm run lint
```

### Project Structure
```
src/
├── api/           # Express API routes
├── config/        # Configuration management
├── database/      # Database connection and queries
├── queue/         # Bull queue management
├── services/      # Core business logic
└── utils/         # Shared utilities
```

## License

MIT License - see LICENSE file for details