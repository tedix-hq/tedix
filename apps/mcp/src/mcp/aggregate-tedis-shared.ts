// Shared aggregate-tedi tool-spec machinery: the AggregateTediEntry input,
// the TediToolSpec shape, annotation tiers, and cross-domain schema helpers.
import type {
	ToolAnnotations,
	ToolInputJsonSchema,
} from "@tedix/api-contract/schemas/tools";
import type { JsonValue } from "@tedix/api-contract/schemas/common";

export interface AggregateTediEntry {
	/** Tedi slug, e.g. "cto". Used to build https://cto.tedi.<domain>/mcp. */
	slug: string;
	/** Code Mode namespace. Defaults to slug. */
	namespace?: string;
	/** Session used by the ask alias. Defaults to the main agent session. */
	sessionKey?: string;
	/** Optional explicit MCP URL for unusual deployments. */
	serverUrl?: string;
	/** Tedi tool surface. Defaults to the full tedi MCP surface. */
	surface?: "full" | "collaboration";
	/** Hydrated from D1; all aggregate tedis use the Agent runtime. */
	runtimeKind?: "agent";
	/**
	 * Hydrated from D1 when the aggregate surface is built. Operators do not set
	 * this in metadata. Used by managed MCP auth to resolve credentials for the
	 * aggregated tedi itself instead of the parent MCP app's org context.
	 */
	tediId?: string;
	organizationId?: string;
}

export const MAIN_SESSION_KEY = "agent:main:main";

export function withoutTediId(
	schema: ToolInputJsonSchema,
): ToolInputJsonSchema {
	const { tediId: _tediId, ...properties } = schema.properties ?? {};
	return {
		...schema,
		properties,
		required: schema.required?.filter((name) => name !== "tediId"),
	};
}

export type TediToolSpec = {
	name: string;
	remoteName: string;
	description: string;
	inputSchema: ToolInputJsonSchema;
	annotations?: ToolAnnotations;
	timeout?: number;
	paramMap?: Record<string, string>;
	staticParams?: Record<string, JsonValue>;
	tediIdDefaultParams?: string[];
	rpcEndpoint?: string;
	layoutId?: string;
	layoutSpec?: Record<string, JsonValue>;
	widgetDescription?: string;
	allowExplicitTediId?: boolean;
	includeTediIdParam?: boolean;
	/** Keep an org-scoped RPC tool hidden until this aggregate namespace resolves. */
	requiresHydratedTedi?: boolean;
	/**
	 * Require a verified tedi/service credential for the hydrated aggregate tedi.
	 * The namespace selects the route but never grants actor authority.
	 */
	credentialDerivedTediActor?: boolean;
	tediBooleanParams?: Record<string, string>;
	voiceSubject?: "aggregateTedi";
	runtimeKinds?: Array<NonNullable<AggregateTediEntry["runtimeKind"]>>;
	directMcpTool?: boolean;
};

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true };
export const MUTATING: ToolAnnotations = { readOnlyHint: false };
/**
 * Run-terminating writes (e.g. bridged `cancel_home_run`) carry
 * `destructiveHint:true` so `requireDestructiveToolApproval` (governance.ts)
 * trips the destructive elicitation gate before the side effect runs. Without
 * this tier the hint is always unset and a cancel bypasses the approval gate.
 */
export const DESTRUCTIVE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
};
