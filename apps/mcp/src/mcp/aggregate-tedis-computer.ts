// Agent Computer projection. File inputs match the pinned Computer contract.
import {
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";

export const COMPUTER_TOOLS: TediToolSpec[] = [
	{
		name: "open_computer",
		remoteName: "open_computer",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 60_000,
		description:
			"Open or reuse the task Linux computer. Set repository:true to prepare the configured checkout; omit it for reuse or a clean shell. File tools and exec share its returned cwd.",
		inputSchema: {
			type: "object",
			properties: { repository: { type: "boolean" } },
			required: [],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "close_computer",
		remoteName: "close_computer",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 60_000,
		description:
			"Close the task computer and release its environment. Publish changes first; completed execution results remain readable.",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "exec",
		remoteName: "exec",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 60_000,
		description:
			"Run a shell command in the selected computer. Open Linux before coding with native software. Short commands return output; long commands return executionId for read_execution. Never replay an unknown outcome.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", minLength: 1 },
				env: {
					type: "object",
					propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
					additionalProperties: { type: "string" },
				},
				cwd: { type: "string" },
				timeoutMs: { type: "integer", minimum: 1000, maximum: 2160_0000 },
			},
			required: ["command"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "read_execution",
		remoteName: "read_execution",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 30_000,
		description: "Read command output and terminal exit status by executionId.",
		inputSchema: {
			type: "object",
			properties: { executionId: { type: "string", minLength: 1 } },
			required: ["executionId"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: "cancel_execution",
		remoteName: "cancel_execution",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 30_000,
		description: "Cancel a running command by executionId.",
		inputSchema: {
			type: "object",
			properties: { executionId: { type: "string", minLength: 1 } },
			required: ["executionId"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "read",
		remoteName: "read",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 30_000,
		description:
			"Read a file from the selected computer. offset is a 1-indexed line; pass offset with a nonzero byteOffset continuation.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				offset: { type: "integer", minimum: 1 },
				byteOffset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1 },
			},
			required: ["path"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: "write",
		remoteName: "write",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 30_000,
		description:
			"Write file content in the selected computer, overwriting existing content.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "edit",
		remoteName: "edit",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 30_000,
		description:
			"Apply exact, unique, non-overlapping replacements against the original file in one call.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: {
							oldText: { type: "string" },
							newText: { type: "string" },
						},
						required: ["oldText", "newText"],
						additionalProperties: false,
					},
				},
			},
			required: ["path", "edits"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "delete",
		remoteName: "delete",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 30_000,
		description:
			"Delete a file or directory. Set recursive:true for a non-empty directory.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" }, recursive: { type: "boolean" } },
			required: ["path"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "ls",
		remoteName: "ls",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 30_000,
		description:
			"List directory entries in name order; use limit and offset for pagination.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				limit: { type: "integer", minimum: 1, maximum: 1000 },
				offset: { type: "integer", minimum: 0 },
			},
			required: ["path"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: "find",
		remoteName: "find",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 30_000,
		description:
			"Find files and directories matching a glob; use the selected computer cwd as path.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", default: "/workspace" },
				pattern: { type: "string" },
				exclude: { type: "array", items: { type: "string" } },
				limit: { type: "integer", minimum: 1, maximum: 1000 },
				offset: { type: "integer", minimum: 0 },
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: "grep",
		remoteName: "grep",
		runtimeKinds: ["agent"],
		directMcpTool: true,
		timeout: 30_000,
		description:
			"Search file content with a literal query or regex and bounded context; use the selected computer cwd as path.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", default: "/workspace" },
				query: { type: "string" },
				include: { type: "string" },
				regex: { type: "boolean" },
				ignoreCase: { type: "boolean" },
				context: { type: "integer", minimum: 0, maximum: 10 },
				limit: { type: "integer", minimum: 1, maximum: 1000 },
				offset: { type: "integer", minimum: 0 },
			},
			required: ["query"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
];
