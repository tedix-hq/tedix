/**
 * Audit Trail Helpers
 * Utility for emitting audit events from any router handler
 */

import type { JWTPayload } from "@tedix/auth/types";
import { isPlatformPrincipal } from "@tedix/auth/types";
import type { DbClient } from "@tedix/db/client";
import { type AuditActorType, insertAuditEvent } from "@tedix/db/queries/audit";
import { toJsonRecord } from "@tedix/db/utils/json";

/**
 * Emit an audit event to the audit_events table.
 *
 * Call this from any router handler to record a significant action.
 *
 * @example
 * ```typescript
 * await emitAuditEvent(context.db, {
 *   organizationId: orgId,
 *   actorId: context.user.sub,
 *   actorType: "user",
 *   action: "app.created",
 *   resourceType: "app",
 *   resourceId: app.id,
 *   metadata: { slug: app.slug },
 *   ipAddress: context.headers.get("CF-Connecting-IP"),
 *   userAgent: context.headers.get("User-Agent"),
 * });
 * ```
 */
export async function emitAuditEvent(
	db: DbClient,
	event: {
		organizationId: string;
		actorId: string;
		actorType: AuditActorType;
		action: string;
		resourceType: string;
		resourceId?: string;
		metadata?: Record<string, unknown>;
		ipAddress?: string | null;
		userAgent?: string | null;
	},
): Promise<void> {
	await insertAuditEvent(db, {
		...event,
		metadata:
			event.metadata === undefined ? undefined : toJsonRecord(event.metadata),
	});
}

/**
 * Extract `{actorId, actorType, isPlatformAdmin}` from any auth context.
 *
 * Use before `emitAuditEvent` so the audit row reflects which principal
 * actually initiated the action — User JWT, API key, M2M token, etc.
 *
 * `isPlatformAdmin` flags cross-org operations for compliance review.
 */
export function auditActor(context: {
	user?: JWTPayload;
	userId?: string;
	apiKey?: { id: string; name?: string; scopes?: string[] };
	serviceAccount?: {
		clientId?: string;
		canonicalPrincipalId?: string;
		id?: string;
		scope?: string;
	};
	authType?: string;
	tediId?: string;
	externalAgentPrincipalId?: string;
	externalAgentSessionId?: string;
	gatewayEndUserId?: string;
}): {
	actorId: string;
	actorType: AuditActorType;
	platformAdmin: boolean;
	actorMetadata: Record<string, unknown>;
} {
	const platformAdmin = isPlatformPrincipal(context);

	// Checked first, matching the accountability precedence the Tedix OS domain
	// already persists on `created_by_kind` (`resolveCreator`): a gateway call
	// from a verified external agent arrives on the trusted service binding, so
	// without this branch every such write collapsed into
	// `actorType: "service"` / `actorId: "service-binding"` — the same blind spot
	// the tedi branch below was added to close. Only the trusted binding can set
	// this field (`withAuth` validates the gateway headers), and such a request
	// never carries `context.user`.
	if (context.externalAgentPrincipalId) {
		return {
			actorId: context.externalAgentPrincipalId,
			actorType: "external_agent",
			platformAdmin,
			actorMetadata: {
				sessionId: context.externalAgentSessionId,
				gatewayEndUserId: context.gatewayEndUserId,
				...(platformAdmin ? { platformAdmin: true } : {}),
			},
		};
	}
	if (context.userId ?? context.user?.sub) {
		return {
			actorId: context.userId ?? context.user?.sub ?? "unknown-user",
			actorType: "user",
			platformAdmin,
			actorMetadata: {
				email: context.user?.email,
				...(platformAdmin ? { platformAdmin: true } : {}),
			},
		};
	}
	// Checked before the generic serviceAccount/service-binding fallbacks below:
	// a tedi access-key caller (`context.authType === "tedi"`) is a first-class,
	// individually identifiable principal, not a generic internal service. Without
	// this branch every tedi-authenticated write previously fell through to
	// `actorType: "service"` / `actorId: "service-binding"` (or "anonymous"),
	// making it impossible to tell which tedi performed a given action from the
	// audit trail alone — see docs/decisions/agent-capability-mutation-gate.md.
	if (context.tediId) {
		return {
			actorId: context.tediId,
			actorType: "tedi",
			platformAdmin,
			actorMetadata: platformAdmin ? { platformAdmin: true } : {},
		};
	}
	if (context.apiKey?.id) {
		return {
			actorId: context.apiKey.id,
			actorType: "api_key",
			platformAdmin,
			actorMetadata: {
				keyName: context.apiKey.name,
				scopes: context.apiKey.scopes,
				...(platformAdmin ? { platformAdmin: true } : {}),
			},
		};
	}
	const serviceAccount = context.serviceAccount;
	const serviceAccountId =
		serviceAccount?.canonicalPrincipalId ??
		serviceAccount?.clientId ??
		serviceAccount?.id;
	if (serviceAccount && serviceAccountId) {
		return {
			actorId: serviceAccountId,
			actorType: "m2m",
			platformAdmin,
			actorMetadata: {
				clientId: serviceAccount.clientId,
				scope: serviceAccount.scope,
				...(platformAdmin ? { platformAdmin: true } : {}),
			},
		};
	}
	if (context.authType === "service-binding") {
		return {
			actorId: "service-binding",
			actorType: "service",
			platformAdmin: true,
			actorMetadata: { source: context.authType },
		};
	}
	return {
		actorId: "unknown",
		actorType: "anonymous",
		platformAdmin: false,
		actorMetadata: {},
	};
}
