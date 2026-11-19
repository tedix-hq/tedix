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

import { CALLER_TRUST_HEADER } from "@tedix/mcp-shared/auth/caller-trust";
import type {
	RuntimeRunSteeringInput,
	RunSteeringMessage,
} from "@tedix/api-contract/schemas/kernel-runtime";

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
	message?: string;
}

/**
 * Wake a tedi runtime and wait for readiness within a bounded time budget.
 * Returns structured state instead of failing when the warm-up window is exceeded.
 */
export async function wakeTedi(
	config: ProvisioningConfig,
): Promise<WakeTediResult> {
	return runtimeFetch<WakeTediResult>(config, "/api/admin/status/wake", {
		method: "POST",
		timeoutMs: 210_000,
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

export async function getBrowserTakeoverStatus(
	config: ProvisioningConfig,
	approvalRequestId: string,
): Promise<unknown> {
	return runtimeFetch(config, "/__internal/browser/takeover-status", {
		method: "POST",
		body: JSON.stringify({ approvalRequestId }),
	});
}

/** Read (`status`) or end the tedi's recorded browser sign-in. */
export async function browserLoginSession(
	config: ProvisioningConfig,
	action: "status" | "end",
): Promise<unknown> {
	return runtimeFetch(config, "/__internal/browser/login-session", {
		method: "POST",
		body: JSON.stringify({ action }),
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
		learningMode?: "disabled";
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
		/**
		 * Sign-in subject of the member whose request this turn serves. Omit
		 * for scheduled or autonomous work, which no member started.
		 */
		actingUserId?: string;
	},
): Promise<{
	success: boolean;
	accepted?: boolean;
	error?: string;
	run_id?: string;
	session_key?: string;
	/** True when the durable turn was dispatched but has not settled yet. */
	pending?: boolean;
	/** `null` on a pending durable turn; set only once the turn settled. */
	assistant?: { role: "assistant"; content: string; ts: number } | null;
}> {
	return runtimeFetch<{
		success: boolean;
		accepted?: boolean;
		error?: string;
		run_id?: string;
		session_key?: string;
		pending?: boolean;
		assistant?: { role: "assistant"; content: string; ts: number } | null;
	}>(config, "/hooks/inject", {
		method: "POST",
		// The runtime fails closed on a missing caller-trust tier; the kernel
		// injects for the organization, so the turn's steering fields
		// (`learning_mode`, `metadata`) are honoured.
		headers: {
			[CALLER_TRUST_HEADER]: "member",
			// The tedi applies this member's credit cap to the turn's model calls.
			...(options.actingUserId
				? { "X-Tedix-Acting-User": options.actingUserId }
				: {}),
		},
		body: JSON.stringify({
			text: options.message,
			...(options.learningMode ? { learning_mode: options.learningMode } : {}),
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

export async function controlRuntimeRunSteering(
	config: ProvisioningConfig,
	input: RuntimeRunSteeringInput,
): Promise<{ messages: RunSteeringMessage[] }> {
	return runtimeFetch(config, "/hooks/steer-run", {
		method: "POST",
		body: JSON.stringify(input),
		timeoutMs: 15_000,
	});
}

/** A separate route fails closed on older runtimes that do not support the restart fence. */
export async function cleanupOrphanRuntimeTurn(
	config: ProvisioningConfig,
	options: { clientRequestId: string; runId: string; orphanedBefore: string },
): Promise<{ success: boolean; detail?: string }> {
	return runtimeFetch(config, "/hooks/cleanup-orphan-turn", {
		method: "POST",
		body: JSON.stringify({
			client_request_id: options.clientRequestId,
			run_id: options.runId,
			orphaned_before: options.orphanedBefore,
		}),
		timeoutMs: 15_000,
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
// CONFIG BUILDER
// =============================================================================

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
