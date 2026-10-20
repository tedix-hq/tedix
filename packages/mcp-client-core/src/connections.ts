import type {
	Client,
	PriorDiscovery,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
	McpConnection,
	McpGuidanceInfo,
	McpPromptInfo,
	McpResourceInfo,
	McpResourceTemplateInfo,
	McpServerConfig,
	McpToolInfo,
} from "./types";

export interface ConnectionSnapshot {
	mode: "sdk" | "stateless";
	config: McpServerConfig;
	info: McpConnection;
	tools: McpToolInfo[];
	resources: McpResourceInfo[];
	resourceTemplates: McpResourceTemplateInfo[];
	prompts: McpPromptInfo[];
	guidance: McpGuidanceInfo[];
	/**
	 * Extension capabilities the server declared during negotiation —
	 * `server/discover` for stateless connections, the (legacy) `initialize`
	 * result for SDK connections. Gates extension-scoped methods such as the
	 * skills extension's `resources/directory/read`.
	 */
	extensions: Record<string, Record<string, unknown>>;
}

export interface SdkManagedConnection extends ConnectionSnapshot {
	mode: "sdk";
	client: Client;
	transport: StreamableHTTPClientTransport;
	authContextKey: string;
	priorDiscoveryExpiresAt: number;
}

export interface StatelessManagedConnection extends ConnectionSnapshot {
	mode: "stateless";
}

export type ManagedConnection =
	| SdkManagedConnection
	| StatelessManagedConnection;

export type TaskSubscription = {
	next(timeoutMs: number): Promise<Record<string, unknown> | null>;
	close(): void;
};

export interface BoundedPriorDiscovery {
	prior: PriorDiscovery;
	authContextKey: string;
	expiresAt: number;
}

export interface DiscoveryNegotiation {
	modern: boolean;
	completions: boolean;
	extensions: Record<string, Record<string, unknown>>;
	ttlMs: number;
	digest?: string;
	expiresAt: number;
}

export interface StatelessRequestContext {
	headers: Record<string, string>;
	negotiation: DiscoveryNegotiation;
}

export type McpListKey =
	| "tools"
	| "resources"
	| "resourceTemplates"
	| "prompts"
	| "skills";

export type McpListSnapshots = Pick<
	ConnectionSnapshot,
	"tools" | "resources" | "resourceTemplates" | "prompts" | "extensions"
> & {
	capabilities: NonNullable<McpConnection["capabilities"]>;
};
