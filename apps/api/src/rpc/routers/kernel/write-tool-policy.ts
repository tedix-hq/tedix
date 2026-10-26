import { parseToolPolicyMetadata } from "@tedix/api-contract/schemas/tools";
import {
	humanReservedActionClasses,
	builtinToolPolicyMetadata,
	isSafeNotionPageUpdateCall,
	isWorkItemPurposeRepairCall,
	platformAutonomousOperation,
	type KernelWriteRiskTier,
} from "@tedix/api-contract/utils/approval-policy";

export interface McpTool {
	name: string;
	authorized?: boolean;
	description?: string;
	_meta?: Record<string, unknown>;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
	inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

/** Operator-configured tenant defaults (app mcpConfig.toolParamDefaults). */
export type ToolParamDefaults = Record<string, string | number | boolean>;

/**
 * Destructive/irreversible verbs — the high-risk subset of the write verbs. A
 * write matching one of these (or carrying `destructiveHint:true`) is high risk
 * and never policy-auto-approved (only an explicit session pre-authorization can
 * carry one through). The shared critical-action classifier also applies.
 *
 * Exported for the subset invariant test — this list is a subset of the write
 * verbs by construction ({@link WRITE_VERB_RE} is built from the union below),
 * so a verb added here can never again be invisible to {@link isWriteCapable}.
 */
export const DESTRUCTIVE_VERBS = [
	"delete",
	"remove",
	"destroy",
	"drop",
	"purge",
	"wipe",
	"erase",
	"cancel",
	"archive",
	"deactivate",
	"disable",
	"revoke",
	"detach",
	"unassign",
	"reset",
	"terminate",
	"refund",
	"void",
	"expire",
	// Money movement and authority grants. Not teardowns, but irreversible in
	// effect and the last things that should ride a wildcard auto-approve, so
	// they are high by verb rather than waiting on an accurate annotation.
	"transfer",
	"pay",
	"charge",
	"issue",
	"grant",
] as const;

/**
 * Mutating verbs that are not destructive — they change or create provider
 * state without tearing it down, moving money, or handing out authority. Low
 * risk by exclusion from {@link DESTRUCTIVE_VERBS}.
 */
export const WRITE_ONLY_VERBS = [
	"create",
	"update",
	"send",
	"write",
	"set",
	"add",
	"insert",
	"patch",
	"post",
	"put",
	"move",
	"label",
	"unlabel",
	"mark",
	"activate",
	"attach",
	"assign",
	"approve",
	"reject",
	"execute",
	"run",
	"trigger",
	"start",
	"stop",
	"restart",
	"sync",
	"import",
	"upload",
	"publish",
	"submit",
] as const;

/** Underscore/dot/dash/space-aware verb-anywhere matcher. */
function verbMatcher(verbs: readonly string[]): RegExp {
	return new RegExp(`(^|[._\\s-])(${verbs.join("|")})([._\\s-]|$)`, "i");
}

/**
 * Write/mutating-verb matcher. Demoted to a diagnostic fallback: it no longer
 * decides whether an unclassified tool is a write, it only says whether the
 * name happens to look like one, and {@link isWriteCapable} logs that answer
 * instead of trusting it.
 *
 * It is demoted because it is structurally blind. The boundaries are separators
 * only (`(^|[._\s-])verb([._\s-]|$)`), so camelCase never matches: `createJiraIssue`
 * does not match `create`, because `create` is followed by `J`. Most unannotated
 * tool ids evade it — e.g. `cms_provision_service_key`, `finalize_invoice`,
 * `modify_pending_order_payment`.
 *
 * Built as the UNION of the write-only and destructive verb lists: destructive
 * verbs (`drop`, `purge`, `revoke`, `terminate`, ...) used to live only in
 * DESTRUCTIVE_VERB_RE, so the very highest-risk tools were invisible to the
 * write planner rather than merely lenient.
 */
const WRITE_VERB_RE = verbMatcher([...WRITE_ONLY_VERBS, ...DESTRUCTIVE_VERBS]);

/**
 * The three-state declared classification of a wire tool, mirroring
 * `app_tools.write_capability` (apps/mcp projects the column onto the wire
 * annotations, so a manual declaration reaches this function).
 *
 * "undeclared" is a real state, not a synonym for read-only — that conflation
 * is the defect this module used to ship.
 */
export type ToolWriteDeclaration =
	| "declared_write"
	| "declared_read"
	| "undeclared";

export function declaredWriteCapability(tool: McpTool): ToolWriteDeclaration {
	const annotations = tool.annotations;
	if (annotations?.destructiveHint === true) return "declared_write";
	if (annotations?.readOnlyHint === true) return "declared_read";
	// `readOnlyHint:false` (or a bare `destructiveHint:false`, which the MCP spec
	// only defines for non-read-only tools) is a positive statement that the tool
	// writes. Absent hints fall through — absent is not false.
	if (
		annotations?.readOnlyHint === false ||
		annotations?.destructiveHint === false
	)
		return "declared_write";
	return "undeclared";
}

/**
 * Whether a tool may mutate provider state. Fail-closed: the declaration wins,
 * and an undeclared tool counts as write-capable.
 *
 * This used to end in `return WRITE_VERB_RE.test(tool.name)` — a silent `false`
 * for anything the regex missed, which is how `createJiraIssue` and
 * `cms_provision_service_key` classified as non-writes. Now the regex only
 * annotates a `console.warn`: unclassified tools are gated, and every one of
 * them names itself in the logs so the backlog is visible rather than invisible
 * (the standing list lives in the catalog-integrity write-capability report).
 */
export function isWriteCapable(tool: McpTool): boolean {
	const declared = declaredWriteCapability(tool);
	if (declared !== "undeclared") return declared === "declared_write";
	console.warn("[kernel.writeProposal] unclassified tool gated as write", {
		tool: tool.name,
		declaration: "undeclared",
		verbFallbackMatched: WRITE_VERB_RE.test(tool.name),
		gated: true,
	});
	return true;
}

const DESTRUCTIVE_VERB_RE = verbMatcher(DESTRUCTIVE_VERBS);

/**
 * Classify writes from configured operational risk metadata. Annotations and
 * critical-action text can raise the risk, but cannot lower a missing or
 * higher-impact classification.
 */
export function classifyWriteRisk(
	tool: McpTool,
	args?: unknown,
): KernelWriteRiskTier {
	if (humanReservedActionClasses(tool.name).length) return "high";
	const risk = classifyToolWriteRisk(tool, args);
	// Platform-default operations (organization-autonomy.v1.json) are reversible
	// in-organization changes: an "archive"/"cancel" verb or a destructive
	// annotation does not make a Tedix-classified one high risk. An
	// unclassified tool stays high whatever its name. Permanent deletes are not
	// platform operations.
	const policy = parseToolPolicyMetadata(tool._meta);
	// A Work update outside purpose repair carries no declared tier.
	const declared =
		policy?.argumentPolicy === "work_item_purpose_repair" &&
		!isWorkItemPurposeRepairCall(args)
			? undefined
			: policy?.riskTier;
	return risk === "high" &&
		(declared === "bounded_write" || declared === "high_impact_write") &&
		platformAutonomousOperation(tool.name)
		? "medium"
		: risk;
}

function classifyToolWriteRisk(
	tool: McpTool,
	args?: unknown,
): KernelWriteRiskTier {
	const policy = parseToolPolicyMetadata(tool._meta);
	const connected = tool._meta?.["com.tedix/connectedTool"] as
		| { providerId?: unknown; toolName?: unknown }
		| undefined;
	if (policy?.argumentPolicy === "work_item_purpose_repair")
		return policy.riskTier === "bounded_write" &&
			isWorkItemPurposeRepairCall(args)
			? "low"
			: "high";
	if (policy?.argumentPolicy === "notion_page_update")
		return policy.riskTier === "bounded_write" &&
			connected?.providerId === "notion" &&
			connected.toolName === "notion-update-page" &&
			isSafeNotionPageUpdateCall(args)
			? "low"
			: "high";
	if (tool.annotations?.destructiveHint === true) return "high";
	const name = tool.name.split(/[.:]/).at(-1)?.split("__").at(-1) ?? tool.name;
	if (DESTRUCTIVE_VERB_RE.test(tool.name) && !builtinToolPolicyMetadata(name))
		return "high";
	return policy?.riskTier === "bounded_write" && policy.blastRadius
		? "low"
		: "high";
}

export const MAX_CATALOG_TOOLS = 40;

/**
 * Declared writes precede undeclared tools so unclassified reads cannot displace
 * actual writes from the bounded catalog. Undeclared entries remain gated and
 * marked unverified; provider declarations, including read-only hints, are final.
 */
export function orderWriteToolCatalog(tools: McpTool[]): McpTool[] {
	const declared: McpTool[] = [];
	const undeclared: McpTool[] = [];
	for (const tool of tools) {
		(declaredWriteCapability(tool) === "undeclared"
			? undeclared
			: declared
		).push(tool);
	}
	return [...declared, ...undeclared];
}

/** Compact, prompt-safe serialization of the write-tool catalog. */
export function renderWriteToolCatalog(tools: McpTool[]): string {
	return orderWriteToolCatalog(tools)
		.slice(0, MAX_CATALOG_TOOLS)
		.map((tool) => {
			const props = Object.entries(tool.inputSchema?.properties ?? {})
				.slice(0, 32)
				.map(([key, value]) => {
					const type =
						value && typeof value === "object" && "type" in value
							? String((value as { type?: unknown }).type ?? "any")
							: "any";
					return `${key}:${type}`;
				})
				.join(", ");
			const required = tool.inputSchema?.required?.length
				? ` required=[${tool.inputSchema.required.join(",")}]`
				: "";
			const description = (tool.description ?? "")
				.replace(/\s+/g, " ")
				.slice(0, 160);
			const unverified =
				declaredWriteCapability(tool) === "undeclared" ? " [unverified]" : "";
			return `- ${tool.name}(${props})${required}${unverified}${description ? ` — ${description}` : ""}`;
		})
		.join("\n");
}
