import {
	SelectedConnectionCredentialSchema,
	ConnectionAllowedResourcesSchema,
	type SelectedConnectionCredential,
} from "@tedix/api-contract/schemas/connections";
import { resourceCapabilityProfile } from "@tedix/api-contract/utils/provider-capability-profiles";
import {
	fetchTenantConnectionToken,
	isNamedConnectionExternalIdentifier,
} from "@tedix/auth/connections";
import { getConnectionProviderByDescopeAppId } from "@tedix/db/queries/connection-providers";
import { getOrganizationConnectionAllowedResources } from "@tedix/db/queries/connection-instances";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";
import { getDescopeManagement } from "../lib/descope-management";
import type { BaseContext } from "../rpc/orpc";
import { resolveConnectionAccessCheck } from "./connection-access-check";

const domain = "tedix:default-tenant-api-key-revision:v1";
type DefaultToken = {
	id?: string;
	accessToken?: string;
	expiresAt?: number;
	reconnectNeeded?: boolean;
	externalIdentifier?: string;
};

/** Metadata-only reference. The opaque key never leaves the server's HMAC input. */
export async function defaultTenantCredentialReference(input: {
	masterKey?: string;
	organizationId: string;
	tenantId: string;
	providerId: string;
	token: DefaultToken;
}): Promise<SelectedConnectionCredential | null> {
	const { token } = input;
	if (
		!input.masterKey ||
		!input.organizationId ||
		!input.tenantId ||
		!input.providerId ||
		!token.id ||
		!token.accessToken?.trim() ||
		token.reconnectNeeded ||
		isNamedConnectionExternalIdentifier(token.externalIdentifier) ||
		(token.expiresAt !== undefined &&
			(!Number.isFinite(token.expiresAt) ||
				token.expiresAt <= Date.now() / 1000))
	)
		return null;
	const key = await deriveHkdfHmacKey(input.masterKey, domain);
	const bytes = await hmacSha256(
		key,
		JSON.stringify([
			domain,
			input.organizationId,
			input.tenantId,
			input.providerId,
			"tenant-default",
			token.id,
			token.accessToken,
		]),
	);
	return {
		organizationId: input.organizationId,
		providerId: input.providerId,
		scope: "tenant",
		accountRevisionDigest: Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
	};
}

/** Native registered-target use only; this does not grant a general MCP credential. */
export async function readDefaultRepositoryCredential(
	context: BaseContext,
	organizationId: string,
	selection: SelectedConnectionCredential,
	repositories: readonly string[],
): Promise<string> {
	const selected = SelectedConnectionCredentialSchema.options[0]
		.omit({ connectionInstanceId: true })
		.required({ accountRevisionDigest: true })
		.parse(selection);
	if (
		context.organizationId !== organizationId ||
		selected.organizationId !== organizationId
	)
		throw new Error("Default connection organization mismatch");
	const [provider, org] = await Promise.all([
		getConnectionProviderByDescopeAppId(context.db, selected.providerId),
		getOrganizationById(context.db, organizationId),
	]);
	// Only the registered GitHub API-key family may authenticate api.github.com.
	if (
		!provider ||
		provider.type !== "api_key" ||
		!["github", "github-pat-key"].includes(provider.id) ||
		!org?.descopeTenantId
	)
		throw new Error("Registered GitHub API-key provider unavailable");
	if (
		resolveConnectionAccessCheck(org.metadata, "", {
			appId: selected.providerId,
			category: provider.category,
		}).checkEachPersonsAccess
	)
		throw new Error(
			"Default connection requires verified personal resource access",
		);
	const { enforceConnectionConsumerGrants } =
		await import("../rpc/routers/connections/consumer-grant-resolution");
	await enforceConnectionConsumerGrants(context, {
		organizationId,
		providerId: selected.providerId,
	});
	const resources = await getOrganizationConnectionAllowedResources(
		context.db,
		organizationId,
		selected.providerId,
	);
	const normalized = repositories.map((repo) => {
		const parsed = ConnectionAllowedResourcesSchema.safeParse([
			{ resourceType: "github_repository", resourceId: repo },
		]);
		if (!parsed.success)
			throw new Error("Invalid registered repository resource");
		return resourceCapabilityProfile("github_repository")!.normalize(repo);
	});
	if (
		resources !== null &&
		normalized.some(
			(repo) =>
				!resources.some(
					(resource) =>
						resource.resourceType === "github_repository" &&
						resourceCapabilityProfile("github_repository")!.normalize(
							resource.resourceId,
						) === repo,
				),
		)
	)
		throw new Error(
			"Registered repository is outside the connection's allowed resources",
		);
	const token = await fetchTenantConnectionToken(
		getDescopeManagement(context.env, true),
		selected.providerId,
		org.descopeTenantId,
	);
	const current =
		token &&
		(await defaultTenantCredentialReference({
			masterKey: context.env.SECRETS_MASTER_KEY,
			organizationId,
			tenantId: org.descopeTenantId,
			providerId: selected.providerId,
			token,
		}));
	if (
		!current ||
		current.accountRevisionDigest !== selected.accountRevisionDigest
	)
		throw new Error("Default connection revision changed or unavailable");
	return token!.accessToken;
}
