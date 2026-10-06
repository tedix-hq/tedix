/**
 * Tedis Router — Shared helpers
 */

import { implement } from "@orpc/server";
import { tedisContract } from "@tedix/api-contract/contracts/tedis";
import type { TediType } from "@tedix/api-contract/schemas/tedi";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { isLocalDemoProject } from "@tedix/auth/local-demo";
import { getTediById } from "@tedix/db/queries/tedis";
import type { Tedi } from "@tedix/db/schema/tedis";
import { buildRuntimeUrl } from "@tedix/db/utils/tedi-routing";
import {
	buildProvisioningConfig,
	type ProvisioningConfig,
	ProvisioningHttpError,
} from "@tedix/provisioning";
import { slugify } from "../../../utils/app";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
	withServiceAuth,
} from "../../orpc";

// Re-export commonly used items
export {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	type ProvisioningConfig,
	ProvisioningHttpError,
	withAuth,
	withAuthorization,
	withServiceAuth,
};

/**
 * Create the contract implementer with base context
 */
export const tedisOs = implement(tedisContract).$context<BaseContext>();

/**
 * Create authenticated implementer - most procedures require auth
 */
export const authedTedisOs = tedisOs.use(withAuth);

// =============================================================================
// HELPERS
// =============================================================================

/** Keys in channel config objects that contain secrets */
const CHANNEL_SECRET_KEYS = new Set([
	"token",
	"botToken",
	"bot_token",
	"apiKey",
	"api_key",
	"secret",
	"webhookSecret",
	"appToken",
	"app_token",
]);

