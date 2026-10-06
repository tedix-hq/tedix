import type {
	TediAppAssignment,
	TediAppAssignmentRole,
	TediMcpAccessBatchItem,
} from "@tedix/api-contract/schemas/tedi-app-assignments";
import { getManagementClient } from "@tedix/auth/client";
import { getAssignedAppRoles } from "@tedix/auth/fga";
import type { DbClient } from "@tedix/db/client";
import type { App } from "@tedix/db/schema/apps";
import type { Tedi } from "@tedix/db/schema/tedis";
import { clearAihTokenCacheForTediServer } from "../lib/aih-token-cache";
import { unifiedGatewayWorkBaselineIssues } from "../lib/unified-gateway-work-baseline";
import {
	attestTediDescopeSubject,
	deleteTediAihClientForApp,
	ensureTediAihClientForApp,
	validateTediAihClientForApp,
} from "../lib/tedi-aih-client-sync";

type AihManagementEnv = {
	DESCOPE_PROJECT_ID: string;
	DESCOPE_MANAGEMENT_KEY: string;
};

type AihSyncEnv = AihManagementEnv & {
	SECRETS_MASTER_KEY: string;
};

export type TediMcpAccessBatchRunInput = {
	tediId?: string;
	appId?: string;
	appSlug?: string;
	includeValid?: boolean;
	includeSkipped?: boolean;
	includeNonAih?: boolean;
	dryRun?: boolean;
};

export type TediMcpAccessBatchRunResult = {
	repairInvalid: boolean;
	dryRun: boolean;
	filters: {
		tediId?: string;
		appId?: string;
		appSlug?: string;
	};
	totalAssignments: number;
	valid: number;
	invalid: number;
	skipped: number;
	repaired: number;
	failed: number;
	items: TediMcpAccessBatchItem[];
};

export type TediMcpAccessHealthResult = TediMcpAccessBatchRunResult & {
	healthy: boolean;
	checkedAt: string;
};

function requireAihManagementEnv(env: CloudflareEnv): AihManagementEnv {
	if (!env.DESCOPE_PROJECT_ID || !env.DESCOPE_MANAGEMENT_KEY) {
		throw new Error("Descope AIH management credentials are not configured");
	}
	return {
		DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
	};
}

function requireAihSyncEnv(env: CloudflareEnv): AihSyncEnv {
	const aihEnv = requireAihManagementEnv(env);
	if (!env.SECRETS_MASTER_KEY) {
		throw new Error("SECRETS_MASTER_KEY not configured");
	}
	return {
		...aihEnv,
		SECRETS_MASTER_KEY: env.SECRETS_MASTER_KEY,
	};
}

function assignmentFromRows(params: {
	orgId: string;
	tedi: Tedi;
	app: App;
	role: TediAppAssignmentRole;
	now: string;
}): TediAppAssignment {
	return {
		id: `fga:${params.tedi.id}:${params.app.id}`,
		organizationId: params.orgId,
		appId: params.app.id,
		tediId: params.tedi.id,
		role: params.role,
		assignedBy: null,
		createdAt: String(params.tedi.createdAt ?? params.now),
		updatedAt: String(params.tedi.updatedAt ?? params.now),
	};
}

function appHasAihMcpResource(app: App): boolean {
	const metadata = app.metadata;
	if (!metadata || typeof metadata !== "object") return false;
	const mcpConfig = (metadata as { mcpConfig?: unknown }).mcpConfig;
	if (!mcpConfig || typeof mcpConfig !== "object") return false;
	const descopeResourceId = (mcpConfig as { descopeResourceId?: unknown })
		.descopeResourceId;
	return (
		typeof descopeResourceId === "string" && descopeResourceId.trim().length > 0
	);
}

function shouldScanNonAihAssignment(
	input: TediMcpAccessBatchRunInput,
): boolean {
	return Boolean(input.includeNonAih || input.appId || input.appSlug);
}

export async function syncTediAihClientForAssignment(params: {
	db: DbClient;
	env: CloudflareEnv;
	tedi: Tedi;
	app: App;
	role: TediAppAssignmentRole;
	createdBy?: string | null;
}) {
	const aihEnv = requireAihSyncEnv(params.env);
	const result = await ensureTediAihClientForApp({
		env: aihEnv,
		db: params.db,
		masterKey: aihEnv.SECRETS_MASTER_KEY,
		tedi: params.tedi,
		app: params.app,
		role: params.role,
		createdBy: params.createdBy ?? null,
	});
	if (result.mcpServerId) {
		clearAihTokenCacheForTediServer({
			tediId: params.tedi.id,
			mcpServerId: result.mcpServerId,
		});
		// Best-effort: invalidate the MCP edge scope cache so the new scopes take
		// effect immediately on the next request rather than waiting up to 5 min.
		// Failure is non-fatal — the TTL backstop covers all isolates regardless.
		if (
			(result.status === "created" || result.status === "updated") &&
			params.env.MCP_SERVICE
		) {
			try {
				await params.env.MCP_SERVICE.fetch(
					new Request("https://internal/__internal/invalidate-scope-cache", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Service-Binding": "true",
						},
						body: JSON.stringify({ mcpServerId: result.mcpServerId }),
					}),
				);
			} catch (err) {
				console.error(
					"[syncTediAihClientForAssignment] scope cache invalidation failed (non-fatal):",
					err instanceof Error ? err.message : String(err),
				);
			}
		}
	}
	return result;
}

