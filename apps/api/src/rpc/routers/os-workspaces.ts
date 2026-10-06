import { getPersonalResourceDelegation } from "@tedix/db/queries/personal-resource-delegations";
import {
	personalDelegationSource,
	validatePersonalRunSources,
} from "../../services/personal-resource-delegation-authority";
import { ORPCError, implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type OsBlueprintDefinition,
	type OsDerivedResourceAccess,
	type OsBlueprintPreflight,
	type OsBlueprintResourceBinding,
	type OsBlueprintUpgradeReport,
	type OsWorkspaceBlueprintDecision,
	OsBlueprintDefinitionSchema,
	OsDerivedAccessEnvelopeSchema,
	OsGadgetManifestSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { WorkItemExecutionPreflight } from "@tedix/api-contract/schemas/work-items";
import { createApprovalRequest } from "@tedix/db/queries/approvals";
import {
	createOsBlueprint,
	createOsBlueprintRevision,
	getCatalogOsBlueprint,
	getOsBlueprint,
	getOsBlueprintRevision,
	importOsBlueprint,
	listCatalogOsBlueprints,
	listOsBlueprintRevisions,
	listOsBlueprints,
	publishOsBlueprintRevision,
	setOsBlueprintVisibility,
} from "@tedix/db/queries/os-workspaces/blueprints";
import {
	applyOsBlueprintUpgrade,
	type OsBlueprintUpgradeGadgetInsert,
	type OsBlueprintUpgradeGadgetSync,
	recordOsWorkspaceBlueprintDecision,
} from "@tedix/db/queries/os-workspaces/upgrade";
import { getOrganizationDisplayName } from "@tedix/db/queries/organizations";
import { getRunArtifact } from "@tedix/db/queries/skill-run-artifacts";
import {
	createOsGadgetExecution,
	getOsGadgetExecution,
	listOsGadgetExecutions,
	settleOsGadgetExecutionFromRun,
} from "@tedix/db/queries/os-workspaces/executions";
import {
	getSkillRun,
	type SkillRunRuntimeEnvironment,
} from "@tedix/db/queries/skill-runs";
import { getTediOrganizationId } from "@tedix/db/queries/tedis";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import {
	createOsGadget,
	createOsGadgetRevision,
	getOsGadget,
	getOsGadgetRevision,
	listOsGadgetRevisions,
	listOsGadgets,
	updateOsGadget,
} from "@tedix/db/queries/os-workspaces/gadgets";
import { instantiateOsBlueprint } from "@tedix/db/queries/os-workspaces/instantiate";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import type {
	NewOsGadgetExecutionRow,
	OsBlueprintRevisionRow,
	OsBlueprintRow,
	OsGadgetExecutionRow,
	OsWorkspaceRow,
} from "@tedix/db/schema/os-workspaces";
import { canonicalDigest, canonicalJson } from "../../lib/blueprint-digest";
import { extractMediaBytes, signMediaUrl } from "../../lib/skill-media-url";
import { untrustedContentBaseUrl } from "../../lib/untrusted-origin";
import { resolveOsBlueprintPreflight } from "../../services/os-blueprint-preflight";
import {
	buildForkLineage,
	buildOsBlueprintExport,
	parseBlueprintLineage,
	verifyOsBlueprintExport,
} from "../../services/os-blueprint-portability";
import {
	resolveOsBlueprintUpgradeReport,
	summarizeOsBlueprintUpgradeReport,
} from "../../services/os-blueprint-upgrade";
import {
	authorizeGadgetInference,
	dispatchGovernedGadgetExecution,
	dispatchedReceiptStatus,
	gadgetPreflightSubject,
	resolveGadgetExecutable,
} from "../../services/os-gadget-approval-settlement";
import { resolveWorkItemExecutionPreflight } from "../../services/work-item-execution-preflight";
import { resolveWorkspaceResourceAvailability } from "../../services/os-workspace-resource-availability";
import * as collaborationProcedures from "./os-workspace-collaboration";
import * as workspaceLibrary from "./os-workspace-library";
import * as workspaceResources from "./os-workspace-resources";
import * as workspaceWork from "./os-workspace-work";
import * as outputProcedures from "./os-workspace-outputs";
import * as resourceLifecycle from "./os-resource-lifecycle";
import {
	mapBlueprint,
	mapBlueprintRevision,
	mapGadget,
	mapGadgetExecution,
	mapGadgetRevision,
	mapWorkspace,
	parseInstantiationPreflight,
	queryDb,
	rethrowNameConflict,
	requireBlueprint,
	requireGadget,
	requireWorkspace,
	isUniqueConstraintError,
	uniqueConstraintTable,
	revisionConflict,
	resolveCreator,
} from "./os-workspaces-shared";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";

export { resolveCreator } from "./os-workspaces-shared";

const osWorkspacesOs = implement(osWorkspacesContract).$context<BaseContext>();
const authed = osWorkspacesOs.use(withAuth).use(osAudit(OS_WORKSPACES_AUDIT));
// The OS workspace domain is tenant infrastructure, guarded per verb on
// the least-privilege os:* taxonomy (settings:manage remains sufficient for
// every verb) plus the apps:read / apps:write machine scopes.
const readOs = authed.use(AUTHZ.osRead);
const authorOs = authed.use(AUTHZ.osAuthor);
const runOs = authed.use(AUTHZ.osRun);
const publishOs = authed.use(AUTHZ.osPublish);

const gadgetsList = readOs.gadgets.list.handler(async ({ input, context }) => {
	const workspace = await requireWorkspace(context, input.workspaceId);
	const rows = await listOsGadgets(queryDb(context), workspace.organizationId, {
		workspaceId: workspace.id,
		status: input.status,
		limit: input.limit + 1,
	});
	return {
		items: rows.slice(0, input.limit).map(mapGadget),
		truncated: rows.length > input.limit,
	};
});

const gadgetsCreate = authorOs.gadgets.create.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const creator = resolveCreator(context);
		const now = new Date().toISOString();
		try {
			const row = await createOsGadget(queryDb(context), {
				id: crypto.randomUUID(),
				organizationId: workspace.organizationId,
				workspaceId: workspace.id,
				name: input.name,
				description: input.description ?? null,
				status: "active",
				currentRevisionId: null,
				createdByKind: creator.kind,
				createdById: creator.id,
				createdAt: now,
				updatedAt: now,
			});
			return { gadget: mapGadget(row) };
		} catch (error) {
			rethrowNameConflict(
				error,
				"A gadget with this name already exists in the workspace",
			);
		}
	},
);

const gadgetsGet = readOs.gadgets.get.handler(async ({ input, context }) => {
	const gadget = await requireGadget(
		context,
		input.workspaceId,
		input.gadgetId,
	);
	const currentRevision = gadget.currentRevisionId
		? await getOsGadgetRevision(queryDb(context), {
				organizationId: gadget.organizationId,
				revisionId: gadget.currentRevisionId,
			})
		: undefined;
	return {
		gadget: mapGadget(gadget),
		currentRevision: currentRevision
			? mapGadgetRevision(currentRevision)
			: null,
	};
});

const gadgetsRevise = authorOs.gadgets.revise.handler(
	async ({ input, context }) => {
		const gadget = await requireGadget(
			context,
			input.workspaceId,
			input.gadgetId,
		);
		const creator = resolveCreator(context);
		const db = queryDb(context);
		const revisionId = crypto.randomUUID();
		const result = await createOsGadgetRevision(db, {
			id: revisionId,
			organizationId: gadget.organizationId,
			gadgetId: gadget.id,
			manifest: JSON.stringify(input.manifest),
			sourceArtifactRef: input.sourceArtifactRef ?? null,
			createdByKind: creator.kind,
			createdById: creator.id,
			expectedRevision: input.expectedRevision,
		});
		if (!result.ok) {
			if (result.reason === "gadget_not_found") {
				throw createError(ErrorCodes.NOT_FOUND, "OS gadget not found");
			}
			const [latest] = await listOsGadgetRevisions(
				db,
				{ organizationId: gadget.organizationId, gadgetId: gadget.id },
				{ limit: 1 },
			);
			throw revisionConflict(
				"Gadget",
				input.expectedRevision ?? 0,
				latest?.revision ?? null,
			);
		}
		const advanced = await getOsGadget(db, {
			organizationId: gadget.organizationId,
			gadgetId: gadget.id,
		});
		return {
			gadget: mapGadget(advanced ?? gadget),
			revision: mapGadgetRevision(result.revision),
		};
	},
);

