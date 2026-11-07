import type { AzureGatewayEnv } from "./model";

/** Bindings this worker runs with; `worker-configuration.d.ts` is the generated truth. */
export type WorkspaceEnv = Cloudflare.Env &
	AzureGatewayEnv & { MIGRATE_WORKSPACES_TOKEN?: string };

export type ActorKind = "user" | "tedi" | "external_agent" | "service";

export interface WorkspaceScope {
	organizationId: string;
	workspaceId: string;
}

export interface TurnRequest {
	/** Caller-supplied for idempotent retries; generated when absent. */
	turnId?: string;
	/** Conversation to continue; null or absent creates one. */
	conversationId?: string | null;
	actorId: string;
	actorKind: ActorKind;
	text: string;
	/** Run as this tedi: its persona and recall come from its own object. */
	tediId?: string;
	/** Force the turn into its own facet (long or risky work). */
	isolate?: boolean;
}
