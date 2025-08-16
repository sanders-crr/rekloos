// Mock Elasticsearch client
const mockElasticsearchClient = {
  indices: {
    exists: jest.fn().mockResolvedValue(true),
    create: jest.fn().mockResolvedValue({ acknowledged: true }),
    putMapping: jest.fn().mockResolvedValue({ acknowledged: true })
  },
  index: jest.fn().mockResolvedValue({
    _id: 'test-id',
    _index: 'test-index',
    result: 'created'
  }),
  search: jest.fn().mockResolvedValue({
    hits: {
      total: { value: 0 },
      hits: []
    }
  }),
  ping: jest.fn().mockResolvedValue(true),
  close: jest.fn().mockResolvedValue(true)
};

module.exports = {
  Client: jest.fn(() => mockElasticsearchClient),
  mockElasticsearchClient
};