const gadgetsArchive = authorOs.gadgets.archive.handler(
	async ({ input, context }) => {
		const gadget = await requireGadget(
			context,
			input.workspaceId,
			input.gadgetId,
		);
		const row = await updateOsGadget(
			queryDb(context),
			{ organizationId: gadget.organizationId, gadgetId: gadget.id },
			{ status: "archived" },
		);
		if (!row) {
			throw createError(ErrorCodes.NOT_FOUND, "OS gadget not found");
		}
		return { gadget: mapGadget(row) };
	},
);

// =============================================================================
// GOVERNED GADGET EXECUTION — dispatch through skill-runtime
// =============================================================================

/**
 * Deterministic execution id for a caller idempotency key, mirroring
 * skill-runtime's `deriveIdempotentRunId` (SHA-256 → UUID-shaped, version 8):
 * the execution id IS the dispatched run id, so a duplicate key derives the
 * same receipt identity here and the same run identity in the runtime.
 */
async function deriveGadgetExecutionId(input: {
	orgId: string;
	gadgetId: string;
	runtimeEnvironment: string;
	approvalMode: "policy" | "required";
	idempotencyKey: string;
}): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			[
				"os-gadget-execution",
				input.orgId,
				input.gadgetId,
				`runtime-environment:${input.runtimeEnvironment}`,
				`approval-mode:${input.approvalMode}`,
				input.idempotencyKey,
			].join("\0"),
		),
	);
	const bytes = new Uint8Array(digest).slice(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The template's owned-tedi guard: the tedi must live in the caller's organization. */
async function requireOwnedTedi(
	context: BaseContext,
	tediId: string,
	organizationId: string,
): Promise<void> {
	const tediOrganizationId = await getTediOrganizationId(context.db, tediId);
	if (tediOrganizationId !== organizationId) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}
}

/**
 * Park a governed run for human approval as a REAL approval card.
 *
 * The shared approval Workflow is the durable continuation owner. A resolver
 * only flips the D1 approval latch and signals that Workflow; the Workflow
 * rechecks policy and budget, claims this exact receipt, and resumes it without
 * a second browser or API action.
 */
async function parkGadgetApproval(
	context: BaseContext,
	params: {
		executionId: string;
		orgId: string;
		tediId: string;
		gadgetId: string;
		gadgetName: string;
		skillSlug: string;
	},
): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date();
	const ttlHours = 72;
	const workflowId = `approval-${id}`;
	await createApprovalRequest(context.db, {
		id,
		tediId: params.tediId,
		orgId: params.orgId,
		actionType: "os_gadget_execution",
		description: `Gadget "${params.gadgetName}" requests dispatch of skill ${params.skillSlug} (execution ${params.executionId})`,
		payload: {
			executionId: params.executionId,
			gadgetId: params.gadgetId,
			skillSlug: params.skillSlug,
		},
		createdAt: now.toISOString(),
		expiresAt: new Date(
			now.getTime() + ttlHours * 60 * 60 * 1000,
		).toISOString(),
		workflowId,
	});
	try {
		await context.env.APPROVAL_WORKFLOW?.create({
			id: workflowId,
			params: {
				approvalRequestId: id,
				tediId: params.tediId,
				orgId: params.orgId,
				ttlHours,
			},
		});
	} catch (error) {
		console.error("Failed to start gadget approval workflow:", error);
	}
	return id;
}

