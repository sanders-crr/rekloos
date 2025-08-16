const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');

// Mock dependencies
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

const RateLimiter = require('../../src/services/rate-limiter');

describe('RateLimiter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear internal state
    RateLimiter.domainDelays.clear();
    RateLimiter.lastRequestTimes.clear();
  });

  describe('setDomainDelay', () => {
    test('should set delay for domain', () => {
      RateLimiter.setDomainDelay('example.com', 2000);
      expect(RateLimiter.domainDelays.get('example.com')).toBe(2000);
    });

    test('should use default delay if not specified', () => {
      RateLimiter.setDomainDelay('example.com');
      expect(RateLimiter.domainDelays.get('example.com')).toBe(1000);
    });
  });

  describe('wait', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('should not wait on first request', async () => {
      const startTime = Date.now();
      
      const waitPromise = RateLimiter.wait('example.com');
      jest.runAllTimers();
      await waitPromise;
      
      const endTime = Date.now();
      expect(endTime - startTime).toBeLessThan(100);
    });

    test('should wait for configured delay on subsequent requests', async () => {
      RateLimiter.setDomainDelay('example.com', 1000);
      
      // First request
      await RateLimiter.wait('example.com');
      
      // Second request should wait
      const waitPromise = RateLimiter.wait('example.com');
      
      // Advance time by 500ms - should still be waiting
      jest.advanceTimersByTime(500);
      
      // Advance time by another 500ms - should complete
      jest.advanceTimersByTime(500);
      
      await expect(waitPromise).resolves.toBeUndefined();
    });

    test('should handle multiple domains independently', async () => {
      RateLimiter.setDomainDelay('example.com', 1000);
      RateLimiter.setDomainDelay('test.com', 2000);
      
      // Make requests to both domains
      await RateLimiter.wait('example.com');
      await RateLimiter.wait('test.com');
      
      // Second requests should wait different amounts
      const exampleWait = RateLimiter.wait('example.com');
      const testWait = RateLimiter.wait('test.com');
      
      jest.advanceTimersByTime(1000);
      await expect(exampleWait).resolves.toBeUndefined();
      
      jest.advanceTimersByTime(1000);
      await expect(testWait).resolves.toBeUndefined();
    });
  });

  describe('getDomainDelay', () => {
    test('should return configured delay for domain', () => {
      RateLimiter.setDomainDelay('example.com', 2000);
      expect(RateLimiter.getDomainDelay('example.com')).toBe(2000);
    });

    test('should return default delay for unconfigured domain', () => {
      expect(RateLimiter.getDomainDelay('new-domain.com')).toBe(1000);
    });
  });

  describe('getStats', () => {
    test('should return rate limiting statistics', () => {
      RateLimiter.setDomainDelay('example.com', 2000);
      RateLimiter.setDomainDelay('test.com', 1500);
      
      const stats = RateLimiter.getStats();
      
      expect(stats).toEqual({
        totalDomains: 2,
        domainDelays: {
          'example.com': 2000,
          'test.com': 1500
        },
        lastRequestTimes: expect.any(Object)
      });
    });
  });

  describe('clearDomain', () => {
    test('should clear domain configuration', () => {
      RateLimiter.setDomainDelay('example.com', 2000);
      RateLimiter.lastRequestTimes.set('example.com', Date.now());
      
      RateLimiter.clearDomain('example.com');
      
      expect(RateLimiter.domainDelays.has('example.com')).toBe(false);
      expect(RateLimiter.lastRequestTimes.has('example.com')).toBe(false);
    });
  });

  describe('close', () => {
    test('should clear all domain data', async () => {
      RateLimiter.setDomainDelay('example.com', 2000);
      RateLimiter.setDomainDelay('test.com', 1500);
      
      await RateLimiter.close();
      
      expect(RateLimiter.domainDelays.size).toBe(0);
      expect(RateLimiter.lastRequestTimes.size).toBe(0);
    });
  });
});