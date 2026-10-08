/**
 * oRPC Waitlist Router
 *
 * Tedix-native admin surface for the onboarding waitlist gate. The gate is
 * owned by the Descope `sign-up-or-in` flow + the `waitlistStatus` custom user
 * attribute (see `docs/engineering/platform/auth.md`). These handlers read and write that
 * attribute through the Descope management SDK so operators can run onboarding
 * from the Tedix admin surface instead of the raw Descope passthrough.
 *
 * All procedures are platform-admin only (`isPlatformPrincipal`) — the waitlist
 * is a cross-org, pre-onboarding concern (a waitlisted user belongs to no org
 * yet), so these deliberately skip `requireOrganizationAccess`.
 */

import { implement } from "@orpc/server";
import { waitlistContract } from "@tedix/api-contract/contracts/waitlist";
import type {
	WaitlistStatusState,
	WaitlistUser,
} from "@tedix/api-contract/schemas/waitlist";
import { getManagementClient } from "@tedix/auth/client";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { auditActor, emitAuditEvent } from "../audit-helpers";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withFleetAuthority,
} from "../orpc";

/** Descope custom attribute key backing the waitlist gate. */
const WAITLIST_ATTR = "waitlistStatus";

/**
 * Minimal shape of the Descope user record we consume. The SDK returns more,
 * but these are the fields the waitlist view projects.
 */
type DescopeUserLike = {
	userId: string;
	loginIds?: string[];
	email?: string;
	name?: string;
	status?: string;
	customAttributes?: Record<string, unknown> | null;
	createdTime?: number;
	userTenants?: unknown[];
};

const waitlistOs = implement(waitlistContract).$context<BaseContext>();
const authedWaitlistOs = waitlistOs.use(withAuth).use(withFleetAuthority);

// =============================================================================
// HELPERS
// =============================================================================

/** Lazy Descope management client; null when the key is not configured. */
function getDescopeManagement(env: CloudflareEnv) {
	if (!env.DESCOPE_MANAGEMENT_KEY) return null;
	return getManagementClient({
		DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
	});
}

function requireManagement(context: BaseContext) {
	const mgmt = getDescopeManagement(context.env);
	if (!mgmt) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Descope management API unavailable (DESCOPE_MANAGEMENT_KEY not configured)",
		);
	}
	return mgmt;
}

/**
 * Platform-admin gate. The waitlist is a cross-org concern, so we require
 * platform authority (user `platform-admin` role, API-key `platform:admin`
 * scope, or `platform:admin`) rather than org membership.
 */
function requirePlatformAdmin(context: BaseContext): void {
	if (!isPlatformPrincipal(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Platform admin authority required to manage the onboarding waitlist (user role 'platform-admin' or API key scope 'platform:admin')",
		);
	}
}

/**
 * Normalize the raw attribute to the read surface. Empty string / absent maps
 * to `unset` — the state that falls into the flow's `Else` branch.
 */
function normalizeWaitlistStatus(
	attrs: Record<string, unknown> | null | undefined,
): WaitlistStatusState {
	const raw = attrs?.[WAITLIST_ATTR];
	if (raw === "pending" || raw === "approved" || raw === "rejected") {
		return raw;
	}
	return "unset";
}

function mapUserToWaitlistRow(user: DescopeUserLike): WaitlistUser {
	return {
		userId: user.userId,
		loginId: user.loginIds?.[0] ?? null,
		email: user.email ?? null,
		name: user.name ?? null,
		status: user.status ?? "unknown",
		waitlistStatus: normalizeWaitlistStatus(user.customAttributes),
		tenantCount: Array.isArray(user.userTenants) ? user.userTenants.length : 0,
		createdAt:
			typeof user.createdTime === "number" && user.createdTime > 0
				? new Date(user.createdTime * 1000).toISOString()
				: null,
	};
}

/** Resolve a Descope user from a `{ userId?, loginId? }` reference. */
async function resolveUser(
	mgmt: ReturnType<typeof getManagementClient>,
	ref: { userId?: string; loginId?: string },
): Promise<DescopeUserLike> {
	if (!ref.userId && !ref.loginId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Provide userId or loginId to identify the user",
		);
	}
	const resp = ref.loginId
		? await mgmt.management.user.load(ref.loginId)
		: await mgmt.management.user.loadByUserId(ref.userId as string);
	if (!resp.ok || !resp.data) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			`Descope user not found for ${ref.loginId ?? ref.userId}`,
		);
	}
	return resp.data as unknown as DescopeUserLike;
}

