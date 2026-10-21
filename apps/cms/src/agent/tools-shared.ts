import type { CmsSandbox } from "../sandbox";
import * as z from "zod";
import { type CmsBuildSnapshot } from "./build-runner";
import { type CmsTemplateSlug } from "../template-policy";
import type {
	ImageGenerationStatusSnapshot,
	ImageGenerationWorkflowParams,
} from "./image-generation-workflow";
import { type CmsPreviewExecSnapshot } from "./preview-exec-runner";
import { type CmsPreviewSnapshot } from "./preview-runner";
import { type PublicCmsRouteExpectation } from "./public-route-verification";
import { getCmsHumanSiteAuthority } from "./storage";
import { type ThemeArtifactSeedSnapshot } from "./theme-artifacts";

// MCP SDK 1.29 supports Zod v4 at runtime but TS overload resolution
// can't match v4's ZodObject against the SDK's AnySchema union.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const schema = (s: z.ZodType): any => s;

export const WORKSPACE = "/workspace";
const SANDBOX_READ_TIMEOUT_MS = 25_000;
// Native container placement and image startup can exceed the short probe
// budget. Launching is still bounded, while the command itself remains an
// asynchronous job with its own timeout.
export const SANDBOX_LAUNCH_TIMEOUT_MS = 90_000;

const HUMAN_AUTHORITY_STALE_HINT =
	"Human CMS OAuth calls fail until the marker matches the active bundle: run get_human_auth_activation, then set_human_auth_activation.";
const HUMAN_AUTHORITY_NONE_HINT =
	"No human assertion marker is set for this site; human CMS OAuth calls are disabled until an admin runs set_human_auth_activation.";

export interface ThemeDeployHumanAuthority {
	state: "active" | "stale" | "none";
	markerEtag: string | null;
	activeEtag: string | null;
	hint?: string;
}

/**
 * Read-only view of whether the site's human assertion marker still matches the
 * currently active bundle. A deploy activates a new bundle, so the marker goes
 * stale and every cms_* human call fails until an admin re-activates it.
 */
export async function readThemeDeployHumanAuthority(
	db: D1Database,
	orgSlug: string,
): Promise<ThemeDeployHumanAuthority> {
	const authority = await getCmsHumanSiteAuthority(db, orgSlug);
	const markerEtag = authority?.humanAssertionBundleEtag ?? null;
	const activeEtag = authority?.activeBundleEtag ?? null;
	if (markerEtag === null)
		return {
			state: "none",
			markerEtag,
			activeEtag,
			hint: HUMAN_AUTHORITY_NONE_HINT,
		};
	if (markerEtag === activeEtag)
		return { state: "active", markerEtag, activeEtag };
	return {
		state: "stale",
		markerEtag,
		activeEtag,
		hint: HUMAN_AUTHORITY_STALE_HINT,
	};
}

export function defaultCmsRouteExpectations(
	orgSlug: string,
): PublicCmsRouteExpectation[] {
	return orgSlug === "tedix-landing"
		? [
				{
					path: "/",
					expectedLang: "en",
					expectedTitleContains: "Tedix",
					forbiddenTitle: "All articles",
				},
				{ path: "/de", expectedLang: "de" },
				{ path: "/es", expectedLang: "es" },
				{
					path: "/blog",
					expectedLang: "en",
					expectedTitleContains: "All articles",
				},
				{
					path: "/blog/crewai-vs-tedix-vs-langgraph-ai-agent-platform-comparison-2026",
					expectedLang: "en",
					expectedTitleContains: "CrewAI vs Tedix vs LangGraph",
				},
			]
		: [{ path: "/" }];
}

