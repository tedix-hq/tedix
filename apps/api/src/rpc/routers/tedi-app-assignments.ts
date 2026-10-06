/**
 * oRPC Tedi App Assignments Router (V2 — FGA-backed)
 *
 * Manages tedi ↔ app authorization via Descope AuthZ (ReBAC).
 * Replaces D1 tedi_app_assignments table with FGA relations.
 *
 * REST Endpoints:
 * GET    /tedi-app-assignments/by-app/{appId}           - List tedi assignments for an app
 * GET    /tedi-app-assignments/by-tedi/{tediId}         - List app assignments for a tedi
 * GET    /tedi-app-assignments/fga-relations/by-app/{appId}   - Raw FGA relations held on an app
 * GET    /tedi-app-assignments/fga-relations/by-tedi/{tediId} - Raw FGA relations held by a tedi
 * GET    /tedi-app-assignments/managed/by-tedi/{tediId} - Preview config-driven managed assignments
 * POST   /tedi-app-assignments/managed/reconcile        - Materialize managed assignments into FGA
 * POST   /tedi-app-assignments/aih-client/repair        - Repair AIH client + tedi secrets for an assignment
 * POST   /tedi-app-assignments                          - Create assignment (FGA relation)
 * DELETE /tedi-app-assignments/{assignmentId}           - Delete assignment (FGA relation)
 * PATCH  /tedi-app-assignments/{assignmentId}           - Update role
 */

import { implement } from "@orpc/server";
import { tediAppAssignmentsContract } from "@tedix/api-contract/contracts/tedi-app-assignments";
import type {
	AppFgaRelation,
	ManagedTediAppAssignment,
	TediAppAssignment,
	TediAppAssignmentAihClientSyncResult,
	TediFgaRelation,
} from "@tedix/api-contract/schemas/tedi-app-assignments";
import { computeManagedAssignmentsForTedi } from "@tedix/auth/app-assignment-policy";
import { getManagementClient } from "@tedix/auth/client";
import {
	deleteAppRelation,
	getAppObservers,
	getAppOperators,
	getAppRoleStateForMutation,
	getAssignedAppRoles,
	grantAppObserver,
	grantAppOperator,
	queryAppRelations,
	queryTediRelations,
	revokeAppAccess,
} from "@tedix/auth/fga";
import { getAppById, getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getAppBySlug, getAppsByOrganization } from "@tedix/db/queries/apps";
import { getTediById, getTedisByOrganization } from "@tedix/db/queries/tedis";
import { validateTediAihClientForApp } from "../../lib/tedi-aih-client-sync";
import {
	deleteTediAihClientForAssignment,
	runTediMcpAccessBatchOnTargets,
	syncTediAihClientForAssignment,
	toTediMcpAccessHealth,
} from "../../services/tedi-mcp-access";
import { auditActor, emitAuditEvent } from "../audit-helpers";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const assignmentsOs = implement(
	tediAppAssignmentsContract,
).$context<BaseContext>();
const authedOs = assignmentsOs.use(withAuth);

// =============================================================================
// HELPERS
// =============================================================================

function getMgmtClient(context: BaseContext) {
	if (!context.env.DESCOPE_MANAGEMENT_KEY) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"DESCOPE_MANAGEMENT_KEY not configured",
		);
	}
	return getManagementClient(context.env);
}

async function auditAssignmentChange(
	context: BaseContext,
	organizationId: string,
	action:
		| "tedi_app_assignment.grant_requested"
		| "tedi_app_assignment.granted"
		| "tedi_app_assignment.revoke_requested"
		| "tedi_app_assignment.revoked"
		| "tedi_app_assignment.role_change_requested"
		| "tedi_app_assignment.role_change_rolled_back"
		| "tedi_app_assignment.role_change_recovery_failed"
		| "tedi_app_assignment.role_changed",
	app: { id: string; slug: string },
	tedi: { id: string },
	roles: {
		previousRole?: "operator" | "observer" | null;
		role?: "operator" | "observer";
	},
): Promise<void> {
	const actor = auditActor(context);
	await emitAuditEvent(context.db, {
		organizationId,
		actorId: actor.actorId,
		actorType: actor.actorType,
		action,
		resourceType: "tedi_app_assignment",
		resourceId: `fga:${tedi.id}:${app.id}`,
		metadata: {
			...actor.actorMetadata,
			appId: app.id,
			appSlug: app.slug,
			tediId: tedi.id,
			...roles,
		},
	});
}

