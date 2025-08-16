import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { searchService, crawlService, statsService } from '../services/api';
import './Search.css';

const Search = () => {
  const location = useLocation();
  const navigate = useNavigate();
  
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [totalResults, setTotalResults] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [jobStatus, setJobStatus] = useState(null);
  const [stats, setStats] = useState(null);
  
  const resultsPerPage = 10;
  const jobId = location.state?.jobId;
  const crawlUrl = location.state?.crawlUrl;

  useEffect(() => {
    loadStats();
    
    if (jobId) {
      checkJobStatus();
      const interval = setInterval(checkJobStatus, 5000);
      return () => clearInterval(interval);
    }
  }, [jobId]);

  const loadStats = async () => {
    try {
      const data = await statsService.getStats();
      setStats(data);
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  const checkJobStatus = async () => {
    if (!jobId) return;
    
    try {
      const status = await crawlService.getCrawlStatus(jobId);
      setJobStatus(status);
    } catch (error) {
      console.error('Failed to get job status:', error);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    
    if (!query.trim()) {
      setError('Please enter a search query');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const data = await searchService.search(query, {
        from: currentPage * resultsPerPage,
        size: resultsPerPage
      });
      
      setResults(data.hits);
      setTotalResults(data.total);
    } catch (error) {
      setError(error.message);
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePageChange = async (newPage) => {
    if (!query.trim()) return;
    
    setCurrentPage(newPage);
    setIsLoading(true);

    try {
      const data = await searchService.search(query, {
        from: newPage * resultsPerPage,
        size: resultsPerPage
      });
      
      setResults(data.hits);
      window.scrollTo(0, 0);
    } catch (error) {
      setError(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const highlightText = (text, highlight) => {
    if (!highlight || !text) return text;
    
    const parts = text.split(new RegExp(`(${highlight.join('|')})`, 'gi'));
    return parts.map((part, i) => 
      highlight.some(h => h.toLowerCase() === part.toLowerCase()) ? 
        <mark key={i}>{part}</mark> : part
    );
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString();
  };

  const totalPages = Math.ceil(totalResults / resultsPerPage);

  return (
    <div className="search-container">
      {/* Job Status Banner */}
      {jobStatus && crawlUrl && (
        <div className={`job-status ${jobStatus.state}`}>
          <div className="job-info">
            <strong>Crawling: {crawlUrl}</strong>
            <span className="status">Status: {jobStatus.state}</span>
            {jobStatus.progress > 0 && (
              <span className="progress">Progress: {jobStatus.progress}%</span>
            )}
          </div>
          {jobStatus.state === 'failed' && jobStatus.failedReason && (
            <div className="error-reason">Error: {jobStatus.failedReason}</div>
          )}
        </div>
      )}

      {/* Stats Bar */}
      {stats && (
        <div className="stats-bar">
          <span>Documents: {stats.documentsIndexed?.toLocaleString() || 0}</span>
          <span>Domains: {stats.crawlStats?.uniqueDomains || 0}</span>
          <span>Crawled Today: {stats.crawlStats?.crawledToday || 0}</span>
        </div>
      )}

      {/* Search Form */}
      <form onSubmit={handleSearch} className="search-form">
        <div className="search-input-container">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search crawled content..."
            disabled={isLoading}
            className="search-input"
          />
          <button
            type="submit"
            disabled={isLoading}
            className="search-button"
          >
            {isLoading ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>

      {/* Back to Home */}
      <button
        onClick={() => navigate('/')}
        className="back-button"
      >
        ← Back to Home
      </button>

      {/* Error Message */}
      {error && (
        <div className="error-message">
          {error}
        </div>
      )}

      {/* Search Results */}
      {results.length > 0 && (
        <div className="results-section">
          <div className="results-header">
            <span>{totalResults.toLocaleString()} results found</span>
            {totalPages > 1 && (
              <span>Page {currentPage + 1} of {totalPages}</span>
            )}
          </div>

          <div className="results-list">
            {results.map((result, index) => (
              <div key={result.id} className="result-item">
                <h3 className="result-title">
                  <a
                    href={result.source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {result.highlight?.title ? 
                      <span dangerouslySetInnerHTML={{ __html: result.highlight.title.join(' ... ') }} /> :
                      result.source.title || 'Untitled'
                    }
                  </a>
                </h3>
                
                <div className="result-url">
                  {result.source.url}
                </div>

                <div className="result-snippet">
                  {result.highlight?.content ? (
                    <span dangerouslySetInnerHTML={{ 
                      __html: result.highlight.content.join(' ... ') 
                    }} />
                  ) : (
                    result.source.description || 
                    (result.source.content?.substring(0, 300) + '...')
                  )}
                </div>

                <div className="result-meta">
                  <span>Score: {result.score?.toFixed(2)}</span>
                  <span>Domain: {result.source.domain}</span>
                  <span>Words: {result.source.word_count}</span>
                  {result.source.crawl_date && (
                    <span>Crawled: {formatDate(result.source.crawl_date)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="pagination">
              <button
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 0 || isLoading}
              >
                Previous
              </button>

              <div className="page-numbers">
                {[...Array(Math.min(5, totalPages))].map((_, i) => {
                  const pageNum = Math.max(0, Math.min(
                    totalPages - 5,
                    currentPage - 2
                  )) + i;
                  
                  if (pageNum >= totalPages) return null;
                  
                  return (
                    <button
                      key={pageNum}
                      onClick={() => handlePageChange(pageNum)}
                      className={currentPage === pageNum ? 'active' : ''}
                      disabled={isLoading}
                    >
                      {pageNum + 1}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage >= totalPages - 1 || isLoading}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* No Results */}
      {query && !isLoading && results.length === 0 && !error && (
        <div className="no-results">
          <p>No results found for "{query}"</p>
          <p>Try different keywords or make sure the content has been crawled.</p>
        </div>
      )}
    </div>
  );
};

export default Search;