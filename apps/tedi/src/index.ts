/**
 * Tedix Tedi Worker — Multi-tenant Tedi edge/control Worker
 *
 * Routes wildcard subdomain requests to the Agent runtime and leases Sandbox
 * workstations for OS/process capability.
 *
 * Architecture:
 * - Public routes (health, status): no auth
 * - Admin routes (/api/admin/*): service binding auth (from apps/api)
 * - Workstation requests: service-bound Sandbox workstation adapter
 */

import {
	createWorkstationEpisodeIds,
	createWorkstationLease,
} from "@tedix/api-contract/schemas/workstation";
import { createDbClient } from "@tedix/db/client";
import { updateTediLastHeartbeat } from "@tedix/db/queries/tedis";
import { installHonoErrorHandlers } from "@tedix/worker-kit/errors";
import {
	applyInboundTrustHeaderHygiene,
	applyOperatorConsentHeaderHygiene,
	isServiceBinding,
	stripServiceBindingMarker,
} from "@tedix/worker-kit/request-auth";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Context } from "hono";
import { Hono } from "hono";
import { getPlatformDomain } from "./platform";
import { contentFreeTediException, createTediLogger } from "./log";
import { resolveTedi } from "./resolve";
import { admin } from "./routes/admin/index";
import { isWorkstationRequest } from "./routes/admin/workstation/shared";
import { canAccessInactiveWorkstation } from "./workstation/inactive-lease-access";
import { health } from "./routes/health";
import { workstationReaper } from "./routes/workstation-reaper";
import { githubCredentialAuthority } from "./routes/github-credential-authority";
import {
	attachBodyGenerationHeaders,
	CloudflareAgentBodyLauncher,
	CloudflareSandboxWorkstationLauncher,
} from "./runtime/body-launcher";
import { createSelectedWorkstationOutboundHandlerParams } from "./runtime/workstation-egress";
import type { AppEnv, TediEnv } from "./types";
import { workstationSandboxId } from "./workstation/egress-guard";
import { WORKSTATION_HOME } from "./workstation/paths";
import { getWorkstationLeaseBundle } from "./workstation/persistence";

const USER_HEARTBEAT_DEBOUNCE_MS = 5 * 60 * 1000;
const userHeartbeatAt = new Map<string, number>();

const app = new Hono<AppEnv>();
const log = createTediLogger("tedi.edge");

installHonoErrorHandlers(app, { service: "tedi" });

type WorkstationRuntimeSelection = {
	attemptId?: string | null;
	released?: boolean;
	workItemId?: string | null;
	leaseId: string;
	participantTediId: string;
	workstationId: string;
};

const ACTIVE_WORKSTATION_PARTICIPANT_STATUSES = new Set([
	"active",
	"invited",
	"paused",
]);

function defaultWorkstationRuntimeSelection(
	tediConfig: {
		id: string;
		organizationId: string | null;
		slug: string;
	},
	executionKey?: string | null,
): WorkstationRuntimeSelection {
	const ids = createWorkstationEpisodeIds({
		executionKey,
		organizationId: tediConfig.organizationId,
		profileId: "general",
		slug: tediConfig.slug,
		tediId: tediConfig.id,
	});
	const lease = createWorkstationLease({
		leaseId: ids.leaseId,
		organizationId: tediConfig.organizationId,
		profileId: "general",
		seats: [
			{
				permissionScopes: [],
				role: "lead",
				slug: tediConfig.slug,
				tediId: tediConfig.id,
			},
		],
		workstationId: ids.workstationId,
	});
	return {
		leaseId: lease.id,
		participantTediId: tediConfig.id,
		workstationId: lease.workstationId,
	};
}

async function explicitWorkstationRuntimeSelection(
	c: Context<AppEnv>,
	tediConfig: {
		id: string;
		organizationId: string | null;
		slug: string;
	},
): Promise<
	| { ok: true; selection: WorkstationRuntimeSelection }
	| { ok: false; error: string; status: 400 | 403 | 404 | 503 }