// =============================================================================
// HANDLERS
// =============================================================================

export const listWaitlistContract = authedWaitlistOs.list
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		requirePlatformAdmin(context);
		const mgmt = requireManagement(context);

		const resp = await mgmt.management.user.search({
			limit: input.limit,
			page: input.page,
			// Newest-first. Descope's default search order is not by recency, so
			// without this the freshest signups fall off the back of the paged
			// window — page 0 is an arbitrary (roughly oldest) slice and a brand-new
			// signup never surfaces. This is load-bearing for the `unset` path in
			// particular, where the in-app filter below only ever sees one page.
			sort: [{ field: "createdTime", desc: true }],
			// `unset` cannot be expressed as a Descope attribute filter (empty
			// value), so we only push the three concrete values server-side and
			// filter `unset` in-app below.
			...(input.status && input.status !== "unset"
				? { customAttributes: { [WAITLIST_ATTR]: input.status } }
				: {}),
		});
		if (!resp.ok || !resp.data) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				resp.error?.errorMessage ?? "Failed to search Descope users",
			);
		}

		const data = resp.data as unknown as {
			users?: DescopeUserLike[];
			total?: number;
		};
		let rows = (data.users ?? []).map(mapUserToWaitlistRow);
		if (input.status === "unset") {
			rows = rows.filter((row) => row.waitlistStatus === "unset");
		}

		return {
			users: rows,
			total:
				input.status === "unset" ? rows.length : (data.total ?? rows.length),
			page: input.page,
			limit: input.limit,
		};
	});

export const getWaitlistStatusContract = authedWaitlistOs.getWaitlistStatus
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		requirePlatformAdmin(context);
		const mgmt = requireManagement(context);
		const user = await resolveUser(mgmt, input);
		return mapUserToWaitlistRow(user);
	});

export const updateWaitlistStatusContract =
	authedWaitlistOs.updateWaitlistStatus
		.use(AUTHZ.platformAdmin)
		.handler(async ({ input, context }) => {
			requirePlatformAdmin(context);
			const mgmt = requireManagement(context);

			const user = await resolveUser(mgmt, input);
			const loginId = user.loginIds?.[0];
			if (!loginId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Descope user ${user.userId} has no login ID to update`,
				);
			}

			const previousStatus = normalizeWaitlistStatus(user.customAttributes);

			const update = await mgmt.management.user.updateCustomAttribute(
				loginId,
				WAITLIST_ATTR,
				input.status,
			);
			if (!update.ok) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					update.error?.errorMessage ??
						`Failed to set ${WAITLIST_ATTR} on ${loginId}`,
				);
			}

			// Audit — waitlist grants/denials are compliance-relevant. Scope the
			// row to the caller's org (the target user has no org yet); best-effort
			// so a missing org context never blocks the actual status write.
			if (context.organizationId) {
				const actor = auditActor(context);
				await emitAuditEvent(context.db, {
					organizationId: context.organizationId,
					actorId: actor.actorId,
					actorType: actor.actorType,
					action: "waitlist.status_set",
					resourceType: "descope_user",
					resourceId: user.userId,
					metadata: {
						...actor.actorMetadata,
						loginId,
						previousStatus,
						newStatus: input.status,
						...(input.reason ? { reason: input.reason } : {}),
					},
					ipAddress: context.headers.get("CF-Connecting-IP"),
					userAgent: context.headers.get("User-Agent"),
				});
			}

			// Reflect the new value without a second round-trip to Descope.
			const updatedUser: DescopeUserLike = {
				...user,
				customAttributes: {
					...user.customAttributes,
					[WAITLIST_ATTR]: input.status,
				},
			};

			return {
				user: mapUserToWaitlistRow(updatedUser),
				previousStatus,
			};
		});

export const waitlistContractRouter = waitlistOs.router({
	list: listWaitlistContract,
	getWaitlistStatus: getWaitlistStatusContract,
	updateWaitlistStatus: updateWaitlistStatusContract,
});
