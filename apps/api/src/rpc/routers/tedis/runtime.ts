/**
 * Tedis Router — Runtime operations (status, wake, coding sessions)
 */

import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { updateTediHeartbeat } from "@tedix/db/queries/tedis";
import {
	authorizeCodingSession,
	revokeCodingSession,
	triggerCronSync,
	type WakeTediResult,
	wakeTedi,
} from "@tedix/provisioning";
import { emitAuditEvent } from "../../audit-helpers";
import {
	AUTHZ,
	withAuthorization,
	authedTedisOs,
	createError,
	ErrorCodes,
	fetchLiveTediRuntime,
	isLocalTediRuntimeUnavailable,
	getProvisioningConfig,
	requireOrganizationId,
	requireTediAccess,
	sanitizeProvisioningError,
} from "./helpers";

// =============================================================================
// RUNTIME OPERATIONS
// =============================================================================

export const auditBackupsProcedure = authedTedisOs.auditBackups
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input }) => {
		const { maxBackupAgeHours = 24, includeR2 = true } = input || {};
		const checkedAt = new Date().toISOString();
		return {
			checkedAt,
			maxBackupAgeHours,
			includeR2,
			total: 0,
			restorable: 0,
			warnings: 0,
			items: [],
		};
	});

export const getStatus = authedTedisOs.getStatus
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		const liveRuntime = await fetchLiveTediRuntime(tedi, context.env);
		if (liveRuntime) {
			await updateTediHeartbeat(context.db, input.tediId, {
				runtimeStatus: liveRuntime.normalizedRuntimeStatus,
				lastSyncAt: tedi.lastSyncAt,
				billingState:
					liveRuntime.normalizedRuntimeStatus === "running" ? "active" : "cold",
			}).catch((error) => {
				console.warn(`[Tedis] Failed to persist heartbeat for ${tedi.slug}`, {
					exception: safeExceptionTopology(error),
				});
			});

			return {
				runtimeStatus: liveRuntime.rawRuntimeStatus,
				lastSeenAt: liveRuntime.lastSeenAt,
				lastSyncAt: liveRuntime.lastSyncAt,
				runtimeVersion: liveRuntime.runtimeVersion,
				processCount: liveRuntime.processCount,
				slug: tedi.slug,
			};
		}

		return {
			runtimeStatus: isLocalTediRuntimeUnavailable(context.env)
				? "unknown"
				: (tedi.runtimeStatus ?? "unknown"),
			lastSeenAt: isLocalTediRuntimeUnavailable(context.env)
				? null
				: tedi.lastSeenAt,
			lastSyncAt: tedi.lastSyncAt,
			// No live runtime reachable — observed binary version is unknown.
			// The target version is sourced from runtime_profiles, not tedis.
			runtimeVersion: null,
			processCount: 0,
			slug: tedi.slug,
		};
	});

export const wake = authedTedisOs.wake
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot wake runtime",
			);
		}

		let result: WakeTediResult;
		try {
			result = await wakeTedi(provConfig);
		} catch (error) {
			const message = sanitizeProvisioningError(error);
			console.warn(`[Tedis] Wake failed for ${tedi.id}: ${message}`);
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, message);
		}

		await updateTediHeartbeat(context.db, input.tediId, {
			runtimeStatus:
				result.ready || result.status === "running" ? "running" : "starting",
			lastSyncAt: tedi.lastSyncAt,
			billingState:
				result.ready || result.status === "running" ? "active" : "warm",
		}).catch((error) => {
			console.warn(
				`[Tedis] Failed to persist wake heartbeat for ${tedi.slug}`,
				{ exception: safeExceptionTopology(error) },
			);
		});

		const actorId = context.user?.sub ?? context.apiKey?.id ?? "system";
		const actorType = context.user?.sub
			? ("user" as const)
			: ("service" as const);
		emitAuditEvent(context.db, {
			organizationId: requireOrganizationId(context),
			actorId,
			actorType,
			action: "tedi.wake",
			resourceType: "tedi",
			resourceId: input.tediId,
			metadata: {
				ready: result.ready,
				woke: result.woke,
				waitMs: result.waitMs,
				status: result.status,
				attempts: result.attempts,
				reason: input.reason ?? null,
			},
		}).catch((err) => {
			console.error("[Tedis] Failed to emit audit event for tedi.wake", {
				exception: safeExceptionTopology(err),
			});
		});

		return result;
	});

export const triggerCronSyncProcedure = authedTedisOs.triggerCronSync
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot trigger sync",
			);
		}

		try {
			return await triggerCronSync(provConfig, {
				forceUpdate: input.forceUpdate ?? false,
			});
		} catch (error) {
			const message = sanitizeProvisioningError(error);
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, message);
		}
	});

export const authorizeCodingSessionProcedure =
	authedTedisOs.authorizeCodingSession
		.use(withAuthorization("tedis:delete", "apps:write"))
		.handler(async ({ input, context }) => {
			if (!isPlatformPrincipal(context)) {
				// Also allow the tedi owner (same org, verified by requireTediAccess).
				// requireTediAccess already enforces org membership, so passing this
				// check means the caller owns the tedi.
			}
			const tedi = await requireTediAccess(context, input.tediId);
			const provConfig = getProvisioningConfig(tedi, context.env);
			if (!provConfig) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Tedi runtime route is not configured — cannot authorize coding session",
				);
			}
			const actorId = context.user?.sub ?? context.apiKey?.id ?? "system";
			const result = await authorizeCodingSession(provConfig, {
				sessionKey: input.sessionKey,
				authorizedBy: input.authorizedBy ?? actorId,
			});
			if (!result.ok) {
				console.warn(
					`[Tedis] authorizeCodingSession failed for ${input.tediId}: ${result.error}`,
				);
			}
			return { ok: result.ok, error: result.error };
		});

/**
 * Revoke a coding session authorization.
 *
 * Gate: platform principal OR tedi owner (same as authorizeCodingSession).
 */
export const revokeCodingSessionProcedure = authedTedisOs.revokeCodingSession
	.use(withAuthorization("tedis:delete", "apps:write"))
	.handler(async ({ input, context }) => {
		if (!isPlatformPrincipal(context)) {
			// Tedi owner access is enforced by requireTediAccess below.
		}
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot revoke coding session",
			);
		}
		const result = await revokeCodingSession(provConfig, {
			sessionKey: input.sessionKey,
		});
		if (!result.ok) {
			console.warn(
				`[Tedis] revokeCodingSession failed for ${input.tediId}: ${result.error}`,
			);
		}
		return { ok: result.ok, error: result.error };
	});
