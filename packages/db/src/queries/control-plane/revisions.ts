import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { tediControlPlaneBindingHistory } from "../../schema/control-plane-history";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../../schema/control-plane";
import type {
	ControlPlaneStatus,
	PolicyPack,
	PolicyPackDefinition,
	RuntimeProfile,
	RuntimeProfileConfig,
	WorkspaceTemplateSet,
	WorkspaceTemplateSetDefinition,
} from "../../schema/control-plane";
import { tedis } from "../../schema/tedis";

export type ControlPlaneRevisionFailureReason =
	| "not_found"
	| "revision_conflict"
	| "family_mismatch"
	| "tedi_binding_conflict";

export type PublishControlPlaneRevisionResult<T> =
	| { ok: true; revision: T }
	| { ok: false; reason: ControlPlaneRevisionFailureReason };

interface RevisionMetadata {
	expectedVersion?: number;
	changeSummary?: string | null;
	publishedBy?: string | null;
	status?: ControlPlaneStatus;
	rollbackOfRevisionId?: string | null;
}

function sameFamily(
	left: { scope: string; slug: string; organizationId: string | null },
	right: { scope: string; slug: string; organizationId: string | null },
): boolean {
	return (
		left.scope === right.scope &&
		left.slug === right.slug &&
		left.organizationId === right.organizationId
	);
}

function organizationCondition<TColumn>(
	column: TColumn,
	organizationId: string | null,
) {
	return organizationId === null
		? isNull(column as Parameters<typeof isNull>[0])
		: eq(column as Parameters<typeof eq>[0], organizationId as never);
}

export async function listRuntimeProfileRevisions(
	db: DbClient,
	revisionId: string,
): Promise<RuntimeProfile[]> {
	const source = await db.query.runtimeProfiles.findFirst({
		where: { id: revisionId },
	});
	if (!source) return [];
	return db
		.select()
		.from(runtimeProfiles)
		.where(
			and(
				eq(runtimeProfiles.scope, source.scope),
				eq(runtimeProfiles.slug, source.slug),
				organizationCondition(
					runtimeProfiles.organizationId,
					source.organizationId,
				),
			),
		)
		.orderBy(desc(runtimeProfiles.version));
}

export async function publishRuntimeProfileRevision(
	db: DbClient,
	input: RevisionMetadata & {
		revisionId: string;
		name?: string;
		description?: string | null;
		config?: RuntimeProfileConfig;
	},
): Promise<PublishControlPlaneRevisionResult<RuntimeProfile>> {
	const source = await db.query.runtimeProfiles.findFirst({
		where: { id: input.revisionId },
	});
	if (!source) return { ok: false, reason: "not_found" };
	if (
		input.expectedVersion !== undefined &&
		input.expectedVersion !== source.version
	) {
		return { ok: false, reason: "revision_conflict" };
	}
	const now = new Date().toISOString();
	const nextId = crypto.randomUUID();
	const currentMax = sql<number>`(select max(version) from runtime_profiles where scope = ${source.scope} and slug = ${source.slug})`;
	const inserted = await db
		.insert(runtimeProfiles)
		.select(
			db
				.select({
					id: sql<string>`${nextId}`.as("id"),
					organizationId: runtimeProfiles.organizationId,
					name: sql<string>`${input.name ?? source.name}`.as("name"),
					slug: runtimeProfiles.slug,
					description: sql<
						string | null
					>`${input.description === undefined ? source.description : input.description}`.as(
						"description",
					),
					scope: runtimeProfiles.scope,
					status: sql<ControlPlaneStatus>`${input.status ?? source.status}`.as(
						"status",
					),
					version: sql<number>`${runtimeProfiles.version} + 1`.as("version"),
					supersedesRevisionId: runtimeProfiles.id,
					rollbackOfRevisionId: sql<
						string | null
					>`${input.rollbackOfRevisionId ?? null}`.as(
						"rollback_of_revision_id",
					),
					changeSummary: sql<string | null>`${input.changeSummary ?? null}`.as(
						"change_summary",
					),
					publishedAt: sql<string>`${now}`.as("published_at"),
					publishedBy: sql<string | null>`${input.publishedBy ?? null}`.as(
						"published_by",
					),
					config:
						sql<string>`${JSON.stringify(input.config ?? source.config)}`.as(
							"config",
						),
					createdAt: sql<string>`${now}`.as("created_at"),
					updatedAt: sql<string>`${now}`.as("updated_at"),
				})
				.from(runtimeProfiles)
				.where(
					and(
						eq(runtimeProfiles.id, source.id),
						sql`${runtimeProfiles.version} = ${currentMax}`,
					),
				),
		)
		.returning();
	const revision = inserted[0];
	return revision
		? { ok: true, revision }
		: { ok: false, reason: "revision_conflict" };
}

