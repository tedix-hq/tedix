/**
 * GenericTasksWorkflow — out-of-band executor for config-driven async MCP tools.
 *
 * Lifecycle:
 * 1. `tool-execution.ts` (capability-gated `_asyncTask` path) inserts an
 *    `mcp_tasks` row with status `working` (snapshotting the tool input, a
 *    minimal exec-config, and durable caller-IDENTITY references — never a
 *    token), then kicks this Workflow with the task id.
 * 2. This Workflow loads the row, dispatches the tool against apps/api
 *    out-of-band, and writes the terminal status (`completed` + result, or
 *    `failed` + JSON-RPC error).
 * 3. The client polls `tasks/get` (aggregate-task-handlers.ts → `generic-<uuid>`
 *    routing) until terminal.
 *
 * EXECUTION SCOPE:
 * The workflow dispatches `rpc`/`rest`-transport tools directly against apps/api
 * over the `API_SERVICE` binding (org-scoped via `X-Tedix-Org-Id`), mirroring
 * the ToolHandler RPC/REST dispatch (handler.ts). This is the dominant async
 * case (kernel/provider reads + writes). The deliberate remaining seam:
 *
 *  - `external`-transport tools need per-request credential injection
 *    (connection-token resolution against the caller's Descope connection),
 *    which is bound to the live ServerContext / caller identity that does not
 *    exist in a detached Workflow. Those tasks are marked `failed` with a
 *    documented `-32601` so the protocol round-trip still terminates cleanly.
 *
 * CALLER-AUTH REPLAY:
 * Durable caller-identity REFERENCES (authType/userId/tediId/org/clientId/
 * kernel/connectionLabel — never a token or caller scopes) captured at create time are
 * replayed as service-binding identity headers on the rpc/rest dispatch
 * (mirroring apps/api kernel `execute.ts`): always `X-Service-Binding` +
 * `X-Tedix-Org-Id`; `X-Tedix-Acting-User` only when there is no tedi (so the
 * user's org-scoped credential leg is used) and `X-Tedix-Tedi-Id` only when a
 * tedi is present (never both — conflating them breaks the non-tedi credential
 * leg); `X-Tedix-Kernel` only for kernel turns. apps/api re-derives the
 * credential leg and re-validates authority server-side. No Authorization
 * bearer is replayed — the service-binding boundary is the trust anchor. An
 * exact code-owned endpoint map delegates only the API procedure scope needed
 * by a detached tool; D1 config and caller claims cannot widen that map.
 *
 * DISPATCH HARDENING:
 *  - Dispatch and the terminal DB write are separate steps so a Workflow retry
 *    of the terminal write never re-runs the side effect (no double-dispatch).
 *  - The row is re-read before dispatch and short-circuits if already terminal.
 *  - A stable taskId-derived idempotency key rides the dispatch so an
 *    idempotency-honoring server dedups a retried dispatch.
 *  - Before dispatch, a non-tedi acting user's org membership is re-validated
 *    against apps/api (revocation fail-closed — credential NOT_FOUND alone does
 *    not cover an org-tenant-scoped token whose membership was revoked).
 *
 * The persistence, status transitions, and cancellation checks around the
 * dispatch are real.
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createDbClient } from "@tedix/db/client";
import { mcpTasks } from "@tedix/db/schema/mcp-tasks";
import { toJsonRecord, toJsonValue } from "@tedix/db/utils/json";
import { eq } from "drizzle-orm";
import { callApiRpc } from "../lib/rpc";
import { getGenericTaskState } from "../mcp/generic-task-store";
import { getByPath } from "../mcp/handlers/path-utils";
import { buildQueryString } from "../mcp/utils/query-params";
import { materializeRestRoute } from "../mcp/utils/rest-route";
import { publishMcpTaskNotification } from "../subscription-publisher";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export interface GenericTasksWorkflowParams {
	/** Public MCP task id (`generic-<uuid>`). */
	taskId: string;
}

interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

interface ExecConfigSnapshot {
	transport?: string;
	endpoint?: string;
	method?: string;
	responsePath?: string;
}

/** Durable caller-identity references captured at task creation (never a token). */
interface CapturedCallerSnapshot {
	authType?: string;
	userId?: string;
	tediId?: string;
	organizationId?: string;
	clientId?: string;
	kernel?: boolean;
	connectionLabel?: string;
}

