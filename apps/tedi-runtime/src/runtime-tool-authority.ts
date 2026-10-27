import { exceptionTopology } from "@tedix/worker-kit/exception-topology";
import { type ProxyToolOutput } from "@cloudflare/codemode";
import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { CODEMODE_EXECUTE_WRITE_KIND } from "@tedix/api-contract/schemas/codemode-execute-write";
import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import { traceBundleId } from "@tedix/context-core/harness-version";
import { getTediRuntimeApproval } from "@tedix/db/queries/tedi-runtime-bootstrap";
import { withDynamicWorkerLoaderDiagnostics } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { type ToolSet } from "ai";
import {
	browserSessionRuntimeEvent,
	browserSessionSignature,
	createTediBrowserSession,
	type TediBrowserSession,
} from "./browser-session";
import {
	browserLoginFromApproval,
	browserLoginRuntimeEvent,
	browserLoginSessions,
} from "./browser-login-session";
import {
	BROWSER_TAKEOVER_GATE_KEY,
	type BrowserTakeoverGate,
	decideBrowserTakeoverGate,
} from "./browser-takeover-gate";
import { createBrowserTools } from "./browser-tools";
import { CmSessionGate } from "./cm-execution-gate";
import { CmExecutionStore, hashCode } from "./cm-execution-store";
import { type ComputerCodeBinding } from "./computer-codemode-routing";
import { computerEnvironmentWorkspace } from "./computer-environment";
import {
	type ComputerWorkspaceScope,
	OPERATOR_COMPUTER_SCOPE,
} from "./computer-workspace-scope";
import type { AgentTediDO } from "./do";
import { createTediDurableCodemode } from "./durable-codemode";
import {
	buildDurableCodemodeEvents,
	publishDurableCodemodeEvents,
} from "./durable-codemode-events";
import {
	durableCodeCorrelationKey,
	type DurableCodeRunCorrelation,
} from "./durable-codemode-lifecycle";
import { validateDurableCodeSource } from "./durable-codemode-policy";
import {
	projectDurableCodemodeExecution,
	projectDurableCodemodeOutput,
} from "./durable-codemode-projection";
import { type RecoverableCodemodeRuntimeHandle } from "./durable-codemode-recovery";
import { createDurableCodemodeTools } from "./durable-codemode-tools";
import type { AgentMcpRuntime } from "./mcp-client-runtime";
import { COLD_MCP_SYNC_TIMEOUT_MS, identityValue } from "./runtime-facet-turns";
import {
	logTediRuntimeFailure,
	logTediRuntimeState,
} from "./runtime-failure-log";
import { createWebSearchAiTools } from "./web-search-tool";
import { withTimeout } from "./with-timeout";
import { createWorkApprovalAiTools as workAiTools } from "./work-approval-tools";
type ActiveTurnBinding = NonNullable<AgentTediDO["activeTurnBinding"]>;
async function durableExecutionStatus(
	runtime: RecoverableCodemodeRuntimeHandle,
	executionId: string,
) {
	const executions = await runtime.executions();
	return executions.find((item) => item.id === executionId)?.status ?? null;
}
/** Keep operator context useful without persisting auth codes or query secrets. */
function browserPageOrigin(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.origin
			: null;
	} catch {
		return null;
	}
}

/** The tedi's recorded human login, scoped to this Durable Object. */
function browserLogins(host: RuntimeToolAuthorityHost) {
	return browserLoginSessions({
		storage: host.ctx.storage,
		owner: () => ({
			tediId: identityValue(host.state.tediId),
			orgId: identityValue(host.state.orgId),
		}),
		currentSessionId: () => host.getBrowserSession().currentSessionId(),
		closeBrowser: (reason) => host.getBrowserSession().close(reason),
		emit: async (event) => {
			try {
				const turn = await host.resolveTurnTelemetry({
					warnLabel: "browser-login",
				});
				if (turn)
					await host.eventOutbox.publish(browserLoginRuntimeEvent(event, turn));
			} catch (error) {
				console.warn("[browser-login] runtime event failed", {
					exception: exceptionTopology(error),
				});
			}
		},
	});
}

