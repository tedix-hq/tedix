import { AUTHORING_TOOLS } from "./authoring-workspace";
import type { CmsSandbox } from "../sandbox";
import type { McpServer } from "@tedix/mcp-shared/server";
import { createMcpServer } from "@tedix/mcp-shared/server";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import * as z from "zod";

import { storeServiceKey } from "../service-key-storage";
import { TEMPLATE_SNAPSHOTS } from "../template-snapshot";
import { readThemeArtifactFile } from "./artifact-source-read";
import { registerBlogGenerationTool } from "./blog-generation";
import {
	type CmsBuildSnapshot,
	cancelCmsSandboxBuild,
	readCmsSandboxBuildStatus,
	resolveCmsPrivacyBannerEnabled,
	startCmsSandboxBuild,
} from "./build-runner";
import type { CmsProxyContext } from "./cms-proxy-runtime";
import { registerCmsProxyTools } from "./cms-proxy-tools";
import {
	type CmsSandboxForceRecoveryPins,
	type CmsSandboxRecoveryPins,
	destroyPinnedCmsBuilderSandbox,
	stopPinnedCmsBuilderSandbox,
} from "./sandbox-recovery";
import { isPathEditable, isPathLocked } from "./constraints";
import {
	type CmsTemplateSlug,
	EDITABLE_DIRS,
	EDITABLE_FILES,
	lockedDirsForTemplate,
	lockedFilesForTemplate,
	normalizeCmsTemplateSlug,
} from "../template-policy";
import { getActiveCmsSiteForPermit } from "./cms-restore-permit";
import {
	HOT_THEME_PUBLIC_PATH,
	hotThemeManifestKey,
	listHotThemeRevisions,
	readHotThemeCss,
	readHotThemeManifest,
	rollbackHotThemeCss,
	themeArtifactRemote,
	themeArtifactRepoName,
	writeHotThemeCss,
} from "./hot-theme";
import {
	type ImageGenerationToolContext,
	registerImageGenerationTools,
} from "./image-generation";
import type {
	ImageGenerationStatusSnapshot,
	ImageGenerationWorkflowParams,
} from "./image-generation-workflow";
import {
	type CmsPreviewExecSnapshot,
	cancelCmsPreviewExec,
	readCmsPreviewExecStatus,
	startCmsPreviewExec,
} from "./preview-exec-runner";
import {
	CMS_PREVIEW_EXPOSURES,
	type CmsPreviewSnapshot,
	readCmsPreviewStatus,
	startCmsPreview,
	stopCmsPreview,
} from "./preview-runner";
import {
	buildCmsPublishReceipt,
	parseCmsPublishJobId,
} from "./publish-receipt";
import { buildServiceKeyProvisionAuthCandidates } from "./service-key-auth";
import {
	type PublicCmsRouteExpectation,
	verifyPublicCmsRoutes,
} from "./public-route-verification";
import {
	digestEditableThemeSource,
	materializeEditableThemeSource,
} from "./source-provenance";
import {
	getCmsHumanSiteAuthority,
	getCmsPublicBuildRoute,
	inspectCmsHumanAuthActivation,
	listCmsFleetBundles,
	setCmsHumanAuthActivation,
} from "./storage";
import { diffTemplate, resyncTemplate } from "./template-sync";
import {
	cancelThemeArtifactRepoSeed,
	readThemeArtifactRepoCommitStatus,
	readThemeArtifactRepoSeedStatus,
	startThemeArtifactRepoCommit,
	startThemeArtifactRepoSeed,
	type ThemeArtifactSeedSnapshot,
} from "./theme-artifacts";
import { inspectWorkspaceSourceStatus } from "./workspace-source-status";

// MCP SDK 1.29 supports Zod v4 at runtime but TS overload resolution
// can't match v4's ZodObject against the SDK's AnySchema union.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schema = (s: z.ZodType): any => s;

const WORKSPACE = "/workspace";
const SANDBOX_READ_TIMEOUT_MS = 25_000;
// Native container placement and image startup can exceed the short probe
// budget. Launching is still bounded, while the command itself remains an
// asynchronous job with its own timeout.
const SANDBOX_LAUNCH_TIMEOUT_MS = 90_000;

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

