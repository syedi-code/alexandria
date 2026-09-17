-- Migration: Backfill NULL user_id to admin user
-- Sets user_id on all existing rows that have NULL user_id.
-- This is safe because all existing data was created by the single admin user
-- before multi-tenant isolation was implemented.
--
-- IMPORTANT: The UUID below is the admin's CF Access 'sub' for THIS environment.
-- It differs between staging and production. Retrieved via:
--   npx tsx cli/db/get-admin-id.ts --env <staging|production>
--
-- Staging UUID:    admin-id (the bootstrap script's placeholder)
-- Production UUID: <run get-admin-id.ts --env production after deploying>

-- =============================================================================
-- Set the admin user ID for this environment
-- =============================================================================
-- Replace this value with the production UUID when running against production.
-- The staging value is pre-filled from the bootstrap script.

UPDATE notes       SET user_id = 'admin-id' WHERE user_id IS NULL;
UPDATE quotes      SET user_id = 'admin-id' WHERE user_id IS NULL;
UPDATE thoughts    SET user_id = 'admin-id' WHERE user_id IS NULL;
UPDATE media       SET user_id = 'admin-id' WHERE user_id IS NULL;
UPDATE links       SET user_id = 'admin-id' WHERE user_id IS NULL;
UPDATE sleep       SET user_id = 'admin-id' WHERE user_id IS NULL;
UPDATE books       SET user_id = 'admin-id' WHERE user_id IS NULL;
UPDATE authors     SET user_id = 'admin-id' WHERE user_id IS NULL;
UPDATE threads     SET user_id = 'admin-id' WHERE user_id IS NULL;
UPDATE connections SET user_id = 'admin-id' WHERE user_id IS NULL;
