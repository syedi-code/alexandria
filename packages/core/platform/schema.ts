import { z } from 'zod';
import { MAX_LENGTHS } from './limits.js';

// ============================================================================
// User / Auth Schemas
// ============================================================================

export const UserSchema = z.object({
	id: z.string().max(MAX_LENGTHS.ID),
	email: z.string().email(),
	name: z.string().max(MAX_LENGTHS.TITLE).nullable().optional(),
	idp_type: z.string().max(MAX_LENGTHS.SHORT).nullable().optional(),
	first_seen: z.string(),
	last_seen: z.string(),
	plan: z.enum(['free', 'paid']).default('free'),
});

export type UserPlan = 'free' | 'paid';

export const UserInput = z.object({
	id: z.string().max(MAX_LENGTHS.ID),
	email: z.string().email(),
	name: z.string().max(MAX_LENGTHS.TITLE).optional(),
	idp_type: z.string().max(MAX_LENGTHS.SHORT).optional(),
});

export type UserSchema = z.infer<typeof UserSchema>;
export type UserInput = z.infer<typeof UserInput>;

export const SessionRow = z.object({
	token: z.string().length(64),
	user_id: z.string().max(MAX_LENGTHS.ID),
	email: z.string().email(),
	role: z.enum(['admin', 'member']),
	created_at: z.string(),
	expires_at: z.string(),
	/** From the user, joined in by getSessionByToken: 1 for a guest. */
	is_guest: z.number().optional(),
});

export type SessionRow = z.infer<typeof SessionRow>;

// =============================================================================
// Access Audit Log
// =============================================================================

export const AccessAuditLogRow = z.object({
	id: z.string().min(1).max(MAX_LENGTHS.ID),
	created_at: z.string(),
	user_id: z.string().min(1).max(MAX_LENGTHS.ID),
	user_tenant_id: z.string().min(1).max(MAX_LENGTHS.ID),
	target_entity_type: z.string().min(1).max(MAX_LENGTHS.SHORT),
	target_entity_id: z.string().min(1).max(MAX_LENGTHS.ID),
	target_tenant_id: z.string().max(MAX_LENGTHS.ID).nullable().optional(),
	action: z.enum(['READ', 'UPDATE', 'DELETE']),
	outcome: z.enum(['BLOCKED']),
	metadata: z.string().max(MAX_LENGTHS.CONTENT).nullable().optional(),
});
export type AccessAuditLogRow = z.infer<typeof AccessAuditLogRow>;

export const AccessAuditLogInput = AccessAuditLogRow.omit({
	id: true,
	created_at: true,
});
export type AccessAuditLogInput = z.infer<typeof AccessAuditLogInput>;

export function friendlyZodError(e: unknown): string {
	if (e instanceof z.ZodError) {
		return e.issues
			.map((i) => `${i.path.join('.')}: ${i.message}`)
			.join('; ');
	}
	return String(e);
}