function requireAihManagementEnv(context: BaseContext) {
	if (!context.env.DESCOPE_PROJECT_ID || !context.env.DESCOPE_MANAGEMENT_KEY) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Descope AIH management credentials are not configured",
		);
	}
	return {
		DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
	};
}

function requireSecretsMasterKey(context: BaseContext): string {
	if (!context.env.SECRETS_MASTER_KEY) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"SECRETS_MASTER_KEY not configured",
		);
	}
	return context.env.SECRETS_MASTER_KEY;
}

async function syncAihClientForAssignment(params: {
	context: BaseContext;
	tedi: NonNullable<Awaited<ReturnType<typeof getTediById>>>;
	app: NonNullable<Awaited<ReturnType<typeof getAppById>>>;
	role: "operator" | "observer";
}) {
	return syncTediAihClientForAssignment({
		db: params.context.db,
		env: params.context.env,
		tedi: params.tedi,
		app: params.app,
		role: params.role,
		createdBy: params.context.user?.sub ?? null,
	});
}

async function deleteAihClientForAssignment(params: {
	context: BaseContext;
	tedi: NonNullable<Awaited<ReturnType<typeof getTediById>>>;
	app: NonNullable<Awaited<ReturnType<typeof getAppById>>>;
}) {
	return deleteTediAihClientForAssignment({
		db: params.context.db,
		env: params.context.env,
		tedi: params.tedi,
		app: params.app,
	});
}

/**
 * Log an AIH sync outcome.
 *
 * The returned `aihClientSync` field is the contract-level fix; this log stays
 * as the operational breadcrumb that correlates a request with Descope. It
 * escalates to `console.warn` on `skipped` so the log is not itself a place
 * where "no AIH client was touched" reads identically to a clean sync — a
 * skipped sync means the assignment exists in FGA but the tedi has no Descope
 * client for the app, and `reason` says why.
 */
function logAihSyncOutcome(
	scope: string,
	result: TediAppAssignmentAihClientSyncResult,
) {
	const line = `[TediAppAssignments/AIH] ${scope}: status=${result.status} tedi=${result.tediId} app=${result.appSlug} scopes=${result.scopes.join(",")}${result.reason ? ` reason=${result.reason}` : ""}`;
	if (result.status === "skipped") {
		console.warn(line);
		return;
	}
	console.log(line);
}

async function loadCurrentAssignmentsForTedi(
	context: BaseContext,
	orgId: string,
	tediId: string,
): Promise<{
	tedi: NonNullable<Awaited<ReturnType<typeof getTediById>>>;
	current: TediAppAssignment[];
}> {
	const tedi = await getTediById(context.db, tediId);
	if (!tedi || tedi.organizationId !== orgId) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}

	const orgApps = await getAppsByOrganization(context.db, orgId);
	const now = new Date().toISOString();
	if (!tedi.descopeUserId || orgApps.length === 0) {
		return { tedi, current: [] };
	}

	const mgmt = getMgmtClient(context);
	const rolesByAppId = await getAssignedAppRoles(
		mgmt,
		tedi.descopeUserId,
		orgApps.map((app) => app.id),
	);

	const current = orgApps
		.filter((app) => rolesByAppId[app.id])
		.map((app) => ({
			id: `fga:${tedi.id}:${app.id}`,
			organizationId: orgId,
			appId: app.id,
			tediId: tedi.id,
			role: rolesByAppId[app.id]!,
			assignedBy: null,
			createdAt: String(tedi.createdAt ?? now),
			updatedAt: String(tedi.updatedAt ?? now),
		}));

	return { tedi, current };
}