const UNSUPPORTED_TRANSPORT_ERROR = (
	transport: string,
): JsonRpcErrorObject => ({
	code: -32_601,
	message: `Generic async execution does not support the "${transport}" transport from a detached Workflow (needs live ServerContext credential injection). Do not mark this tool _asyncTask. The mcp_tasks lifecycle terminated cleanly.`,
});

const MISSING_CONFIG_ERROR: JsonRpcErrorObject = {
	code: -32_603,
	message:
		"Generic async task is missing the execution-config snapshot; cannot dispatch out-of-band.",
};

const MISSING_ORG_ERROR: JsonRpcErrorObject = {
	code: -32_603,
	message:
		"Generic async task is missing the caller org boundary; refusing to dispatch out-of-band (fail closed).",
};

const AUTHORITY_REVOKED_ERROR: JsonRpcErrorObject = {
	code: -32_603,
	message:
		"Caller authority could not be re-confirmed at dispatch time (membership not active); refusing to dispatch (fail closed).",
};

const DISPATCH_TIMEOUT_MS = 60_000;
const AUTHORITY_RECHECK_TIMEOUT_MS = 10_000;

/**
 * Exact API procedure capabilities a detached generic task may exercise.
 *
 * This is deliberately code-owned instead of persisted in `mcp_tasks` or read
 * from D1 tool config: caller scopes describe ingress authority, not the MCP
 * Worker's authority to invoke apps/api. Adding an endpoint here is therefore
 * a security-boundary change with source review and tests. Unknown endpoints
 * receive no delegated scope and remain fail-closed at the API guard.
 */
export const GENERIC_TASK_ENDPOINT_SCOPES: Readonly<
	Record<string, readonly string[]>
> = {
	"kernelRuntime/readRunSet": ["tedis:read"],
};

/**
 * Build the service-binding identity headers replaying the captured caller's
 * authority on the dispatch. Mirrors apps/api kernel `execute.ts`:
 *  - Always `X-Service-Binding` (trust anchor) + `X-Tedix-Org-Id`.
 *  - `X-Tedix-Acting-User` only when there is no tedi (resolve the human's own
 *    org-scoped provider connection) — distinct from the tedi credential leg.
 *  - `X-Tedix-Tedi-Id` only when a tedi is present.
 *  - never both acting-user and tedi-id (conflation breaks the non-tedi leg).
 *  - `X-Tedix-Kernel` only for kernel turns.
 *  - No Authorization bearer — service-binding is the trust anchor.
 */
function replayHeaders(
	orgId: string,
	caller: CapturedCallerSnapshot | undefined,
	useServiceBinding: boolean,
	endpoint: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Tedix-Org-Id": orgId,
	};
	// `X-Service-Binding` is the trust anchor and is only honored over the
	// worker-to-worker API_SERVICE binding. Assert it only when we actually
	// dispatch over that binding — on the public-URL fallback (dead in every
	// deployed env, reached only when API_SERVICE is unbound) public ingress
	// strips it anyway, so do not emit it there.
	if (useServiceBinding) headers["X-Service-Binding"] = "true";
	const tediId = caller?.tediId;
	if (tediId) {
		headers["X-Tedix-Tedi-Id"] = tediId;
	} else if (caller?.userId) {
		headers["X-Tedix-Acting-User"] = caller.userId;
	}
	if (caller?.kernel === true) headers["X-Tedix-Kernel"] = "true";
	if (caller?.connectionLabel) {
		headers["X-Tedix-Connection-Label"] = caller.connectionLabel;
	}
	const endpointScopes = GENERIC_TASK_ENDPOINT_SCOPES[endpoint];
	if (useServiceBinding && endpointScopes?.length) {
		headers["X-Tedix-Tedi-Scopes"] = endpointScopes.join(" ");
	}
	return headers;
}

/** Normalized actor fields for the dispatch-boundary audit log line. */
function auditActor(caller: CapturedCallerSnapshot | undefined): {
	actorType: string;
	userId?: string;
	tediId?: string;
	kernel: boolean;
} {
	const kernel = caller?.kernel === true;
	const actorType = caller?.tediId
		? "tedi"
		: kernel
			? "kernel"
			: caller?.userId
				? "user"
				: (caller?.authType ?? "service");
	return {
		actorType,
		...(caller?.userId ? { userId: caller.userId } : {}),
		...(caller?.tediId ? { tediId: caller.tediId } : {}),
		kernel,
	};
}

