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
 * `append` writes refusals to the MCP audit stream as `access_denied`
 * events. Applied calls are already written there as `tool_call` events by
 * the telemetry wrapper, keyed by the same trace id, so they are not
 * duplicated here.
 */
import type {
	CallToolResult,
	ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
	evaluateCall,
	type ApprovalState,
} from "@tedix/workspace-adapters/compliance";
import type {
	AccountabilityAdapter,
	Actor,
	CallDescription,
	CallOutcome,
	ChangeRecord,
	ChangeRecordInput,
	ComplianceAdapter,
	ComplianceDecision,
	LedgerQuery,
} from "@tedix/workspace-adapters/types";
import { hashValue } from "@tedix/workspace-adapters/hash";
import {
	CallRefusedError,
	guardedCall,
} from "@tedix/workspace-adapters/wrap-binding";
import {
	enforceExpectedAnnotations,
	requireDestructiveToolApproval,
	stripDestructiveApprovalArgs,
	type DestructiveApprovalOptions,
} from "./governance";
import { INPUT_REQUIRED_META_KEY } from "./mrtr";
import type { AppTool, ServerContext } from "./server-context";
import {
	enforceToolRiskRateLimit,
	resolveToolRiskPolicy,
} from "./tool-risk-policy";
import { emitMcpAuditEvent, type McpEvent } from "./utils/analytics";

type GateContext = Parameters<typeof requireDestructiveToolApproval>[0] &
	Partial<
		Pick<
			ServerContext,
			"env" | "ctx" | "appId" | "appSlug" | "app" | "callerIdentity" | "traceId"
		>
	>;
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

export function describeGatewayCall(gates: GatewayCallGates): CallDescription {
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
	/** The gate response for the last refusal, in the shape clients expect. */
	failure: CallToolResult | null = null;
	constructor(private readonly gates: GatewayCallGates) {}

	async check(call: CallDescription): Promise<ComplianceDecision> {
		const { agent, tool, annotations, approval } = this.gates;
		this.failure = null;
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
			approval,
		);
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
		// The telemetry wrapper writes the tool_call row; refusals go through append.
	}
}

function readRetryAfter(result: CallToolResult): number | undefined {
	const security = result._meta?.["com.tedix/security"] as
		| { rateLimit?: { retryAfterSeconds?: number } }
		| undefined;
	return security?.rateLimit?.retryAfterSeconds;
}

export class GatewayAccountabilityAdapter implements AccountabilityAdapter {
	private readonly records: ChangeRecord[] = [];
	constructor(private readonly agent: GateContext) {}

	async append(input: ChangeRecordInput): Promise<ChangeRecord> {
		const record: ChangeRecord = Object.freeze({
			...input,
			id: crypto.randomUUID(),
			sequence: this.records.length + 1,
			recordedAt: new Date().toISOString(),
		});
		this.records.push(record);
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
	async list(query: LedgerQuery = {}): Promise<ChangeRecord[]> {
		return this.records.filter(
			(r) =>
				(!query.resource || r.resource === query.resource) &&
				(query.afterSequence === undefined || r.sequence > query.afterSequence),
		);
	}
	async get(id: string): Promise<ChangeRecord | null> {
		return this.records.find((r) => r.id === id) ?? null;
	}
	async export(): Promise<{ exportedAt: string; records: ChangeRecord[] }> {
		return { exportedAt: new Date().toISOString(), records: [...this.records] };
	}
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
	execute: (executionArgs: Record<string, unknown>) => Promise<CallToolResult>,
): Promise<GuardedGatewayCall> {
	const compliance = new GatewayComplianceAdapter(gates);
	const accountability = new GatewayAccountabilityAdapter(gates.agent);
	const call = describeGatewayCall(gates);
	const executionArgs = stripDestructiveApprovalArgs(gates.tool, gates.args);
	try {
		const { result, decision, record } = await guardedCall(
			call,
			() => execute(executionArgs),
			{
				compliance,
				accountability,
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
	const accountability = new GatewayAccountabilityAdapter(gates.agent);
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
		settle: async (outcome) => {
			if (settled) return null;
			settled = true;
			const record = await accountability.append({
				...common,
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
