/**
 * Kernel — delegation work-order + auto-dispatch decision.
 *
 * The payoff the Tedi Capability Card unlocks: turns the `delegate_tedi` route
 * from recognition ("this belongs to tedi X") into an authorized supervised
 * dispatch (an actual work order + a fail-closed authorization gate).
 *
 * Three pure concerns, no DB writes / no I/O — fully unit-testable:
 *
 *  1. buildDelegationWorkOrder — construct a four-field work order. The fields
 *     follow a simple delegation rule: vague
 *     instructions cause duplicated work, so a good order carries an objective,
 *     an output contract, tool/scope guidance, and boundaries. Managers must
 *     not be overly prescriptive — we emit boundaries + a contract, never
 *     step-by-step instructions. The contract block (success criteria, budget,
 *     soft deadline, fail-closed failure policy — arXiv:2603.18043) is derived
 *     deterministically from routeKind/effortClass, never planner-emitted.
 *
 *  2. decideDelegationDispatch — the authorization gate, fail closed. Mirrors
 *     the workstation-dispatch posture in `dispatch-policy.ts`
 *     (`classifyWorkstationDispatch`): the default when anything is unknown or
 *     unmet is never `auto`.
 *
 *  3. classifyDelegationFailure — typed failure taxonomy (capability | policy
 *     | quality | runtime | transport) with a retryability verdict, replacing
 *     string-only delegation errors wherever this module's outputs are
 *     recorded.
 */

import type {
	ExecutionCapability,
	ExecutionRequirement,
} from "@tedix/api-contract/schemas/execution-evidence";
import type {
	DelegationAuthorityEnvelope,
	DelegationBudget,
	DelegationContract,
	DelegationWorkOrder,
	HomePlanAssignment,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	INTERACTIVE_WORKSTATION_EXECUTION_CAPABILITIES,
	MANAGED_JOB_EXECUTION_CAPABILITIES,
} from "@tedix/api-contract/utils/execution-requirement";
import {
	type DispatchPolicyLayer,
	resolveLayeredDispatchPolicy,
} from "./dispatch-policy";
import {
	verificationFailurePolicyClause,
	verificationRequirementLines,
} from "./delegated-stop";
import type { HomeEffortClass, KernelRouteDecision } from "./route-schema";
import type { TediCapabilityCard } from "./tedi-capabilities";

export type { DelegationWorkOrder };

// ---------------------------------------------------------------------------
// Bounds apply to summaries and guidance, never to the accepted source request.
// ---------------------------------------------------------------------------

const MAX_OBJECTIVE_LEN = 600;
const MAX_OUTPUT_CONTRACT_LEN = 400;
const MAX_LABEL_LEN = 200;
const MAX_GUIDANCE_ITEMS = 8;
const MAX_VERIFY_COMMAND_LEN = 500;

/**
 * Bounded tool guidance for a coding work order. The signal is
 * `requiredProofKind === "code"` — set by `tedix ask --require-code-proof` or
 * derived from an execution requirement that includes `repository_edit` —
 * never a text heuristic over the objective. Inserted ahead of the
 * card-derived scope/app lines so the guidance cap trims those, not these.
 */
const CODING_TOOL_GUIDANCE: readonly string[] = [
	"Batch related shell commands into ONE exec script per step instead of one call per command.",
	"Read production D1 and Worker logs through cloudflare_tedix.execute (read-only) instead of guessing from code.",
	"Verify in your own scoped view: inboxes and lists are scoped to the caller, so reproduce with the operator's exact command and scope.",
	"Write one progress line in your reply text after each step (what ran, what it showed).",
];
const MAX_BOUNDARY_ITEMS = 8;
// Rich handoffs: a bounded slice of recent conversation/route rationale lines
// carried into the work order so context is not lost across the kernel→tedi hop.
// Capped tight so it never balloons the child's first-turn prompt.
const MAX_TRACE_EXCERPTS = 4;
const MAX_ITEM_LEN = 200;

const AVAILABLE_STATES = new Set(["running", "active"]);