async function loadManagedPreviewForTedi(
	context: BaseContext,
	orgId: string,
	tediId: string,
) {
	const { tedi, current } = await loadCurrentAssignmentsForTedi(
		context,
		orgId,
		tediId,
	);
	const orgApps = await getAppsByOrganization(context.db, orgId);
	const desired = computeManagedAssignmentsForTedi(
		orgApps.map((app) => ({
			id: app.id,
			name: app.name,
			slug: app.slug,
			metadata: getAppMetadataJson(app),
		})),
		{
			id: tedi.id,
			slug: tedi.slug,
			mcpCapabilityProfile: tedi.mcpCapabilityProfile,
			tags: tedi.tags,
		},
	).map<ManagedTediAppAssignment>((assignment) => ({
		appId: assignment.appId,
		appSlug: assignment.appSlug,
		appName: assignment.appName,
		role: assignment.role,
		reason: `assignmentConfig(profile-default:${tedi.mcpCapabilityProfile ?? "standard"})`,
	}));

	const currentByAppId = new Map(
		current.map((assignment) => [assignment.appId, assignment]),
	);
	const desiredByAppId = new Map(
		desired.map((assignment) => [assignment.appId, assignment]),
	);

	const missing = desired.filter((assignment) => {
		const currentAssignment = currentByAppId.get(assignment.appId);
		return !currentAssignment || currentAssignment.role !== assignment.role;
	});
	const unchanged = desired.filter((assignment) => {
		const currentAssignment = currentByAppId.get(assignment.appId);
		return currentAssignment?.role === assignment.role;
	});
	const extra = current.filter((assignment) => {
		const desiredAssignment = desiredByAppId.get(assignment.appId);
		return !desiredAssignment || desiredAssignment.role !== assignment.role;
	});

	return {
		tedi,
		current,
		desired,
		missing,
		extra,
		unchanged,
	};
}

async function loadMcpAccessBatchApps(
	context: BaseContext,
	orgId: string,
	input: { appId?: string; appSlug?: string },
) {
	if (input.appId || input.appSlug) {
		const app = input.appId
			? await getAppById(context.db, input.appId)
			: await getAppBySlug(context.db, input.appSlug!.trim());
		if (!app || app.organizationId !== orgId) {
			throw createError(ErrorCodes.NOT_FOUND, "App not found");
		}
		if (input.appSlug && app.slug !== input.appSlug.trim().toLowerCase()) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"appId and appSlug refer to different apps",
			);
		}
		return [app];
	}

	return getAppsByOrganization(context.db, orgId);
}

async function loadMcpAccessBatchTedis(
	context: BaseContext,
	orgId: string,
	input: { tediId?: string },
) {
	if (input.tediId) {
		const tedi = await getTediById(context.db, input.tediId);
		if (!tedi || tedi.organizationId !== orgId) {
			throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
		}
		return [tedi];
	}

	return getTedisByOrganization(context.db, orgId);
}

async function runMcpAccessBatch(params: {
	context: BaseContext;
	orgId: string;
	input: {
		tediId?: string;
		appId?: string;
		appSlug?: string;
		includeValid?: boolean;
		includeSkipped?: boolean;
		includeNonAih?: boolean;
		dryRun?: boolean;
	};
	repairInvalid: boolean;
}) {
	const { context, orgId, input, repairInvalid } = params;
	const apps = await loadMcpAccessBatchApps(context, orgId, input);
	const tedis = await loadMcpAccessBatchTedis(context, orgId, input);
	return runTediMcpAccessBatchOnTargets({
		db: context.db,
		env: context.env,
		orgId,
		input,
		apps,
		tedis,
		repairInvalid,
		createdBy: context.user?.sub ?? null,
	});
}

// =============================================================================
// PROCEDURES
// =============================================================================

/**
 * List tedis assigned to an app.
 * Uses FGA whoCanAccess to find operators, then enriches with tedi data from D1.
 */
