/** Invocation-owned elicitation; correlation alone grants no model authority. */
export type McpElicitationResolver = (input: {
	taskId: string;
	inputRequests: Record<string, unknown>;
}) => Promise<Record<string, unknown> | null>;

export interface McpServerConfig {
	url: string;
	transport?: "streamable-http";
	headers?: Record<string, string>;
	/**
	 * Optional async function that returns fresh headers for each request.
	 * Used for dynamic auth (for example Descope JWT refresh).
	 */
	headerFactory?: () => Promise<Record<string, string>>;
	/**
	 * Called before reconnect to invalidate cached credentials for this server URL.
	 * Ensures headerFactory fetches a fresh token instead of reusing a rejected one.
	 */
	onCredentialInvalidate?: (serverUrl: string) => void;
	/**
	 * MCP 2026-07-28 Tasks: when an upstream tool returns a `resultType: "task"`
	 * (or a `task` linkage), managed Tedix endpoints consume finalized
	 * `notifications/tasks` states and all endpoints retain bounded `tasks/get`
	 * polling for recovery. Tune that fallback here.
	 */
	taskPolling?: {
		/** Max `tasks/get` polls before returning the latest state. Default 30. */
		maxAttempts?: number;
		/** Upper bound applied to the server's `pollIntervalMs`. Default 2000. */
		maxIntervalMs?: number;
	};
	/**
	 * MRTR (Multi Round-Trip Requests): invoked when a polled task reaches
	 * `input_required`. Returning a map of input responses drives a `tasks/update`
	 * round-trip and continues polling; returning `null` surfaces the
	 * `input_required` task state to the caller unresolved.
	 */
	onTaskInputRequired?: McpElicitationResolver;
}

export interface McpConnection {
	serverId: string;
	url: string;
	transport: "streamable-http";
	connectedAt: string;
	serverName?: string;
	serverVersion?: string;
	capabilities?: {
		tools?: boolean;
		resources?: boolean;
		resourceTemplates?: boolean;
		prompts?: boolean;
		/** 2026-07-28 `completion/complete` (autocomplete) advertised. */
		completions?: boolean;
	};
}

export interface McpToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface McpIconInfo {
	src: string;
	mimeType?: string;
	sizes?: string[];
	theme?: "light" | "dark";
}

export interface McpToolInfo {
	serverId: string;
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	icons?: McpIconInfo[];
	annotations?: McpToolAnnotations;
	meta?: Record<string, unknown>;
	hasWidget?: boolean;
	widgetDescription?: string;
}

export interface McpResourceInfo {
	serverId: string;
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	icons?: McpIconInfo[];
	annotations?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

export interface McpResourceTemplateInfo {
	serverId: string;
	uriTemplate: string;
	name?: string;
	title?: string;
	description?: string;
	mimeType?: string;
	icons?: McpIconInfo[];
	annotations?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

export interface McpPromptArgumentInfo {
	name: string;
	description?: string;
	required?: boolean;
}

export interface McpPromptInfo {
	serverId: string;
	name: string;
	title?: string;
	description?: string;
	arguments?: McpPromptArgumentInfo[];
	icons?: McpIconInfo[];
	_meta?: Record<string, unknown>;
}

export interface McpGuidanceMetadata {
	title?: string;
	summary?: string;
	description?: string;
	version?: string;
	tags?: string[];
	dependencies?: string[];
	provenance?: string;
	source?: string;
	audience?: string[];
}

export interface McpGuidanceInfo {
	serverId: string;
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	kind: "skill" | "guide" | "policy";
	summary: string;
	sourceUrl: string;
	serverName?: string;
	serverVersion?: string;
	metadata?: McpGuidanceMetadata;
}
