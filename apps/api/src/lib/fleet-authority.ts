import type { DbClient } from "@tedix/db/client";
import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import { coreDb, isD1CoreStore } from "@tedix/db/core-store/scope";

export type FleetAuthorityMode = "disabled" | "co-located";

export interface FleetAuthorityEnv extends CoreStoreEnv {
	TEDIX_FLEET_AUTHORITY_MODE?: string;
}

export class FleetAuthorityUnavailableError extends Error {
	readonly reason: "disabled" | "invalid-mode" | "missing-binding";

	constructor(
		reason: FleetAuthorityUnavailableError["reason"],
		message: string,
	) {
		super(message);
		this.name = "FleetAuthorityUnavailableError";
		this.reason = reason;
	}
}

export function resolveFleetAuthorityMode(
	env: FleetAuthorityEnv,
): FleetAuthorityMode {
	switch (env.TEDIX_FLEET_AUTHORITY_MODE) {
		case "disabled":
		case "co-located":
			return env.TEDIX_FLEET_AUTHORITY_MODE;
		default:
			throw new FleetAuthorityUnavailableError(
				"invalid-mode",
				"TEDIX_FLEET_AUTHORITY_MODE must be explicitly set to disabled or co-located",
			);
	}
}

export function resolveFleetAuthorityBinding(
	env: FleetAuthorityEnv,
): D1Database {
	if (resolveFleetAuthorityMode(env) === "disabled") {
		throw new FleetAuthorityUnavailableError(
			"disabled",
			"Fleet authority is disabled for this installation",
		);
	}
	if (!isD1CoreStore(env) || !env.DB) {
		throw new FleetAuthorityUnavailableError(
			"missing-binding",
			"Co-located fleet authority requires DB",
		);
	}
	return env.DB;
}

export function resolveFleetAuthorityDb(env: FleetAuthorityEnv): DbClient {
	assertFleetAuthorityAvailable(env);
	return coreDb(env);
}

export function assertFleetAuthorityAvailable(env: FleetAuthorityEnv): void {
	if (resolveFleetAuthorityMode(env) === "disabled")
		throw new FleetAuthorityUnavailableError(
			"disabled",
			"Fleet authority is disabled for this installation",
		);
	if (isD1CoreStore(env)) {
		resolveFleetAuthorityBinding(env);
		return;
	}
	if (env.CORE_STORE !== "postgres" || !env.CORE_HYPERDRIVE)
		throw new FleetAuthorityUnavailableError(
			"missing-binding",
			"Co-located fleet authority requires CORE_HYPERDRIVE for Postgres",
		);
}

export function fleetAuthorityIsEnabled(env: FleetAuthorityEnv): boolean {
	if (resolveFleetAuthorityMode(env) === "disabled") return false;
	assertFleetAuthorityAvailable(env);
	return true;
}