const listByApp = authedOs.listByApp
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const app = await getAppById(context.db, input.appId);
		if (!app || app.organizationId !== orgId) {
			throw createError(ErrorCodes.NOT_FOUND, "App not found");
		}

		const mgmt = getMgmtClient(context);
		const orgTedis = await getTedisByOrganization(context.db, orgId);
		const candidateDescopeIds = orgTedis
			.filter(
				(t): t is typeof t & { descopeUserId: string } => !!t.descopeUserId,
			)
			.map((t) => t.descopeUserId);
		const [operatorDescopeIds, observerDescopeIds] = await Promise.all([
			getAppOperators(mgmt, app.id, candidateDescopeIds),
			getAppObservers(mgmt, app.id, candidateDescopeIds),
		]);
		const roleByDescopeId = new Map<string, "operator" | "observer">();
		for (const descopeUserId of observerDescopeIds) {
			roleByDescopeId.set(descopeUserId, "observer");
		}
		for (const descopeUserId of operatorDescopeIds) {
			roleByDescopeId.set(descopeUserId, "operator");
		}
		const now = new Date().toISOString();
		const data = orgTedis
			.filter((t) => t.descopeUserId && roleByDescopeId.has(t.descopeUserId))
			.map((t) => ({
				id: `fga:${t.id}:${app.id}`,
				organizationId: orgId,
				appId: app.id,
				tediId: t.id,
				role: roleByDescopeId.get(t.descopeUserId!) ?? "observer",
				assignedBy: null as string | null,
				createdAt: String(t.createdAt ?? now),
				updatedAt: String(t.updatedAt ?? now),
			}));

		return { data };
	});

/**
 * List apps assigned to a tedi.
 */
const listByTedi = authedOs.listByTedi
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { current } = await loadCurrentAssignmentsForTedi(
			context,
			orgId,
			input.tediId,
		);
		return { data: current };
	});

/**
 * Publish the raw FGA relations held ON an app.
 *
 * Guard: `AUTHZ.tedisRead`, the same guard as `listByApp`/`listByTedi`.
 * Deliberate, not copied. The facts here are the tedi↔app authorization facts
 * those two already publish under that guard, so a stricter guard on the raw
 * view would be theatre while the derived view stays open, and a looser one
 * (`apps:read`) would widen an authorization-plane read. The tenancy boundary
 * is the org-ownership check below, not the guard: relations are org-scoped
 * only because the app is, so the app must be proven org-owned BEFORE Descope
 * is queried — `resourceRelations` itself is project-wide and knows nothing
 * about tenants.
 */
const listFgaRelationsByApp = authedOs.listFgaRelationsByApp
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const app = await getAppById(context.db, input.appId);
		if (!app || app.organizationId !== orgId) {
			throw createError(ErrorCodes.NOT_FOUND, "App not found");
		}

		const mgmt = getMgmtClient(context);
		// Throws when Descope cannot answer, rather than reporting zero
		// relations. "Nobody can operate this app" must never be produced by an
		// outage — see `queryAppRelations`.
		const relations = await queryAppRelations(mgmt, app.id);

		// Retired tedis included on purpose: a retired tedi still holding
		// operator is live authority nobody is operating, and it is the finding
		// most worth naming. Excluding them would silently demote it to an
		// anonymous `unresolvedTargetCount`.
		const orgTedis = await getTedisByOrganization(context.db, orgId, {
			includeRetired: true,
		});
		const tediByDescopeId = new Map(
			orgTedis
				.filter(
					(t): t is typeof t & { descopeUserId: string } => !!t.descopeUserId,
				)
				.map((t) => [t.descopeUserId, t] as const),
		);

		let unresolvedTargetCount = 0;
		const data: AppFgaRelation[] = relations.map((relation) => {
			const tedi = relation.target
				? tediByDescopeId.get(relation.target)
				: undefined;
			if (!tedi) unresolvedTargetCount++;
			return {
				namespace: relation.namespace,
				relation: relation.relationDefinition,
				target: relation.target ?? null,
				tediId: tedi?.id ?? null,
				tediSlug: tedi?.slug ?? null,
				tediRetired: tedi ? Boolean(tedi.retiredAt) : null,
			};
		});

		return {
			appId: app.id,
			appSlug: app.slug,
			checkedAt: new Date().toISOString(),
			relations: data,
			unresolvedTargetCount,
		};
	});

/**
 * Publish the raw FGA relations a tedi holds.
 *
 * Same guard and same reasoning as `listFgaRelationsByApp`; here the tenancy
 * boundary is the tedi's org ownership plus the org-app filter below, because
 * `targetsRelations` answers for the whole project.
 */
