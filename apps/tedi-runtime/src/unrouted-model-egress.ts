import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";

export async function requireUnrestrictedModelEgress(
	env: { API_SERVICE?: Fetcher },
	organizationId: string,
	operation: string,
): Promise<void> {
	if (!env.API_SERVICE || !organizationId)
		throw new Error(
			"Data residency requires organization attribution and the policy service before model processing",
		);
	const result = await callRpc<{ allowed: boolean; message?: string }>(
		"runtimeEntitlements/checkModelEgress",
		{ organizationId, operation },
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(env.API_SERVICE),
			headers: { "X-Service-Binding": "true", "X-Tedix-Org-Id": "system" },
		},
	);
	if (!result.allowed)
		throw new Error(
			result.message ??
				"EU model processing is required; this model feature has no verified regional route",
		);
}

export function unrestrictedModelAi<T extends object>(
	env: { API_SERVICE?: Fetcher },
	ai: T,
	organizationId: () => string,
): T {
	return new Proxy(ai, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (property === "run" && typeof value === "function")
				return async (...args: unknown[]) => {
					await requireUnrestrictedModelEgress(
						env,
						organizationId(),
						"Live voice",
					);
					return value.apply(target, args);
				};
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
