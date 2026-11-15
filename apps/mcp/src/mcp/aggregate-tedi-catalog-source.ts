// Build-time catalog source; the request path reads its generated snapshot.
import { BROWSER_TOOLS } from "./aggregate-tedis-browser";
import { CAPABILITY_MAP_TOOLS } from "./aggregate-tedis-capabilities";
import {
	COLLABORATION_TOOLS,
	CONVERSATIONS_LIST_SCHEMA,
	MESSAGING_TOOLS,
} from "./aggregate-tedis-collaboration";
import { EMAIL_TOOLS } from "./aggregate-tedis-email";
import { GOVERNANCE_TOOLS } from "./aggregate-tedis-governance";
import { HARNESS_TOOLS } from "./aggregate-tedis-harness";
import { KERNEL_RUNTIME_TOOLS } from "./aggregate-tedis-kernel-runtime";
import { MEMORY_TOOLS, RATIONALE_MUSCLE_TOOLS } from "./aggregate-tedis-memory";
import { PAYMENT_TOOLS } from "./aggregate-tedis-payments";
import { PROJECT_TOOLS } from "./aggregate-tedis-projects";
import { ROLE_TEMPLATE_TOOLS } from "./aggregate-tedis-role-templates";
import { READ_ONLY, type TediToolSpec } from "./aggregate-tedis-shared";
import {
	SKILL_WORKFLOW_OUTPUT_SCHEMAS,
	SKILL_WORKFLOW_TOOLS,
} from "./aggregate-tedis-skill-workflows";
import { WORK_ITEM_TOOLS } from "./aggregate-tedis-work-items";
import { WORKSPACE_TOOLS } from "./aggregate-tedis-workspace";
import { COMPUTER_TOOLS } from "./aggregate-tedis-computer";

const FULL_TEDI_TOOLS: TediToolSpec[] = [
	{
		name: "conversations_list",
		remoteName: "conversations_list",
		description:
			"List cognitive-runtime conversations, including channel-backed and internal agent sessions.",
		inputSchema: CONVERSATIONS_LIST_SCHEMA,
		annotations: READ_ONLY,
	},
	{
		name: "conversation_get",
		remoteName: "conversation_get",
		description: "Get one cognitive-runtime conversation by session key.",
		inputSchema: {
			type: "object",
			properties: { session_key: { type: "string" } },
			required: ["session_key"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	...COLLABORATION_TOOLS.filter(
		(tool) => !["ask", "conversations_list"].includes(tool.name),
	),
	...SKILL_WORKFLOW_TOOLS,
	...CAPABILITY_MAP_TOOLS,
	...GOVERNANCE_TOOLS,
	...PROJECT_TOOLS,
	...ROLE_TEMPLATE_TOOLS,
	...WORKSPACE_TOOLS,
	...MESSAGING_TOOLS,
	...COMPUTER_TOOLS,
	...MEMORY_TOOLS,
	...BROWSER_TOOLS,
	...EMAIL_TOOLS,
	...WORK_ITEM_TOOLS,
	...HARNESS_TOOLS,
	...KERNEL_RUNTIME_TOOLS,
	...RATIONALE_MUSCLE_TOOLS,
	...PAYMENT_TOOLS,
];

export const aggregateTediCatalog = {
	full: FULL_TEDI_TOOLS,
	collaboration: COLLABORATION_TOOLS,
	skills: SKILL_WORKFLOW_TOOLS,
	outputs: SKILL_WORKFLOW_OUTPUT_SCHEMAS,
};
