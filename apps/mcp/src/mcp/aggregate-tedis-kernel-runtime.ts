// Home/kernel runtime tool specs: transcript/run reads, approvals, steering,
// and the org-scoped home-namespace Work Item write mirror.
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import { workItemsContract } from "@tedix/api-contract/contracts/work-items";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import {
	DESTRUCTIVE,
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";

const HOME_MESSAGES_READ_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		conversationId: { type: "string", default: "home:main" },
		limit: { type: "integer", minimum: 1, maximum: 500 },
		cursor: { type: "string" },
	},
	additionalProperties: false,
};

const HOME_RUN_SET_READ_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		conversationId: { type: "string", default: "home:main" },
		limit: { type: "integer", minimum: 1, maximum: 100 },
		// Curated specs are additionalProperties:false, so a contract-side input
		// is unreachable from this surface until it is mirrored here — the D1
		// schema sync does not touch these hardcoded schemas, and an unmirrored
		// field is silently stripped at the edge.
		summary: {
			type: "boolean",
			description:
				"Compact projection for agent context budgets: omits per-run metadata bags and the approvalMirrors rendering projection; identity, status, timing, progress, and usage survive.",
		},
	},
	additionalProperties: false,
};

const HOME_RUN_READ_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
	},
	required: ["runId"],
	additionalProperties: false,
};

const HOME_PLAN_APPROVE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
		assignmentIds: {
			type: "array",
			items: { type: "string", minLength: 1 },
		},
		dispatch: { type: "boolean" },
		approvalNote: { type: "string", maxLength: 2000 },
	},
	required: ["runId"],
	additionalProperties: false,
};

const HOME_APPROVAL_RESPOND_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
		decision: { type: "string", enum: ["approve", "reject"] },
		assignmentIds: {
			type: "array",
			items: { type: "string" },
		},
		note: { type: "string", maxLength: 2000 },
	},
	required: ["runId", "decision"],
	additionalProperties: false,
};

const HOME_RUN_CANCEL_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
		reason: { type: "string", maxLength: 2000 },
	},
	required: ["runId"],
	additionalProperties: false,
};

const HOME_RUN_STEER_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
		instruction: { type: "string", minLength: 1, maxLength: 4000 },
	},
	required: ["runId", "instruction"],
	additionalProperties: false,
};

const HOME_DELEGATION_RETRY_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		workItemId: { type: "string", minLength: 1 },
	},
	required: ["workItemId"],
	additionalProperties: false,
};

// Org-scoped Work Item write schemas for the home-namespace mirror (no tedi
// identity, no `assignToSelf`: org rides X-Tedix-Org-Id and is enforced
// server-side). These mirror the canonical home-surface.ts tools so the
// per-tedi aggregate carries the same write surface as the home__* tools.
const HOME_WORK_ITEM_CREATE_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.create),
);
const HOME_WORK_ITEM_UPDATE_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.updateSpecification),
);
const HOME_WORK_ITEM_CANCEL_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.cancel),
);

export const KERNEL_RUNTIME_TOOLS: TediToolSpec[] = [
	{
		name: "read_home_messages",
		remoteName: "read_home_messages",
		description:
			"Read the tenant Home transcript for plan, approval, and async delegation proof.",
		inputSchema: HOME_MESSAGES_READ_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readMessages",
	},
	{
		name: "read_home_run_set",
		remoteName: "read_home_run_set",
		description:
			"Read Home's durable run set, including plan metadata, delegated child links, progress, and active run ids.",
		inputSchema: HOME_RUN_SET_READ_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readRunSet",
	},
	{
		name: "read_home_run",
		remoteName: "read_home_run",
		description:
			"Inspect one parent Home run by runId: status, typed route, child-run links, progress, and evidence.",
		inputSchema: HOME_RUN_READ_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readRun",
	},
	{
		name: "approve_home_plan",
		remoteName: "approve_home_plan",
		description:
			"Approve proposed Home plan assignments, promote them into Work Items, and optionally dispatch delegated child runs.",
		inputSchema: HOME_PLAN_APPROVE_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/approvePlanAssignments",
	},
	{
		name: "respond_home_approval",
		remoteName: "respond_home_approval",
		description:
			"Approve or reject what a Home run is waiting on: write-action cards, delegation approvals, workstation attachments, and proposed plans.",
		inputSchema: HOME_APPROVAL_RESPOND_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/respondApproval",
	},
	{
		name: "cancel_home_run",
		remoteName: "cancel_home_run",
		description:
			"Stop a parent Home run by runId without killing the whole Home conversation.",
		inputSchema: HOME_RUN_CANCEL_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "kernelRuntime/cancelRun",
	},
	{
		name: "steer_home_run",
		remoteName: "steer_home_run",
		description:
			"Attach an operator steering instruction to an active parent Home run or work card.",
		inputSchema: HOME_RUN_STEER_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/steerRun",
	},
	{
		name: "retry_delegation",
		remoteName: "retry_delegation",
		description:
			"Recover a proof-gate BLOCKED delegation Work Item: operator-gated re-dispatch, bounded by MAX_DELEGATION_RETRIES.",
		inputSchema: HOME_DELEGATION_RETRY_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/retryDelegation",
	},
	{
		name: "create_work_item",
		remoteName: "create_work_item",
		description:
			"Track a NEW provider-neutral organization Work Item from the operator/Home surface without borrowing a tedi identity. Purpose context is required: supply objectiveId, inherit it from projectId/parentWorkItemId, or supply maintenance/incident/hygiene workClass plus purposeExceptionExpiresAt no more than 30 days out. The caller's org is resolved from the request; an optional assigneeTediId is org-checked.",
		inputSchema: HOME_WORK_ITEM_CREATE_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: MUTATING,
		rpcEndpoint: "workItems/create",
	},
	{
		name: "update_work_item",
		remoteName: "update_work_item",
		description:
			"Update descriptive Work Item specification fields. Disposition, readiness, attempts, and evidence use their dedicated lifecycle operations.",
		inputSchema: HOME_WORK_ITEM_UPDATE_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: MUTATING,
		rpcEndpoint: "workItems/updateSpecification",
	},
	{
		name: "cancel_work_item",
		remoteName: "cancel_work_item",
		description:
			"Cancel a single organization Work Item specification. Existing attempt and evidence history remains immutable.",
		inputSchema: HOME_WORK_ITEM_CANCEL_SCHEMA,
		allowExplicitTediId: false,
		includeTediIdParam: false,
		annotations: MUTATING,
		rpcEndpoint: "workItems/cancel",
	},
];