> {
	let body: Record<string, unknown> | null = null;
	try {
		const parsed = await c.req.raw.clone().json();
		body =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
	} catch {
		body = null;
	}
	const leaseId =
		typeof body?.leaseId === "string" && body.leaseId.trim()
			? body.leaseId.trim()
			: "";
	if (!leaseId) {
		const executionKey = [
			body?.executionId,
			body?.workItemId,
			body?.kernelRunId,
		].find(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		return {
			ok: true,
			selection: defaultWorkstationRuntimeSelection(tediConfig, executionKey),
		};
	}
	if (!c.env.DB) {
		return {
			ok: false,
			error: "workstation lease selection requires DB persistence",
			status: 503,
		};
	}
	const bundle = await getWorkstationLeaseBundle(
		createDbClient(c.env.DB),
		leaseId,
	);
	if (!bundle) {
		return {
			ok: false,
			error: `workstation lease not found: ${leaseId}`,
			status: 404,
		};
	}
	const lease = bundle.workstationLease;
	if (lease.organizationId !== tediConfig.organizationId) {
		return {
			ok: false,
			error: `workstation lease ${leaseId} is not in this organization`,
			status: 403,
		};
	}
	if (lease.profileId !== "general") {
		return {
			ok: false,
			error: `workstation lease ${leaseId} is not a workstation`,
			status: 400,
		};
	}
	const requestedWorkstationId =
		typeof body?.workstationId === "string" && body.workstationId.trim()
			? body.workstationId.trim()
			: "";
	if (
		requestedWorkstationId &&
		requestedWorkstationId !== bundle.workstation.id
	) {
		return {
			ok: false,
			error: `workstationId ${requestedWorkstationId} does not match lease ${leaseId}`,
			status: 403,
		};
	}
	const participant =
		lease.participants.find(
			(candidate) => candidate.tediId === tediConfig.id,
		) ?? null;
	if (!participant) {
		return {
			ok: false,
			error: `workstation lease ${leaseId} has no participant for tedi ${tediConfig.id}`,
			status: 403,
		};
	}
	const requestPath = new URL(c.req.url).pathname;
	const isCleanupOrReceiptReplay = canAccessInactiveWorkstation({
		path: requestPath,
		leaseStatus: lease.status,
		participantRole: participant.role,
		participantStatus: participant.status,
		preserveChanges: body?.preserveChanges === true,
	});
	if (
		!ACTIVE_WORKSTATION_PARTICIPANT_STATUSES.has(participant.status) &&
		!isCleanupOrReceiptReplay
	) {
		return {
			ok: false,
			error: `workstation participant ${participant.id} is not active`,
			status: 403,
		};
	}
	return {
		ok: true,
		selection: {
			attemptId: lease.attemptId,
			leaseId: lease.id,
			workItemId: lease.workItemId,
			released: lease.status === "released",
			participantTediId: participant.tediId,
			workstationId: bundle.workstation.id,
		},
	};
}

// =============================================================================
// PUBLIC ROUTES (no tedi resolution needed)
// =============================================================================

app.route("/", health);
// Fleet-scoped, service-binding-guarded: a reap has no tedi subdomain to
// resolve, and resolving one would scope it to a single tenant.
app.route("/", workstationReaper);
app.route("/", githubCredentialAuthority);

// =============================================================================
// MIDDLEWARE: Resolve tedi from subdomain + initialize sandbox
// =============================================================================

app.use("*", async (c, next) => {
	// Trust X-Tedix-Host only for service binding requests.
	// External requests must use the Host header — accepting X-Tedix-Host from the
	// internet would let any caller route their request to an arbitrary tedi.
	const isServiceBindingRequest = isServiceBinding(c.req.raw.headers);
	let host =
		(
			(isServiceBindingRequest ? c.req.header("X-Tedix-Host") : null) ||
			c.req.header("host") ||
			""
		).split(":")[0] ?? "";

	// Local dev fallback: cloudflared can't preserve nested wildcard subdomains
	// (e.g., "tedi-0f0f0f0f.tedi.tedix.tech" arrives as just "tedi.tedix.tech").
	// When DEFAULT_TEDI_SLUG is set, synthesize the full hostname.
	if (c.env.DEFAULT_TEDI_SLUG) {
		const baseDomain = `tedi.${getPlatformDomain(c.env.ENVIRONMENT)}`;
		if (host === baseDomain || host === "localhost") {
			host = `${c.env.DEFAULT_TEDI_SLUG}.${baseDomain}`;
			console.log(`[Tedi] Local dev fallback: DEFAULT_TEDI_SLUG → ${host}`);
		}
	}

	// Resolve tedi from hostname (supports subdomains + custom domains)
	const tediConfig = await resolveTedi(
		c.env.DB,
		host,
		c.env.ENVIRONMENT,
		c.env.SECRETS_MASTER_KEY,
		{ projectId: c.env.DESCOPE_PROJECT_ID, baseUrl: c.env.DESCOPE_BASE_URL },
		c.env.API_URL,
		{
			OPENAI_API_KEY: c.env.OPENAI_API_KEY,
			AZURE_OPENAI_RESOURCE: c.env.AZURE_OPENAI_RESOURCE,
			AZURE_OPENAI_BASE_URL: c.env.AZURE_OPENAI_BASE_URL,
			GEMINI_API_KEY: c.env.GEMINI_API_KEY,
			GOOGLE_API_KEY: c.env.GOOGLE_API_KEY,
			AZURE_OPENAI_TTS_DEPLOYMENT: c.env.AZURE_OPENAI_TTS_DEPLOYMENT,
			AZURE_OPENAI_TTS_VOICE: c.env.AZURE_OPENAI_TTS_VOICE,
			AZURE_OPENAI_STT_DEPLOYMENT: c.env.AZURE_OPENAI_STT_DEPLOYMENT,
			AZURE_OPENAI_STT_API_VERSION: c.env.AZURE_OPENAI_STT_API_VERSION,
			AZURE_OPENAI_REALTIME_DEPLOYMENT: c.env.AZURE_OPENAI_REALTIME_DEPLOYMENT,
			AZURE_OPENAI_REALTIME_API_VERSION:
				c.env.AZURE_OPENAI_REALTIME_API_VERSION,
			GRADIUM_API_KEY: c.env.GRADIUM_API_KEY,
			KUGEL_API_KEY: c.env.KUGEL_API_KEY,
			TWILIO_ACCOUNT_SID: c.env.TWILIO_ACCOUNT_SID,
			TWILIO_AUTH_TOKEN: c.env.TWILIO_AUTH_TOKEN,
		},
	);
	if (!tediConfig) {
		return c.json(
			{
				error: "Not found",
			},
			404,
		);
	}
	const requestPath = new URL(c.req.url).pathname;
	const isWorkstationProvisionRequest = requestPath.endsWith(
		"/workstation/provision",
	);
	const isWorkstationObservationRequest = requestPath.endsWith(
		"/workstation/status",
	);
	const isWorkstationRequestInternal =
		isServiceBindingRequest &&
		isWorkstationRequest(c.req.method, requestPath, c.req.raw.headers);

	// =========================================================================
	// AGENT RUNTIME BRANCH (default)
	// =========================================================================
	// Every tedi is served by the apps/tedi-runtime Worker (the Agent runtime),
	// except internal workstation
	// requests which go through the workstation Sandbox path below.
	//
	// Forward via service binding to preserve full request semantics
	// (URL path, headers including Upgrade, and body for WS + streaming).
	// Must run before resolving the workstation Durable Object so workstation setup only happens for
	// the workstation path.
	if (!isWorkstationRequestInternal) {
		if (!c.env.TEDI_RUNTIME_SERVICE) {
			return new Response("agent runtime not bound", { status: 503 });
		}
		if (c.env.ENVIRONMENT === "development") {
			console.log(
				`[tedi.isolate-forward] tedi=${tediConfig.slug} path=${requestPath} method=${c.req.method}`,
			);
		}
		const isolateLauncher = new CloudflareAgentBodyLauncher({
			db: c.env.DB,
			externalId: tediConfig.isolateAgentId ?? tediConfig.slug,
			fetcher: c.env.TEDI_RUNTIME_SERVICE,
			record: { kind: "tedi", id: tediConfig.id, tediId: tediConfig.id },
		});
		const generation = await isolateLauncher.arm({ requireToken: true });
		const forwardUrl = new URL(c.req.url);
		// Service-binding requests arrive at apps/tedi with a neutral internal
		// host plus X-Tedix-Host. apps/tedi resolves that safely above, but the
		// isolate Worker only sees the forwarded URL host. Stamp the resolved slug
		// onto the internal request so isolate routing stays explicit.
		//
		// SECURITY: this stamp is UNCONDITIONAL. apps/tedi has already resolved
		// tediConfig.slug from the trusted Host (external requests cannot spoof
		// X-Tedix-Host — see the resolution guard above), so any client-supplied
		// `?slug=` on the inbound URL must be overwritten, never honored. Honoring
		// it would let a client override hostname-based tenant routing and reach
		// another tenant's isolate (confused-deputy cross-tenant routing).
		forwardUrl.searchParams.set("slug", tediConfig.slug);
		const forwardHeaders = new Headers(c.req.raw.headers);
		// EXTERNAL ingress hygiene: a public request to a tedi subdomain must
		// not carry any client-supplied internal-trust marker (service-binding
		// flag, caller identity/authority, tenancy, admin token, routing) into
		// the trusted apps/tedi-runtime binding, which reads them as authority.
		// No-op on genuine service-binding hops, where trusted upstreams
		// legitimately stamp these; those markers survive to the runtime.
		applyInboundTrustHeaderHygiene(forwardHeaders, isServiceBindingRequest);
		applyOperatorConsentHeaderHygiene(forwardHeaders, isServiceBindingRequest);
		attachBodyGenerationHeaders(forwardHeaders, generation);
		const forwardRequest = new Request(forwardUrl.toString(), {
			body:
				c.req.method === "GET" || c.req.method === "HEAD"
					? undefined
					: c.req.raw.body,
			headers: forwardHeaders,
			method: c.req.method,
		});
		const isolateService = await isolateLauncher.ensureBody();
		return isolateService.fetch(forwardRequest);
	}

	const workstationRuntimeSelection = await explicitWorkstationRuntimeSelection(
		c,
		tediConfig,
	);
	if (!workstationRuntimeSelection.ok) {
		return c.json(
			{ ok: false, error: workstationRuntimeSelection.error },
			workstationRuntimeSelection.status,
		);
	}
	const selectedWorkstation = workstationRuntimeSelection.selection;
	c.set("workstationRuntimeSelection", selectedWorkstation);
	c.set("tediConfig", tediConfig);
	c.set("tediId", tediConfig.id);
	const r2Prefix = tediConfig.organizationId
		? `orgs/${tediConfig.organizationId}/tedis/${tediConfig.id}`
		: `tedis/${tediConfig.id}`;
	c.set("r2Prefix", r2Prefix);

	// Status is a passive D1 observation. Do not construct or configure the
	// workstation runtime here: on a cold Worker isolate the Durable Object configures the
	// workstation Durable Object, whose initialization runs inside
	// blockConcurrencyWhile(). A status poll during a long bootstrap install can
	// therefore reset the very body it is meant only to observe. /wake and the
	// execution routes remain the explicit activation paths.
	if (
		isWorkstationObservationRequest ||
		(selectedWorkstation.released &&
			requestPath.endsWith("/workstation/process/status"))
	) {
		c.set("runtimeBodyLauncher", null);
		c.set("workstationBodyInstance", null);
		await next();
		return;
	}

	// The v1 Durable Object owns native Container lifecycle and inactivity.
	// Resolving the named stub is passive; the first operation starts its image.
	const sandboxNamespace = c.env.TEDI_WORKSTATION_RUNTIME_SANDBOX;
	const physicalSandboxId = workstationSandboxId(
		selectedWorkstation.workstationId,
	);
	const runtimeBodyLauncher = new CloudflareSandboxWorkstationLauncher({
		bodyKind: "workstation",
		db: c.env.DB,
		externalId: selectedWorkstation.workstationId,
		namespace: sandboxNamespace,
		proofEnvPath: `${WORKSTATION_HOME}/.tedix-body-generation.env`,
		record: {
			kind: "workstationLease",
			id: selectedWorkstation.leaseId,
			tediId: selectedWorkstation.participantTediId,
		},
		sandboxId: physicalSandboxId,
	});
	// The lease-to-container join. `physicalSandboxId` is the Sandbox Durable
	// Object NAME the containers dashboard prints — it looks truncated because
	// `workstationSandboxId()` truncated it to the SDK's 63-char DNS limit, not
	// because Cloudflare did. `idFromName` on the same namespace the SDK uses
	// (namespace.idFromName) yields the 64-hex id of
	// the object that owns the container, identical to `ctx.id.toString()` in
	// the workstation runtime. Both are derived here and recorded on the lease
	// once the envelope is persisted.
	c.set("workstationBodyInstance", {
		id: sandboxNamespace.idFromName(physicalSandboxId).toString(),
		name: physicalSandboxId,
	});
	const sandbox = await runtimeBodyLauncher.ensureBody();

	// Default-deny egress for workstation sandboxes. The runtime body sets
	// enableInternet=false + interceptHttps=true and routes outbound through an
	// SSRF-guarded `outbound` handler; here we pass per-workstation policy under
	// Tedix-private params so the SDK cannot pre-gate before durable events are
	// recorded. Absent config means deny-all sentinel (see
	// runtime/workstation-egress.ts).
	if (
		isWorkstationRequestInternal &&
		!isWorkstationProvisionRequest &&
		!isWorkstationObservationRequest
	) {
		try {
			await sandbox.setOutboundPolicy(
				createSelectedWorkstationOutboundHandlerParams(
					tediConfig,
					selectedWorkstation,
				),
			);
		} catch (err) {
			log.error("Workstation egress policy setup failed", {
				event: "edge.workstation_egress_setup_failed",
				tediId: tediConfig.id,
				outcome: "unavailable",
				error: contentFreeTediException(err),
			});
		}
	}

	// Set context
	c.set("runtimeBodyLauncher", runtimeBodyLauncher);
	c.set("sandbox", sandbox);
	// Debounced user-activity heartbeat: write last_heartbeat_at for external
	// (non-service-binding) requests so the cron sleep filter knows a user is active.
	// Cron no longer writes this field — only user traffic does.
	if (!isServiceBindingRequest) {
		const lastWrite = userHeartbeatAt.get(tediConfig.id) ?? 0;
		if (Date.now() - lastWrite > USER_HEARTBEAT_DEBOUNCE_MS) {
			userHeartbeatAt.set(tediConfig.id, Date.now());
			updateTediLastHeartbeat(createDbClient(c.env.DB), tediConfig.id).catch(
				() => {},
			);
		}
	}

	await next();
});

// =============================================================================
// TEDI-SCOPED ROUTES
// =============================================================================

// Workstation API. All non-workstation per-tedi traffic returns from the
// middleware above after forwarding to apps/tedi-runtime.
app.route("/api/admin", admin);

/**
 * Service-binding ingress. Internal callers bind with
 * `"entrypoint": "InternalEntrypoint"`; the internet reaches only the default
 * export, which strips the `X-Service-Binding` marker, so binding trust is
 * unreachable from a public request.
 */
export class InternalEntrypoint extends WorkerEntrypoint<TediEnv> {
	override async fetch(request: Request): Promise<Response> {
		return app.fetch(request, this.env, this.ctx);
	}
}

export default {
	fetch: (request: Request, env: TediEnv, ctx: ExecutionContext) =>
		app.fetch(stripServiceBindingMarker(request), env, ctx),
};
