import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const crawlService = {
  startCrawl: async (url, options = {}) => {
    try {
      const response = await api.post('/crawl', {
        url,
        maxDepth: options.maxDepth || 3,
        domainFilter: options.domainFilter || [],
        priority: options.priority || 5
      });
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Failed to start crawl');
    }
  },

  getCrawlStatus: async (jobId) => {
    try {
      const response = await api.get(`/crawl/status/${jobId}`);
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Failed to get crawl status');
    }
  }
};

export const searchService = {
  search: async (query, options = {}) => {
    try {
      const params = new URLSearchParams({
        q: query,
        from: options.from || 0,
        size: options.size || 10
      });

      if (options.domain) params.append('domain', options.domain);
      if (options.contentType) params.append('contentType', options.contentType);
      if (options.language) params.append('language', options.language);
      if (options.dateFrom) params.append('dateFrom', options.dateFrom);
      if (options.dateTo) params.append('dateTo', options.dateTo);

      const response = await api.get(`/search?${params}`);
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Search failed');
    }
  },

  getSuggestions: async (query) => {
    try {
      const response = await api.get(`/suggest?q=${encodeURIComponent(query)}`);
      return response.data.suggestions;
    } catch (error) {
      return [];
    }
  }
};

export const statsService = {
  getStats: async () => {
    try {
      const response = await api.get('/stats');
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Failed to get stats');
    }
  }
};

export default api;