const listFgaRelationsByTedi = authedOs.listFgaRelationsByTedi
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const tedi = await getTediById(context.db, input.tediId);
		if (!tedi || tedi.organizationId !== orgId) {
			throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
		}
		if (!tedi.descopeUserId) {
			// `queryTediRelations` short-circuits an empty target list to `[]`
			// without calling Descope, so falling through here would answer "this
			// tedi holds no relations" for a tedi nobody ever asked about — the
			// same clean-looking non-answer this endpoint exists to rule out.
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Tedi has no Descope identity — run auth migration",
			);
		}

		const mgmt = getMgmtClient(context);
		const relations = await queryTediRelations(mgmt, [tedi.descopeUserId]);

		const orgApps = await getAppsByOrganization(context.db, orgId);
		const appById = new Map(orgApps.map((app) => [app.id, app] as const));

		let unresolvedRelationCount = 0;
		const data: TediFgaRelation[] = [];
		for (const relation of relations) {
			const app = appById.get(relation.resource);
			if (!app) {
				// The resource is not an app this organization owns, so its ID
				// belongs to another tenant. Counted, never echoed — see
				// `TediFgaRelationsSchema.unresolvedRelationCount`.
				unresolvedRelationCount++;
				continue;
			}
			data.push({
				namespace: relation.namespace,
				relation: relation.relationDefinition,
				appId: app.id,
				appSlug: app.slug,
			});
		}

		return {
			tediId: tedi.id,
			descopeUserId: tedi.descopeUserId,
			checkedAt: new Date().toISOString(),
			relations: data,
			unresolvedRelationCount,
		};
	});

/**
 * Preview the config-driven assignment baseline for a tedi.
 */
const previewManagedByTedi = authedOs.previewManagedByTedi
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const preview = await loadManagedPreviewForTedi(
			context,
			orgId,
			input.tediId,
		);

		return {
			tediId: preview.tedi.id,
			current: preview.current,
			desired: preview.desired,
			missing: preview.missing,
			extra: preview.extra,
			unchanged: preview.unchanged,
		};
	});

/**
 * Reconcile config-driven assignments into FGA.
 */
const reconcileManagedByTedi = authedOs.reconcileManagedByTedi
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const preview = await loadManagedPreviewForTedi(
			context,
			orgId,
			input.tediId,
		);
		const dryRun = input.dryRun ?? false;
		const pruneExtra = input.pruneExtra ?? false;
		const aihClientSyncs: TediAppAssignmentAihClientSyncResult[] = [];

		if (!preview.tedi.descopeUserId) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Tedi has no Descope identity — run auth migration",
			);
		}

		if (!dryRun) {
			const mgmt = getMgmtClient(context);
			const currentByAppId = new Map(
				preview.current.map((assignment) => [assignment.appId, assignment]),
			);
			const orgApps = await getAppsByOrganization(context.db, orgId);
			const appsById = new Map(orgApps.map((app) => [app.id, app]));

			for (const assignment of preview.missing) {
				const currentAssignment = currentByAppId.get(assignment.appId);
				if (currentAssignment) {
					await revokeAppAccess(
						mgmt,
						preview.tedi.descopeUserId,
						assignment.appId,
					);
				}

				if (assignment.role === "operator") {
					await grantAppOperator(
						mgmt,
						preview.tedi.descopeUserId,
						assignment.appId,
					);
				} else {
					await grantAppObserver(
						mgmt,
						preview.tedi.descopeUserId,
						assignment.appId,
					);
				}
			}

			if (pruneExtra) {
				for (const assignment of preview.extra) {
					const desiredAssignment = preview.desired.find(
						(candidate) => candidate.appId === assignment.appId,
					);
					if (desiredAssignment && desiredAssignment.role !== assignment.role) {
						continue;
					}
					await revokeAppAccess(
						mgmt,
						preview.tedi.descopeUserId,
						assignment.appId,
					);
					const app = appsById.get(assignment.appId);
					if (app) {
						const deleteResult = await deleteAihClientForAssignment({
							context,
							tedi: preview.tedi,
							app,
						});
						aihClientSyncs.push(deleteResult);
						logAihSyncOutcome("reconcile/prune", deleteResult);
					}
				}
			}

			for (const assignment of preview.desired) {
				const app = appsById.get(assignment.appId);
				if (!app) continue;
				const syncResult = await syncAihClientForAssignment({
					context,
					tedi: preview.tedi,
					app,
					role: assignment.role,
				});
				aihClientSyncs.push(syncResult);
				logAihSyncOutcome("reconcile/desired", syncResult);
			}
		}

		return {
			tediId: preview.tedi.id,
			dryRun,
			pruneExtra,
			aihClientSyncs,
			current: preview.current,
			desired: preview.desired,
			missing: preview.missing,
			extra: preview.extra,
			unchanged: preview.unchanged,
			added: preview.missing,
			removed: pruneExtra ? preview.extra : [],
		};
	});

