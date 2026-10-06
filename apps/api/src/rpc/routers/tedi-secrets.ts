/**
 * oRPC Tedi Secrets Router
 * Encrypted secrets management for per-tedi API keys and credentials
 *
 * Uses the same HKDF + AES-256-GCM encryption as org/app secrets,
 * but with tedi-scoped key derivation.
 */

import { implement } from "@orpc/server";
import { tediSecretsContract } from "@tedix/api-contract/contracts/tedi-secrets";
import { isPlatformAdmin } from "@tedix/auth/types";
import {
	deleteTediSecret as deleteTediSecretQuery,
	getTediSecret,
	getTediSecretById,
	listTediSecrets as listTediSecretsQuery,
	upsertTediSecret,
} from "@tedix/db/queries/tedi-secrets";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	decryptTediSecret,
	encryptTediSecret,
	generateSecretHint,
} from "@tedix/db/utils/secrets-encryption";
import { buildRuntimeUrl } from "@tedix/db/utils/tedi-routing";
import { buildProvisioningConfig, invalidateConfig } from "@tedix/provisioning";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const tediSecretsOs = implement(tediSecretsContract).$context<BaseContext>();
const authedOs = tediSecretsOs.use(withAuth);

// =============================================================================
// HELPERS
// =============================================================================

const CHANNEL_RUNTIME_SECRETS = new Set(["TELEGRAM_BOT_TOKEN"]);

const MODEL_RUNTIME_SECRETS = new Set([
	"OPENAI_API_KEY",
	"AZURE_OPENAI_RESOURCE",
	"AZURE_OPENAI_BASE_URL",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"CLOUDFLARE_AI_GATEWAY_API_KEY",
	"CF_AI_GATEWAY_ACCOUNT_ID",
	"CF_AI_GATEWAY_GATEWAY_ID",
	"CF_AI_GATEWAY_MODEL",
]);

function shouldRefreshRuntimeForSecret(name: string): boolean {
	return CHANNEL_RUNTIME_SECRETS.has(name) || MODEL_RUNTIME_SECRETS.has(name);
}

async function requireTediAccess(context: BaseContext, tediId: string) {
	const orgId = requireOrgId(context);
	const tedi = await getTediById(context.db, tediId);
	if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	if (tedi.organizationId !== orgId) {
		if (isPlatformAdmin(context.user)) {
			console.log(
				`[Auth] Platform admin cross-org access: tedi-secrets for tedi=${tediId}`,
			);
		} else {
			throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
		}
	}
	return tedi;
}

/**
 * Fire-and-forget runtime refresh for a tedi Worker.
 * Invalidates resolve cache after secret changes. Agent-runtime credential
 * refresh is handled by runtime config reload paths; there is no gateway process
 * to restart.
 */
function refreshTediRuntime(
	tedi: {
		slug: string | null;
	},
	env: CloudflareEnv,
	waitUntil?: (promise: Promise<unknown>) => void,
	options?: { refreshRuntime?: boolean },
): void {
	if (options?.refreshRuntime === false) return;
	const envName = String(env.ENVIRONMENT || "");
	const platformDomain = envName === "production" ? "tedix.dev" : "tedix.tech";
	const workerUrl = buildRuntimeUrl({ slug: tedi.slug }, platformDomain);
	if (!workerUrl) return;
	const config = buildProvisioningConfig(
		workerUrl,
		{
			ENVIRONMENT: env.ENVIRONMENT,
			TEDI_DEV_BASE_URL: env.TEDI_DEV_BASE_URL,
		},
		env.TEDI_SERVICE,
	);
	const job = (async () => {
		await invalidateConfig(config).catch(() => false);
	})();
	if (waitUntil) waitUntil(job);
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

// =============================================================================
// PROCEDURES
// =============================================================================

export const listTediSecrets = authedOs.list
	.use(AUTHZ.secretsRead)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);

		const secrets = await listTediSecretsQuery(context.db, input.tediId);
		return {
			data: secrets,
			pagination: {
				limit: secrets.length,
				offset: 0,
				total: secrets.length,
				hasMore: false,
			},
		};
	});

export const setTediSecret = authedOs.set
	.use(AUTHZ.secretsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const masterKey = getMasterKey(context.env);

		const encryptedValue = await encryptTediSecret(
			masterKey,
			input.tediId,
			input.value,
		);
		const hint = generateSecretHint(input.value);
		const userId =
			(context as BaseContext & { user?: { sub: string } }).user?.sub ?? null;

		const secret = await upsertTediSecret(
			context.db,
			input.tediId,
			input.name,
			encryptedValue,
			hint,
			userId,
		);

		// Refresh runtime config after provider changes.
		refreshTediRuntime(tedi, context.env, context.waitUntil, {
			refreshRuntime: shouldRefreshRuntimeForSecret(input.name),
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

export const copyTediSecret = authedOs.copy
	.use(AUTHZ.secretsWrite)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.sourceTediId);
		const targetTedi = await requireTediAccess(context, input.tediId);
		const source = await getTediSecret(
			context.db,
			input.sourceTediId,
			input.name,
		);
		if (!source)
			throw createError(ErrorCodes.NOT_FOUND, "Source secret not found");

		const masterKey = getMasterKey(context.env);
		const plaintext = await decryptTediSecret(
			masterKey,
			input.sourceTediId,
			source.encryptedValue,
		);
		const encryptedValue = await encryptTediSecret(
			masterKey,
			input.tediId,
			plaintext,
		);
		const userId =
			(context as BaseContext & { user?: { sub: string } }).user?.sub ?? null;
		const secret = await upsertTediSecret(
			context.db,
			input.tediId,
			input.name,
			encryptedValue,
			generateSecretHint(plaintext),
			userId,
		);

		refreshTediRuntime(targetTedi, context.env, context.waitUntil, {
			refreshRuntime: shouldRefreshRuntimeForSecret(input.name),
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

export const deleteTediSecretProcedure = authedOs.delete
	.use(AUTHZ.secretsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		// Verify secret belongs to this tedi
		const existing = await getTediSecretById(context.db, input.secretId);
		if (!existing) throw createError(ErrorCodes.NOT_FOUND, "Secret not found");
		if (existing.tediId !== input.tediId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Secret does not belong to this tedi",
			);

		const deleted = await deleteTediSecretQuery(context.db, input.secretId);

		// Refresh runtime config after provider credential removal.
		refreshTediRuntime(tedi, context.env, context.waitUntil, {
			refreshRuntime: shouldRefreshRuntimeForSecret(existing.name),
		});

		return { success: deleted };
	});

export const tediSecretsContractRouter = authedOs.router({
	list: listTediSecrets,
	set: setTediSecret,
	copy: copyTediSecret,
	delete: deleteTediSecretProcedure,
});
