-- Track whether welcome data has been populated for a user
ALTER TABLE users ADD COLUMN welcome_completed INTEGER DEFAULT 0;
