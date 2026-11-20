import type { WorkspaceModelEnv } from "./model";

/** Bindings this worker runs with; `worker-configuration.d.ts` is the generated truth. */
export type WorkspaceEnv = Cloudflare.Env &
	WorkspaceModelEnv & {
		/** Set only by the local demo launcher. */
		LOCAL_WORKSPACE_SEED_TOKEN?: string;
	};

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
	/** Must name a deployment supported by this runtime. */
	modelId?: string;
	attachments?: Array<{ outputId: string }>;
	/** Run as this tedi: its persona and recall come from its own object. */
	tediId?: string;
	/**
	 * A signed-in person picked nobody: the workspace's default tedi answers
	 * when it can, otherwise the workspace agent with a line saying why.
	 */
	defaultTedi?: boolean;
	/** The previous answerer handed this turn over; it cannot hand over again. */
	handedFrom?: { tediId: string | null };
	/** The workspace app the person asked from; shown under their message. */
	fromAppId?: string;
	/** Force the turn into its own facet (long or risky work). */
	isolate?: boolean;
}
