// Memory, brain diagnostics, rationale, and muscle-memory tool specs.
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { memoryEntitiesContract } from "@tedix/api-contract/contracts/memory-entities";
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import { READ_ONLY, type TediToolSpec } from "./aggregate-tedis-shared";

export const MEMORY_SEARCH_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		query: { type: "string" },
		domain: { type: "string" },
		factType: { type: "string" },
		minConfidence: { type: "number" },
		topK: { type: "number" },
		includeRelated: { type: "boolean" },
	},
	required: ["query"],
	additionalProperties: false,
};

export const REVIEW_MEMORY_FACT_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		factId: {
			type: "string",
			minLength: 1,
			description: "Memory fact id to review.",
		},
		reviewStatus: {
			type: "string",
			enum: [
				"pending",
				"confirmed",
				"evidence_only",
				"restricted",
				"stale",
				"disputed",
				"rejected",
				"superseded",
			],
		},
		usePolicy: {
			type: "string",
			enum: [
				"can_use_as_instruction",
				"can_use_as_evidence",
				"requires_user_confirmation",
				"do_not_inject_automatically",
			],
		},
		priority: { type: "string", enum: ["core", "active", "background"] },
		visibility: { type: "string", enum: ["private", "shared", "org"] },
		topicKey: { type: "string", minLength: 1 },
		archived: {
			type: "boolean",
			description: "Set true to soft-archive the fact, false to unarchive it.",
		},
		reason: { type: "string", minLength: 1, maxLength: 2000 },
	},
	required: ["factId"],
	additionalProperties: false,
};

export const RATIONALE_CHAIN_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		limit: {
			type: "number",
			minimum: 1,
			maximum: 100,
			description:
				"Maximum rationale records to return (default: 20, max: 100).",
		},
	},
	additionalProperties: false,
};

export const RATIONALE_CHAIN_LAYOUT_SPEC: Record<string, JsonValue> = {
	root: "shell",
	elements: {
		shell: {
			type: "Stack",
			props: { gap: 4 },
			children: ["summary", "records"],
		},
		summary: {
			type: "KeyValuePanel",
			props: {
				variant: "plain",
				columns: 2,
				items: [
					{ label: "Records", value: { $state: "/json/data/length" } },
					{ label: "Source", value: "CTO MCP" },
				],
			},
			children: [],
		},
		records: {
			type: "DataTable",
			props: {
				data: { $state: "/json/data" },
				columns: [
					{ field: "action", header: "Action", format: "text", sortable: true },
					{
						field: "category",
						header: "Category",
						format: "badge",
						sortable: true,
					},
					{
						field: "outcomeStatus",
						header: "Outcome",
						format: "badge",
						sortable: true,
					},
					{
						field: "confidence",
						header: "Confidence",
						format: "number",
						sortable: true,
					},
					{
						field: "createdAt",
						header: "Created",
						format: "dateTime",
						sortable: true,
					},
				],
			},
			children: [],
		},
	},
};

export const MEMORY_TOOLS: TediToolSpec[] = [
	{
		// Body-neutral read: routed through apps/api `memoryGraph/graph/traverse`
		// → canonical Neo4j graph. Traversal is fact-scoped (startFactId), not
		// tedi-scoped, so suppress tediId injection.
		name: "memory_graph_query",
		remoteName: "memory_graph_query",
		description:
			"Traverse the tedi's Neo4j context graph from a starting fact.",
		inputSchema: {
			type: "object",
			properties: {
				startFactId: { type: "string" },
				maxDepth: { type: "number" },
				maxNodes: { type: "number" },
			},
			required: ["startFactId"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
		rpcEndpoint: "memoryGraph/graph/traverse",
		includeTediIdParam: false,
	},
];

export const RATIONALE_MUSCLE_TOOLS: TediToolSpec[] = [];

/**
 * Entity-mention recording. Derived from the contract so the projected schema
 * cannot drift from the procedure it calls.
 */
export const RECORD_ENTITY_MENTION_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(
		procedureInputSchema(memoryEntitiesContract.recordMention),
	);
