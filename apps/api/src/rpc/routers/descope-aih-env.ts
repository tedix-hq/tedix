import type { AihEnv } from "@tedix/auth/aih-client";
import { createError, ErrorCodes } from "../orpc";

export function requireAihEnv(env: CloudflareEnv): AihEnv {
	if (!env.DESCOPE_PROJECT_ID || !env.DESCOPE_MANAGEMENT_KEY) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Descope AIH management is not configured",
		);
	}

	return {
		DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
	};
}