/**
 * Structured dispatch-boundary audit/telemetry line. A detached Cloudflare
 * Workflow does not carry the MCP request-path analytics/audit emitter (those
 * are bound to the per-request `McpEvent` shape + live ServerContext), so we
 * emit a single-line structured `console` log carrying the replayed normalized
 * caller identity, taskId, toolId, and org. Operators can query these in
 * Workers Logs by `source: "generic-tasks-workflow"`.
 */
function emitDispatchAudit(
	phase: "start" | "terminal",
	fields: {
		taskId: string;
		toolName?: string;
		orgId: string;
		caller: CapturedCallerSnapshot | undefined;
		outcome?: "completed" | "failed" | "cancelled";
		errorCode?: number;
	},
): void {
	const actor = auditActor(fields.caller);
	console.log(
		JSON.stringify({
			source: "generic-tasks-workflow",
			event: "dispatch",
			phase,
			taskId: fields.taskId,
			toolName: fields.toolName ?? null,
			organizationId: fields.orgId,
			actorType: actor.actorType,
			userId: actor.userId ?? null,
			tediId: actor.tediId ?? null,
			kernel: actor.kernel,
			...(fields.outcome ? { outcome: fields.outcome } : {}),
			...(typeof fields.errorCode === "number"
				? { errorCode: fields.errorCode }
				: {}),
		}),
	);
}

type DispatchOutcome =
	| { kind: "completed"; result: Record<string, unknown> }
	| { kind: "failed"; error: JsonRpcErrorObject }
	| { kind: "cancelled" }
	// Dispatch short-circuited because the row was already terminal (a prior run
	// drove it to completed/failed/cancelled, or it vanished). The terminal write
	// MUST NOT touch the row — clobbering it to "cancelled" would corrupt a
	// completed/failed result on a Workflow retry.
	| { kind: "noop" };