export async function withSandboxTimeout<T>(
	ctx: Pick<SiteBuilderToolContext, "orgSlug">,
	operation: string,
	work: Promise<T>,
	timeoutMs = SANDBOX_READ_TIMEOUT_MS,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timed = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(
				new Error(
					`CMS sandbox operation timed out after ${timeoutMs}ms for org "${ctx.orgSlug}" during ${operation}. The tenant CMS runtime may still be healthy, but the Site Builder sandbox control channel is not responding. Preserve and verify the active editable source before any sandbox reset.`,
				),
			);
		}, timeoutMs);
	});

	try {
		return await Promise.race([work, timed]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

export function forbidden(message: string) {
	return {
		content: [{ type: "text" as const, text: `[FORBIDDEN] ${message}` }],
		isError: true as const,
	};
}

export function requirePlatformAdminForOrg(
	ctx: SiteBuilderToolContext,
	targetOrgSlug: string,
	action: string,
) {
	if (targetOrgSlug === ctx.orgSlug || ctx.isPlatformAdmin) return null;
	return forbidden(
		`Platform admin authority required to ${action} org "${targetOrgSlug}" from "${ctx.orgSlug}"`,
	);
}

export function buildStatusOutput(snapshot: CmsBuildSnapshot) {
	return {
		jobId: snapshot.jobId,
		status: snapshot.status,
		exitCode: snapshot.exitCode,
		running: snapshot.running,
		message: snapshot.message,
		startedAt:
			snapshot.startedAt === null
				? null
				: new Date(snapshot.startedAt).toISOString(),
		durationMs: snapshot.durationMs,
		successMarkerDetected: snapshot.successMarkerDetected,
		logTail: snapshot.logTail,
		launchLog: snapshot.launchLog || undefined,
	};
}

export type BuildStatusOutput = ReturnType<typeof buildStatusOutput>;

export function previewStatusOutput(snapshot: CmsPreviewSnapshot) {
	return {
		status: snapshot.status,
		processStatus: snapshot.processStatus,
		running: snapshot.running,
		processId: snapshot.processId,
		port: snapshot.port,
		previewUrl: snapshot.previewUrl,
		previewUrlMode: snapshot.previewUrlMode,
		previewUrlEphemeral: snapshot.previewUrlEphemeral,
		startedAt:
			snapshot.startedAt === null
				? null
				: new Date(snapshot.startedAt).toISOString(),
		durationMs: snapshot.durationMs,
		exitCode: snapshot.exitCode,
		logTail: snapshot.logTail,
		message: snapshot.message,
	};
}

export function previewExecOutput(snapshot: CmsPreviewExecSnapshot) {
	return {
		jobId: snapshot.jobId,
		status: snapshot.status,
		exitCode: snapshot.exitCode,
		running: snapshot.running,
		command: snapshot.command,
		startedAt:
			snapshot.startedAt === null
				? null
				: new Date(snapshot.startedAt).toISOString(),
		durationMs: snapshot.durationMs,
		stdoutTail: snapshot.stdoutTail,
		stderrTail: snapshot.stderrTail,
		logTail: snapshot.logTail,
		message: snapshot.message,
	};
}

export function themeArtifactSeedOutput(snapshot: ThemeArtifactSeedSnapshot) {
	return {
		jobId: snapshot.jobId,
		status: snapshot.status,
		exitCode: snapshot.exitCode,
		running: snapshot.running,
		startedAt:
			snapshot.startedAt === null
				? null
				: new Date(snapshot.startedAt).toISOString(),
		durationMs: snapshot.durationMs,
		seed: snapshot.seed,
		stdoutTail: snapshot.stdoutTail,
		stderrTail: snapshot.stderrTail,
		logTail: snapshot.logTail,
		message: snapshot.message,
	};
}

export type PreviewExecOutput = ReturnType<typeof previewExecOutput>;
export type ThemeArtifactSeedOutput = ReturnType<
	typeof themeArtifactSeedOutput
>;
type JobReceipt =
	| BuildStatusOutput
	| PreviewExecOutput
	| ThemeArtifactSeedOutput;

export function cmsBuildStatusKey(orgSlug: string, jobId: string): string {
	return `themes/build-status/${orgSlug}/${jobId}.json`;
}
export function cmsPreviewExecStatusKey(
	orgSlug: string,
	jobId: string,
): string {
	return `themes/preview-exec-status/${orgSlug}/${jobId}.json`;
}
export function cmsThemeArtifactSeedStatusKey(
	orgSlug: string,
	jobId: string,
): string {
	return `themes/artifact-seed-status/${orgSlug}/${jobId}.json`;
}
export function cmsThemeArtifactCommitStatusKey(
	orgSlug: string,
	jobId: string,
): string {
	return `themes/artifact-commit-status/${orgSlug}/${jobId}.json`;
}
function isTerminalReceipt(receipt: JobReceipt): boolean {
	return (
		!receipt.running &&
		(receipt.status === "complete" ||
			receipt.status === "timeout" ||
			receipt.status === "cancelled" ||
			(receipt.status === "failed" && receipt.exitCode !== null))
	);
}

/** A native process can disappear; its observed terminal receipt must not. */
export async function updateStoredJobReceipt<T extends JobReceipt>(
	storage: R2Bucket,
	key: string,
	observe: (previous: T | null) => Promise<T>,
): Promise<T> {
	let observed: T | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		const object = await storage.get(key);
		const previous = object ? await object.json<T>() : null;
		if (previous && isTerminalReceipt(previous)) return previous;
		// Observe (or cancel) at most once, including when another request wins the CAS.
		observed ??= await observe(previous);
		let next = observed;
		if (
			previous &&
			observed.status === "failed" &&
			observed.exitCode === null &&
			observed.startedAt === null &&
			!observed.logTail
		) {
			next = {
				...previous,
				status: observed.status,
				exitCode: null,
				running: false,
				message: `${observed.message}; last known status before sandbox state was lost: ${previous.status}`,
			};
		}
		const saved = await storage.put(key, JSON.stringify(next), {
			onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
			httpMetadata: { contentType: "application/json" },
		});
		if (saved) return next;
	}
	throw new Error(
		"CMS job receipt changed concurrently; retry the status read",
	);
}

export interface DeployStatus {
	status:
		| "queued"
		| "running"
		| "complete"
		| "failed"
		| "errored"
		| "terminated"
		| "paused"
		| "unknown";
	jobId: string;
	output?: { version: number; url: string };
	error?: string;
	phase?: string;
	message?: string;
	updatedAt?: string;
	history?: Array<{
		phase: string;
		status: string;
		message?: string;
		timestamp: string;
		details?: Record<string, unknown>;
	}>;
	details?: Record<string, unknown>;
}

export interface SiteBuilderToolContext {
	prepareAuthoringWorkspace?: () => Promise<void>;
	orgSlug: string;
	recordMcpAuditEvent?: (input: {
		durationMs: number;
		outcome: "error" | "success";
		resultDigest: string | null;
		toolName: string;
	}) => Promise<void>;
	/** Canonical starter selected by the tenant's explicit app metadata. */
	templateSlug: CmsTemplateSlug;
	sandbox: CmsSandbox;
	previewHostname: string;
	storage: R2Bucket;
	environment: string;
	/** True when the authenticated caller has platform-wide admin authority. */
	isPlatformAdmin: boolean;
	/** Verified tenant-scoped authority for native CMS maintenance tools. */
	mediaMaintenanceAuthorized?: boolean;
	/** User's Descope JWT forwarded from the MCP Worker via X-Forwarded-Authorization. */
	forwardedAuth?: string;
	humanAuthRequired?: boolean;
	humanIdentity?: import("./cms-human-auth").CmsHumanIdentity | null;
	humanAuthDenial?: import("./cms-human-auth").CmsHumanAuthDenial | null;
	/** Emdash PAT for REST fallback and bearer-only native tenant MCP forwarding. */
	serviceApiKey?: string;
	loadTransferServiceKey?: (slug: string) => Promise<string | undefined>;
	loadTransferHumanIdentity?: (
		slug: string,
	) => Promise<import("./cms-human-auth").CmsHumanIdentity | null>;
	/** Shared internal secret for Site Builder -> CMS Runtime service-binding calls. */
	internalAuthToken?: string;
	/** Service binding to the CMS dispatch worker. */
	cmsDispatch?: Fetcher;
	/** Gemini key for Site Builder-owned AI generation tools. */
	geminiApiKey?: string;
	/** AI Gateway routing for the Gemini blog-generation tool (google-ai-studio provider). */
	geminiGateway?: import("./blog-generation").GeminiGatewayConfig;
	/** R2 bucket containing deployed tenant bundles and hot theme assets. */
	bundlesBucket: R2Bucket;
	/** Cloudflare Artifacts binding for Git-backed tenant theme source repos. */
	artifacts?: import("../types").ArtifactsBinding;
	artifactsAccountId: string;
	artifactsNamespace: string;
	startDeploy(
		orgSlug: string,
		summary?: string,
		sourceCommit?: string,
	): Promise<{ jobId: string }>;
	getDeployStatus(jobId: string): Promise<DeployStatus>;
	startImageGeneration(
		params: ImageGenerationWorkflowParams,
	): Promise<{ jobId: string }>;
	getImageGenerationStatus(
		jobId: string,
	): Promise<
		| ImageGenerationStatusSnapshot
		| { status: string; jobId: string; error?: string }
	>;
	rollback(orgSlug: string, version: number): Promise<{ url: string }>;
	listVersions(orgSlug: string): Promise<
		Array<{
			version: number;
			active: boolean;
			deployedAt: string | null;
			promptSummary: string | null;
			sourceRevision:
				| import("@tedix/provisioning/cms").TenantBundleSourceRevision
				| null;
		}>
	>;
	/** Platform D1 — used to enumerate all active org sandboxes for template_propagate. */
	db: D1Database;
	/** Get a sandbox instance for any org slug — used by template_propagate. */
	getSandboxForOrg(slug: string): CmsSandbox;
}