const gadgetsRun = runOs.gadgets.run.handler(async ({ input, context }) => {
	const gadget = await requireGadget(
		context,
		input.workspaceId,
		input.gadgetId,
	);
	const workspace = await requireWorkspace(context, input.workspaceId);
	const creator = resolveCreator(context);
	const db = queryDb(context);
	const orgId = gadget.organizationId;

	// Deterministic receipt identity: a caller idempotencyKey derives the
	// execution id, so a duplicate admission returns the recorded receipt
	// instead of admitting (and paying for) the run twice.
	const executionId = input.idempotencyKey
		? await deriveGadgetExecutionId({
				orgId,
				gadgetId: gadget.id,
				runtimeEnvironment: context.env.ENVIRONMENT,
				approvalMode: input.approvalMode,
				idempotencyKey: input.idempotencyKey,
			})
		: crypto.randomUUID();
	if (input.idempotencyKey) {
		const existing = await getOsGadgetExecution(db, {
			organizationId: orgId,
			executionId,
		});
		if (existing && existing.gadgetId === gadget.id) {
			return { execution: mapGadgetExecution(existing) };
		}
	}

	const reasons: string[] = [];
	if (gadget.status !== "active") {
		reasons.push("gadget is archived");
	}
	const revision = gadget.currentRevisionId
		? await getOsGadgetRevision(db, {
				organizationId: orgId,
				revisionId: gadget.currentRevisionId,
			})
		: undefined;
	if (!revision) {
		reasons.push("gadget has no revision to run");
	}
	const manifest = revision
		? OsGadgetManifestSchema.parse(JSON.parse(revision.manifest))
		: null;
	const declared = manifest?.capabilities ?? [];
	const requested = input.capabilities ?? declared;
	for (const capability of new Set(requested)) {
		if (!declared.includes(capability)) {
			reasons.push(`undeclared capability: ${capability}`);
		}
	}
	const declaredResourceGrants = manifest?.resourceGrants ?? [];
	const executable = manifest
		? await resolveGadgetExecutable(context, orgId, manifest)
		: "Gadget has no executable revision";
	const grantedResources: Array<
		OsDerivedResourceAccess & { slot: string; name: string }
	> = [];
	if (declaredResourceGrants.length > 0) {
		const resources = await listOsWorkspaceResources(db, {
			organizationId: orgId,
			workspaceId: gadget.workspaceId,
			status: "active",
			limit: 200,
		});
		const resourcesBySlot = new Map(
			resources
				.filter((resource) => resource.slot)
				.map((resource) => [resource.slot, resource]),
		);
		for (const grant of declaredResourceGrants) {
			const resource = resourcesBySlot.get(grant.slot);
			if (!resource) {
				reasons.push(`resource slot ${grant.slot} has no active selection`);
				continue;
			}
			if (resource.connectionScope === "user") {
				try {
					if (typeof executable === "string") throw new Error(executable);
					const rows = await Promise.all(
						input.resourceDelegationIds.map((id) =>
							getPersonalResourceDelegation(context.db, {
								organizationId: orgId,
								id,
							}),
						),
					);
					const matching = rows.filter(
						(row) =>
							row?.resourceId === resource.id &&
							row.workspaceId === resource.workspaceId &&
							row.tediId === input.tediId &&
							row.skillId === executable.skill.id &&
							row.skillRevision === executable.skill.revision,
					);
					if (
						matching.length !== 1 ||
						!matching[0] ||
						grant.operations.some(
							(operation) => !matching[0]!.operations.includes(operation),
						)
					)
						throw new Error(
							"Select exactly one valid personal resource consent covering this Gadget grant",
						);
					const source = {
						...personalDelegationSource(matching[0]),
						operations: grant.operations,
					};
					await validatePersonalRunSources(context, {
						tediId: input.tediId,
						skillId: executable.skill.id,
						skillRevision: executable.skill.revision,
						resourceAccessEnvelope: { version: 1, sources: [source] },
					});
					grantedResources.push({
						...source,
						slot: grant.slot,
						name: resource.name,
					});
				} catch (error) {
					reasons.push(
						`resource slot ${grant.slot}: ${error instanceof Error ? error.message : "personal consent denied"}`,
					);
				}
				continue;
			}
			const availability = await resolveWorkspaceResourceAvailability(context, {
				...resource,
				requiredScopes: JSON.parse(resource.requiredScopes) as string[],
			});
			if (availability.status !== "available") {
				reasons.push(
					`resource slot ${grant.slot} is unavailable: ${availability.status}`,
				);
				continue;
			}
			grantedResources.push({
				workspaceResourceId: resource.id,
				workspaceId: resource.workspaceId,
				slot: grant.slot,
				providerId: resource.providerId,
				connectionScope: "tenant",
				requiredScopes: JSON.parse(resource.requiredScopes) as string[],
				resourceType: resource.resourceType,
				providerResourceId: resource.providerResourceId,
				name: resource.name,
				operations: grant.operations,
			});
		}
	}

	const baseReceipt = {
		id: executionId,
		organizationId: orgId,
		workspaceId: gadget.workspaceId,
		gadgetId: gadget.id,
		revisionId: revision?.id ?? null,
		revision: revision?.revision ?? null,
		input: input.input === undefined ? null : JSON.stringify(input.input),
		tediId: input.tediId,
		workItemId: input.workItemId ?? null,
		runtimeEnvironment: context.env.ENVIRONMENT ?? null,
		agentSessionId: context.externalAgentSessionId ?? null,
		createdByKind: creator.kind,
		createdById: creator.id,
		createdAt: new Date().toISOString(),
		resourceAccessEnvelope: JSON.stringify({
			version: 1,
			sources: grantedResources.map(
				({ slot: _slot, name: _name, ...source }) => source,
			),
		}),
	};

	/** Insert the receipt; a concurrent duplicate of the same idempotent id resolves to the first admission's receipt. */
	const persistReceipt = async (
		receipt: NewOsGadgetExecutionRow,
	): Promise<OsGadgetExecutionRow> => {
		try {
			return await createOsGadgetExecution(db, receipt);
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				const existing = await getOsGadgetExecution(db, {
					organizationId: orgId,
					executionId,
				});
				if (existing && existing.gadgetId === gadget.id) return existing;
			}
			throw error;
		}
	};

	const denyReceipt = async (
		denialReasons: string[],
		decisions?: WorkItemExecutionPreflight["decisions"],
	) => {
		const row = await persistReceipt({
			...baseReceipt,
			status: "denied",
			grantedCapabilities: JSON.stringify([]),
			policyDecision: JSON.stringify({
				allowed: false,
				reasons: denialReasons,
				...(decisions ? { decisions } : {}),
			}),
		});
		return { execution: mapGadgetExecution(row) };
	};

	// Fast local denial — manifest-level failures deny before governed
	// capability, policy, and budget resolution.
	if (reasons.length > 0 || !manifest) {
		return denyReceipt(
			reasons.length > 0 ? reasons : ["gadget has no revision to run"],
		);
	}
	if (!revision) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Runnable Gadget revision disappeared after admission",
		);
	}

	// ---- Governed dispatch: the gadget run IS a skill-runtime run ----
	await requireOwnedTedi(context, input.tediId, orgId);
	if (input.workItemId) {
		const workItem = await getWorkItemById(context.db, input.workItemId);
		if (!workItem || workItem.orgId !== orgId) {
			throw createError(ErrorCodes.NOT_FOUND, "Work Item not found");
		}
	}

	if (typeof executable === "string") {
		return denyReceipt([executable]);
	}

	// Capability/policy/approval preflight via the shared work-item execution
	// machinery, on a synthetic subject derived from the gadget manifest.
	const preflight = await resolveWorkItemExecutionPreflight({
		db: context.db,
		env: context.env,
		workItem: gadgetPreflightSubject({
			subjectId: input.workItemId ?? executionId,
			orgId,
			tediId: input.tediId,
			requestedCapabilities: requested,
		}),
	});
	if (preflight.status === "blocked" || preflight.status === "not_configured") {
		return denyReceipt(
			preflight.blockingReasons.length > 0
				? preflight.blockingReasons
				: ["capability preflight blocked the dispatch"],
			preflight.decisions,
		);
	}
	if (
		preflight.status === "needs_approval" ||
		input.approvalMode === "required"
	) {
		const approvalRequestId = await parkGadgetApproval(context, {
			executionId,
			orgId,
			tediId: input.tediId,
			gadgetId: gadget.id,
			gadgetName: gadget.name,
			skillSlug: executable.slug,
		});
		const row = await persistReceipt({
			...baseReceipt,
			status: "awaiting_approval",
			approvalRequestId,
			grantedCapabilities: JSON.stringify(requested),
			policyDecision: JSON.stringify({
				allowed: false,
				reasons: [
					input.approvalMode === "required"
						? "the caller requires explicit human approval before dispatch"
						: "the active policy requires human approval before autonomous dispatch",
				],
				decisions: preflight.decisions,
			}),
		});
		return { execution: mapGadgetExecution(row) };
	}

	// Inference-budget admission; a denial is a receipt, not an exception.
	const budget = await authorizeGadgetInference(context, {
		orgId,
		tediId: input.tediId,
		runtimeProfileId: preflight.runtimeProfile?.id ?? null,
		executionId,
	});
	if (!budget.allowed) {
		return denyReceipt([`billing_denied: ${budget.code}`], preflight.decisions);
	}

	// Dispatch through skill-runtime — the receipt id IS the run id, so the
	// runtime's own admission dedupes an idempotent retry onto the same run.
	const dispatched = await dispatchGovernedGadgetExecution(context, {
		executionId,
		orgId,
		tediId: input.tediId,
		workItemId: input.workItemId ?? null,
		executable,
		input: input.input,
		idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
		resourceAccessEnvelope: OsDerivedAccessEnvelopeSchema.parse(
			JSON.parse(baseReceipt.resourceAccessEnvelope),
		),
		contextEnvelope: {
			version: 1,
			organizationId: orgId,
			workspace: { id: workspace.id, name: workspace.name },
			gadget: {
				id: gadget.id,
				name: gadget.name,
				revisionId: revision.id,
				revision: revision.revision,
			},
			resources: grantedResources.map(
				({
					slot,
					providerId,
					resourceType,
					providerResourceId,
					name,
					operations,
				}) => ({
					slot,
					providerId,
					resourceType,
					providerResourceId,
					name,
					operations,
				}),
			),
		},
	});
	const row = await persistReceipt({
		...baseReceipt,
		status: dispatchedReceiptStatus(dispatched.status),
		grantedCapabilities: JSON.stringify(requested),
		policyDecision: JSON.stringify({
			allowed: true,
			reasons: [],
			decisions: preflight.decisions,
		}),
		runId: dispatched.runId,
		workflowInstanceId: dispatched.workflowInstanceId ?? null,
		executionEpoch: dispatched.executionEpoch ?? 0,
		billingReservationId: budget.reservationId,
	});
	return { execution: mapGadgetExecution(row) };
});

/**
 * Fetch a receipt org-scoped and pin it to the gadget/workspace named in the
 * path. Receipts are audit evidence that survives gadget deletion, so this
 * deliberately verifies against the receipt row instead of requiring the
 * gadget to still exist.
 */
async function requireExecution(
	context: BaseContext,
	input: { workspaceId: string; gadgetId: string; executionId: string },
): Promise<OsGadgetExecutionRow> {
	const organizationId = requireOrgId(context);
	const execution = await getOsGadgetExecution(queryDb(context), {
		organizationId,
		executionId: input.executionId,
	});
	if (
		!execution ||
		execution.gadgetId !== input.gadgetId ||
		execution.workspaceId !== input.workspaceId
	) {
		throw createError(ErrorCodes.NOT_FOUND, "OS gadget execution not found");
	}
	return execution;
}

const RUN_SETTLEABLE_RECEIPT_STATUSES = new Set([
	"queued",
	"running",
	"paused",
]);

const SKILL_RUN_ENVIRONMENTS: ReadonlySet<string> = new Set([
	"development",
	"staging",
	"production",
]);

/**
 * Settle a dispatched receipt from run evidence at read time. The runtime owns
 * the run; the receipt is its audit projection, and the edge stays stateless —
 * no callback or reconciler holds the pair in sync, so every read of a
 * non-terminal run-linked receipt resolves the run and folds terminal evidence
 * (output, error, costs, epoch) into the receipt exactly once. Terminal
 * receipts are immutable and skip the run read entirely.
 */
