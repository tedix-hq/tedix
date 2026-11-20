type JsonSchema = Record<string, unknown>;

const uuid = { type: "string", format: "uuid" } as const;
const emptyInput = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;
const readAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	openWorldHint: false,
} as const;
const writeAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	openWorldHint: false,
} as const;

export interface DirectoryMcpToolDefinition {
	toolId: string;
	title: string;
	description: string;
	endpoint: string | null;
	inputSchema: JsonSchema;
	annotations: typeof readAnnotations | typeof writeAnnotations;
	writeCapability: "read" | "write";
	scope: "mcp:content.read" | "mcp:work.read" | "mcp:work.write" | null;
}

export const DIRECTORY_MCP_SURFACE_VERSION = 1;

/** Versioned public-directory surface; installation supplies app and organization IDs. */
export const DIRECTORY_MCP_SURFACE = {
	version: DIRECTORY_MCP_SURFACE_VERSION,
	app: {
		slug: "directory",
		name: "Tedix",
		description: "Read shared Tedix work and propose bounded updates.",
		mcpConfig: {
			codeMode: false,
			bootstrapInfo: {
				toolId: "get_connection_info",
				title: "Tedix connection details",
				description:
					"Shows which Tedix organizations this connection can reach, the Tedix server version, and the views available (Deck, Feed). Use when the user asks what Tedix can do or which organizations are connected. Does not read tasks, documents or other organization data.",
				responseMode: "connection",
				views: [
					{ id: "deck", label: "Deck", tool: "show_deck" },
					{ id: "feed", label: "Feed", tool: "show_feed" },
				],
			},
			toolScopes: {
				list_work_items: ["mcp:work.read"],
				get_work_item: ["mcp:work.read"],
				list_work_item_events: ["mcp:work.read"],
				wait_work_item: ["mcp:work.read"],
				list_work_item_evidence: ["mcp:work.read"],
				list_workspaces: ["mcp:content.read"],
				get_workspace_output: ["mcp:content.read"],
				show_deck: ["mcp:work.read"],
				show_feed: ["mcp:work.read"],
				add_work_item_comment: ["mcp:work.write"],
				create_work_item: ["mcp:work.write"],
			},
		},
	},
	tools: [
		{
			toolId: "get_profile",
			title: "Tedix account profile",
			description: "Shows which Tedix account is connected.",
			endpoint: null,
			inputSchema: emptyInput,
			annotations: readAnnotations,
			writeCapability: "read",
			scope: null,
		},
		{
			toolId: "get_connection_info",
			title: "Tedix connection details",
			description:
				"Shows connected organizations, the server version, and available views without reading organization data.",
			endpoint: null,
			inputSchema: emptyInput,
			annotations: readAnnotations,
			writeCapability: "read",
			scope: null,
		},
		{
			toolId: "list_work_items",
			title: "List Work Items",
			description: "Find shared tasks in the connected Tedix organization.",
			endpoint: "workItems/list",
			inputSchema: {
				type: "object",
				properties: {
					disposition: {
						type: "string",
						enum: ["proposed", "accepted", "completed", "cancelled"],
					},
					projectId: uuid,
					titleContains: { type: "string", minLength: 1, maxLength: 200 },
					limit: { type: "integer", minimum: 1, maximum: 100 },
					offset: { type: "integer", minimum: 0 },
				},
				additionalProperties: false,
			},
			annotations: readAnnotations,
			writeCapability: "read",
			scope: "mcp:work.read",
		},
		{
			toolId: "get_work_item",
			title: "Get Work Item",
			description: "Read one task and its current state by ID.",
			endpoint: "workItems/getById",
			inputSchema: {
				type: "object",
				properties: {
					id: {
						type: "string",
						pattern: "^[a-fA-F0-9]{8}(?:[a-fA-F0-9-]{0,27})$",
					},
				},
				required: ["id"],
				additionalProperties: false,
			},
			annotations: readAnnotations,
			writeCapability: "read",
			scope: "mcp:work.read",
		},
		{
			toolId: "wait_work_item",
			title: "Wait for Work changes",
			description:
				"Wait up to 25 seconds for new Work events, run messages or answers. Omit cursor to start from now. Preserve the returned cursor for the next wait; read changed record IDs for canonical content. A timeout returns reason timeout.",
			endpoint: "workItems/wait",
			inputSchema: {
				type: "object",
				properties: {
					id: uuid,
					timeoutMs: { type: "integer", minimum: 0, maximum: 25000 },
					cursor: {
						type: "object",
						properties: {
							workItemId: uuid,
							event: { type: "integer", minimum: 0 },
							message: { type: "integer", minimum: 0 },
							response: { type: "integer", minimum: 0 },
						},
						required: ["workItemId", "event", "message", "response"],
						additionalProperties: false,
					},
				},
				required: ["id"],
				additionalProperties: false,
			},
			annotations: readAnnotations,
			writeCapability: "read",
			scope: "mcp:work.read",
		},
		{
			toolId: "list_work_item_events",
			title: "List Work Item events",
			description:
				"Read comments, acceptance, attempts, and other task history.",
			endpoint: "workItems/listEvents",
			inputSchema: {
				type: "object",
				properties: {
					id: uuid,
					afterSequence: { type: "integer", minimum: 0 },
					limit: { type: "integer", minimum: 1, maximum: 200 },
				},
				required: ["id"],
				additionalProperties: false,
			},
			annotations: readAnnotations,
			writeCapability: "read",
			scope: "mcp:work.read",
		},
		{
			toolId: "list_work_item_evidence",
			title: "List Work Item evidence",
			description: "Read evidence recorded for one task.",
			endpoint: "workItems/listEvidence",
			inputSchema: {
				type: "object",
				properties: {
					id: uuid,
					cursor: { type: "string", maxLength: 2000 },
					limit: { type: "integer", minimum: 1, maximum: 100 },
				},
				required: ["id"],
				additionalProperties: false,
			},
			annotations: readAnnotations,
			writeCapability: "read",
			scope: "mcp:work.read",
		},
		{
			toolId: "list_workspaces",
			title: "List workspaces",
			description: "Find a Tedix workspace by name or lifecycle status.",
			endpoint: "osWorkspaces/workspaces/list",
			inputSchema: {
				type: "object",
				properties: {
					status: { type: "string", enum: ["active", "archived"] },
					search: { type: "string", maxLength: 200 },
					limit: { type: "integer", minimum: 1, maximum: 100 },
					offset: { type: "integer", minimum: 0 },
				},
				additionalProperties: false,
			},
			annotations: readAnnotations,
			writeCapability: "read",
			scope: "mcp:content.read",
		},
		{
			toolId: "get_workspace_output",
			title: "Get workspace output",
			description:
				"Read one document, sheet, presentation, or video and its current revision.",
			endpoint: "osWorkspaces/outputs/get",
			inputSchema: {
				type: "object",
				properties: { outputId: uuid },
				required: ["outputId"],
				additionalProperties: false,
			},
			annotations: readAnnotations,
			writeCapability: "read",
			scope: "mcp:content.read",
		},
		...(["show_deck", "show_feed"] as const).map((toolId) => ({
			toolId,
			title: toolId === "show_deck" ? "Show Decisions" : "Show Activity",
			description:
				toolId === "show_deck"
					? "Show decisions waiting for the user without deciding for them."
					: "Show recent relevant updates for the user.",
			endpoint:
				toolId === "show_deck" ? "attention/showDeck" : "attention/showFeed",
			inputSchema: {
				type: "object",
				properties: {
					projectId: uuid,
					timeZone: { type: "string", minLength: 1, maxLength: 100 },
					limit: { type: "integer", minimum: 1, maximum: 100 },
				},
				additionalProperties: false,
			},
			annotations: readAnnotations,
			writeCapability: "read" as const,
			scope: "mcp:work.read" as const,
		})),
		{
			toolId: "add_work_item_comment",
			title: "Add Work Item comment",
			description:
				"Add a comment to one task. This does not start or complete the task.",
			endpoint: "workItems/addComment",
			inputSchema: {
				type: "object",
				properties: {
					id: uuid,
					body: { type: "string", minLength: 1, maxLength: 10000 },
				},
				required: ["id", "body"],
				additionalProperties: false,
			},
			annotations: writeAnnotations,
			writeCapability: "write",
			scope: "mcp:work.write",
		},
		{
			toolId: "create_work_item",
			title: "Create Work Item proposal",
			description:
				"Propose a new task. Creation does not accept or start execution.",
			endpoint: "workItems/create",
			inputSchema: {
				type: "object",
				properties: {
					title: { type: "string", minLength: 1, maxLength: 500 },
					description: { type: "string", maxLength: 10000 },
					projectId: uuid,
					workClass: {
						type: "string",
						enum: ["maintenance", "incident", "hygiene"],
					},
					priority: {
						type: "string",
						enum: ["low", "medium", "high", "critical"],
					},
				},
				required: ["title"],
				additionalProperties: false,
			},
			annotations: writeAnnotations,
			writeCapability: "write",
			scope: "mcp:work.write",
		},
	] satisfies DirectoryMcpToolDefinition[],
} as const;
