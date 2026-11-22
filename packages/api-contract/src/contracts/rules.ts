import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ChangeRuleInputSchema,
	CreateRuleInputSchema,
	GetRuleInputSchema,
	ListRulesInputSchema,
	ListRulesResultSchema,
	RuleSchema,
	UpdateRuleInputSchema,
} from "../schemas/rules";

export const rulesContract = oc
	.route({ tags: ["rules"], prefix: "/rules" })
	.errors(baseErrors)
	.router({
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				operationId: "create_rule",
				summary: "Write a team or personal rule",
				description:
					"Save plain text in the existing lesson store. Team rules written by an agent or a member wait for an owner or admin to approve_rule. An authenticated person manages their own personal rules directly. Approved rules use the same session-start and per-turn context as mined lessons.",
			})
			.input(CreateRuleInputSchema)
			.output(RuleSchema),
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				operationId: "list_rules",
				summary: "List team rules and your personal rules",
				description:
					"List mined and written rules, including pending and retired rules, with their state, origin and revisions. Personal rules are visible only to their owner. Follow nextOffset to read another page.",
			})
			.input(ListRulesInputSchema)
			.output(ListRulesResultSchema),
		get: oc
			.route({
				method: "GET",
				path: "/{ruleId}",
				operationId: "get_rule",
				summary: "Read a rule and its revisions",
			})
			.input(GetRuleInputSchema)
			.output(RuleSchema),
		update: oc
			.route({
				method: "POST",
				path: "/{ruleId}/update",
				operationId: "update_rule",
				summary: "Change a rule, keeping its old text",
				description:
					"Requires the revision read from get_rule. Team changes written by an agent wait for owner/admin approval again. A retired rule must first be restored.",
			})
			.input(UpdateRuleInputSchema)
			.output(RuleSchema),
		retire: oc
			.route({
				method: "POST",
				path: "/{ruleId}/retire",
				operationId: "retire_rule",
				summary: "Stop delivering a rule",
				description:
					"Retain the rule and its evidence so mining cannot recreate it from the same history. Personal rules may be retired only by their owner.",
			})
			.input(ChangeRuleInputSchema)
			.output(RuleSchema),
		restore: oc
			.route({
				method: "POST",
				path: "/{ruleId}/restore",
				operationId: "restore_rule",
				summary: "Restore a retired rule",
				description:
					"Personal rules return directly. Team rules restored by an agent wait for owner/admin approval again.",
			})
			.input(ChangeRuleInputSchema)
			.output(RuleSchema),
		approve: oc
			.route({
				method: "POST",
				path: "/{ruleId}/approve",
				operationId: "approve_rule",
				summary: "Approve a pending team rule",
				description:
					"Only a signed-in active organization owner or admin may approve the exact revision. Agents cannot approve, including agents acting for an owner.",
			})
			.input(ChangeRuleInputSchema)
			.output(RuleSchema),
	});