const NATIVE_ONLY_SIGNAL =
	/\b(without (?:requesting |using )?(?:a )?workstation|no workstation|native (?:repository |workspace )?tools? only|(?:do not|don't|don’t|never) (?:use|request) (?:a )?workstation)\b/i;

const NEGATED_CAPABILITY_CLAUSE =
	/\b(?:without|do not|don't|must not|never)\b[^.!?;]{0,180}?(?=,\s*(?:then\s+)?(?:run|use|poll|return|perform|execute|read|inspect|check|validate)\b|\s+but\s+|[.!?;]|$)/gi;

const MANAGED_JOB_TOOL = /(?:^|[.:])(?:exec|read_execution|cancel_execution)$/;

const CAPABILITY_SIGNALS: ReadonlyArray<{
	capability: ExecutionCapability;
	pattern: RegExp;
}> = [
	{
		capability: "dependency_install",
		pattern: /\b(?:install|update) (?:dependencies|packages?|toolchain)\b/i,
	},
	{ capability: "typecheck", pattern: /\b(?:type-?check|tsc)\b/i },
	{ capability: "tests", pattern: /\b(?:test suite|tests?|vitest)\b/i },
	{ capability: "lint", pattern: /\b(?:lint|biome)\b/i },
	{
		capability: "build",
		// "Build a GTM plan" is ordinary tedi work, not a software build job.
		pattern:
			/\b(?:build|compile|bundle)\s+(?:(?:the|a|an|our|my)\s+)?(?:app|application|package|project|repo|repository|code|worker|site|website|frontend|backend|client|server|binary|assets?)\b|\b(?:run|execute)\s+(?:(?:the|a|an)\s+)?(?:production\s+)?build\b|\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build\b/i,
	},
	{ capability: "deploy", pattern: /\b(?:deploy|release|ship)\b/i },
	{ capability: "notebook", pattern: /\b(?:notebook|jupyter)\b/i },
	{
		capability: "data",
		pattern:
			/\b(?:dataset|data processing|data transformation|statistics|statistical analysis|etl)\b/i,
	},
	{
		capability: "browser_session",
		pattern: /\b(?:browser session|chrome devtools|playwright)\b/i,
	},
	{
		capability: "dev_server",
		pattern: /\b(?:dev server|localhost|preview server)\b/i,
	},
	{
		capability: "git_network",
		pattern: /\b(?:git (?:push|pull|fetch)|rebase|bisect|merge conflict)\b/i,
	},
	{
		capability: "process",
		pattern:
			/\b(?:shell|bash|command line|(?:in|open|use) (?:the )?terminal|terminal (?:command|session|shell)|start (?:a )?process|docker|(?:run|invoke|delegate to) (?:codex|claude code))\b/i,
	},
	{
		capability: "filesystem_transform",
		pattern:
			/\b(?:workspace edit|multi-file|replace in files|transform files)\b/i,
	},
	{
		capability: "repository_edit",
		pattern: /\b(?:edit|change|implement|fix|refactor|documentation|docs?)\b/i,
	},
	{
		capability: "repository_read",
		pattern:
			/\b(?:repository|repo|source code|codebase|readme(?:\.md)?|package\.json)\b|\b(?:read|review|inspect|explain|summari[sz]e)\b[^.!?;]{0,60}\b(?:files?|code|implementation)\b/i,
	},
	{
		capability: "live_verify",
		pattern: /\b(?:live verify|production proof|validate live)\b/i,
	},
];

function classifyCapabilities(
	content: string,
	route: KernelRouteDecision,
): ExecutionCapability[] {
	const capabilities = new Set<ExecutionCapability>();
	const requestedContent = content.replace(NEGATED_CAPABILITY_CLAUSE, " ");
	for (const signal of CAPABILITY_SIGNALS) {
		if (signal.pattern.test(requestedContent))
			capabilities.add(signal.capability);
	}
	for (const toolId of route.plannedToolIds) {
		const value = toolId.toLowerCase();
		if (value.includes("browser")) capabilities.add("browser_session");
		if (value.includes("deploy")) capabilities.add("deploy");
		if (MANAGED_JOB_TOOL.test(value)) capabilities.add("data");
		if (/(?:^|[.:])(?:open_computer|close_computer)$/.test(value))
			capabilities.add("process");
	}
	return [...capabilities];
}

/**
 * Parse request/tool intent into typed capabilities, then select a surface from
 * a capability lattice. Detection never chooses the surface directly:
 * interactive OS capabilities dominate managed jobs, which dominate native
 * repository work.
 */
export function deriveExecutionRequirement(
	content: string,
	route: KernelRouteDecision,
): ExecutionRequirement {
	const requiredCapabilities = classifyCapabilities(content, route);
	const nativeOnly = NATIVE_ONLY_SIGNAL.test(content);
	const prohibitedSurfaces: ExecutionRequirement["prohibitedSurfaces"] =
		nativeOnly ? ["managed_job", "workstation"] : [];
	const nativeOnlyConflict =
		nativeOnly &&
		requiredCapabilities.some(
			(capability) =>
				MANAGED_JOB_EXECUTION_CAPABILITIES.has(capability) ||
				INTERACTIVE_WORKSTATION_EXECUTION_CAPABILITIES.has(capability),
		);
	if (nativeOnly) {
		return {
			surface: "native",
			requiredCapabilities,
			reason: nativeOnlyConflict
				? "the requested capabilities cannot be satisfied while the operator prohibits managed-job and workstation surfaces"
				: "the operator explicitly requested the Agent-runtime tool surface",
			fallbackSurface: null,
			prohibitedSurfaces,
			satisfiable: !nativeOnlyConflict,
		};
	}
	if (
		requiredCapabilities.some((capability) =>
			INTERACTIVE_WORKSTATION_EXECUTION_CAPABILITIES.has(capability),
		)
	) {
		return {
			surface: "workstation",
			requiredCapabilities,
			reason:
				"the typed capability set requires an interactive OS, process, browser, dev-server, or Git-network session",
			fallbackSurface: null,
			prohibitedSurfaces,
			satisfiable: true,
		};
	}
	if (
		requiredCapabilities.some((capability) =>
			MANAGED_JOB_EXECUTION_CAPABILITIES.has(capability),
		)
	) {
		return {
			surface: "managed_job",
			requiredCapabilities,
			reason:
				"the typed capability set requires a bounded durable job with a terminal receipt",
			fallbackSurface: "workstation",
			prohibitedSurfaces,
			satisfiable: true,
		};
	}
	if (route.effortClass === "embodied") {
		return {
			surface: "workstation",
			requiredCapabilities,
			reason:
				"the planner requested an embodied budget and no bounded managed-job path was identified",
			fallbackSurface: null,
			prohibitedSurfaces,
			satisfiable: true,
		};
	}
	return {
		surface: "native",
		requiredCapabilities,
		reason: "the typed capability set fits Agent-runtime tools",
		fallbackSurface: "workstation",
		prohibitedSurfaces,
		satisfiable: true,
	};
}

function requiresWorkstation(requirement: ExecutionRequirement): boolean {
	return requirement.surface === "workstation";
}

function requiresWorkstationLease(requirement: ExecutionRequirement): boolean {
	// A managed job has its own bounded execution receipt; only the interactive
	// workstation surface needs a workstation lease on the target tedi.
	return requirement.surface === "workstation";
}

function clamp(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function boundedList(items: string[], maxItems: number): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of items) {
		const item = clamp(raw, MAX_ITEM_LEN);
		if (!item || seen.has(item)) continue;
		seen.add(item);
		out.push(item);
		if (out.length >= maxItems) break;
	}
	return out;
}

function stringField(
	record: Record<string, unknown> | null | undefined,
	key: string,
): string | null {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringListField(
	record: Record<string, unknown> | null | undefined,
	key: string,
): string[] {
	const value = record?.[key];
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is string =>
			typeof item === "string" && item.trim().length > 0,
	);
}

function recordField(
	record: Record<string, unknown> | null | undefined,
	key: string,
): Record<string, unknown> | null {
	const value = record?.[key];
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

// ---------------------------------------------------------------------------
// Delegation contract (arXiv:2603.18043) — explicit success criteria, budget,
// deadline, and failure policy on every hand-off. Derived DETERMINISTICALLY
// here in dispatch code from routeKind/effortClass: the planner LLM never
// emits contract fields, so the contract cannot drift with planner phrasing.
// ---------------------------------------------------------------------------

/**
 * Per-effort-class caps. `maxToolCalls` enforces the effort class the planner
 * already committed to (route-schema.ts: effort is "a routing output, not a
 * suggestion"); `embodied` matches the child loop's stepCountIs(24) ceiling.
 * Deadlines are soft wall-clock hints — guidance in the work-order text plus
 * an advisory `deadlineMs` cap on the structured budget, never a hard kill.
 */
const EFFORT_CONTRACT_CAPS: Record<
	HomeEffortClass,
	{ maxToolCalls: number; deadlineMs: number; deadlineLabel: string }
> = {
	single_read: {
		maxToolCalls: 3,
		deadlineMs: 120_000,
		deadlineLabel: "~2 minutes",
	},
	multi_hop_read: {
		maxToolCalls: 8,
		deadlineMs: 300_000,
		deadlineLabel: "~5 minutes",
	},
	fan_out: {
		maxToolCalls: 16,
		deadlineMs: 600_000,
		deadlineLabel: "~10 minutes",
	},
	embodied: {
		maxToolCalls: 24,
		deadlineMs: 1_200_000,
		deadlineLabel: "~20 minutes",
	},
};

// A null effort class (planner: "genuinely inapplicable") still needs a cap —
// take the middle read budget, never the widest one.
const DEFAULT_CONTRACT_EFFORT_CLASS: HomeEffortClass = "multi_hop_read";

export const DELEGATION_FAILURE_POLICY =
	'fail_closed — if you cannot meet the criteria, say so explicitly and begin the answer with "Partial result:"';

/**
 * Derive the contract + structured budget for a delegation from the route
 * alone. Success criteria are generic and evidence-shaped (read work proves
 * the facts, write-shaped work proves the mutation) — never per-domain, so
 * they stay judgeable by the deterministic grader without domain knowledge.
 */
export function deriveDelegationContract(route: KernelRouteDecision): {
	contract: DelegationContract;
	budget: DelegationBudget;
} {
	const caps =
		EFFORT_CONTRACT_CAPS[route.effortClass ?? DEFAULT_CONTRACT_EFFORT_CLASS];
	// Write-shaped work (an embodied surface, or an explicit write route) is
	// judged on proof of the mutation; read work on proof of the facts read.
	const writeShaped =
		route.effortClass === "embodied" ||
		route.routeKind === "propose_tool_write";
	const successCriteria = [
		writeShaped
			? "every claimed action cites the mutating tool call result that performed it"
			: "the answer states the specific facts read, citing the tool calls that produced them",
		...(route.effortClass === "fan_out"
			? [
					"every branch is accounted for in the reply, including branches that returned nothing",
				]
			: []),
		"anything the output contract asks for that is not delivered is named explicitly as missing",
	];
	return {
		contract: {
			successCriteria,
			budgetHint: `about ${caps.maxToolCalls} tool calls (soft cap) — if the task genuinely needs materially more, stop and report progress instead of silently overrunning`,
			deadlineHint: `${caps.deadlineLabel} of wall clock; if you will exceed it, return what you have as a result labeled partial`,
			failurePolicy: DELEGATION_FAILURE_POLICY,
		},
		budget: { maxToolCalls: caps.maxToolCalls, deadlineMs: caps.deadlineMs },
	};
}

export function renderDelegationWorkOrderMessage(input: {
	fallbackContent: string;
	fallbackWorkOrderId: string;
	label?: string;
	workOrder: Record<string, unknown> | null;
}): string {
	const workOrder = input.workOrder;
	const sourceContent =
		stringField(workOrder, "sourceContent") ?? input.fallbackContent.trim();
	const workOrderId = stringField(workOrder, "id") ?? input.fallbackWorkOrderId;
	const objective =
		stringField(workOrder, "objective") ??
		`Deliver on this request from the Home operator: "${sourceContent}"`;
	const outputContract =
		stringField(workOrder, "outputContract") ??
		"Return a concise result with the evidence (sources/tool outputs) that supports it.";
	const workItemId = stringField(workOrder, "workItemId");
	const targetTediId = stringField(workOrder, "targetTediId");
	const targetTediLabel = stringField(workOrder, "targetTediLabel");
	const toolGuidance = stringListField(workOrder, "toolGuidance");
	const boundaries = stringListField(workOrder, "boundaries");
	// Rich handoffs: recent trace excerpts (conversation turns / route
	// rationale) ride as an extra `traceExcerpts` JSON key on the work order, read
	// defensively here. Absent ⇒ the block is omitted (today's behavior).
	const traceExcerpts = stringListField(workOrder, "traceExcerpts");
	// Project validation contract: set only for repository-backed delegations (see
	// buildDelegationWorkOrder). Read defensively; absent means no block and every
	// non-project delegation renders exactly as before.
	const projectValidation = workOrder?.projectValidation === true;
	// Delegation contract: rides as an extra `contract` JSON key (same pattern as
	// traceExcerpts — no api-contract schema field). Read defensively; a
	// historical work order without it renders byte-identically to before.
	const contract = recordField(workOrder, "contract");
	const successCriteria = stringListField(contract, "successCriteria");
	const budgetHint = stringField(contract, "budgetHint");
	const deadlineHint = stringField(contract, "deadlineHint");
	const failurePolicy = stringField(contract, "failurePolicy");
	// Verify command: an operator-supplied exact command the child must run and
	// quote before it reports (`verifyCommand`, api-contract field). Read
	// defensively; absent renders byte-identically to before.
	const verifyCommand = stringField(workOrder, "verifyCommand");
	// Output-schema task mode (opt-in Tedix result-contract pattern): rides as an
	// extra `outputSchema` JSON key
	// (same pattern as contract/traceExcerpts — no api-contract schema field).
	// Read defensively; a work order without it renders byte-identically to
	// before this feature existed.
	const outputSchema = recordField(workOrder, "outputSchema");
	const label = input.label ?? "DELEGATION";

	const lines: string[] = [
		`[HOME ${label} WORK ORDER ${workOrderId}]`,
		...(targetTediId
			? [
					`Assigned tedi: ${targetTediLabel ? `${targetTediLabel} (` : ""}${targetTediId}${targetTediLabel ? ")" : ""}. Use this exact tedi id for tedi-scoped reads; do not rediscover your own identity.`,
				]
			: []),
		`Objective: ${objective}`,
		`Output contract: ${outputContract}`,
		// Honesty clause: a delegated tedi must not claim a side effect that only
		// a discovery call preceded, or the kernel repeats the claim as fact.
		"Honesty contract: only claim an action was performed, created, or scheduled if a tool call in THIS turn actually did it — cite that call's result. Discovery/search does not count as doing. If something remains undone, say exactly what and why.",
	];
	// Contract block — each line independently conditional so a partially-shaped
	// contract still renders what it has (and no contract renders nothing).
	if (successCriteria.length > 0) {
		lines.push("Success criteria:");
		for (const item of successCriteria) lines.push(`- ${item}`);
	}
	if (budgetHint) lines.push(`Budget: ${budgetHint}`);
	if (deadlineHint) lines.push(`Deadline (soft): ${deadlineHint}`);
	if (failurePolicy) lines.push(`Failure policy: ${failurePolicy}`);
	if (verifyCommand) lines.push(...verificationRequirementLines(verifyCommand));
	if (workItemId) lines.push(`Work Item: ${workItemId}`);
	if (toolGuidance.length > 0) {
		lines.push("Tool guidance:");
		for (const item of toolGuidance) lines.push(`- ${item}`);
	}
	if (boundaries.length > 0) {
		lines.push("Boundaries:");
		for (const item of boundaries) lines.push(`- ${item}`);
	}
	if (traceExcerpts.length > 0) {
		lines.push("Recent context:");
		for (const item of traceExcerpts) lines.push(`- ${item}`);
	}
	if (projectValidation) {
		lines.push(
			"Project validation contract:",
			"- Before changing code, confirm the workstation deps are ready: require bootstrap.depsReady:true. If false, follow bootstrap.nextAction using bootstrap.installProcessId, then poll readiness until depsReady:true before running tests.",
			"- Run focused validation from the repo root with the workspace-filter form: bun run --filter @tedix/<pkg> test:run -- <path> (vitest packages accept the `-- <path>` filter; a few packages run a fixed test list, so run that package's tests directly there). There is NO root test:run script; bare `bun run test:run` from the repo root will fail.",
			"- Only commit/push after that validation is green.",
		);
	}
	if (outputSchema) {
		lines.push(
			"Output contract (structured):",
			"In addition to your prose answer (not instead of it), include a fenced json code block in your final reply whose contents satisfy this exact JSON Schema:",
			"```json",
			JSON.stringify(outputSchema, null, 2),
			"```",
		);
	}
	lines.push(
		"Source request:",
		sourceContent,
		`[END HOME ${label} WORK ORDER]`,
		"",
		"Complete the task described in this work order now, then reply with the result that satisfies the output contract.",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 1. Work order
// ---------------------------------------------------------------------------

/**
 * Construct the four-field work order from the route decision + the user's
 * message + the target's capability card.
 *
 * - objective:      concise statement of what to accomplish (the route
 *                   rationale steers it; falls back to the user's ask). No
 *                   step-by-step — that is Cognition's over-prescription trap.
 * - outputContract: what to hand back (the route's answer/evidence shape if
 *                   present, else a generic "summary + evidence" contract).
 * - toolGuidance:   derived from the card's actual scopeGroups/apps — steer
 *                   the worker to the scopes it genuinely holds.
 * - boundaries:     a no-fabrication clause, "do not exceed assigned scopes",
 *                   and any approval note.
 */
export function buildDelegationWorkOrder(input: {
	route: KernelRouteDecision;
	card: TediCapabilityCard | null;
	userContent: string;
	/**
	 * Optional caller-supplied bounded-authority caps for this delegation.
	 * Caller caps are explicit authority and win per-field; the effort-class
	 * caps derived by `deriveDelegationContract` fill only the gaps, so every
	 * work order carries a budget the dispatch path threads into the child run
	 * metadata. All caps stay advisory to the executor/policy layer.
	 */
	budget?: DelegationBudget;
	/**
	 * Rich handoffs: optional bounded trace excerpts (e.g. the last 2-3
	 * conversation-history lines + the route rationale) the caller supplies so the
	 * delegated child does not lose context across the kernel→tedi hop. Clamped,
	 * deduped, and capped at MAX_TRACE_EXCERPTS here.
	 */
	traceExcerpts?: string[];
	executionRequirement?: ExecutionRequirement;
	/** Runtime environment used to bind a matching earned-authority envelope. */
	executionEnvironment?: string;
	/** Shadow preserves legacy dispatch without a grant; enforce fails closed. */
	authorityMode?: EarnedDelegationEnforcementMode;
	/**
	 * Output-schema task mode (opt-in Tedix result-contract pattern): an
	 * optional, caller-supplied JSON Schema the
	 * child's final answer must satisfy. Caller-supplied bounded authority —
	 * exactly like `budget` above — not currently populated by the live
	 * auto-route caller. This is a deliberate deferral: the kernel
	 * route-planner LLM (`KernelRouteDecisionSchema` / `route-planner.ts`)
	 * does not emit this field in this batch, since wiring it there touches
	 * the live Azure-strict structured-output route-decision contract and
	 * needs eval verification not built here.
	 */
	outputSchema?: Record<string, unknown> | null;
	/**
	 * Exact command the child must run in its own environment and quote under
	 * `Verification output:` before it reports; Home treats a success report
	 * without that section as partial. Clamped to the schema bound.
	 */
	verifyCommand?: string | null;
	/**
	 * Proof kind the tracking Work Item will demand. `"code"` is the coding
	 * signal for the coding tool guidance; it also follows from an execution
	 * requirement that includes `repository_edit`.
	 */
	requiredProofKind?: "code" | "terminal_execution" | null;
}): DelegationWorkOrder {
	const { route, card, userContent, budget, traceExcerpts, outputSchema } =
		input;
	const verifyCommand = input.verifyCommand?.trim()
		? clamp(input.verifyCommand.trim(), MAX_VERIFY_COMMAND_LEN)
		: null;
	const executionRequirement =
		input.executionRequirement ??
		deriveExecutionRequirement(userContent, route);
	const authorityEnvelope = card
		? selectDelegationAuthorityEnvelope({
				card,
				route,
				executionRequirement,
				environment: input.executionEnvironment ?? "production",
			})
		: null;

	const targetTediId = (route.targetTediId ?? card?.tediId ?? "").trim();
	const targetTediLabel = clamp(
		route.targetTediLabel ?? card?.name ?? card?.slug ?? "the target tedi",
		MAX_LABEL_LEN,
	);

	const sourceContent = userContent ?? "";

	// Objective: prefer the route rationale (the kernel's grounded read of the
	// ask), but anchor it to the user's request so the worker has the verbatim
	// intent. Deliberately a goal statement, not a procedure.
	const rationale = (route.rationale ?? "").trim();
	const objective = clamp(
		rationale
			? `Deliver on this request for the operator: "${sourceContent}". Context for why this is yours: ${rationale}`
			: `Deliver on this request for the operator: "${sourceContent}".`,
		MAX_OBJECTIVE_LEN,
	);

	// Output contract: prefer the route's stated answer/evidence expectation,
	// otherwise a generic, contract-shaped (not procedural) expectation.
	const answer = (route.answer ?? "").trim();
	const evidence = (route.evidenceExpectation ?? "").trim();
	const contractSeed = evidence || answer;
	const outputContract = clamp(
		contractSeed
			? `Return: ${contractSeed}`
			: "Return a concise result with the evidence (sources/tool outputs) that supports it.",
		MAX_OUTPUT_CONTRACT_LEN,
	);

	// Tool guidance: steer the worker to its actual capabilities. Scope groups
	// are the authorization surface; apps are the product surface.
	const guidanceSeeds: string[] = [];
	// Native work stays native until a concrete runtime ceiling returns a typed
	// workstation fallback. Do not turn lease warmth into a second routing
	// authority.
	const codingTask =
		input.requiredProofKind === "code" ||
		executionRequirement.requiredCapabilities.includes("repository_edit");
	const checkoutCodingTask =
		codingTask &&
		!executionRequirement.prohibitedSurfaces.includes("workstation");
	const workstationUnusable =
		card?.hasWarmWorkstationLease !== true || card?.environmentReady !== true;
	if (
		executionRequirement.surface === "native" &&
		!checkoutCodingTask &&
		card?.hasRepository === true &&
		executionRequirement.requiredCapabilities.some(
			(capability) =>
				capability === "repository_read" || capability === "repository_edit",
		) &&
		workstationUnusable
	) {
		guidanceSeeds.push(
			"Use the Worker-native repository tools for this bounded task; workstation readiness does not change the selected surface.",
			"Native path: clone_repo with exact paths; oversized repos auto-fall back to repo_load without .git. Edit with workspace tools, validate_typescript, then land through approval-gated repo_commit.",
		);
		if (executionRequirement.fallbackSurface === "workstation")
			guidanceSeeds.push(
				"A successful repo_load_fallback stays native. Escalate only for full checkout/Git CLI, installs, builds, tests, processes, or full validation.",
			);
	}
	if (executionRequirement.surface === "managed_job") {
		guidanceSeeds.push(
			"Open the task computer with open_computer, then execute validation with exec. If it returns a running executionId, yield for the durable completion to resume this run before claiming success.",
		);
	}
	if (checkoutCodingTask)
		guidanceSeeds.push(
			"Start with open_computer({ repository: true }); use native files and exec for Git, validation, commit and push in its returned checkout.",
		);
	if (codingTask) guidanceSeeds.push(...CODING_TOOL_GUIDANCE);
	if (card) {
		for (const group of card.scopeGroups) {
			guidanceSeeds.push(`Use your "${group}" scope group for this work.`);
		}
		for (const app of card.apps) {
			guidanceSeeds.push(`The "${app}" app is available to you.`);
		}
		if (card.skills.length > 0) {
			guidanceSeeds.push(
				`Reuse your existing skills where they fit: ${card.skills
					.slice(0, 5)
					.join(", ")}.`,
			);
		}
	}
	if (guidanceSeeds.length === 0) {
		guidanceSeeds.push(
			"Use only the tools and scopes already granted to you; do not request new access.",
		);
	}
	const toolGuidance = boundedList(guidanceSeeds, MAX_GUIDANCE_ITEMS);

	// Boundaries: fixed safety clauses + any approval note. Boundaries, not
	// steps — we tell the worker its limits and let it choose the path.
	const boundarySeeds: string[] = [
		"Do not exceed your assigned scopes; if the task needs access you lack, stop and report it.",
		"Do not fabricate data — every claim must be backed by a tool result or source.",
		"Stay within the stated objective; do not take unrelated or destructive actions.",
	];
	if (codingTask) {
		boundarySeeds.push(
			"Never weaken, skip, delete, or narrow a test, assertion, or validation gate to make a failure pass. Never edit CI configuration or the script defining a verification command to make it pass. Fix the cause; if the check itself is wrong, stop and report the exact check instead of changing it in this turn.",
		);
	}
	if (card?.requiresApproval) {
		boundarySeeds.push(
			"This tedi requires approval for actions — pause for sign-off before any write or external side effect.",
		);
	}
	const boundaries = boundedList(boundarySeeds, MAX_BOUNDARY_ITEMS);

	// Bound the caller-supplied trace excerpts the same way as every other list
	// so they never balloon the child's first-turn prompt.
	const boundedTraceExcerpts = boundedList(
		traceExcerpts ?? [],
		MAX_TRACE_EXCERPTS,
	);

	// "Workstations over bodies": a router-planned delegate_tedi to an embodied
	// target carrying a workstation lease or configured repository is a WORKSTATION
	// attachment — the operator should see a workstation, not a body
	// (docs/decisions/workstations-over-bodies.md). A non-embodied
	// delegation stays a plain tedi.delegate. Reuses this one builder; only the
	// kind differs; authority and capability are carried by the formal contract.
	//
	// The kind is a function of (instruction needs × target capability), not of
	// capability alone. A permanently-embodied tedi (e.g. a CTO carrying a coding
	// repo, which marks the isolate `embodied`) must not mint a workstation.attach
	// for a read-only/conversational ask like "introduce yourself": attaching a
	// (likely cold) workstation for purely cognitive work is the live
	// boot_unavailable failure. Escalate to workstation.attach only when the route
	// actually needs the embodied surface (shell/repo/process/tool-write work);
	// otherwise degrade to a bodiless tedi.delegate even on an embodied target.
	const isWorkstation =
		card?.embodied === true && requiresWorkstation(executionRequirement);

	// Project validation contract: a workstation attachment whose target carries a
	// configured repository. Narrower than `isWorkstation` (which also covers
	// browser/shell embodied work via a warm lease alone), so the deps-gate +
	// validation-command guidance is injected only for repository-backed work.
	const projectValidation =
		(isWorkstation || executionRequirement.surface === "managed_job") &&
		card?.hasRepository === true;

	// Delegation contract: derived deterministically from the route (the planner
	// contributes only routeKind/effortClass, never contract text). Caller caps
	// override the derived per-field defaults; derived caps fill the gaps.
	const derived = deriveDelegationContract(route);
	const contract: DelegationContract = verifyCommand
		? {
				...derived.contract,
				failurePolicy: `${derived.contract.failurePolicy}; ${verificationFailurePolicyClause()}`,
			}
		: derived.contract;
	const mergedBudget: DelegationBudget = {
		...derived.budget,
		...(budget?.maxToolCalls != null
			? { maxToolCalls: budget.maxToolCalls }
			: {}),
		...(budget?.maxTokens != null ? { maxTokens: budget.maxTokens } : {}),
		...(budget?.maxUsd != null ? { maxUsd: budget.maxUsd } : {}),
		...(budget?.deadlineMs != null ? { deadlineMs: budget.deadlineMs } : {}),
	};

	return {
		kind: isWorkstation ? "workstation.attach" : "tedi.delegate",
		objective,
		outputContract,
		status: "draft",
		toolGuidance,
		boundaries,
		executionRequirement,
		sourceContent,
		targetTediId,
		targetTediLabel,
		// Structured caps for the dispatch path (auto-dispatch threads this into
		// the child run metadata as delegationBudget/delegationDeadlineMs). Always
		// present now: derived effort-class caps under any caller-supplied caps.
		budget: mergedBudget,
		authorityMode: input.authorityMode ?? "shadow",
		...(authorityEnvelope ? { authorityEnvelope } : {}),
		contract,
		traceExcerpts: boundedTraceExcerpts,
		projectValidation,
		outputSchema: outputSchema ?? null,
		...(verifyCommand ? { verifyCommand } : {}),
	};
}

// ---------------------------------------------------------------------------
// 2. Dispatch decision (fail closed)
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on delegation chain depth (bounded depth).
 * LangGraph's supervisor-vs-swarm result shows cross-agent error compounds past
 * ~8–10 handoffs, so a chain deeper than this is a runaway, not decomposition.
 * The kernel bounds the chain; breadth (a wider plan) is the correct answer to
 * "more work", not a deeper chain.
 */
export const MAX_DELEGATION_DEPTH = 10;

/**
 * Mutation signal in an assignment objective. Verb-stem matched (case-insensitive)
 * so a plan branch that CREATES/EDITS/DELETES/DEPLOYS/etc. state is caught
 * regardless of tense. Deliberately biased toward recall: over-matching a read
 * as write only costs one serialized fan-out (correctness-safe); a miss is a
 * cross-facet write race. Mechanical/policy only — no LLM verdict.
 */
const WRITE_BEARING_OBJECTIVE_SIGNAL =
	/\b(?:creat|implement|refactor|migrat|deploy|commit|provision|configur|publish|writ|delet|modif|upsert|regist|persist|renam|fix|edit|updat|remov|push|patch|record|insert|apply|applies|mutat|ship|save|draft|generat|build|send|add)\w*/i;

/**
 * Write-race classifier — does a plan assignment mutate shared state (so two
 * of them racing in a parallel fan-out is a cross-facet write race)? Keyed off
 * the planner's own route classification plus a mutation-verb signal on the
 * objective; no LLM verdict. A `workstation` route runs a shell/process and a
 * `workflow` route runs a workflow — both write by construction. Otherwise the
 * objective's mutation signal decides.
 */
export function assignmentIsWriteBearing(input: {
	routeKind: HomePlanAssignment["routeKind"];
	objective: string;
}): boolean {
	if (input.routeKind === "workstation" || input.routeKind === "workflow") {
		return true;
	}
	return WRITE_BEARING_OBJECTIVE_SIGNAL.test(input.objective);
}

/**
 * Fleet fan-out = independent-reads-only (docs/decisions/agentic-kernel-
 * architecture.md). Decide whether a multi-tedi plan dispatch must be serialized
 * (single-threaded through the kernel) rather than fanned out in parallel.
 * Parallel fan-out is Anthropic's proven orchestrator-worker envelope for
 * breadth-first independent work.
 *
 * A fan-out serializes when it is write-bearing — 2+ members mutate shared
 * work-item/ledger/facet state, so firing them in parallel is a cross-facet
 * write race ("no cross-facet write races"). A
 * read-only fan-out (writeBearingCount ≤ 1) keeps the parallel path.
 *
 * Cross-tedi dependency ordering is deliberately not decided here. The cross-tedi
 * blocker gate in approvePlanAssignments already defers any dependent whose
 * blocker work item is non-terminal (work_item_relations `blocks`,
 * completion-gated) — strictly stronger than enqueue-order serialization, which
 * only orders the dispatch call and never waits for the blocker to finish.
 * Keying serialization on `dependencyEdges` was therefore redundant: a deferred
 * dependent never dispatches in the same turn, so the only assignments left to
 * serialize are mutually independent roots (no edge among them), which need
 * ordering solely when they are write-bearing — the case handled above.
 *
 * Mechanical/policy only, no LLM verdict.
 */
export function shouldSerializeFanOut(input: {
	dispatch: boolean;
	assignmentCount: number;
	writeBearingCount?: number;
}): boolean {
	if (!input.dispatch || input.assignmentCount <= 1) return false;
	return (input.writeBearingCount ?? 0) > 1;
}

/** A blocker→dependent edge between two Work Items (from finishes before to). */
export interface FanOutBlockerEdge {
	fromWorkItemId: string;
	toWorkItemId: string;
}

/**
 * Synthesize the blocker edges that actually single-thread a serialized
 * fan-out. `shouldSerializeFanOut` only decides that a write-bearing multi-tedi
 * fan-out must serialize; awaiting the async delegate enqueue does not serialize
 * anything (the await resolves once the child turn is queued in the child's DO,
 * not when its work runs — every child still executes concurrently in its own
 * runtime, so the writes still race). Real serialization has to ride the kernel's
 * existing terminal-event supervision: the cross-tedi blocker gate defers a
 * dispatch whose Work Item has a non-terminal blocker, and the unblock watcher
 * auto-dispatches it once every blocker is terminal (completion-gated — "strictly
 * stronger than enqueue-order serialization", the exact reasoning that retired
 * the dependency-edge branch). So we chain the whole fan-out into a single line
 * of blocker edges and let that proven machinery advance it one child at a time —
 * no inline waiting, thin-kernel invariant preserved.
 *
 * The chain is a linear extension of the plan's existing dependency dag: we
 * topologically order the members (blocker before dependent, stable by the
 * supplied order for ties) and add a `from→to` edge for each consecutive pair
 * that is not already directly connected. Because every synthetic edge points
 * forward in a topo order and every existing edge does too, the combined graph
 * stays acyclic — no synthetic edge can introduce a cycle (which would deadlock
 * the fan-out forever). Fail-safe: if the existing edges already contain a cycle
 * we cannot order, return no synthetic edges rather than risk deepening it.
 *
 * Pure/mechanical — no DB, no LLM verdict. The caller writes the returned edges
 * via `addWorkItemRelation` (idempotent) exactly like the inferred plan edges.
 */
export function serializedFanOutChainEdges(input: {
	/** Fan-out member Work Item ids, in plan/creation order (tie-break order). */
	orderedWorkItemIds: string[];
	/** Existing blocker→dependent edges among those items (from = blocker). */
	existingEdges: readonly FanOutBlockerEdge[];
}): FanOutBlockerEdge[] {
	const nodes = input.orderedWorkItemIds;
	if (nodes.length < 2) return [];
	const index = new Map<string, number>();
	nodes.forEach((id, i) => {
		if (!index.has(id)) index.set(id, i);
	});
	// Adjacency + indegree over the member set only (ignore dangling endpoints).
	const dependents = new Map<string, Set<string>>();
	const indegree = new Map<string, number>();
	for (const id of nodes) {
		dependents.set(id, new Set());
		indegree.set(id, 0);
	}
	const directEdge = new Set<string>();
	for (const edge of input.existingEdges) {
		if (!index.has(edge.fromWorkItemId) || !index.has(edge.toWorkItemId)) {
			continue;
		}
		if (edge.fromWorkItemId === edge.toWorkItemId) continue;
		const key = `${edge.fromWorkItemId} ${edge.toWorkItemId}`;
		if (directEdge.has(key)) continue;
		directEdge.add(key);
		dependents.get(edge.fromWorkItemId)?.add(edge.toWorkItemId);
		indegree.set(edge.toWorkItemId, (indegree.get(edge.toWorkItemId) ?? 0) + 1);
	}
	// Kahn's algorithm, ready set kept in the supplied order for determinism.
	const ordered: string[] = [];
	const ready = nodes.filter((id) => (indegree.get(id) ?? 0) === 0);
	while (ready.length > 0) {
		ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
		const id = ready.shift();
		if (id === undefined) break;
		ordered.push(id);
		for (const dep of dependents.get(id) ?? []) {
			const next = (indegree.get(dep) ?? 0) - 1;
			indegree.set(dep, next);
			if (next === 0) ready.push(dep);
		}
	}
	// Cycle in the existing edges — cannot safely serialize; add nothing.
	if (ordered.length !== nodes.length) return [];
	const synthetic: FanOutBlockerEdge[] = [];
	for (let i = 1; i < ordered.length; i++) {
		const from = ordered[i - 1];
		const to = ordered[i];
		if (from === undefined || to === undefined) continue;
		if (directEdge.has(`${from} ${to}`)) continue;
		synthetic.push({ fromWorkItemId: from, toWorkItemId: to });
	}
	return synthetic;
}

export interface DispatchDecision {
	canAutoDispatch: boolean;
	reason: string;
	mode: "auto" | "needs_approval" | "blocked" | "boot_unavailable";
	/**
	 * Who may decide a `needs_approval` hold. `agent` holds (earned-delegation
	 * ceilings, a target that requires approval, a high-risk route) route to the
	 * organization's designated approval tedi through the Work approval plane
	 * when one is configured and valid; `human` holds stay with the operator:
	 * an explicit operator hold, a layered policy deny, a speaker without
	 * approval authority (an agent approving would escalate that authority), and
	 * capability/availability holds, which are not approval questions. Absent
	 * on every other mode.
	 */
	approvalRoute?: DelegationApprovalRoute;
	/**
	 * Typed failure classification — present only for the hard-fail modes
	 * (`blocked`, `boot_unavailable`), so recorders persist a category instead
	 * of a bare string. `needs_approval` is a pending approval decision, not a
	 * failure, and stays unclassified.
	 */
	failure?: DelegationFailureClassification;
	/**
	 * Shadow-mode rollout signal: the target had no task-scoped grant matching
	 * this route, and `shadow` let the dispatch proceed anyway.
	 *
	 * It is a flag rather than a prefix on `reason` because `reason` is what an
	 * operator reads on the approval card. Smuggling a diagnostic through it
	 * meant every surface had to strip the marker back out, and the one that
	 * did not — Tedix OS — showed customers
	 * "earned-delegation-shadow: no matching task-scoped grant; target not
	 * active". Structured is also what a rollout actually wants to count.
	 */
	earnedDelegationShadow?: true;
}

export type EarnedDelegationEnforcementMode = "shadow" | "enforce";

export type DelegationApprovalRoute = "agent" | "human";

const ROUTE_RISK_RANK: Record<string, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

function constraintStrings(
	constraints: Record<string, unknown>,
	key: string,
): string[] | null {
	const value = constraints[key];
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		return null;
	}
	return value as string[];
}

/**
 * Match concrete delegated work against one independently applied grant. Every
 * material dimension is fail-closed: action, environment, task family, route
 * risk, requested tool, spend posture, and recognized constraints.
 */
export function selectDelegationAuthorityEnvelope(input: {
	card: TediCapabilityCard;
	route: KernelRouteDecision;
	executionRequirement?: ExecutionRequirement;
	environment: string;
}): DelegationAuthorityEnvelope | null {
	const action = "kernel.receive_delegation";
	const plannedToolIds = input.route.plannedToolIds;
	const surfaceToolIds =
		input.executionRequirement?.surface === "managed_job"
			? [
					"open_computer",
					"close_computer",
					"exec",
					"read_execution",
					"cancel_execution",
				]
			: input.executionRequirement?.surface === "workstation"
				? [
						"open_computer",
						"close_computer",
						"exec",
						"read_execution",
						"cancel_execution",
					]
				: [];
	const requestedTools = [...new Set([...plannedToolIds, ...surfaceToolIds])];
	if (!input.route.targetActivityId) return null;
	if (new Set(plannedToolIds).size !== plannedToolIds.length) return null;
	for (const grant of input.card.delegationEntrustments) {
		if (grant.activityId !== input.route.targetActivityId) continue;
		if (grant.expiresAt) {
			const expiry = Date.parse(grant.expiresAt);
			if (!Number.isFinite(expiry) || expiry <= Date.now()) continue;
		}
		if (!grant.actionPatterns.includes(action)) continue;
		if (!grant.scope.actions.includes(action)) continue;
		if (!grant.scope.environments.includes(input.environment)) continue;
		if (
			(ROUTE_RISK_RANK[input.route.risk] ?? Number.POSITIVE_INFINITY) >
			(ROUTE_RISK_RANK[grant.riskLevel] ?? -1)
		)
			continue;
		if (grant.scope.spendPermission !== "none") continue;
		if (
			requestedTools.some(
				(toolId) =>
					!grant.activityToolIds.includes(toolId) ||
					!grant.scope.toolIds.includes(toolId),
			)
		)
			continue;

		const knownConstraintKeys = new Set([
			"routeKinds",
			"effortClasses",
			"taskFamilies",
			"capabilities",
			"maximumRisk",
		]);
		if (
			Object.keys(grant.scope.constraints).some(
				(key) => !knownConstraintKeys.has(key),
			)
		)
			continue;
		const routeKinds = constraintStrings(grant.scope.constraints, "routeKinds");
		const effortClasses = constraintStrings(
			grant.scope.constraints,
			"effortClasses",
		);
		const constrainedFamilies = constraintStrings(
			grant.scope.constraints,
			"taskFamilies",
		);
		const capabilities = constraintStrings(
			grant.scope.constraints,
			"capabilities",
		);
		if (
			routeKinds === null ||
			effortClasses === null ||
			constrainedFamilies === null ||
			capabilities === null
		)
			continue;
		if (routeKinds.length > 0 && !routeKinds.includes(input.route.routeKind)) {
			continue;
		}
		if (
			effortClasses.length > 0 &&
			(!input.route.effortClass ||
				!effortClasses.includes(input.route.effortClass))
		)
			continue;
		if (
			constrainedFamilies.length > 0 &&
			!constrainedFamilies.includes(grant.taskFamily)
		)
			continue;
		if (
			capabilities.length > 0 &&
			(input.executionRequirement?.requiredCapabilities ?? []).some(
				(capability) => !capabilities.includes(capability),
			)
		)
			continue;
		const maximumRisk = grant.scope.constraints.maximumRisk;
		if (
			maximumRisk !== undefined &&
			(typeof maximumRisk !== "string" ||
				(ROUTE_RISK_RANK[input.route.risk] ?? Number.POSITIVE_INFINITY) >
					(ROUTE_RISK_RANK[maximumRisk] ?? -1))
		)
			continue;
		return {
			version: "earned-delegation.v1",
			grantId: grant.grantId,
			grantRevision: grant.grantRevision,
			decisionId: grant.decisionId,
			activityId: grant.activityId,
			activityVersion: grant.activityVersion,
			taskFamily: grant.taskFamily,
			riskLevel: input.route.risk,
			environment: input.environment,
			allowedToolIds: requestedTools,
			expiresAt: grant.expiresAt,
		};
	}
	return null;
}

export function hasMatchingDelegationEntrustment(input: {
	card: TediCapabilityCard;
	route: KernelRouteDecision;
	executionRequirement?: ExecutionRequirement;
	environment: string;
}): boolean {
	return selectDelegationAuthorityEnvelope(input) !== null;
}

/**
 * Whether an embodied target presents a warm execution surface right now — keyed
 * on the actual warm signal per body kind, not on generic availability. No
 * network probe; both inputs are already on the card.
 *
 *  - Agent runtime: the runtime surface must be running/active.
 *  - embodied workstation: requires a real warm workstation lease
 *    (`hasWarmWorkstationLease`). An isolate is marked `embodied` from a warm
 *    lease or merely a configured `repoConfig.repoUrl`; the repo-only case has
 *    no running workstation, so a dispatch forces a cold on-demand spawn — the
 *    live no-lease first-turn (cold-503 / empty_assistant_message) failure. We
 *    therefore treat repo-only-without-lease as cold even when `availability` is
 *    "running" (the isolate body is up, but its workstation is not).
 *
 * Only called for `embodied === true` targets; a plain (non-embodied) isolate is
 * gated by the cheaper availability rule downstream (degrades to needs_approval,
 * a cheap DO wake — never refused here).
 */
function hasWarmEmbodiedSurface(card: TediCapabilityCard): boolean {
	return card.hasWarmWorkstationLease === true;
}

/**
 * Whether the instruction (not the target) needs an embodied execution surface —
 * shell, repo/files, a long-running process, browser automation, or a tool
 * write. This is the "needs" half of the (needs × capability) kind decision.
 *
 * The planner already classifies effort: `embodied` is exactly the budget for a
 * workstation profile/adapter (shell/files/coding/browser/long process — see
 * `HOME_EFFORT_CLASSES` in route-schema.ts). Read-only / conversational routes
 * (`single_read`, `multi_hop_read`, `fan_out`, or an unset effort) do not need a
 * body: a cold-bodied embodied target can serve them on its cognitive/isolate
 * dispatch path. So the predicate is true iff the route's effort class is
 * `embodied`.
 *
 * Keyed off the route alone (no card): the same predicate drives both the
 * work-order kind and the dispatch boot_unavailable gate, so a route that does
 * not need a body never mints a workstation.attach and is never refused for a
 * cold body.
 */
function routeNeedsEmbodiedSurface(route: KernelRouteDecision): boolean {
	return route.effortClass === "embodied";
}

/**
 * Authorization gate for delegating to a tedi. Fail closed — the only path to
 * `auto` is: a capability card exists, the target is active, the target's
 * capability envelope can carry the route's effort class (embodied work needs a
 * body or workstation adapter),
 * the target does not require approval, the target actually holds relevant
 * scope groups, the
 * speaker carries approval authority, and the route is not high-risk. Anything
 * else degrades to `needs_approval` (or `blocked` when there is no card at
 * all). The default when uncertain is never `auto`.
 *
 * Rule table (first match wins):
 *
 *  | #  | Condition                                          | mode            |
 *  |----|----------------------------------------------------|-----------------|
 *  | 1  | no card                                            | blocked         |
 *  | 2  | layered policy deny (session -> tedi -> org)       | needs_approval  |
 *  | 3a | embodied target + embodied route, body cold        | boot_unavailable|
 *  | 3b | embodied target + embodied route, body up but       | needs_approval  |
 *  |    |   workstation lease cold (warms own ws first turn) |                 |
 *  | 4  | availability not running/active                    | needs_approval  |
 *  | 5  | embodied route, target not embodied                | needs_approval  |
 *  | 6  | card.requiresApproval === true                     | needs_approval  |
 *  | 7  | no relevant scopeGroups                             | needs_approval  |
 *  | 8  | speaker lacks approvalAuthority                    | needs_approval  |
 *  | 9  | route.risk === "high"                              | needs_approval  |
 *  | 10 | all of the above satisfied                         | auto            |
 *
 * Every `needs_approval` verdict carries `approvalRoute`. Rules 6 and 9 (and
 * the earned-delegation ceilings applied after this table) are `agent`: the
 * org's designated approval tedi may decide them through the Work approval
 * plane. Rules 2, 3b, 3c, 4, 5, 7 and 8, and an explicit operator hold, are
 * `human`.
 *
 * `boot_unavailable` is a refusal, distinct from `needs_approval`: it is not a
 * "human, decide" card but a "the body is cold, don't enqueue a child that will
 * fail its first turn" verdict. The supervised-dispatch path treats only `auto`
 * as dispatchable and only `needs_approval` as card-able, so a
 * `boot_unavailable` run records the refusal + reason and does nothing else.
 *
 * `gating` (optional) carries the session/tedi/org gating layers. Absent → no
 * layered opinion → behavior is exactly the pre-existing two-layer model.

 */
export function decideDelegationDispatch(input: {
	route: KernelRouteDecision;
	card: TediCapabilityCard | null;
	speaker: { approvalAuthority?: boolean } | null;
	executionRequirement?: ExecutionRequirement;
	/**
	 * Layered gating policy (precedence session → tedi → org, deny short-circuits,
	 * fail-closed). All fields optional; when none are present the layered check
	 * defers and the gate is unchanged.
	 */
	gating?: {
		session?: DispatchPolicyLayer | null;
		tedi?: DispatchPolicyLayer | null;
		org?: DispatchPolicyLayer | null;
	} | null;
	/**
	 * Explicit operator instruction to park the delegation for later approval.
	 * This suppresses otherwise-authorized auto dispatch.
	 */
	operatorHeldForApproval?: boolean;
	/** Shadow records misses without changing dispatch; enforce gates them. */
	earnedDelegationEnforcement?: EarnedDelegationEnforcementMode;
	/**
	 * Whether the planner's concrete activity is in the active rollout
	 * allowlist. A named-tedi rollout can enforce even when the planner omits
	 * the activity; false then holds the route before autonomous dispatch.
	 */
	earnedDelegationActivityAllowed?: boolean;
	executionEnvironment?: string;
	/**
	 * Depth of this delegation in the parent→child→grandchild chain (a top-level
	 * Home turn is 0; the first delegated child dispatching further is 1; etc.).
	 * When absent it is treated as 0 (backward-compatible no-op). See
	 * MAX_DELEGATION_DEPTH — LangGraph's finding that error compounds past
	 * ~8–10 hops (docs/decisions/agentic-kernel-architecture.md).
	 */
	delegationDepth?: number;
}): DispatchDecision {
	const { route, card, speaker } = input;

	// Depth bound (fail closed, before the capability verdict): a delegation
	// chain deeper than MAX_DELEGATION_DEPTH is refused as a policy failure —
	// every cross-agent hop compounds error, so an unbounded parent→child→…
	// chain is a runaway, not work. Typed `policy` so recorders classify it.
	const depth = input.delegationDepth ?? 0;
	if (depth >= MAX_DELEGATION_DEPTH) {
		return {
			canAutoDispatch: false,
			mode: "blocked",
			reason: `delegation depth ${depth} exceeds the maximum chain depth of ${MAX_DELEGATION_DEPTH}; deepen the plan, do not deepen the delegation chain`,
			failure: { category: "policy", retryable: false },
		};
	}

	const verdict = computeDispatchVerdict({
		route,
		card,
		speaker,
		executionRequirement: input.executionRequirement,
		gating: input.gating,
	});

	// Hard-fail verdicts carry the typed failure so every recorder downstream
	// gets a category, not a string. Holds/promotions below only touch
	// auto/needs_approval, so classifying here is terminal for these modes.
	if (verdict.mode === "blocked" || verdict.mode === "boot_unavailable") {
		return { ...verdict, failure: classifyDelegationFailure(verdict.reason) };
	}

	if (
		input.earnedDelegationEnforcement === "enforce" &&
		input.earnedDelegationActivityAllowed === false
	) {
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: earnedHoldApprovalRoute(verdict),
			reason:
				"target is enrolled in earned-delegation enforcement, but the route omitted or selected an activity outside the rollout allowlist",
		};
	}

	const matchingEntrustment =
		card !== null &&
		hasMatchingDelegationEntrustment({
			card,
			route,
			executionRequirement: input.executionRequirement,
			environment: input.executionEnvironment ?? "production",
		});
	// Earned authority is a hard ceiling in enforce mode, including in open-
	// testing mode. Shadow mode is the explicit zero-grant rollout posture: it
	// preserves existing dispatch while recording the miss on the decision.
	if (!matchingEntrustment && input.earnedDelegationEnforcement === "enforce") {
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: earnedHoldApprovalRoute(verdict),
			reason: `target lacks a matching ${input.executionEnvironment ?? "production"} entrustment for this route risk, task family, tools, and constraints`,
		};
	}
	const shadowMiss = !matchingEntrustment;

	if (input.operatorHeldForApproval && verdict.mode === "auto") {
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: "human",
			reason: "operator explicitly held dispatch for approval",
		};
	}

	return shadowMiss ? { ...verdict, earnedDelegationShadow: true } : verdict;
}

/**
 * An earned-delegation ceiling is agent-decidable only when the underlying
 * gate would otherwise have dispatched, or itself held for an agent-decidable
 * reason. A ceiling stacked on a human-only hold (policy deny, a speaker
 * without approval authority, a capability gap) must never let an agent
 * approval bypass that hold.
 */
function earnedHoldApprovalRoute(
	verdict: DispatchDecision,
): DelegationApprovalRoute {
	return verdict.mode === "auto" || verdict.approvalRoute === "agent"
		? "agent"
		: "human";
}

function computeDispatchVerdict(input: {
	route: KernelRouteDecision;
	card: TediCapabilityCard | null;
	speaker: { approvalAuthority?: boolean } | null;
	executionRequirement?: ExecutionRequirement;
	gating?: {
		session?: DispatchPolicyLayer | null;
		tedi?: DispatchPolicyLayer | null;
		org?: DispatchPolicyLayer | null;
	} | null;
}): DispatchDecision {
	const { route, card, speaker } = input;
	const needsWorkstation = input.executionRequirement
		? requiresWorkstationLease(input.executionRequirement)
		: routeNeedsEmbodiedSurface(route);

	if (input.executionRequirement?.satisfiable === false) {
		return {
			canAutoDispatch: false,
			mode: "blocked",
			reason: input.executionRequirement.reason,
		};
	}

	// 1. No capability data → we cannot reason about authorization at all.
	if (!card) {
		return {
			canAutoDispatch: false,
			mode: "blocked",
			reason: "no capability data for target",
		};
	}

	// 2. Layered policy precedence (session → tedi → org). A deny at any layer
	//    short-circuits to a human decision (fail-closed); ALLOW/defer fall
	//    through to the existing gate (an allow never weakens the checks below).
	if (input.gating) {
		const layered = resolveLayeredDispatchPolicy(input.gating);
		if (layered.effect === "deny") {
			return {
				canAutoDispatch: false,
				mode: "needs_approval",
				approvalRoute: "human",
				reason: `dispatch denied by ${layered.layer} policy: ${layered.reason}`,
			};
		}
	}

	// 3. Embodied target + embodied route + no warm workstation lease: the
	//    execution surface is not warm. Split on whether the body itself is up:
	//
	//    3a. Body cold (isolate not running, availability not in AVAILABLE_STATES):
	//        Refuse (boot_unavailable). Enqueuing an embodied-effort child here is
	//        the live cold-503 / empty_assistant_message failure: the child spawns
	//        onto a dead surface and dies on its first turn. There is nothing for a
	//        human to approve until the body is up; this is the fail-closed floor.
	//
	//    3b. Body up, only the workstation lease cold (a running isolate carrying a
	//        configured repository but holding no warm `workstation_leases` seat): degrade to
	//        needs_approval, not a refusal. The isolate wakes on message (Agents
	//        SDK) and warms its own workstation on the first turn via
	//        open_computer, proven by the direct-delegate path, which warms
	//        and codes successfully where the old flat boot_unavailable dead-ended
	//        the kernel route. needs_approval is routed through the existing
	//        approve -> dispatch channel, so an approval recovers the path
	//        without any new dispatch infrastructure.
	//
	//    A read-only / conversational route to an embodied target never reaches
	//    here (gated on `routeNeedsEmbodiedSurface`); it degrades on the
	//    availability rule below, keeping kind and dispatch in lockstep.
	if (
		card.embodied === true &&
		needsWorkstation &&
		!hasWarmEmbodiedSurface(card)
	) {
		if (!AVAILABLE_STATES.has(card.availability)) {
			return {
				canAutoDispatch: false,
				mode: "boot_unavailable",
				reason:
					"target body is cold; isolate is not running and no warm workstation lease exists; refusing dispatch instead of enqueuing a child that fails its first turn",
			};
		}
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: "human",
			reason:
				"embodied work for a running isolate with a cold workstation lease; approve to dispatch, then the tedi warms its own workstation on the first turn",
		};
	}

	// 3c. Warm workstation lease, but the workstation environment is not ready
	//     (deps still installing). The lease is up (we passed rule 3), so this is
	//     not a cold body — but dispatching a coding task now lands the tedi in a
	//     "vitest not found"/`depsReady:false` mid-task failure. Hold "warming"
	//     (needs_approval) until the env is environment-ready; the workstation already
	//     self-bootstraps its deps, so a retry clears it. Scoped to a repository
	//     target (hasRepository) — browser/shell embodied work has no deps notion
	//     and is unaffected. Fail-soft: `environmentReady` defaults to false only when
	//     a warm lease exists but has no readiness metadata, which a served lease
	//     always has, so this does not over-fire. This makes workstation readiness
	//     a control-plane preflight (CMA "prove the tier is ready before delegate")
	//     rather than something the tedi discovers mid-task.
	if (
		card.embodied === true &&
		needsWorkstation &&
		card.hasRepository === true &&
		card.hasWarmWorkstationLease === true &&
		card.environmentReady === false
	) {
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: "human",
			reason:
				"workstation warming: the workstation is up but not yet environment-ready (deps installing); holding until depsReady, then retry",
		};
	}

	// 4. A gated target that is not active would need a wake, so hold it for an
	//    operator. An explicitly autonomous target may wake for a cognitive turn:
	//    its scope, speaker authority, and route-risk checks still run below. The
	//    embodied cold-body refusal above remains non-promotable.
	if (!AVAILABLE_STATES.has(card.availability) && card.requiresApproval) {
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: "human",
			reason: "target not active",
		};
	}

	// 5. Embodied work needs an embodied capability envelope. That can be a
	//    runtime body or an isolate tedi with a workstation adapter.
	//    Fail closed to a human decision rather than auto-dispatching work the
	//    target physically cannot do.
	if (needsWorkstation && card.embodied === false) {
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: "human",
			reason:
				"embodied work targeted at a tedi without body/workstation capability — needs human confirmation",
		};
	}

	// 6. Target self-declares it requires approval for its actions.
	if (card.requiresApproval === true) {
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: "agent",
			reason: "target requires approval for its actions",
		};
	}

	// 7. Target is not authorized for anything relevant — no scope groups means
	//    we cannot say it can do the work within its grant.
	if (card.scopeGroups.length === 0) {
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: "human",
			reason: "target has no authorized scope groups",
		};
	}

	// 8. Speaker authority — only an operator with approval authority can
	//    pre-authorize an autonomous dispatch.
	if (!speaker?.approvalAuthority) {
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: "human",
			reason: "speaker lacks approval authority",
		};
	}

	// 9. High-risk route → always require a human in the loop.
	if (route.risk === "high") {
		return {
			canAutoDispatch: false,
			mode: "needs_approval",
			approvalRoute: "agent",
			reason: "route classified as high risk",
		};
	}

	// 10. Every condition holds → authorized supervised auto-dispatch.
	return {
		canAutoDispatch: true,
		mode: "auto",
		reason:
			"authorized operator delegating to an active in-scope target with no high-risk signal",
	};
}

