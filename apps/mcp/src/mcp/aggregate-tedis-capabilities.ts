import { capabilitiesContract } from "@tedix/api-contract/contracts/capabilities";
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import {
	DESTRUCTIVE,
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";

// Business capability map (flywheel P5 #2). Org-scoped surface: capabilities
// have no tediId, so the selected tedi's id is never injected
// (includeTediIdParam: false) — mirroring get_skill_portfolio_balance.
const CREATE_CAPABILITY_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(capabilitiesContract.create),
);
const UPDATE_CAPABILITY_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(capabilitiesContract.update),
);
const ARCHIVE_CAPABILITY_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(capabilitiesContract.archive),
);
const LIST_CAPABILITIES_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(capabilitiesContract.list),
);
const CAPABILITY_TREE_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(capabilitiesContract.tree),
);
const CAPABILITY_COVERAGE_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(procedureInputSchema(capabilitiesContract.coverage));
const CAPABILITY_UNMAPPED_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(procedureInputSchema(capabilitiesContract.unmapped));
const LINK_CAPABILITY_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(capabilitiesContract.link),
);
const UNLINK_CAPABILITY_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(capabilitiesContract.unlink),
);

export const CAPABILITY_MAP_TOOLS: TediToolSpec[] = [
	{
		name: "create_capability",
		remoteName: "create_capability",
		description:
			"Create a business capability (value-stream-derived, max tree depth 3) in this organization's capability map.",
		inputSchema: CREATE_CAPABILITY_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "capabilities/create",
		includeTediIdParam: false,
	},
	{
		name: "update_capability",
		remoteName: "update_capability",
		description:
			"Update a business capability: name, slug, description, value stream, pace layer, maturity score, or parent (re-parenting re-validates the depth-3 ceiling).",
		inputSchema: UPDATE_CAPABILITY_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "capabilities/update",
		includeTediIdParam: false,
	},
	{
		name: "archive_capability",
		remoteName: "archive_capability",
		description:
			"Soft-archive a business capability and its whole subtree (audit-preserving; links stay in place).",
		inputSchema: ARCHIVE_CAPABILITY_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "capabilities/archive",
		includeTediIdParam: false,
	},
	{
		name: "list_capabilities",
		remoteName: "list_capabilities",
		description:
			"List this organization's business capabilities (flat, with status/paceLayer/parent filters).",
		inputSchema: LIST_CAPABILITIES_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "capabilities/list",
		includeTediIdParam: false,
	},
	{
		name: "get_capability_tree",
		remoteName: "get_capability_tree",
		description:
			"Get the organization's business capability tree (value-stream roots, max depth 3).",
		inputSchema: CAPABILITY_TREE_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "capabilities/tree",
		includeTediIdParam: false,
	},
	{
		name: "get_capability_coverage",
		remoteName: "get_capability_coverage",
		description:
			"Per-capability coverage report: linked skill count, skill lifecycle/pace-layer maturity mix, linked tedis, objectives, and apps.",
		inputSchema: CAPABILITY_COVERAGE_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "capabilities/coverage",
		includeTediIdParam: false,
	},
	{
		name: "list_unmapped_capability_entities",
		remoteName: "list_unmapped_capability_entities",
		description:
			"List skills and active objectives with NO capability link — the relevance-filter gap list for pattern mining.",
		inputSchema: CAPABILITY_UNMAPPED_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "capabilities/unmapped",
		includeTediIdParam: false,
	},
	{
		name: "link_capability",
		remoteName: "link_capability",
		description:
			"Link a skill, app, tedi, or objective to a business capability (idempotent).",
		inputSchema: LINK_CAPABILITY_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "capabilities/link",
		includeTediIdParam: false,
	},
	{
		name: "unlink_capability",
		remoteName: "unlink_capability",
		description:
			"Remove a capability↔entity link (idempotent — removed: false when absent).",
		inputSchema: UNLINK_CAPABILITY_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "capabilities/unlink",
		includeTediIdParam: false,
	},
];
