import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { crawlService } from '../services/api';
import './Home.css';

const Home = () => {
  const [url, setUrl] = useState('');
  const [maxDepth, setMaxDepth] = useState(3);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState(''); // 'success', 'error', 'info'
  const navigate = useNavigate();

  const validateUrl = (url) => {
    try {
      const urlObj = new URL(url);
      return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch {
      return false;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!url.trim()) {
      setMessage('Please enter a URL to crawl');
      setMessageType('error');
      return;
    }

    if (!validateUrl(url)) {
      setMessage('Please enter a valid HTTP or HTTPS URL');
      setMessageType('error');
      return;
    }

    setIsLoading(true);
    setMessage('');

    try {
      const result = await crawlService.startCrawl(url, { maxDepth });
      
      setMessage(`Crawl started successfully! Job ID: ${result.jobId}`);
      setMessageType('success');
      
      // Navigate to search page after a short delay
      setTimeout(() => {
        navigate('/search', { state: { jobId: result.jobId, crawlUrl: url } });
      }, 2000);
      
    } catch (error) {
      setMessage(error.message);
      setMessageType('error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearchRedirect = () => {
    navigate('/search');
  };

  return (
    <div className="home-container">
      <div className="hero-section">
        <h2>Web Crawler & Search Engine</h2>
        <p>Enter a website URL to start crawling and make its content searchable</p>
      </div>

      <div className="crawl-form-container">
        <form onSubmit={handleSubmit} className="crawl-form">
          <div className="form-group">
            <label htmlFor="url">Website URL:</label>
            <input
              type="url"
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              disabled={isLoading}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="maxDepth">Max Crawl Depth:</label>
            <select
              id="maxDepth"
              value={maxDepth}
              onChange={(e) => setMaxDepth(parseInt(e.target.value))}
              disabled={isLoading}
            >
              <option value={1}>1 level (homepage only)</option>
              <option value={2}>2 levels</option>
              <option value={3}>3 levels (recommended)</option>
              <option value={5}>5 levels</option>
              <option value={10}>10 levels (deep crawl)</option>
            </select>
          </div>

          <button
            type="submit"
            className="crawl-button"
            disabled={isLoading}
          >
            {isLoading ? 'Starting Crawl...' : 'Start Crawling'}
          </button>
        </form>

        {message && (
          <div className={`message ${messageType}`}>
            {message}
          </div>
        )}
      </div>

      <div className="actions-section">
        <button
          onClick={handleSearchRedirect}
          className="search-redirect-button"
        >
          Search Existing Content
        </button>
      </div>

      <div className="info-section">
        <h3>How it works:</h3>
        <ol>
          <li>Enter a website URL you want to make searchable</li>
          <li>Choose how deep to crawl (number of page levels)</li>
          <li>The crawler will extract content and index it for search</li>
          <li>Search through the crawled content using our search interface</li>
        </ol>

        <div className="features">
          <h3>Features:</h3>
          <ul>
            <li>Respectful crawling (follows robots.txt)</li>
            <li>Full-text search with relevance ranking</li>
            <li>Content extraction from HTML, PDF, and text files</li>
            <li>Real-time crawl progress tracking</li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default Home;