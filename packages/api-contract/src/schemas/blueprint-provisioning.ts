import * as z from "zod";
import { JsonValueSchema } from "./common";
import {
	WorkItemKindSchema,
	WorkItemRiskLevelSchema,
	WorkItemAcceptanceContractSchema,
} from "./work-items";

const key = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const text = z.string().min(1).max(20_000);
const parameter = z
	.object({
		type: z.enum(["string", "number", "boolean", "array", "object"]),
		required: z.boolean().default(true),
	})
	.strict();

const target = z.union([
	z.string().max(100),
	z
		.object({
			parameter: z.string().min(1),
			offsetMinutes: z.number().int().min(-525600).max(525600),
		})
		.strict(),
]);

/** Portable setup data. Installing it never accepts or claims Work. */
export const BlueprintProvisioningSchema = z
	.object({
		version: z.literal(1),
		parameters: z
			.record(
				z
					.string()
					.regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/)
					.refine(
						(name) => !["workspaceId", "projectId"].includes(name),
						"Reserved parameter name",
					),
				parameter,
			)
			.default({}),
		project: z
			.object({
				key,
				name: z.string().min(1).max(200),
				description: text.optional(),
				targetAt: target.optional(),
			})
			.strict()
			.optional(),
		milestones: z
			.array(
				z
					.object({
						key,
						title: z.string().min(1).max(200),
						description: text.optional(),
						targetAt: target.optional(),
					})
					.strict(),
			)
			.max(100)
			.default([]),
		workItems: z
			.array(
				z
					.object({
						key,
						title: z.string().min(1).max(500),
						description: text,
						doneWhen: WorkItemAcceptanceContractSchema.shape.doneLooksLike
							.unwrap()
							.min(1),
						workKind: WorkItemKindSchema.default("operations"),
						riskLevel: WorkItemRiskLevelSchema.default("medium"),
						dependsOn: z.array(key).max(100).default([]),
						milestone: key.optional(),
						suggestedOwners: z
							.array(z.string().min(1).max(300))
							.max(50)
							.default([]),
					})
					.strict(),
			)
			.max(200)
			.default([]),
		documents: z
			.array(
				z
					.object({
						key,
						title: z.string().min(1).max(300),
						text,
					})
					.strict(),
			)
			.max(50)
			.default([]),
		schedules: z
			.array(
				z
					.object({
						key,
						name: z.string().min(1).max(200),
						cron: z.string().min(1).max(100),
						procedure: text,
						enabled: z.boolean().default(false),
						/** Optional existing executable skill in the installing organization. */
						skillId: z.string().max(100).optional(),
						params: z.record(z.string(), JsonValueSchema).default({}),
					})
					.strict(),
			)
			.max(20)
			.default([]),
	})
	.strict()
	.superRefine((plan, ctx) => {
		for (const field of [
			"milestones",
			"workItems",
			"documents",
			"schedules",
		] as const) {
			if (
				new Set(plan[field].map((row) => row.key)).size !== plan[field].length
			)
				ctx.addIssue({
					code: "custom",
					path: [field],
					message: "Template keys must be unique",
				});
		}
		if (!plan.project && (plan.milestones.length || plan.workItems.length))
			ctx.addIssue({
				code: "custom",
				path: ["project"],
				message: "Work and milestones require a project",
			});
		const items = new Map(plan.workItems.map((row) => [row.key, row]));
		const milestones = new Set(plan.milestones.map((row) => row.key));
		const visited = new Set<string>();
		const visiting = new Set<string>();
		function visit(id: string): boolean {
			if (visiting.has(id)) return false;
			if (visited.has(id)) return true;
			const item = items.get(id);
			if (!item) return false;
			visiting.add(id);
			for (const dependency of item.dependsOn)
				if (!visit(dependency)) return false;
			visiting.delete(id);
			visited.add(id);
			return true;
		}
		for (const [index, item] of plan.workItems.entries()) {
			if (!visit(item.key))
				ctx.addIssue({
					code: "custom",
					path: ["workItems", index, "dependsOn"],
					message: "Unknown dependency or dependency cycle",
				});
			if (new Set(item.dependsOn).size !== item.dependsOn.length)
				ctx.addIssue({
					code: "custom",
					path: ["workItems", index, "dependsOn"],
					message: "Duplicate dependency",
				});
			if (item.milestone && !milestones.has(item.milestone))
				ctx.addIssue({
					code: "custom",
					path: ["workItems", index, "milestone"],
					message: "Unknown milestone",
				});
		}
	});
export type BlueprintProvisioning = z.infer<typeof BlueprintProvisioningSchema>;

export const BlueprintApplyInputSchema = z.object({
	blueprintId: z.uuid(),
	instanceKey: z.string().min(1).max(120),
	tediId: z.uuid().optional(),
	workspaceName: z.string().trim().min(1).max(120),
	parameters: z.record(z.string(), JsonValueSchema).default({}),
	expectedPlanSha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});

export const BlueprintApplyReceiptSchema = z.object({
	workspaceId: z.uuid(),
	revisionId: z.uuid(),
	instanceKey: z.string(),
	planSha256: z.string().regex(/^[a-f0-9]{64}$/),
	replayed: z.boolean(),
	resources: z.array(
		z.object({
			kind: z.enum([
				"project",
				"milestone",
				"work_item",
				"dependency",
				"document",
				"schedule",
				"app",
			]),
			key: z.string(),
			id: z.uuid(),
		}),
	),
});
export type BlueprintApplyReceipt = z.infer<typeof BlueprintApplyReceiptSchema>;
