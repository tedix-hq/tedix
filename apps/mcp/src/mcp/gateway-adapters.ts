/**
 * The MCP gateway's ComplianceAdapter and AccountabilityAdapter.
 *
 * `check` runs the gateway's existing per-call gates (annotation assertion,
 * tier rate limit, destructive approval) and reduces what they found to the
 * shared `evaluateCall` facts, so a workspace object binding and a gateway
 * tool produce the same decision for the same call. The original gate
 * response is kept on the adapter so callers return the message clients and
 * tests already know.
 *
 * `append` stores one ChangeRecord per call that changed something or was
 * refused, through the API (one insert, no read); `needsChangeRecord` in
 * `change-record-policy.ts` decides. An applied read or liveness report is
 * returned unstored (`sequence` 0) and writes nothing, for Work tools too:
 * recording each of those grew the ledger by thousands of rows an hour.
 * A record holds
 * arguments only as `argsHash`. The gateway picks its `id` and `recordedAt`.
 *
 * A refused call waits for its record. A call that was allowed and has run
 * does not: the write is handed to `ctx.waitUntil` and the response returns
 * at once, so the ledger adds no latency to a working tool call. Without an
 * execution context the write is awaited.
 *
 * The returned record of a background write has `sequence` 0
 * (`UNSTORED_SEQUENCE`); its stored sequence is known only when it is read
 * back with `get` or `list`. Sequence is storage order, so a background
 * write can land after a later refusal: use `recordedAt` for call order.
 *
 * A ledger outage must not take tool calls down with it. A failed or slow
 * write is logged as `gateway_change_record_write_failed`; an awaited one
 * then also returns `sequence` 0. Refusal telemetry is a separate stream.
 */
import { requestPhaseTimings } from "./phase-timings";
import type {
	CallToolResult,
	ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
	evaluateCall,
	type ApprovalState,
} from "@tedix/agent-governance/compliance";
import type {
	AccountabilityAdapter,
	Actor,
	ApprovalEvidence,
	CallDescription,
	CallOutcome,
	ChangeRecord,
	ChangeRecordInput,
	ComplianceAdapter,
	ComplianceDecision,
	LedgerQuery,
} from "@tedix/agent-governance/types";
import { CHANGE_RECORD_SCHEMA_VERSION } from "@tedix/agent-governance/types";
import { hashValue } from "@tedix/agent-governance/hash";
import {
	CallRefusedError,
	guardedCall,
} from "@tedix/agent-governance/wrap-binding";
import {
	enforceExpectedAnnotations,
	requireDestructiveToolApproval,
	stripDestructiveApprovalArgs,
	type DestructiveApprovalOptions,
} from "./governance";
import {
	declaresSkipAppliedChangeRecord,
	needsChangeRecord,
} from "./change-record-policy";
import { INPUT_REQUIRED_META_KEY } from "./mrtr";
import type { AppTool, ServerContext } from "./server-context";
import {
	enforceToolRiskRateLimit,
	resolveToolRiskPolicy,
} from "./tool-risk-policy";
import { emitMcpAuditEvent, type McpEvent } from "./utils/analytics";
import { z } from "zod";

/** What the ledger needs from a request: who called, for which app, and the API. */
type LedgerContext = Partial<
	Pick<
		ServerContext,
		| "env"
		| "ctx"
		| "appId"
		| "appSlug"
		| "app"
		| "callerIdentity"
		| "traceId"
		| "apiClient"
	>
>;
type GateContext = Parameters<typeof requireDestructiveToolApproval>[0] &
	LedgerContext;
type GateTool = Parameters<typeof requireDestructiveToolApproval>[1] &
	Pick<AppTool, "inputSchema"> &
	Partial<Pick<AppTool, "meta" | "writeCapability">>;

export interface GatewayCallGates {
	agent: GateContext;
	tool: GateTool;
	annotations: ToolAnnotations | undefined;
	args: Record<string, unknown>;
	approval?: DestructiveApprovalOptions;
	/** Namespaced name for Code Mode, else the tool id. */
	toolName?: string;
	/** Request surface, for the ledger row. */
	surface?: "mcp_gateway" | "mcp_codemode" | "mcp_widget";
}

/** A call refused before the gates ran, which may be before a server exists. */
export type GatewayRefusedCall = Omit<GatewayCallGates, "agent"> & {
	agent: LedgerContext;
};

