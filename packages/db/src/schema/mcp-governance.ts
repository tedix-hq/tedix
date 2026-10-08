/**
 * MCP tool-approval grants.
 *
 * A NEW, ISOLATED grant layer for the raw `tools/call` trust boundary enforced
 * by `apps/mcp/src/mcp/governance.ts`'s `requireDestructiveToolApproval`. This
 * is deliberately NOT the kernel write-proposal approval system
 * (`kernel_runtime_runs.metadata.sessionWriteAllowlist`,
 * `packages/api-contract/src/utils/approval-policy.ts`'s
 * `decideKernelWriteApproval`) — that governs a different trust boundary (a
 * kernel turn's write proposals) and is out of scope here by design. Do not
 * converge the two.
 *
 * A grant is a durable, operator-issued pre-authorization that lets a
 * destructive MCP tool call skip the per-call elicitation/MRTR round-trip.
 * Nothing in this batch creates grants automatically — issuance is a manual
 * operator action via `createGrant` (queries layer only; no RPC/UI wired yet,
 * intentionally — see `docs/engineering/mcp/runtime.md` follow-up).
 *
 * Additive table only. No existing table is altered.
 */

import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { uuid4Default } from "./_sql-helpers";
import { organizations } from "./organizations";

export const MCP_TOOL_APPROVAL_GRANT_KIND_VALUES = ["once", "always"] as const;
export type McpToolApprovalGrantKind =
	(typeof MCP_TOOL_APPROVAL_GRANT_KIND_VALUES)[number];

/**
 * `subjectId` is the granting/grantee identity — the normalized caller actor
 * id from `apps/mcp/src/mcp/caller-identity.ts`'s `normalizeCallerIdentity`
 * (tedi id, service/m2m client id, or user id depending on `authType`). Grants
 * are per-subject: a grant issued to one tedi/user/service identity never
 * satisfies a call from a different one, even within the same organization.
 *
 * `toolId` stores a SCOPE PATTERN, not necessarily a bare tool id, in the
 * `{appSlug}:{toolId}` shape mirroring `decideKernelWriteApproval`'s
 * `writeTier.trustedTools` allowlist entries for a consistent mental model:
 *   - `{appSlug}:{toolId}`  — exact tool, exact app
 *   - `{appSlug}:*`         — every tool in one app
 *   - `*:*`                 — every tool in every app (use sparingly)
 * Matching is EXACT-STRING-EQUALITY only against this finite candidate set
 * (see `packages/db/src/queries/mcp-governance.ts`'s `buildGrantScopeCandidates`)
 * — never a LIKE/prefix/substring match — so a grant can never accidentally
 * widen past what was explicitly typed.
 */
export const mcpToolApprovalGrants = sqliteTable(
	"mcp_tool_approval_grants",
	{
		id: text("id").primaryKey().default(uuid4Default()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		subjectId: text("subject_id").notNull(),
		/** Scope pattern — see column doc above. Normalized lowercase/trimmed. */
		toolId: text("tool_id").notNull(),
		grantKind: text("grant_kind", {
			enum: MCP_TOOL_APPROVAL_GRANT_KIND_VALUES,
		}).notNull(),
		/**
		 * Stamped exactly once when a "once" grant is consumed — the single-use
		 * fence. NULL = unconsumed/active. A CAS write
		 * (`UPDATE ... WHERE consumed_at IS NULL`) is the only way this column is
		 * ever set, so a grant is consumable exactly once even under a race.
		 */
		consumedAt: text("consumed_at"),
		/** Nullable — a NULL expiry never expires. */
		expiresAt: text("expires_at"),
		reason: text("reason"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		// Primary lookup path: findActiveGrant filters on all three, then filters
		// candidate scope patterns client-side via repeated exact-eq queries.
		index("idx_mcp_tool_approval_grants_lookup").on(
			table.organizationId,
			table.subjectId,
			table.toolId,
		),
		index("idx_mcp_tool_approval_grants_expiry").on(table.expiresAt),
	],
);

export type McpToolApprovalGrant = typeof mcpToolApprovalGrants.$inferSelect;
export type NewMcpToolApprovalGrant = typeof mcpToolApprovalGrants.$inferInsert;