/**
 * Create a tedi ↔ app assignment via FGA.
 */
const createAssignmentProcedure = authedOs.create
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const app = await getAppById(context.db, input.appId);
		if (!app || app.organizationId !== orgId) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"App not found in your organization",
			);
		}

		const tedi = await getTediById(context.db, input.tediId);
		if (!tedi || tedi.organizationId !== orgId) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Tedi not found in your organization",
			);
		}

		if (!tedi.descopeUserId) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Tedi has no Descope identity — run auth migration",
			);
		}

		const mgmt = getMgmtClient(context);
		const existingRoles = await getAssignedAppRoles(mgmt, tedi.descopeUserId, [
			app.id,
		]);
		if (existingRoles[app.id]) {
			throw createError(
				ErrorCodes.CONFLICT,
				"This tedi is already assigned to this app",
			);
		}

		const role = input.role ?? "operator";
		await auditAssignmentChange(
			context,
			orgId,
			"tedi_app_assignment.grant_requested",
			app,
			tedi,
			{ role },
		);
		if (role === "operator") {
			await grantAppOperator(mgmt, tedi.descopeUserId, app.id);
		} else {
			await grantAppObserver(mgmt, tedi.descopeUserId, app.id);
		}
		await auditAssignmentChange(
			context,
			orgId,
			"tedi_app_assignment.granted",
			app,
			tedi,
			{ role },
		);

		const syncResult = await syncAihClientForAssignment({
			context,
			tedi,
			app,
			role,
		});

		const now = new Date().toISOString();
		// The FGA grant above succeeded; the AIH sync is a separate effect that
		// may legitimately have been skipped. Return it so the caller can tell
		// "assigned and MCP-credentialed" from "assigned only".
		const result = {
			id: `fga:${tedi.id}:${app.id}`,
			organizationId: orgId,
			appId: app.id,
			tediId: tedi.id,
			role,
			assignedBy: context.user?.sub ?? null,
			createdAt: now,
			updatedAt: now,
			aihClientSync: syncResult,
		};

		logAihSyncOutcome("create", syncResult);
		return result;
	});

/**
 * Validate a tedi's MCP access to an assigned app without mutating Descope or D1.
 */
const validateMcpAccessProcedure = authedOs.validateMcpAccess
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		if (!input.appId && !input.appSlug) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Either appId or appSlug is required",
			);
		}

		const app = input.appId
			? await getAppById(context.db, input.appId)
			: await getAppBySlug(context.db, input.appSlug!.trim());
		if (!app || app.organizationId !== orgId) {
			throw createError(ErrorCodes.NOT_FOUND, "App not found");
		}

		if (input.appSlug && app.slug !== input.appSlug.trim().toLowerCase()) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"appId and appSlug refer to different apps",
			);
		}

		const tedi = await getTediById(context.db, input.tediId);
		if (!tedi || tedi.organizationId !== orgId || !tedi.descopeUserId) {
			throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
		}

		const mgmt = getMgmtClient(context);
		const assignedRoles = await getAssignedAppRoles(mgmt, tedi.descopeUserId, [
			app.id,
		]);
		const role = assignedRoles[app.id];
		if (!role) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Tedi is not assigned to this app",
			);
		}

		return validateTediAihClientForApp({
			env: requireAihManagementEnv(context),
			db: context.db,
			masterKey: requireSecretsMasterKey(context),
			tedi,
			app,
			role,
		});
	});

/**
 * Validate all matching tedi MCP app assignments without mutation.
 */
const validateMcpAccessBatchProcedure = authedOs.validateMcpAccessBatch
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		return runMcpAccessBatch({
			context,
			orgId,
			input,
			repairInvalid: false,
		});
	});

/**
 * Validate all matching tedi MCP app assignments and repair invalid rows.
 */
const repairMcpAccessBatchProcedure = authedOs.repairMcpAccessBatch
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		return runMcpAccessBatch({
			context,
			orgId,
			input,
			repairInvalid: true,
		});
	});

