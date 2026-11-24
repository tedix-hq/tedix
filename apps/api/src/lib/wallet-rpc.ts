import type { WalletRpc } from "@tedix/api-contract/schemas/billing-wallet";
import { walletObjectName } from "@tedix/api-contract/utils/wallet-object";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";

/**
 * The organization wallet. With the `WALLET` binding (production) a call goes
 * straight to the wallet Durable Object; going through the MCP Worker's
 * service binding added 500-650 ms to about a quarter of model-call holds.
 * Without it, the MCP Worker's `wallet` RPC serves the same routes.
 */
export function walletRpc(env: {
	WALLET?: DurableObjectNamespace;
	MCP_SERVICE?: unknown;
}): WalletRpc {
	const namespace = env.WALLET;
	if (namespace)
		return {
			async wallet(organizationId, route, body) {
				// The same request the MCP Worker's InternalEntrypoint.wallet sends.
				const response = await durableObjectStubByName(
					namespace,
					env,
					walletObjectName(organizationId),
				).fetch(`https://wallet.internal/wallet/${route}`, {
					method: "POST",
					body: JSON.stringify(body),
				});
				if (!response.ok) throw new Error(`Wallet status ${response.status}`);
				return response.json();
			},
		};
	if (!env.MCP_SERVICE)
		throw new Error("Managed billing needs the WALLET or MCP_SERVICE binding");
	return env.MCP_SERVICE as WalletRpc;
}

/** The wallet when either binding exists; callers that can run without it get undefined. */
export function boundWalletRpc(env: {
	WALLET?: DurableObjectNamespace;
	MCP_SERVICE?: unknown;
}): WalletRpc | undefined {
	return env.WALLET || env.MCP_SERVICE ? walletRpc(env) : undefined;
}