export async function deleteTediAihClientForAssignment(params: {
	db: DbClient;
	env: CloudflareEnv;
	tedi: Tedi;
	app: App;
}) {
	const result = await deleteTediAihClientForApp({
		env: requireAihManagementEnv(params.env),
		db: params.db,
		tedi: params.tedi,
		app: params.app,
	});
	if (result.mcpServerId) {
		clearAihTokenCacheForTediServer({
			tediId: params.tedi.id,
			mcpServerId: result.mcpServerId,
		});
	}
	return result;
}

export async function runTediMcpAccessBatchOnTargets(params: {
	db: DbClient;
	env: CloudflareEnv;
	orgId: string;
	input: TediMcpAccessBatchRunInput;
	apps: App[];
	tedis: Tedi[];
	repairInvalid: boolean;
	createdBy?: string | null;
}): Promise<TediMcpAccessBatchRunResult> {
	const { db, env, orgId, input, apps, tedis, repairInvalid } = params;
	const dryRun = input.dryRun ?? !repairInvalid;
	const includeValid = input.includeValid ?? !repairInvalid;
	const includeSkipped = input.includeSkipped ?? true;
	const scanNonAihAssignments = shouldScanNonAihAssignment(input);
	const appIds = apps.map((app) => app.id);
	const mgmt = getManagementClient(env);
	const items: TediMcpAccessBatchItem[] = [];
	let totalAssignments = 0;
	let valid = 0;
	let invalid = 0;
	let skipped = 0;
	let repaired = 0;
	let failed = 0;

	for (const tedi of tedis) {
		if (!tedi.descopeUserId || appIds.length === 0) continue;

		const assignedRoles = await getAssignedAppRoles(
			mgmt,
			tedi.descopeUserId,
			appIds,
		);
		let identity: Awaited<ReturnType<typeof attestTediDescopeSubject>> | null =
			null;
		for (const app of apps) {
			const role = assignedRoles[app.id];
			if (!role) continue;
			if (!appHasAihMcpResource(app) && !scanNonAihAssignments) continue;

			totalAssignments += 1;
			const assignment = assignmentFromRows({
				orgId,
				tedi,
				app,
				role,
				now: new Date().toISOString(),
			});
			const clientValidation = await validateTediAihClientForApp({
				env: requireAihManagementEnv(env),
				db,
				masterKey: requireAihSyncEnv(env).SECRETS_MASTER_KEY,
				tedi,
				app,
				role,
				identity:
					identity ??
					(identity = await attestTediDescopeSubject(
						requireAihManagementEnv(env),
						tedi,
					)),
			});
			const baselineIssues =
				role === "operator"
					? unifiedGatewayWorkBaselineIssues(app, tedi.slug)
					: [];
			const validation =
				baselineIssues.length > 0
					? {
							...clientValidation,
							status: "invalid" as const,
							ok: false,
							reason: `Unified gateway Work baseline missing: ${baselineIssues.join("; ")}`,
						}
					: clientValidation;

			if (validation.status === "valid") {
				valid += 1;
			} else if (validation.status === "skipped") {
				skipped += 1;
			} else {
				invalid += 1;
			}

			const item: TediMcpAccessBatchItem = { assignment, validation };
			if (
				repairInvalid &&
				validation.status === "invalid" &&
				baselineIssues.length === 0 &&
				!dryRun
			) {
				try {
					item.repair = await syncTediAihClientForAssignment({
						db,
						env,
						tedi,
						app,
						role,
						createdBy: params.createdBy ?? null,
					});
					item.afterValidation = await validateTediAihClientForApp({
						env: requireAihManagementEnv(env),
						db,
						masterKey: requireAihSyncEnv(env).SECRETS_MASTER_KEY,
						tedi,
						app,
						role,
						identity,
					});
					if (item.afterValidation.ok) {
						repaired += 1;
					} else {
						failed += 1;
						item.error =
							item.afterValidation.reason ??
							"AIH repair completed but validation still failed";
					}
				} catch (error) {
					failed += 1;
					item.error =
						error instanceof Error ? error.message : "AIH repair failed";
				}
			}

			const shouldInclude =
				validation.status === "valid"
					? includeValid
					: validation.status === "skipped"
						? includeSkipped
						: true;
			if (shouldInclude || item.repair || item.error) {
				items.push(item);
			}
		}
	}

	return {
		repairInvalid,
		dryRun,
		filters: {
			tediId: input.tediId,
			appId: input.appId,
			appSlug: input.appSlug?.trim().toLowerCase(),
		},
		totalAssignments,
		valid,
		invalid,
		skipped,
		repaired,
		failed,
		items,
	};
}

export function toTediMcpAccessHealth(
	result: TediMcpAccessBatchRunResult,
): TediMcpAccessHealthResult {
	return {
		...result,
		healthy: result.invalid === 0 && result.failed === 0,
		checkedAt: new Date().toISOString(),
	};
}