export async function listPolicyPackRevisions(
	db: DbClient,
	revisionId: string,
): Promise<PolicyPack[]> {
	const source = await db.query.policyPacks.findFirst({
		where: { id: revisionId },
	});
	if (!source) return [];
	return db
		.select()
		.from(policyPacks)
		.where(
			and(
				eq(policyPacks.scope, source.scope),
				eq(policyPacks.slug, source.slug),
				organizationCondition(
					policyPacks.organizationId,
					source.organizationId,
				),
			),
		)
		.orderBy(desc(policyPacks.version));
}

export async function publishPolicyPackRevision(
	db: DbClient,
	input: RevisionMetadata & {
		revisionId: string;
		name?: string;
		description?: string | null;
		definition?: PolicyPackDefinition;
	},
): Promise<PublishControlPlaneRevisionResult<PolicyPack>> {
	const source = await db.query.policyPacks.findFirst({
		where: { id: input.revisionId },
	});
	if (!source) return { ok: false, reason: "not_found" };
	if (
		input.expectedVersion !== undefined &&
		input.expectedVersion !== source.version
	) {
		return { ok: false, reason: "revision_conflict" };
	}
	const now = new Date().toISOString();
	const nextId = crypto.randomUUID();
	const currentMax = sql<number>`(select max(version) from policy_packs where scope = ${source.scope} and slug = ${source.slug})`;
	const inserted = await db
		.insert(policyPacks)
		.select(
			db
				.select({
					id: sql<string>`${nextId}`.as("id"),
					organizationId: policyPacks.organizationId,
					name: sql<string>`${input.name ?? source.name}`.as("name"),
					slug: policyPacks.slug,
					description: sql<
						string | null
					>`${input.description === undefined ? source.description : input.description}`.as(
						"description",
					),
					scope: policyPacks.scope,
					target: policyPacks.target,
					status: sql<ControlPlaneStatus>`${input.status ?? source.status}`.as(
						"status",
					),
					version: sql<number>`${policyPacks.version} + 1`.as("version"),
					supersedesRevisionId: policyPacks.id,
					rollbackOfRevisionId: sql<
						string | null
					>`${input.rollbackOfRevisionId ?? null}`.as(
						"rollback_of_revision_id",
					),
					changeSummary: sql<string | null>`${input.changeSummary ?? null}`.as(
						"change_summary",
					),
					publishedAt: sql<string>`${now}`.as("published_at"),
					publishedBy: sql<string | null>`${input.publishedBy ?? null}`.as(
						"published_by",
					),
					definition:
						sql<string>`${JSON.stringify(input.definition ?? source.definition)}`.as(
							"definition",
						),
					createdAt: sql<string>`${now}`.as("created_at"),
					updatedAt: sql<string>`${now}`.as("updated_at"),
				})
				.from(policyPacks)
				.where(
					and(
						eq(policyPacks.id, source.id),
						sql`${policyPacks.version} = ${currentMax}`,
					),
				),
		)
		.returning();
	const revision = inserted[0];
	return revision
		? { ok: true, revision }
		: { ok: false, reason: "revision_conflict" };
}

export async function listWorkspaceTemplateSetRevisions(
	db: DbClient,
	revisionId: string,
): Promise<WorkspaceTemplateSet[]> {
	const source = await db.query.workspaceTemplateSets.findFirst({
		where: { id: revisionId },
	});
	if (!source) return [];
	return db
		.select()
		.from(workspaceTemplateSets)
		.where(
			and(
				eq(workspaceTemplateSets.scope, source.scope),
				eq(workspaceTemplateSets.slug, source.slug),
				organizationCondition(
					workspaceTemplateSets.organizationId,
					source.organizationId,
				),
			),
		)
		.orderBy(desc(workspaceTemplateSets.version));
}

