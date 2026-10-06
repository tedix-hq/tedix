/**
 * API Keys Schema
 * Organization-level API keys for programmatic access
 *
 * API keys are scoped to organizations and can have different environments (test/live)
 * and permission scopes. Keys are hashed for security - only the preview is stored.
 */

import type { ApiKeyScope as ContractApiKeyScope } from "@tedix/api-contract/schemas/organization";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

// ============================================================================
// API Keys Table
// ============================================================================

export const apiKeys = sqliteTable(
	"api_keys",
	{
		id: text("id").primaryKey(),

		// Organization reference (foreign key with cascade delete)
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		// Key identification
		name: text("name").notNull(),
		description: text("description"),

		// Key storage (security)
		// keyHash: SHA-256 hash of the actual key (for verification)
		// keyPreview: Last 8 characters for UI display (e.g., "...abc12345")
		keyHash: text("key_hash").notNull().unique(),
		keyPreview: text("key_preview").notNull(),

		// Permissions
		// Array of permission scopes this key has access to
		scopes: text("scopes", { mode: "json" }).$type<ApiKeyScope[]>(),

		// Environment
		// test: Can only access test/sandbox data
		// live: Full production access
		environment: text("environment", {
			enum: ["test", "live"],
		}).default("test"),

		// Usage tracking
		lastUsedAt: text("last_used_at"),
		requestsThisMonth: integer("requests_this_month").default(0),
		totalRequests: integer("total_requests").default(0),

		// Security restrictions
		// Optional IP allowlist (null = any IP allowed)
		ipAllowlist: text("ip_allowlist", { mode: "json" }).$type<string[]>(),
		// Optional expiration date
		expiresAt: text("expires_at"),

		// Historical configuration retained in storage; no current rate enforcement.
		rateLimit: integer("rate_limit"),

		// Status
		status: text("status", {
			enum: ["active", "revoked", "expired"],
		}).default("active"),

		// Rotation tracking
		rotatedAt: text("rotated_at"),
		rotationScheduleDays: integer("rotation_schedule_days"), // e.g., 90 for 90-day rotation
		previousKeyHash: text("previous_key_hash"), // Hash of old key during grace period
		previousKeyExpiresAt: text("previous_key_expires_at"), // When the old key stops working

		// Revocation tracking
		revokedAt: text("revoked_at"),
		revokedBy: text("revoked_by"), // descopeUserId who revoked
		revokeReason: text("revoke_reason"),

		// Metadata
		metadata: text("metadata", { mode: "json" }).$type<ApiKeyMetadata>(),

		// Audit trail
		createdBy: text("created_by"), // descopeUserId who created
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_api_key_org").on(table.organizationId),
		index("idx_api_key_status").on(table.status),
		index("idx_api_key_env").on(table.environment),
		index("idx_api_key_hash").on(table.keyHash),
	],
);

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * API key permission scopes.
 *
 * Re-exported from `@tedix/api-contract` rather than restated. Three copies of
 * this list used to exist — this one, `ApiKeyScopeSchema`, and a hand-written
 * inline cast in the `createApiKey` handler — and all three disagreed: the DB
 * union was missing `platform:admin`, and the inline cast was missing
 * `apps:delete`, `team:write`, and `tedis:read`. A scope the contract accepts
 * but the DB type omits forces exactly the kind of cast that hides the next
 * divergence, so the contract enum is now the only definition.
 */
export type ApiKeyScope = ContractApiKeyScope;

/**
 * API key metadata
 * Additional key information
 */
export interface ApiKeyMetadata {
	/** User agent from last request */
	lastUserAgent?: string;
	/** IP address from last request */
	lastIpAddress?: string;
	/** Notes about this key's purpose */
	notes?: string;
	/** Tags for organization */
	tags?: string[];
}

// ============================================================================
// Inferred Types
// ============================================================================

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

// ============================================================================
// Enum Types
// ============================================================================

export type ApiKeyEnvironment = "test" | "live";

export type ApiKeyStatus = "active" | "revoked" | "expired";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a new API key
 * Returns the raw key (to show user once) and its display preview.
 * Callers hash the key asynchronously with hashApiKey before storing it.
 */
export function generateApiKey(environment: ApiKeyEnvironment): {
	key: string;
	preview: string;
} {
	// Generate random bytes
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);

	// Convert to base64 and clean up
	const base64 = btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "")
		.replace(/\//g, "")
		.replace(/=/g, "");

	// Create key with prefix
	const prefix = environment === "live" ? "sk_live_" : "sk_test_";
	const key = `${prefix}${base64.substring(0, 40)}`;

	// Create preview (last 8 chars)
	const preview = `...${key.slice(-8)}`;

	return {
		key,
		preview,
	};
}

/**
 * Hash an API key for storage
 * Uses SHA-256 via Web Crypto API
 */
export async function hashApiKey(key: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check if an IP address matches a CIDR range or exact IP
 * Supports IPv4 exact match and IPv4 CIDR notation (e.g., "192.168.1.0/24")
 */
export function matchesIpOrCidr(clientIp: string, pattern: string): boolean {
	// Exact match
	if (clientIp === pattern) return true;

	// CIDR match
	if (!pattern.includes("/")) return false;

	const parts = pattern.split("/");
	const subnet = parts[0];
	const prefixStr = parts[1];
	if (!subnet || !prefixStr) return false;
	const prefix = Number.parseInt(prefixStr, 10);
	if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;

	const ipToInt = (ip: string): number | null => {
		const octets = ip.split(".");
		if (octets.length !== 4) return null;
		let result = 0;
		for (const octet of octets) {
			const num = Number.parseInt(octet, 10);
			if (Number.isNaN(num) || num < 0 || num > 255) return null;
			result = (result << 8) | num;
		}
		return result >>> 0; // Convert to unsigned 32-bit
	};

	const clientInt = ipToInt(clientIp);
	const subnetInt = ipToInt(subnet);
	if (clientInt === null || subnetInt === null) return false;

	const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
	return (clientInt & mask) === (subnetInt & mask);
}
