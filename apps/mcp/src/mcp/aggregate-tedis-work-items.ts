// Artifact-neutral Work factory tools plus graph and source reads.
import { workItemsContract } from "@tedix/api-contract/contracts/work-items";
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import {
	DESTRUCTIVE,
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";

const WORK_ITEM_AUTHOR_TYPE_ENUM = ["user", "tedi", "system"];
const WORK_ITEM_RELATION_TYPE_ENUM = ["blocks", "duplicates", "references"];
const WORK_ITEM_PROJECTION_DIRECTION_ENUM = ["source", "projection", "sync"];
const WORK_ITEM_PROJECTION_STATUS_ENUM = [
	"pending",
	"synced",
	"failed",
	"stale",
];

const WORK_ITEMS_LIST_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.list),
);

const WORK_ITEM_ID_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: { id: { type: "string", format: "uuid" } },
	required: ["id"],
	additionalProperties: false,
};

const WORK_ITEM_CREATE_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.create),
);

const WORK_ITEM_COMMENT_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", format: "uuid" },
		body: { type: "string" },
		authorType: { type: "string", enum: WORK_ITEM_AUTHOR_TYPE_ENUM },
		authorId: { type: "string" },
		metadata: { type: "object", additionalProperties: true },
	},
	required: ["id", "body"],
	additionalProperties: false,
};

const WORK_ITEM_CORROBORATE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", format: "uuid" },
		body: {
			type: "string",
			description:
				"How you independently reproduced/hit this. Defaults to a generic corroboration note.",
		},
		evidenceRef: {
			type: "string",
			description: "Required commit, artifact, or reproduction evidence ref.",
		},
	},
	required: ["id", "body", "evidenceRef"],
	additionalProperties: false,
};

const START_ATTEMPT_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.startAttempt),
);
const HEARTBEAT_ATTEMPT_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.heartbeatAttempt),
);
const SETTLE_ATTEMPT_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.settleAttempt),
);
const LIST_ATTEMPTS_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.listAttempts),
);
const GET_READINESS_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.getReadiness),
);
const SUBMIT_EVIDENCE_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.submitEvidence),
);
const COMPLETE_WORK_ITEM_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.complete),
);
const LIST_EVIDENCE_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.listEvidence),
);
const LIST_EVENTS_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.listEvents),
);

const WORK_ITEM_RELATION_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", format: "uuid" },
		toWorkItemId: { type: "string", format: "uuid" },
		relationType: { type: "string", enum: WORK_ITEM_RELATION_TYPE_ENUM },
		metadata: { type: "object", additionalProperties: true },
	},
	required: ["id", "toWorkItemId", "relationType"],
	additionalProperties: false,
};

const WORK_ITEM_PROJECTION_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", format: "uuid" },
		provider: { type: "string" },
		direction: { type: "string", enum: WORK_ITEM_PROJECTION_DIRECTION_ENUM },
		status: { type: "string", enum: WORK_ITEM_PROJECTION_STATUS_ENUM },
		externalId: { type: "string" },
		externalUrl: { type: "string" },
		externalProjectId: { type: "string" },
		externalSectionId: { type: "string" },
		lastSyncedAt: { type: "string" },
		lastError: { anyOf: [{ type: "string" }, { type: "null" }] },
		syncCursor: { type: "string" },
		providerState: { type: "object", additionalProperties: true },
	},
	required: ["id", "provider"],
	additionalProperties: false,
};

const GET_WORK_GRAPH_HEALTH_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(
		procedureInputSchema(workItemsContract.getWorkGraphHealth),
	);
const RUN_WORK_GRAPH_STEWARD_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(
		procedureInputSchema(workItemsContract.runWorkGraphSteward),
	);
const GET_ORG_GRAPH_HEALTH_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(
		procedureInputSchema(workItemsContract.getOrgGraphHealth),
	);
