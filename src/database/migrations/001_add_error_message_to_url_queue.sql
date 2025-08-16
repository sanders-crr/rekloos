-- Migration: Add error_message field to url_queue table
-- Description: Adds error_message TEXT column to store error details for failed URL processing
-- Date: 2025-08-15

-- Add error_message column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'url_queue' 
        AND column_name = 'error_message'
    ) THEN
        ALTER TABLE url_queue ADD COLUMN error_message TEXT;
    END IF;
END $$;

-- Update any existing failed URLs to have a default error message
UPDATE url_queue 
SET error_message = 'Migration: Previous error details not available'
WHERE status = 'failed' 
AND error_message IS NULL;