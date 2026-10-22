import type { ProviderExecutionIdentity } from "@tedix/api-contract/schemas/provider-execution";
import type { ResidencyProvider } from "@tedix/api-contract/schemas/data-residency";
import type { DbClient } from "@tedix/db/client";
import {
	getOrganizationResidencyPolicy,
	listResidencyProviders,
} from "@tedix/db/queries/data-residency";
import { getOrgSecret } from "@tedix/db/queries/organization-secrets";
import { decryptSecret } from "@tedix/db/utils/secrets-encryption";

export class DataResidencyError extends Error {
	readonly providerRequestSent = false;
	constructor(
		readonly code:
			| "EU_PROVIDER_POOL_REQUIRED"
			| "EU_PROVIDER_ROUTE_REQUIRED"
			| "EU_PROVIDER_CREDENTIAL_REQUIRED"
			| "RESIDENCY_POLICY_UNAVAILABLE",
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "DataResidencyError";
	}
}

export function eligibleResidencyProvider(
	members: ResidencyProvider[],
	execution: ProviderExecutionIdentity,
	now: number,
	modality: "text" | "image" | "unknown" = "text",
) {
	const eligible = members.filter(
		(m) =>
			m.enabled && m.jurisdiction === "eu" && Date.parse(m.expiresAt) > now,
	);
	if (!eligible.length)
		throw new DataResidencyError(
			"EU_PROVIDER_POOL_REQUIRED",
			"This organization requires EU model processing. An administrator must add an enabled EU-hosted provider/model to the provider catalog, with its exact regional endpoint, deployment, current processing evidence and credential reference.",
		);
	const sameModelRoute = (member: ResidencyProvider) => {
		const target = member.execution;
		return (
			modality !== "unknown" &&
			member.modalities.includes(modality) &&
			target.provider === execution.provider &&
			target.requestModel === execution.requestModel &&
			target.apiKind === execution.apiKind &&
			target.transportKind === execution.transportKind &&
			target.gatewayAccountId === execution.gatewayAccountId &&
			target.gatewayId === execution.gatewayId &&
			!target.autoRouting
		);
	};
	const member =
		eligible.find(
			(m) =>
				sameModelRoute(m) &&
				m.execution.providerOrigin === execution.providerOrigin,
		) ?? eligible.find(sameModelRoute);
	if (!member || execution.autoRouting || execution.provider !== "azure-openai")
		throw new DataResidencyError(
			"EU_PROVIDER_ROUTE_REQUIRED",
			"This model route is not verified for EU processing. An administrator must configure a regional EU Azure OpenAI endpoint and deployment matching an enabled EU provider catalog entry. Global, unknown and adaptive fallback routes are blocked.",
		);
	return member;
}

const RESIDENCY_POLICY_READ_BACKOFF_MS = [100, 400, 1000, 2000];
const RESIDENCY_POLICY_JITTER_MS = 200;
const RESIDENCY_POLICY_CACHE_TTL_MS = 15 * 60 * 1000;

type ResidencyPolicyRow = Awaited<
	ReturnType<typeof getOrganizationResidencyPolicy>
>;

/**
 * Last policy this isolate read per organization. A D1 burst that outlasts
 * the retry window must not fail a turn for an organization whose setting is
 * already known; the verdict falls back to the last read, which keeps the
 * EU posture for an eu-mode organization and admits an unrestricted one.
 */
const lastKnownResidencyPolicy = new Map<
	string,
	{ policy: ResidencyPolicyRow; readAt: number }
>();

/** Test seam: forget every cached policy. */
export function resetResidencyPolicyCache() {
	lastKnownResidencyPolicy.clear();
}

/**
 * One busy D1 read must not fail a whole delegated turn before inference.
 * Jittered, bounded retries survive a burst; the fail-closed verdict stays
 * for an organization whose policy was never read in this isolate.
 */
async function readResidencyPolicyWithRetry(
	db: DbClient,
	organizationId: string,
	now: number,
): Promise<ResidencyPolicyRow> {
	for (let attempt = 0; ; attempt++) {
		try {
			const policy = await getOrganizationResidencyPolicy(db, organizationId);
			lastKnownResidencyPolicy.set(organizationId, { policy, readAt: now });
			return policy;
		} catch (error) {
			const delay = RESIDENCY_POLICY_READ_BACKOFF_MS[attempt];
			if (delay === undefined) {
				const known = lastKnownResidencyPolicy.get(organizationId);
				if (known && now - known.readAt <= RESIDENCY_POLICY_CACHE_TTL_MS)
					return known.policy;
				throw error;
			}
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					delay + Math.floor(Math.random() * RESIDENCY_POLICY_JITTER_MS),
				),
			);
		}
	}
}

export async function authorizeDataResidency(input: {
	db: DbClient;
	organizationId: string;
	execution: ProviderExecutionIdentity;
	masterKey?: string;
	now: number;
	modality?: "text" | "image" | "unknown";
}) {
	let policy;
	try {
		policy = await readResidencyPolicyWithRetry(
			input.db,
			input.organizationId,
			input.now,
		);
	} catch {
		throw new DataResidencyError(
			"RESIDENCY_POLICY_UNAVAILABLE",
			"The organization's data residency setting could not be verified. No model request was sent. Retry when the setting is available.",
		);
	}
	if (!policy || policy.mode === "unrestricted") return null;
	if (policy.mode !== "eu")
		throw new DataResidencyError(
			"RESIDENCY_POLICY_UNAVAILABLE",
			"The organization's data residency setting is invalid. Ask an administrator to repair it.",
		);
	let members;
	try {
		members = await listResidencyProviders(input.db);
	} catch {
		throw new DataResidencyError(
			"RESIDENCY_POLICY_UNAVAILABLE",
			"The EU provider catalog could not be verified. An administrator must repair the provider evidence/configuration. No model request was sent.",
		);
	}
	const member = eligibleResidencyProvider(
		members,
		input.execution,
		input.now,
		input.modality,
	);
	let apiKey: string | undefined;
	try {
		const secret = await getOrgSecret(
			input.db,
			input.organizationId,
			member.credentialRef,
		);
		if (secret && input.masterKey)
			apiKey = await decryptSecret(
				input.masterKey,
				input.organizationId,
				secret.encryptedValue,
			);
	} catch {
		// No secret value or decryption error enters the user-facing failure.
	}
	if (!apiKey?.trim() || /[\r\n]/.test(apiKey))
		throw new DataResidencyError(
			"EU_PROVIDER_CREDENTIAL_REQUIRED",
			`An administrator must add ${member.credentialRef} to this organization's encrypted secrets: the API key for the verified regional EU provider at ${member.execution.providerOrigin}. No model request was sent.`,
		);
	return { policy, member, apiKey };
}