async function settleExecutionFromRunEvidence(
	context: BaseContext,
	row: OsGadgetExecutionRow,
): Promise<OsGadgetExecutionRow> {
	if (!row.runId || !RUN_SETTLEABLE_RECEIPT_STATUSES.has(row.status)) {
		return row;
	}
	const environment = row.runtimeEnvironment ?? context.env.ENVIRONMENT;
	if (!environment || !SKILL_RUN_ENVIRONMENTS.has(environment)) return row;
	const run = await getSkillRun(
		context.db,
		row.runId,
		row.organizationId,
		environment as SkillRunRuntimeEnvironment,
	);
	if (!run || run.status === "queued" || run.status === row.status) return row;
	const terminal =
		run.status === "completed" ||
		run.status === "failed" ||
		run.status === "canceled";
	const settled = await settleOsGadgetExecutionFromRun(queryDb(context), {
		runId: row.runId,
		status: run.status,
		...(terminal
			? {
					output:
						run.result === null || run.result === undefined
							? null
							: JSON.stringify(run.result),
					error: run.error ?? null,
					costs:
						run.costSummary == null ? null : JSON.stringify(run.costSummary),
				}
			: {}),
		executionEpoch: run.executionEpoch,
	});
	return settled.find((candidate) => candidate.id === row.id) ?? row;
}

const executionsList = readOs.executions.list.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const rows = await listOsGadgetExecutions(
			queryDb(context),
			{ organizationId, gadgetId: input.gadgetId },
			{ status: input.status, limit: input.limit + 1 },
		);
		// A gadget's receipts all pin the same workspace; a mismatched path
		// yields an empty page rather than leaking another workspace's rows.
		const scoped = rows.filter((row) => row.workspaceId === input.workspaceId);
		const settledPage = await Promise.all(
			scoped
				.slice(0, input.limit)
				.map((row) => settleExecutionFromRunEvidence(context, row)),
		);
		return {
			items: settledPage.map(mapGadgetExecution),
			truncated: rows.length > input.limit,
		};
	},
);

const executionsGet = readOs.executions.get.handler(
	async ({ input, context }) => ({
		execution: mapGadgetExecution(
			await settleExecutionFromRunEvidence(
				context,
				await requireExecution(context, input),
			),
		),
	}),
);

const MAX_GADGET_EXPORT_ARTIFACT_BYTES = 35 * 1024 * 1024;
const MAX_GADGET_EXPORT_DECODED_BYTES = 25 * 1024 * 1024;

function gadgetExportFileName(
	gadgetName: string,
	executionId: string,
	extension: string,
): string {
	const stem = gadgetName
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9._ -]+/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[ ._-]+|[ ._-]+$/g, "")
		.slice(0, 100);
	return `${stem || "gadget-export"}-${executionId.slice(0, 8)}.${extension}`;
}

/**
 * Mint one explicit download capability from an immutable execution receipt.
 *
 * The URL is intentionally unavailable for source-derived runs: the artifact
 * origin is bearer-only and cannot repeat the viewer-time provider checks in a
 * resource access envelope. An empty, valid envelope is therefore a hard gate,
 * not a caller-supplied "safe" flag in the Gadget manifest.
 */
const executionsExport = readOs.executions.export.handler(
	async ({ input, context }) => {
		const row = await settleExecutionFromRunEvidence(
			context,
			await requireExecution(context, input),
		);
		if (row.status !== "completed" || !row.runId || !row.revisionId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Only a completed, run-backed Gadget execution can be exported",
			);
		}

		let envelopeValue: unknown = null;
		try {
			envelopeValue = row.resourceAccessEnvelope
				? JSON.parse(row.resourceAccessEnvelope)
				: null;
		} catch {
			// Malformed historical provenance is unverifiable and fails closed below.
		}
		const envelope = OsDerivedAccessEnvelopeSchema.safeParse(envelopeValue);
		if (!envelope.success) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"The execution has no valid resource access envelope, so export is unavailable",
			);
		}
		if (envelope.data.sources.length > 0) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Source-derived Gadget bytes cannot be downgraded to a bearer download URL",
			);
		}

		const revision = await getOsGadgetRevision(queryDb(context), {
			organizationId: row.organizationId,
			revisionId: row.revisionId,
		});
		if (!revision || revision.gadgetId !== row.gadgetId) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"The Gadget revision pinned by this execution is unavailable",
			);
		}
		const manifest = OsGadgetManifestSchema.parse(
			JSON.parse(revision.manifest),
		);
		const descriptor = manifest.exports?.find(
			(candidate) => candidate.id === input.exportId,
		);
		if (!descriptor) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"This execution revision did not declare the requested export",
			);
		}

		const artifact = await getRunArtifact(
			context.db,
			row.runId,
			descriptor.artifactPath,
		);
		if (!artifact || artifact.outcome !== "success") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"The declared export artifact is not available from this run",
			);
		}
		if (artifact.sizeBytes > MAX_GADGET_EXPORT_ARTIFACT_BYTES) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"The declared export artifact exceeds the supported download size",
			);
		}
		let content = artifact.contentInline;
		if (content === null && artifact.contentR2Key) {
			const stored = await context.env.SKILL_ARTIFACTS?.get(
				artifact.contentR2Key,
			);
			content = stored ? await stored.text() : null;
		}
		const media = content ? extractMediaBytes(content) : null;
		if (
			!media ||
			media.mimeType.toLowerCase() !== descriptor.mimeType.toLowerCase()
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"The declared export artifact does not contain bytes with the manifest media type",
			);
		}
		if (media.bytes.byteLength > MAX_GADGET_EXPORT_DECODED_BYTES) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"The decoded export exceeds the supported download size",
			);
		}

		const gadget = await getOsGadget(queryDb(context), {
			organizationId: row.organizationId,
			gadgetId: row.gadgetId,
		});
		const fileName = gadgetExportFileName(
			gadget?.name ?? "gadget-export",
			row.id,
			descriptor.extension,
		);
		const signed = await signMediaUrl({
			baseUrl: untrustedContentBaseUrl(context.env, context.env.API_URL),
			secret: context.env.SECRETS_MASTER_KEY,
			runId: row.runId,
			path: descriptor.artifactPath,
			downloadName: fileName,
			nowMs: Date.now(),
			ttlSeconds: 300,
		});
		return {
			descriptor,
			fileName,
			sizeBytes: media.bytes.byteLength,
			url: signed.url,
			urlExpiresAt: signed.expiresAt,
		};
	},
);

const blueprintsList = readOs.blueprints.list.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const rows = await listOsBlueprints(queryDb(context), organizationId, {
			status: input.status,
			limit: input.limit + 1,
		});
		return {
			items: rows.slice(0, input.limit).map(mapBlueprint),
			truncated: rows.length > input.limit,
		};
	},
);

const blueprintsCreate = authorOs.blueprints.create.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const creator = resolveCreator(context);
		const now = new Date().toISOString();
		try {
			const row = await createOsBlueprint(queryDb(context), {
				id: crypto.randomUUID(),
				organizationId,
				name: input.name,
				description: input.description ?? null,
				status: "draft",
				currentRevisionId: null,
				createdByKind: creator.kind,
				createdById: creator.id,
				createdAt: now,
				updatedAt: now,
			});
			return { blueprint: mapBlueprint(row) };
		} catch (error) {
			rethrowNameConflict(
				error,
				"A blueprint with this name already exists in the organization",
			);
		}
	},
);

const blueprintsGet = readOs.blueprints.get.handler(
	async ({ input, context }) => {
		const blueprint = await requireBlueprint(context, input.blueprintId);
		const currentRevision = blueprint.currentRevisionId
			? await getOsBlueprintRevision(queryDb(context), {
					organizationId: blueprint.organizationId,
					revisionId: blueprint.currentRevisionId,
				})
			: undefined;
		return {
			blueprint: mapBlueprint(blueprint),
			currentRevision: currentRevision
				? mapBlueprintRevision(currentRevision)
				: null,
		};
	},
);

const blueprintsRevise = authorOs.blueprints.revise.handler(
	async ({ input, context }) => {
		const blueprint = await requireBlueprint(context, input.blueprintId);
		const creator = resolveCreator(context);
		const db = queryDb(context);
		const result = await createOsBlueprintRevision(db, {
			id: crypto.randomUUID(),
			organizationId: blueprint.organizationId,
			blueprintId: blueprint.id,
			definition: JSON.stringify(input.definition),
			createdByKind: creator.kind,
			createdById: creator.id,
			expectedRevision: input.expectedRevision,
		});
		if (!result.ok) {
			if (result.reason === "blueprint_not_found") {
				throw createError(ErrorCodes.NOT_FOUND, "OS blueprint not found");
			}
			const [latest] = await listOsBlueprintRevisions(
				db,
				{ organizationId: blueprint.organizationId, blueprintId: blueprint.id },
				{ limit: 1 },
			);
			throw revisionConflict(
				"Blueprint",
				input.expectedRevision ?? 0,
				latest?.revision ?? null,
			);
		}
		const advanced = await getOsBlueprint(db, {
			organizationId: blueprint.organizationId,
			blueprintId: blueprint.id,
		});
		return {
			blueprint: mapBlueprint(advanced ?? blueprint),
			revision: mapBlueprintRevision(result.revision),
		};
	},
);

