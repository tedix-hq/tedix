/**
 * Control Plane Router
 * Runtime profiles, policy packs, workspace template sets, and effective config resolution
 *
 * REST Endpoints:
 * GET    /control-plane/runtime-profiles              - List runtime profiles
 * GET    /control-plane/runtime-profiles/{id}         - Get runtime profile
 * POST   /control-plane/runtime-profiles              - Create runtime profile
 * PATCH  /control-plane/runtime-profiles/{id}         - Update runtime profile
 * DELETE /control-plane/runtime-profiles/{id}         - Delete runtime profile
 * GET    /control-plane/policy-packs                  - List policy packs
 * GET    /control-plane/policy-packs/{id}             - Get policy pack
 * POST   /control-plane/policy-packs                  - Create policy pack
 * PATCH  /control-plane/policy-packs/{id}             - Update policy pack
 * DELETE /control-plane/policy-packs/{id}             - Delete policy pack
 * GET    /control-plane/workspace-templates            - List workspace template sets
 * GET    /control-plane/workspace-templates/{id}       - Get workspace template set
 * POST   /control-plane/workspace-templates            - Create workspace template set
 * PATCH  /control-plane/workspace-templates/{id}       - Update workspace template set
 * DELETE /control-plane/workspace-templates/{id}       - Delete workspace template set
 * GET    /control-plane/apps/{appId}/effective-config  - Get effective app config
 */

import { implement } from "@orpc/server";
import { controlPlaneContract } from "@tedix/api-contract/contracts/control-plane";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	createPolicyPack,
	createRuntimeProfile,
	createWorkspaceTemplateSet,
	getEffectiveActiveAppConfig,
	getPolicyPackById,
	getRuntimeProfileById,
	getWorkspaceTemplateSetById,
	listPolicyPacks,
	listRuntimeProfiles,
	listWorkspaceTemplateSets,
} from "@tedix/db/queries/control-plane/definitions";
import {
	rebindTediControlPlaneRevision,
	listPolicyPackRevisions,
	listRuntimeProfileRevisions,
	listTediControlPlaneBindingHistory,
	listWorkspaceTemplateSetRevisions,
	publishPolicyPackRevision,
	publishRuntimeProfileRevision,
	publishWorkspaceTemplateSetRevision,
	rollbackPolicyPackRevision,
	rollbackRuntimeProfileRevision,
	rollbackWorkspaceTemplateSetRevision,
} from "@tedix/db/queries/control-plane/revisions";
import { listPlatformCronExecutionSummaries } from "@tedix/db/queries/platform-cron-executions";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type {
	PolicyPackDefinition,
	RuntimeProfileConfig,
	WorkspaceTemplateSetDefinition,
} from "@tedix/db/schema/control-plane";
import { requireOrgId } from "../org-scope";
import { auditActor } from "../audit-helpers";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { diffControlPlaneJson } from "../../services/control-plane-revision-diff";

import { invalidateConfig, triggerCronSync } from "@tedix/provisioning";
import {
	getProvisioningConfig,
	sanitizeProvisioningError,
} from "./tedis/helpers";

// =============================================================================
// IMPLEMENTER
// =============================================================================

const controlPlaneOs = implement(controlPlaneContract).$context<BaseContext>();
const authedOs = controlPlaneOs.use(withAuth);

/**
 * Platform cron health is Tedix's OWN infrastructure — the API Worker's fleet
 * schedules, their failure strings, and a link into the Tedix Cloudflare
 * account. `platform_cron_executions` has no org dimension, so there is nothing
 * to scope by tenant: the only correct guard is platform authority.
 *
 * This shipped on `AUTHZ.analyticsRead` (an ordinary tenant permission) with a
 * bare `requireOrgId`, which asserts the caller HAS an org and scopes nothing —
 * so every tenant's Automation page rendered our internal fleet. Deliberately
 * no `requireOrgId` here: the data is org-less and a platform principal need
 * not be acting inside a tenant.
 */
const listPlatformCronHealthProcedure = authedOs.listPlatformCronHealth
	.use(AUTHZ.platformAdmin)
	.handler(async ({ context }) => {
		const summaries = await listPlatformCronExecutionSummaries(context.db);
		const { buildPlatformCronHealth } =
			await import("../../jobs/platform-cron-catalog");
		return buildPlatformCronHealth({ env: context.env, summaries });
	});

