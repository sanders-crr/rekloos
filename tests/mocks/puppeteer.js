// Mock Puppeteer
const mockPage = {
  goto: jest.fn().mockResolvedValue({
    status: () => 200,
    headers: () => ({ 'content-type': 'text/html' })
  }),
  content: jest.fn().mockResolvedValue('<html><body>Test content</body></html>'),
  setUserAgent: jest.fn(),
  setViewport: jest.fn(),
  setRequestInterception: jest.fn(),
  on: jest.fn(),
  close: jest.fn(),
  waitForTimeout: jest.fn()
};

const mockBrowser = {
  newPage: jest.fn().mockResolvedValue(mockPage),
  close: jest.fn()
};

module.exports = {
  launch: jest.fn().mockResolvedValue(mockBrowser),
  mockBrowser,
  mockPage
};