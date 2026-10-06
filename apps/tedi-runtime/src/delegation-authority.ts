import type { ExecutionSurface } from "@tedix/api-contract/schemas/execution-evidence";
import {
	type DelegationAuthorityEnvelope,
	DelegationAuthorityEnvelopeSchema,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { ToolSet } from "ai";

const MCP_CALL_TOOL = "tedix_mcp_call_tool";
const BROAD_CODE_TOOL = "tedix_mcp_code";
const IDENTITY_BOUND_AITL_TOOLS = new Set([
	"list_work_approval_inbox",
	"decide_work_approval",
]);
/** Classification exposes affordances, never grants authority. Every operation
 * still requires its exact tool ID in an enforced envelope. Shell execution
 * may mutate files and must not inherit read-only access. */
export const COMPUTER_TOOL_CAPABILITIES = {
	read: "read",
	ls: "read",
	find: "read",
	grep: "read",
	code_search: "read",
	write: "mutation",
	edit: "mutation",
	delete: "mutation",
	exec: "execution",
	open_computer: "execution",
	close_computer: "mutation",
	read_execution: "read",
	cancel_execution: "mutation",
} as const;

const SUPERVISED_DELEGATION_EXACT_TOOLS = new Set([
	...Object.keys(COMPUTER_TOOL_CAPABILITIES),
	"list_work_approval_inbox",
	"decide_work_approval",
	BROAD_CODE_TOOL,
	// A supervised child must be able to page its own retained MCP result after
	// the model-facing result cap, without repeating a provider action.
	"mcp_read_result",
	"read_skill",
	"workspace_snapshot",
	"repo_load",
	"clone_repo",
	"run_git",
	"repo_commit",
	"record_artifact",
	"deliverable_list",
	"deliverable_read_text",
	"deliverable_read_artifact",
	"open_computer",
	"close_computer",
	"read_execution",
	"cancel_execution",
]);
export type DelegationAuthorityMode = "shadow" | "enforce";

export type DelegationAuthorityVerdict = {
	allowed: boolean;
	wouldHaveDenied: boolean;
	requestedSurface: string;
	reason?: string;
};

export function parseDelegationAuthorityMode(
	value: unknown,
): DelegationAuthorityMode {
	if (value === undefined || value === null) return "shadow";
	if (value === "shadow" || value === "enforce") return value;
	throw new Error("invalid delegation authority mode");
}

export function parseDelegationAuthorityEnvelope(
	value: unknown,
): DelegationAuthorityEnvelope | null {
	if (value === undefined || value === null) return null;
	const parsed = DelegationAuthorityEnvelopeSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("invalid delegation authority envelope");
	}
	return parsed.data;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function namespacedCallables(
	envelope: DelegationAuthorityEnvelope,
): Set<string> {
	return new Set(
		envelope.allowedToolIds.filter(
			(toolId) => toolId.includes(".") && !toolId.startsWith("."),
		),
	);
}

export type DelegatedTurnAuthority = {
	envelope: DelegationAuthorityEnvelope;
	mode: DelegationAuthorityMode;
};

/**
 * Which per-tool authority, if any, governs a facet turn. Only a Home
 * delegation that carries an earned-delegation envelope has one: the envelope
 * is the entrustment grant Home matched at dispatch
 * (`selectDelegationAuthorityEnvelope` in apps/api), and it is what enforce
 * mode checks every tool call against.
 *
 * A delegated turn WITHOUT an envelope was authorized by Home's dispatch
 * decision itself (operator-forced, approved, or autonomous dispatch) and runs
 * under its admitted Work Item Attempt; its tool ceiling is
 * `supervisedDelegationToolSet`. In enforce mode that run never starts: the
 * dispatch policy holds it for approval and the runtime ingress rejects it
 * with 403 before any tool call. So there is nothing to evaluate per tool and
 * no verdict to record — a "would have denied" row there described an
 * enforcement that cannot happen on that run.
 */
export function delegatedTurnAuthority(input: {
	delegated?: boolean;
	envelope?: DelegationAuthorityEnvelope;
	mode?: DelegationAuthorityMode;
}): DelegatedTurnAuthority | null {
	if (!input.delegated || !input.envelope) return null;
	return { envelope: input.envelope, mode: input.mode ?? "shadow" };
}

/**
 * Authoritative per-call check used at the parent DO's facet proxy boundary
 * for a turn that carries an earned-delegation envelope. Shadow mode records
 * the verdict against the real grant without enforcing it.
 */
export function evaluateDelegatedFacetTool(input: {
	envelope: DelegationAuthorityEnvelope;
	mode?: DelegationAuthorityMode;
	tool: string;
	args: unknown;
}): DelegationAuthorityVerdict {
	const callable =
		input.tool === MCP_CALL_TOOL ? record(input.args)?.callable : undefined;
	const requestedSurface = typeof callable === "string" ? callable : input.tool;
	const deny = (reason: string): DelegationAuthorityVerdict => ({
		allowed: input.mode !== "enforce",
		wouldHaveDenied: true,
		requestedSurface,
		reason,
	});
	const envelope = input.envelope;
	if (envelope.expiresAt) {
		const expiry = Date.parse(envelope.expiresAt);
		if (!Number.isFinite(expiry) || expiry <= Date.now()) {
			return deny(
				`Delegation authority grant ${envelope.grantId} is expired or invalid`,
			);
		}
	}
	if (IDENTITY_BOUND_AITL_TOOLS.has(input.tool)) {
		return { allowed: true, wouldHaveDenied: false, requestedSurface };
	}
	if (input.tool === BROAD_CODE_TOOL) {
		return deny(
			`${BROAD_CODE_TOOL} is unavailable under an earned delegation authority envelope`,
		);
	}
	if (input.tool === MCP_CALL_TOOL) {
		const allowed = namespacedCallables(envelope);
		if (typeof callable === "string" && allowed.has(callable)) {
			return { allowed: true, wouldHaveDenied: false, requestedSurface };
		}
		return deny(
			`MCP callable ${typeof callable === "string" ? `"${callable}"` : "(missing)"} is outside delegated activity ${envelope.activityId}`,
		);
	}
	if (envelope.allowedToolIds.includes(input.tool)) {
		return { allowed: true, wouldHaveDenied: false, requestedSurface };
	}
	return deny(
		`Tool "${input.tool}" is outside delegated activity ${envelope.activityId}`,
	);
}

/**
 * Descriptor-level narrowing gives the facet useful affordances; the proxy
 * check above remains authoritative even if a facet submits an undeclared key.
 */
export function restrictDelegatedToolSet(
	tools: ToolSet,
	envelope?: DelegationAuthorityEnvelope,
	mode: DelegationAuthorityMode = "shadow",
): ToolSet {
	if (mode !== "enforce") return tools;
	if (!envelope) return {};
	const out: ToolSet = {};
	const callableCount = namespacedCallables(envelope).size;
	for (const [name, definition] of Object.entries(tools)) {
		if (IDENTITY_BOUND_AITL_TOOLS.has(name)) {
			out[name] = definition;
			continue;
		}
		if (name === BROAD_CODE_TOOL) continue;
		if (name === MCP_CALL_TOOL) {
			if (callableCount > 0) out[name] = definition;
			continue;
		}
		if (envelope.allowedToolIds.includes(name)) out[name] = definition;
	}
	return out;
}

/**
 * Native identifies the Agent runtime, not a ban on its Computer backend.
 * Keep Computer operations available on delegated turns; exact authority and
 * backend admission still govern execution.
 */
export function computerToolsForDelegatedTurn(
	tools: ToolSet,
	executionSurface?: ExecutionSurface,
): ToolSet {
	if (executionSurface === undefined || executionSurface === "workstation") {
		return tools;
	}
	const managedJobTools = new Set([
		"open_computer",
		"close_computer",
		"exec",
		"read_execution",
		"cancel_execution",
		"code_search",
		"read",
		"write",
		"edit",
		"delete",
		"find",
		"grep",
		"ls",
	]);
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => managedJobTools.has(name)),
	) as ToolSet;
}

/**
 * Home owns the linked Work Item lifecycle below the model: checkout, heartbeat,
 * proof extraction, terminal disposition, and release are reconciler writes.
 * A supervised child therefore receives execution capabilities, not a second
 * operator/control-plane surface. One Code Mode primitive preserves access to
 * every assigned MCP app while forcing discovery + dependent calls into a
 * single provider round; the redundant wrapper tools and unrelated scheduler,
 * memory-maintenance, object-store, and analytics surfaces stay out of context.
 */
export function supervisedDelegationToolSet(
	tools: ToolSet,
	supervised: boolean,
	allowExactMcpCall = false,
): ToolSet {
	if (!supervised) return tools;
	return Object.fromEntries(
		Object.entries(tools).filter(
			([name]) =>
				(allowExactMcpCall && name === MCP_CALL_TOOL) ||
				SUPERVISED_DELEGATION_EXACT_TOOLS.has(name) ||
				name.startsWith("browser_") ||
				name.startsWith("artifact_"),
		),
	) as ToolSet;
}