/**
 * Report divergence between LIVE Descope RBAC and the canonical model.
 *
 * Descope mints the role/permission claims every guard authorizes against, and
 * the sync that aligns the two is run by hand — so a Console edit or a failed
 * sync is invisible until a guard denies someone. This makes it observable
 * without provisioning anything: it reads, plans, and reports.
 *
 * Platform-guarded, matching `descopeAih.auditDrift`: the Descope project is
 * shared across every tenant, so this is Tedix infrastructure state, not tenant
 * data. Deliberately uncached — it is a rarely-called operator diagnostic, and
 * a cache on a drift report is a way to be told stale news about staleness.
 */
const getDescopeRbacDriftProcedure = authedOs.getDescopeRbacDrift
	.use(AUTHZ.platformAdmin)
	.handler(async ({ context }) => {
		const { getManagementClient } = await import("@tedix/auth/client");
		const {
			buildDescopeRbacPlan,
			readDescopeRbacSnapshot,
			summarizeDescopeRbacDrift,
		} = await import("@tedix/auth/descope-rbac-sync");

		const client = getManagementClient(context.env);
		const snapshot = await readDescopeRbacSnapshot(
			client as unknown as Parameters<typeof readDescopeRbacSnapshot>[0],
		);

		return {
			checkedAt: new Date().toISOString(),
			...summarizeDescopeRbacDrift(buildDescopeRbacPlan(snapshot), snapshot),
		};
	});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Authorize a mutation (update/delete) on a control-plane record. A tenant admin
 * may only mutate an `organization`-scoped record owned by their OWN org;
 * `system` records (organizationId === null, shared platform-wide) and other
 * orgs' records are platform-only. Returns NOT_FOUND (not FORBIDDEN) for
 * out-of-boundary ids so the existence of cross-org/system records isn't leaked.
 */
function assertOwnedControlPlaneRecord(
	context: BaseContext,
	record: { scope: string; organizationId: string | null } | null | undefined,
	notFoundMessage: string,
): void {
	if (!record) {
		throw createError(ErrorCodes.NOT_FOUND, notFoundMessage);
	}
	if (isPlatformPrincipal(context)) return;
	if (
		record.scope === "system" ||
		record.organizationId !== context.organizationId
	) {
		throw createError(ErrorCodes.NOT_FOUND, notFoundMessage);
	}
}

/**
 * Authorize a READ of a control-plane record by id. Read visibility is wider
 * than mutation visibility and must mirror exactly what the corresponding
 * `list*` query returns for this caller: the org's own records plus `system`
 * records, which are shared platform-wide and assignable by every org. That is
 * why this cannot reuse {@link assertOwnedControlPlaneRecord} — that guard
 * rejects `system` records, which is right for a mutation and wrong for a read.
 *
 * Without this the get-by-id handlers only asserted that the CALLER had an org,
 * never that the RECORD belonged to it, so any authenticated tenant could read
 * any other tenant's runtime profile, policy pack, or workspace template set by
 * id — while the update/delete siblings were correctly guarded. NOT_FOUND
 * rather than FORBIDDEN, so the existence of another org's record isn't leaked.
 */
export function assertReadableControlPlaneRecord<
	T extends { scope: string; organizationId: string | null },
>(
	context: BaseContext,
	record: T | null | undefined,
	notFoundMessage: string,
): asserts record is T {
	if (!record) {
		throw createError(ErrorCodes.NOT_FOUND, notFoundMessage);
	}
	if (isPlatformPrincipal(context)) return;
	if (record.scope === "system") return;
	if (record.organizationId !== context.organizationId) {
		throw createError(ErrorCodes.NOT_FOUND, notFoundMessage);
	}
}

/**
 * Coerce a caller-supplied create scope: only platform principals may mint
 * `system`-scoped records (which surface to and are assignable by every org).
 */
function resolveCreateScope(
	context: BaseContext,
	requested: string | undefined,
): "system" | "organization" {
	if (requested === "system" && !isPlatformPrincipal(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only platform administrators can create system-scoped records.",
		);
	}
	return requested === "system" ? "system" : "organization";
}

function publishedBy(context: BaseContext): string {
	return auditActor(context).actorId;
}

