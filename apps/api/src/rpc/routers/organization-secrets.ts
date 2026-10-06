/**
 * oRPC Organization Secrets Router
 * Encrypted secrets management for customer API keys and credentials
 *
 * Security model:
 * - Master key: 32-byte key stored in Cloudflare Secrets Store (SECRETS_MASTER_KEY)
 * - Per-org keys: Derived using HKDF(master, orgId, "org-secrets")
 * - Encryption: AES-256-GCM with random 12-byte IV per operation
 * - Storage: Base64 encoded IV + ciphertext + authTag in D1
 *
 * This router uses contract-first development with oRPC.
 * Contract is imported from @tedix/api-contract.
 */

import { implement } from "@orpc/server";
import {
	organizationSecretsContract,
	SecretIdParamSchema,
} from "@tedix/api-contract/contracts/secrets";
import {
	createOrgSecret,
	deleteOrgSecret as deleteOrgSecretQuery,
	getOrgSecret,
	getOrgSecretById,
	listOrgSecrets as listOrgSecretsQuery,
	updateOrgSecret,
} from "@tedix/db/queries/organization-secrets";
import {
	decryptSecret,
	encryptSecret,
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
const organizationSecretsOs = implement(
	organizationSecretsContract,
).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all organization secrets endpoints require authentication
 */
const authedOrganizationSecretsOs = organizationSecretsOs.use(withAuth);

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Contract-based list procedure implementation
 */
export const listOrgSecrets = authedOrganizationSecretsOs.list
	.use(AUTHZ.secretsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId } = input;

		requireOrganizationAccess(context, organizationId);

		const secrets = await listOrgSecretsQuery(db, organizationId);
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
export const getOrgSecretProcedure = authedOrganizationSecretsOs.get
	.use(AUTHZ.secretsRead)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const { organizationId, secretId } = input;

		requireOrganizationAccess(context, organizationId);

		const secret = await getOrgSecretById(db, secretId);

		if (!secret) {
			throw createError(ErrorCodes.NOT_FOUND, "Secret not found");
		}

		if (secret.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Secret does not belong to this organization",
			);
		}

		// Decrypt the value
		const masterKey = getMasterKey(env);
		const value = await decryptSecret(
			masterKey,
			organizationId,
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
export const setOrgSecretProcedure = authedOrganizationSecretsOs.set
	.use(AUTHZ.secretsWrite)
	.handler(async ({ input, context }) => {
		const { db, env, user } = context as BaseContext & {
			user?: { sub: string };
		};
		const { organizationId, name, value } = input;

		requireOrganizationAccess(context as BaseContext, organizationId);
		requireAdminOrOwner(context as BaseContext);

		// Check if secret already exists
		const existing = await getOrgSecret(db, organizationId, name);
		const masterKey = getMasterKey(env);
		const encryptedValue = await encryptSecret(
			masterKey,
			organizationId,
			value,
		);
		const hint = generateSecretHint(value);

		if (existing) {
			// Update existing secret
			const updated = await updateOrgSecret(db, existing.id, {
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
		const secret = await createOrgSecret(db, {
			organizationId,
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
export const deleteOrgSecretProcedure = authedOrganizationSecretsOs.delete
	.use(AUTHZ.secretsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, secretId } = input;

		requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);

		// Verify secret exists and belongs to this organization
		const existing = await getOrgSecretById(db, secretId);
		if (!existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Secret not found");
		}
		if (existing.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Secret does not belong to this organization",
			);
		}

		const deleted = await deleteOrgSecretQuery(db, secretId);
		return { success: deleted };
	});

/**
 * Contract-based router using os.router() pattern
 */
export const organizationSecretsContractRouter =
	authedOrganizationSecretsOs.router({
		list: listOrgSecrets,
		get: getOrgSecretProcedure,
		set: setOrgSecretProcedure,
		delete: deleteOrgSecretProcedure,
	});

/**
 * Type export for the organization secrets contract router
 */
export type OrganizationSecretsContractRouter =
	typeof organizationSecretsContractRouter;

// =============================================================================
// HELPERS
// =============================================================================

function requireOrganizationAccess(
	context: BaseContext,
	organizationId: string,
): void {
	const contextOrgId = context.organizationId;
	if (!contextOrgId || contextOrgId !== organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Organization access denied for this resource",
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
