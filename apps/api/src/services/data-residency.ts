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

const RESIDENCY_POLICY_READ_BACKOFF_MS = [100, 400];

/**
 * One busy D1 read must not fail a whole delegated turn before inference.
 * Bounded retries keep the fail-closed verdict for a persistent outage.
 */
async function readResidencyPolicyWithRetry(
	db: DbClient,
	organizationId: string,
) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await getOrganizationResidencyPolicy(db, organizationId);
		} catch (error) {
			const delay = RESIDENCY_POLICY_READ_BACKOFF_MS[attempt];
			if (delay === undefined) throw error;
			await new Promise((resolve) => setTimeout(resolve, delay));
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
		policy = await readResidencyPolicyWithRetry(input.db, input.organizationId);
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