function unwrapRevision<T>(
	result: { ok: true; revision: T } | { ok: false; reason: string },
	notFoundMessage: string,
): T {
	if (result.ok) return result.revision;
	if (result.reason === "not_found") {
		throw createError(ErrorCodes.NOT_FOUND, notFoundMessage);
	}
	if (result.reason === "family_mismatch") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Revisions do not belong to the same definition family",
		);
	}
	throw createError(
		ErrorCodes.CONFLICT,
		"The definition head or tedi pin changed concurrently",
	);
}

async function assertOwnedTedi(
	context: BaseContext,
	tediId: string,
): Promise<string> {
	const organizationId = requireOrgId(context);
	const tedi = await getTediByIdForOrganization(
		context.db,
		tediId,
		organizationId,
	);
	if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	return organizationId;
}

// =============================================================================
// RUNTIME PROFILES
// =============================================================================

const listRuntimeProfilesProcedure = authedOs.listRuntimeProfiles
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const profiles = await listRuntimeProfiles(context.db, {
			organizationId: input.organizationId ?? orgId,
			includeSystem: input.includeSystem,
		});
		return { data: profiles };
	});

const getRuntimeProfileProcedure = authedOs.getRuntimeProfile
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		const profile = await getRuntimeProfileById(context.db, input.id);
		assertReadableControlPlaneRecord(
			context,
			profile,
			"Runtime profile not found",
		);
		return profile;
	});

const createRuntimeProfileProcedure = authedOs.createRuntimeProfile
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (input.organizationId && input.organizationId !== orgId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot create runtime profile attributed to another organization",
			);
		}
		const profile = await createRuntimeProfile(context.db, {
			name: input.name,
			slug: input.slug,
			description: input.description ?? null,
			scope: resolveCreateScope(context, input.scope),
			config: input.config as RuntimeProfileConfig,
			organizationId: input.organizationId ?? orgId,
			publishedBy: publishedBy(context),
			changeSummary: "Initial revision",
		});
		return profile;
	});

const listRuntimeProfileRevisionsProcedure =
	authedOs.listRuntimeProfileRevisions
		.use(AUTHZ.settingsRead)
		.handler(async ({ input, context }) => {
			requireOrgId(context);
			const source = await getRuntimeProfileById(context.db, input.id);
			assertReadableControlPlaneRecord(
				context,
				source,
				"Runtime profile not found",
			);
			return { data: await listRuntimeProfileRevisions(context.db, input.id) };
		});

const publishRuntimeProfileRevisionProcedure =
	authedOs.publishRuntimeProfileRevision
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			requireOrgId(context);
			const existing = await getRuntimeProfileById(context.db, input.id);
			assertOwnedControlPlaneRecord(
				context,
				existing,
				"Runtime profile not found",
			);
			return unwrapRevision(
				await publishRuntimeProfileRevision(context.db, {
					revisionId: input.id,
					expectedVersion: input.expectedVersion,
					changeSummary: input.changeSummary,
					publishedBy: publishedBy(context),
					name: input.name,
					description: input.description,
					config: input.config as RuntimeProfileConfig | undefined,
					status: input.status,
				}),
				"Runtime profile not found",
			);
		});

const diffRuntimeProfileRevisionsProcedure =
	authedOs.diffRuntimeProfileRevisions
		.use(AUTHZ.settingsRead)
		.handler(async ({ input, context }) => {
			requireOrgId(context);
			const [from, to] = await Promise.all([
				getRuntimeProfileById(context.db, input.id),
				getRuntimeProfileById(context.db, input.otherId),
			]);
			assertReadableControlPlaneRecord(
				context,
				from,
				"Runtime profile not found",
			);
			assertReadableControlPlaneRecord(
				context,
				to,
				"Runtime profile not found",
			);
			if (
				from.scope !== to.scope ||
				from.slug !== to.slug ||
				from.organizationId !== to.organizationId
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Revisions do not belong to the same runtime profile",
				);
			}
			return {
				fromRevisionId: from.id,
				toRevisionId: to.id,
				changes: diffControlPlaneJson(from.config, to.config),
			};
		});

