import type { DbQueryClient } from "@tedix/db/query-client";
import { getOrganizationResidencyPolicy } from "@tedix/db/queries/data-residency";
import { DataResidencyError } from "./data-residency";

const checks = new WeakMap<object, () => Promise<void>>();

export async function requireUnrestrictedModelEgress(
	db: DbQueryClient,
	organizationId: string,
	operation: string,
): Promise<void> {
	if (!organizationId.trim())
		throw new DataResidencyError(
			"RESIDENCY_POLICY_UNAVAILABLE",
			"Organization attribution is required before model processing. No model request was sent.",
		);
	let policy;
	try {
		policy = await getOrganizationResidencyPolicy(db, organizationId);
	} catch {
		throw new DataResidencyError(
			"RESIDENCY_POLICY_UNAVAILABLE",
			"Data residency could not be checked. No model request was sent.",
		);
	}
	if (policy && policy.mode !== "unrestricted")
		throw new DataResidencyError(
			"EU_PROVIDER_ROUTE_REQUIRED",
			`This organization requires EU model processing. ${operation} has no verified regional adapter yet and is blocked. An administrator must configure a supported EU provider route before using this feature.`,
		);
}

/** Bind legacy model helpers to their actual organization without changing shared Worker env. */
export function organizationModelEnv<T extends { AI?: unknown }>(
	env: T,
	db: DbQueryClient,
	organizationId: string,
): T {
	const check = () =>
		requireUnrestrictedModelEgress(
			db,
			organizationId,
			"This auxiliary model feature",
		);
	const scoped = { ...env };
	checks.set(scoped, check);
	if (env.AI && typeof env.AI === "object") {
		scoped.AI = new Proxy(env.AI, {
			get(target, property) {
				const value = Reflect.get(target, property, target);
				if (property === "run" && typeof value === "function")
					return async (...args: unknown[]) => {
						await check();
						return value.apply(target, args);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
	return scoped;
}

export async function assertModelEgressAllowed(env: object): Promise<void> {
	await checks.get(env)?.();
}
