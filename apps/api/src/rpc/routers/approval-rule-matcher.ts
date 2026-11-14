import { decideAutoApproval } from "@tedix/api-contract/utils/approval-policy";
import type { DbQueryClient } from "@tedix/db/query-client";
import { findEnabledOsApprovalRulesByKind } from "@tedix/db/queries/os-approval-rules";
import type { OsApprovalRuleRow } from "@tedix/db/schema/os-approval-rules";
import { parseDeclaredToolClass } from "@tedix/api-contract/utils/tool-declared-class";
import { toolNameWords } from "../../services/tool-class-backlog";
import { DESTRUCTIVE_VERBS } from "./kernel/write-tool-policy";

type ApprovalRuleMatch = OsApprovalRuleRow & { approvalReason: string };

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
): ApprovalRuleMatch | undefined {
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
	const decision = decideAutoApproval({
		kind: "standing_rule",
		organizationId: approval.orgId,
		actionType: approval.actionType,
		payloadKind: payload.kind,
		riskTier: payload.riskTier,
		declaredClass: payload.declaredClass,
		toolSlug,
		verb: verb ?? null,
		rules,
		forbiddenName: [
			approval.actionType,
			...(declared ? [] : [toolSlug ?? "", verb ?? ""]),
		].some((value) => toolNameWords(value).some((word) => forbidden.has(word))),
	});
	const rule = decision.autoApprove
		? rules.find((rule) => rule.id === decision.ruleId)
		: undefined;
	return rule ? { ...rule, approvalReason: decision.reason } : undefined;
}
/** Read standing authority at creation; settlement waits until the run is parked. */
export async function findApprovalRule(
	db: DbQueryClient,
	approval: RuleApproval,
	organizationId: string,
): Promise<ApprovalRuleMatch | undefined> {
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
