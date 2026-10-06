/**
 * Tedi Runtime Provisioning Client
 *
 * Utility functions to interact with a tedi's runtime Worker instance.
 * Each tedi runtime is addressed by its derived runtime URL. The API-facing
 * root export is limited to current Agent-runtime and generic tedi Worker
 * admin routes.
 *
 * Admin routes are protected by service binding detection (no public HTTP access).
 */

// =============================================================================
// TYPES
// =============================================================================

export interface ProvisioningConfig {
	/** Base URL of the tedi runtime Worker (e.g. https://my-tedi-owner.tedi.tedix.dev) */
	workerUrl: string;
	/** Optional host override for local dev tunnels (sent as X-Tedix-Host) */
	hostOverride?: string;
	/** Optional service binding fetcher — bypasses public routing for Worker-to-Worker calls */
	fetcher?: { fetch: typeof fetch };
	/** When true, adds X-Service-Binding header even without a real fetcher (local dev) */
	isDev?: boolean;
}

export interface BackupHandleSummary {
	runtimeId?: string | null;
	runtimeDir?: string | null;
	runtimePresent?: boolean;
	workspaceId?: string | null;
	workspaceDir?: string | null;
	workspacePresent?: boolean;
	createdAt?: string | null;
	restorable?: boolean;
	format?: "missing" | "unified" | "legacy-split" | "unknown";
}

export interface SyncResult {
	success: boolean;
	lastSync?: string | null;
	backupHandles?: BackupHandleSummary;
	error?: string;
	details?: string;
}

export interface CronSyncResult {
	success: boolean;
	cronBootstrap: {
		ok: boolean;
		forceUpdate: boolean;
		templateCount: number;
		existingCount: number;
		plannedCount: number;
		appliedCount: number;
		actions: Array<{
			op: "add" | "update" | "remove";
			name: string;
		}>;
		errors: string[];
	};
}

export interface StorageStatus {
	configured: boolean;
	missing?: string[];
	lastSync: string | null;
	backupHandles?: BackupHandleSummary;
	mountError?: string;
	message: string;
	bucketName?: string | null;
	prefix?: string;
}

export interface StorageFileEntry {
	path: string;
	type: "file" | "dir";
}

export interface StorageFilesResult {
	path: string;
	entries: StorageFileEntry[];
}

export interface StorageFileResult {
	path: string;
	content: string;
	sizeBytes: number | null;
	truncated: boolean;
}

export interface AgentDiagnosticsResult {
	ok: boolean;
	slug?: string | null;
	tediId?: string | null;
	queue?: unknown;
	schedules?: unknown;
	state?: Record<string, unknown>;
	artifacts?: Record<string, unknown> | null;
	compaction?: unknown;
	[key: string]: unknown;
}

export interface RuntimeDevice {
	id: string;
	tediId?: string | null;
	deviceId?: string | null;
	displayName?: string | null;
	platform?: string | null;
	channel?: string | null;
	status: "pending" | "paired" | "revoked";
	pairedAt?: string | null;
	createdAt?: string | null;
}

export interface RuntimeDevicesResult {
	pending: RuntimeDevice[];
	paired: RuntimeDevice[];
	raw?: unknown;
}

export interface RuntimeChannelStatus {
	channel: string;
	enabled?: boolean;
	connected?: boolean;
	status?: string;
	lastError?: string | null;
	observedAt?: string;
}

export interface RuntimeChannelsResult {
	channels: RuntimeChannelStatus[];
	observedAt?: string;
}

export class ProvisioningHttpError extends Error {
	status: number;
	body: string;
	/** The caller's deadline expired before delivery could be confirmed. */
	timedOut: boolean;
	constructor(message: string, status: number, body = "", timedOut = false) {
		super(message);
		this.name = "ProvisioningHttpError";
		this.status = status;
		this.body = body;
		this.timedOut = timedOut;
	}
}