export function describeGatewayCall(
	gates: GatewayCallGates | GatewayRefusedCall,
): CallDescription {
	const policy = resolveToolRiskPolicy({ meta: gates.tool.meta ?? null });
	const identity = gates.agent.callerIdentity;
	const actor: Actor = {
		id:
			identity?.userId ?? identity?.tediId ?? identity?.clientId ?? "anonymous",
		kind:
			identity?.authType === "tedi"
				? "tedi"
				: identity?.authType === "service"
					? "service"
					: identity?.authType === "external_agent"
						? "agent"
						: identity?.authType === "user" || identity?.authType === "oauth"
							? "user"
							: "system",
		...(gates.agent.app?.organizationId
			? { organizationId: gates.agent.app.organizationId }
			: {}),
	};
	const approvalRequestId =
		gates.approval?.extra?._meta?.["com.tedix/approvalRequestId"];
	return {
		resource: `tool:${gates.tool.toolId}`,
		operation: gates.toolName ?? gates.tool.toolId,
		args: gates.args,
		actor,
		source: {
			surface: gates.surface ?? "mcp_gateway",
			...(gates.agent.traceId ? { traceId: gates.agent.traceId } : {}),
		},
		...(policy
			? { riskTier: policy.riskTier, blastRadius: policy.blastRadius }
			: {}),
		...(gates.annotations?.destructiveHint === true ||
		gates.tool.writeCapability === "destructive"
			? { destructive: true }
			: {}),
		...(typeof approvalRequestId === "string" ? { approvalRequestId } : {}),
		...(gates.tool.title ? { title: gates.tool.title } : {}),
	};
}

export class GatewayComplianceAdapter implements ComplianceAdapter {
	verifiedHomeAgentPrincipalId?: string;
	verifiedOwnerToolUserId?: string;
	/**
	 * Evidence from the approval path that let the call through. A path that
	 * consumes its approval during execution sets it then, so read it when the
	 * record is written, and only for an allowed call.
	 */
	approvalEvidence?: ApprovalEvidence;
	/** The gate response for the last refusal, in the shape clients expect. */
	failure: CallToolResult | null = null;
	constructor(private readonly gates: GatewayCallGates) {}

	async check(call: CallDescription): Promise<ComplianceDecision> {
		const context = this.gates.agent.ctx;
		return context
			? requestPhaseTimings(context).measure("policy", () =>
					this.checkCurrent(call),
				)
			: this.checkCurrent(call);
	}
	private async checkCurrent(
		call: CallDescription,
	): Promise<ComplianceDecision> {
		const { agent, tool, annotations, approval } = this.gates;
		this.failure = null;
		this.verifiedHomeAgentPrincipalId = undefined;
		this.verifiedOwnerToolUserId = undefined;
		this.approvalEvidence = undefined;
		const base = {
			riskTier: call.riskTier,
			blastRadius: call.blastRadius,
			destructive: call.destructive,
			disposition: approval?.tenantPolicyCandidate?.effect.disposition,
		};
		const annotationFailure = enforceExpectedAnnotations(
			agent,
			tool,
			annotations,
			approval?.extra,
		);
		if (annotationFailure) {
			this.failure = annotationFailure;
			return evaluateCall({
				...base,
				annotationViolation: true,
				approval: "not_required",
			});
		}
		const rateFailure = await enforceToolRiskRateLimit(
			agent as ServerContext,
			tool as AppTool,
		);
		if (rateFailure) {
			this.failure = rateFailure;
			return evaluateCall({
				...base,
				rate: {
					limited: true,
					scope: "organization_caller_app_tool",
					retryAfterSeconds: readRetryAfter(rateFailure),
				},
				approval: "not_required",
			});
		}
		const approvalFailure = await requireDestructiveToolApproval(
			agent,
			tool,
			annotations,
			{
				...approval,
				onOwnerToolVerified: (userId) => {
					this.verifiedOwnerToolUserId = userId;
				},
				onHomeAgentVerified: (principalId) => {
					this.verifiedHomeAgentPrincipalId = principalId;
				},
				onApprovalEvidence: (evidence) => {
					this.approvalEvidence = evidence;
				},
			},
		);
		// Evidence from a path that was later refused is not evidence.
		if (approvalFailure) this.approvalEvidence = undefined;
		let approvalState: ApprovalState;
		if (!approvalFailure) {
			approvalState =
				base.destructive || base.disposition === "ask"
					? "granted"
					: "not_required";
		} else {
			this.failure = approvalFailure;
			approvalState = approvalFailure._meta?.[INPUT_REQUIRED_META_KEY]
				? "pending"
				: "denied";
		}
		return evaluateCall({
			...base,
			rate:
				base.riskTier && base.riskTier !== "read"
					? { limited: false, scope: "organization_caller_app_tool" }
					: undefined,
			approval: approvalState,
			approvalRoute:
				agent.callerIdentity?.authType === "tedi" ? "agent" : "human",
		});
	}

