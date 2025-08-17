const cheerio = require('cheerio');
const mime = require('mime-types');
const crypto = require('crypto');
const logger = require('../utils/logger');

// Extracts structured data from various content types (HTML, JSON, plain text) using string manipulation and parsing techniques. Focuses on cleaning and normalizing text data for search indexing.
class ContentExtractor {
  constructor() {
    this.stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 
      'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being'
    ]);
  }

  extractFromHTML(html, url) {
    try {
      const $ = cheerio.load(html);
      
      // Remove script and style elements
      $('script, style, nav, footer, aside, .advertisement, .ads').remove();
      
      const title = this.extractTitle($);
      const description = this.extractDescription($);
      const content = this.extractMainContent($);
      const keywords = this.extractKeywords($);
      const links = this.extractLinks($, url);
      const metadata = this.extractMetadata($);
      
      return {
        title: title || '',
        description: description || '',
        content: content || '',
        keywords: keywords || [],
        links: links || [],
        wordCount: this.countWords(content),
        language: this.detectLanguage($),
        contentHash: this.generateContentHash(content),
        metadata,
        domain: new URL(url).hostname
      };
    } catch (error) {
      logger.error('HTML extraction failed', { url, error: error.message });
      return null;
    }
  }

  extractTitle($) {
    // Fallback strategy: try multiple selectors in priority order until content is found. Uses both attribute values (meta tags) and element text content.
    const selectors = [
      'title',
      'h1',
      '[property="og:title"]',
      '[name="twitter:title"]',
      '.title',
      '.page-title'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        // Extract from 'content' attribute (meta tags) or inner text, preferring attributes for meta tags
        const title = element.attr('content') || element.text();
        if (title && title.trim().length > 0) {
          // Normalize whitespace and truncate to prevent overly long titles in search results
          return title.trim().substring(0, 200);
        }
      }
    }

    return null;
  }

  extractDescription($) {
    const selectors = [
      '[name="description"]',
      '[property="og:description"]',
      '[name="twitter:description"]',
      '.description',
      '.summary'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const description = element.attr('content') || element.text();
        if (description && description.trim().length > 0) {
          // Limit description length for database storage and search snippet display
          return description.trim().substring(0, 500);
        }
      }
    }

    return null;
  }

  extractMainContent($) {
    // Remove unwanted elements
    $('nav, footer, aside, .sidebar, .advertisement, .ads, .menu, .navigation').remove();
    
    // Try to find main content area
    const contentSelectors = [
      'main',
      'article',
      '.content',
      '.main-content',
      '.post-content',
      '.article-content',
      '#content',
      '.page-content'
    ];

    for (const selector of contentSelectors) {
      const element = $(selector).first();
      if (element.length) {
        const content = element.text();
        // Ensure content has sufficient length to be meaningful (filters out navigation elements)
        if (content && content.trim().length > 100) {
          return this.cleanText(content);
        }
      }
    }

    // Fallback to body content
    const bodyContent = $('body').text();
    return this.cleanText(bodyContent);
  }

  extractKeywords($) {
    const keywords = new Set();
    
    // Extract from meta keywords tag and parse comma-separated values
    const metaKeywords = $('[name="keywords"]').attr('content');
    if (metaKeywords) {
      // Split by comma, normalize case, and filter short words that aren't meaningful
      metaKeywords.split(',').forEach(keyword => {
        const clean = keyword.trim().toLowerCase();
        if (clean.length > 2) keywords.add(clean);
      });
    }

    // Convert Set to Array and limit to prevent keyword spam in search index
    return Array.from(keywords).slice(0, 20);
  }

  extractLinks($, baseUrl) {
    const links = [];
    
    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      const text = $(element).text().trim();
      
      // Filter out non-web links (email, anchors) and ensure both URL and text exist
      if (href && text && !href.startsWith('mailto:') && !href.startsWith('#')) {
        try {
          let absoluteUrl = new URL(href, baseUrl).toString();
          // Normalize URLs by removing trailing slashes for consistent deduplication
          if (absoluteUrl.endsWith('/') && absoluteUrl !== baseUrl + '/') {
            absoluteUrl = absoluteUrl.slice(0, -1);
          }
          links.push({
            url: absoluteUrl,
            // Truncate link text to prevent database bloat from very long anchor text
            text: text.substring(0, 100)
          });
        } catch (error) {
          // Invalid URL, skip
        }
      }
    });

    return links;
  }

  extractMetadata($) {
    const metadata = {};
    
    // Open Graph metadata
    $('[property^="og:"]').each((_, element) => {
      const property = $(element).attr('property');
      const content = $(element).attr('content');
      if (property && content) {
        metadata[property] = content;
      }
    });

    // Twitter Card metadata
    $('[name^="twitter:"]').each((_, element) => {
      const name = $(element).attr('name');
      const content = $(element).attr('content');
      if (name && content) {
        metadata[name] = content;
      }
    });

    // Schema.org structured data
    $('[itemtype], [typeof]').each((_, element) => {
      const type = $(element).attr('itemtype') || $(element).attr('typeof');
      if (type) {
        metadata.schemaType = type;
      }
    });

    return metadata;
  }

  detectLanguage($) {
    // Try to detect language from various sources
    const langSources = [
      $('html').attr('lang'),
      $('[http-equiv="content-language"]').attr('content'),
      $('[name="language"]').attr('content'),
      $('[property="og:locale"]').attr('content')
    ];

    for (const lang of langSources) {
      if (lang) {
        // Normalize language codes to lowercase and limit length (e.g., 'en-US' -> 'en-us')
        return lang.substring(0, 5).toLowerCase();
      }
    }

    return 'en'; // Default to English
  }

  // Normalizes text by collapsing whitespace and removing special characters for clean indexing
  cleanText(text) {
    if (!text) return '';
    
    return text
      .replace(/\s+/g, ' ') // Collapse multiple spaces, tabs, newlines into single spaces
      .replace(/[\r\n\t]/g, ' ') // Convert line breaks and tabs to spaces for consistent formatting
      .trim()
      .substring(0, 50000); // Prevent extremely large content from overwhelming search index
  }

  // Counts words by splitting on whitespace and filtering empty strings from consecutive spaces
  countWords(text) {
    if (!text) return 0;
    return text.split(/\s+/).filter(word => word.length > 0).length;
  }

  // Creates SHA-256 hash of content for duplicate detection and change tracking
  generateContentHash(content) {
    return crypto.createHash('sha256')
      .update(content || '')
      .digest('hex');
  }

  extractFromPDF(buffer) {
    // Placeholder for PDF extraction
    // Would need pdf-parse library for full implementation
    logger.warn('PDF extraction not implemented');
    return {
      title: '',
      content: '',
      contentType: 'application/pdf',
      wordCount: 0
    };
  }

  extractFromPlainText(text) {
    return {
      title: '',
      content: this.cleanText(text),
      contentType: 'text/plain',
      wordCount: this.countWords(text),
      contentHash: this.generateContentHash(text)
    };
  }

  extractFromJSON(jsonContent) {
    try {
      // Parse and re-stringify JSON to normalize formatting and validate structure
      const parsed = JSON.parse(jsonContent);
      const content = JSON.stringify(parsed, null, 2);
      return {
        title: '',
        content: this.cleanText(content),
        contentType: 'application/json',
        wordCount: this.countWords(content),
        contentHash: this.generateContentHash(content)
      };
    } catch (error) {
      logger.error('JSON parsing failed', { error: error.message });
      return null;
    }
  }

  // Main extraction router that determines content type and delegates to appropriate parser
  extractContent(content, contentType, url) {
    try {
      // Normalize content type using mime-types library for consistent type detection
      const mimeType = mime.lookup(contentType) || contentType;
      
      if (mimeType.startsWith('text/html')) {
        return this.extractFromHTML(content, url);
      } else if (mimeType === 'text/plain') {
        return this.extractFromPlainText(content);
      } else if (mimeType === 'application/json') {
        return this.extractFromJSON(content);
      } else if (mimeType === 'application/pdf') {
        return this.extractFromPDF(content);
      } else {
        logger.warn('Unsupported content type', { contentType, url });
        return null;
      }
    } catch (error) {
      logger.error('Content extraction failed', { url, contentType, error: error.message });
      return null;
    }
  }
}

module.exports = new ContentExtractor();