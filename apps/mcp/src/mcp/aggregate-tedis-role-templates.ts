import { roleTemplatesContract } from "@tedix/api-contract/contracts/role-templates";
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import {
	DESTRUCTIVE,
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";

// Role templates (reusable role primitive). Org-scoped provisioning tools; the
// tedi id is an explicit caller-provided input on apply (which tedi to
// provision), never injected — so includeTediIdParam: false everywhere.
const CREATE_ROLE_TEMPLATE_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(procedureInputSchema(roleTemplatesContract.create));
const LIST_ROLE_TEMPLATES_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(procedureInputSchema(roleTemplatesContract.list));
const APPLY_ROLE_TEMPLATE_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(procedureInputSchema(roleTemplatesContract.apply));

export const ROLE_TEMPLATE_TOOLS: TediToolSpec[] = [
	{
		name: "create_role_template",
		remoteName: "create_role_template",
		description:
			"Create an org-scoped role template — a reusable unit that provisions { persona + standing objectives + app-assignment tags + capability profile } onto a tedi in one apply. `key` is unique per org.",
		inputSchema: CREATE_ROLE_TEMPLATE_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "roleTemplates/create",
		includeTediIdParam: false,
	},
	{
		name: "list_role_templates",
		remoteName: "list_role_templates",
		description:
			"List this organization's role templates plus platform-wide (org-null) blueprints such as the seeded `cmo`.",
		inputSchema: LIST_ROLE_TEMPLATES_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "roleTemplates/list",
		includeTediIdParam: false,
	},
	{
		name: "apply_role_template",
		remoteName: "apply_role_template",
		description:
			"Provision a role template onto an EXISTING tedi as one unit: set persona, union app-assignment tags, set the capability profile, and reconcile standing objectives by title (create missing, update stale policy/content, skip unchanged). Managed app-assignment reconcile runs separately; setting tags is the trigger.",
		inputSchema: APPLY_ROLE_TEMPLATE_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "roleTemplates/apply",
		includeTediIdParam: false,
	},
];