const ATTACH_SOURCE_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.attachWorkItemSource),
);
const LIST_SOURCES_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.listWorkItemSources),
);
const RECONCILE_SOURCES_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.reconcileWorkItemSources),
);
export const WORK_ITEM_TOOLS: TediToolSpec[] = [
	{
		name: "work_items_list",
		remoteName: "work_items_list",
		description:
			"List canonical Tedix Work Items for this tedi's organization.",
		inputSchema: WORK_ITEMS_LIST_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "workItems/list",
		// This is an organization-scoped projection. The selected aggregate
		// tedi authenticates the caller but is not part of the list contract.
		includeTediIdParam: false,
		requiresHydratedTedi: true,
	},
	{
		name: "work_item_get",
		remoteName: "work_item_get",
		description:
			"Read one Work Item thread, including its bounded evidence ledger, comments, and external provider projections. Reviewers should use this exact read before deciding evidence.",
		inputSchema: WORK_ITEM_ID_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "workItems/getById",
	},
	{
		name: "get_work_graph_health",
		remoteName: "get_work_graph_health",
		description:
			"Deterministic coherence report over this org's Work Item/project graph. Read-only; each scan is windowed and `truncated` flags a cap hit.",
		inputSchema: GET_WORK_GRAPH_HEALTH_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "workItems/getWorkGraphHealth",
		includeTediIdParam: false,
	},
	{
		name: "run_work_graph_steward",
		remoteName: "run_work_graph_steward",
		description:
			"Detect then (when `apply` is true) SAFELY repair the org work graph: link near-duplicate clusters, transition long-idle unclaimed items to `stale`, and leave `steward_flag` comments on naming/orphan findings. Never cancels a duplicate, deletes, or rewrites titles. `apply=false` (default) previews. Idempotent across re-runs.",
		inputSchema: RUN_WORK_GRAPH_STEWARD_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "workItems/runWorkGraphSteward",
		includeTediIdParam: false,
	},
	{
		name: "get_org_graph_health",
		remoteName: "get_org_graph_health",
		description:
			"Blocked-work dependency analysis over this org's `blocks` graph — the planning-layer 'digital twin' read. Surfaces root blockers (chain heads ranked by transitive downstream impact, via a recursive CTE) with their owners, the blocker tedis holding up the most work (who to unblock first), and a best-effort capability-stall rollup by value-stream/pace-layer. Sibling of get_work_graph_health (coherence) but for dependency stalls. Read-only, org-scoped, cycle-safe, capped.",
		inputSchema: GET_ORG_GRAPH_HEALTH_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "workItems/getOrgGraphHealth",
		includeTediIdParam: false,
	},
	{
		name: "attach_work_item_source",
		remoteName: "attach_work_item_source",
		description:
			"Attach an external source (Notion page, Gmail thread, Drive file) to a project or Work Item as a source-graph edge. Stores IDENTITY only — provider, external id, url, title, and a caller-computed content hash — never the source content, so the connector stays the system of record. Idempotent: re-attaching an unchanged hash refreshes the freshness check, a moved hash flags the source changed, and a tombstoned source is revived.",
		inputSchema: ATTACH_SOURCE_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/attachWorkItemSource",
	},
	{
		name: "list_work_item_sources",
		remoteName: "list_work_item_sources",
		description:
			"List the external sources attached to a project or Work Item, with a freshness report (counts by state, oldest check, never-checked). Tombstoned sources are excluded by default so a brief never renders a dead link.",
		inputSchema: LIST_SOURCES_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "workItems/listWorkItemSources",
	},
	{
		name: "reconcile_work_item_sources",
		remoteName: "reconcile_work_item_sources",
		description:
			"Reconcile attached sources against what a sweep observed. Pass EVERY external id seen for the provider: anything attached and absent is marked missing, then tombstoned once it has stayed missing past the grace window. Absence means deletion, so never call this with a partial result set — skip the provider instead. Supports dryRun.",
		inputSchema: RECONCILE_SOURCES_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/reconcileWorkItemSources",
	},
	{
		name: "work_item_create",
		remoteName: "work_item_create",
		description:
			"Create a provider-neutral Tedix Work Item from conversation, planning, or execution evidence. Purpose context is required: supply objectiveId, inherit it from projectId/parentWorkItemId, or supply maintenance/incident/hygiene workClass plus purposeExceptionExpiresAt no more than 30 days out.",
		inputSchema: WORK_ITEM_CREATE_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/create",
	},
	{
		name: "work_item_comment",
		remoteName: "work_item_comment",
		description:
			"Append human-readable discussion to a Work Item. Lifecycle state belongs to immutable events, attempts, and evidence.",
		inputSchema: WORK_ITEM_COMMENT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/addComment",
		staticParams: { authorType: "tedi" },
		tediIdDefaultParams: ["authorId"],
	},
	{
		name: "get_work_item_readiness",
		remoteName: "get_work_item_readiness",
		description:
			"Derive whether a Work Item is ready from disposition, dependencies, capabilities, authority, budget, resources, and live attempts.",
		inputSchema: GET_READINESS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "workItems/getReadiness",
		includeTediIdParam: false,
	},
	{
		name: "start_work_attempt",
		remoteName: "start_work_attempt",
		description:
			"Atomically start a fenced execution attempt for this tedi after readiness admission.",
		inputSchema: START_ATTEMPT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/startAttempt",
		includeTediIdParam: false,
		credentialDerivedTediActor: true,
	},
	{
		name: "heartbeat_work_attempt",
		remoteName: "heartbeat_work_attempt",
		description:
			"Heartbeat the exact active attempt fence; stale or expired attempts are rejected.",
		inputSchema: HEARTBEAT_ATTEMPT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/heartbeatAttempt",
		includeTediIdParam: false,
		credentialDerivedTediActor: true,
	},
	{
		name: "settle_work_attempt",
		remoteName: "settle_work_attempt",
		description:
			"Settle or durably park the exact fenced attempt without completing the Work Item outcome.",
		inputSchema: SETTLE_ATTEMPT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/settleAttempt",
		includeTediIdParam: false,
		credentialDerivedTediActor: true,
	},
	{
		name: "list_work_attempts",
		remoteName: "list_work_attempts",
		description: "List immutable execution attempts for one Work Item.",
		inputSchema: LIST_ATTEMPTS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "workItems/listAttempts",
		includeTediIdParam: false,
	},
	{
		name: "submit_work_evidence",
		remoteName: "submit_work_evidence",
		description:
			"Submit typed evidence from the exact active attempt against one acceptance claim.",
		inputSchema: SUBMIT_EVIDENCE_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/submitEvidence",
		includeTediIdParam: false,
		credentialDerivedTediActor: true,
	},
	{
		name: "complete_work_item",
		remoteName: "complete_work_item",
		description:
			"Complete an accepted Work Item once its Attempt has settled. Settled means done: no evidence count or review stands in front of completion.",
		inputSchema: COMPLETE_WORK_ITEM_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/complete",
		includeTediIdParam: false,
		credentialDerivedTediActor: true,
	},
	{
		name: "list_work_evidence",
		remoteName: "list_work_evidence",
		description: "List evidence and verifier dispositions for one Work Item.",
		inputSchema: LIST_EVIDENCE_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "workItems/listEvidence",
		includeTediIdParam: false,
	},
	{
		name: "list_work_events",
		remoteName: "list_work_events",
		description: "Read the append-only Work Item lifecycle event stream.",
		inputSchema: LIST_EVENTS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "workItems/listEvents",
		includeTediIdParam: false,
	},
	{
		name: "work_item_corroborate",
		remoteName: "work_item_corroborate",
		description:
			"Corroborate an existing Work Item with an independently observed source reference.",
		inputSchema: WORK_ITEM_CORROBORATE_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/corroborate",
		includeTediIdParam: false,
	},
	{
		name: "work_item_add_relation",
		remoteName: "work_item_add_relation",
		description:
			"Relate two Work Items as blockers, duplicates, or references.",
		inputSchema: WORK_ITEM_RELATION_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/addRelation",
	},
	{
		name: "work_item_upsert_projection",
		remoteName: "work_item_upsert_projection",
		description:
			"Attach or update an external task/project-management provider reference for a Work Item.",
		inputSchema: WORK_ITEM_PROJECTION_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/upsertProjection",
	},
];
