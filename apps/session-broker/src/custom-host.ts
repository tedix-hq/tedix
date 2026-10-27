import {
	callRpc,
	serviceBindingFetch,
	type FetcherLike,
} from "@tedix/api-client/internal";
import type { SessionBrokerIntent } from "@tedix/auth/session-broker";

export async function assertFreshCustomHost(
	api: FetcherLike,
	intent: Pick<SessionBrokerIntent, "customHost" | "targetOrigin">,
): Promise<void> {
	if (!intent.customHost) return;
	const claim = await callRpc<{
		provisioned: boolean;
		organizationId: string | null;
		descopeTenantId: string | null;
		identityProvider?: "oidc";
	}>(
		"osTenant/resolveHostname",
		{ hostname: new URL(intent.targetOrigin).hostname },
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(api),
			headers: { "X-Service-Binding": "true" },
			timeoutMs: 5_000,
			retry: 0,
		},
	);
	if (
		!claim.provisioned ||
		claim.identityProvider === "oidc" ||
		claim.organizationId !== intent.customHost.organizationId ||
		claim.descopeTenantId !== intent.customHost.tenantId
	)
		throw new Error("Custom OS host claim no longer matches");
}