// =============================================================================
// CLIENT
// =============================================================================

/**
 * Create headers for tedi Worker requests.
 */
function buildAuthHeaders(config: ProvisioningConfig): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	if (config.hostOverride) {
		headers["X-Tedix-Host"] = config.hostOverride;
	}

	return headers;
}

/**
 * Make a request to the tedi runtime Worker.
 */
async function runtimeFetch<T = unknown>(
	config: ProvisioningConfig,
	path: string,
	options: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
	const url = `${config.workerUrl.replace(/\/+$/, "")}${path}`;
	const headers = {
		...buildAuthHeaders(config),
		...((options.headers as Record<string, string>) || {}),
	};
	const timeoutMs = options.timeoutMs ?? 12_000;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	// Use service binding if available, otherwise global fetch
	// Mark service binding requests so the tedi admin auth middleware accepts them
	if (config.fetcher || config.isDev) {
		headers["X-Service-Binding"] = "true";
	}
	const fetchFn = config.fetcher?.fetch.bind(config.fetcher) ?? fetch;
	let response: Response;
	try {
		response = await fetchFn(url, {
			...options,
			headers,
			signal: options.signal ?? controller.signal,
		});
	} catch (error) {
		if ((error as { name?: string })?.name === "AbortError") {
			const requestMeta = `${options.method || "GET"} ${url}`;
			const hostMeta = config.hostOverride
				? ` (X-Tedix-Host: ${config.hostOverride})`
				: "";
			throw new ProvisioningHttpError(
				`Tedi runtime request timed out after ${timeoutMs}ms [${requestMeta}${hostMeta}]`,
				504,
				"",
				true,
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) {
		const body = await response.text();
		let parsed: { error?: string; message?: string } | null = null;
		try {
			parsed = JSON.parse(body);
		} catch {
			// not JSON
		}
		const message =
			parsed?.error ||
			parsed?.message ||
			`Tedi runtime responded ${response.status}`;
		const requestMeta = `${options.method || "GET"} ${url}`;
		const hostMeta = config.hostOverride
			? ` (X-Tedix-Host: ${config.hostOverride})`
			: "";
		throw new ProvisioningHttpError(
			`${message} [${requestMeta}${hostMeta}]`,
			response.status,
			body,
		);
	}

	return response.json() as Promise<T>;
}

// =============================================================================
// PUBLIC API
// =============================================================================

export interface WakeTediResult {
	success: boolean;
	ready: boolean;
	woke: boolean;
	restoredFromBackup: boolean;
	status: string;
	processId: string | null;
	waitMs: number;
	attempts?: number;
	recoveredBySandboxReset?: boolean;
	message?: string;
}

export interface WakeTediOptions {
	allowSandboxReset?: boolean;
	forceSandboxReset?: boolean;
	reason?: string;
}

/**
 * Wake a tedi runtime and wait for readiness within a bounded time budget.
 * Returns structured state instead of failing when the warm-up window is exceeded.
 */
export async function wakeTedi(
	config: ProvisioningConfig,
	options: WakeTediOptions = {},
): Promise<WakeTediResult> {
	const body = Object.values(options).some((value) => value !== undefined)
		? JSON.stringify(options)
		: undefined;
	return runtimeFetch<WakeTediResult>(config, "/api/admin/status/wake", {
		method: "POST",
		timeoutMs: 210_000, // Must exceed STARTUP_TIMEOUT_MS (180s) + onboard (120s)
		body,
	});
}

/**
 * Get read-only diagnostics from an Agent-runtime tedi body.
 * The route is served by apps/tedi-runtime through apps/tedi's service binding
 * forwarder and intentionally has no removed container-runtime dependency.
 */
export async function getAgentDiagnostics(
	config: ProvisioningConfig,
): Promise<AgentDiagnosticsResult> {
	return runtimeFetch<AgentDiagnosticsResult>(config, "/__admin/agent-diag", {
		timeoutMs: 8_000,
	});
}

export interface SandboxResetResult {
	success: boolean;
	message: string;
	audit?: {
		tediId: string;
		triggeredBy: string;
		triggeredAt: string;
		reason: string | null;
	};
}

/**
 * Reset the runtime sandbox Durable Object when a runtime lease needs a clean
 * start. Agent-runtime tedis normally use wake/status instead.
 */
export async function resetSandbox(
	config: ProvisioningConfig,
	reason?: string,
	force?: boolean,
): Promise<SandboxResetResult> {
	return runtimeFetch<SandboxResetResult>(config, "/api/admin/sandbox/reset", {
		method: "POST",
		timeoutMs: 30_000,
		body: JSON.stringify({ reason: reason ?? null, force: force ?? false }),
	});
}

/**
 * Inject a message into an Agent-runtime tedi via its service-binding
 * `/hooks/inject` route. Apps/tedi forwards requests to apps/tedi-runtime; the
 * inject route drives one turn through the runtime's
 * `TediSessionHarness` + ledger path (`runChatTurn`), the same path Tedix OS/MCP use —
 * not a parallel mini-loop. Returns the assistant reply alongside `success`.
 */
export async function injectAgentMessage(
	config: ProvisioningConfig,
	options: {
		message: string;
		session?: string;
		attachments?: Array<{
			content: string;
			fileName: string;
			mimeType: string;
			type: "audio" | "file" | "image";
		}>;
		/**
		 * Stable client id for this inject → the isolate turn's runId turnKey.
		 * Pass a caller-minted idempotency key so a retried inject dedups to the
		 * same runId. Defaults to a fresh uuid (random, NOT a wall-clock) when the
		 * caller has no stable id — each operator inject is then its own run.
		 */
		clientRequestId?: string;
		/** Caller metadata to bind into the runtime turn context. */
		metadata?: Record<string, unknown>;
		/**
		 * Async-supervised inject (kernel delegation). When true the isolate
		 * DO accepts the message, queues the canonical turn on its durable
		 * background queue, and returns `202 { accepted, run_id }` immediately —
		 * the child's first turn is NOT capped by this inject's HTTP timeout, so a
		 * cold DO cannot false-fail it. The full ledger
		 * chain lands under the returned `run_id` when the queued turn runs, and
		 * Home reconciles via terminal events. Omit/false for interactive operator
		 * + mesh inject that needs the assistant reply inline.
		 */
		async?: boolean;
	},
): Promise<{
	success: boolean;
	accepted?: boolean;
	error?: string;
	run_id?: string;
	session_key?: string;
	assistant?: { role: "assistant"; content: string; ts: number };
}> {
	return runtimeFetch<{
		success: boolean;
		accepted?: boolean;
		error?: string;
		run_id?: string;
		session_key?: string;
		assistant?: { role: "assistant"; content: string; ts: number };
	}>(config, "/hooks/inject", {
		method: "POST",
		body: JSON.stringify({
			text: options.message,
			session_key: options.session,
			client_request_id: options.clientRequestId ?? crypto.randomUUID(),
			...(options.metadata ? { metadata: options.metadata } : {}),
			...(options.attachments?.length
				? { attachments: options.attachments }
				: {}),
			...(options.async ? { async: true } : {}),
		}),
		// Async accept returns fast (just enqueues); the synchronous path must wait
		// for the whole turn, so it keeps the longer budget.
		timeoutMs: options.async ? 12_000 : 30_000,
	});
}

/**
 * Terminate a running CHAT_TURN_WORKFLOW instance on an isolate (agent-runtime)
 * tedi. The `clientRequestId` is the same id the kernel used when dispatching
 * the turn via `injectAgentMessage` — the DO derives the `workflowInstanceId`
 * from it using the same sanitize logic as the dispatch path, so they cannot
 * drift. Fail-soft: a missing or already-terminal workflow returns
 * `{ success: true, detail: "already_settled" }` — the child has already
 * settled and the parent cancel should proceed normally.
 *
 * Only valid for Agent-runtime tedis.
 */
export async function cancelRuntimeTurn(
	config: ProvisioningConfig,
	options: {
		/** clientRequestId used when the turn was dispatched (same as idempotencyKey). */
		clientRequestId: string;
		/** Canonical child run id; avoids re-derivation drift at the runtime fence. */
		runId?: string;
	},
): Promise<{ success: boolean; detail?: string; error?: string }> {
	return runtimeFetch<{ success: boolean; detail?: string; error?: string }>(
		config,
		"/hooks/cancel-turn",
		{
			method: "POST",
			body: JSON.stringify({
				client_request_id: options.clientRequestId,
				...(options.runId ? { run_id: options.runId } : {}),
			}),
			timeoutMs: 15_000,
		},
	);
}

/**
 * Pre-authorize a coding session for the Code Mode `execute` tool.
 *
 * POSTs to the DO's `/__internal/cm-session/authorize` endpoint via service
 * binding (sets `X-Service-Binding: true`). The DO stores the sessionKey in
 * its durable KV allowlist (`cm_session_allowlist`). Once authorized, the
 * tedi's `execute` tool will run code for requests carrying that sessionKey
 * (subject to `CODEMODE_EXECUTE_ENABLED=1` being set on the runtime Worker).
 *
 * Fail-soft: network/timeout errors return `{ ok: false, error }` rather than
 * throwing, so the oRPC handler can surface a clean message to the operator.
 */
export async function authorizeCodingSession(
	config: ProvisioningConfig,
	options: { sessionKey: string; authorizedBy?: string },
): Promise<{ ok: boolean; error?: string }> {
	try {
		return await runtimeFetch<{ ok: boolean; error?: string }>(
			config,
			"/__internal/cm-session/authorize",
			{
				method: "POST",
				body: JSON.stringify({
					sessionKey: options.sessionKey,
					authorized_by: options.authorizedBy ?? "operator",
				}),
				timeoutMs: 15_000,
			},
		);
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "unknown provisioning error";
		return { ok: false, error: message };
	}
}

export interface RepoCommitDrainResult {
	ok: boolean;
	drained: boolean;
	error?: string;
	evidenceEventError?: string;
	evidenceEventId?: string;
	evidenceEventStatus?: string;
}

/**
 * Ask an Agent-runtime tedi DO to drain a resolved repo_commit approval.
 *
 * The approval row lives in D1, but the full changeset intentionally lives only
 * in the tedi DO's local ledger. Approval resolution therefore triggers this
 * service-binding route instead of executing the write in apps/api.
 */
export async function drainRepoCommitApproval(
	config: ProvisioningConfig,
	options: {
		approvalRequestId: string;
		executionLedgerId: string;
		status?: "approved" | "cancelled" | "rejected";
	},
): Promise<RepoCommitDrainResult> {
	try {
		return await runtimeFetch<RepoCommitDrainResult>(
			config,
			"/__internal/repo-commit/drain",
			{
				method: "POST",
				body: JSON.stringify({
					approvalRequestId: options.approvalRequestId,
					executionLedgerId: options.executionLedgerId,
					status: options.status,
				}),
				timeoutMs: 45_000,
			},
		);
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "unknown provisioning error";
		return { ok: false, drained: false, error: message };
	}
}

export interface FanoutSlotRecord {
	id: string;
	childRunId: string;
	ownerTediId: string;
	ownerSlug: string | null;
	ownerLabel: string;
	objective: string;
	status: "queued" | "running" | "completed" | "failed" | "canceled";
	dispatchedAt: string | null;
}

export interface FanoutSlotsResult {
	ok: boolean;
	slots: FanoutSlotRecord[];
	error?: string;
}

/**
 * Read live fan-out work-item slots from a tedi-runtime DO for a given
 * parentRunId. Returns only slots still alive in DO storage (not yet settled).
 * Fail-soft: returns `{ ok: false, slots: [] }` on any error.
 */
export async function readFanoutSlots(
	config: ProvisioningConfig,
	options: { parentRunId: string; limit?: number },
): Promise<FanoutSlotsResult> {
	try {
		const limit = Math.min(options.limit ?? 20, 50);
		const params = new URLSearchParams({
			parent_run_id: options.parentRunId,
			limit: String(limit),
		});
		return await runtimeFetch<FanoutSlotsResult>(
			config,
			`/__internal/fanout-slots?${params.toString()}`,
			{ method: "GET", timeoutMs: 5_000 },
		);
	} catch {
		return { ok: false, slots: [], error: "read_failed" };
	}
}

/**
 * Revoke a previously authorized coding session.
 *
 * POSTs to `/__internal/cm-session/revoke` via service binding. The DO
 * removes the sessionKey from its durable KV allowlist so subsequent `execute`
 * calls with that sessionKey park instead of running.
 *
 * Fail-soft: same shape as `authorizeCodingSession`.
 */
export async function revokeCodingSession(
	config: ProvisioningConfig,
	options: { sessionKey: string },
): Promise<{ ok: boolean; error?: string }> {
	try {
		return await runtimeFetch<{ ok: boolean; error?: string }>(
			config,
			"/__internal/cm-session/revoke",
			{
				method: "POST",
				body: JSON.stringify({ sessionKey: options.sessionKey }),
				timeoutMs: 15_000,
			},
		);
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "unknown provisioning error";
		return { ok: false, error: message };
	}
}

/**
 * Trigger a runtime storage sync.
 */
export async function triggerSync(
	config: ProvisioningConfig,
): Promise<SyncResult> {
	return runtimeFetch<SyncResult>(config, "/api/admin/storage/sync", {
		method: "POST",
		timeoutMs: 120_000,
	});
}

/** Get runtime storage status. */
export async function getStorageStatus(
	config: ProvisioningConfig,
): Promise<StorageStatus> {
	return runtimeFetch<StorageStatus>(config, "/api/admin/storage", {
		timeoutMs: 10_000,
	});
}

/**
 * List files in the mounted R2 namespace.
 */
export async function listStorageFiles(
	config: ProvisioningConfig,
	opts?: { path?: string; recursive?: boolean },
): Promise<StorageFilesResult> {
	const qs = new URLSearchParams();
	if (opts?.path) qs.set("path", opts.path);
	if (opts?.recursive) qs.set("recursive", "1");
	const suffix = qs.size ? `?${qs.toString()}` : "";
	return runtimeFetch<StorageFilesResult>(
		config,
		`/api/admin/storage/files${suffix}`,
		{ timeoutMs: 20_000 },
	);
}

/**
 * Read a small text file from the mounted R2 namespace.
 * Currently restricted server-side to .md/.txt/.json/.yaml/.yml.
 */
export async function getStorageFile(
	config: ProvisioningConfig,
	path: string,
): Promise<StorageFileResult> {
	const qs = new URLSearchParams({ path });
	return runtimeFetch<StorageFileResult>(
		config,
		`/api/admin/storage/file?${qs.toString()}`,
		{ timeoutMs: 20_000 },
	);
}

/**
 * Write a text file to the mounted R2 namespace.
 */
export async function writeStorageFile(
	config: ProvisioningConfig,
	path: string,
	content: string,
): Promise<{ success: boolean; path: string; error?: string }> {
	return runtimeFetch<{ success: boolean; path: string; error?: string }>(
		config,
		"/api/admin/storage/write",
		{
			method: "POST",
			timeoutMs: 30_000,
			body: JSON.stringify({ path, content }),
		},
	);
}

/**
 * Delete a file from the mounted R2 namespace.
 */
export async function deleteStorageFile(
	config: ProvisioningConfig,
	path: string,
): Promise<{ success: boolean }> {
	return runtimeFetch<{ success: boolean }>(
		config,
		`/api/admin/storage/file?${new URLSearchParams({ path }).toString()}`,
		{ method: "DELETE", timeoutMs: 20_000 },
	);
}

export interface WriteStorageFileResult {
	success: boolean;
	path: string;
	error?: string;
}

/**
 * Read device state from tedi Worker admin endpoint (runtime truth).
 */
export async function getRuntimeDevices(
	config: ProvisioningConfig,
): Promise<RuntimeDevicesResult> {
	const data = await runtimeFetch<{
		pending?: Array<Record<string, unknown>>;
		paired?: Array<Record<string, unknown>>;
		raw?: unknown;
	}>(config, "/api/admin/devices", { timeoutMs: 30_000 });

	const normalize = (
		status: "pending" | "paired" | "revoked",
		device: Record<string, unknown>,
	): RuntimeDevice => ({
		id: String(
			device.id ?? device.deviceId ?? device.requestId ?? crypto.randomUUID(),
		),
		tediId: null,
		deviceId:
			typeof device.deviceId === "string"
				? device.deviceId
				: typeof device.requestId === "string"
					? device.requestId
					: null,
		displayName:
			typeof device.displayName === "string"
				? device.displayName
				: typeof device.name === "string"
					? device.name
					: null,
		platform: typeof device.platform === "string" ? device.platform : null,
		channel: typeof device.channel === "string" ? device.channel : null,
		status,
		pairedAt: typeof device.pairedAt === "string" ? device.pairedAt : null,
		createdAt:
			typeof device.createdAt === "string"
				? device.createdAt
				: typeof device.requestedAt === "string"
					? device.requestedAt
					: null,
	});

	return {
		pending: (data.pending ?? []).map((d) => normalize("pending", d)),
		paired: (data.paired ?? []).map((d) => normalize("paired", d)),
		raw: data.raw,
	};
}

/**
 * Approve a pending runtime device by request ID.
 */
// =============================================================================
// PAIRING
// =============================================================================

export interface PairingRequest {
	code: string;
	senderId?: string;
	senderName?: string;
	createdAt?: string;
}

export interface PairingListResult {
	channel: string;
	pending: PairingRequest[];
	count: number;
}

/**
 * List pending pairing requests for a channel.
 */
export async function listPairingRequests(
	config: ProvisioningConfig,
	channel: string,
): Promise<PairingListResult> {
	return runtimeFetch<PairingListResult>(
		config,
		`/api/admin/pairing/list?channel=${encodeURIComponent(channel)}`,
		{ timeoutMs: 20_000 },
	);
}

/**
 * Approve a pairing request by channel + code.
 */
export async function approvePairingRequest(
	config: ProvisioningConfig,
	channel: string,
	code: string,
): Promise<{
	success: boolean;
	channel: string;
	code: string;
	message: string;
}> {
	return runtimeFetch<{
		success: boolean;
		channel: string;
		code: string;
		message: string;
	}>(config, "/api/admin/pairing/approve", {
		method: "POST",
		body: JSON.stringify({ channel, code }),
		timeoutMs: 20_000,
	});
}

export async function approveRuntimeDevice(
	config: ProvisioningConfig,
	requestId: string,
): Promise<{ success: boolean; message?: string }> {
	return runtimeFetch<{ success: boolean; message?: string }>(
		config,
		`/api/admin/devices/${encodeURIComponent(requestId)}/approve`,
		{ method: "POST", timeoutMs: 20_000 },
	);
}

/**
 * Read channel runtime status from tedi Worker admin endpoint.
 */
export async function getRuntimeChannelStatus(
	config: ProvisioningConfig,
): Promise<RuntimeChannelsResult> {
	return runtimeFetch<RuntimeChannelsResult>(
		config,
		"/api/admin/channels/status",
		{
			timeoutMs: 30_000,
		},
	);
}

/**
 * Await runtime configuration-cache invalidation and require its explicit ok receipt.
 * The edge independently rebuilds its cache when fresh D1 revision pins change.
 */
export async function invalidateConfig(
	config: ProvisioningConfig,
	hostname?: string,
): Promise<boolean> {
	try {
		const receipt = await runtimeFetch<{ ok?: boolean }>(
			config,
			"/api/admin/invalidate-config",
			{
				method: "POST",
				timeoutMs: 10_000,
				body: JSON.stringify({ hostname: hostname ?? undefined }),
			},
		);
		return receipt?.ok === true;
	} catch (error) {
		console.warn("[provisioning] Failed to invalidate config cache:", error);
		return false;
	}
}

/**
 * Reconcile policy-pack cron templates into the durable Agent scheduler.
 * Returns the sync result including cronBootstrap diagnostics.
 *
 * When `forceUpdate` is true, matching template schedules are re-registered in
 * addition to normal drift repair. That path can touch multiple schedules, so
 * keep the caller timeout above the normal 120s boundary.
 */
export async function triggerCronSync(
	config: ProvisioningConfig,
	options?: { forceUpdate?: boolean },
): Promise<CronSyncResult> {
	const query = options?.forceUpdate ? "?forceUpdate=true" : "";
	return runtimeFetch<CronSyncResult>(config, `/api/cron/sync${query}`, {
		method: "POST",
		timeoutMs: options?.forceUpdate ? 180_000 : 120_000,
	});
}

// =============================================================================
// INTER-TEDI MESH
// =============================================================================

/**
 * List peer tedis in the same organization.
 */
export async function listTediPeers(config: ProvisioningConfig): Promise<{
	peers: Array<{
		id: string;
		name: string;
		slug: string;
		status: string;
		description?: string;
	}>;
}> {
	return runtimeFetch(config, "/api/admin/peers", { timeoutMs: 10_000 });
}

// =============================================================================
// CONFIG BUILDER
// =============================================================================

/**
 * Build a ProvisioningConfig from environment variables and a tedi runtime URL.
 */
export function buildProvisioningConfig(
	workerUrl: string,
	env: {
		ENVIRONMENT?: string;
		TEDI_DEV_BASE_URL?: string;
	},
	fetcher?: { fetch: typeof fetch },
): ProvisioningConfig {
	let effectiveWorkerUrl = workerUrl;
	let hostOverride: string | undefined;

	// Service bindings: CF Workers don't preserve the URL hostname as the Host header.
	// The tedi Worker uses Host to resolve which tedi to serve, so we MUST send X-Tedix-Host.
	if (fetcher) {
		try {
			hostOverride = new URL(workerUrl).hostname;
		} catch {
			// Keep undefined if URL parsing fails
		}
	}

	// Local API dev: route through the local tedi tunnel and preserve tenant resolution.
	// Cloudflared can't handle nested wildcard subdomains (e.g. tedi-0f0f0f0f.tedi.tedix.tech),
	// so we rewrite to the base tunnel URL and pass the original host via X-Tedix-Host.
	if (env.ENVIRONMENT === "development" && env.TEDI_DEV_BASE_URL) {
		try {
			const workerHost = new URL(workerUrl).hostname;
			const baseUrl = env.TEDI_DEV_BASE_URL;
			const baseHost = new URL(baseUrl).hostname; // e.g. tedi.tedix.tech
			if (workerHost !== baseHost) {
				effectiveWorkerUrl = baseUrl;
				hostOverride = workerHost;
			}
		} catch {
			// Keep original URL if parsing fails.
		}
	}

	return {
		workerUrl: effectiveWorkerUrl,
		...(hostOverride ? { hostOverride } : {}),
		...(fetcher ? { fetcher } : {}),
		...(env.ENVIRONMENT === "development" ? { isDev: true } : {}),
	};
}