const blueprintsPublish = publishOs.blueprints.publish.handler(
	async ({ input, context }) => {
		const blueprint = await requireBlueprint(context, input.blueprintId);
		if (!blueprint.currentRevisionId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Blueprint has no revision to publish; record one with blueprints.revise first",
			);
		}
		const db = queryDb(context);
		const result = await publishOsBlueprintRevision(db, {
			organizationId: blueprint.organizationId,
			blueprintId: blueprint.id,
			revisionId: blueprint.currentRevisionId,
		});
		if (!result.ok) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Blueprint revision changed concurrently; re-read and publish again",
			);
		}
		const revision = await getOsBlueprintRevision(db, {
			organizationId: blueprint.organizationId,
			revisionId: blueprint.currentRevisionId,
		});
		if (!revision) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Published revision was not observable after the publish batch",
			);
		}
		return {
			blueprint: mapBlueprint(result.blueprint),
			revision: mapBlueprintRevision(revision),
		};
	},
);

/**
 * Resolve the pinned dependency declaration of one blueprint revision against
 * the CALLER's organization. Every instantiation path goes through this, so a
 * gallery import is resolved in the importing tenant — never the publisher's.
 */
async function resolveBlueprintPreflight(
	context: BaseContext,
	organizationId: string,
	blueprintId: string,
	revisionRow: OsBlueprintRevisionRow,
	definition: OsBlueprintDefinition,
	tediId: string | undefined,
	resourceBindings: OsBlueprintResourceBinding[],
): Promise<OsBlueprintPreflight> {
	return resolveOsBlueprintPreflight({
		db: context.db,
		env: context.env,
		organizationId,
		blueprintId,
		revisionId: revisionRow.id,
		revision: revisionRow.revision,
		definition,
		tediId: tediId ?? null,
		ownerUserId:
			context.authType === "user" ? (context.user?.sub ?? null) : null,
		resourceBindings,
	});
}

/** Refuse instantiation when a definitional pin did not resolve; nothing has been written yet. */
function requireInstantiablePreflight(preflight: OsBlueprintPreflight): void {
	if (preflight.instantiateAllowed) return;
	const reasons = [
		...preflight.blockingReasons,
		...preflight.configurationReasons,
	];
	throw new ORPCError("UNPROCESSABLE_CONTENT", {
		message: `Blueprint dependencies did not resolve in this organization: ${reasons.join("; ")}`,
		data: { preflight },
	});
}

/**
 * Materialize a blueprint revision's definition as a new workspace with every
 * declared gadget at revision 1, plus — for a gallery import — the blueprint
 * copy itself, all in one D1 batch.
 *
 * `blueprint` and `revisionRow` describe the row set the workspace is pinned
 * to; for a gallery import they are the not-yet-written copy, and
 * `blueprintCopy` carries the insert rows so the copy cannot survive a failed
 * workspace insert. Nothing here reads or writes a credential: only the
 * declared gadget manifests are copied, and the requirement declaration is
 * `.strict()`, so no token can be represented in one.
 */