export class GenericTasksWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	GenericTasksWorkflowParams
> {
	async run(
		event: WorkflowEvent<GenericTasksWorkflowParams>,
		step: WorkflowStep,
	): Promise<void> {
		const { taskId } = event.payload;
		const db = createDbClient(this.env.DB);

		// Step 1 — load the task lifecycle scalars (Serializable across the step
		// boundary). The exec-config + caller snapshots (JSON objects) are re-read
		// inside the dispatch step where they are consumed.
		const task = await step.do("load-task", async () => {
			const rows = await db
				.select({
					status: mcpTasks.status,
					cancelRequestedAt: mcpTasks.cancelRequestedAt,
					orgId: mcpTasks.orgId,
					appId: mcpTasks.appId,
				})
				.from(mcpTasks)
				.where(eq(mcpTasks.taskId, taskId))
				.limit(1);
			return rows[0] ?? null;
		});

		if (!task) {
			// Nothing to execute — the row was deleted/expired before the workflow
			// reached it. Terminal no-op.
			return;
		}

		// Already terminal (e.g. cancelled before execution started) — stop.
		if (
			task.status === "completed" ||
			task.status === "failed" ||
			task.status === "cancelled"
		) {
			return;
		}

		// Step 2 — honor cooperative cancellation requested via tasks/cancel.
		if (task.cancelRequestedAt) {
			await step.do("write-cancelled", async () => {
				await db
					.update(mcpTasks)
					.set({
						status: "cancelled",
						updatedAt: new Date().toISOString(),
					})
					.where(eq(mcpTasks.taskId, taskId));
			});
			await this.publishCurrentTaskState(taskId, task.orgId, task.appId);
			return;
		}

		// ── Step 3 (split) — DISPATCH only. Returns the persisted outcome; never
		// writes the terminal status. Splitting dispatch from the terminal write
		// means a Workflow retry of the terminal write cannot re-run the
		// side-effecting dispatch (no double-dispatch). The dispatch step itself
		// short-circuits if the row is already terminal (defends against a retry
		// of this step after a prior successful dispatch+terminal write).
		const outcome = await step.do<DispatchOutcome>("dispatch", async () => {
			// SHORT-CIRCUIT — re-read the row; if a prior run already drove it
			// terminal, do not dispatch again. This makes the dispatch step
			// idempotent across Workflow retries.
			const current = await db
				.select({
					status: mcpTasks.status,
					cancelRequestedAt: mcpTasks.cancelRequestedAt,
					orgId: mcpTasks.orgId,
					toolName: mcpTasks.toolName,
					inputRequests: mcpTasks.inputRequests,
				})
				.from(mcpTasks)
				.where(eq(mcpTasks.taskId, taskId))
				.limit(1);
			const row = current[0];
			// Row vanished (deleted/expired) — terminal no-op, do not write.
			if (!row) return { kind: "noop" } as DispatchOutcome;
			if (
				row.status === "completed" ||
				row.status === "failed" ||
				row.status === "cancelled"
			) {
				// Already terminal from a prior run — nothing to dispatch and the
				// terminal write must not touch the row (no clobber on retry).
				return { kind: "noop" } as DispatchOutcome;
			}
			// Cancel requested before dispatch — honor it without dispatching.
			if (row.cancelRequestedAt) {
				return { kind: "cancelled" } as DispatchOutcome;
			}

			const snapshot = isRecord(row.inputRequests) ? row.inputRequests : {};
			const inputArgs = isRecord(snapshot.input) ? snapshot.input : {};
			const execConfig = isRecord(snapshot.execConfig)
				? (snapshot.execConfig as ExecConfigSnapshot)
				: undefined;
			const caller = isRecord(snapshot.caller)
				? (snapshot.caller as CapturedCallerSnapshot)
				: undefined;
			// Caller org reference, else the row's org. Used for the org boundary.
			const orgId = caller?.organizationId ?? row.orgId;
			const toolName =
				typeof row.toolName === "string" ? row.toolName : undefined;

			// FAIL CLOSED — no caller org boundary means we cannot scope the
			// dispatch; refuse before fetch (and record the fail-closed decision so
			// it is observable, not silent).
			if (!orgId) {
				emitDispatchAudit("terminal", {
					taskId,
					toolName,
					orgId: caller?.organizationId ?? "",
					caller,
					outcome: "failed",
					errorCode: MISSING_ORG_ERROR.code,
				});
				return { kind: "failed", error: MISSING_ORG_ERROR } as DispatchOutcome;
			}

			emitDispatchAudit("start", { taskId, toolName, orgId, caller });

			const result = await this.runTool(
				taskId,
				orgId,
				inputArgs,
				execConfig,
				caller,
			);

			emitDispatchAudit("terminal", {
				taskId,
				toolName,
				orgId,
				caller,
				outcome: result.ok ? "completed" : "failed",
				...(result.ok ? {} : { errorCode: result.error.code }),
			});
			// The post-dispatch cancel re-read lives in the write-terminal step, not
			// here: once this step returns its outcome Cloudflare Workflows memoizes
			// it, so a retry can never re-run runTool (no double-dispatch). Doing the
			// cancel re-read here would re-open that window — a throw on the read
			// after a successful fetch would retry the whole step and re-dispatch.
			return result.ok
				? ({ kind: "completed", result: result.result } as DispatchOutcome)
				: ({ kind: "failed", error: result.error } as DispatchOutcome);
		});

		// ── Step 4 (split) — WRITE TERMINAL only. Consumes the persisted outcome
		// from the dispatch step; never re-dispatches. A retry of this step simply
		// re-writes the same terminal status (idempotent).
		await step.do("write-terminal", async () => {
			const now = new Date().toISOString();
			if (outcome.kind === "noop") {
				// The row was already terminal (or vanished) when the dispatch step
				// ran — leave it exactly as-is. This is the retry-safe short-circuit:
				// never clobber a prior completed/failed/cancelled status.
				return;
			}
			if (outcome.kind === "cancelled") {
				// Pre-dispatch cancellation — no side effect ran; flip to cancelled.
				await db
					.update(mcpTasks)
					.set({ status: "cancelled", updatedAt: now })
					.where(eq(mcpTasks.taskId, taskId));
				return;
			}
			// A dispatch ran (completed/failed). Re-read the cancel marker here
			// (moved out of the dispatch step to keep that step memoizable / avoid
			// the re-dispatch window): a cancel that landed mid-dispatch still wins
			// over a late-completing run. This read is in the write-terminal step so
			// a throw on it cannot re-run runTool.
			const fresh = await db
				.select({ cancelRequestedAt: mcpTasks.cancelRequestedAt })
				.from(mcpTasks)
				.where(eq(mcpTasks.taskId, taskId))
				.limit(1);
			if (fresh[0]?.cancelRequestedAt) {
				await db
					.update(mcpTasks)
					.set({ status: "cancelled", updatedAt: now })
					.where(eq(mcpTasks.taskId, taskId));
				return;
			}
			if (outcome.kind === "completed") {
				await db
					.update(mcpTasks)
					.set({
						status: "completed",
						result: toJsonRecord(outcome.result),
						updatedAt: now,
					})
					.where(eq(mcpTasks.taskId, taskId));
				return;
			}
			await db
				.update(mcpTasks)
				.set({
					status: "failed",
					error: {
						code: outcome.error.code,
						message: outcome.error.message,
						...(outcome.error.data === undefined
							? {}
							: { data: toJsonValue(outcome.error.data) }),
					},
					updatedAt: now,
				})
				.where(eq(mcpTasks.taskId, taskId));
		});
		if (outcome.kind !== "noop") {
			await this.publishCurrentTaskState(taskId, task.orgId, task.appId);
		}
	}

	private async publishCurrentTaskState(
		taskId: string,
		orgId: string,
		appId: string,
	): Promise<void> {
		try {
			const state = await getGenericTaskState(this.env.DB, taskId, orgId);
			await publishMcpTaskNotification({
				env: this.env,
				appId,
				organizationId: orgId,
				state,
			});
		} catch (error) {
			console.warn("[GenericTasksWorkflow] task notification publish failed", {
				taskId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Dispatch the snapshotted tool against apps/api out-of-band. Mirrors the
	 * ToolHandler rpc/rest dispatch (handler.ts) at the wire level, scoped to the
	 * task's org over the service binding, replaying the captured caller identity
	 * references (never a token). `external` transport is the documented seam
	 * (needs live credential injection) and terminates as a `-32601`.
	 */
	private async runTool(
		taskId: string,
		orgId: string,
		inputArgs: Record<string, unknown>,
		execConfig: ExecConfigSnapshot | undefined,
		caller: CapturedCallerSnapshot | undefined,
	): Promise<
		| { ok: true; result: Record<string, unknown> }
		| { ok: false; error: JsonRpcErrorObject }
	> {
		if (!execConfig?.endpoint) {
			return { ok: false, error: MISSING_CONFIG_ERROR };
		}
		const transport = execConfig.transport ?? "rpc";
		if (transport !== "rpc" && transport !== "rest") {
			return { ok: false, error: UNSUPPORTED_TRANSPORT_ERROR(transport) };
		}

		const useServiceBinding = Boolean(this.env.API_SERVICE);
		const baseUrl = useServiceBinding ? "https://api" : this.env.API_URL;
		if (!baseUrl) {
			return {
				ok: false,
				error: { code: -32_603, message: "No apps/api base URL available." },
			};
		}

		// ── [security] Dispatch-time authority re-check (revocation fail-closed) ──
		// Credential NOT_FOUND does not cover an org-tenant-scoped token whose
		// membership was revoked between create and dispatch. For a non-tedi acting
		// user, re-confirm the user is still an active member of the org before
		// dispatch. Tedi callers are covered by the tedi credential-resolution path
		// (NOT_FOUND/FORBIDDEN → terminal failed); bare service callers have no
		// acting user to revoke.
		if (caller?.userId && !caller.tediId) {
			const confirmed = await this.confirmActiveMembership(
				useServiceBinding,
				orgId,
				caller,
			);
			if (confirmed === false) {
				return { ok: false, error: AUTHORITY_REVOKED_ERROR };
			}
			// `null` = the check itself errored/was unreachable. We do not widen on a
			// transient check failure: dispatch proceeds and apps/api remains the
			// authoritative gate (it re-validates auth + resolves credentials, and a
			// genuinely revoked caller still fails there → terminal failed via the
			// existing status>=400 path).
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...replayHeaders(orgId, caller, useServiceBinding, execConfig.endpoint),
			// Stable taskId-derived idempotency key so an idempotency-honoring
			// server dedups a retried dispatch (defense-in-depth alongside the
			// terminal short-circuit).
			"Idempotency-Key": taskId,
			"X-Idempotency-Key": taskId,
		};

		try {
			let status: number;
			let data: unknown;
			if (transport === "rest") {
				const fetcher = useServiceBinding
					? this.env.API_SERVICE!.fetch.bind(this.env.API_SERVICE!)
					: globalThis.fetch;
				const method = execConfig.method ?? "POST";
				const route = materializeRestRoute(execConfig.endpoint, inputArgs);
				const queryString =
					method === "GET" ? buildQueryString(route.params) : "";
				const url = `${baseUrl}/v1/${route.endpoint}${queryString ? `?${queryString}` : ""}`;
				const response = await fetcher(url, {
					method,
					headers,
					body: method === "GET" ? undefined : JSON.stringify(route.params),
					signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
				});
				status = response.status;
				const contentType = response.headers.get("content-type") ?? "";
				data = contentType.includes("application/json")
					? await response.json()
					: await response.text();
			} else {
				const result = await callApiRpc(
					this.env,
					execConfig.endpoint,
					inputArgs,
					{
						headers,
						serviceBinding: useServiceBinding,
						timeoutMs: DISPATCH_TIMEOUT_MS,
					},
				);
				status = result.status;
				data = { json: result.data };
			}

			if (status >= 400) {
				return {
					ok: false,
					error: {
						code: -32_603,
						message: `Upstream tool dispatch failed (${status}).`,
						data: { status },
					},
				};
			}

			const responsePath =
				execConfig.responsePath ?? (transport === "rpc" ? "json" : undefined);
			if (responsePath && isRecord(data)) {
				data = getByPath(data, responsePath) ?? data;
			}

			return {
				ok: true,
				result: {
					content: [
						{
							type: "text",
							text:
								typeof data === "string" ? data : JSON.stringify(data ?? null),
						},
					],
					structuredContent: data ?? null,
				},
			};
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				return {
					ok: false,
					error: {
						code: -32_603,
						message: `Tool dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms.`,
					},
				};
			}
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: { code: -32_603, message } };
		}
	}

	/**
	 * Lightweight dispatch-time membership re-check for a NON-TEDI acting user.
	 * Calls apps/api `members/listMembers` over the service binding scoped to the
	 * captured org (the service-binding caller passes `withPermission`/scope
	 * guards, and `requireOrganizationAccess` is satisfied because the same org is
	 * carried in `X-Tedix-Org-Id`). Returns:
	 *   true  — the acting user is an active member of the org (authority confirmed)
	 *   false — the acting user is not an active member (revoked → fail closed)
	 *   null  — the check itself failed/unreachable (do not widen; apps/api stays
	 *           the authoritative gate on dispatch)
	 */
	private async confirmActiveMembership(
		useServiceBinding: boolean,
		orgId: string,
		caller: CapturedCallerSnapshot,
	): Promise<boolean | null> {
		const userId = caller.userId;
		if (!userId) return null;
		try {
			const LIMIT = 100;
			// Bound the scan so a pathologically large org cannot stall dispatch;
			// at most MAX_MEMBER_PAGES * LIMIT active members are walked.
			const MAX_MEMBER_PAGES = 50;
			for (
				let page = 0, offset = 0;
				page < MAX_MEMBER_PAGES;
				page++, offset += LIMIT
			) {
				const { data: payload, status } = await callApiRpc(
					this.env,
					"members/listMembers",
					{
						organizationId: orgId,
						status: "active",
						limit: LIMIT,
						offset,
					},
					{
						headers: replayHeaders(
							orgId,
							caller,
							useServiceBinding,
							"members/listMembers",
						),
						serviceBinding: useServiceBinding,
						timeoutMs: AUTHORITY_RECHECK_TIMEOUT_MS,
					},
				);
				if (status >= 400) return null;
				const members = isRecord(payload) ? payload.data : undefined;
				if (!Array.isArray(members)) return null;
				const found = members.some(
					(m) =>
						isRecord(m) &&
						m.descopeUserId === userId &&
						(m.status === "active" || m.status == null),
				);
				if (found) return true;
				// Walk pages until the active set is exhausted (listMembers is
				// paginated); only an exhausted scan without a hit means the user is
				// genuinely not an active member (revoked → fail closed). A single
				// first-page read would FALSE-deny a legitimate user in a >100-member
				// org who falls outside page 1.
				const pagination =
					isRecord(payload) && isRecord(payload.pagination)
						? payload.pagination
						: undefined;
				const hasMore =
					pagination && typeof pagination.hasMore === "boolean"
						? pagination.hasMore
						: members.length === LIMIT;
				if (!hasMore) return false;
			}
			// Page cap hit on an unusually large org — do not falsely deny a
			// legitimate caller; defer to apps/api as the authoritative gate.
			return null;
		} catch {
			// Transient/unreachable — do not widen; apps/api re-validates on dispatch.
			return null;
		}
	}
}