function defaultCmsRouteExpectations(
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

async function withSandboxTimeout<T>(
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

function forbidden(message: string) {
	return {
		content: [{ type: "text" as const, text: `[FORBIDDEN] ${message}` }],
		isError: true as const,
	};
}

function requirePlatformAdminForOrg(
	ctx: SiteBuilderToolContext,
	targetOrgSlug: string,
	action: string,
) {
	if (targetOrgSlug === ctx.orgSlug || ctx.isPlatformAdmin) return null;
	return forbidden(
		`Platform admin authority required to ${action} org "${targetOrgSlug}" from "${ctx.orgSlug}"`,
	);
}

function buildStatusOutput(snapshot: CmsBuildSnapshot) {
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

type BuildStatusOutput = ReturnType<typeof buildStatusOutput>;

function previewStatusOutput(snapshot: CmsPreviewSnapshot) {
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

function previewExecOutput(snapshot: CmsPreviewExecSnapshot) {
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

function themeArtifactSeedOutput(snapshot: ThemeArtifactSeedSnapshot) {
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

type PreviewExecOutput = ReturnType<typeof previewExecOutput>;
type ThemeArtifactSeedOutput = ReturnType<typeof themeArtifactSeedOutput>;
type JobReceipt =
	| BuildStatusOutput
	| PreviewExecOutput
	| ThemeArtifactSeedOutput;

function cmsBuildStatusKey(orgSlug: string, jobId: string): string {
	return `themes/build-status/${orgSlug}/${jobId}.json`;
}
function cmsPreviewExecStatusKey(orgSlug: string, jobId: string): string {
	return `themes/preview-exec-status/${orgSlug}/${jobId}.json`;
}
function cmsThemeArtifactSeedStatusKey(orgSlug: string, jobId: string): string {
	return `themes/artifact-seed-status/${orgSlug}/${jobId}.json`;
}
function cmsThemeArtifactCommitStatusKey(
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
async function updateStoredJobReceipt<T extends JobReceipt>(
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

export function buildSiteBuilderMcpServer(
	ctx: SiteBuilderToolContext,
): McpServer {
	const server = createMcpServer(
		{ name: "cms", version: "0.1.0" },
		{
			// No `logging` capability: server-initiated notifications/message never
			// fire on the stateless transport, and logging is deprecated in MCP
			// 2026-07-28 (SEP-2577), so declaring it would be an empty promise.
			capabilities: {},
			instructions: buildInstructions(ctx.templateSlug),
		},
	);
	installCmsToolAudit(server, ctx.recordMcpAuditEvent);
	if (ctx.prepareAuthoringWorkspace) {
		const register = server.registerTool.bind(server);
		server.registerTool = ((
			name: string,
			options: unknown,
			handler: (...args: unknown[]) => unknown,
		) =>
			register(
				name,
				options as never,
				(async (...args: unknown[]) => {
					if (AUTHORING_TOOLS.has(name)) await ctx.prepareAuthoringWorkspace!();
					return handler(...args);
				}) as never,
			)) as typeof server.registerTool;
	}

	registerThemeTools(server, ctx);
	registerBuilderRecoveryTool(server, ctx);
	registerHotThemeTools(server, ctx);
	registerTemplateSyncTools(server, ctx);
	registerPreviewTools(server, ctx);
	registerDeployTools(server, ctx);
	registerPropagateTools(server, ctx);
	registerImageGenerationTools(server, ctx as ImageGenerationToolContext);

	const cmsCtx: CmsProxyContext = {
		orgSlug: ctx.orgSlug,
		isPlatformAdmin: ctx.isPlatformAdmin,
		mediaMaintenanceAuthorized: ctx.mediaMaintenanceAuthorized,
		forwardedAuth: ctx.forwardedAuth,
		humanAuthRequired: ctx.humanAuthRequired,
		humanIdentity: ctx.humanIdentity,
		humanAuthDenial: ctx.humanAuthDenial,
		serviceApiKey: ctx.serviceApiKey,
		loadTransferServiceKey: ctx.loadTransferServiceKey,
		loadTransferHumanIdentity: ctx.loadTransferHumanIdentity,
		internalAuthToken: ctx.internalAuthToken,
		environment: ctx.environment,
		cmsDispatch: ctx.cmsDispatch,
		db: ctx.db,
		bundlesBucket: ctx.bundlesBucket,
	};
	try {
		registerCmsProxyTools(server, cmsCtx);
		registerBlogGenerationTool(server, {
			cms: cmsCtx,
			geminiApiKey: ctx.geminiApiKey,
			geminiGateway: ctx.geminiGateway,
		});
		const toolCount = Object.keys(
			(server as any)._registeredTools ?? {},
		).length;
		console.log(
			`[buildSiteBuilderMcpServer] Registered ${toolCount} total tools`,
		);
	} catch (err) {
		console.error(
			"[buildSiteBuilderMcpServer] registerCmsProxyTools failed:",
			err,
		);
	}

	registerServiceKeyTool(server, ctx);

	return server;
}

function registerBuilderRecoveryTool(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	const recoveryInput = z.object({
		orgSlug: z.string().regex(/^[a-z][a-z0-9-]*$/),
		expectedSiteId: z.string().uuid(),
		expectedVersion: z.number().int().positive(),
		expectedBundleEtag: z.string().regex(/^[a-f0-9]{64}$/),
		expectedSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
		expectedFailedSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
		proofJobId: z
			.string()
			.regex(/^cms-[0-9a-f-]+-e\d+-v[1-9]\d*-s[a-f0-9]{40}$/),
		confirmMayInterruptInFlightBuild: z.literal(true),
		reason: z.string().trim().min(20).max(1000),
	});
	const recoveryOutput = (status: z.ZodType) =>
		z.object({
			status,
			orgSlug: z.string(),
			siteId: z.string(),
			activeVersion: z.number().int(),
			sourceCommit: z.string(),
			message: z.string(),
		});
	server.registerTool(
		"stop_builder_sandbox",
		{
			title: "Stop Pinned CMS Builder Sandbox",
			description:
				"Platform-admin recovery only. Pin the active bundle's Artifacts source with expectedSourceCommit and the failed deploy's source with expectedFailedSourceCommit. Invoke stop for this exact tenant's Builder container after checking its active site ID, bundle version and etag, and a failed deploy receipt whose completed preflight fetched the failed source. The receipt proves a prior fetch, not current Git availability. The SDK stop RPC does not confirm signal delivery or container exit, so success means stop_requested. Does not destroy the Sandbox or modify the live site; local Builder drafts may be lost. A concurrently restarted same-tenant build can be interrupted after the final checks. A lost stop response is reported as uncertain.",
			inputSchema: schema(recoveryInput),
			outputSchema: schema(
				recoveryOutput(z.enum(["stop_requested", "uncertain"])),
			),
			annotations: { destructiveHint: true, readOnlyHint: false },
		},
		async (pins: CmsSandboxRecoveryPins) => {
			if (!ctx.isPlatformAdmin)
				return forbidden(
					"Platform admin authority required to stop a CMS Builder Sandbox",
				);
			try {
				const output = await stopPinnedCmsBuilderSandbox({
					pins,
					currentOrgSlug: ctx.orgSlug,
					isPlatformAdmin: ctx.isPlatformAdmin,
					db: ctx.db,
					bundlesBucket: ctx.bundlesBucket,
					storage: ctx.storage,
					artifacts: ctx.artifacts,
					getDeployStatus: ctx.getDeployStatus,
					getSandboxForOrg: ctx.getSandboxForOrg,
				});
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(output, null, 2) },
					],
					structuredContent: output,
					isError: output.status === "uncertain" ? (true as const) : undefined,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[CONFLICT] ${error instanceof Error ? error.message : "CMS Builder stop refused"}`,
						},
					],
					isError: true as const,
				};
			}
		},
	);
	server.registerTool(
		"force_destroy_builder_sandbox",
		{
			title: "Force Destroy Pinned CMS Builder Sandbox",
			description:
				"Platform-admin recovery after ordinary stop failed. Request force-destroy for only this exact tenant's Builder Sandbox after the same active-site, separately pinned active and failed Artifacts sources, failed preflight receipt, and terminal Workflow checks. This can lose container-local drafts and preview state and interrupt a concurrent build. The SDK may queue destroy behind an unfinished stop, so a timeout does not prove SIGKILL was attempted. No CMS site, bundle, R2, or Artifacts deletion is requested. SDK completion does not replace independent provider instance-exit verification; a lost response is uncertain.",
			inputSchema: schema(
				recoveryInput.extend({ confirmLoseBuilderDrafts: z.literal(true) }),
			),
			outputSchema: schema(
				recoveryOutput(z.enum(["destroy_rpc_completed", "uncertain"])),
			),
			annotations: { destructiveHint: true, readOnlyHint: false },
		},
		async (pins: CmsSandboxForceRecoveryPins) => {
			if (!ctx.isPlatformAdmin)
				return forbidden(
					"Platform admin authority required to force-destroy a CMS Builder Sandbox",
				);
			try {
				const output = await destroyPinnedCmsBuilderSandbox({
					pins,
					currentOrgSlug: ctx.orgSlug,
					isPlatformAdmin: ctx.isPlatformAdmin,
					db: ctx.db,
					bundlesBucket: ctx.bundlesBucket,
					storage: ctx.storage,
					artifacts: ctx.artifacts,
					getDeployStatus: ctx.getDeployStatus,
					getSandboxForOrg: ctx.getSandboxForOrg,
				});
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(output, null, 2) },
					],
					structuredContent: output,
					isError: output.status === "uncertain" ? (true as const) : undefined,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[CONFLICT] ${error instanceof Error ? error.message : "CMS Builder force-destroy refused"}`,
						},
					],
					isError: true as const,
				};
			}
		},
	);
}

export function installCmsToolAudit(
	server: McpServer,
	record: SiteBuilderToolContext["recordMcpAuditEvent"],
): void {
	if (!record) return;
	const target = server as unknown as {
		registerTool: (...args: unknown[]) => unknown;
	};
	const registerTool = target.registerTool.bind(server);
	target.registerTool = (...args: unknown[]) => {
		const [name, options, handler] = args;
		if (typeof name !== "string" || typeof handler !== "function") {
			return registerTool(...args);
		}
		return registerTool(name, options, async (...handlerArgs: unknown[]) => {
			const startedAt = Date.now();
			let outcome: "error" | "success" = "error";
			let resultDigest: string | null = null;
			try {
				const result = await (handler as (...values: unknown[]) => unknown)(
					...handlerArgs,
				);
				try {
					const bytes = new TextEncoder().encode(
						(JSON.stringify(result) ?? "null").slice(0, 65_536),
					);
					const digest = await crypto.subtle.digest("SHA-256", bytes);
					resultDigest = Array.from(new Uint8Array(digest), (byte) =>
						byte.toString(16).padStart(2, "0"),
					).join("");
				} catch {
					resultDigest = null;
				}
				outcome = "success";
				return result;
			} finally {
				try {
					await record({
						durationMs: Date.now() - startedAt,
						outcome,
						resultDigest,
						toolName: name,
					});
				} catch (error) {
					console.error("[cms-mcp] audit write failed", error);
				}
			}
		});
	};
}

function registerServiceKeyTool(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"cms_provision_service_key",
		{
			title: "Provision CMS Service Key",
			description:
				"Store an Emdash PAT (ec_pat_...) for this org so service/tedi contexts can call CMS tools autonomously. " +
				"Two modes: (1) pass `pat` directly to store a PAT you already have; " +
				"(2) omit `pat` to auto-create one via the Emdash API using a live Descope user session or the Site Builder internal service credential. " +
				"Run once per org to enable autonomous CMS access.",
			inputSchema: schema(
				z.object({
					pat: z
						.string()
						.optional()
						.describe(
							"Existing Emdash PAT (ec_pat_...) to store directly. Omit to auto-create via user session.",
						),
					name: z
						.string()
						.optional()
						.describe(
							"Token name when auto-creating through user or internal service auth (default: 'tedix-site-builder-service')",
						),
				}),
			),
			// Provisions a credential: mutating and authority-granting.
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async (args: { pat?: string; name?: string }) => {
			// Direct PAT bootstrap — no user session required
			if (args.pat) {
				if (!args.pat.startsWith("ec_pat_")) {
					return {
						content: [
							{
								type: "text" as const,
								text: "[ERROR] pat must be an Emdash Personal Access Token starting with ec_pat_. OAuth tokens (ec_oat_) are time-limited and not suitable as service keys.",
							},
						],
						isError: true,
					};
				}
				await storeServiceKey(ctx.storage, ctx.orgSlug, args.pat);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								ok: true,
								org: ctx.orgSlug,
								mode: "stored",
								message:
									"PAT stored. CMS tools are now available for this org.",
							}),
						},
					],
				};
			}

			const authCandidates = buildServiceKeyProvisionAuthCandidates(ctx);
			if (authCandidates.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "[ERROR] No pat provided and no CMS bootstrap credential is available. Pass pat=<ec_pat_...>, call from a user session, or configure CMS_INTERNAL_AUTH_TOKEN.",
						},
					],
					isError: true,
				};
			}

			const origin = buildSurfaceUrl("cms", ctx.orgSlug, {
				platformDomain: platformDomainForEnvironment(ctx.environment),
			});
			if (!origin) throw new Error("CMS organization slug is required");
			const baseUrl = `${origin}/_emdash/api`;
			const tokenName = args.name ?? "tedix-site-builder-service";

			const doFetch = ctx.cmsDispatch
				? (url: string, init: RequestInit) =>
						ctx.cmsDispatch!.fetch(new Request(url, init))
				: (url: string, init: RequestInit) => fetch(url, init);
			let resp: Response | undefined;
			let text = "";
			for (const [index, headers] of authCandidates.entries()) {
				resp = await doFetch(`${baseUrl}/admin/api-tokens`, {
					method: "POST",
					headers: {
						...headers,
						"Content-Type": "application/json",
						"X-EmDash-Request": "1",
					},
					body: JSON.stringify({
						name: tokenName,
						scopes: ["admin"],
					}),
				});
				text = await resp.text();
				if (resp.ok) break;
				const canRetryAuth =
					(resp.status === 401 || resp.status === 403) &&
					index < authCandidates.length - 1;
				if (!canRetryAuth) break;
			}

			if (!resp) throw new Error("CMS service-key bootstrap made no request");
			if (!resp.ok) {
				const detail =
					resp.status === 403
						? "Admin privileges required — the Descope user must have an admin role in this Emdash org."
						: text.slice(0, 400);
				return {
					content: [
						{
							type: "text" as const,
							text: `[CMS_ERROR] POST /admin/api-tokens failed (${resp.status}): ${detail}`,
						},
					],
					isError: true,
				};
			}

			let pat: string;
			try {
				const body = JSON.parse(text) as {
					success?: boolean;
					data?: { token?: string };
				};
				pat = body.data?.token ?? "";
			} catch {
				return {
					content: [
						{
							type: "text" as const,
							text: `[CMS_ERROR] Unexpected response: ${text.slice(0, 200)}`,
						},
					],
					isError: true,
				};
			}

			if (!pat) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[CMS_ERROR] No token in response: ${text.slice(0, 200)}`,
						},
					],
					isError: true,
				};
			}

			await storeServiceKey(ctx.storage, ctx.orgSlug, pat);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							ok: true,
							org: ctx.orgSlug,
							tokenName,
							mode: "created",
							message:
								"PAT created and stored. Service contexts can now call CMS tools for this org.",
						}),
					},
				],
			};
		},
	);
}

function registerThemeTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	const humanAuthActivationOutput = z.object({
		status: z.enum(["ready", "unavailable"]),
		siteId: z.string().nullable(),
		tenantId: z.string().nullable(),
		activeVersion: z.number().int().nullable(),
		activeBundleEtag: z.string().nullable(),
		humanAssertionBundleEtag: z.string().nullable(),
		compatible: z.boolean(),
		reason: z.string().nullable(),
	});
	server.registerTool(
		"get_human_auth_activation",
		{
			title: "Inspect CMS Human Auth Activation",
			description:
				"Read the exact active site, editorial tenant, bundle version and etag, current human assertion marker, and compiled bundle compatibility. Platform admin only; this does not change tenant access.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(humanAuthActivationOutput),
			annotations: { readOnlyHint: true },
		},
		async () => {
			if (!ctx.isPlatformAdmin)
				return forbidden(
					"Platform admin authority required to inspect CMS human auth activation",
				);
			const output = await inspectCmsHumanAuthActivation(
				ctx.db,
				ctx.bundlesBucket,
				ctx.orgSlug,
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"set_human_auth_activation",
		{
			title: "Set Exact-Bundle CMS Human Auth Activation",
			description:
				"Enable or revoke human OAuth assertions for this CMS tenant only when site, editorial tenant, active version, etag, and current marker match the inspected values. Enabling also verifies the immutable compiled bundle's assertion handler. Platform admin only.",
			inputSchema: schema(
				z.object({
					expectedSiteId: z.string().uuid(),
					expectedTenantId: z.string().min(1),
					expectedVersion: z.number().int().positive(),
					expectedBundleEtag: z.string().regex(/^[a-f0-9]{64}$/),
					expectedCurrentMarker: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.nullable(),
					enabled: z.boolean(),
				}),
			),
			outputSchema: schema(humanAuthActivationOutput),
			annotations: { destructiveHint: true, readOnlyHint: false },
		},
		async (
			args: Omit<Parameters<typeof setCmsHumanAuthActivation>[2], "slug">,
		) => {
			if (!ctx.isPlatformAdmin)
				return forbidden(
					"Platform admin authority required to change CMS human auth activation",
				);
			try {
				const output = await setCmsHumanAuthActivation(
					ctx.db,
					ctx.bundlesBucket,
					{ slug: ctx.orgSlug, ...args },
				);
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(output, null, 2) },
					],
					structuredContent: output,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[CONFLICT] ${error instanceof Error ? error.message : "CMS human auth activation failed"}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"theme_workspace_status",
		{
			title: "Compare Builder Workspace With Active Theme Source",
			description:
				"Before editing a committed CMS theme, compare the builder's editable files with the active Artifacts commit. " +
				"A difference may be intentional draft work or a reset/stale sandbox; review and preserve changes before replacing the workspace. " +
				"This check does not alter the builder workspace.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z.object({
					status: z.enum([
						"matches_active_source",
						"differs_from_active_source",
						"no_artifacts_source",
						"unavailable",
					]),
					activeVersion: z.number().int().nullable(),
					activeSourceCommit: z.string().nullable(),
					activeSourceDigest: z.string().optional(),
					workspaceSource: z
						.object({ digest: z.string(), fileCount: z.number().int() })
						.optional(),
					activeSource: z
						.object({ digest: z.string(), fileCount: z.number().int() })
						.optional(),
					message: z.string(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const guard = requirePlatformAdminForOrg(
				ctx,
				ctx.orgSlug,
				"compare theme source for",
			);
			if (guard) return guard;
			const active = (await ctx.listVersions(ctx.orgSlug)).find(
				(version) => version.active,
			);
			const activeSourceRevision = active?.sourceRevision ?? null;
			const output = await withSandboxTimeout(
				ctx,
				"theme_workspace_status",
				inspectWorkspaceSourceStatus({
					orgSlug: ctx.orgSlug,
					templateSlug: ctx.templateSlug,
					sandbox: ctx.sandbox,
					activeVersion: active?.version ?? null,
					activeSourceRevision,
					artifacts: ctx.artifacts,
				}),
			).catch(() => ({
				status: "unavailable" as const,
				activeVersion: active?.version ?? null,
				activeSourceCommit:
					activeSourceRevision?.kind === "artifacts_commit"
						? activeSourceRevision.value
						: null,
				...(activeSourceRevision?.kind === "editable_source_digest"
					? { activeSourceDigest: activeSourceRevision.value }
					: {}),
				message:
					"Builder source comparison timed out or failed. Do not seed Artifacts or replace the workspace until the active source is recovered.",
			}));
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_list_files",
		{
			title: "List Theme Files",
			description:
				"List all theme files with their editable/locked status. " +
				"LOCKED files cannot be modified — they contain auth, content layer, and Worker config. " +
				"EDITABLE files can be modified to customize the theme. Call theme_workspace_status before editing a committed site to detect stale or draft workspace contents.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z
					.object({
						files: z.array(
							z.object({
								path: z.string(),
								size: z.number(),
								status: z.enum(["locked", "editable", "unknown"]),
							}),
						),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const result = await withSandboxTimeout(
				ctx,
				"theme_list_files",
				ctx.sandbox.listFiles(`${WORKSPACE}/src`, { recursive: true }),
			);
			const annotated = result
				.filter((f) => f.type === "file")
				.map((f) => {
					const path = f.relativePath.startsWith("src/")
						? f.relativePath
						: `src/${f.relativePath}`;
					return {
						path,
						size: f.size,
						status: isPathLocked(path, ctx.templateSlug)
							? "locked"
							: isPathEditable(path, ctx.templateSlug)
								? "editable"
								: "unknown",
					};
				});
			const output = { files: annotated };

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_read_file",
		{
			title: "Read Theme File",
			description:
				"Read the contents of a theme file. You can read both locked and editable files " +
				"to understand the current theme structure before making changes.",
			inputSchema: schema(
				z.object({
					path: z
						.string()
						.describe(
							"File path relative to the theme root (e.g. 'src/pages/index.astro')",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						content: z.string().describe("Raw file contents"),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => {
			const result = await withSandboxTimeout(
				ctx,
				`theme_read_file ${args.path}`,
				ctx.sandbox.readFile(`${WORKSPACE}/${args.path}`),
			);
			const output = { content: result.content };
			return {
				content: [{ type: "text" as const, text: output.content }],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_write_file",
		{
			title: "Write Theme File",
			description:
				"Create or update a theme file. Only files in editable directories are allowed: " +
				"src/styles/, src/layouts/, src/components/, src/pages/. " +
				"Locked files (middleware.ts, worker.ts, live.config.ts, etc.) cannot be modified. " +
				"Provide the COMPLETE file contents — not a diff or patch.",
			inputSchema: schema(
				z.object({
					path: z
						.string()
						.describe(
							"File path relative to theme root (e.g. 'src/pages/index.astro')",
						),
					content: z.string().describe("Complete file contents"),
				}),
			),
		},
		async (args: any) => {
			if (!isPathEditable(args.path, ctx.templateSlug)) {
				const reason = isPathLocked(args.path, ctx.templateSlug)
					? `"${args.path}" is a locked file — it contains critical CMS infrastructure that must not be modified`
					: `"${args.path}" is outside editable directories (${EDITABLE_DIRS.join(", ")})`;
				return {
					content: [{ type: "text" as const, text: `[FORBIDDEN] ${reason}` }],
					isError: true as const,
				};
			}

			await withSandboxTimeout(
				ctx,
				`theme_write_file ${args.path}`,
				ctx.sandbox.writeFile(`${WORKSPACE}/${args.path}`, args.content),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Written ${args.path} (${args.content.length} bytes)`,
					},
				],
			};
		},
	);

	server.registerTool(
		"theme_delete_file",
		{
			title: "Delete Theme File",
			description:
				"Delete a theme file. Only editable files can be deleted. " +
				"Use this to remove custom components or pages you no longer need.",
			inputSchema: schema(
				z.object({
					path: z.string().describe("File path to delete"),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => {
			if (!isPathEditable(args.path, ctx.templateSlug)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[FORBIDDEN] Cannot delete "${args.path}" — locked or outside editable directories`,
						},
					],
					isError: true as const,
				};
			}

			await ctx.sandbox.deleteFile(`${WORKSPACE}/${args.path}`);
			return {
				content: [{ type: "text" as const, text: `Deleted ${args.path}` }],
			};
		},
	);

	server.registerTool(
		"theme_write_files",
		{
			title: "Write Multiple Theme Files",
			description:
				"Create or update multiple theme files at once. Use this for coordinated changes " +
				"across pages, layouts, components, and styles. All files must be in editable " +
				"directories. Provide COMPLETE file contents for each file.",
			inputSchema: schema(
				z.object({
					files: z
						.array(
							z.object({
								path: z.string().describe("File path relative to theme root"),
								content: z.string().describe("Complete file contents"),
							}),
						)
						.describe("Array of files to write"),
					reasoning: z
						.string()
						.optional()
						.describe("Brief explanation of the changes being made"),
				}),
			),
		},
		async (args: any) => {
			const results: string[] = [];
			const errors: string[] = [];

			for (const file of args.files) {
				if (!isPathEditable(file.path, ctx.templateSlug)) {
					errors.push(
						`SKIPPED ${file.path} — locked or outside editable directories`,
					);
					continue;
				}
				await withSandboxTimeout(
					ctx,
					`theme_write_files ${file.path}`,
					ctx.sandbox.writeFile(`${WORKSPACE}/${file.path}`, file.content),
				);
				results.push(`Written ${file.path} (${file.content.length} bytes)`);
			}

			const output = [...results, ...errors].join("\n");
			return {
				content: [{ type: "text" as const, text: output }],
				isError:
					errors.length > 0 && results.length === 0
						? (true as const)
						: undefined,
			};
		},
	);
}

function registerHotThemeTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"read_hot_theme",
		{
			title: "Read Hot Theme",
			description:
				"Read the sandbox-free hot theme CSS published for this tenant. " +
				"This reads R2 directly and does not open the Site Builder sandbox.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						publicPath: z.string(),
						css: z.string(),
						manifest: z
							.object({
								orgSlug: z.string(),
								cssKey: z.string(),
								historyKey: z.string().optional(),
								previousRevision: z.string().nullable().optional(),
								revision: z.string(),
								revisionKey: z.string().optional(),
								size: z.number().int(),
								sha256: z.string(),
								updatedAt: z.string(),
								summary: z.string().optional(),
							})
							.passthrough()
							.nullable(),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const [manifest, css] = await Promise.all([
				readHotThemeManifest(ctx.bundlesBucket, ctx.orgSlug),
				readHotThemeCss(ctx.bundlesBucket, ctx.orgSlug),
			]);
			const output = {
				orgSlug: ctx.orgSlug,
				publicPath: HOT_THEME_PUBLIC_PATH,
				css: css ?? "",
				manifest,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"write_hot_theme",
		{
			title: "Write Hot Theme",
			description:
				"Publish sandbox-free CSS for the tenant at /_tedix/theme.css. " +
				"Use this for near-instant visual changes such as colors, spacing, typography, and small layout overrides. " +
				"It writes R2 + D1 metadata directly and does not run Astro build or touch the Site Builder sandbox.",
			inputSchema: schema(
				z.object({
					css: z
						.string()
						.max(120_000)
						.describe("Complete CSS to serve from /_tedix/theme.css."),
					summary: z
						.string()
						.max(300)
						.optional()
						.describe("Short operator summary for the hot theme revision."),
					confirmLivePublish: z
						.boolean()
						.describe(
							"Must be true. This publishes to the live tenant immediately.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						publicPath: z.string(),
						cssKey: z.string(),
						historyKey: z.string().optional(),
						manifestKey: z.string(),
						previousRevision: z.string().nullable().optional(),
						revision: z.string(),
						revisionKey: z.string().optional(),
						size: z.number().int(),
						sha256: z.string(),
						updatedAt: z.string(),
						summary: z.string().optional(),
					})
					.passthrough(),
			),
			annotations: { destructiveHint: true },
		},
		async (args: {
			css: string;
			summary?: string;
			confirmLivePublish: boolean;
		}) => {
			if (!args.confirmLivePublish) {
				return forbidden(
					"write_hot_theme publishes directly to the live CMS runtime; pass confirmLivePublish:true",
				);
			}
			if (/<\/?\s*script\b/i.test(args.css)) {
				return forbidden("Hot theme CSS must not contain script tags.");
			}

			const manifest = await writeHotThemeCss(ctx, {
				css: args.css,
				summary: args.summary,
			});
			const output = {
				...manifest,
				publicPath: HOT_THEME_PUBLIC_PATH,
				manifestKey: hotThemeManifestKey(ctx.orgSlug),
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"list_hot_theme_revisions",
		{
			title: "List Hot Theme Revisions",
			description:
				"List the bounded R2-backed hot-theme CSS revision history for this tenant. " +
				"Use this before rollback_hot_theme when a live CSS-only change needs to be reversed without using the Site Builder sandbox.",
			inputSchema: schema(
				z.object({
					limit: z
						.number()
						.int()
						.min(1)
						.max(25)
						.optional()
						.describe("Maximum revisions to return. Default 10."),
				}),
			),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						currentRevision: z.string().nullable(),
						updatedAt: z.string(),
						revisions: z.array(
							z.object({
								activatedAt: z.string(),
								createdAt: z.string(),
								revision: z.string(),
								revisionKey: z.string(),
								sha256: z.string(),
								size: z.number().int(),
								sourceRepo: z
									.object({
										name: z.string(),
										remote: z.string(),
										defaultBranch: z.string().optional(),
									})
									.optional(),
								summary: z.string().optional(),
							}),
						),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { limit?: number }) => {
			const history = await listHotThemeRevisions(
				ctx.bundlesBucket,
				ctx.orgSlug,
			);
			const output = {
				...history,
				revisions: history.revisions.slice(0, args.limit ?? 10),
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"rollback_hot_theme",
		{
			title: "Rollback Hot Theme",
			description:
				"Promote a previous R2-backed hot-theme CSS revision back to /_tedix/theme.css without opening the Site Builder sandbox or running an Astro build.",
			inputSchema: schema(
				z.object({
					revision: z
						.string()
						.regex(/^[a-f0-9]{12}$/)
						.describe("Revision from list_hot_theme_revisions."),
					summary: z
						.string()
						.max(300)
						.optional()
						.describe("Short operator summary for the rollback revision."),
					confirmLivePublish: z
						.boolean()
						.describe(
							"Must be true. This immediately changes the live tenant hot-theme CSS.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						publicPath: z.string(),
						cssKey: z.string(),
						historyKey: z.string().optional(),
						manifestKey: z.string(),
						previousRevision: z.string().nullable().optional(),
						revision: z.string(),
						revisionKey: z.string().optional(),
						size: z.number().int(),
						sha256: z.string(),
						updatedAt: z.string(),
						summary: z.string().optional(),
					})
					.passthrough(),
			),
			annotations: { destructiveHint: true },
		},
		async (args: {
			revision: string;
			summary?: string;
			confirmLivePublish: boolean;
		}) => {
			if (!args.confirmLivePublish) {
				return forbidden(
					"rollback_hot_theme publishes directly to the live CMS runtime; pass confirmLivePublish:true",
				);
			}
			const manifest = await rollbackHotThemeCss(ctx, {
				revision: args.revision,
				summary: args.summary,
			});
			const output = {
				...manifest,
				publicPath: HOT_THEME_PUBLIC_PATH,
				manifestKey: hotThemeManifestKey(ctx.orgSlug),
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"provision_theme_artifact_repo",
		{
			title: "Provision Theme Artifact Repo",
			description:
				"Create or read the tenant's Cloudflare Artifacts Git repo and mint a short-lived Git token for editable theme source handoff. " +
				"The repo is for agent/operator authoring and review; hot live CSS still publishes through write_hot_theme. " +
				"Pass seedFromSandbox:true with scope:'write' to start a pollable seed job that pushes the current sandbox theme source into the repo.",
			inputSchema: schema(
				z.object({
					scope: z
						.enum(["read", "write"])
						.optional()
						.describe("Token scope. Default read."),
					ttlSeconds: z
						.number()
						.int()
						.min(60)
						.max(3600)
						.optional()
						.describe("Short-lived Git token TTL. Default 1800 seconds."),
					seedFromSandbox: z
						.boolean()
						.optional()
						.describe(
							"Start a background seed job that pushes the current /workspace theme source into the Artifacts repo. Requires scope:'write'. Defaults to false.",
						),
					forceSeed: z
						.boolean()
						.optional()
						.describe(
							"Overwrite the target branch when seedFromSandbox is true and the repo already has that branch. Defaults to false.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						orgSlug: z.string(),
						repoName: z.string(),
						remote: z.string(),
						defaultBranch: z.string().optional(),
						scope: z.enum(["read", "write"]),
						token: z.string().optional(),
						expiresAt: z.union([z.string(), z.number()]).optional(),
						created: z.boolean(),
						seedJob: z
							.object({
								jobId: z.string(),
								status: z.enum([
									"running",
									"complete",
									"failed",
									"timeout",
									"cancelled",
								]),
								running: z.boolean(),
								startedAt: z.string().nullable(),
								durationMs: z.number().int().nullable(),
								seed: z.record(z.string(), z.unknown()).nullable(),
								message: z.string(),
							})
							.passthrough()
							.optional(),
					})
					.passthrough(),
			),
		},
		async (args: {
			forceSeed?: boolean;
			scope?: "read" | "write";
			seedFromSandbox?: boolean;
			ttlSeconds?: number;
		}) => {
			if (!ctx.artifacts) {
				return {
					content: [
						{
							type: "text" as const,
							text: "[ERROR] CMS Artifacts binding is not configured.",
						},
					],
					isError: true as const,
				};
			}

			const repoName = themeArtifactRepoName(ctx.orgSlug);
			const scope = args.scope ?? "read";
			const ttlSeconds = args.ttlSeconds ?? 1800;
			if (args.seedFromSandbox && scope !== "write") {
				return forbidden(
					"seedFromSandbox pushes theme source to Git; request scope:'write' so the short-lived token can push.",
				);
			}
			let created = false;
			let repo: import("../types").ArtifactsRepoHandle;
			try {
				repo = await ctx.artifacts.get(repoName);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/not.?found|NOT_FOUND|404/i.test(message)) throw error;
				await ctx.artifacts.create(repoName, {
					description: `CMS theme source for ${ctx.orgSlug}`,
					readOnly: false,
					setDefaultBranch: "main",
				});
				repo = await ctx.artifacts.get(repoName);
				created = true;
			}

			const tokenResult = await repo.createToken(scope, ttlSeconds);
			const remote = themeArtifactRemote(
				ctx.artifactsAccountId,
				ctx.orgSlug,
				ctx.artifactsNamespace,
			);
			const defaultBranch = "main";
			const plaintext = await tokenResult.plaintext;
			const expiresAt = await tokenResult.expiresAt;
			const seedLaunch = args.seedFromSandbox
				? await withSandboxTimeout(
						ctx,
						"provision_theme_artifact_repo seedFromSandbox launch",
						startThemeArtifactRepoSeed(ctx, {
							branch: defaultBranch,
							forceSeed: args.forceSeed === true,
							remote,
							token: plaintext,
						}),
					)
				: undefined;
			let seedJob = seedLaunch
				? themeArtifactSeedOutput({
						jobId: seedLaunch.jobId,
						status: "running",
						exitCode: null,
						running: true,
						startedAt: seedLaunch.startedAt,
						durationMs: 0,
						seed: null,
						stdoutTail: "",
						stderrTail: "",
						logTail: "",
						message:
							"CMS theme artifact seed started; poll theme_artifact_seed_status with this jobId.",
					})
				: undefined;
			if (seedJob) {
				const initial = seedJob;
				seedJob = await updateStoredJobReceipt(
					ctx.storage,
					cmsThemeArtifactSeedStatusKey(ctx.orgSlug, initial.jobId),
					async () => initial,
				);
			}

			const output = {
				orgSlug: ctx.orgSlug,
				repoName,
				remote,
				defaultBranch,
				scope,
				token: plaintext,
				expiresAt,
				created,
				seedJob,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"read_theme_artifact_file",
		{
			title: "Read Theme Artifact File",
			description:
				"Read one editable text file from an exact commit in this tenant's Artifacts theme repo without changing the Site Builder sandbox. The short-lived read token stays server-side.",
			inputSchema: schema(
				z.object({
					sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
					path: z.string().min(1),
				}),
			),
			outputSchema: schema(
				z.object({
					sourceCommit: z.string(),
					path: z.string(),
					content: z.string(),
					sizeBytes: z.number(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { sourceCommit: string; path: string }) => {
			if (!ctx.artifacts) {
				return forbidden("CMS Artifacts binding is not configured");
			}
			const output = await readThemeArtifactFile({
				orgSlug: ctx.orgSlug,
				templateSlug: ctx.templateSlug,
				sourceCommit: args.sourceCommit,
				path: args.path,
				artifacts: ctx.artifacts,
			});
			return {
				content: [{ type: "text" as const, text: JSON.stringify(output) }],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"checkout_theme_artifact_source",
		{
			title: "Check Out Theme Artifact Source",
			description:
				"Load the editable Astro/CSS files from one exact commit in this tenant's Artifacts theme repo into the disposable Site Builder sandbox. " +
				"Use theme_read_file after this to inspect and edit the current source. This replaces unsaved editable sandbox files but does not deploy or publish. Locked template files remain platform-owned. The read token stays server-side.",
			inputSchema: schema(
				z.object({
					sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
					confirmReplaceSandbox: z.literal(true),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: { sourceCommit: string; confirmReplaceSandbox: true }) => {
			if (!ctx.artifacts)
				return forbidden("CMS Artifacts binding is not configured");
			const repo = await ctx.artifacts.get(themeArtifactRepoName(ctx.orgSlug));
			const tokenResult = await repo.createToken("read", 600);
			await materializeEditableThemeSource(ctx.sandbox, {
				remote: themeArtifactRemote(
					ctx.artifactsAccountId,
					ctx.orgSlug,
					ctx.artifactsNamespace,
				),
				token: await tokenResult.plaintext,
				commit: args.sourceCommit,
				templateSlug: ctx.templateSlug,
			});
			const source = await digestEditableThemeSource(
				ctx.sandbox,
				ctx.templateSlug,
			);
			const output = {
				sourceCommit: args.sourceCommit,
				...source,
				sandboxPath: WORKSPACE,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"commit_theme_artifact_files",
		{
			title: "Commit Theme Files to Artifacts",
			description:
				"Commit complete editable Astro/CSS file contents to the tenant's existing Artifacts Git main branch. " +
				"The server handles the short-lived Git token; no credential is returned. Pass the current full main commit as expectedHead. " +
				"Poll theme_artifact_commit_status for the commit SHA, then pass that SHA to theme_deploy.sourceCommit. " +
				"A changed main branch is reported as a conflict; this tool never force-pushes or deploys.",
			inputSchema: schema(
				z.object({
					expectedHead: z.string().regex(/^[0-9a-f]{40}$/),
					message: z.string().min(1).max(200),
					files: z
						.array(
							z.object({
								path: z.string().min(1),
								content: z.string().max(256_000),
							}),
						)
						.min(1)
						.max(20),
				}),
			),
		},
		async (args: {
			expectedHead: string;
			message: string;
			files: Array<{ path: string; content: string }>;
		}) => {
			if (!ctx.artifacts)
				return forbidden("CMS Artifacts binding is not configured");
			const paths = args.files.map((file) => file.path);
			if (
				new Set(paths).size !== paths.length ||
				paths.some((path) => !isPathEditable(path, ctx.templateSlug))
			) {
				return forbidden(
					"Every path must be unique and editable for this tenant template",
				);
			}
			if (
				paths.some(
					(path) =>
						!/^[a-zA-Z0-9._/\[\]-]+$/.test(path) ||
						path
							.split("/")
							.some(
								(segment) =>
									!segment ||
									segment === "." ||
									segment === ".." ||
									segment === ".git",
							),
				)
			) {
				return forbidden(
					"Theme artifact paths may contain only letters, numbers, dot, underscore, dash, slash, and brackets",
				);
			}
			const repo = await ctx.artifacts.get(themeArtifactRepoName(ctx.orgSlug));
			const tokenResult = await repo.createToken("write", 600);
			const launch = await withSandboxTimeout(
				ctx,
				"commit_theme_artifact_files launch",
				startThemeArtifactRepoCommit(ctx, {
					branch: "main",
					expectedHead: args.expectedHead,
					files: args.files,
					message: args.message,
					remote: themeArtifactRemote(
						ctx.artifactsAccountId,
						ctx.orgSlug,
						ctx.artifactsNamespace,
					),
					token: await tokenResult.plaintext,
				}),
			);
			const receipt = await updateStoredJobReceipt(
				ctx.storage,
				cmsThemeArtifactCommitStatusKey(ctx.orgSlug, launch.jobId),
				async () =>
					themeArtifactSeedOutput({
						jobId: launch.jobId,
						status: "running",
						exitCode: null,
						running: true,
						startedAt: launch.startedAt,
						durationMs: 0,
						seed: null,
						stdoutTail: "",
						stderrTail: "",
						logTail: "",
						message: "CMS theme artifact commit started",
					}),
			);
			const output = {
				jobId: launch.jobId,
				status: receipt.status,
				message: receipt.message,
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(output) }],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_artifact_commit_status",
		{
			title: "Check Theme Artifact Commit Status",
			description:
				"Read the result of commit_theme_artifact_files. A complete result may report a conflict or unchanged files instead of a new commit.",
			inputSchema: schema(
				z.object({ jobId: z.string().regex(/^[a-zA-Z0-9._-]{1,96}$/) }),
			),
		},
		async (args: { jobId: string }) => {
			const receipt = await updateStoredJobReceipt<ThemeArtifactSeedOutput>(
				ctx.storage,
				cmsThemeArtifactCommitStatusKey(ctx.orgSlug, args.jobId),
				async () =>
					themeArtifactSeedOutput(
						await readThemeArtifactRepoCommitStatus(ctx.sandbox, args.jobId),
					),
			);
			const { seed, ...rest } = receipt;
			const output = { ...rest, result: seed };
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_artifact_seed_status",
		{
			title: "Check Theme Artifact Seed Status",
			description:
				"Check a source-handoff seed job started by provision_theme_artifact_repo. " +
				"Uses short Sandbox process probes and returns the latest Git push result/log tails.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,96}$/)
						.describe(
							"Seed job ID returned by provision_theme_artifact_repo.seedJob.jobId.",
						),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					seed: z.record(z.string(), z.unknown()).nullable(),
					stdoutTail: z.string(),
					stderrTail: z.string(),
					logTail: z.string(),
					message: z.string(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { jobId: string }) => {
			const output = await updateStoredJobReceipt<ThemeArtifactSeedOutput>(
				ctx.storage,
				cmsThemeArtifactSeedStatusKey(ctx.orgSlug, args.jobId),
				async () =>
					themeArtifactSeedOutput(
						await readThemeArtifactRepoSeedStatus(ctx.sandbox, args.jobId),
					),
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_artifact_seed_cancel",
		{
			title: "Cancel Theme Artifact Seed",
			description:
				"Cancel a running source-handoff seed job started by provision_theme_artifact_repo.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,96}$/)
						.describe(
							"Seed job ID returned by provision_theme_artifact_repo.seedJob.jobId.",
						),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					seed: z.record(z.string(), z.unknown()).nullable(),
					stdoutTail: z.string(),
					stderrTail: z.string(),
					logTail: z.string(),
					message: z.string(),
					cancelled: z.boolean(),
					previousStatus: z.string().nullable(),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: { jobId: string }) => {
			let cancellation:
				| { cancelled: boolean; previousStatus: string | null }
				| undefined;
			const receipt = await updateStoredJobReceipt<ThemeArtifactSeedOutput>(
				ctx.storage,
				cmsThemeArtifactSeedStatusKey(ctx.orgSlug, args.jobId),
				async () => {
					const snapshot = await cancelThemeArtifactRepoSeed(
						ctx.sandbox,
						args.jobId,
					);
					cancellation = snapshot;
					return themeArtifactSeedOutput(snapshot);
				},
			);
			const output = {
				...receipt,
				cancelled:
					receipt.status === "cancelled" && (cancellation?.cancelled ?? false),
				previousStatus: cancellation?.previousStatus ?? receipt.status,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);
}

function registerTemplateSyncTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"theme_resync_template",
		{
			title: "Resync Theme Template",
			description:
				"Copy the in-repo canonical starter template back into the Site Builder sandbox. " +
				"Use this when the Site Builder Worker bundle is newer than the seeded sandbox " +
				"(e.g. after a locked-file fix or new SEO route). " +
				"Default scope 'locked' overwrites only LOCKED files — the legitimate way " +
				"to update CMS infrastructure without touching vibe-coded theme work. " +
				"scope='all' overwrites ALL snapshot files (locked + editable scaffolds) and " +
				"requires confirm:true. It removes absent files only if they still match a known starter; custom files are preserved. scope='files' targets a specific list of paths.",
			inputSchema: schema(
				z.object({
					scope: z
						.enum(["locked", "all", "files"])
						.optional()
						.describe(
							"Default 'locked'. 'all' wipes editable files too — destructive. 'files' = per-path.",
						),
					paths: z
						.array(z.string())
						.optional()
						.describe(
							"Required when scope='files'. Paths must exist in the bundled template snapshot.",
						),
					confirm: z
						.boolean()
						.optional()
						.describe(
							"Required when scope='all'. Acknowledges editable file overwrite.",
						),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => {
			try {
				const result = await resyncTemplate(ctx.sandbox, {
					scope: args.scope,
					paths: args.paths,
					confirm: args.confirm,
					templateSlug: ctx.templateSlug,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{ ...result, sandboxId: ctx.orgSlug },
								null,
								2,
							),
						},
					],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `[ERROR] ${msg}` }],
					isError: true as const,
				};
			}
		},
	);

	server.registerTool(
		"theme_diff_template",
		{
			title: "Diff Sandbox vs Template",
			description:
				"Compare files in the Site Builder sandbox against the in-repo canonical starter. " +
				"Returns paths whose SHA-256 hashes differ. Default scope 'locked' only — " +
				"editable files drift by design (vibe-coded). Use scope='all' to see every " +
				"snapshot path (noisier, but useful for full audits). " +
				"clean=true means no drift in the requested scope. " +
				"Pre-deploy preflight calls this with scope='locked' and refuses to deploy if drift is found.",
			inputSchema: schema(
				z.object({
					scope: z
						.enum(["locked", "all"])
						.optional()
						.describe(
							"Default 'locked'. 'all' includes editable scaffolds too.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						drifted: z.array(
							z.object({
								path: z.string(),
								locked: z.boolean(),
								sandboxHash: z.string(),
								repoHash: z.string(),
							}),
						),
						clean: z.boolean(),
						scope: z.enum(["locked", "all"]),
						checked: z.number().int(),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => {
			const result = await withSandboxTimeout(
				ctx,
				`theme_diff_template ${args.scope ?? "locked"}`,
				diffTemplate(ctx.sandbox, args.scope ?? "locked", ctx.templateSlug),
			);
			const output = { ...result };
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_fleet_status",
		{
			title: "Inspect CMS Fleet Status",
			description:
				"Report active bundle versions, stale-version drift, routing metadata, and optional " +
				"locked-template drift for the CMS tenant fleet. Platform admins can omit orgs to scan " +
				"all active tenants; non-admin callers scan only their current org unless orgs contains only that org.",
			inputSchema: schema(
				z.object({
					orgs: z
						.array(z.string())
						.optional()
						.describe(
							"Org slugs to inspect. Omit for all active orgs when platform admin, otherwise current org only.",
						),
					scope: z
						.enum(["locked", "all"])
						.optional()
						.describe("Template diff scope. Default 'locked'."),
					includeTemplateDiff: z
						.boolean()
						.optional()
						.describe(
							"Whether to diff each sandbox against its selected template snapshot. Default true.",
						),
				}),
			),
			outputSchema: schema(
				z
					.object({
						generatedAt: z.string(),
						scope: z.enum(["locked", "all"]),
						includeTemplateDiff: z.boolean(),
						summary: z.object({
							targetCount: z.number().int(),
							reportedCount: z.number().int(),
							missingOrInactive: z.array(z.string()),
							staleActiveCount: z.number().int(),
							templateDriftCount: z.number().int(),
							errorCount: z.number().int(),
						}),
						tenants: z.array(
							z.object({
								slug: z.string(),
								activeVersion: z.number().int().nullable(),
								latestVersion: z.number().int().nullable(),
								staleActive: z.boolean(),
								deployedAt: z.string().nullable(),
								promptSummary: z.string().nullable(),
								routing: z.object({
									defaultLocale: z.string().nullable(),
									cmsDomain: z.string().nullable(),
									publicSiteUrl: z.string().nullable(),
								}),
								template: z
									.object({
										scope: z.enum(["locked", "all"]),
										clean: z.boolean(),
										checked: z.number().int(),
										driftedCount: z.number().int(),
										drifted: z.array(
											z.object({
												path: z.string(),
												locked: z.boolean(),
											}),
										),
									})
									.optional(),
								error: z.string().optional(),
							}),
						),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: {
			orgs?: string[];
			scope?: "locked" | "all";
			includeTemplateDiff?: boolean;
		}) => {
			const scope = args.scope ?? "locked";
			const includeTemplateDiff = args.includeTemplateDiff !== false;
			const allRows = await listCmsFleetBundles(ctx.db);
			const targetSlugs =
				args.orgs && args.orgs.length > 0
					? Array.from(new Set(args.orgs))
					: ctx.isPlatformAdmin
						? allRows.map((row) => row.slug)
						: [ctx.orgSlug];

			const crossOrgSlug = targetSlugs.find((slug) => slug !== ctx.orgSlug);
			if (crossOrgSlug) {
				const guard = requirePlatformAdminForOrg(
					ctx,
					crossOrgSlug,
					"inspect CMS fleet status for",
				);
				if (guard) return guard;
			}

			const rowBySlug = new Map(allRows.map((row) => [row.slug, row]));
			const missingOrInactive = targetSlugs.filter(
				(slug) => !rowBySlug.has(slug),
			);
			const tenants: Array<{
				slug: string;
				activeVersion: number | null;
				latestVersion: number | null;
				staleActive: boolean;
				deployedAt: string | null;
				promptSummary: string | null;
				routing: {
					defaultLocale: string | null;
					cmsDomain: string | null;
					publicSiteUrl: string | null;
				};
				template?: {
					scope: "locked" | "all";
					clean: boolean;
					checked: number;
					driftedCount: number;
					drifted: Array<{ path: string; locked: boolean }>;
				};
				error?: string;
			}> = [];

			for (const slug of targetSlugs) {
				const row = rowBySlug.get(slug);
				if (!row) continue;

				const tenant = {
					slug,
					activeVersion: row.activeVersion,
					latestVersion: row.latestVersion,
					staleActive:
						row.activeVersion !== null &&
						row.latestVersion !== null &&
						row.activeVersion < row.latestVersion,
					deployedAt: row.deployedAt,
					promptSummary: row.promptSummary,
					routing: {
						defaultLocale: row.defaultLocale,
						cmsDomain: row.cmsDomain,
						publicSiteUrl: row.publicSiteUrl,
					},
				} as (typeof tenants)[number];

				if (includeTemplateDiff) {
					try {
						const diff = await withSandboxTimeout(
							{ orgSlug: slug },
							`theme_fleet_status diffTemplate ${scope}`,
							diffTemplate(
								ctx.getSandboxForOrg(slug),
								scope,
								normalizeCmsTemplateSlug(row.templateSlug),
							),
						);
						tenant.template = {
							scope,
							clean: diff.clean,
							checked: diff.checked,
							driftedCount: diff.drifted.length,
							drifted: diff.drifted.slice(0, 25).map((entry) => ({
								path: entry.path,
								locked: entry.locked,
							})),
						};
					} catch (err) {
						tenant.error = err instanceof Error ? err.message : String(err);
					}
				}

				tenants.push(tenant);
			}

			const staleActiveCount = tenants.filter(
				(tenant) => tenant.staleActive,
			).length;
			const templateDriftCount = tenants.filter(
				(tenant) => tenant.template && !tenant.template.clean,
			).length;
			const errorCount = tenants.filter((tenant) => tenant.error).length;
			const output = {
				generatedAt: new Date().toISOString(),
				scope,
				includeTemplateDiff,
				summary: {
					targetCount: targetSlugs.length,
					reportedCount: tenants.length,
					missingOrInactive,
					staleActiveCount,
					templateDriftCount,
					errorCount,
				},
				tenants,
			};

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(output, null, 2),
					},
				],
				structuredContent: output,
				isError:
					errorCount > 0 && tenants.length === errorCount ? true : undefined,
			};
		},
	);
}

function registerPreviewTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	const previewExposureSchema = z
		.enum(CMS_PREVIEW_EXPOSURES)
		.optional()
		.describe(
			"Preview URL exposure through the authenticated CMS preview route.",
		);
	const previewOutputSchema = schema(
		z.object({
			status: z.enum(["starting", "running", "stopped", "failed", "not_found"]),
			processStatus: z.string().nullable(),
			running: z.boolean(),
			processId: z.string(),
			port: z.number().int(),
			previewUrl: z.string().nullable(),
			previewUrlMode: z.enum(CMS_PREVIEW_EXPOSURES).nullable(),
			previewUrlEphemeral: z.boolean(),
			startedAt: z.string().nullable(),
			durationMs: z.number().int().nullable(),
			exitCode: z.number().int().nullable(),
			logTail: z.string(),
			message: z.string(),
		}),
	);

	server.registerTool(
		"theme_preview_start",
		{
			title: "Start Theme Preview",
			description:
				"Start or reuse the Astro dev server behind the authenticated CMS preview route. " +
				"The preview shows the theme with the org's real CMS content and reloads when theme files change.",
			inputSchema: schema(z.object({ exposure: previewExposureSchema })),
			outputSchema: previewOutputSchema,
		},
		async (args: { exposure?: (typeof CMS_PREVIEW_EXPOSURES)[number] }) => {
			const snapshot = await withSandboxTimeout(
				ctx,
				"theme_preview_start",
				startCmsPreview(ctx.sandbox, {
					previewHostname: ctx.previewHostname,
					exposure: args.exposure,
				}),
				95_000,
			);
			const output = previewStatusOutput(snapshot);

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(output, null, 2),
					},
				],
				structuredContent: output,
				isError: output.status === "failed" ? (true as const) : undefined,
			};
		},
	);

	server.registerTool(
		"theme_preview_status",
		{
			title: "Check Theme Preview Status",
			description:
				"Check the Astro dev preview process and authenticated preview URL without starting a new process.",
			inputSchema: schema(z.object({ exposure: previewExposureSchema })),
			outputSchema: previewOutputSchema,
			annotations: { readOnlyHint: true },
		},
		async (args: { exposure?: (typeof CMS_PREVIEW_EXPOSURES)[number] }) => {
			const snapshot = await withSandboxTimeout(
				ctx,
				"theme_preview_status",
				readCmsPreviewStatus(ctx.sandbox, {
					previewHostname: ctx.previewHostname,
					preferredExposure: args.exposure,
				}),
			);
			const output = previewStatusOutput(snapshot);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError: output.status === "failed" ? (true as const) : undefined,
			};
		},
	);

	server.registerTool(
		"theme_preview_stop",
		{
			title: "Stop Theme Preview",
			description: "Stop the Astro dev preview process.",
			inputSchema: schema(z.object({})),
			outputSchema: previewOutputSchema,
			annotations: { destructiveHint: true },
		},
		async () => {
			const snapshot = await withSandboxTimeout(
				ctx,
				"theme_preview_stop",
				stopCmsPreview(ctx.sandbox, ctx.previewHostname),
			);
			const output = previewStatusOutput(snapshot);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError: output.status === "failed" ? (true as const) : undefined,
			};
		},
	);

	server.registerTool(
		"theme_preview_exec",
		{
			title: "Run Command in Preview Container",
			description:
				"Start a command in an preview process without holding a long Sandbox control request open. " +
				"Useful for checking build errors, inspecting files, or running astro check. " +
				"Returns a jobId immediately; poll theme_preview_exec_status until complete or failed.",
			inputSchema: schema(
				z.object({
					command: z.string().describe("Shell command to execute"),
					waitMs: z
						.number()
						.int()
						.min(0)
						.max(45_000)
						.optional()
						.describe(
							"Optional initial wait before returning status. Default 3000ms, max 45000ms.",
						),
					timeoutMs: z
						.number()
						.int()
						.min(1000)
						.max(120_000)
						.optional()
						.describe("Maximum command runtime before status reports timeout."),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					command: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					stdoutTail: z.string(),
					stderrTail: z.string(),
					logTail: z.string(),
					message: z.string(),
				}),
			),
		},
		async (args: { command: string; waitMs?: number; timeoutMs?: number }) => {
			const launch = await withSandboxTimeout(
				ctx,
				`theme_preview_exec ${String(args.command).slice(0, 120)}`,
				startCmsPreviewExec(ctx.sandbox, {
					command: args.command,
					timeoutMs: args.timeoutMs,
				}),
				SANDBOX_LAUNCH_TIMEOUT_MS,
			);
			let snapshot = await readCmsPreviewExecStatus(ctx.sandbox, launch.jobId, {
				command: args.command,
				timeoutMs: args.timeoutMs,
			});
			const waitMs = args.waitMs ?? 3000;
			const deadline = Date.now() + waitMs;
			while (snapshot.status === "running" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				snapshot = await readCmsPreviewExecStatus(ctx.sandbox, launch.jobId, {
					command: args.command,
					timeoutMs: args.timeoutMs,
				});
			}
			const output = await updateStoredJobReceipt(
				ctx.storage,
				cmsPreviewExecStatusKey(ctx.orgSlug, snapshot.jobId),
				async () => previewExecOutput(snapshot),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_preview_exec_status",
		{
			title: "Check Preview Command Status",
			description:
				"Check a command job started by theme_preview_exec. Uses short Sandbox process probes and returns stdout/stderr tails.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,96}$/)
						.describe("Job ID returned by theme_preview_exec."),
					timeoutMs: z
						.number()
						.int()
						.min(1000)
						.max(120_000)
						.optional()
						.describe("Maximum command runtime before status reports timeout."),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					command: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					stdoutTail: z.string(),
					stderrTail: z.string(),
					logTail: z.string(),
					message: z.string(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { jobId: string; timeoutMs?: number }) => {
			const output = await updateStoredJobReceipt<PreviewExecOutput>(
				ctx.storage,
				cmsPreviewExecStatusKey(ctx.orgSlug, args.jobId),
				async (previous) =>
					previewExecOutput(
						await readCmsPreviewExecStatus(ctx.sandbox, args.jobId, {
							command: previous?.command,
							timeoutMs: args.timeoutMs,
						}),
					),
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_preview_exec_cancel",
		{
			title: "Cancel Preview Command",
			description:
				"Cancel a running preview command job started by theme_preview_exec.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,96}$/)
						.describe("Job ID returned by theme_preview_exec."),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					command: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					stdoutTail: z.string(),
					stderrTail: z.string(),
					logTail: z.string(),
					message: z.string(),
					cancelled: z.boolean(),
					previousStatus: z.string().nullable(),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: { jobId: string }) => {
			let cancellation:
				| { cancelled: boolean; previousStatus: string | null }
				| undefined;
			const receipt = await updateStoredJobReceipt<PreviewExecOutput>(
				ctx.storage,
				cmsPreviewExecStatusKey(ctx.orgSlug, args.jobId),
				async () => {
					const snapshot = await cancelCmsPreviewExec(ctx.sandbox, args.jobId);
					cancellation = snapshot;
					return previewExecOutput(snapshot);
				},
			);
			const output = {
				...receipt,
				cancelled:
					receipt.status === "cancelled" && (cancellation?.cancelled ?? false),
				previousStatus: cancellation?.previousStatus ?? receipt.status,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);
}

function registerDeployTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"theme_build",
		{
			title: "Build Theme",
			description:
				"Start a build-only check for the current theme without holding a long Sandbox control request open. " +
				"Returns a jobId immediately; poll theme_build_status until complete or failed.",
			inputSchema: schema(
				z.object({
					waitMs: z
						.number()
						.int()
						.min(0)
						.max(45_000)
						.optional()
						.describe(
							"Optional initial wait before returning status. Default 5000ms, max 45000ms.",
						),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					message: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					successMarkerDetected: z.boolean(),
					logTail: z.string(),
					launchLog: z.string().optional(),
				}),
			),
		},
		async (args: { waitMs?: number }) => {
			const privacyBannerEnabled = await resolveCmsPrivacyBannerEnabled(
				ctx.db,
				ctx.orgSlug,
			);
			const publicBuildRoute = await getCmsPublicBuildRoute(
				ctx.db,
				ctx.orgSlug,
			);
			if (!publicBuildRoute)
				throw new Error(
					`CMS site ${ctx.orgSlug} has no active public build route`,
				);
			const build = await startCmsSandboxBuild(ctx.sandbox, {
				orgSlug: ctx.orgSlug,
				privacyBannerEnabled,
				...publicBuildRoute,
			});
			let snapshot = await readCmsSandboxBuildStatus(ctx.sandbox, build.jobId);
			const waitMs = args.waitMs ?? 5000;
			const deadline = Date.now() + waitMs;
			while (snapshot.status === "running" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				snapshot = await readCmsSandboxBuildStatus(ctx.sandbox, build.jobId);
			}
			const output = await updateStoredJobReceipt(
				ctx.storage,
				cmsBuildStatusKey(ctx.orgSlug, snapshot.jobId),
				async () => buildStatusOutput(snapshot),
			);

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_build_status",
		{
			title: "Check Theme Build Status",
			description:
				"Check a build-only job started by theme_build. Uses short Sandbox control probes and returns the current log tail.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,128}$/)
						.describe("Build job ID returned by theme_build."),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					message: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					successMarkerDetected: z.boolean(),
					logTail: z.string(),
					launchLog: z.string().optional(),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { jobId: string }) => {
			const output = await updateStoredJobReceipt<BuildStatusOutput>(
				ctx.storage,
				cmsBuildStatusKey(ctx.orgSlug, args.jobId),
				async () =>
					buildStatusOutput(
						await readCmsSandboxBuildStatus(ctx.sandbox, args.jobId),
					),
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_build_cancel",
		{
			title: "Cancel Theme Build",
			description:
				"Cancel a running build-only job started by theme_build. Uses the Sandbox SDK process API for the build process instead of a shell fallback.",
			inputSchema: schema(
				z.object({
					jobId: z
						.string()
						.regex(/^[a-zA-Z0-9._-]{1,128}$/)
						.describe("Build job ID returned by theme_build."),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.enum([
						"running",
						"complete",
						"failed",
						"timeout",
						"cancelled",
					]),
					exitCode: z.number().int().nullable(),
					running: z.boolean(),
					message: z.string(),
					startedAt: z.string().nullable(),
					durationMs: z.number().int().nullable(),
					successMarkerDetected: z.boolean(),
					logTail: z.string(),
					launchLog: z.string().optional(),
					cancelled: z.boolean(),
					previousStatus: z.string().nullable(),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: { jobId: string }) => {
			let cancellation:
				| { cancelled: boolean; previousStatus: string | null }
				| undefined;
			const receipt = await updateStoredJobReceipt<BuildStatusOutput>(
				ctx.storage,
				cmsBuildStatusKey(ctx.orgSlug, args.jobId),
				async () => {
					const snapshot = await cancelCmsSandboxBuild(ctx.sandbox, args.jobId);
					cancellation = snapshot;
					return buildStatusOutput(snapshot);
				},
			);
			const output = {
				...receipt,
				cancelled:
					receipt.status === "cancelled" && (cancellation?.cancelled ?? false),
				previousStatus: cancellation?.previousStatus ?? receipt.status,
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					output.status === "failed" || output.status === "timeout"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_deploy",
		{
			title: "Deploy Theme to Live CMS",
			description:
				"Kick off an async deploy of the current theme to {slug}.cms.tedix.dev. " +
				"Returns immediately with a jobId. The deploy runs in a Cloudflare Workflow: " +
				"build → snapshot → dispatch upload → version finalize, with per-step retries. " +
				"Poll theme_deploy_status with the jobId to see progress and the final URL. " +
				"Pass sourceCommit to build the editable theme from that commit of the tenant's Artifacts theme repo " +
				"(the builder workspace is overwritten with it and the bundle records the commit); " +
				"without it the builder's current workspace is built only when no prior Artifacts-backed bundle exists.",
			inputSchema: schema(
				z.object({
					summary: z
						.string()
						.optional()
						.describe("Brief description of the changes (for version history)"),
					sourceCommit: z
						.string()
						.regex(/^[a-f0-9]{40}$/)
						.optional()
						.describe(
							"Full 40-character commit in the tenant's cms-theme-{slug} Artifacts repo to build and record as the bundle source.",
						),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => {
			const guard = requirePlatformAdminForOrg(ctx, ctx.orgSlug, "deploy");
			if (guard) return guard;
			const { jobId } = await ctx.startDeploy(
				ctx.orgSlug,
				args.summary,
				args.sourceCommit,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								status: "queued",
								jobId,
								summary: args.summary,
								hint: "Call theme_deploy_status with this jobId to check progress. Builds typically finish within 60-120s.",
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	server.registerTool(
		"theme_deploy_status",
		{
			title: "Get Theme Deploy Status",
			description:
				"Check the status of a deploy started with theme_deploy. " +
				"Returns one of: queued, running, complete, failed. Includes the latest " +
				"workflow phase plus recent phase history (preflight, build-and-snapshot, " +
				"publish-bundle, health-check). On 'complete' the response includes the deployed version and live URL. " +
				"Every response carries a read-only humanAuthority object ({ state: active | stale | none, markerEtag, activeEtag, hint }) " +
				"describing whether the site's human assertion marker matches the currently active bundle; a deploy activates a new bundle, " +
				"so 'stale' means human cms_* OAuth calls fail until an admin runs get_human_auth_activation then set_human_auth_activation. " +
				"While the job is still running it reports the currently active bundle.",
			inputSchema: schema(
				z.object({
					jobId: z.string().describe("Job ID returned from theme_deploy"),
				}),
			),
			outputSchema: schema(
				z
					.object({
						status: z.enum([
							"queued",
							"running",
							"complete",
							"failed",
							"errored",
							"terminated",
							"paused",
							"unknown",
						]),
						jobId: z.string(),
						output: z
							.object({
								version: z.number().int(),
								url: z.string(),
							})
							.optional(),
						error: z.string().optional(),
						phase: z.string().optional(),
						message: z.string().optional(),
						updatedAt: z.string().optional(),
						history: z
							.array(
								z.object({
									phase: z.string(),
									status: z.string(),
									message: z.string().optional(),
									timestamp: z.string(),
									details: z.record(z.string(), z.unknown()).optional(),
								}),
							)
							.optional(),
						details: z.record(z.string(), z.unknown()).optional(),
						humanAuthority: z.object({
							state: z.enum(["active", "stale", "none"]),
							markerEtag: z.string().nullable(),
							activeEtag: z.string().nullable(),
							hint: z.string().optional(),
						}),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: any) => {
			const [status, humanAuthority] = await Promise.all([
				ctx.getDeployStatus(args.jobId),
				readThemeDeployHumanAuthority(ctx.db, ctx.orgSlug),
			]);
			const output = { ...status, humanAuthority };
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
				isError:
					status.status === "failed" || status.status === "errored"
						? (true as const)
						: undefined,
			};
		},
	);

	server.registerTool(
		"theme_verify_public_routes",
		{
			title: "Verify Public CMS Routes",
			description:
				"Check public HTML routes at this tenant's configured canonical site URL without a browser. " +
				"Reports status, title, H1, language, and canonical URL for each bounded relative route. " +
				"Tedix landing defaults to its home, localized pages, blog, and a published article; other sites default to home. " +
				"Pass routes to check additional pages or stronger title expectations. This is read-only and does not publish content.",
			inputSchema: schema(
				z.object({
					routes: z
						.array(
							z.object({
								path: z.string(),
								expectedLang: z.string().optional(),
								expectedTitle: z.string().optional(),
								expectedTitleContains: z.string().optional(),
								forbiddenTitle: z.string().optional(),
							}),
						)
						.min(1)
						.max(8)
						.optional(),
				}),
			),
			outputSchema: schema(
				z.object({
					ok: z.boolean(),
					checkedAt: z.string(),
					origin: z.string(),
					routes: z.array(
						z.object({
							path: z.string(),
							url: z.string(),
							status: z.number().int().nullable(),
							ok: z.boolean(),
							title: z.string().nullable(),
							h1: z.string().nullable(),
							canonical: z.string().nullable(),
							lang: z.string().nullable(),
							error: z.string().optional(),
						}),
					),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: { routes?: PublicCmsRouteExpectation[] }) => {
			const guard = requirePlatformAdminForOrg(
				ctx,
				ctx.orgSlug,
				"verify public routes for",
			);
			if (guard) return guard;
			const configured = await getCmsPublicBuildRoute(ctx.db, ctx.orgSlug);
			if (!configured?.publicSiteUrl) {
				throw new Error(
					`No active canonical public site URL for CMS tenant ${ctx.orgSlug}`,
				);
			}
			const output = await verifyPublicCmsRoutes({
				canonicalUrl: configured.publicSiteUrl,
				routes: args.routes ?? defaultCmsRouteExpectations(ctx.orgSlug),
			});
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_publish_receipt",
		{
			title: "Read Verified Theme Publish Receipt",
			description:
				"For a theme_deploy job, combine its terminal outcome, the currently active bundle and source, and fresh canonical public-page checks. " +
				"ready is true only when the same deployed version is still active and the public routes match. " +
				"A completed job alone is not publication proof.",
			inputSchema: schema(
				z.object({
					jobId: z.string().max(150),
					expectedSourceCommit: z
						.string()
						.regex(/^[a-f0-9]{40}$/)
						.optional(),
					routes: z
						.array(
							z.object({
								path: z.string(),
								expectedLang: z.string().optional(),
								expectedTitle: z.string().optional(),
								expectedTitleContains: z.string().optional(),
								forbiddenTitle: z.string().optional(),
							}),
						)
						.min(1)
						.max(8)
						.optional(),
				}),
			),
			outputSchema: schema(
				z.object({
					jobId: z.string(),
					status: z.string(),
					deployedVersion: z.number().int().nullable(),
					activeVersion: z.number().int().nullable(),
					sourceRevision: z
						.discriminatedUnion("kind", [
							z.object({
								kind: z.literal("artifacts_commit"),
								value: z.string(),
							}),
							z.object({
								kind: z.literal("editable_source_digest"),
								value: z.string(),
							}),
						])
						.nullable(),
					liveUrl: z.string().nullable(),
					routeHealth: z
						.object({
							ok: z.boolean(),
							checkedAt: z.string(),
							origin: z.string().optional(),
							routes: z.array(
								z.object({
									path: z.string(),
									url: z.string(),
									status: z.number().int().nullable(),
									ok: z.boolean(),
									title: z.string().nullable(),
									h1: z.string().nullable(),
									canonical: z.string().nullable(),
									lang: z.string().nullable(),
									error: z.string().optional(),
								}),
							),
						})
						.nullable(),
					ready: z.boolean(),
					issues: z.array(z.string()),
				}),
			),
			annotations: { readOnlyHint: true },
		},
		async (args: {
			jobId: string;
			expectedSourceCommit?: string;
			routes?: PublicCmsRouteExpectation[];
		}) => {
			const guard = requirePlatformAdminForOrg(
				ctx,
				ctx.orgSlug,
				"read publish receipt for",
			);
			if (guard) return guard;
			const site = await getActiveCmsSiteForPermit(ctx.db, ctx.orgSlug);
			parseCmsPublishJobId(args.jobId, site.siteId, site.restoreEpoch);
			const deploy = await ctx.getDeployStatus(args.jobId);
			let routeHealth:
				| Awaited<ReturnType<typeof verifyPublicCmsRoutes>>
				| undefined;
			if (deploy.status === "complete") {
				try {
					const configured = await getCmsPublicBuildRoute(ctx.db, ctx.orgSlug);
					if (configured?.publicSiteUrl) {
						routeHealth = await verifyPublicCmsRoutes({
							canonicalUrl: configured.publicSiteUrl,
							routes: args.routes ?? defaultCmsRouteExpectations(ctx.orgSlug),
						});
					}
				} catch {
					// Missing/unsafe public route configuration fails the receipt closed.
				}
			}
			const versions = await ctx.listVersions(ctx.orgSlug);
			const output = buildCmsPublishReceipt({
				orgSlug: ctx.orgSlug,
				siteId: site.siteId,
				restoreEpoch: site.restoreEpoch,
				jobId: args.jobId,
				deploy,
				versions,
				expectedSourceCommit: args.expectedSourceCommit,
				routeHealth,
			});
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_list_versions",
		{
			title: "List Theme Versions",
			description:
				"List all deployed theme versions with active status, source identity, timestamps, and summaries. " +
				"Use a version number with theme_rollback to restore a previous theme.",
			inputSchema: schema(z.object({})),
			outputSchema: schema(
				z
					.object({
						versions: z.array(
							z.object({
								version: z.number().int(),
								active: z.boolean(),
								deployedAt: z.string().nullable(),
								promptSummary: z.string().nullable(),
								sourceRevision: z
									.discriminatedUnion("kind", [
										z.object({
											kind: z.literal("artifacts_commit"),
											value: z.string().regex(/^[a-f0-9]{40}$/),
										}),
										z.object({
											kind: z.literal("editable_source_digest"),
											value: z.string().regex(/^[a-f0-9]{64}$/),
										}),
									])
									.nullable(),
							}),
						),
					})
					.passthrough(),
			),
			annotations: { readOnlyHint: true },
		},
		async () => {
			const guard = requirePlatformAdminForOrg(
				ctx,
				ctx.orgSlug,
				"list versions for",
			);
			if (guard) return guard;
			const versions = await ctx.listVersions(ctx.orgSlug);
			const output = { versions };
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(output, null, 2) },
				],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"theme_rollback",
		{
			title: "Rollback Theme",
			description:
				"Restore a previous theme version to the live CMS. " +
				"Use theme_list_versions to see available versions.",
			inputSchema: schema(
				z.object({
					version: z
						.number()
						.int()
						.positive()
						.describe("Version number to restore"),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: any) => {
			const guard = requirePlatformAdminForOrg(ctx, ctx.orgSlug, "rollback");
			if (guard) return guard;
			const { url } = await ctx.rollback(ctx.orgSlug, args.version);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{ status: "rolled_back", version: args.version, url },
							null,
							2,
						),
					},
				],
			};
		},
	);
}

function registerPropagateTools(
	server: McpServer,
	ctx: SiteBuilderToolContext,
): void {
	server.registerTool(
		"template_propagate",
		{
			title: "Propagate Template Files to All Orgs",
			description:
				"Write one or more template files from the bundled snapshot to every active org sandbox " +
				"(or a specified subset), then optionally trigger a deploy for each. " +
				"Use this after pushing template changes to git and redeploying the Site Builder Worker " +
				"(which refreshes the snapshot). " +
				"Only files present in the template snapshot can be propagated. " +
				"Pass deploy:true to queue an Astro build for each org after writing.",
			inputSchema: schema(
				z.object({
					files: z
						.array(z.string())
						.describe(
							"File paths to propagate (relative to theme root, e.g. 'src/styles/globals.css'). " +
								"Must exist in the template snapshot.",
						),
					deploy: z
						.boolean()
						.optional()
						.describe(
							"Queue a deploy for each org after writing files (default: false)",
						),
					orgs: z
						.array(z.string())
						.optional()
						.describe(
							"Org slugs to target. Omit to target all active orgs in tenant_bundles.",
						),
				}),
			),
			annotations: { destructiveHint: true },
		},
		async (args: { files: string[]; deploy?: boolean; orgs?: string[] }) => {
			// Validate against the union up front; each target is still resynced
			// from its own template snapshot below.
			const snapshotPaths = new Set(
				Object.values(TEMPLATE_SNAPSHOTS).flatMap((snapshot) =>
					Object.keys(snapshot),
				),
			);
			const validFiles = args.files.filter((file) => snapshotPaths.has(file));
			const unknownFiles = args.files.filter(
				(file) => !snapshotPaths.has(file),
			);

			if (validFiles.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									error:
										"No valid files to propagate. All specified paths are absent from the template snapshot.",
									unknownFiles,
								},
								null,
								2,
							),
						},
					],
					isError: true,
				};
			}

			// Resolve target orgs
			const fleetRows = await listCmsFleetBundles(ctx.db);
			const fleetBySlug = new Map(fleetRows.map((row) => [row.slug, row]));
			let targetSlugs: string[];
			if (args.orgs && args.orgs.length > 0) {
				targetSlugs = [...new Set(args.orgs)];
			} else {
				if (!ctx.isPlatformAdmin) {
					return forbidden(
						"Platform admin authority required to propagate the template to all orgs",
					);
				}
				targetSlugs = fleetRows.map((row) => row.slug);
			}

			const crossOrgSlug = targetSlugs.find((slug) => slug !== ctx.orgSlug);
			if (crossOrgSlug) {
				const guard = requirePlatformAdminForOrg(
					ctx,
					crossOrgSlug,
					"propagate template files to",
				);
				if (guard) return guard;
			}

			if (targetSlugs.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{ error: "No active orgs found in tenant_bundles." },
								null,
								2,
							),
						},
					],
					isError: true,
				};
			}

			// Process orgs in batches of 5 to avoid overwhelming sandbox DOs
			const BATCH = 5;
			const results: Array<{
				slug: string;
				status: "ok" | "error";
				templateSlug?: CmsTemplateSlug;
				filesWritten?: number;
				copied?: string[];
				skipped?: string[];
				jobId?: string;
				error?: string;
			}> = [];

			for (let i = 0; i < targetSlugs.length; i += BATCH) {
				const batch = targetSlugs.slice(i, i + BATCH);
				const batchResults = await Promise.all(
					batch.map(async (slug) => {
						try {
							const fleetRow = fleetBySlug.get(slug);
							if (!fleetRow) {
								throw new Error(`No active CMS bundle found for org "${slug}"`);
							}
							const templateSlug = normalizeCmsTemplateSlug(
								fleetRow.templateSlug,
							);
							const sandbox = ctx.getSandboxForOrg(slug);
							const sync = await resyncTemplate(sandbox, {
								scope: "files",
								paths: validFiles,
								templateSlug,
							});
							let jobId: string | undefined;
							if (args.deploy && sync.copied.length > 0) {
								const d = await ctx.startDeploy(
									slug,
									`Template propagation (${templateSlug}): ${sync.copied.join(", ")}`,
								);
								jobId = d.jobId;
							}
							return {
								slug,
								status: "ok" as const,
								templateSlug,
								filesWritten: sync.copied.length,
								copied: sync.copied,
								skipped: sync.skipped,
								jobId,
							};
						} catch (err) {
							return { slug, status: "error" as const, error: String(err) };
						}
					}),
				);
				results.push(...batchResults);
			}

			const ok = results.filter((r) => r.status === "ok");
			const failed = results.filter((r) => r.status === "error");

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								summary: `Processed ${validFiles.length} requested file(s) for ${ok.length}/${targetSlugs.length} orgs${args.deploy ? "; deploys queued only where files were copied" : ""}`,
								filesWritten: validFiles,
								unknownFiles:
									unknownFiles.length > 0 ? unknownFiles : undefined,
								orgsOk: ok.length,
								orgsFailed: failed.length,
								results,
							},
							null,
							2,
						),
					},
				],
				isError: failed.length > 0 && ok.length === 0 ? true : undefined,
			};
		},
	);
}

export function buildInstructions(templateSlug: CmsTemplateSlug): string {
	return `You are connected to the CMS theme builder for an Emdash tenant using the installed Astro and Tailwind CSS versions.

## What You Can Do

Use the theme_* tools inside this cms_* namespace to customize the tenant frontend:
- Read and modify Astro pages, layouts, components, and CSS
- Preview changes with a live dev server
- Build and deploy themes to the live CMS
- Rollback to previous versions

## File Boundaries

LOCKED (cannot modify — CMS infrastructure):
${lockedFilesForTemplate(templateSlug)
	.map((f) => `  - ${f}`)
	.join("\n")}
${lockedDirsForTemplate(templateSlug)
	.map((dir) => `  - ${dir}**`)
	.join("\n")}

EDITABLE (theme customization):
${EDITABLE_FILES.map((f) => `  - ${f}`).join("\n")}

You may also create NEW files in: ${EDITABLE_DIRS.join(", ")}

## Emdash Content API (available in theme files)

\`\`\`typescript
// Content queries (import from "emdash")
getEmDashCollection(name, { orderBy, limit, offset }) → { entries, cacheHint }
getEntriesByByline(collection, byline, options) → entries credited to a byline in any position
getEmDashEntry(name, slug) → { entry, cacheHint }
getSiteSettings() → { title, tagline, url, ... }
getSiteSettingsWithCacheHint() → { data, cacheHint }
getEntryTerms(collection, id, taxonomy) → terms[]
getSeoMeta(entry, opts) → { title, description, ogTitle, ogDescription, ogImage, canonical, robots } // reads entry.data.seo
decodeSlug(slug) → decoded string
search(query, opts) → { items, nextCursor? }

// UI components (import from "emdash/ui")
<Image image={...} class="..." />
<PortableText value={content} />
<EmDashHead page={pageCtx} />
<EmDashBodyStart page={pageCtx} />
<EmDashBodyEnd page={pageCtx} />

// Page context (import from "emdash/page")
createPublicPageContext({ Astro, kind, pageType, title, ... })
\`\`\`

## Important Rules

1. Always keep EmDashHead/EmDashBodyStart/EmDashBodyEnd in the layout — they power the CMS toolbar and SEO
2. Pass returned cacheHint values to Astro.cache.set(cacheHint) for route invalidation; use getSiteSettingsWithCacheHint() when settings should invalidate the page
3. Use the installed Tailwind CSS utilities and tenant font variable \`var(--font-sans)\`
4. Content is Portable Text (structured JSON), not markdown — render with <PortableText value={...} />
5. Author metadata belongs in native Emdash byline customFields; read from entry.data.bylines[i].byline.customFields rather than hardcoded tenant data
6. Org context available via Astro.locals.org (slug, siteTitle)
`;
}
