import { getManagementClient } from "@tedix/auth/client";
import { rotateTediAccessKey } from "@tedix/auth/tedi-identity";
import { requireStepUp } from "../../step-up";
import { getTediSecret } from "@tedix/db/queries/tedi-secrets";
import { decryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import { invalidateConfig } from "@tedix/provisioning";
import { auditActor, emitAuditEvent } from "../../audit-helpers";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	getProvisioningConfig,
	requireOrganizationId,
	requireTediAccess,
} from "./helpers";
import {
	storeEncryptedTediSecret,
	refreshTediRuntimeSecrets,
} from "./identity-provisioning";

/**
 * Rotate a tedi's Descope access key.
 *
 * Step-up gated. The rotation returns a live credential for the worker's own
 * identity, so a hijacked owner session can mint itself a tedi's key and keep
 * acting as that worker long after the session is cut off.
 */
export const rotateAccessKeyProcedure = authedTedisOs.rotateAccessKey
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		requireStepUp(context, "Rotating a tedi access key");
		const masterKey = context.env.SECRETS_MASTER_KEY;

		if (!masterKey) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"SECRETS_MASTER_KEY is not configured",
			);
		}

		if (
			!context.env.DESCOPE_MANAGEMENT_KEY ||
			!context.env.DESCOPE_PROJECT_ID
		) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Descope management is not configured",
			);
		}

		if (!tedi.descopeUserId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This tedi does not have a Descope identity yet",
			);
		}

		const existingKeyIdSecret = await getTediSecret(
			context.db,
			tedi.id,
			"DESCOPE_ACCESS_KEY_ID",
		);
		let oldKeyId: string | undefined;
		if (existingKeyIdSecret) {
			oldKeyId = await decryptTediSecret(
				masterKey,
				tedi.id,
				existingKeyIdSecret.encryptedValue,
			);
		}

		const descopeClient = getManagementClient(context.env);
		const rotation = await rotateTediAccessKey(descopeClient, {
			slug: tedi.slug ?? tedi.id,
			descopeUserId: tedi.descopeUserId,
			oldKeyId,
			tediId: tedi.id,
		});

		await storeEncryptedTediSecret(
			masterKey,
			context,
			tedi.id,
			"DESCOPE_ACCESS_KEY",
			rotation.cleartext,
		);
		await storeEncryptedTediSecret(
			masterKey,
			context,
			tedi.id,
			"DESCOPE_ACCESS_KEY_ID",
			rotation.descopeKeyId,
		);

		let runtimeRefreshed = false;
		try {
			runtimeRefreshed = await refreshTediRuntimeSecrets(context, tedi);
		} catch (error) {
			console.warn(
				`[Tedis] Failed to refresh runtime after access key rotation for ${tedi.id}:`,
				error,
			);
			const provConfig = getProvisioningConfig(tedi, context.env);
			if (provConfig) {
				const p = invalidateConfig(provConfig).catch(() => {});
				if (context.waitUntil) context.waitUntil(p);
			}
		}

		const { actorId, actorType } = auditActor(context);
		await emitAuditEvent(context.db, {
			organizationId: requireOrganizationId(context),
			actorId,
			actorType,
			action: "tedi.auth.rotate_access_key",
			resourceType: "tedi",
			resourceId: tedi.id,
			metadata: {
				descopeUserId: tedi.descopeUserId,
				descopeKeyId: rotation.descopeKeyId,
				oldKeyIdPresent: Boolean(oldKeyId),
				oldKeyDeactivated: rotation.oldKeyDeactivated,
				runtimeRefreshed,
			},
		}).catch((err) => {
			console.error(
				"[Tedis] Failed to emit audit event for tedi.auth.rotate_access_key:",
				err,
			);
		});

		return {
			success: true,
			message: rotation.oldKeyDeactivated
				? "Descope access key rotated and runtime refreshed"
				: "Descope access key rotated; previous key id was unavailable for automatic deactivation",
			descopeKeyId: rotation.descopeKeyId,
			oldKeyDeactivated: rotation.oldKeyDeactivated,
			runtimeRefreshed,
		};
	});