	async record(
		_call: CallDescription,
		_decision: ComplianceDecision,
		_outcome: CallOutcome,
	): Promise<void> {
		// The accountability adapter owns the durable ChangeRecord; telemetry is separate.
	}
}

function readRetryAfter(result: CallToolResult): number | undefined {
	const security = result._meta?.["com.tedix/security"] as
		| { rateLimit?: { retryAfterSeconds?: number } }
		| undefined;
	return security?.rateLimit?.retryAfterSeconds;
}

/** `sequence` of a record not (yet) confirmed stored; stored rows start at 1. */
export const UNSTORED_SEQUENCE = 0;
const LEDGER_WRITE_TIMEOUT_MS = 3000;
/**
 * Waits before each retry of a failed record write, in the background. The
 * record keeps its id, and an append of a stored id stores nothing new, so a
 * retry never duplicates. Sized to finish inside a Worker's waitUntil time.
 */
export const LEDGER_WRITE_RETRY_MS = [1000, 3000, 10_000] as const;

export interface GatewayLedgerOptions {
	/** The called tool declares `skipAppliedChangeRecord` in its policy. */
	skipAppliedChangeRecord?: boolean;
	/** The Work Item the call was about, stamped on every record it writes. */
	subject?: ChangeRecord["subject"];
	/** Digest of the policy inputs the gates judged the call by. */
	policyDigest?: string;
}

/**
 * What ran the call and which run made it, from the Worker's own release
 * metadata and the verified caller identity. Never from client input.
 */
export function gatewayChangeContext(
	agent: LedgerContext,
	policyDigest: string | undefined,
): Pick<ChangeRecord, "environment" | "parent"> {
	const env = agent.env as
		| { GIT_SHA?: string; WORKER_VERSION?: { id?: string } }
		| undefined;
	const identity = agent.callerIdentity;
	const productSha =
		env?.GIT_SHA && env.GIT_SHA !== "unknown" ? env.GIT_SHA : undefined;
	const harness = identity?.ownerHostHarness ?? identity?.externalAgentHarness;
	const model = identity?.ownerHostModel ?? identity?.externalAgentModel;
	const environment = {
		...(productSha ? { productSha } : {}),
		...(env?.WORKER_VERSION?.id
			? { workerVersionId: env.WORKER_VERSION.id }
			: {}),
		...(harness
			? { harness }
			: identity?.authType === "tedi"
				? { harness: "tedi" }
				: {}),
		...(model ? { model } : {}),
		...(policyDigest ? { policyDigest } : {}),
	};
	const runId = identity?.requestRunId ?? identity?.skillRunId;
	const rootRunId =
		identity?.requestRootRunId && identity.requestRootRunId !== runId
			? identity.requestRootRunId
			: undefined;
	const parent = {
		...(runId ? { runId } : {}),
		...(rootRunId ? { rootRunId } : {}),
	};
	return {
		...(Object.keys(environment).length ? { environment } : {}),
		...(Object.keys(parent).length ? { parent } : {}),
	};
}

/** `hashValue` of the policy inputs the gates read for this tool. */
async function gatewayPolicyDigest(
	gates: Pick<GatewayCallGates, "tool" | "annotations">,
): Promise<string> {
	return hashValue({
		riskPolicy: resolveToolRiskPolicy({ meta: gates.tool.meta ?? null }),
		annotations: gates.annotations ?? null,
		writeCapability: gates.tool.writeCapability ?? null,
	});
}