/** Redact secret values from parsed channels JSON, preserving structure */
export function redactChannelSecrets(channels: unknown): unknown {
	if (!channels || typeof channels !== "object") return channels;
	if (Array.isArray(channels)) return channels.map(redactChannelSecrets);
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(
		channels as Record<string, unknown>,
	)) {
		if (
			CHANNEL_SECRET_KEYS.has(key) &&
			typeof value === "string" &&
			value.length > 0
		) {
			result[key] = `${value.slice(0, 4)}…${value.slice(-4)}`;
		} else if (typeof value === "object" && value !== null) {
			result[key] = redactChannelSecrets(value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

export function toTediDto(
	tedi: Tedi,
	options?: {
		env?: Pick<CloudflareEnv, "ENVIRONMENT" | "DESCOPE_PROJECT_ID">;
		liveRuntime?: Partial<Pick<TediType, "runtimeStatus" | "lastSeenAt">>;
		overrides?: Partial<TediType>;
	},
): TediType {
	// Normalize the cached D1 runtimeStatus before output. The runtime
	// projection cron has historically written values not in the contract
	// enum (e.g. "stopped" before the rename). Emitting them un-normalized
	// would fail oRPC output validation. The live override (when present)
	// is also re-normalized in case its source changed semantics.
	const liveOverride = options?.liveRuntime ?? {};
	const rawStatus =
		liveOverride.runtimeStatus !== undefined
			? liveOverride.runtimeStatus
			: tedi.runtimeStatus;
	const runtimeStatus =
		liveOverride.runtimeStatus === undefined
			? projectIsolateRuntimeStatus(tedi)
			: rawStatus == null
				? null
				: normalizeLiveRuntimeStatus(rawStatus);
	const dto = {
		...tedi,
		...liveOverride,
		toolPolicy: tedi.toolPolicy,
		selfImprovementPolicy: tedi.selfImprovementPolicy,
		budgets: tedi.budgets,
		quietHours: tedi.quietHours,
		channels: redactChannelSecrets(tedi.channels),
		cronJobs: tedi.cronJobs,
		installedSkills: tedi.installedSkills,
		installedPlugins: tedi.installedPlugins,
		tags: tedi.tags,
		lastBackupHandles: tedi.lastBackupHandles,
		runtimeOverrides: tedi.runtimeOverrides,
		repoConfig: tedi.repoConfig,
		runtimeStatus,
	} as TediType;

	return {
		...dto,
		...options?.overrides,
		...(options?.env && isLocalTediRuntimeUnavailable(options.env)
			? { runtimeStatus: "unknown" as const, lastSeenAt: null }
			: {}),
	};
}

export function isLocalTediRuntimeUnavailable(
	env: Pick<CloudflareEnv, "ENVIRONMENT" | "DESCOPE_PROJECT_ID">,
): boolean {
	return (
		env.ENVIRONMENT === "development" &&
		isLocalDemoProject(env.DESCOPE_PROJECT_ID)
	);
}

export function requireOrganizationId(context: BaseContext): string {
	const orgId = context.organizationId;
	if (!orgId) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}
	return orgId;
}

export function getPlatformDomain(env: CloudflareEnv): string {
	const envName = String(env.ENVIRONMENT || "");
	return envName === "production" ? "tedix.dev" : "tedix.tech";
}

/**
 * Build provisioning config for a tedi.
 * Canonical runtime URL is derived from the globally-unique slug.
 */
export function getProvisioningConfig(
	tedi: {
		slug: string | null;
	},
	env: CloudflareEnv,
): ProvisioningConfig | null {
	const derivedWorkerUrl = buildRuntimeUrl(
		{ slug: tedi.slug },
		getPlatformDomain(env),
	);
	if (!derivedWorkerUrl) return null;
	return buildProvisioningConfig(
		derivedWorkerUrl,
		{
			ENVIRONMENT: env.ENVIRONMENT,
			TEDI_DEV_BASE_URL: env.TEDI_DEV_BASE_URL,
		},
		env.TEDI_SERVICE,
	);
}

export function normalizeLiveRuntimeStatus(
	status: string | null | undefined,
): "running" | "sleeping" | "starting" | "error" | "unknown" {
	switch (status) {
		case "running":
		case "degraded":
			return "running";
		case "not_running":
		case "sleeping":
		case "stopped":
			return "sleeping";
		case "starting":
		case "runtime_bypass":
			return "starting";
		case "not_responding":
		case "error":
			return "error";
		default:
			return "unknown";
	}
}

export function projectIsolateRuntimeStatus(
	tedi: Pick<Tedi, "runtimeState" | "status">,
): "running" | "sleeping" | "starting" | "error" {
	if (tedi.status === "error") return "error";
	if (tedi.status === "provisioning") return "starting";
	if (tedi.status === "paused" || tedi.runtimeState === "archived") {
		return "sleeping";
	}
	return "running";
}

export async function fetchLiveTediRuntime(
	tedi: {
		slug: string | null;
		runtimeStatus: string | null;
		lastSeenAt: string | null;
		lastSyncAt: string | null;
		runtimeKind?: string | null;
		runtimeState?: string | null;
		status?: string | null;
	},
	env: CloudflareEnv,
): Promise<{
	rawRuntimeStatus: string;
	normalizedRuntimeStatus:
		| "running"
		| "sleeping"
		| "starting"
		| "error"
		| "unknown";
	lastSeenAt: string;
	lastSyncAt: string | null;
	runtimeVersion: string | null;
	processCount: number;
} | null> {
	if (isLocalTediRuntimeUnavailable(env)) return null;
	const status = projectIsolateRuntimeStatus({
		runtimeState: tedi.runtimeState ?? null,
		status: tedi.status ?? null,
	} as Pick<Tedi, "runtimeState" | "status">);
	return {
		rawRuntimeStatus: status,
		normalizedRuntimeStatus: status,
		lastSeenAt: new Date().toISOString(),
		lastSyncAt: tedi.lastSyncAt,
		runtimeVersion: null,
		processCount: 0,
	};
}

/**
 * Sanitize provisioning error messages to avoid leaking internal URLs/hosts.
 */
export function sanitizeProvisioningError(error: unknown): string {
	const raw =
		error instanceof ProvisioningHttpError
			? error.message
			: error instanceof Error
				? error.message
				: "Service unavailable";
	return raw
		.replace(/https?:\/\/[^\s\]]+/g, "[internal]")
		.replace(/X-Tedix-Host:\s*\S+/g, "X-Tedix-Host: [redacted]")
		.slice(0, 200);
}

export function generateSlug(name: string): string {
	return slugify(name);
}

/**
 * Verify tenant ownership or canonical platform-principal authority.
 * Mutation-specific policy gates remain the responsibility of each handler.
 */
export async function requireTediAccess(context: BaseContext, tediId: string) {
	const orgId = requireOrganizationId(context);
	const tedi = await getTediById(context.db, tediId);

	if (!tedi) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}

	if (tedi.organizationId !== orgId) {
		// Allow service-binding calls with org="system" (used by MCP edge auth to resolve tedi identity)
		if (context.authType === "service-binding" && orgId === "system") {
			// Trusted internal call — bypass org check
		} else if (isPlatformPrincipal(context)) {
			console.log(
				`[Auth] Platform principal cross-org access: authType=${context.authType} accessing tedi=${tediId} (org=${tedi.organizationId}, caller-org=${orgId})`,
			);
		} else {
			throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
		}
	}

	return tedi;
}
