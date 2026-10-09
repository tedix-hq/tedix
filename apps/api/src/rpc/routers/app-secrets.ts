/**
 * oRPC App Secrets Router
 * Encrypted secrets management for app-level API keys and credentials
 *
 * Security model:
 * - Master key: 32-byte key stored in Cloudflare Secrets Store (SECRETS_MASTER_KEY)
 * - Per-app keys: Derived using HKDF(master, appId, "app-secrets")
 * - Encryption: AES-256-GCM with random 12-byte IV per operation
 * - Storage: Base64 encoded IV + ciphertext + authTag in D1
 *
 * This router uses contract-first development with oRPC.
 * Contract is imported from @tedix/api-contract.
 */

import { implement } from "@orpc/server";
import {
	appSecretsContract,
	SecretIdParamSchema,
} from "@tedix/api-contract/contracts/secrets";
import { getAppById } from "@tedix/db/queries/app-records";
import {
	createAppSecret,
	deleteAppSecret as deleteAppSecretQuery,
	getAppSecret,
	getAppSecretById,
	listAppSecrets as listAppSecretsQuery,
	updateAppSecret,
} from "@tedix/db/queries/app-secrets";
import {
	decryptAppSecret,
	encryptAppSecret,
	generateSecretHint,
} from "@tedix/db/utils/secrets-encryption";
import {
	AUTHZ,
	type BaseContext,
	base,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

/**
 * Create the contract implementer with base context
 */
const appSecretsOs = implement(appSecretsContract).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all app secrets endpoints require authentication
 */
const authedAppSecretsOs = appSecretsOs.use(withAuth);

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Contract-based list procedure implementation
 */
export const listAppSecrets = authedAppSecretsOs.list
	.use(AUTHZ.secretsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;

		await requireAppAccess(context, appId);

		const secrets = await listAppSecretsQuery(db, appId);
		const total = secrets.length;

		return {
			data: secrets,
			pagination: {
				limit: total,
				offset: 0,
				total,
				hasMore: false,
			},
		};
	});

/**
 * Contract-based get procedure implementation
 */
// Returns the decrypted value. Tools that need a secret get it injected by
// the runtime; reading the plaintext is platform administration only.
export const getAppSecretProcedure = authedAppSecretsOs.get
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const { appId, secretId } = input;

		await requireAppAccess(context, appId);

		const secret = await getAppSecretById(db, secretId);

		if (!secret) {
			throw createError(ErrorCodes.NOT_FOUND, "Secret not found");
		}

		if (secret.appId !== appId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Secret does not belong to this app",
			);
		}

		// Decrypt the value
		const masterKey = getMasterKey(env);
		const value = await decryptAppSecret(
			masterKey,
			appId,
			secret.encryptedValue,
		);

		return {
			id: secret.id,
			name: secret.name,
			value,
			hint: secret.hint,
			keyVersion: secret.keyVersion,
			createdBy: secret.createdBy,
			createdAt: secret.createdAt,
			updatedAt: secret.updatedAt,
		};
	});

/**
 * Contract-based set (create/update) procedure implementation
 */
export const setAppSecretProcedure = authedAppSecretsOs.set
	.use(AUTHZ.secretsWrite)
	.handler(async ({ input, context }) => {
		const { db, env, user } = context as BaseContext & {
			user?: { sub: string };
		};
		const { appId, name, value } = input;

		await requireAppAccess(context as BaseContext, appId);
		requireAdminOrOwner(context as BaseContext);

		// Check if secret already exists
		const existing = await getAppSecret(db, appId, name);
		const masterKey = getMasterKey(env);
		const encryptedValue = await encryptAppSecret(masterKey, appId, value);
		const hint = generateSecretHint(value);

		if (existing) {
			// Update existing secret
			const updated = await updateAppSecret(db, existing.id, {
				encryptedValue,
				hint,
				keyVersion: existing.keyVersion + 1,
			});

			if (!updated) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Failed to update secret",
				);
			}

			return {
				id: updated.id,
				name: updated.name,
				hint: updated.hint,
				keyVersion: updated.keyVersion,
				createdBy: updated.createdBy,
				createdAt: updated.createdAt,
				updatedAt: updated.updatedAt,
			};
		}

		// Create new secret
		const secret = await createAppSecret(db, {
			appId,
			name,
			encryptedValue,
			hint,
			keyVersion: 1,
			createdBy: user?.sub ?? null,
		});

		return {
			id: secret.id,
			name: secret.name,
			hint: secret.hint,
			keyVersion: secret.keyVersion,
			createdBy: secret.createdBy,
			createdAt: secret.createdAt,
			updatedAt: secret.updatedAt,
		};
	});

/**
 * Contract-based delete procedure implementation
 */
export const deleteAppSecretProcedure = authedAppSecretsOs.delete
	.use(AUTHZ.secretsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, secretId } = input;

		await requireAppAccess(context, appId);
		requireAdminOrOwner(context);

		// Verify secret exists and belongs to this app
		const existing = await getAppSecretById(db, secretId);
		if (!existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Secret not found");
		}
		if (existing.appId !== appId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Secret does not belong to this app",
			);
		}

		const deleted = await deleteAppSecretQuery(db, secretId);
		return { success: deleted };
	});

/**
 * Contract-based router using os.router() pattern
 */
export const appSecretsContractRouter = authedAppSecretsOs.router({
	list: listAppSecrets,
	get: getAppSecretProcedure,
	set: setAppSecretProcedure,
	delete: deleteAppSecretProcedure,
});

/**
 * Type export for the app secrets contract router
 */

// =============================================================================
// HELPERS
// =============================================================================

async function requireAppAccess(
	context: BaseContext,
	appId: string,
): Promise<void> {
	const { db, organizationId } = context;

	if (!organizationId) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}

	// Verify app exists and belongs to the user's organization
	const app = await getAppById(db, appId);
	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}

	if (app.organizationId !== organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"App does not belong to your organization",
		);
	}
}

function requireAdminOrOwner(context: BaseContext): void {
	const role = context.userRole;
	if (!role || !["admin", "owner"].includes(role)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only admins and owners can manage secrets",
		);
	}
}

function getMasterKey(env: CloudflareEnv): string {
	const masterKey = (env as { SECRETS_MASTER_KEY?: string }).SECRETS_MASTER_KEY;
	if (!masterKey) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Secrets encryption not configured. SECRETS_MASTER_KEY is missing.",
		);
	}
	return masterKey;
}
