-- Migration: Create access_audit_log table
-- Records every blocked cross-tenant access attempt for compliance and security.
-- This table is append-only — no updates or deletes.

CREATE TABLE IF NOT EXISTS access_audit_log (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    user_tenant_id TEXT NOT NULL,
    target_entity_type TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    target_tenant_id TEXT,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    metadata TEXT
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_audit_user_date
    ON access_audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_action_date
    ON access_audit_log(action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_target
    ON access_audit_log(target_entity_type, target_entity_id);