async function materializeBlueprintWorkspace(
	context: BaseContext,
	blueprint: OsBlueprintRow,
	revisionRow: OsBlueprintRevisionRow,
	definition: OsBlueprintDefinition,
	preflight: OsBlueprintPreflight,
	resourceBindings: OsBlueprintResourceBinding[],
	workspaceName: string,
	description: string | null,
	blueprintCopy?: {
		blueprint: OsBlueprintRow;
		revision: OsBlueprintRevisionRow;
	},
) {
	const declaredNames = new Set<string>();
	for (const declared of definition.gadgets) {
		if (declaredNames.has(declared.name)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Blueprint revision declares the gadget name twice: ${declared.name}`,
			);
		}
		declaredNames.add(declared.name);
	}
	const creator = resolveCreator(context);
	const now = new Date().toISOString();
	const workspaceId = crypto.randomUUID();
	const accountability = {
		organizationId: blueprint.organizationId,
		createdByKind: creator.kind,
		createdById: creator.id,
		createdAt: now,
	};
	const gadgetRows = [];
	const revisionRows = [];
	const resourceRows = resourceBindings.map((binding) => ({
		...accountability,
		id: crypto.randomUUID(),
		workspaceId,
		slot: binding.slot,
		providerId: binding.selection.providerId,
		connectionScope: binding.selection.connectionScope,
		requiredScopes: JSON.stringify(binding.selection.requiredScopes),
		resourceType: binding.selection.resourceType,
		providerResourceId: binding.selection.providerResourceId,
		name: binding.selection.name,
		metadata: JSON.stringify(binding.selection.metadata),
		status: "active" as const,
		updatedAt: now,
		removedAt: null,
	}));
	for (const declared of definition.gadgets) {
		const gadgetId = crypto.randomUUID();
		const gadgetRevisionId = crypto.randomUUID();
		gadgetRows.push({
			...accountability,
			id: gadgetId,
			workspaceId,
			name: declared.name,
			description: null,
			status: "active" as const,
			currentRevisionId: gadgetRevisionId,
			sourceBlueprintRevisionId: revisionRow.id,
			updatedAt: now,
		});
		revisionRows.push({
			...accountability,
			id: gadgetRevisionId,
			gadgetId,
			revision: 1,
			manifest: JSON.stringify(declared.manifest),
			sourceArtifactRef: null,
		});
	}
	const result = await instantiateOsBlueprint(queryDb(context), {
		blueprintCopy,
		workspace: {
			...accountability,
			id: workspaceId,
			name: workspaceName,
			description,
			status: "active",
			sourceBlueprintId: blueprint.id,
			sourceBlueprintRevisionId: revisionRow.id,
			sourceBlueprintRevisionNumber: revisionRow.revision,
			instantiationPreflight: JSON.stringify(preflight),
			updatedAt: now,
		},
		resources: resourceRows,
		gadgets: gadgetRows,
		revisions: revisionRows,
	});
	const revisionsByGadget = new Map(
		result.revisions.map((row) => [row.gadgetId, row]),
	);
	return {
		workspace: mapWorkspace(result.workspace),
		blueprint: mapBlueprint(result.blueprintCopy?.blueprint ?? blueprint),
		revision: mapBlueprintRevision(
			result.blueprintCopy?.revision ?? revisionRow,
		),
		preflight,
		resources: result.resources.map(workspaceResources.mapWorkspaceResource),
		gadgets: result.gadgets.map((gadgetRow) => {
			const gadgetRevision = revisionsByGadget.get(gadgetRow.id);
			if (!gadgetRevision) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Instantiated gadget was returned without its revision",
				);
			}
			return {
				gadget: mapGadget(gadgetRow),
				revision: mapGadgetRevision(gadgetRevision),
			};
		}),
	};
}

const blueprintsPreflight = readOs.blueprints.preflight.handler(
	async ({ input, context }) => {
		const blueprint = await requireBlueprint(context, input.blueprintId);
		if (!blueprint.currentRevisionId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Blueprint has no revision to preflight; record one with blueprints.revise first",
			);
		}
		const revisionRow = await getOsBlueprintRevision(queryDb(context), {
			organizationId: blueprint.organizationId,
			revisionId: blueprint.currentRevisionId,
		});
		if (!revisionRow) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Current blueprint revision was not readable",
			);
		}
		const definition = OsBlueprintDefinitionSchema.parse(
			JSON.parse(revisionRow.definition),
		);
		return {
			preflight: await resolveBlueprintPreflight(
				context,
				blueprint.organizationId,
				blueprint.id,
				revisionRow,
				definition,
				input.tediId,
				input.resourceBindings,
			),
		};
	},
);

const blueprintsInstantiate = publishOs.blueprints.instantiate.handler(
	async ({ input, context }) => {
		const blueprint = await requireBlueprint(context, input.blueprintId);
		if (blueprint.status !== "published" || !blueprint.currentRevisionId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Only a published blueprint can be instantiated; publish it first",
			);
		}
		const revisionRow = await getOsBlueprintRevision(queryDb(context), {
			organizationId: blueprint.organizationId,
			revisionId: blueprint.currentRevisionId,
		});
		if (!revisionRow) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Published blueprint revision was not readable",
			);
		}
		const definition = OsBlueprintDefinitionSchema.parse(
			JSON.parse(revisionRow.definition),
		);
		const preflight = await resolveBlueprintPreflight(
			context,
			blueprint.organizationId,
			blueprint.id,
			revisionRow,
			definition,
			input.tediId,
			input.resourceBindings,
		);
		requireInstantiablePreflight(preflight);
		try {
			return await materializeBlueprintWorkspace(
				context,
				blueprint,
				revisionRow,
				definition,
				preflight,
				input.resourceBindings,
				input.workspaceName,
				input.description ?? null,
			);
		} catch (error) {
			rethrowNameConflict(
				error,
				"A workspace with this name already exists in the organization",
			);
		}
	},
);

const blueprintsSetVisibility = publishOs.blueprints.setVisibility.handler(
	async ({ input, context }) => {
		const blueprint = await requireBlueprint(context, input.blueprintId);
		if (blueprint.status !== "published") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Only a published blueprint can change catalog visibility; publish it first",
			);
		}
		const row = await setOsBlueprintVisibility(
			queryDb(context),
			{ organizationId: blueprint.organizationId, blueprintId: blueprint.id },
			input.visibility,
		);
		if (!row) {
			throw createError(ErrorCodes.NOT_FOUND, "OS blueprint not found");
		}
		return { blueprint: mapBlueprint(row) };
	},
);

const blueprintsGallery = readOs.blueprints.gallery.handler(
	async ({ input, context }) => {
		// Deliberately org-agnostic (still two-plane authenticated): the query
		// itself fences the listing to catalog-visible published blueprints, and
		// only the gallery-item fields leave this handler.
		const listings = await listCatalogOsBlueprints(queryDb(context), {
			limit: input.limit,
		});
		return {
			items: listings.map((listing) => ({
				id: listing.blueprint.id,
				name: listing.blueprint.name,
				description: listing.blueprint.description,
				gadgetCount: listing.gadgetCount,
				organizationName: listing.organizationName,
				publishedAt: listing.publishedAt,
			})),
		};
	},
);

/** Name attempts for the copied blueprint when the source name is taken in the caller's organization. */
const GALLERY_COPY_NAME_ATTEMPTS = 3;

const blueprintsInstantiateFromGallery =
	publishOs.blueprints.instantiateFromGallery.handler(
		async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			const db = queryDb(context);
			// Cross-organization resolution is fenced inside the query to
			// catalog-visible + published sources; anything else resolves exactly
			// like a missing id.
			const source = await getCatalogOsBlueprint(db, input.blueprintId);
			if (!source || !source.blueprint.currentRevisionId) {
				throw createError(ErrorCodes.NOT_FOUND, "OS blueprint not found");
			}
			const sourceRevision = await getOsBlueprintRevision(db, {
				organizationId: source.blueprint.organizationId,
				revisionId: source.blueprint.currentRevisionId,
			});
			if (!sourceRevision) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Gallery blueprint revision was not readable",
				);
			}
			const definition = OsBlueprintDefinitionSchema.parse(
				JSON.parse(sourceRevision.definition),
			);
			const creator = resolveCreator(context);
			const now = new Date().toISOString();
			const provenance = `Imported from the blueprint gallery: "${source.blueprint.name}" by ${source.organizationName} (blueprint ${source.blueprint.id}, revision ${sourceRevision.revision}).`;
			const description = source.blueprint.description
				? `${source.blueprint.description}\n\n${provenance}`
				: provenance;
			// Structured lineage beside the prose: the description is free text a
			// later edit rewrites and no reader can parse, and it cannot express a
			// fork of a fork. This chain names the origin — organization, blueprint,
			// revision, and a digest of the exact definition forked — without ever
			// needing to read the source organization again.
			const lineage = JSON.stringify(
				buildForkLineage(
					{
						organizationId: source.blueprint.organizationId,
						organizationName: source.organizationName,
						blueprintId: source.blueprint.id,
						blueprintName: source.blueprint.name,
						revisionId: sourceRevision.id,
						revision: sourceRevision.revision,
						definitionSha256: await canonicalDigest(definition),
						forkedAt: now,
						via: "gallery",
						// The platform read the source blueprint and revision rows to
						// build this entry, so it is verified.
						attested: true,
					},
					parseBlueprintLineage(source.blueprint.lineage),
				),
			);
			for (
				let attempt = 0;
				attempt < GALLERY_COPY_NAME_ATTEMPTS;
				attempt += 1
			) {
				const blueprintId = crypto.randomUUID();
				const revisionId = crypto.randomUUID();
				const name =
					attempt === 0
						? source.blueprint.name
						: `${source.blueprint.name} (${attempt + 1})`;
				const copyBlueprint: OsBlueprintRow = {
					id: blueprintId,
					organizationId,
					name,
					description,
					status: "published",
					visibility: "org",
					currentRevisionId: revisionId,
					lineage,
					createdByKind: creator.kind,
					createdById: creator.id,
					createdAt: now,
					updatedAt: now,
				};
				const copyRevision: OsBlueprintRevisionRow = {
					id: revisionId,
					organizationId,
					blueprintId,
					revision: 1,
					// The PARSED definition, re-serialized — never the source bytes.
					// `.strict()` on the requirement schemas is not the guarantee it
					// looks like: it governs `requirements` only, and copying the raw
					// string let unvalidated keys planted by the SOURCE org cross the
					// tenant boundary and land persisted in the IMPORTING org's D1.
					// They were invisible in the response (zod strips them on the way
					// out), so a wire-level assertion could never see them — only the
					// row could. Serializing the parsed object is what actually makes
					// the copied bytes match the declared schema.
					definition: JSON.stringify(definition),
					createdByKind: creator.kind,
					createdById: creator.id,
					createdAt: now,
					publishedAt: now,
				};
				// Resolved in the IMPORTING organization against the copy's own
				// identity, before a single row is written. A skill id or org-scoped
				// policy pack pinned by the publisher is not reachable here, so this
				// reports missing/denied rather than binding to a same-slug local row.
				const preflight = await resolveOsBlueprintPreflight({
					db: context.db,
					env: context.env,
					organizationId,
					blueprintId,
					revisionId,
					revision: 1,
					definition,
					tediId: input.tediId ?? null,
					ownerUserId:
						context.authType === "user" ? (context.user?.sub ?? null) : null,
					resourceBindings: input.resourceBindings,
				});
				requireInstantiablePreflight(preflight);
				try {
					return await materializeBlueprintWorkspace(
						context,
						copyBlueprint,
						copyRevision,
						definition,
						preflight,
						input.resourceBindings,
						input.workspaceName,
						null,
						{ blueprint: copyBlueprint, revision: copyRevision },
					);
				} catch (error) {
					if (!isUniqueConstraintError(error)) throw error;
					// One batch writes both rows, so either name can lose the race.
					// Only a blueprint-name collision is renumberable; a taken
					// workspace name is the caller's to resolve, and the batch rolled
					// the copy back with it.
					if (uniqueConstraintTable(error) === "os_workspaces") {
						throw createError(
							ErrorCodes.CONFLICT,
							"A workspace with this name already exists in the organization",
							error,
						);
					}
				}
			}
			throw createError(
				ErrorCodes.CONFLICT,
				`Blueprint name "${source.blueprint.name}" and its numbered variants already exist in this organization`,
			);
		},
	);

/** Read one revision of a blueprint the caller's organization owns, bound to that blueprint. */
async function requireBlueprintRevision(
	context: BaseContext,
	blueprint: OsBlueprintRow,
	revisionId: string,
): Promise<OsBlueprintRevisionRow> {
	const revisionRow = await getOsBlueprintRevision(queryDb(context), {
		organizationId: blueprint.organizationId,
		revisionId,
	});
	// Org-scoped by the query AND pinned to this blueprint: a revision id that
	// belongs to a different blueprint of the same tenant is not this
	// blueprint's revision, and must not resolve here.
	if (!revisionRow || revisionRow.blueprintId !== blueprint.id) {
		throw createError(ErrorCodes.NOT_FOUND, "OS blueprint revision not found");
	}
	return revisionRow;
}

const blueprintsExport = readOs.blueprints.export.handler(
	async ({ input, context }) => {
		const blueprint = await requireBlueprint(context, input.blueprintId);
		const revisionId = input.revisionId ?? blueprint.currentRevisionId;
		if (!revisionId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Blueprint has no revision to export; record one with blueprints.revise first",
			);
		}
		const revisionRow = await requireBlueprintRevision(
			context,
			blueprint,
			revisionId,
		);
		return {
			export: await buildOsBlueprintExport({
				blueprint,
				revision: revisionRow,
				// The PARSED definition: the envelope carries the declared schema, not
				// whatever bytes the column happens to hold.
				definition: OsBlueprintDefinitionSchema.parse(
					JSON.parse(revisionRow.definition),
				),
				organizationName:
					(await getOrganizationDisplayName(
						context.db,
						blueprint.organizationId,
					)) ?? null,
				exportedByKind: resolveCreator(context).kind,
				exportedAt: new Date().toISOString(),
			}),
		};
	},
);

const blueprintsImport = authorOs.blueprints.import.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const envelope = input.export;
		// Validate BEFORE persisting: the contract already rejected an envelope
		// with unknown keys, and this proves the recorded digest actually
		// describes the definition the envelope carries — without it the lineage
		// digest would name an ancestor whose content is not present.
		const verified = await verifyOsBlueprintExport(envelope);
		if (!verified.ok) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Export envelope digest does not match its definition (declared ${verified.expected}, computed ${verified.actual})`,
			);
		}
		const creator = resolveCreator(context);
		const now = new Date().toISOString();
		const blueprintId = crypto.randomUUID();
		const revisionId = crypto.randomUUID();
		try {
			const result = await importOsBlueprint(queryDb(context), {
				blueprint: {
					id: blueprintId,
					organizationId,
					name: input.name ?? envelope.blueprint.name,
					description: envelope.blueprint.description,
					// An import never inherits the source's lifecycle or catalog
					// decision: it lands as a private draft the importer reviews and
					// publishes, so it can never republish another org's blueprint.
					status: "draft",
					visibility: "org",
					currentRevisionId: revisionId,
					// The envelope's `source` is CALLER-SUPPLIED. Its digest proves the
					// envelope is self-consistent, not that the named organization ever
					// published that revision — an importer can name any org and any
					// real ids. Recorded as an assertion, never as proof.
					lineage: JSON.stringify(
						buildForkLineage(
							{ ...envelope.source, attested: false },
							envelope.lineage,
						),
					),
					createdByKind: creator.kind,
					createdById: creator.id,
					createdAt: now,
					updatedAt: now,
				},
				revision: {
					id: revisionId,
					organizationId,
					blueprintId,
					revision: 1,
					// The PARSED definition, re-serialized — never the submitted bytes.
					// Copying raw bytes is how unvalidated keys previously crossed a
					// tenant boundary and landed persisted while being invisible in the
					// response (zod strips them on the way out).
					definition: JSON.stringify(envelope.definition),
					createdByKind: creator.kind,
					createdById: creator.id,
					createdAt: now,
					publishedAt: null,
				},
			});
			return {
				blueprint: mapBlueprint(result.blueprint),
				revision: mapBlueprintRevision(result.revision),
			};
		} catch (error) {
			rethrowNameConflict(
				error,
				"A blueprint with this name already exists in the organization; import it under a different name",
			);
		}
	},
);