const rollbackRuntimeProfileRevisionProcedure =
	authedOs.rollbackRuntimeProfileRevision
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = await assertOwnedTedi(context, input.tediId);
			const [current, target] = await Promise.all([
				getRuntimeProfileById(context.db, input.id),
				getRuntimeProfileById(context.db, input.targetRevisionId),
			]);
			assertOwnedControlPlaneRecord(
				context,
				current,
				"Runtime profile not found",
			);
			assertOwnedControlPlaneRecord(
				context,
				target,
				"Runtime profile not found",
			);
			return unwrapRevision(
				await rollbackRuntimeProfileRevision(context.db, {
					organizationId,
					tediId: input.tediId,
					currentRevisionId: input.id,
					targetRevisionId: input.targetRevisionId,
					expectedVersion: input.expectedVersion,
					changeSummary: input.changeSummary,
					publishedBy: publishedBy(context),
				}),
				"Runtime profile not found",
			);
		});

const deleteRuntimeProfileProcedure = authedOs.deleteRuntimeProfile
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		const existing = await getRuntimeProfileById(context.db, input.id);
		assertOwnedControlPlaneRecord(
			context,
			existing,
			"Runtime profile not found",
		);
		unwrapRevision(
			await publishRuntimeProfileRevision(context.db, {
				revisionId: input.id,
				status: "archived",
				changeSummary: "Archived definition",
				publishedBy: publishedBy(context),
			}),
			"Runtime profile not found",
		);
		return { success: true as const };
	});

// =============================================================================
// POLICY PACKS
// =============================================================================

const listPolicyPacksProcedure = authedOs.listPolicyPacks
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const packs = await listPolicyPacks(context.db, {
			organizationId: input.organizationId ?? orgId,
			includeSystem: input.includeSystem,
			target: input.target,
		});
		return { data: packs };
	});

const getPolicyPackProcedure = authedOs.getPolicyPack
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		const pack = await getPolicyPackById(context.db, input.id);
		assertReadableControlPlaneRecord(context, pack, "Policy pack not found");
		return pack;
	});

const createPolicyPackProcedure = authedOs.createPolicyPack
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (input.organizationId && input.organizationId !== orgId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot create policy pack attributed to another organization",
			);
		}
		const pack = await createPolicyPack(context.db, {
			name: input.name,
			slug: input.slug,
			description: input.description ?? null,
			scope: resolveCreateScope(context, input.scope),
			target: input.target ?? "shared",
			definition: input.definition as PolicyPackDefinition,
			organizationId: input.organizationId ?? orgId,
			publishedBy: publishedBy(context),
			changeSummary: "Initial revision",
		});
		return pack;
	});

const activatePolicyPackRevisionProcedure = authedOs.activatePolicyPackRevision
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		if (
			(context.authType !== "user" && context.authType !== "apikey") ||
			context.externalAgentPrincipalId != null ||
			context.tediId != null
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Policy activation requires a human or operator API key",
			);
		}
		const tedi = await getTediByIdForOrganization(
			context.db,
			input.tediId,
			input.organizationId,
		);
		if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
		const revision = await getPolicyPackById(context.db, input.id);
		if (
			!revision ||
			(revision.scope !== "system" &&
				revision.organizationId !== input.organizationId)
		) {
			throw createError(ErrorCodes.NOT_FOUND, "Policy pack not found");
		}
		if (
			revision.status !== "active" ||
			!revision.publishedAt ||
			!["tedi", "shared"].includes(revision.target)
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"An active published tedi policy revision is required",
			);
		}
		// An already-applied target retries runtime reconciliation without another audit row.
		if (tedi.policyPackId !== input.id) {
			const applied = await rebindTediControlPlaneRevision(context.db, {
				organizationId: input.organizationId,
				tediId: input.tediId,
				kind: "policy_pack",
				expectedRevisionId: input.expectedRevisionId,
				revisionId: input.id,
				changedBy: publishedBy(context),
				changeReason: input.changeReason,
			});
			if (!applied)
				throw createError(
					ErrorCodes.CONFLICT,
					"The tedi policy pin changed concurrently",
				);
		}
		const config = getProvisioningConfig(tedi, context.env);
		let configInvalidated = false;
		let cronSync: Awaited<ReturnType<typeof triggerCronSync>> | null = null;
		let error: string | null = null;
		if (!config) {
			error = "Tedi runtime route is not configured";
		} else {
			try {
				configInvalidated = await invalidateConfig(config);
				cronSync = await triggerCronSync(config, { forceUpdate: false });
				if (
					!configInvalidated ||
					!cronSync.success ||
					!cronSync.cronBootstrap.ok
				) {
					error =
						"Policy binding applied; runtime reconciliation is incomplete";
				}
			} catch (cause) {
				error = sanitizeProvisioningError(cause);
			}
		}
		let currentRevisionId: string | null = null;
		try {
			const current = await getTediByIdForOrganization(
				context.db,
				input.tediId,
				input.organizationId,
			);
			currentRevisionId = current?.policyPackId ?? null;
			if (currentRevisionId !== input.id)
				error = "The tedi policy pin changed during reconciliation";
		} catch {
			// D1 errors can contain SQL and bound values. Keep the applied binding
			// explicit without exposing internals or implying verified convergence.
			error =
				"Policy binding applied; current policy pin could not be verified";
			console.error("[control-plane] Policy activation readback failed", {
				tediId: input.tediId,
			});
		}
		return {
			bindingApplied: true as const,
			revisionId: input.id,
			currentRevisionId,
			configInvalidated,
			reconciled: error === null,
			cronSync,
			error,
		};
	});

