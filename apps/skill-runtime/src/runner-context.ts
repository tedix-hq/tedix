import type { CapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import type { ArtifactBridge } from "./artifacts";
import type { EvidenceBridge, EvidenceBridgeProps } from "./evidence";
import type { ReasonBridge } from "./reason";
import type { ReasonBridgeProps } from "./reason-core";
import type { McpBridge, McpBridgeProps } from "./mcp-bridge";
import type { RationaleBridge } from "./rationale";

export interface LoadSkillRuntimeInput {
	skillId: string;
	/** Human-readable slug from skill_entries (used in rationale evidence
	 *  and Tedix OS timeline labels). */
	skillSlug?: string | null;
	tediId: string;
	/** Owning organization's Code Mode aggregate app slug. */
	aggregateMcpSlug: string;
	/** Owning tedi's configured namespace within that aggregate. */
	tediNamespace?: string | null;
	orgId: string;
	runId: string;
	executionEpoch: number;
	admittedAt: string;
	/**
	 * Run-starter provenance from the admission row:
	 * "user:<descopeUserId>" for operator-started runs, "agent:"/"tedi:"/auth
	 * class otherwise. Rides the bridge headers so the gateway can attest
	 * operator consent on tedi-bound calls; tenant code never sees or sets it.
	 */
	createdBy?: string | null;
	/** Work Item pinned at admission and inherited by every MCP call. */
	workItemId?: string | null;
	/**
	 * SHA-256 of every non-secret input that affects the Loader callback's
	 * WorkerCode/config. Cloudflare requires one Loader id to resolve to the
	 * same config forever; changing this hash deliberately selects a new id.
	 */
	loaderConfigHash: string;
	/** Source of the tenant's `scripts/workflow.ts`. */
	code: string;
	manifest: CapabilityManifest;
	/** Provenance derived from the authoritative run-pinned snapshot. */
	provenance: {
		source: {
			workflowSha256: string;
			skillDocSha256: string;
			skillRevision: number | null;
			skillSlug: string | null;
		};
		runtime: {
			workerVersionId: string;
			workerVersionTag: string;
			workerVersionTimestamp: string;
			executionCompatibilityHash: string;
			dispatchShimVersion: string;
			compatibilityDate: string;
			dynamicWorkflowsVersion: string;
			loaderConfigHash: string;
			tenantCpuMs: number;
			tenantSubRequests: number;
		};
	};
	/**
	 * Map from manifest namespace (what the tenant types — e.g. `peec`)
	 * to the real apps/mcp slug (e.g. `peec-tedix`). Resolved by the
	 * factory at workflow-boot time so the dispatch shim has zero-cost
	 * lookups per call. If a namespace has no entry, the dispatch shim
	 * falls back to the namespace itself with `_` → `-` mapping.
	 */
	namespaceToSlug?: Record<string, string>;
	/**
	 * Namespace→slug routing for the PLATFORM's evidence scrape. Resolved
	 * separately from the tenant map so grounding never depends on (and never
	 * widens) what the skill happens to declare.
	 */
	evidenceNamespaceToSlug?: Record<string, string>;
}

export function buildTenantRunContext(
	input: Pick<
		LoadSkillRuntimeInput,
		| "skillId"
		| "skillSlug"
		| "tediId"
		| "orgId"
		| "runId"
		| "executionEpoch"
		| "admittedAt"
		| "workItemId"
		| "manifest"
		| "namespaceToSlug"
		| "provenance"
	>,
) {
	return {
		skillId: input.skillId,
		skillSlug: input.skillSlug ?? null,
		tediId: input.tediId,
		orgId: input.orgId,
		runId: input.runId,
		executionEpoch: input.executionEpoch,
		admittedAt: input.admittedAt,
		workItemId: input.workItemId ?? null,
		capabilityManifest: input.manifest,
		namespaceToSlug: input.namespaceToSlug ?? {},
		provenance: input.provenance,
	};
}

export interface SkillRuntimeEnv {
	LOADER: WorkerLoader;
	PLATFORM_SERVICE_TOKEN: string;
	MCP_URL?: string;
	/**
	 * Platform-global Gemini key, injected into `network: true` skill
	 * workflows' outbound requests by {@link SkillRuntimeExportFactories.OutboundProxy}.
	 * Optional so a missing secret never blocks dispatch — the proxy simply
	 * forwards uncredentialed and Gemini returns its own auth error.
	 */
	GEMINI_API_KEY?: string;
	/** Service-account JSON used by the outbound proxy for Vertex OAuth. */
	GOOGLE_SERVICE_ACCOUNT_KEY?: string;
	/** Vertex model collection endpoint used by the media import bridge. */
	VERTEX_VIDEO_ENDPOINT?: string;
	/** Tenant-owned video asset storage; access remains restricted to the proxy. */
	VIDEO_BUCKET: R2Bucket;
}

export interface SkillRuntimeExportFactories {
	McpBridge(opts: { props: McpBridgeProps }): Fetcher<McpBridge>;
	ArtifactBridge(opts: { props: { runId: string } }): Fetcher<ArtifactBridge>;
	EvidenceBridge(opts: { props: EvidenceBridgeProps }): Fetcher<EvidenceBridge>;
	ReasonBridge(opts: { props: ReasonBridgeProps }): Fetcher<ReasonBridge>;
	RationaleBridge(opts: {
		props: {
			runId: string;
			skillId: string;
			skillSlug: string | null;
			tediId: string;
			orgId: string;
			rationaleMode: CapabilityManifest["rationale"]["mode"];
			executionEpoch: number;
			serviceToken: string;
		};
	}): Fetcher<RationaleBridge>;
	OutboundProxy(opts: {
		props: {
			geminiApiKey?: string | null;
			googleServiceAccountKey?: string | null;
			organizationId?: string | null;
			vertexVideoEndpoint?: string | null;
		};
	}): Fetcher;
}

export const COMPATIBILITY_DATE = "2026-06-11";
export const DYNAMIC_WORKFLOWS_VERSION = "0.1.1";
export const TENANT_WORKER_LIMITS = {
	cpuMs: 60_000,
	// Include durable-step RPC and evidence replay in the workflow's bounded budget.
	subRequests: 10_000,
} as const;