/**
 * Everything an upgrade preview or decision needs, resolved read-only: the
 * workspace, the blueprint it came from, the revision it is pinned to, the
 * candidate revision, and the compatibility report between them.
 *
 * Every read binds `organizationId` — the CALLER's, passed in explicitly rather
 * than read back off the workspace row, so the tenant fence never depends on a
 * column of the record being fenced. The revisions are additionally pinned to
 * the blueprint the workspace records, so a hand-created workspace, a deleted
 * blueprint, or a revision belonging to some other blueprint all fail here
 * rather than producing a comparison that was never made.
 */
async function resolveWorkspaceUpgrade(
	context: BaseContext,
	organizationId: string,
	input: {
		workspaceId: string;
		candidateRevisionId?: string;
		tediId?: string;
	},
): Promise<{
	workspace: OsWorkspaceRow;
	blueprint: OsBlueprintRow;
	pinnedRevision: OsBlueprintRevisionRow;
	pinnedDefinition: OsBlueprintDefinition;
	candidateRevision: OsBlueprintRevisionRow;
	candidateDefinition: OsBlueprintDefinition;
	report: OsBlueprintUpgradeReport;
}> {
	const workspace = await requireWorkspace(context, input.workspaceId);
	if (
		!workspace.sourceBlueprintId ||
		!workspace.sourceBlueprintRevisionId ||
		workspace.sourceBlueprintRevisionNumber === null
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"This workspace was not instantiated from a blueprint, so there is no pinned revision to upgrade from",
		);
	}
	const blueprint = await getOsBlueprint(queryDb(context), {
		organizationId,
		blueprintId: workspace.sourceBlueprintId,
	});
	if (!blueprint) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"The blueprint this workspace was instantiated from no longer exists in this organization; there is nothing to compare against",
		);
	}
	const pinnedRevision = await requireBlueprintRevision(
		context,
		blueprint,
		workspace.sourceBlueprintRevisionId,
	);
	if (!blueprint.currentRevisionId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"The source blueprint has no current revision to compare against",
		);
	}
	const candidateRevision = await requireBlueprintRevision(
		context,
		blueprint,
		input.candidateRevisionId ?? blueprint.currentRevisionId,
	);
	const pinnedDefinition = OsBlueprintDefinitionSchema.parse(
		JSON.parse(pinnedRevision.definition),
	);
	const candidateDefinition = OsBlueprintDefinitionSchema.parse(
		JSON.parse(candidateRevision.definition),
	);
	const report = await resolveOsBlueprintUpgradeReport({
		db: context.db,
		env: context.env,
		organizationId,
		workspaceId: workspace.id,
		blueprintId: blueprint.id,
		pinned: {
			id: pinnedRevision.id,
			revision: pinnedRevision.revision,
			definition: pinnedDefinition,
		},
		candidate: {
			id: candidateRevision.id,
			revision: candidateRevision.revision,
			definition: candidateDefinition,
		},
		preflightAtInstantiation: parseInstantiationPreflight(
			workspace.instantiationPreflight,
		),
		tediId: input.tediId ?? null,
		ownerUserId:
			context.authType === "user" ? (context.user?.sub ?? null) : null,
	});
	return {
		workspace,
		blueprint,
		pinnedRevision,
		pinnedDefinition,
		candidateRevision,
		candidateDefinition,
		report,
	};
}

const workspacesPreviewBlueprintUpgrade =
	readOs.workspaces.previewBlueprintUpgrade.handler(
		async ({ input, context }) => {
			const { report } = await resolveWorkspaceUpgrade(
				context,
				requireOrgId(context),
				input,
			);
			return { report };
		},
	);

/**
 * D1 executes a batch as one transaction; an upgrade whose reconcile plan needs
 * more statements than this is not an upgrade, it is a re-instantiation. Two
 * statements per added gadget, up to two per synced gadget, one per archived
 * gadget, plus the workspace re-pin.
 */
const MAX_UPGRADE_STATEMENTS = 120;

/**
 * How many of a workspace's gadgets the reconcile reads. It matches the cap
 * `listOsGadgets` enforces, so a full page means the read was truncated — see
 * the refusal at the call site.
 */
const WORKSPACE_GADGET_READ_LIMIT = 500;