/** Same check as the stored record's `subject.id`, so a write never fails on it. */
const isUuid = (value: unknown): value is string =>
	z.uuid().safeParse(value).success;

/**
 * The Work Item a call to one of Tedix's own API tools is about, so the
 * ledger can be read by task. A `workItems/...` endpoint names the item in
 * `id`; any other API tool names it in `workItemId`. Calls that name no
 * item, or two different ones, or a list of them, get no subject.
 */
function workItemSubject(
	tool: Pick<GateTool, "config">,
	args: Record<string, unknown>,
): ChangeRecord["subject"] {
	const config = tool.config;
	if (config?.transport !== "rpc") return undefined;
	const ids = new Set<string>();
	if (
		typeof config.endpoint === "string" &&
		config.endpoint.startsWith("workItems/") &&
		isUuid(args.id)
	)
		ids.add(args.id.toLowerCase());
	if (isUuid(args.workItemId)) ids.add(args.workItemId.toLowerCase());
	const [id] = ids;
	return ids.size === 1 && id ? { kind: "work_item", id } : undefined;
}

export class GatewayAccountabilityAdapter implements AccountabilityAdapter {
	constructor(
		private readonly agent: LedgerContext,
		private readonly options: GatewayLedgerOptions = {},
	) {}

	private get client() {
		if (!this.agent.apiClient) {
			throw new Error(
				"Gateway change ledger requires an organization-scoped API client",
			);
		}
		return this.agent.apiClient.audit;
	}

	async append(input: ChangeRecordInput): Promise<ChangeRecord> {
		// The gateway names the record, so a call that ran can be answered
		// before the write lands and telemetry can cite the id either way.
		const subject = input.subject ?? this.options.subject;
		const unstored: ChangeRecord = {
			schemaVersion: CHANGE_RECORD_SCHEMA_VERSION,
			...gatewayChangeContext(this.agent, this.options.policyDigest),
			...input,
			...(subject ? { subject } : {}),
			id: crypto.randomUUID(),
			sequence: UNSTORED_SEQUENCE,
			recordedAt: new Date().toISOString(),
		};
		const refused =
			input.outcome === "denied" || input.outcome === "needs_approval";
		const context = this.agent.ctx;
		let record: ChangeRecord;
		if (
			!needsChangeRecord({
				outcome: input.outcome,
				riskTier: input.decision.riskTier,
				skipAppliedChangeRecord: this.options.skipAppliedChangeRecord === true,
			})
		) {
			record = Object.freeze(unstored);
		} else if (!refused && context) {
			context.waitUntil(this.storeWithRetry(unstored, 0));
			record = Object.freeze(unstored);
		} else {
			record = Object.freeze(
				await this.store(unstored).catch(() => {
					context?.waitUntil(this.storeWithRetry(unstored, 1));
					return unstored;
				}),
			);
		}
		const { agent } = this;
		if (
			(record.outcome === "denied" || record.outcome === "needs_approval") &&
			agent.env &&
			agent.ctx &&
			agent.appId
		) {
			const event: McpEvent = {
				timestamp: record.recordedAt,
				eventType: "access_denied",
				appId: agent.appId,
				appSlug: agent.appSlug,
				organizationId: agent.app?.organizationId,
				toolName: record.operation,
				userId: agent.callerIdentity?.userId,
				clientId: agent.callerIdentity?.clientId,
				authType: agent.callerIdentity?.authType,
				traceId: agent.traceId,
				success: false,
				errorCode: record.decision.reason,
				metadata: {
					changeRecordId: record.id,
					gate: record.decision.gate,
					gateDecision:
						record.decision.verdict === "deny" ? "deny" : "needs_approval",
					gateReason: record.decision.reason,
					riskTier: record.decision.riskTier,
					blastRadius: record.decision.blastRadius,
					argsHash: record.argsHash,
					surface: record.source.surface,
				},
			};
			emitMcpAuditEvent(agent.env, event, agent.ctx.waitUntil.bind(agent.ctx));
		}
		return record;
	}
	/**
	 * One insert through the API, bounded so a stalled ledger holds nothing
	 * up for long. A failure is logged here and rethrown.
	 */
	/**
	 * Write the record, retrying after each failure with the waits in
	 * `LEDGER_WRITE_RETRY_MS`, starting at try `attempt`. A record still not
	 * stored after the last try is logged as lost.
	 */
	private async storeWithRetry(
		record: ChangeRecord,
		attempt: number,
	): Promise<void> {
		for (let next = attempt; ; next++) {
			if (next > 0) {
				const wait = LEDGER_WRITE_RETRY_MS[next - 1];
				if (wait === undefined) break;
				await new Promise((resolve) => setTimeout(resolve, wait));
			}
			try {
				await this.store(record);
				return;
			} catch {
				// Logged by `store`; try again.
			}
		}
		console.error(
			JSON.stringify({
				level: "error",
				event: "gateway_change_record_lost",
				message:
					"A gateway tool call has no stored change record after every retry.",
				changeRecordId: record.id,
				recordedAt: record.recordedAt,
				organizationId: this.agent.app?.organizationId,
				traceId: record.source.traceId,
				resource: record.resource,
				operation: record.operation,
				outcome: record.outcome,
			}),
		);
	}

