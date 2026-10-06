import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { OsCreatedByKindSchema } from "../schemas/os-workspaces";

/**
 * Tedix OS auto-approval policies (v1): per-organization rules that
 * auto-resolve pending tedi approval requests matching an action kind.
 *
 * Rules are explicit, listable, and disable-able. Nothing runs in the
 * background — resolution happens only through the explicit, idempotent
 * `apply` sweep, which resolves each matching pending approval through the
 * SAME canonical resolution path a human `tediApprovals.resolve` uses and
 * records the rule id in the resolution note. Internal + MCP projection only;
 * all ids are UUIDs.
 */

export const OsApprovalRuleSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	/** Matches `tedi_approval_requests.action_type` exactly. */
	actionKind: z.string(),
	/** v1 supports only auto-approval. */
	decision: z.literal("approve"),
	enabled: z.boolean(),
	createdByKind: OsCreatedByKindSchema,
	createdById: z.string(),
	createdAt: z.string(),
	/** When the rule was last disabled (ISO 8601); null while enabled. */
	disabledAt: z
		.string()
		.nullable()
		.describe(
			"Lifecycle marker: set when the rule was disabled; null while the rule is enabled or was never disabled",
		),
});

export type OsApprovalRule = z.infer<typeof OsApprovalRuleSchema>;

export const OsApprovalRuleMatchSchema = z.object({
	approvalId: z.string(),
	ruleId: z.string(),
});

export type OsApprovalRuleMatch = z.infer<typeof OsApprovalRuleMatchSchema>;

export const osApprovalRulesContract = oc
	.route({ tags: ["os-approval-rules"], prefix: "/os-approval-rules" })
	.errors(baseErrors)
	.router({
		create: oc
			.route({
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create an auto-approval rule",
				description:
					"Create an enabled rule that auto-approves pending tedi approval requests of the given action kind. Idempotent per kind: when an enabled rule for the kind already exists, that rule is returned instead of a duplicate. The rule only takes effect through the explicit `apply` sweep.",
				successStatus: 201,
			})
			.input(
				z.object({
					actionKind: z.string().trim().min(1).max(200),
				}),
			)
			.output(z.object({ rule: OsApprovalRuleSchema })),

		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List auto-approval rules",
				description:
					"List the organization's auto-approval rules, newest first, including disabled rules.",
			})
			.output(z.object({ items: z.array(OsApprovalRuleSchema) })),

		setEnabled: oc
			.route({
				method: "POST",
				path: "/{ruleId}/enabled",
				summary: "Enable or disable an auto-approval rule",
			})
			.input(
				z.object({
					ruleId: z.uuid(),
					enabled: z.boolean(),
				}),
			)
			.output(z.object({ rule: OsApprovalRuleSchema })),

		delete: oc
			.route({
				method: "DELETE",
				path: "/{ruleId}",
				summary: "Permanently delete a disabled auto-approval rule",
				description:
					"Requires os:admin and a disabled rule. Historical approval and audit rows keep the deleted rule id in their evidence.",
			})
			.input(z.object({ ruleId: z.uuid() }))
			.output(z.object({ deleted: z.literal(true) })),

		apply: oc
			.route({
				method: "POST",
				path: "/apply",
				summary: "Apply enabled auto-approval rules to pending approvals",
				description:
					"Idempotent sweep: resolves every pending tedi approval request whose action kind matches an enabled rule, through the same canonical resolution path a human resolve uses, with the rule id recorded in the resolution note. Already-resolved and expired approvals are skipped cleanly.",
			})
			.output(
				z.object({
					/** How many approvals this sweep actually resolved. */
					resolved: z.number().int().nonnegative(),
					/** The approval→rule pairing for every resolution in this sweep. */
					ruleMatches: z.array(OsApprovalRuleMatchSchema),
				}),
			),
	});

export type OsApprovalRulesContract = typeof osApprovalRulesContract;
