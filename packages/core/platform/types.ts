/// <reference types="@cloudflare/workers-types" />

export interface Env {
	/** Enable debug logging when set to "1" or "true" */
	DEBUG?: string;
	/**
	 * Set to "true" in .dev.vars to stand in for Access on a local process.
	 * Ignored on a deployed worker — see isLocalDev() in apps/worker/api/auth.ts.
	 */
	LOCAL_DEV?: string;
	/** Identity a local dev session runs as; defaults to a user that owns nothing. */
	LOCAL_DEV_USER_ID?: string;
	/** Cloudflare D1 database binding */
	DB: D1Database;
	/** The page search index (FTS5). Separate from DB so DB stays exportable. */
	SEARCH?: D1Database;
	/** Cloudflare R2 bucket for file storage (PDFs, covers) */
	R2_BUCKET?: R2Bucket;
	/** Secret used for HMAC-SHA256 signing of file access tokens */
	FILE_SIGNING_SECRET?: string;
	/** Cloudflare Workers AI binding */
	AI?: Ai;
	/** Cloudflare Vectorize index binding */
	VECTORIZE?: VectorizeIndex;
	/** Cloudflare Access team domain, e.g. https://myteam.cloudflareaccess.com */
	TEAM_DOMAIN?: string;
	/** Cloudflare Access application AUD tag */
	POLICY_AUD?: string;
	/** Email address of the admin user (matched against CF Access JWT email claim) */
	ADMIN_EMAIL?: string;
	/**
	 * "true" serves GET /api/catalogue without a session — titles, creators and
	 * page counts only. Files and page text always require one. See api/public.ts.
	 */
	PUBLIC_CATALOGUE?: string;
	/** Session duration in hours for sliding window expiry (default: 12) */
	SESSION_DURATION_HOURS?: string;
	/** Model provider keys; a provider without a key is left off the model roster */
	ANTHROPIC_API_KEY?: string;
	OPENAI_API_KEY?: string;
	GOOGLE_GENERATIVE_AI_API_KEY?: string;
	/** AUD tag of the Cloudflare Access application covering /api/mcp */
	MCP_POLICY_AUD?: string;
	/** Client ID of the Access service token allowed to call /api/mcp */
	MCP_SERVICE_TOKEN_ID?: string;
}

// ============================================================================
// Auth Types
// ============================================================================

export type UserRole = 'admin' | 'member';

export interface AuthContext {
	user: { id: string; email: string };
	role: UserRole;
}

export type AuthErrorCode =
	| 'TOKEN_MISSING'
	| 'TOKEN_EXPIRED'
	| 'TOKEN_INVALID_SIGNATURE'
	| 'TOKEN_INVALID_AUDIENCE'
	| 'JWKS_FETCH_FAILED'
	| 'SERVER_CONFIG_ERROR'
	| 'AUTH_CONTEXT_MISSING'
	| 'SESSION_MISSING'
	| 'SESSION_EXPIRED'
	| 'JWT_VERIFICATION_FAILED';

export interface AuthError {
	error: string;
	code: AuthErrorCode;
	details: string | null;
	hint: string | null;
}

export interface AuthDiagnostic {
	authenticated: boolean;
	user: { id: string; email: string } | null;
	role: UserRole | null;
	diagnostics: {
		jwtHeaderPresent: boolean;
		jwtValid: boolean;
		jwksCacheStatus: 'hit' | 'miss' | 'error';
		jwksLastFetch: string | null;
		userRecordExists: boolean;
		envVarsPresent: {
			TEAM_DOMAIN: boolean;
			POLICY_AUD: boolean;
			ADMIN_EMAIL: boolean;
			DB: boolean;
		};
	};
	timestamp: string;
}
