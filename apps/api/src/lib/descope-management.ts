import { getManagementClient } from "@tedix/auth/client";
import type { DescopeEnv } from "@tedix/auth/types";
import { createError, ErrorCodes } from "../rpc/orpc";

export function getDescopeManagement(
	env: DescopeEnv,
	required: true,
): ReturnType<typeof getManagementClient>;
export function getDescopeManagement(
	env: DescopeEnv,
	required?: false,
): ReturnType<typeof getManagementClient> | null;
export function getDescopeManagement(env: DescopeEnv, required = false) {
	if (!env.DESCOPE_MANAGEMENT_KEY) {
		if (required)
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Descope management key not configured",
			);
		return null;
	}
	return getManagementClient(env);
}