export async function publishWorkspaceTemplateSetRevision(
	db: DbClient,
	input: RevisionMetadata & {
		revisionId: string;
		name?: string;
		description?: string | null;
		templates?: WorkspaceTemplateSetDefinition;
	},
): Promise<PublishControlPlaneRevisionResult<WorkspaceTemplateSet>> {
	const source = await db.query.workspaceTemplateSets.findFirst({
		where: { id: input.revisionId },
	});
	if (!source) return { ok: false, reason: "not_found" };
	if (
		input.expectedVersion !== undefined &&
		input.expectedVersion !== source.version
	) {
		return { ok: false, reason: "revision_conflict" };
	}
	const now = new Date().toISOString();
	const nextId = crypto.randomUUID();
	const currentMax = sql<number>`(select max(version) from workspace_template_sets where scope = ${source.scope} and slug = ${source.slug})`;
	const inserted = await db
		.insert(workspaceTemplateSets)
		.select(
			db
				.select({
					id: sql<string>`${nextId}`.as("id"),
					organizationId: workspaceTemplateSets.organizationId,
					name: sql<string>`${input.name ?? source.name}`.as("name"),
					slug: workspaceTemplateSets.slug,
					description: sql<
						string | null
					>`${input.description === undefined ? source.description : input.description}`.as(
						"description",
					),
					scope: workspaceTemplateSets.scope,
					status: sql<ControlPlaneStatus>`${input.status ?? source.status}`.as(
						"status",
					),
					version: sql<number>`${workspaceTemplateSets.version} + 1`.as(
						"version",
					),
					supersedesRevisionId: workspaceTemplateSets.id,
					rollbackOfRevisionId: sql<
						string | null
					>`${input.rollbackOfRevisionId ?? null}`.as(
						"rollback_of_revision_id",
					),
					changeSummary: sql<string | null>`${input.changeSummary ?? null}`.as(
						"change_summary",
					),
					publishedAt: sql<string>`${now}`.as("published_at"),
					publishedBy: sql<string | null>`${input.publishedBy ?? null}`.as(
						"published_by",
					),
					templates:
						sql<string>`${JSON.stringify(input.templates ?? source.templates)}`.as(
							"templates",
						),
					createdAt: sql<string>`${now}`.as("created_at"),
					updatedAt: sql<string>`${now}`.as("updated_at"),
				})
				.from(workspaceTemplateSets)
				.where(
					and(
						eq(workspaceTemplateSets.id, source.id),
						sql`${workspaceTemplateSets.version} = ${currentMax}`,
					),
				),
		)
		.returning();
	const revision = inserted[0];
	return revision
		? { ok: true, revision }
		: { ok: false, reason: "revision_conflict" };
}

export async function rebindTediControlPlaneRevision(
	db: DbClient,
	params: {
		organizationId: string;
		tediId: string;
		kind: "runtime_profile" | "policy_pack" | "workspace_template_set";
		expectedRevisionId: string | null;
		revisionId: string;
		changedBy?: string | null;
		changeReason?: string | null;
	},
): Promise<boolean> {
	const column =
		params.kind === "runtime_profile"
			? tedis.runtimeProfileId
			: params.kind === "policy_pack"
				? tedis.policyPackId
				: tedis.workspaceTemplateSetId;
	const field =
		params.kind === "runtime_profile"
			? { runtimeProfileId: params.revisionId }
			: params.kind === "policy_pack"
				? { policyPackId: params.revisionId }
				: { workspaceTemplateSetId: params.revisionId };
	const now = new Date().toISOString();
	const updateBinding = db
		.update(tedis)
		.set({ ...field, updatedAt: now })
		.where(
			and(
				eq(tedis.id, params.tediId),
				eq(tedis.organizationId, params.organizationId),
				params.expectedRevisionId === null
					? isNull(column)
					: eq(column, params.expectedRevisionId),
			),
		)
		.returning({ id: tedis.id });
	const recordHistory = db
		.insert(tediControlPlaneBindingHistory)
		.select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					organizationId: tedis.organizationId,
					tediId: tedis.id,
					kind: sql<typeof params.kind>`${params.kind}`.as("kind"),
					previousRevisionId: sql<
						string | null
					>`${params.expectedRevisionId}`.as("previous_revision_id"),
					revisionId: sql<string>`${params.revisionId}`.as("revision_id"),
					changedBy: sql<string | null>`${params.changedBy ?? null}`.as(
						"changed_by",
					),
					changeReason: sql<string | null>`${params.changeReason ?? null}`.as(
						"change_reason",
					),
					effectiveAt: sql<string>`${now}`.as("effective_at"),
				})
				.from(tedis)
				.where(
					and(
						eq(tedis.id, params.tediId),
						eq(tedis.organizationId, params.organizationId),
						eq(column, params.revisionId),
						sql`changes() = 1`,
					),
				),
		)
		.returning({ id: tediControlPlaneBindingHistory.id });
	const [updated, history] = await db.batch([updateBinding, recordHistory]);
	return updated.length === 1 && history.length === 1;
}

export async function listTediControlPlaneBindingHistory(
	db: DbClient,
	params: { organizationId: string; tediId: string },
) {
	return db
		.select()
		.from(tediControlPlaneBindingHistory)
		.where(
			and(
				eq(
					tediControlPlaneBindingHistory.organizationId,
					params.organizationId,
				),
				eq(tediControlPlaneBindingHistory.tediId, params.tediId),
			),
		)
		.orderBy(desc(tediControlPlaneBindingHistory.effectiveAt));
}