// ---------------------------------------------------------------------------
// 3. Typed failure taxonomy (arXiv:2603.18043)
// ---------------------------------------------------------------------------

/**
 * - capability: the target cannot do the work (missing tool/body/skill) —
 *   retry against the same target is futile.
 * - policy: an authorization/approval/scope gate said no — futile until a
 *   human or policy change acts.
 * - quality: the work ran but the output failed the contract (overclaim,
 *   unmet criteria) — a retry may pass.
 * - runtime: the target's execution surface failed (cold body, crash,
 *   dropped run) — retryable once the surface recovers.
 * - transport: the hop itself failed (timeout, network) — retry is the
 *   designed response.
 */
export type DelegationFailureCategory =
	| "capability"
	| "policy"
	| "quality"
	| "runtime"
	| "transport";

export interface DelegationFailureClassification {
	category: DelegationFailureCategory;
	retryable: boolean;
}

/**
 * First-match-wins over the failure text. Order constraints:
 * - transport before runtime: "dispatch timed out before the child runtime
 *   published events" is a hop failure even though it names the runtime.
 * - runtime before policy/capability: boot/cold-body refusals mention the
 *   workstation surface, not grants.
 * - capability last of the futile pair: policy words (scope, approval,
 *   denied) are more specific than capability words.
 */
