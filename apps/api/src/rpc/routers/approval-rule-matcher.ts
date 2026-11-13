import type { DbQueryClient } from "@tedix/db/query-client";
import { findEnabledOsApprovalRulesByKind } from "@tedix/db/queries/os-approval-rules";
import type { OsApprovalRuleRow } from "@tedix/db/schema/os-approval-rules";
import {
	declaredAutoApproval,
	parseDeclaredToolClass,
} from "@tedix/api-contract/utils/tool-declared-class";
import { toolNameWords } from "../../services/tool-class-backlog";
import { DESTRUCTIVE_VERBS } from "./kernel/write-tool-policy";

interface RuleApproval {
	orgId: string;
	actionType: string;
	payload: Record<string, unknown>;
}
/**
 * Backstop for a tool nobody has classified: a word in its name decides. A
 * payload that carries the tool's declared class never reaches this list.
 */
const forbidden = new Set<string>([...DESTRUCTIVE_VERBS, "deploy", "takeover"]);
export function matchingApprovalRule(
	approval: RuleApproval,
	rules: readonly OsApprovalRuleRow[],
): OsApprovalRuleRow | undefined {
	const payload = approval.payload;
	const tool = typeof payload.toolName === "string" ? payload.toolName : null;
	const app = typeof payload.appSlug === "string" ? payload.appSlug : null;
	const verb =
		typeof payload.verb === "string"
			? payload.verb
			: tool
				? toolNameWords(tool)[0]
				: null;
	const toolSlug = app && tool ? `${app}.${tool}` : null;
	// The declared class decides first; the name is read only without one.
	const declared = parseDeclaredToolClass(payload.declaredClass);
	if (declared && !declaredAutoApproval(declared).eligible) return;
	if (
		[
			approval.actionType,
			...(declared ? [] : [toolSlug ?? "", verb ?? ""]),
		].some((value) => toolNameWords(value).some((word) => forbidden.has(word)))
	)
		return;
	if (payload.riskTier === "high") return;
	// Standing consent for a Home write covers low risk only: medium stays with
	// a person (decideKernelWriteApproval would hold it), and a payload without
	// a classified tier predates this matcher and never matches.
	if (approval.actionType === "home.tool_write" && payload.riskTier !== "low")
		return;
	// Home's coarse kind is never authority for every connected write tool.
	if (
		approval.actionType === "home.tool_write" &&
		(!toolSlug ||
			!verb ||
			!["home_tool_write", "repo_commit_write"].includes(String(payload.kind)))
	)
		return;
	return rules.find(
		(rule) =>
			rule.enabled &&
			rule.decision === "approve" &&
			rule.organizationId === approval.orgId &&
			rule.actionKind === approval.actionType &&
			(approval.actionType !== "home.tool_write" ||
				Boolean(rule.toolSlug && rule.verb)) &&
			(rule.toolSlug == null || rule.toolSlug === toolSlug) &&
			(rule.verb == null || rule.verb === verb),
	);
}
/** Read standing authority at creation; settlement waits until the run is parked. */
export async function findApprovalRule(
	db: DbQueryClient,
	approval: RuleApproval,
	organizationId: string,
): Promise<OsApprovalRuleRow | undefined> {
	if (approval.orgId !== organizationId) return undefined;
	try {
		const rules = await findEnabledOsApprovalRulesByKind(db, organizationId, [
			approval.actionType,
		]);
		return matchingApprovalRule(approval, rules);
	} catch {
		// An unavailable rule store never releases an approval or discards its card.
		console.warn("[approval.rules] standing rule lookup unavailable");
		return undefined;
	}
}
