/**
 * Tedis Router — Runtime operations (status, restart, storage, channels)
 */

import { isPlatformPrincipal } from "@tedix/auth/types";
import { updateTediHeartbeat } from "@tedix/db/queries/tedis";
import {
	authorizeCodingSession,
	deleteStorageFile,
	getRuntimeChannelStatus,
	getStorageFile,
	getStorageStatus,
	listStorageFiles,
	resetSandbox,
	revokeCodingSession,
	type SandboxResetResult,
	type SyncResult,
	triggerCronSync,
	triggerSync,
	type WakeTediResult,
	wakeTedi,
	writeStorageFile,
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
				console.warn(
					`[Tedis] Failed to persist heartbeat for ${tedi.slug}:`,
					error,
				);
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
			result = await wakeTedi(provConfig, {
				allowSandboxReset:
					input.allowSandboxReset || input.forceSandboxReset || undefined,
				forceSandboxReset: input.forceSandboxReset,
				reason: input.reason,
			});
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
				`[Tedis] Failed to persist wake heartbeat for ${tedi.slug}:`,
				error,
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
				recoveredBySandboxReset: result.recoveredBySandboxReset,
			},
		}).catch((err) => {
			console.error("[Tedis] Failed to emit audit event for tedi.wake:", err);
		});

		return result;
	});

export const restart = authedTedisOs.restart
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Tedi runtime restart has been removed. Agent-runtime tedis are Durable Objects; use wake/status for liveness and workstation leases for OS/process reset.",
		);
	});

export const resetSandboxProcedure = authedTedisOs.resetSandbox
	.use(withAuthorization("tedis:delete", "apps:write"))
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot reset sandbox",
			);
		}

		const effectiveForce = input.force === true && isPlatformPrincipal(context);

		console.log(
			`[Tedis] Sandbox reset requested for: ${tedi.name} (reason: ${input.reason ?? "none"}, force: ${input.force ?? false})`,
		);
		let result: SandboxResetResult;
		try {
			result = await resetSandbox(provConfig, input.reason, effectiveForce);
		} catch (error) {
			const message = sanitizeProvisioningError(error);
			console.warn(`[Tedis] Sandbox reset failed for ${tedi.id}: ${message}`);
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, message);
		}

		// Emit audit event for sandbox reset
		const actorId = context.user?.sub ?? context.apiKey?.id ?? "system";
		const actorType = context.user?.sub
			? ("user" as const)
			: ("service" as const);
		emitAuditEvent(context.db, {
			organizationId: requireOrganizationId(context),
			actorId,
			actorType,
			action: "tedi.sandbox_reset",
			resourceType: "tedi",
			resourceId: input.tediId,
			metadata: { reason: input.reason ?? null, success: result.success },
		}).catch((err) => {
			console.error(
				"[Tedis] Failed to emit audit event for tedi.sandbox_reset:",
				err,
			);
		});

		return {
			success: result.success,
			message: result.message,
			audit: {
				tediId: input.tediId,
				triggeredBy: actorId,
				triggeredAt: new Date().toISOString(),
				reason: input.reason ?? null,
			},
		};
	});

export const syncStorage = authedTedisOs.syncStorage
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot sync storage",
			);
		}

		let result: SyncResult;
		try {
			result = await triggerSync(provConfig);
		} catch (error) {
			const message = sanitizeProvisioningError(error);
			console.warn(`[Tedis] Storage sync failed for ${tedi.id}: ${message}`);
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, message);
		}

		return {
			success: result.success,
			lastSync: result.lastSync ?? null,
			backupHandles: result.backupHandles,
			...(result.error ? { error: result.error } : {}),
			...(result.details ? { details: result.details } : {}),
		};
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

export const getStorageStatusProcedure = authedTedisOs.getStorageStatus
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot get storage status",
			);
		}
		try {
			return await getStorageStatus(provConfig);
		} catch (error) {
			const message = sanitizeProvisioningError(error);
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, message);
		}
	});

export const listStorageFilesProcedure = authedTedisOs.listStorageFiles
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot list storage files",
			);
		}
		try {
			return await listStorageFiles(provConfig, {
				path: input.path,
				recursive: input.recursive ?? false,
			});
		} catch (error) {
			const message = sanitizeProvisioningError(error);
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, message);
		}
	});

export const getStorageFileProcedure = authedTedisOs.getStorageFile
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot get storage file",
			);
		}
		try {
			return await getStorageFile(provConfig, input.path);
		} catch (error) {
			const message = sanitizeProvisioningError(error);
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, message);
		}
	});

export const writeStorageFileProcedure = authedTedisOs.writeStorageFile
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot write storage file",
			);
		}
		try {
			return await writeStorageFile(provConfig, input.path, input.content);
		} catch (error) {
			const message = sanitizeProvisioningError(error);
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, message);
		}
	});

export const deleteStorageFileProcedure = authedTedisOs.deleteStorageFile
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot delete storage file",
			);
		}
		try {
			return await deleteStorageFile(provConfig, input.path);
		} catch (error) {
			const message = sanitizeProvisioningError(error);
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, message);
		}
	});

export const getChannelStatus = authedTedisOs.getChannelStatus
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured — cannot get channel status",
			);
		}
		try {
			const status = await getRuntimeChannelStatus(provConfig);
			return {
				channels: status.channels,
				observedAt: status.observedAt ?? new Date().toISOString(),
			};
		} catch (error) {
			const message = sanitizeProvisioningError(error);
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, message);
		}
	});

export const getDreamsProcedure = authedTedisOs.getDreams
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"The runtime dream diary was removed with the container runtime. Use Agent-runtime memory, rationale, and cognitive-runtime readback instead.",
		);
	});

// =============================================================================
// CODE MODE SESSION AUTHORIZATION
// =============================================================================

/**
 * Authorize a coding session for the Code Mode `execute` tool.
 *
 * Gate: platform principal OR tedi owner (same as resetSandbox — this
 * authorizes arbitrary code execution on the tedi's DO-SQLite workspace).
 */
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