export async function rollbackRuntimeProfileRevision(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		currentRevisionId: string;
		targetRevisionId: string;
		expectedVersion?: number;
		changeSummary?: string | null;
		publishedBy?: string | null;
	},
): Promise<PublishControlPlaneRevisionResult<RuntimeProfile>> {
	const [current, target] = await Promise.all([
		db.query.runtimeProfiles.findFirst({
			where: { id: input.currentRevisionId },
		}),
		db.query.runtimeProfiles.findFirst({
			where: { id: input.targetRevisionId },
		}),
	]);
	if (!current || !target) return { ok: false, reason: "not_found" };
	if (!sameFamily(current, target))
		return { ok: false, reason: "family_mismatch" };
	const published = await publishRuntimeProfileRevision(db, {
		revisionId: current.id,
		expectedVersion: input.expectedVersion,
		name: target.name,
		description: target.description,
		config: target.config,
		status: "active",
		rollbackOfRevisionId: target.id,
		changeSummary:
			input.changeSummary ?? `Rollback to revision ${target.version}`,
		publishedBy: input.publishedBy,
	});
	if (!published.ok) return published;
	const rebound = await rebindTediControlPlaneRevision(db, {
		organizationId: input.organizationId,
		tediId: input.tediId,
		kind: "runtime_profile",
		expectedRevisionId: current.id,
		revisionId: published.revision.id,
		changedBy: input.publishedBy,
		changeReason: published.revision.changeSummary,
	});
	return rebound ? published : { ok: false, reason: "tedi_binding_conflict" };
}

export async function rollbackPolicyPackRevision(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		currentRevisionId: string;
		targetRevisionId: string;
		expectedVersion?: number;
		changeSummary?: string | null;
		publishedBy?: string | null;
	},
): Promise<PublishControlPlaneRevisionResult<PolicyPack>> {
	const [current, target] = await Promise.all([
		db.query.policyPacks.findFirst({ where: { id: input.currentRevisionId } }),
		db.query.policyPacks.findFirst({ where: { id: input.targetRevisionId } }),
	]);
	if (!current || !target) return { ok: false, reason: "not_found" };
	if (!sameFamily(current, target))
		return { ok: false, reason: "family_mismatch" };
	const published = await publishPolicyPackRevision(db, {
		revisionId: current.id,
		expectedVersion: input.expectedVersion,
		name: target.name,
		description: target.description,
		definition: target.definition,
		status: "active",
		rollbackOfRevisionId: target.id,
		changeSummary:
			input.changeSummary ?? `Rollback to revision ${target.version}`,
		publishedBy: input.publishedBy,
	});
	if (!published.ok) return published;
	const rebound = await rebindTediControlPlaneRevision(db, {
		organizationId: input.organizationId,
		tediId: input.tediId,
		kind: "policy_pack",
		expectedRevisionId: current.id,
		revisionId: published.revision.id,
		changedBy: input.publishedBy,
		changeReason: published.revision.changeSummary,
	});
	return rebound ? published : { ok: false, reason: "tedi_binding_conflict" };
}

export async function rollbackWorkspaceTemplateSetRevision(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		currentRevisionId: string;
		targetRevisionId: string;
		expectedVersion?: number;
		changeSummary?: string | null;
		publishedBy?: string | null;
	},
): Promise<PublishControlPlaneRevisionResult<WorkspaceTemplateSet>> {
	const [current, target] = await Promise.all([
		db.query.workspaceTemplateSets.findFirst({
			where: { id: input.currentRevisionId },
		}),
		db.query.workspaceTemplateSets.findFirst({
			where: { id: input.targetRevisionId },
		}),
	]);
	if (!current || !target) return { ok: false, reason: "not_found" };
	if (!sameFamily(current, target))
		return { ok: false, reason: "family_mismatch" };
	const published = await publishWorkspaceTemplateSetRevision(db, {
		revisionId: current.id,
		expectedVersion: input.expectedVersion,
		name: target.name,
		description: target.description,
		templates: target.templates,
		status: "active",
		rollbackOfRevisionId: target.id,
		changeSummary:
			input.changeSummary ?? `Rollback to revision ${target.version}`,
		publishedBy: input.publishedBy,
	});
	if (!published.ok) return published;
	const rebound = await rebindTediControlPlaneRevision(db, {
		organizationId: input.organizationId,
		tediId: input.tediId,
		kind: "workspace_template_set",
		expectedRevisionId: current.id,
		revisionId: published.revision.id,
		changedBy: input.publishedBy,
		changeReason: published.revision.changeSummary,
	});
	return rebound ? published : { ok: false, reason: "tedi_binding_conflict" };
}
