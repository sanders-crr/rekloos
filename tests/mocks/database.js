// Mock database connection
const mockDbConnection = {
  query: jest.fn().mockResolvedValue({
    rows: [],
    rowCount: 0
  }),
  getClient: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn()
  }),
  connect: jest.fn().mockResolvedValue(true),
  end: jest.fn().mockResolvedValue(true)
};

module.exports = mockDbConnection;