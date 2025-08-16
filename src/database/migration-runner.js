const fs = require('fs').promises;
const path = require('path');
const db = require('./connection');
const logger = require('../utils/logger');
const config = require('../config');

class MigrationRunner {
  constructor() {
    this.migrationsDir = path.join(__dirname, 'migrations');
  }

  async initialize() {
    try {
      // Create migrations table if it doesn't exist
      await db.query(`
        CREATE TABLE IF NOT EXISTS migrations (
          id SERIAL PRIMARY KEY,
          filename VARCHAR(255) UNIQUE NOT NULL,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          checksum VARCHAR(64)
        )
      `);
      logger.info('Migration system initialized');
    } catch (error) {
      logger.error('Failed to initialize migration system', { error: error.message });
      throw error;
    }
  }

  async getAppliedMigrations() {
    try {
      const result = await db.query('SELECT filename FROM migrations ORDER BY id');
      return result.rows.map(row => row.filename);
    } catch (error) {
      logger.error('Failed to get applied migrations', { error: error.message });
      return [];
    }
  }

  async getPendingMigrations() {
    try {
      // Check if migrations directory exists
      try {
        await fs.access(this.migrationsDir);
      } catch {
        logger.info('No migrations directory found, creating it');
        await fs.mkdir(this.migrationsDir, { recursive: true });
        return [];
      }

      const files = await fs.readdir(this.migrationsDir);
      const migrationFiles = files
        .filter(file => file.endsWith('.sql'))
        .sort();

      const appliedMigrations = await this.getAppliedMigrations();
      const pendingMigrations = migrationFiles.filter(
        file => !appliedMigrations.includes(file)
      );

      return pendingMigrations;
    } catch (error) {
      logger.error('Failed to get pending migrations', { error: error.message });
      throw error;
    }
  }

  async runMigration(filename) {
    const filePath = path.join(this.migrationsDir, filename);
    
    try {
      logger.info('Running migration', { filename });
      
      const sql = await fs.readFile(filePath, 'utf8');
      const checksum = this.generateChecksum(sql);

      // Run the migration in a transaction
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        
        // Execute the migration SQL
        await client.query(sql);
        
        // Record the migration as applied
        await client.query(
          'INSERT INTO migrations (filename, checksum) VALUES ($1, $2)',
          [filename, checksum]
        );
        
        await client.query('COMMIT');
        logger.info('Migration completed successfully', { filename });
        
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      
    } catch (error) {
      logger.error('Migration failed', { filename, error: error.message });
      throw error;
    }
  }

  async runAllPendingMigrations() {
    try {
      await this.initialize();
      
      const pendingMigrations = await this.getPendingMigrations();
      
      if (pendingMigrations.length === 0) {
        logger.info('No pending migrations');
        return;
      }

      logger.info('Found pending migrations', { 
        count: pendingMigrations.length,
        migrations: pendingMigrations 
      });

      for (const migration of pendingMigrations) {
        await this.runMigration(migration);
      }

      logger.info('All migrations completed successfully');
      
    } catch (error) {
      logger.error('Migration process failed', { error: error.message });
      throw error;
    }
  }

  generateChecksum(content) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  async getMigrationStatus() {
    try {
      const applied = await this.getAppliedMigrations();
      const pending = await this.getPendingMigrations();
      
      return {
        applied: applied.length,
        pending: pending.length,
        appliedMigrations: applied,
        pendingMigrations: pending
      };
    } catch (error) {
      logger.error('Failed to get migration status', { error: error.message });
      return null;
    }
  }
}

module.exports = new MigrationRunner();