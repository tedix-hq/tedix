/// <reference path="../../worker-configuration.d.ts" />

import { rotateTediAccessKey } from "@tedix/auth/tedi-identity";
import { createDbClient } from "@tedix/db/client";
import { emitAuditEvent } from "../rpc/audit-helpers";

export const TEDI_ACCESS_KEY_ROTATE_AFTER_DAYS = 60;
const MAX_ROTATIONS_PER_TICK = 25;
const ROTATION_LEASE_NAME = "descope-access-key-rotation";
const ROTATION_LEASE_TTL_MS = 5 * 60_000;

export async function runTediAccessKeyRotationTick(
	env: CloudflareEnv,
	runId: string,
	now = new Date(),
): Promise<Record<string, number>> {
	if (
		!env.DESCOPE_PROJECT_ID ||
		!env.DESCOPE_MANAGEMENT_KEY ||
		!env.SECRETS_MASTER_KEY
	) {
		return {};
	}

	const { getManagementClient } = await import("@tedix/auth/client");
	const {
		getTediSecret,
		getTediSecretById,
		listTediAccessKeysDueForRotation,
		replaceTediAccessKeySecrets,
	} = await import("@tedix/db/queries/tedi-secrets");
	const { releaseTediRuntimeLease, tryAcquireTediRuntimeLease } =
		await import("@tedix/db/queries/tedis");
	const { decryptTediSecret, encryptTediSecret } =
		await import("@tedix/db/utils/secrets-encryption");
	const { invalidateConfig } = await import("@tedix/provisioning");
	const { getProvisioningConfig } =
		await import("../rpc/routers/tedis/helpers");

	const db = createDbClient(env.DB);
	const cutoff = new Date(
		now.getTime() - TEDI_ACCESS_KEY_ROTATE_AFTER_DAYS * 86_400_000,
	).toISOString();
	const candidates = await listTediAccessKeysDueForRotation(db, {
		updatedBefore: cutoff,
		limit: MAX_ROTATIONS_PER_TICK,
	});
	const counts = {
		candidates: candidates.length,
		rotated: 0,
		leaseContended: 0,
		skippedMissingKeyId: 0,
		failed: 0,
		oldKeyDeactivationFailed: 0,
		oldKeyDeactivationDeferred: 0,
		runtimeRefreshFailed: 0,
	};
	const client = getManagementClient(env);

	for (const candidate of candidates) {
		const leaseOwner = `${runId}:${candidate.tediId}`;
		const acquired = await tryAcquireTediRuntimeLease(db, {
			tediId: candidate.tediId,
			name: ROTATION_LEASE_NAME,
			owner: leaseOwner,
			ttlMs: ROTATION_LEASE_TTL_MS,
			nowMs: now.getTime(),
		});
		if (!acquired) {
			counts.leaseContended += 1;
			continue;
		}

		try {
			// Re-read after taking the lease. A prior runner may have rotated this
			// candidate between discovery and acquisition.
			const [accessKeySecret, accessKeyIdSecret] = await Promise.all([
				getTediSecretById(db, candidate.accessKeySecretId),
				getTediSecret(db, candidate.tediId, "DESCOPE_ACCESS_KEY_ID"),
			]);
			if (!accessKeySecret || accessKeySecret.updatedAt > cutoff) continue;
			if (!accessKeyIdSecret) {
				counts.skippedMissingKeyId += 1;
				continue;
			}

			const oldKeyId = await decryptTediSecret(
				env.SECRETS_MASTER_KEY,
				candidate.tediId,
				accessKeyIdSecret.encryptedValue,
			);
			let replacementKeyId: string | null = null;
			try {
				const replacement = await rotateTediAccessKey(client, {
					slug: candidate.slug ?? candidate.tediId,
					descopeUserId: candidate.descopeUserId!,
					oldKeyId,
					tediId: candidate.tediId,
					deactivateOld: false,
				});
				replacementKeyId = replacement.descopeKeyId;
				const [encryptedAccessKey, encryptedAccessKeyId] = await Promise.all([
					encryptTediSecret(
						env.SECRETS_MASTER_KEY,
						candidate.tediId,
						replacement.cleartext,
					),
					encryptTediSecret(
						env.SECRETS_MASTER_KEY,
						candidate.tediId,
						replacement.descopeKeyId,
					),
				]);
				await replaceTediAccessKeySecrets(db, {
					accessKeySecretId: accessKeySecret.id,
					accessKeyIdSecretId: accessKeyIdSecret.id,
					encryptedAccessKey,
					encryptedAccessKeyId,
					updatedAt: now.toISOString(),
				});
			} catch (error) {
				// The old key is still active because rotation creation deliberately
				// defers deactivation until after the atomic D1 replacement. If D1
				// persistence fails, retire the unreferenced replacement best-effort.
				if (replacementKeyId) {
					await client.management.accessKey
						.deactivate(replacementKeyId)
						.catch(() => undefined);
				}
				throw error;
			}

			const provisioningConfig = getProvisioningConfig(candidate, env);
			const runtimeRefreshed = provisioningConfig
				? await invalidateConfig(provisioningConfig)
				: false;
			if (!runtimeRefreshed) counts.runtimeRefreshFailed += 1;

			let oldKeyDeactivated = false;
			if (runtimeRefreshed) {
				try {
					const response =
						await client.management.accessKey.deactivate(oldKeyId);
					oldKeyDeactivated = response.ok;
				} catch {
					oldKeyDeactivated = false;
				}
				if (!oldKeyDeactivated) counts.oldKeyDeactivationFailed += 1;
			} else {
				// Preserve availability when the runtime did not acknowledge the new
				// D1 secret. The old key remains bounded by its original 90-day expiry.
				counts.oldKeyDeactivationDeferred += 1;
			}
			counts.rotated += 1;

			await emitAuditEvent(db, {
				organizationId: candidate.organizationId,
				actorId: "platform-cron",
				actorType: "service",
				action: "tedi.auth.rotate_access_key",
				resourceType: "tedi",
				resourceId: candidate.tediId,
				metadata: {
					source: "scheduled",
					runId,
					accessKeyAgeDays: Math.floor(
						(now.getTime() - new Date(accessKeySecret.updatedAt).getTime()) /
							86_400_000,
					),
					replacementKeyId,
					oldKeyDeactivated,
					runtimeRefreshed,
				},
			});
		} catch (error) {
			counts.failed += 1;
			console.error(
				`[tedi-access-key-rotation] failed for tedi ${candidate.tediId}`,
				error,
			);
		} finally {
			await releaseTediRuntimeLease(db, {
				tediId: candidate.tediId,
				name: ROTATION_LEASE_NAME,
				owner: leaseOwner,
			}).catch(() => undefined);
		}
	}

	console.log(
		JSON.stringify({
			job: "tedi-access-key-rotation",
			runId,
			asOf: now.toISOString(),
			cutoff,
			...counts,
		}),
	);
	return counts;
}