const DELEGATION_FAILURE_RULES: Array<{
	category: DelegationFailureCategory;
	retryable: boolean;
	pattern: RegExp;
}> = [
	{
		category: "transport",
		retryable: true,
		pattern:
			/timed?\s?out|timeout|dispatch_timeout|fetch failed|network|econn|socket|unreachable|\b50[234]\b/i,
	},
	{
		category: "runtime",
		retryable: true,
		pattern:
			/runtime_unavailable|runtime_dropped|runtime error|\bboot\b|\bcold\b|not running|crash|empty_assistant_message|internal error|\b500\b/i,
	},
	{
		category: "policy",
		retryable: false,
		pattern:
			/denied|approval|unauthoriz|not authorized|forbidden|\b403\b|permission|policy|scope/i,
	},
	{
		category: "capability",
		retryable: false,
		pattern:
			/capabilit|unsupported|no such tool|unknown tool|missing tool|not embodied|lacks/i,
	},
	{
		category: "quality",
		retryable: true,
		pattern: /overclaim|fabricat|criteria|partial result|unverified/i,
	},
];

/**
 * Classify a delegation failure into the typed taxonomy. Pure and total: any
 * text yields a verdict. `evidence.overclaim` (the claim-vs-evidence verdict)
 * outranks the text — an overclaim is a quality failure even when the recorded
 * error says something else or nothing at all. Unknown text defaults to
 * runtime/retryable: blaming infra is safe; capability/quality verdicts feed
 * selection priors, so they must come from a matched signal, not a fallback.
 */
export function classifyDelegationFailure(
	errorText: string,
	evidence?: { overclaim?: boolean },
): DelegationFailureClassification {
	if (evidence?.overclaim === true) {
		return { category: "quality", retryable: true };
	}
	const text = (errorText ?? "").trim();
	for (const rule of DELEGATION_FAILURE_RULES) {
		if (rule.pattern.test(text)) {
			return { category: rule.category, retryable: rule.retryable };
		}
	}
	return { category: "runtime", retryable: true };
}