	private async store(record: ChangeRecord): Promise<ChangeRecord> {
		const { sequence: _unstored, ...input } = record;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.client.appendChangeRecord(input),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("change record write timed out")),
						LEDGER_WRITE_TIMEOUT_MS,
					);
				}),
			]);
		} catch (error) {
			console.error(
				JSON.stringify({
					level: "error",
					event: "gateway_change_record_write_failed",
					message:
						"A gateway tool call has no stored change record; the call was not blocked.",
					error: error instanceof Error ? error.message : String(error),
					changeRecordId: record.id,
					organizationId: this.agent.app?.organizationId,
					appId: this.agent.appId,
					traceId: record.source.traceId,
					surface: record.source.surface,
					resource: record.resource,
					operation: record.operation,
					actorId: record.actor.id,
					outcome: record.outcome,
					gate: record.decision.gate,
					reason: record.decision.reason,
					argsHash: record.argsHash,
				}),
			);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
	async list(query: LedgerQuery = {}): Promise<ChangeRecord[]> {
		const records: ChangeRecord[] = [];
		let afterSequence = query.afterSequence;
		while (query.limit === undefined || records.length < query.limit) {
			const limit = Math.min(
				1000,
				query.limit === undefined ? 1000 : query.limit - records.length,
			);
			const page = await this.client.listChangeRecords({
				...query,
				afterSequence,
				limit,
			});
			for (const record of page) records.push(Object.freeze(record));
			if (page.length < limit) break;
			afterSequence = page[page.length - 1]!.sequence;
		}
		return records;
	}
	async get(id: string): Promise<ChangeRecord | null> {
		const record = await this.client.getChangeRecord({ id });
		return record ? Object.freeze(record) : null;
	}
	async export(): Promise<{ exportedAt: string; records: ChangeRecord[] }> {
		return { exportedAt: new Date().toISOString(), records: await this.list() };
	}
}

/** Record a refusal from a dispatch gate that runs before compliance admission. */
export async function recordGatewayRefusal(
	gates: GatewayRefusedCall,
	gate: ComplianceDecision["gate"],
	reason: string,
): Promise<ChangeRecord> {
	const call = describeGatewayCall(gates);
	const subject = workItemSubject(gates.tool, gates.args);
	return new GatewayAccountabilityAdapter(gates.agent, {
		...(subject ? { subject } : {}),
		policyDigest: await gatewayPolicyDigest(gates),
	}).append({
		resource: call.resource,
		operation: call.operation,
		actor: call.actor,
		source: call.source,
		argsHash: await hashValue(call.args),
		outcome: "denied",
		decision: {
			verdict: "deny",
			gate,
			reason,
			riskTier: call.riskTier ?? "unclassified",
			blastRadius: call.blastRadius ?? "unclassified",
		},
	});
}

async function ledgerOptions(
	gates: GatewayCallGates,
): Promise<GatewayLedgerOptions> {
	return {
		skipAppliedChangeRecord: declaresSkipAppliedChangeRecord(
			gates.tool.meta as Record<string, unknown> | null | undefined,
		),
		subject: workItemSubject(gates.tool, gates.args),
		policyDigest: await gatewayPolicyDigest(gates),
	};
}

export interface GuardedGatewayCall {
	/** The gate response to return to the client when the call was refused. */
	failure: CallToolResult | null;
	decision: ComplianceDecision;
	record: ChangeRecord;
	/** Arguments with the approval fields removed, ready for execution. */
	executionArgs: Record<string, unknown>;
	result: CallToolResult | null;
}