const listPolicyPackRevisionsProcedure = authedOs.listPolicyPackRevisions
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		const source = await getPolicyPackById(context.db, input.id);
		assertReadableControlPlaneRecord(context, source, "Policy pack not found");
		return { data: await listPolicyPackRevisions(context.db, input.id) };
	});

const publishPolicyPackRevisionProcedure = authedOs.publishPolicyPackRevision
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		const existing = await getPolicyPackById(context.db, input.id);
		assertOwnedControlPlaneRecord(context, existing, "Policy pack not found");
		return unwrapRevision(
			await publishPolicyPackRevision(context.db, {
				revisionId: input.id,
				expectedVersion: input.expectedVersion,
				changeSummary: input.changeSummary,
				publishedBy: publishedBy(context),
				name: input.name,
				description: input.description,
				definition: input.definition as PolicyPackDefinition | undefined,
				status: input.status,
			}),
			"Policy pack not found",
		);
	});

const diffPolicyPackRevisionsProcedure = authedOs.diffPolicyPackRevisions
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		const [from, to] = await Promise.all([
			getPolicyPackById(context.db, input.id),
			getPolicyPackById(context.db, input.otherId),
		]);
		assertReadableControlPlaneRecord(context, from, "Policy pack not found");
		assertReadableControlPlaneRecord(context, to, "Policy pack not found");
		if (
			from.scope !== to.scope ||
			from.slug !== to.slug ||
			from.organizationId !== to.organizationId
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Revisions do not belong to the same policy pack",
			);
		}
		return {
			fromRevisionId: from.id,
			toRevisionId: to.id,
			changes: diffControlPlaneJson(from.definition, to.definition),
		};
	});

const rollbackPolicyPackRevisionProcedure = authedOs.rollbackPolicyPackRevision
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		const organizationId = await assertOwnedTedi(context, input.tediId);
		const [current, target] = await Promise.all([
			getPolicyPackById(context.db, input.id),
			getPolicyPackById(context.db, input.targetRevisionId),
		]);
		assertOwnedControlPlaneRecord(context, current, "Policy pack not found");
		assertOwnedControlPlaneRecord(context, target, "Policy pack not found");
		return unwrapRevision(
			await rollbackPolicyPackRevision(context.db, {
				organizationId,
				tediId: input.tediId,
				currentRevisionId: input.id,
				targetRevisionId: input.targetRevisionId,
				expectedVersion: input.expectedVersion,
				changeSummary: input.changeSummary,
				publishedBy: publishedBy(context),
			}),
			"Policy pack not found",
		);
	});

const deletePolicyPackProcedure = authedOs.deletePolicyPack
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		const existing = await getPolicyPackById(context.db, input.id);
		assertOwnedControlPlaneRecord(context, existing, "Policy pack not found");
		unwrapRevision(
			await publishPolicyPackRevision(context.db, {
				revisionId: input.id,
				status: "archived",
				changeSummary: "Archived definition",
				publishedBy: publishedBy(context),
			}),
			"Policy pack not found",
		);
		return { success: true as const };
	});

// =============================================================================
// WORKSPACE TEMPLATE SETS
// =============================================================================