/**
 * Compact fleet health summary for tedi MCP app access.
 */
const mcpAccessHealthProcedure = authedOs.mcpAccessHealth
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const result = await runMcpAccessBatch({
			context,
			orgId,
			input: {
				...input,
				includeValid: false,
				includeSkipped: input.includeSkipped ?? false,
			},
			repairInvalid: false,
		});
		return toTediMcpAccessHealth(result);
	});

/**
 * Start durable tedi MCP access-health workflow for this organization.
 */
const runMcpAccessHealthWorkflowProcedure = authedOs.runMcpAccessHealthWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const workflow = context.env.TEDI_MCP_ACCESS_HEALTH_WORKFLOW;
		if (!workflow) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"TEDI_MCP_ACCESS_HEALTH_WORKFLOW not configured",
			);
		}
		const repairInvalid = input.repairInvalid ?? false;
		const dryRun = input.dryRun ?? !repairInvalid;
		const instance = await workflow.create({
			params: {
				...input,
				organizationIds: [orgId],
				repairInvalid,
				dryRun,
				source: "operator",
			},
		});
		return {
			workflowId: instance.id,
			status: "queued" as const,
			repairInvalid,
			dryRun,
		};
	});

/**
 * Delete a tedi ↔ app assignment.
 * assignmentId format: fga:{tediId}:{appId}
 */
const deleteAssignmentProcedure = authedOs.delete
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const parts = input.assignmentId.split(":");
		if (parts[0] !== "fga" || parts.length !== 3) {
			throw createError(ErrorCodes.NOT_FOUND, "Invalid assignment ID format");
		}
		const [, tediId, appId] = parts;

		const tedi = await getTediById(context.db, tediId!);
		if (!tedi || tedi.organizationId !== orgId || !tedi.descopeUserId) {
			throw createError(ErrorCodes.NOT_FOUND, "Assignment not found");
		}
		const app = await getAppById(context.db, appId!);
		if (!app || app.organizationId !== orgId) {
			throw createError(ErrorCodes.NOT_FOUND, "Assignment not found");
		}

		const mgmt = getMgmtClient(context);
		const previousRole =
			(await getAssignedAppRoles(mgmt, tedi.descopeUserId, [app.id]))[app.id] ??
			null;
		await auditAssignmentChange(
			context,
			orgId,
			"tedi_app_assignment.revoke_requested",
			app,
			tedi,
			{ previousRole },
		);
		await revokeAppAccess(mgmt, tedi.descopeUserId, appId!);
		await auditAssignmentChange(
			context,
			orgId,
			"tedi_app_assignment.revoked",
			app,
			tedi,
			{ previousRole },
		);
		const syncResult = await deleteAihClientForAssignment({
			context,
			tedi,
			app,
		});

		// `delete` keeps the shared `SuccessResponseSchema` output — a skipped AIH
		// delete means there was no client to remove, which does not weaken the
		// revocation the caller asked for. The log still distinguishes it.
		logAihSyncOutcome("delete", syncResult);
		return { success: true as const, message: "Assignment removed" };
	});

/**
 * Update the role of a tedi ↔ app assignment.
 */