/**
 * check -> execute -> record for one gateway tool call. `execute` receives
 * the stripped arguments and runs only when the decision is `allow`.
 */
export async function guardGatewayCall(
	gates: GatewayCallGates,
	execute: (
		executionArgs: Record<string, unknown>,
		verifiedHomeAgentPrincipalId?: string,
		verifiedOwnerToolUserId?: string,
	) => Promise<CallToolResult>,
): Promise<GuardedGatewayCall> {
	const compliance = new GatewayComplianceAdapter(gates);
	const accountability = new GatewayAccountabilityAdapter(
		gates.agent,
		await ledgerOptions(gates),
	);
	const call = describeGatewayCall(gates);
	const executionArgs = stripDestructiveApprovalArgs(gates.tool, gates.args);
	try {
		const { result, decision, record } = await guardedCall(
			call,
			() =>
				execute(
					executionArgs,
					compliance.verifiedHomeAgentPrincipalId,
					compliance.verifiedOwnerToolUserId,
				),
			{
				compliance,
				accountability,
				approval: () => compliance.approvalEvidence,
				classify: (result) =>
					result.isError
						? { status: "not_applied", error: resultText(result) }
						: { status: "applied" },
			},
		);
		return { failure: null, decision, record, executionArgs, result };
	} catch (error) {
		if (error instanceof CallRefusedError) {
			return {
				failure: compliance.failure ?? refusalResult(error.decision),
				decision: error.decision,
				record: error.record,
				executionArgs,
				result: null,
			};
		}
		throw error;
	}
}

export interface AdmittedGatewayCall {
	verifiedHomeAgentPrincipalId?: string;
	verifiedOwnerToolUserId?: string;
	failure: CallToolResult | null;
	decision: ComplianceDecision;
	executionArgs: Record<string, unknown>;
	/** Append the ledger row once the call ran (or failed). No-op after a refusal. */
	settle(outcome: CallOutcome): Promise<ChangeRecord | null>;
}

/**
 * check -> (caller executes) -> settle, for call sites that own their own
 * execution loop. Same adapters and same decision as `guardGatewayCall`.
 */
export async function admitGatewayCall(
	gates: GatewayCallGates,
): Promise<AdmittedGatewayCall> {
	const compliance = new GatewayComplianceAdapter(gates);
	const accountability = new GatewayAccountabilityAdapter(
		gates.agent,
		await ledgerOptions(gates),
	);
	const call = describeGatewayCall(gates);
	const executionArgs = stripDestructiveApprovalArgs(gates.tool, gates.args);
	const argsHash = await hashValue(call.args);
	const decision = await compliance.check(call);
	const common = {
		resource: call.resource,
		operation: call.operation,
		actor: call.actor,
		source: call.source,
		decision,
		argsHash,
	};
	if (decision.verdict !== "allow") {
		await accountability.append({
			...common,
			outcome: decision.verdict === "deny" ? "denied" : "needs_approval",
		});
		await compliance.record(call, decision, {
			status: "not_applied",
			error: decision.reason,
		});
		return {
			failure: compliance.failure ?? refusalResult(decision),
			decision,
			executionArgs,
			settle: async () => null,
		};
	}
	let settled = false;
	return {
		failure: null,
		decision,
		executionArgs,
		verifiedHomeAgentPrincipalId: compliance.verifiedHomeAgentPrincipalId,
		verifiedOwnerToolUserId: compliance.verifiedOwnerToolUserId,
		settle: async (outcome) => {
			if (settled) return null;
			settled = true;
			const approval = compliance.approvalEvidence;
			const record = await accountability.append({
				...common,
				...(approval ? { approval } : {}),
				outcome: outcome.status,
			});
			await compliance.record(call, decision, outcome);
			return record;
		},
	};
}

function resultText(result: CallToolResult): string {
	return result.content
		.map((c) => (c.type === "text" ? c.text : ""))
		.join("\n")
		.slice(0, 1024);
}

function refusalResult(decision: ComplianceDecision): CallToolResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: `Call refused by ${decision.gate}: ${decision.reason}`,
			},
		],
	};
}

export type { CallOutcome };
