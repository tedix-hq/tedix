import { projectsContract } from "@tedix/api-contract/contracts/projects";
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import {
	DESTRUCTIVE,
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";

// Work hierarchy v1 projects (project → epic → story container + rollup).
// Org-scoped surface: projects have no tediId, so the selected tedi's id is
// never injected (includeTediIdParam: false) — mirroring CAPABILITY_MAP_TOOLS.
const CREATE_PROJECT_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(projectsContract.create),
);
const UPDATE_PROJECT_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(projectsContract.update),
);
const ARCHIVE_PROJECT_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(projectsContract.archive),
);
const LIST_PROJECTS_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(projectsContract.list),
);
const GET_PROJECT_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(projectsContract.get),
);
const GET_PROJECT_ROLLUP_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(projectsContract.getRollup),
);

export const PROJECT_TOOLS: TediToolSpec[] = [
	{
		name: "create_project",
		remoteName: "create_project",
		description:
			"Create an org-scoped project — the top of the work hierarchy (project → epic → feature → story → work_item → task). `key` is unique per org.",
		inputSchema: CREATE_PROJECT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "projects/create",
		includeTediIdParam: false,
	},
	{
		name: "update_project",
		remoteName: "update_project",
		description:
			"Update a project: name, description, status, lead tedi, owner, objective, target date, or metadata.",
		inputSchema: UPDATE_PROJECT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "projects/update",
		includeTediIdParam: false,
	},
	{
		name: "archive_project",
		remoteName: "archive_project",
		description:
			"Soft-archive a project (status=archived; audit-preserving — work items keep their projectId).",
		inputSchema: ARCHIVE_PROJECT_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "projects/archive",
		includeTediIdParam: false,
	},
	{
		name: "list_projects",
		remoteName: "list_projects",
		description:
			"List this organization's projects (flat, with an optional status filter).",
		inputSchema: LIST_PROJECTS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "projects/list",
		includeTediIdParam: false,
	},
	{
		name: "get_project",
		remoteName: "get_project",
		description: "Get one org-scoped project by id.",
		inputSchema: GET_PROJECT_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "projects/get",
		includeTediIdParam: false,
	},
	{
		name: "get_project_rollup",
		remoteName: "get_project_rollup",
		description:
			"Roll up the bounded Work Items grouped under one project: counts by disposition and work kind, completion percentage, aggregate disposition, distinct executors, and top-level items. The result reports when its capped scan was truncated.",
		inputSchema: GET_PROJECT_ROLLUP_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "projects/getRollup",
		includeTediIdParam: false,
	},
];