const listWorkspaceTemplateSetsProcedure = authedOs.listWorkspaceTemplateSets
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const sets = await listWorkspaceTemplateSets(context.db, {
			organizationId: input.organizationId ?? orgId,
			includeSystem: input.includeSystem,
		});
		return { data: sets };
	});

const getWorkspaceTemplateSetProcedure = authedOs.getWorkspaceTemplateSet
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		const set = await getWorkspaceTemplateSetById(context.db, input.id);
		assertReadableControlPlaneRecord(
			context,
			set,
			"Workspace template set not found",
		);
		return set;
	});

const createWorkspaceTemplateSetProcedure = authedOs.createWorkspaceTemplateSet
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (input.organizationId && input.organizationId !== orgId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot create workspace template set attributed to another organization",
			);
		}
		const set = await createWorkspaceTemplateSet(context.db, {
			name: input.name,
			slug: input.slug,
			description: input.description ?? null,
			scope: resolveCreateScope(context, input.scope),
			templates: input.templates as WorkspaceTemplateSetDefinition,
			organizationId: input.organizationId ?? orgId,
			publishedBy: publishedBy(context),
			changeSummary: "Initial revision",
		});
		return set;
	});

const listWorkspaceTemplateSetRevisionsProcedure =
	authedOs.listWorkspaceTemplateSetRevisions
		.use(AUTHZ.settingsRead)
		.handler(async ({ input, context }) => {
			requireOrgId(context);
			const source = await getWorkspaceTemplateSetById(context.db, input.id);
			assertReadableControlPlaneRecord(
				context,
				source,
				"Workspace template set not found",
			);
			return {
				data: await listWorkspaceTemplateSetRevisions(context.db, input.id),
			};
		});

const publishWorkspaceTemplateSetRevisionProcedure =
	authedOs.publishWorkspaceTemplateSetRevision
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			requireOrgId(context);
			const existing = await getWorkspaceTemplateSetById(context.db, input.id);
			assertOwnedControlPlaneRecord(
				context,
				existing,
				"Workspace template set not found",
			);
			return unwrapRevision(
				await publishWorkspaceTemplateSetRevision(context.db, {
					revisionId: input.id,
					expectedVersion: input.expectedVersion,
					changeSummary: input.changeSummary,
					publishedBy: publishedBy(context),
					name: input.name,
					description: input.description,
					templates: input.templates as
						| WorkspaceTemplateSetDefinition
						| undefined,
					status: input.status,
				}),
				"Workspace template set not found",
			);
		});

const diffWorkspaceTemplateSetRevisionsProcedure =
	authedOs.diffWorkspaceTemplateSetRevisions
		.use(AUTHZ.settingsRead)
		.handler(async ({ input, context }) => {
			requireOrgId(context);
			const [from, to] = await Promise.all([
				getWorkspaceTemplateSetById(context.db, input.id),
				getWorkspaceTemplateSetById(context.db, input.otherId),
			]);
			assertReadableControlPlaneRecord(
				context,
				from,
				"Workspace template set not found",
			);
			assertReadableControlPlaneRecord(
				context,
				to,
				"Workspace template set not found",
			);
			if (
				from.scope !== to.scope ||
				from.slug !== to.slug ||
				from.organizationId !== to.organizationId
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Revisions do not belong to the same workspace template set",
				);
			}
			return {
				fromRevisionId: from.id,
				toRevisionId: to.id,
				changes: diffControlPlaneJson(from.templates, to.templates),
			};
		});

const rollbackWorkspaceTemplateSetRevisionProcedure =
	authedOs.rollbackWorkspaceTemplateSetRevision
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = await assertOwnedTedi(context, input.tediId);
			const [current, target] = await Promise.all([
				getWorkspaceTemplateSetById(context.db, input.id),
				getWorkspaceTemplateSetById(context.db, input.targetRevisionId),
			]);
			assertOwnedControlPlaneRecord(
				context,
				current,
				"Workspace template set not found",
			);
			assertOwnedControlPlaneRecord(
				context,
				target,
				"Workspace template set not found",
			);
			return unwrapRevision(
				await rollbackWorkspaceTemplateSetRevision(context.db, {
					organizationId,
					tediId: input.tediId,
					currentRevisionId: input.id,
					targetRevisionId: input.targetRevisionId,
					expectedVersion: input.expectedVersion,
					changeSummary: input.changeSummary,
					publishedBy: publishedBy(context),
				}),
				"Workspace template set not found",
			);
		});

