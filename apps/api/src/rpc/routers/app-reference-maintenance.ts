/**
 * Platform-admin, cross-organization repair of app references.
 *
 * - `apps.backfillAggregateAppIds` (MCP `backfill_aggregate_app_ids`)
 * - `apps.renameSlug` (MCP `rename_app_slug`)
 * - `apps.relinkConnectionProvider` (MCP `relink_connection_provider`)
 *
 * Every procedure is a dry run unless `dryRun: false`, and returns the exact
 * per-field plan. Apply writes that plan in one compare-and-set D1 batch, so a
 * row changed between plan and apply aborts the whole apply. Tenant callers
 * are refused by `AUTHZ.platformAdmin` and again by the principal check below.
 */

import { implement } from "@orpc/server";
import { appsContract } from "@tedix/api-contract/contracts/apps";
import type { AppReferenceChange } from "@tedix/api-contract/schemas/app-reference-maintenance";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	type AppReferenceWrite,
	applyAppReferenceWrites,
	getAppSlugIdentity,
	listAppSlugCandidates,
	listAppToolsByConnectionProvider,
	listAppsLinkingToApp,
	listAppsReferencingConnectionProvider,
	listAppsWithAggregateEntriesMissingAppId,
	listCatalogAppsByScanConnection,
	MAX_APP_REFERENCE_WRITES,
} from "@tedix/db/queries/app-reference-maintenance";
import { purgeMcpAggregateCache } from "../../lib/mcp-subscriptions";
import {
	planAggregateAppIdBackfill,
	planAppSlugRename,
	planConnectionProviderRelink,
	slugsMissingAppId,
} from "../../services/app-reference-maintenance";
import { isReservedAppSlug } from "../../utils/app";
import { auditActor, emitAuditEvent } from "../audit-helpers";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { purgeMcpDiscoveryCache } from "./app-discovery-cache";

const maintenanceOs = implement(appsContract)
	.$context<BaseContext>()
	.use(withAuth);

/** Audit rows carry at most this many planned changes inline. */
const AUDIT_CHANGE_SAMPLE = 100;

function requirePlatformOperator(context: BaseContext): void {
	if (!isPlatformPrincipal(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Cross-organization app reference repair requires platform-admin authority",
		);
	}
}

