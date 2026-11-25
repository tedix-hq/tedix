import type { z } from "zod";
import type { RevokeMcpInstallationInputSchema } from "@tedix/api-contract/schemas/mcp-grant";
import { verifyMcpRevocationProof } from "@tedix/auth/mcp-installation-revocation";
import type { DbClient } from "@tedix/db/client";
import {
	getMcpConsentResource,
	revokeMcpConsentGrant,
} from "@tedix/db/queries/mcp-consent";
import { forgetHumanMcpProviderFacts } from "./mcp-grant";

export async function revokeMcpInstallation(
	db: DbClient,
	env: CloudflareEnv,
	input: z.infer<typeof RevokeMcpInstallationInputSchema>,
	fetcher: typeof fetch = fetch,
) {
	const resource = await getMcpConsentResource(db, {
		resourceUrl: input.resourceUrl,
	});
	const mcpServerId = resource?.metadata?.mcpConfig?.descopeResourceId;
	if (typeof mcpServerId !== "string" || !mcpServerId)
		throw new Error("Unknown MCP resource");
	const proof = await verifyMcpRevocationProof(
		env,
		{ ...input, mcpServerId },
		fetcher,
	);
	const key = {
		descopeUserId: proof.descopeUserId,
		clientId: proof.clientId,
		mcpServerId,
	};
	await revokeMcpConsentGrant(db, { ...key, revision: proof.revision });
	forgetHumanMcpProviderFacts(key);
	// Consent can be shared by other installations. End only this token family.
	const body = new URLSearchParams({
		token: input.refreshToken,
		token_type_hint: "refresh_token",
		client_id: proof.clientId,
	});
	if (input.clientSecret) body.set("client_secret", input.clientSecret);
	const response = await fetcher(proof.revocationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	if (response.status !== 200)
		throw new Error("Refresh token revocation unavailable");
	return { revoked: true as const, consentRevision: proof.revision };
}