const deleteWorkspaceTemplateSetProcedure = authedOs.deleteWorkspaceTemplateSet
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		requireOrgId(context);
		const existing = await getWorkspaceTemplateSetById(context.db, input.id);
		assertOwnedControlPlaneRecord(
			context,
			existing,
			"Workspace template set not found",
		);
		unwrapRevision(
			await publishWorkspaceTemplateSetRevision(context.db, {
				revisionId: input.id,
				status: "archived",
				changeSummary: "Archived definition",
				publishedBy: publishedBy(context),
			}),
			"Workspace template set not found",
		);
		return { success: true as const };
	});

// =============================================================================
// EFFECTIVE CONFIG RESOLUTION
// =============================================================================

const listTediControlPlaneBindingHistoryProcedure =
	authedOs.listTediControlPlaneBindingHistory
		.use(AUTHZ.settingsRead)
		.handler(async ({ input, context }) => {
			const organizationId = await assertOwnedTedi(context, input.tediId);
			return {
				data: await listTediControlPlaneBindingHistory(context.db, {
					organizationId,
					tediId: input.tediId,
				}),
			};
		});

const getEffectiveAppConfigProcedure = authedOs.getEffectiveAppConfig
	.use(AUTHZ.settingsRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const config = await getEffectiveActiveAppConfig(
			context.db,
			input.appId,
			orgId,
		);
		if (!config) {
			throw createError(ErrorCodes.NOT_FOUND, "App not found");
		}
		return config;
	});

// =============================================================================
// ROUTER EXPORT
// =============================================================================

export const controlPlaneContractRouter = controlPlaneOs.router({
	getDescopeRbacDrift: getDescopeRbacDriftProcedure,
	listPlatformCronHealth: listPlatformCronHealthProcedure,
	listRuntimeProfiles: listRuntimeProfilesProcedure,
	getRuntimeProfile: getRuntimeProfileProcedure,
	createRuntimeProfile: createRuntimeProfileProcedure,
	listRuntimeProfileRevisions: listRuntimeProfileRevisionsProcedure,
	publishRuntimeProfileRevision: publishRuntimeProfileRevisionProcedure,
	diffRuntimeProfileRevisions: diffRuntimeProfileRevisionsProcedure,
	rollbackRuntimeProfileRevision: rollbackRuntimeProfileRevisionProcedure,
	deleteRuntimeProfile: deleteRuntimeProfileProcedure,
	listPolicyPacks: listPolicyPacksProcedure,
	getPolicyPack: getPolicyPackProcedure,
	createPolicyPack: createPolicyPackProcedure,
	listPolicyPackRevisions: listPolicyPackRevisionsProcedure,
	publishPolicyPackRevision: publishPolicyPackRevisionProcedure,
	activatePolicyPackRevision: activatePolicyPackRevisionProcedure,
	diffPolicyPackRevisions: diffPolicyPackRevisionsProcedure,
	rollbackPolicyPackRevision: rollbackPolicyPackRevisionProcedure,
	deletePolicyPack: deletePolicyPackProcedure,
	listWorkspaceTemplateSets: listWorkspaceTemplateSetsProcedure,
	getWorkspaceTemplateSet: getWorkspaceTemplateSetProcedure,
	createWorkspaceTemplateSet: createWorkspaceTemplateSetProcedure,
	listWorkspaceTemplateSetRevisions: listWorkspaceTemplateSetRevisionsProcedure,
	publishWorkspaceTemplateSetRevision:
		publishWorkspaceTemplateSetRevisionProcedure,
	diffWorkspaceTemplateSetRevisions: diffWorkspaceTemplateSetRevisionsProcedure,
	rollbackWorkspaceTemplateSetRevision:
		rollbackWorkspaceTemplateSetRevisionProcedure,
	deleteWorkspaceTemplateSet: deleteWorkspaceTemplateSetProcedure,
	listTediControlPlaneBindingHistory:
		listTediControlPlaneBindingHistoryProcedure,
	getEffectiveAppConfig: getEffectiveAppConfigProcedure,
});