async function applyPlan(
	context: BaseContext,
	writes: AppReferenceWrite[],
): Promise<void> {
	if (writes.length > MAX_APP_REFERENCE_WRITES) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Plan has ${writes.length} writes; narrow it (for example with organizationId) to at most ${MAX_APP_REFERENCE_WRITES}`,
		);
	}
	try {
		await applyAppReferenceWrites(context.db, writes);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/malformed JSON|stale_reference_plan/i.test(message)) {
			throw createError(
				ErrorCodes.CONFLICT,
				"A planned row changed after the plan was computed; nothing was written. Re-run the dry run and apply again.",
			);
		}
		throw error;
	}
}

async function auditReferenceRepair(
	context: BaseContext,
	event: {
		organizationId: string;
		action: string;
		resourceType: string;
		resourceId?: string;
		dryRun: boolean;
		changes: AppReferenceChange[];
		metadata?: Record<string, unknown>;
	},
): Promise<void> {
	const actor = auditActor(context);
	await emitAuditEvent(context.db, {
		organizationId: event.organizationId,
		actorId: actor.actorId,
		actorType: actor.actorType,
		action: `${event.action}.${event.dryRun ? "planned" : "applied"}`,
		resourceType: event.resourceType,
		resourceId: event.resourceId,
		metadata: {
			...actor.actorMetadata,
			...event.metadata,
			dryRun: event.dryRun,
			changeCount: event.changes.length,
			changes: event.changes.slice(0, AUDIT_CHANGE_SAMPLE),
			changesTruncated: event.changes.length > AUDIT_CHANGE_SAMPLE,
		},
		ipAddress: context.headers.get("CF-Connecting-IP"),
		userAgent: context.headers.get("User-Agent"),
	});
}

/** Strictly verify a Descope outbound app exists; an unreadable list refuses. */
async function connectionProviderExists(
	env: BaseContext["env"],
	providerId: string,
): Promise<boolean> {
	// Lazy: the connections module is heavy and only this rare call needs it.
	const { getDescopeManagement } =
		await import("./connections/policy-resolution");
	const response =
		await getDescopeManagement(
			env,
		).management.outboundApplication.loadAllApplications();
	if (!response.ok || !response.data) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Connection providers could not be verified",
		);
	}
	return response.data.some((app) => app.id === providerId);
}

export const backfillAggregateAppIdsProcedure =
	maintenanceOs.backfillAggregateAppIds
		.use(AUTHZ.platformAdmin)
		.handler(async ({ input, context }) => {
			requirePlatformOperator(context);
			const rows = await listAppsWithAggregateEntriesMissingAppId(context.db, {
				organizationId: input.organizationId,
			});
			const candidates = await listAppSlugCandidates(
				context.db,
				slugsMissingAppId(rows),
			);
			const plan = planAggregateAppIdBackfill(rows, candidates);
			const apply = !input.dryRun && plan.writes.length > 0;
			if (apply) await applyPlan(context, plan.writes);
			await auditReferenceRepair(context, {
				organizationId: input.organizationId ?? requireOrgId(context),
				action: "app.aggregate_app_ids.backfill",
				resourceType: "app",
				dryRun: input.dryRun,
				changes: plan.changes,
				metadata: {
					filterOrganizationId: input.organizationId ?? null,
					unresolvedCount: plan.unresolved.length,
				},
			});
			if (apply) {
				await purgeMcpAggregateCache(
					context.env,
					"apps.backfillAggregateAppIds",
				);
			}
			return {
				dryRun: input.dryRun,
				applied: apply,
				scannedApps: rows.length,
				changes: plan.changes,
				unresolved: plan.unresolved,
			};
		});

export const renameAppSlugProcedure = maintenanceOs.renameSlug
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		requirePlatformOperator(context);
		const target = await getAppSlugIdentity(context.db, input.appId);
		if (!target) throw createError(ErrorCodes.NOT_FOUND, "App not found");
		const newSlug = input.newSlug;
		// Same rules apps.create / apps.update enforce: the contract's slug
		// pattern, no platform-routing slug, and global uniqueness
		// (`getAppBySlug` is an unscoped lookup).
		if (isReservedAppSlug(newSlug)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Slug "${newSlug}" is reserved for platform routing`,
			);
		}
		if (newSlug !== target.slug) {
			const taken = (await listAppSlugCandidates(context.db, [newSlug])).get(
				newSlug,
			);
			if (taken?.length) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`App with slug "${newSlug}" already exists`,
				);
			}
		}
		const [linkers, oldSlugCandidates] = await Promise.all([
			listAppsLinkingToApp(context.db, {
				appId: target.id,
				slug: target.slug,
			}),
			listAppSlugCandidates(context.db, [target.slug]),
		]);
		const plan = planAppSlugRename({
			target,
			newSlug,
			preserveToolPrefix: input.preserveToolPrefix,
			linkers,
			oldSlugCandidates: oldSlugCandidates.get(target.slug) ?? [],
		});
		if (!input.dryRun && plan.blockers.length > 0) {
			throw createError(
				ErrorCodes.CONFLICT,
				`${plan.blockers.length} linking aggregate entr${plan.blockers.length === 1 ? "y has" : "ies have"} no appId and an ambiguous slug "${target.slug}"; set their appId first (dry run lists them)`,
			);
		}
		const apply = !input.dryRun && plan.writes.length > 0;
		if (apply) await applyPlan(context, plan.writes);
		await auditReferenceRepair(context, {
			organizationId: target.organizationId,
			action: "app.slug.rename",
			resourceType: "app",
			resourceId: target.id,
			dryRun: input.dryRun,
			changes: plan.changes,
			metadata: {
				fromSlug: target.slug,
				toSlug: newSlug,
				blockerCount: plan.blockers.length,
			},
		});
		if (apply) {
			await Promise.all([
				purgeMcpDiscoveryCache(context.env, target.id, [
					{ slug: target.slug },
					{ slug: newSlug },
				]),
				purgeMcpAggregateCache(context.env, "apps.renameSlug"),
			]);
		}
		return {
			dryRun: input.dryRun,
			applied: apply,
			appId: target.id,
			organizationId: target.organizationId,
			fromSlug: target.slug,
			toSlug: newSlug,
			changes: plan.changes,
			blockers: plan.blockers,
		};
	});

export const relinkConnectionProviderProcedure =
	maintenanceOs.relinkConnectionProvider
		.use(AUTHZ.platformAdmin)
		.handler(async ({ input, context }) => {
			requirePlatformOperator(context);
			if (!(await connectionProviderExists(context.env, input.to))) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					`Connection provider "${input.to}" does not exist; relink only rewrites references to an existing provider`,
				);
			}
			const filter = { organizationId: input.organizationId };
			const [appRows, catalogApps, tools] = await Promise.all([
				listAppsReferencingConnectionProvider(context.db, input.from, filter),
				listCatalogAppsByScanConnection(context.db, input.from, filter),
				listAppToolsByConnectionProvider(context.db, input.from, filter),
			]);
			const plan = planConnectionProviderRelink({
				from: input.from,
				to: input.to,
				apps: appRows,
				catalogApps,
				tools,
			});
			const apply = !input.dryRun && plan.writes.length > 0;
			if (apply) await applyPlan(context, plan.writes);
			await auditReferenceRepair(context, {
				organizationId: input.organizationId ?? requireOrgId(context),
				action: "app.connection_provider.relink",
				resourceType: "connection_provider",
				resourceId: input.from,
				dryRun: input.dryRun,
				changes: plan.changes,
				metadata: {
					from: input.from,
					to: input.to,
					filterOrganizationId: input.organizationId ?? null,
				},
			});
			if (apply) {
				await purgeMcpAggregateCache(
					context.env,
					"apps.relinkConnectionProvider",
				);
			}
			return {
				dryRun: input.dryRun,
				applied: apply,
				from: input.from,
				to: input.to,
				changes: plan.changes,
			};
		});
