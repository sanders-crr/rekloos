-- Database initialization script
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Crawl jobs table
CREATE TABLE crawl_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    url TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    priority INTEGER DEFAULT 5,
    depth INTEGER DEFAULT 0,
    max_depth INTEGER DEFAULT 3,
    domain_filter TEXT[],
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT,
    pages_crawled INTEGER DEFAULT 0,
    pages_indexed INTEGER DEFAULT 0
);

-- Crawled pages tracking
CREATE TABLE crawled_pages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    url TEXT UNIQUE NOT NULL,
    title TEXT,
    content_hash VARCHAR(64),
    last_crawled TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_modified TIMESTAMP,
    status_code INTEGER,
    content_type VARCHAR(100),
    word_count INTEGER,
    domain VARCHAR(255),
    indexed BOOLEAN DEFAULT false,
    error_count INTEGER DEFAULT 0
);

-- URL queue for crawling
CREATE TABLE url_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    url TEXT UNIQUE NOT NULL,
    parent_url TEXT,
    depth INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 5,
    job_id UUID REFERENCES crawl_jobs(id),
    status VARCHAR(20) DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    scheduled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    error_message TEXT
);

-- Robots.txt cache
CREATE TABLE robots_cache (
    domain VARCHAR(255) PRIMARY KEY,
    robots_txt TEXT,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    crawl_delay INTEGER DEFAULT 1
);

-- Create indexes
CREATE INDEX idx_crawl_jobs_status ON crawl_jobs(status);
CREATE INDEX idx_crawled_pages_url ON crawled_pages(url);
CREATE INDEX idx_crawled_pages_domain ON crawled_pages(domain);
CREATE INDEX idx_url_queue_status ON url_queue(status);
CREATE INDEX idx_url_queue_scheduled ON url_queue(scheduled_at);
CREATE INDEX idx_robots_cache_domain ON robots_cache(domain);