const updateRoleProcedure = authedOs.updateRole
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const parts = input.assignmentId.split(":");
		if (parts[0] !== "fga" || parts.length !== 3) {
			throw createError(ErrorCodes.NOT_FOUND, "Invalid assignment ID format");
		}
		const [, tediId, appId] = parts;

		const tedi = await getTediById(context.db, tediId!);
		if (!tedi || tedi.organizationId !== orgId || !tedi.descopeUserId) {
			throw createError(ErrorCodes.NOT_FOUND, "Assignment not found");
		}
		const app = await getAppById(context.db, appId!);
		if (!app || app.organizationId !== orgId) {
			throw createError(ErrorCodes.NOT_FOUND, "Assignment not found");
		}

		const mgmt = getMgmtClient(context);
		const original = await getAppRoleStateForMutation(
			mgmt,
			tedi.descopeUserId,
			app.id,
		);
		const previousRole = original.operator
			? "operator"
			: original.observer
				? "observer"
				: null;
		if (!previousRole) {
			throw createError(ErrorCodes.NOT_FOUND, "Assignment not found");
		}
		const targetRole = input.role;
		const oldRole = targetRole === "operator" ? "observer" : "operator";
		const needsGrant = !original[targetRole];
		const needsRemoval = original[oldRole];
		const grant = (role: "operator" | "observer") =>
			role === "operator"
				? grantAppOperator(mgmt, tedi.descopeUserId!, app.id)
				: grantAppObserver(mgmt, tedi.descopeUserId!, app.id);
		if (needsGrant || needsRemoval) {
			await auditAssignmentChange(
				context,
				orgId,
				"tedi_app_assignment.role_change_requested",
				app,
				tedi,
				{ previousRole, role: targetRole },
			);
			let attemptedGrant = false;
			let attemptedRemoval = false;
			try {
				if (needsGrant) {
					attemptedGrant = true;
					await grant(targetRole);
				}
				if (needsRemoval) {
					attemptedRemoval = true;
					await deleteAppRelation(mgmt, tedi.descopeUserId, app.id, oldRole);
				}
				const applied = await getAppRoleStateForMutation(
					mgmt,
					tedi.descopeUserId,
					app.id,
				);
				if (!applied[targetRole] || applied[oldRole]) {
					throw new Error("App FGA role change did not reach the target state");
				}
			} catch {
				// Provider failures can arrive after the effect was applied. Restore
				// the original relation set, then verify it before claiming recovery.
				if (attemptedRemoval && original[oldRole]) {
					try {
						await grant(oldRole);
					} catch {
						// A failed response can still have applied. Final readback decides.
					}
				}
				if (attemptedGrant && !original[targetRole]) {
					try {
						await deleteAppRelation(
							mgmt,
							tedi.descopeUserId,
							app.id,
							targetRole,
						);
					} catch {
						// A failed response can still have applied. Final readback decides.
					}
				}
				let recovered = false;
				try {
					const restored = await getAppRoleStateForMutation(
						mgmt,
						tedi.descopeUserId,
						app.id,
					);
					recovered =
						restored.operator === original.operator &&
						restored.observer === original.observer;
				} catch {
					// Without provider readback, recovery cannot be claimed.
				}
				try {
					await auditAssignmentChange(
						context,
						orgId,
						recovered
							? "tedi_app_assignment.role_change_rolled_back"
							: "tedi_app_assignment.role_change_recovery_failed",
						app,
						tedi,
						{ previousRole, role: targetRole },
					);
				} catch {
					console.error("[FGA] Role change recovery audit unavailable");
				}
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					recovered
						? "Role change failed; original access was restored"
						: "Role change failed; access requires reconciliation",
				);
			}
			await auditAssignmentChange(
				context,
				orgId,
				"tedi_app_assignment.role_changed",
				app,
				tedi,
				{ previousRole, role: targetRole },
			);
		}
		const syncResult = await syncAihClientForAssignment({
			context,
			tedi,
			app,
			role: input.role,
		});

		const now = new Date().toISOString();
		logAihSyncOutcome("updateRole", syncResult);

		// A role change is only fully applied once the AIH client carries the new
		// role's scopes. Surface the sync outcome so a skipped re-scope is not
		// reported as a completed role change.
		return {
			id: input.assignmentId,
			organizationId: orgId,
			appId: appId!,
			tediId: tediId!,
			role: input.role,
			assignedBy: null,
			createdAt: now,
			updatedAt: now,
			aihClientSync: syncResult,
		};
	});

// =============================================================================
// CONTRACT ROUTER
// =============================================================================

export const tediAppAssignmentsContractRouter = assignmentsOs.router({
	listByApp,
	listByTedi,
	listFgaRelationsByApp,
	listFgaRelationsByTedi,
	previewManagedByTedi,
	reconcileManagedByTedi,
	validateMcpAccess: validateMcpAccessProcedure,
	validateMcpAccessBatch: validateMcpAccessBatchProcedure,
	repairMcpAccessBatch: repairMcpAccessBatchProcedure,
	mcpAccessHealth: mcpAccessHealthProcedure,
	runMcpAccessHealthWorkflow: runMcpAccessHealthWorkflowProcedure,
	create: createAssignmentProcedure,
	delete: deleteAssignmentProcedure,
	updateRole: updateRoleProcedure,
});

export type TediAppAssignmentsContractRouter =
	typeof tediAppAssignmentsContractRouter;
