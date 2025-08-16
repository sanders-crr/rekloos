# Testing Documentation

This directory contains comprehensive tests for the web crawler service.

## Test Structure

```
tests/
├── unit/                 # Unit tests for individual modules
│   ├── url-manager.test.js
│   ├── content-extractor.test.js
│   ├── elasticsearch-service.test.js
│   ├── rate-limiter.test.js
│   ├── robots-service.test.js
│   ├── crawler-queue.test.js
│   └── worker.test.js
├── integration/          # Integration tests for API routes
│   └── api-routes.test.js
├── mocks/               # Mock implementations for dependencies
│   ├── database.js
│   ├── elasticsearch.js
│   └── puppeteer.js
├── setup.js             # Jest setup configuration
└── README.md            # This file
```

## Running Tests

### All Tests
```bash
npm test                 # Run all tests
npm run test:ci         # Run tests in CI mode with coverage
```

### Unit Tests
```bash
npm run test:unit                # Run unit tests only
npm run test:coverage:unit       # Run unit tests with coverage
```

### Integration Tests
```bash
npm run test:integration         # Run integration tests only
npm run test:coverage:integration # Run integration tests with coverage
```

### Watch Mode
```bash
npm run test:watch              # Run tests in watch mode
```

### Coverage
```bash
npm run test:coverage           # Run all tests with coverage report
```

## Test Configuration

- **Framework**: Jest
- **Test Environment**: Node.js
- **Timeout**: 30 seconds per test
- **Coverage**: Configured to track all source files except entry points and migrations

## Mock Strategy

The test suite uses comprehensive mocking to isolate units under test:

- **Database**: Mocked PostgreSQL connections and queries
- **Elasticsearch**: Mocked client with configurable responses
- **Puppeteer**: Mocked browser automation
- **External APIs**: Mocked HTTP requests with axios
- **Logger**: Mocked logging functions

## Writing Tests

### Unit Test Example
```javascript
const { describe, test, expect, beforeEach } = require('@jest/globals');

// Mock dependencies
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn()
}));

describe('ModuleName', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should perform expected behavior', () => {
    // Test implementation
  });
});
```

### Integration Test Example
```javascript
const request = require('supertest');
const app = require('../../src/app');

describe('API Endpoint', () => {
  test('should return expected response', async () => {
    const response = await request(app)
      .get('/api/endpoint')
      .expect(200);
      
    expect(response.body).toMatchObject({
      expectedProperty: 'expectedValue'
    });
  });
});
```

## Test Coverage

The test suite aims for high coverage across:

- **Core Services**: URL management, content extraction, crawling logic
- **API Routes**: All HTTP endpoints with various scenarios
- **Utility Functions**: Rate limiting, robots.txt parsing, logging
- **Worker Logic**: Job processing and queue management
- **Error Handling**: Graceful failure scenarios

## Environment

Tests use a separate environment configuration in `.env.test` to avoid conflicts with development/production databases and services.

## CI/CD Integration

The `test:ci` script is optimized for continuous integration environments:
- Runs without watch mode
- Generates coverage reports
- Exits with appropriate status codes
- Uses CI-friendly output formatting