const workspacesDecideBlueprintUpgrade =
	publishOs.workspaces.decideBlueprintUpgrade.handler(
		async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			const resolved = await resolveWorkspaceUpgrade(
				context,
				organizationId,
				input,
			);
			const { workspace, report, candidateRevision } = resolved;
			const creator = resolveCreator(context);
			const now = new Date().toISOString();
			const summary = summarizeOsBlueprintUpgradeReport(report);
			const pinnedRevisionId = workspace.sourceBlueprintRevisionId as string;
			const pinnedRevisionNumber =
				workspace.sourceBlueprintRevisionNumber as number;
			const db = queryDb(context);

			if (input.decision === "stay_pinned") {
				// A recorded review that moves nothing. This is the whole point of the
				// branch: "we looked at revision N and chose to stay" is a fact a
				// reader can find, which the absence of an upgrade can never state.
				const decision: OsWorkspaceBlueprintDecision = {
					version: 1,
					decision: "stay_pinned",
					decidedAt: now,
					decidedByKind: creator.kind,
					reviewedRevisionId: candidateRevision.id,
					reviewedRevision: candidateRevision.revision,
					pinnedRevisionId,
					pinnedRevision: pinnedRevisionNumber,
					reason: input.reason ?? null,
					summary,
				};
				const row = await recordOsWorkspaceBlueprintDecision(db, {
					organizationId,
					workspaceId: workspace.id,
					expectedRevisionId: pinnedRevisionId,
					blueprintDecision: JSON.stringify(decision),
					now,
				});
				if (!row) {
					throw createError(
						ErrorCodes.CONFLICT,
						"The workspace moved to a different blueprint revision while the decision was being recorded; re-read the preview and decide again",
					);
				}
				return { workspace: mapWorkspace(row), report, decision };
			}

			if (report.upToDate) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"The workspace is already pinned to this revision; record a stay_pinned decision to note the review instead",
				);
			}
			// The same gate instantiation uses, against the candidate resolved in
			// THIS organization — an upgrade may not materialize a pin that does not
			// resolve here.
			requireInstantiablePreflight(report.candidatePreflightNow);

			const existing = await listOsGadgets(db, organizationId, {
				workspaceId: workspace.id,
				limit: WORKSPACE_GADGET_READ_LIMIT,
			});
			if (existing.length >= WORKSPACE_GADGET_READ_LIMIT) {
				// The reconcile decides which gadgets are new and which the candidate
				// dropped by comparing the declaration against THIS list. A truncated
				// list would make it archive gadgets it simply did not read, so refuse
				// rather than act on a partial view.
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`This workspace carries at least ${WORKSPACE_GADGET_READ_LIMIT} gadgets, more than an upgrade can reconcile in one pass; instantiate the revision as a new workspace instead`,
				);
			}
			const existingByName = new Map(existing.map((row) => [row.name, row]));
			const declaredNames = new Set<string>();
			const added: OsBlueprintUpgradeGadgetInsert[] = [];
			const synced: OsBlueprintUpgradeGadgetSync[] = [];
			for (const declared of resolved.candidateDefinition.gadgets) {
				if (declaredNames.has(declared.name)) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`Blueprint revision declares the gadget name twice: ${declared.name}`,
					);
				}
				declaredNames.add(declared.name);
				const current = existingByName.get(declared.name);
				const accountability = {
					organizationId,
					createdByKind: creator.kind,
					createdById: creator.id,
					createdAt: now,
				};
				if (!current) {
					const gadgetId = crypto.randomUUID();
					const gadgetRevisionId = crypto.randomUUID();
					added.push({
						gadget: {
							...accountability,
							id: gadgetId,
							workspaceId: workspace.id,
							name: declared.name,
							description: null,
							status: "active",
							currentRevisionId: gadgetRevisionId,
							sourceBlueprintRevisionId: candidateRevision.id,
							updatedAt: now,
						},
						revision: {
							...accountability,
							id: gadgetRevisionId,
							gadgetId,
							revision: 1,
							manifest: JSON.stringify(declared.manifest),
							sourceArtifactRef: null,
						},
					});
					continue;
				}
				const currentRevision = current.currentRevisionId
					? await getOsGadgetRevision(db, {
							organizationId,
							revisionId: current.currentRevisionId,
						})
					: undefined;
				// A manifest counts as changed only when its canonical JSON differs
				// from what the gadget actually serves — never assumed from the
				// blueprint diff alone.
				const servedManifest = currentRevision
					? canonicalJson(
							OsGadgetManifestSchema.parse(
								JSON.parse(currentRevision.manifest),
							),
						)
					: null;
				const nextManifest = canonicalJson(declared.manifest);
				synced.push({
					gadgetId: current.id,
					append:
						servedManifest === nextManifest
							? null
							: {
									revisionId: crypto.randomUUID(),
									manifest: JSON.stringify(declared.manifest),
									createdByKind: creator.kind,
									createdById: creator.id,
								},
				});
			}
			const archivedGadgetIds = existing
				.filter(
					(row) => !declaredNames.has(row.name) && row.status === "active",
				)
				.map((row) => row.id);

			const statements =
				added.length * 2 +
				synced.reduce((total, sync) => total + (sync.append ? 2 : 1), 0) +
				archivedGadgetIds.length +
				1;
			if (statements > MAX_UPGRADE_STATEMENTS) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`This upgrade would reconcile ${added.length + synced.length + archivedGadgetIds.length} gadgets in one transaction, beyond what a single D1 batch should carry; instantiate the revision as a new workspace instead`,
				);
			}

			const decision: OsWorkspaceBlueprintDecision = {
				version: 1,
				decision: "applied",
				decidedAt: now,
				decidedByKind: creator.kind,
				reviewedRevisionId: candidateRevision.id,
				reviewedRevision: candidateRevision.revision,
				pinnedRevisionId: candidateRevision.id,
				pinnedRevision: candidateRevision.revision,
				reason: input.reason ?? null,
				summary,
			};
			const result = await applyOsBlueprintUpgrade(db, {
				organizationId,
				workspaceId: workspace.id,
				expectedRevisionId: pinnedRevisionId,
				expectedRevisionNumber: pinnedRevisionNumber,
				// Retained, not overwritten: skills and policy packs version in place,
				// so the envelope recorded on the old pin cannot be reconstructed.
				expectedInstantiationPreflight: workspace.instantiationPreflight,
				nextRevisionId: candidateRevision.id,
				nextRevisionNumber: candidateRevision.revision,
				nextInstantiationPreflight: JSON.stringify(
					report.candidatePreflightNow,
				),
				blueprintDecision: JSON.stringify(decision),
				added,
				synced,
				archivedGadgetIds,
				now,
			});
			if (!result.ok) {
				throw createError(
					ErrorCodes.CONFLICT,
					"The workspace moved to a different blueprint revision while the upgrade was being applied; nothing was written — re-read the preview and decide again",
				);
			}
			return { workspace: mapWorkspace(result.workspace), report, decision };
		},
	);

export const osWorkspacesContractRouter = osWorkspacesOs.router({
	workspaces: {
		...workspaceLibrary.osWorkspaceProcedures,
		previewBlueprintUpgrade: workspacesPreviewBlueprintUpgrade,
		decideBlueprintUpgrade: workspacesDecideBlueprintUpgrade,
	},
	workspacePreferences: workspaceLibrary.osWorkspacePreferenceProcedures,
	resources: workspaceResources.osWorkspaceResourceProcedures,
	work: workspaceWork.osWorkspaceWorkProcedures,
	gadgets: {
		list: gadgetsList,
		create: gadgetsCreate,
		get: gadgetsGet,
		revise: gadgetsRevise,
		archive: gadgetsArchive,
		run: gadgetsRun,
		...resourceLifecycle.osGadgetLifecycleProcedures,
	},
	executions: {
		list: executionsList,
		get: executionsGet,
		export: executionsExport,
	},
	collaboration: collaborationProcedures.osCollaborationProcedures,
	outputs: {
		...outputProcedures.osOutputProcedures,
		...resourceLifecycle.osOutputLifecycleProcedures,
	},
	blueprints: {
		list: blueprintsList,
		create: blueprintsCreate,
		get: blueprintsGet,
		revise: blueprintsRevise,
		publish: blueprintsPublish,
		...resourceLifecycle.osBlueprintLifecycleProcedures,
		preflight: blueprintsPreflight,
		instantiate: blueprintsInstantiate,
		export: blueprintsExport,
		import: blueprintsImport,
		setVisibility: blueprintsSetVisibility,
		gallery: blueprintsGallery,
		instantiateFromGallery: blueprintsInstantiateFromGallery,
	},
});