export interface RuntimeToolAuthorityHost {
	mcpRuntime: AgentTediDO["mcpRuntime"];
	state: AgentTediDO["state"];
	env: AgentTediDO["env"];
	publishRuntimeObservation: AgentTediDO["publishRuntimeObservation"];
	computerWorkspace: AgentTediDO["computerWorkspace"];
	getMcpRuntime: AgentTediDO["getMcpRuntime"];
	computerEnvironment: AgentTediDO["computerEnvironment"];
	computerCodeRouting: AgentTediDO["computerCodeRouting"];
	ctx: AgentTediDO["ctx"];
	eventOutbox: AgentTediDO["eventOutbox"];
	getDurableCodemodeRuntime: AgentTediDO["getDurableCodemodeRuntime"];
	proposeCodemodeExecuteApproval: AgentTediDO["proposeCodemodeExecuteApproval"];
	recordDurableCodemodeResult: AgentTediDO["recordDurableCodemodeResult"];
	scheduleCodemodeApprovalRepair: AgentTediDO["scheduleCodemodeApprovalRepair"];
	activeTurnBinding: AgentTediDO["activeTurnBinding"];
	schedule: AgentTediDO["schedule"];
	resolveIdentityFromD1: AgentTediDO["resolveIdentityFromD1"];
	getSqlRunner: AgentTediDO["getSqlRunner"];
	getBrowserSession: AgentTediDO["getBrowserSession"];
	browserHostnamePolicies: AgentTediDO["browserHostnamePolicies"];
	enforceBrowserTakeoverGate: AgentTediDO["enforceBrowserTakeoverGate"];
	recordBrowserEgressDenial: AgentTediDO["recordBrowserEgressDenial"];
	getBrowserBudgetStore: AgentTediDO["getBrowserBudgetStore"];
	requestBrowserTakeover: AgentTediDO["requestBrowserTakeover"];
	browserTakeoverStatus: AgentTediDO["browserTakeoverStatus"];
	browserSession: AgentTediDO["browserSession"];
	resolveTurnTelemetry: AgentTediDO["resolveTurnTelemetry"];
	ensureIdentity: AgentTediDO["ensureIdentity"];
	runDurableCode: AgentTediDO["runDurableCode"];
	searchDurableCode: AgentTediDO["searchDurableCode"];
	describeDurableCode: AgentTediDO["describeDurableCode"];
	getDurableCodeExecution: AgentTediDO["getDurableCodeExecution"];
	listDurableCodeExecutions: AgentTediDO["listDurableCodeExecutions"];
	workspaceAiTools: AgentTediDO["workspaceAiTools"];
	browserAiTools: AgentTediDO["browserAiTools"];
	skillReadTool: AgentTediDO["skillReadTool"];
	durableCodemodeAiTools: AgentTediDO["durableCodemodeAiTools"];
	getPlatformClient: AgentTediDO["getPlatformClient"];
	cronAiTool: AgentTediDO["cronAiTool"];
	workstationAiTool: AgentTediDO["workstationAiTool"];
	objectStoreAiTools: AgentTediDO["objectStoreAiTools"];
	r2SqlAiTool: AgentTediDO["r2SqlAiTool"];
}
export const runtimeToolAuthority = {
	async getMcpRuntime(
		this: RuntimeToolAuthorityHost,
		skipInitialSync = false,
	): Promise<AgentMcpRuntime | null> {
		if (this.mcpRuntime) return this.mcpRuntime;
		const { tediId, orgId } = this.state;
		if (!tediId) return null;
		const { AgentMcpRuntime } = await import("./mcp-client-runtime");
		const runtime = new AgentMcpRuntime(
			this.env,
			tediId,
			orgId,
			(event) => this.publishRuntimeObservation(event),
			(conversationId) =>
				this.computerWorkspace({ kind: "conversation", key: conversationId })
					.workspace,
		);
		try {
			if (skipInitialSync) return (this.mcpRuntime = runtime);
			// Bound the cold sync: ensureSynced() can HANG (not only throw) on a cold
			// DO — a wedged upstream/AIH resolve leaves this await (and therefore
			// the facet turn setup) pending forever, which is the cold-tedi turn-START
			// stall. The timeout routes a hang into the SAME fail-soft catch below as
			// a thrown error, so the turn proceeds instead of wedging at run.started.
			await withTimeout(
				runtime.ensureSynced(),
				COLD_MCP_SYNC_TIMEOUT_MS,
				"mcp ensureSynced (cold-start guard)",
			);
		} catch (err) {
			// A failed OR HUNG first sync must NOT strand the turn tool-less or wedge
			// it. Cache the runtime anyway: downstream executeTool()/ensureSynced()
			// calls retry (the failed sync did not advance lastSyncAt), so transient
			// upstream blips self-heal within the same turn or on the next one.
			console.warn(
				"[isolate-mcp] runtime init sync failed/timed out (will retry on next tool access)",
				{ exception: exceptionTopology(err) },
			);
		}
		this.mcpRuntime = runtime;
		return runtime;
	},
	async getDurableCodemodeRuntime(
		this: RuntimeToolAuthorityHost,
		scope: ComputerCodeBinding,
	): Promise<RecoverableCodemodeRuntimeHandle> {
		const computer = this.computerWorkspace(scope);
		if (!this.env.LOADER)
			throw new Error("LOADER binding unavailable for durable Code Mode");
		const mcpRuntime = await this.getMcpRuntime();
		if (!mcpRuntime)
			throw new Error("MCP runtime unavailable for durable Code Mode");
		const environment = this.computerEnvironment(scope, null);
		const selected = Object.hasOwn(scope, "environment")
			? scope.environment
			: await environment.selected();
		await this.computerCodeRouting.register(
			`${computer.id}:${selected?.leaseId ?? "scratch"}`,
			{ ...scope, environment: selected ?? null },
		);
		const runtime = createTediDurableCodemode({
			ctx: this.ctx,
			env: this.env,
			loader: this.env.LOADER,
			mcpRuntime,
			workspace: computerEnvironmentWorkspace(
				computer.workspace,
				environment,
				selected ?? null,
			),
			name: `computer-${computer.id}:${selected?.leaseId ?? "scratch"}`,
		});
		return runtime;
	},
	async recordDurableCodemodeResult(
		this: RuntimeToolAuthorityHost,
		input: {
			action: "run" | "approve" | "reject" | "rollback";
			executionId: string;
			result: unknown;
			status?: string;
		},
	): Promise<void> {
		const tediId = this.state.tediId;
		if (!tediId) return;
		const createdAt = new Date().toISOString();
		try {
			const correlation = await this.ctx.storage.get<DurableCodeRunCorrelation>(
				durableCodeCorrelationKey(input.executionId),
			);
			const scope = await this.computerCodeRouting.resolve(input.executionId);
			const binding = correlation;
			const runId =
				binding?.runId ?? `${tediId}:durable-code:${input.executionId}`;
			const conversationId =
				binding?.conversationId ??
				buildTediConversationId({
					tediRef: this.state.slug || tediId,
					sessionKey:
						scope.kind === "conversation"
							? scope.key
							: `computer-${scope.kind}-${scope.key}`,
				});
			await publishDurableCodemodeEvents(
				this.eventOutbox,
				buildDurableCodemodeEvents(input, {
					tediId,
					runId,
					conversationId,
					homeRunId: correlation?.homeRunId,
					createdAt,
				}),
			);
		} catch (error) {
			logTediRuntimeFailure(
				"tedi.codemode.event_projection_failed",
				error,
				"error",
			);
		}
	},
	async runDurableCode(
		this: RuntimeToolAuthorityHost,
		input: {
			code: string;
		},
		scope: ComputerWorkspaceScope,
		binding: ActiveTurnBinding | null,
	): Promise<ProxyToolOutput> {
		const validation = validateDurableCodeSource(input.code);
		if (!validation.ok) {
			return {
				status: "error",
				executionId: "",
				error: validation.error ?? "Invalid durable Code Mode source",
			};
		}
		const boundScope = {
			...scope,
			environment:
				(await this.computerEnvironment(scope, null).selected()) ?? null,
		};
		const runtime = await this.getDurableCodemodeRuntime(boundScope);
		const result = await runtime.execute({ code: input.code });
		if (result.executionId)
			await this.computerCodeRouting.record(result.executionId, boundScope);
		let correlation: DurableCodeRunCorrelation | null = null;
		if (binding && result.executionId) {
			const codeHash = await hashCode(input.code);
			correlation = {
				codeHash,
				conversationId: binding.conversationId,
				runId: binding.runId,
				sessionKey: binding.sessionKey ?? scope.key,
				...(binding.homeRunId ? { homeRunId: binding.homeRunId } : {}),
				...(binding.workItemId ? { workItemId: binding.workItemId } : {}),
			};
			await this.ctx.storage.put<DurableCodeRunCorrelation>(
				durableCodeCorrelationKey(result.executionId),
				correlation,
			);
		}
		if (
			result.status === "paused" &&
			correlation?.homeRunId &&
			result.pending[0]
		) {
			const pending = result.pending[0];
			const approvalRequestId =
				correlation.approvalPendingSeq === pending.seq &&
				correlation.approvalRequestId
					? correlation.approvalRequestId
					: crypto.randomUUID();
			correlation = {
				...correlation,
				approvalPendingSeq: pending.seq,
				approvalRequestId,
			};
			// Persist the stable card id BEFORE the network bridge. A response-loss
			// retry therefore reuses the same canonical approval instead of creating a
			// duplicate card.
			await this.ctx.storage.put<DurableCodeRunCorrelation>(
				durableCodeCorrelationKey(result.executionId),
				correlation,
			);
			const bridgedApprovalRequestId =
				await this.proposeCodemodeExecuteApproval({
					approvalRequestId,
					executionId: result.executionId,
					sessionKey: correlation.sessionKey,
					codeHash: correlation.codeHash ?? (await hashCode(input.code)),
					conversationId: correlation.conversationId,
					executionMode: "durable_call",
					homeRunId: correlation.homeRunId,
					childRunId: correlation.runId,
					pendingSeq: pending.seq,
					connector: pending.connector,
					method: pending.method,
				});
			if (bridgedApprovalRequestId) {
				correlation = {
					...correlation,
					approvalRequestId: bridgedApprovalRequestId,
				};
				await this.ctx.storage.put<DurableCodeRunCorrelation>(
					durableCodeCorrelationKey(result.executionId),
					correlation,
				);
			}
		}
		const projectedResult = projectDurableCodemodeOutput(result);
		await this.recordDurableCodemodeResult({
			action: "run",
			executionId: result.executionId,
			result: projectedResult,
			status: result.status,
		});
		return projectedResult;
	},
	async searchDurableCode(
		this: RuntimeToolAuthorityHost,
		query: string,
		scope: ComputerWorkspaceScope,
	): Promise<unknown> {
		return (await this.getDurableCodemodeRuntime(scope)).search(query);
	},
	async describeDurableCode(
		this: RuntimeToolAuthorityHost,
		target: string,
		scope: ComputerWorkspaceScope,
	): Promise<unknown> {
		return (await this.getDurableCodemodeRuntime(scope)).describe(target);
	},
	async getDurableCodeExecution(
		this: RuntimeToolAuthorityHost,
		executionId: string,
		expectedScope?: ComputerWorkspaceScope,
	): Promise<unknown> {
		const scope = await this.computerCodeRouting.resolve(executionId);
		if (
			expectedScope &&
			(expectedScope.kind !== scope.kind || expectedScope.key !== scope.key)
		)
			throw new Error("Execution belongs to another Computer workspace");
		const executions = await (
			await this.getDurableCodemodeRuntime(scope)
		).executions();
		const execution = executions.find((item) => item.id === executionId);
		return (
			(execution ? projectDurableCodemodeExecution(execution) : null) ?? {
				ok: false,
				error: "execution_not_found",
				execution_id: executionId,
			}
		);
	},
	async listDurableCodeExecutions(
		this: RuntimeToolAuthorityHost,
		limit: number,
		scope: ComputerWorkspaceScope,
	): Promise<unknown[]> {
		const executions = await (
			await this.getDurableCodemodeRuntime(scope)
		).executions(limit);
		return executions.map(projectDurableCodemodeExecution);
	},
	async approveDurableCodeExecution(
		this: RuntimeToolAuthorityHost,
		executionId: string,
	): Promise<ProxyToolOutput> {
		const result = await (
			await this.getDurableCodemodeRuntime(
				await this.computerCodeRouting.resolve(executionId),
			)
		).approve({
			executionId,
		});
		let correlation = await this.ctx.storage.get<DurableCodeRunCorrelation>(
			durableCodeCorrelationKey(executionId),
		);
		if (
			result.status === "paused" &&
			correlation?.homeRunId &&
			correlation.codeHash &&
			result.pending[0]
		) {
			const pending = result.pending[0];
			const codeHash = correlation.codeHash;
			const approvalRequestId =
				correlation.approvalPendingSeq === pending.seq &&
				correlation.approvalRequestId
					? correlation.approvalRequestId
					: crypto.randomUUID();
			correlation = {
				...correlation,
				approvalPendingSeq: pending.seq,
				approvalRequestId,
			};
			await this.ctx.storage.put<DurableCodeRunCorrelation>(
				durableCodeCorrelationKey(executionId),
				correlation,
			);
			const bridgedApprovalRequestId =
				await this.proposeCodemodeExecuteApproval({
					approvalRequestId,
					executionId,
					sessionKey: correlation.sessionKey,
					codeHash,
					conversationId: correlation.conversationId,
					executionMode: "durable_call",
					homeRunId: correlation.homeRunId,
					childRunId: correlation.runId,
					pendingSeq: pending.seq,
					connector: pending.connector,
					method: pending.method,
				});
			if (bridgedApprovalRequestId) {
				await this.ctx.storage.put<DurableCodeRunCorrelation>(
					durableCodeCorrelationKey(executionId),
					{
						...correlation,
						approvalRequestId: bridgedApprovalRequestId,
					},
				);
			}
		}
		const projectedResult = projectDurableCodemodeOutput(result);
		await this.recordDurableCodemodeResult({
			action: "approve",
			executionId,
			result: projectedResult,
			status: result.status,
		});
		return projectedResult;
	},
	async rejectDurableCodeExecution(
		this: RuntimeToolAuthorityHost,
		executionId: string,
		seq: number,
	): Promise<{ ok: boolean; execution_id: string; seq: number }> {
		const runtime = await this.getDurableCodemodeRuntime(
			await this.computerCodeRouting.resolve(executionId),
		);
		// Only a paused run has an actionable approval. A stale pending entry on a
		// finished run must not rewrite its outcome as rejected.
		const ok =
			(await durableExecutionStatus(runtime, executionId)) === "paused" &&
			(await runtime.reject({ executionId, seq }));
		const result = { ok, execution_id: executionId, seq };
		await this.recordDurableCodemodeResult({
			action: "reject",
			executionId,
			result,
			status: ok ? "rejected" : "unchanged",
		});
		return result;
	},
	async rollbackDurableCodeExecution(
		this: RuntimeToolAuthorityHost,
		executionId: string,
	): Promise<{ ok: true; execution_id: string }> {
		const runtime = await this.getDurableCodemodeRuntime(
			await this.computerCodeRouting.resolve(executionId),
		);
		const status = await durableExecutionStatus(runtime, executionId);
		if (!status)
			throw new Error(
				"Cannot roll back durable Code Mode execution: execution_not_found",
			);
		// Reverting under a live run would let its pending approval resume, or an
		// in-flight pass complete over the rollback.
		if (status === "paused" || status === "running")
			throw new Error(
				`Cannot roll back a durable Code Mode execution that is still ${status}; reject it or let it finish first.`,
			);
		await runtime.rollback({ executionId });
		const result = { ok: true as const, execution_id: executionId };
		await this.recordDurableCodemodeResult({
			action: "rollback",
			executionId,
			result,
			status: "rolled_back",
		});
		return result;
	},
	async proposeCodemodeExecuteApproval(
		this: RuntimeToolAuthorityHost,
		input: {
			approvalRequestId: string;
			executionId: string;
			sessionKey: string;
			codeHash: string;
			conversationId: string;
			executionMode?: "session_replay" | "durable_call";
			homeRunId?: string;
			childRunId?: string;
			pendingSeq?: number;
			connector?: string;
			method?: string;
			repairAttempt?: number;
		},
	): Promise<string | null> {
		if (!this.env.API_SERVICE) {
			await this.scheduleCodemodeApprovalRepair(input);
			return null;
		}
		const tediId = identityValue(this.state.tediId);
		const orgId = identityValue(this.state.orgId);
		if (!tediId || !orgId) {
			await this.scheduleCodemodeApprovalRepair(input);
			return null;
		}
		const conversationId =
			input.conversationId ??
			this.activeTurnBinding?.conversationId ??
			buildTediConversationId({
				tediRef: this.state.slug || tediId,
				sessionKey: input.sessionKey,
			});
		try {
			const data = await callRpc<{
				approvalRequestId?: string;
			}>(
				"kernelRuntime/proposeCodemodeExecute",
				{
					tediId,
					orgId,
					conversationId,
					sessionKey: input.sessionKey,
					executionId: input.executionId,
					codeHash: input.codeHash,
					approvalRequestId: input.approvalRequestId,
					...(input.executionMode
						? { executionMode: input.executionMode }
						: {}),
					...(input.homeRunId ? { homeRunId: input.homeRunId } : {}),
					...(input.childRunId ? { childRunId: input.childRunId } : {}),
					...(input.pendingSeq !== undefined
						? { pendingSeq: input.pendingSeq }
						: {}),
					...(input.connector ? { connector: input.connector } : {}),
					...(input.method ? { method: input.method } : {}),
				},
				{
					apiUrl: "https://api",
					fetch: serviceBindingFetch(this.env.API_SERVICE),
					headers: {
						"X-Service-Binding": "true",
						"X-Tedix-Org-Id": orgId,
					},
				},
			);
			const approvalRequestId =
				typeof data.approvalRequestId === "string"
					? data.approvalRequestId
					: null;
			if (!approvalRequestId) await this.scheduleCodemodeApprovalRepair(input);
			return approvalRequestId;
		} catch (error) {
			console.warn(
				`[durable-codemode] approval bridge failed for ${input.executionId}`,
				{ exception: exceptionTopology(error) },
			);
			await this.scheduleCodemodeApprovalRepair(input);
			return null;
		}
	},
	async scheduleCodemodeApprovalRepair(
		this: RuntimeToolAuthorityHost,
		input: {
			approvalRequestId: string;
			executionId: string;
			sessionKey: string;
			codeHash: string;
			conversationId: string;
			executionMode?: "session_replay" | "durable_call";
			homeRunId?: string;
			childRunId?: string;
			pendingSeq?: number;
			connector?: string;
			method?: string;
			repairAttempt?: number;
		},
	): Promise<void> {
		const repairAttempt = input.repairAttempt ?? 0;
		if (repairAttempt >= 5) {
			logTediRuntimeState("tedi.codemode.approval_repair_exhausted", "error");
			return;
		}
		try {
			await this.schedule(
				30 * 2 ** repairAttempt,
				"repairCodemodeExecuteApproval",
				{ ...input, repairAttempt: repairAttempt + 1 },
				{ idempotent: true, retry: { maxAttempts: 3 } },
			);
		} catch (error) {
			logTediRuntimeFailure(
				"tedi.codemode.approval_repair_schedule_failed",
				error,
			);
		}
	},
	async repairCodemodeExecuteApproval(
		this: RuntimeToolAuthorityHost,
		input: {
			approvalRequestId: string;
			executionId: string;
			sessionKey: string;
			codeHash: string;
			conversationId: string;
			executionMode?: "session_replay" | "durable_call";
			homeRunId?: string;
			childRunId?: string;
			pendingSeq?: number;
			connector?: string;
			method?: string;
			repairAttempt?: number;
		},
	): Promise<void> {
		const approvalRequestId = await this.proposeCodemodeExecuteApproval(input);
		if (!approvalRequestId) return;
		const key = durableCodeCorrelationKey(input.executionId);
		const correlation = await this.ctx.storage
			.get<DurableCodeRunCorrelation>(key)
			.catch(() => undefined);
		if (!correlation || correlation.approvalPendingSeq !== input.pendingSeq)
			return;
		await this.ctx.storage.put<DurableCodeRunCorrelation>(key, {
			...correlation,
			approvalRequestId,
		});
	},
	async drainPendingCodemodeExecutions(
		this: RuntimeToolAuthorityHost,
	): Promise<void> {
		let tediId = identityValue(this.state.tediId);
		if (!tediId) {
			const resolved = await this.resolveIdentityFromD1();
			tediId = resolved?.tediId;
		}
		if (!tediId) return;

		const execStore = new CmExecutionStore(this.getSqlRunner());
		const parked = execStore.listParked(10);
		if (parked.length === 0) return;

		const sessionGate = new CmSessionGate(this.ctx.storage);
		const db = this.env.DB;

		for (const row of parked) {
			const approvalRequestId = row.approval_request_id;
			if (!approvalRequestId) continue;
			let card: {
				status: string;
				tediId: string;
				payload: string;
			} | null = null;
			try {
				card = await getTediRuntimeApproval(db, approvalRequestId);
			} catch {
				continue;
			}
			if (!card || card.tediId !== tediId) continue;
			// Defense-in-depth: confirm the card is a codemode-execute card.
			let kind: unknown;
			try {
				kind = (JSON.parse(card.payload) as { kind?: unknown })?.kind;
			} catch {
				continue;
			}
			if (kind !== CODEMODE_EXECUTE_WRITE_KIND) continue;

			if (card.status === "approved") {
				try {
					await sessionGate.authorizeReplay({
						sessionKey: row.session_id,
						codeHash: row.code_hash,
						sourceExecutionId: row.id,
						authorizedBy: "operator",
					});
					execStore.markReplayAuthorized(row.id, "operator");
					console.log(
						JSON.stringify({
							_cm: "execute_replay_authorized",
							executionId: row.id,
							sessionKey: row.session_id,
							approvalRequestId,
							codeHash: row.code_hash,
						}),
					);
				} catch {}
			} else if (
				card.status === "rejected" ||
				card.status === "cancelled" ||
				card.status === "expired"
			) {
				execStore.markAbandoned(row.id, `card_${card.status}`);
			}
		}
	},
	browserAiTools(
		this: RuntimeToolAuthorityHost,
		scope: ComputerWorkspaceScope | null,
		binding: ActiveTurnBinding | null,
	): ToolSet {
		const resultFiles = this.computerWorkspace(
			scope ?? OPERATOR_COMPUTER_SCOPE,
		).workspace;
		const limit = this.state.budgets?.browserBudgetDaily ?? 50;
		const approvalRequired =
			(this.state.toolPolicy?.browser ?? "always-allow") === "always-approve";
		const session = this.getBrowserSession();
		return createBrowserTools({
			resultFiles,
			session,
			getSession: () => this.getBrowserSession(),
			getSessionPolicy: () => this.state.toolPolicy?.browserSession,
			onClosed: async () => {
				await this.ctx.storage.delete(BROWSER_TAKEOVER_GATE_KEY);
				await browserLogins(this).forget("tedi_request");
			},
			login: () => browserLogins(this).status(),
			gates: {
				approvalRequired,
				hostnamePolicies: this.browserHostnamePolicies(),
				executeEgress: session.executeEgress,
				enforceTakeover: (name) => this.enforceBrowserTakeoverGate(name),
				onEgressDenied: (name, egress) =>
					this.recordBrowserEgressDenial(name, egress, binding),
				consumeBudget: () => this.getBrowserBudgetStore().consume(limit),
			},
			budgetStatus: () => ({
				...this.getBrowserBudgetStore().status(limit),
				approvalPolicy: approvalRequired ? "always-approve" : "always-allow",
				hostnamePolicy: {
					organization: this.state.organizationBrowserEgress ?? null,
					tedi: this.state.toolPolicy?.browserEgress ?? null,
				},
				timezone: "UTC",
			}),
			requestTakeover: (input) =>
				this.requestBrowserTakeover({ ...input, limit }, binding),
			takeoverStatus: (approvalRequestId) =>
				this.browserTakeoverStatus(approvalRequestId, limit),
		});
	},
	browserHostnamePolicies(this: RuntimeToolAuthorityHost) {
		return [
			this.state.organizationBrowserEgress,
			this.state.toolPolicy?.browserEgress,
		];
	},
	getBrowserSession(this: RuntimeToolAuthorityHost): TediBrowserSession {
		const policy = this.state.toolPolicy?.browserSession;
		const hostnamePolicies = this.browserHostnamePolicies();
		if (
			this.browserSession?.signature ===
			browserSessionSignature(policy, hostnamePolicies)
		) {
			return this.browserSession;
		}
		const loader = this.env.LOADER;
		this.browserSession = createTediBrowserSession({
			ctx: this.ctx,
			browser: this.env.BROWSER,
			loader: loader
				? withDynamicWorkerLoaderDiagnostics(loader, {
						surface: "tedi_browser_code",
						reason: "tedi_browser_authored_invocation",
					})
				: loader,
			policy,
			hostnamePolicies,
			onLifecycle: async (event) => {
				const turn = await this.resolveTurnTelemetry({
					warnLabel: "browser-session",
				});
				if (turn) {
					await this.eventOutbox.publish(
						browserSessionRuntimeEvent(event, turn),
					);
				}
			},
		});
		return this.browserSession;
	},
	async requestBrowserTakeover(
		this: RuntimeToolAuthorityHost,
		input: {
			reason: "login" | "mfa" | "captcha" | "consent" | "operator_takeover";
			note: string;
			limit: number;
		},
		binding: ActiveTurnBinding | null,
	): Promise<unknown> {
		if (!binding) throw new Error("browser_takeover_owner_missing");
		await this.ensureIdentity();
		const tediId = identityValue(this.state.tediId);
		const orgId = identityValue(this.state.orgId);
		if (!tediId || !orgId) throw new Error("Tedi identity is unavailable");
		if (!this.env.API_SERVICE)
			throw new Error("Approval service is unavailable");
		const existingGate = await this.ctx.storage.get<BrowserTakeoverGate>(
			BROWSER_TAKEOVER_GATE_KEY,
		);
		const liveView = await this.getBrowserSession().liveView();
		if (!liveView || liveView.targets.length === 0) {
			throw new Error(
				"No durable Browser Run session with an open tab is active. Open the page with browser_execute (and call cdp.startSession() unless the browser is persistent) before requesting operator takeover.",
			);
		}
		const now = Date.now();
		const payload = {
			kind: "browser_live_view_takeover",
			sessionKey: binding.sessionKey,
			reason: input.reason,
			note: input.note,
			sessionId: liveView.sessionId,
			mode: "tab",
			targets: liveView.targets.map((target) => ({
				targetId: target.targetId,
				url: target.url,
				pageUrl: browserPageOrigin(target.pageUrl),
				title: null,
			})),
			urlExpiresAt: new Date(now + liveView.expiresInMs).toISOString(),
			...(binding?.conversationId
				? { conversationId: binding.conversationId }
				: {}),
			...(binding?.runId ? { runId: binding.runId } : {}),
			...(binding?.runId
				? { traceBundleId: traceBundleId(binding.runId) }
				: {}),
			...(binding?.workItemId ? { workItemId: binding.workItemId } : {}),
			budget: this.getBrowserBudgetStore().status(input.limit),
		};
		const approval = await callRpc<{
			expiresAt: string;
			id: string;
			status: string;
		}>(
			"tediApprovals/create",
			{
				tediId,
				orgId,
				actionType: "browser.live_view_takeover",
				description: `Human browser step required (${input.reason}): ${input.note}`,
				payload,
				...(existingGate
					? { replacesApprovalRequestId: existingGate.approvalRequestId }
					: {}),
				ttlHours: 1,
			},
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(this.env.API_SERVICE),
				headers: {
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": orgId,
				},
			},
		);
		await this.ctx.storage.put<BrowserTakeoverGate>(BROWSER_TAKEOVER_GATE_KEY, {
			approvalRequestId: approval.id,
			expiresAt: approval.expiresAt,
			sessionId: liveView.sessionId,
		});
		if (binding) {
			try {
				await binding.platform.recordRuntimeEvent({
					id: `${binding.runId}:browser-takeover:${approval.id}`,
					tediId,
					kind: "approval.requested",
					conversationId: binding.conversationId,
					runId: binding.runId,
					payload: {
						surface: "browser_live_view",
						approvalRequestId: approval.id,
						sessionId: liveView.sessionId,
						reason: input.reason,
						...(binding.workItemId ? { workItemId: binding.workItemId } : {}),
					},
					runtime: { backend: "cloudflare-agents" },
					createdAt: new Date(now).toISOString(),
				});
			} catch (error) {
				// The canonical API approval already exists. Evidence projection is
				// best-effort and must not invite a duplicate approval retry.
				console.warn("[browser-takeover] runtime event projection failed", {
					exception: exceptionTopology(error),
				});
			}
		}
		return {
			status: "approval_requested",
			approvalRequestId: approval.id,
			sessionId: liveView.sessionId,
			urlExpiresAt: payload.urlExpiresAt,
			targets: payload.targets,
			budget: payload.budget,
			instruction:
				"Wait for the operator to complete the browser step and approve in Tedix OS, then call get_browser_takeover_status.",
		};
	},
	async browserTakeoverStatus(
		this: RuntimeToolAuthorityHost,
		approvalRequestId: string,
		limit: number,
	): Promise<unknown> {
		await this.ensureIdentity();
		const tediId = identityValue(this.state.tediId);
		if (!tediId) throw new Error("Tedi identity is unavailable");
		const row = await getTediRuntimeApproval(this.env.DB, approvalRequestId);
		if (!row || row.tediId !== tediId) {
			throw new Error("Browser takeover approval was not found for this tedi");
		}
		let payload: { kind?: unknown; sessionId?: unknown };
		try {
			payload = JSON.parse(row.payload) as typeof payload;
		} catch {
			throw new Error("Browser takeover approval payload is invalid");
		}
		if (payload.kind !== "browser_live_view_takeover") {
			throw new Error("Approval is not a browser takeover continuation");
		}
		const gate = await this.ctx.storage.get<BrowserTakeoverGate>(
			BROWSER_TAKEOVER_GATE_KEY,
		);
		if (
			!gate ||
			gate.approvalRequestId !== approvalRequestId ||
			gate.sessionId !== payload.sessionId
		) {
			throw new Error("Browser takeover continuation gate is unavailable");
		}
		const gateDecision = decideBrowserTakeoverGate({
			gate,
			row,
			tediId,
			orgId: identityValue(this.state.orgId),
		});
		if (gateDecision.action === "close") {
			await this.getBrowserSession().close("takeover_closed");
			await this.ctx.storage.delete(BROWSER_TAKEOVER_GATE_KEY);
			await browserLogins(this).forget("session_lost");
			return {
				approvalRequestId,
				status: gateDecision.reason,
				resolution: row.resolution,
				continuationReady: false,
				sameSession: false,
				sessionId: payload.sessionId,
				closed: true,
				budget: this.getBrowserBudgetStore().status(limit),
			};
		}
		const liveView = await this.getBrowserSession().liveView();
		const sameSession =
			liveView !== undefined && liveView.sessionId === payload.sessionId;
		return {
			approvalRequestId,
			status: row.status,
			resolution: row.resolution,
			continuationReady: gateDecision.action === "allow" && sameSession,
			sameSession,
			sessionId: payload.sessionId,
			...(sameSession && liveView
				? {
						targets: liveView.targets.map((target) => ({
							targetId: target.targetId,
							url: target.url,
							pageUrl: browserPageOrigin(target.pageUrl),
							title: null,
						})),
						urlExpiresAt: new Date(
							Date.now() + liveView.expiresInMs,
						).toISOString(),
					}
				: {}),
			budget: this.getBrowserBudgetStore().status(limit),
		};
	},
	async enforceBrowserTakeoverGate(
		this: RuntimeToolAuthorityHost,
		toolName: string,
	): Promise<void> {
		if (toolName !== "browser_execute") return;
		const gate = await this.ctx.storage.get<BrowserTakeoverGate>(
			BROWSER_TAKEOVER_GATE_KEY,
		);
		const logins = browserLogins(this);
		if (!gate) return logins.ensure();
		const row = await getTediRuntimeApproval(
			this.env.DB,
			gate.approvalRequestId,
		);
		const tediId = identityValue(this.state.tediId);
		const orgId = identityValue(this.state.orgId);
		const decision = decideBrowserTakeoverGate({ gate, row, tediId, orgId });
		if (decision.action !== "allow") {
			if (decision.action === "close") {
				await this.getBrowserSession().close("takeover_closed");
				await this.ctx.storage.delete(BROWSER_TAKEOVER_GATE_KEY);
				await logins.forget("session_lost");
			}
			throw new Error(
				decision.action === "wait"
					? `Browser session is paused for approval ${gate.approvalRequestId}.`
					: `Browser takeover continuation closed (${decision.reason}).`,
			);
		}
		const liveView = await this.getBrowserSession().liveView();
		// `allow` already implies a row and an identity; the guard narrows them.
		if (!row || !tediId || !orgId || liveView?.sessionId !== gate.sessionId) {
			await this.ctx.storage.delete(BROWSER_TAKEOVER_GATE_KEY);
			throw new Error(
				"Approved browser takeover cannot resume because the original Browser Run session is no longer available.",
			);
		}
		// The person's sign-in now lives in this session; later turns reuse
		// it until it expires or someone ends it.
		await logins.record(
			browserLoginFromApproval({
				approvalRequestId: gate.approvalRequestId,
				sessionId: gate.sessionId,
				tediId,
				orgId,
				row,
				pageUrls: liveView.targets.map((target) => target.pageUrl),
			}),
		);
		await this.ctx.storage.delete(BROWSER_TAKEOVER_GATE_KEY);
	},
	/** Operator read or end of the tedi's recorded human login. */
	async browserLoginSession(
		this: RuntimeToolAuthorityHost,
		action: "status" | "end",
	): Promise<unknown> {
		await this.ensureIdentity();
		const logins = browserLogins(this);
		if (action === "end") {
			await this.ctx.storage.delete(BROWSER_TAKEOVER_GATE_KEY);
			return logins.end();
		}
		return { login: await logins.status() };
	},
	async recordBrowserEgressDenial(
		this: RuntimeToolAuthorityHost,
		toolName: string,
		decision: {
			hostname: string | null;
			reason: string;
		},
		binding: ActiveTurnBinding | null,
	): Promise<void> {
		console.warn(
			`[browser-egress] decision=deny tool=${toolName} host=${decision.hostname ?? "uninspectable"} reason=${decision.reason}`,
		);
		try {
			const ctx = await this.resolveTurnTelemetry({ binding });
			if (!ctx) return;
			await ctx.platform.recordRuntimeEvent({
				id: `${ctx.runId}:browser-egress:${crypto.randomUUID()}`,
				tediId: ctx.tediId,
				kind: "browser.egress.deny",
				conversationId: ctx.conversationId,
				runId: ctx.runId,
				payload: {
					toolName,
					hostname: decision.hostname,
					reason: decision.reason,
				},
				runtime: { backend: "cloudflare-agents" },
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			logTediRuntimeFailure(
				"tedi.browser.egress_denial_audit_failed",
				error,
				"error",
			);
		}
	},
	durableCodemodeAiTools(
		this: RuntimeToolAuthorityHost,
		scope: ComputerWorkspaceScope,
		binding: ActiveTurnBinding | null,
	): ToolSet {
		return createDurableCodemodeTools({
			run: (input) => this.runDurableCode(input, scope, binding),
			search: (query) => this.searchDurableCode(query, scope),
			describe: (target) => this.describeDurableCode(target, scope),
			getExecution: (executionId) =>
				this.getDurableCodeExecution(executionId, scope),
			listExecutions: (limit) => this.listDurableCodeExecutions(limit, scope),
		});
	},
	getTools(
		this: RuntimeToolAuthorityHost,
		scope: ComputerWorkspaceScope | null = null,
		binding: ActiveTurnBinding | null = null,
	): ToolSet {
		// Server-resolved tools only — the isolate exposes NO client-resolved
		// tools (ask_user / display_ui / browser clientTools). Before adding any,
		// add a native parallel-client-tool canary test before enabling the
		// 60s "fire-through" + spurious human-tool repair on PARALLEL client tools
		// The SDK permits client-side tools; without a Tedix-side guard that
		// timeout-based repair could silently regress here.
		//
		// One narrow exception lives outside this set: an embedded widget turn
		// may offer the host page's own tools for that turn only. They are
		// server-defined relays, not SDK client tools: `page-tool-broker.ts`
		// runs them one at a time per turn with per-call ids, bounded waits and
		// fenced results; `page-tool-broker.test.ts` is the parallel-call canary.
		//
		// Generic fetch tools are deliberately not wired.
		// Public `fetch_url` bypasses the MCP capability gate and egress audit model.
		// `fetch_api` binding for API_SERVICE is not useful here — oRPC is POST-based
		// and createFetchTools is GET-only. Wire inside this method (it runs per
		// turn) when per-tedi profile `fetchAllowlist` support lands.
		return {
			...(scope ? this.workspaceAiTools(scope, binding) : {}),
			...this.browserAiTools(scope, binding),
			...this.skillReadTool(binding),
			...(scope ? this.durableCodemodeAiTools(scope, binding) : {}),
			...workAiTools(() => this.getPlatformClient()),
			...this.cronAiTool(binding?.sessionKey),
			...(scope ? this.workstationAiTool(scope, binding) : {}),
			...this.objectStoreAiTools(),
			...this.r2SqlAiTool(),
			...createWebSearchAiTools({
				ai: this.env.AI,
				organizationWebSearch: this.state.organizationWebSearch,
				toolPolicy: this.state.toolPolicy,
				runId: binding?.runId,
				getPlatform: () => this.getPlatformClient(),
			}),
		};
	},
};
