import * as z from "zod";
import {
	WorkItemAcceptanceContractSchema,
	WorkItemKindSchema,
	WorkItemRiskLevelSchema,
} from "./work-items";

const key = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const text = z.string().trim().min(1).max(2_000);

/** Portable operating design, never an execution grant or mutable run ledger. */
export const FactoryBlueprintSchema = z
	.object({
		version: z.literal(1),
		key,
		purpose: text,
		beneficiary: text,
		exclusions: z.array(text).min(1).max(20),
		stewardRole: text,
		intake: z
			.object({
				triggers: z
					.array(z.enum(["manual", "schedule", "source_change"]))
					.min(1)
					.max(3),
				sourcePolicy: text,
				maxSourceRefs: z.number().int().min(1).max(50),
			})
			.strict(),
		limits: z
			.object({
				maxAttemptsPerCycle: z.number().int().min(1).max(5),
				budgetMicrosPerCycle: z.number().int().positive().max(1_000_000_000),
			})
			.strict(),
		templates: z
			.array(
				z
					.object({
						key,
						title: z.string().trim().min(1).max(200),
						workKind: WorkItemKindSchema,
						riskLevel: WorkItemRiskLevelSchema,
						outcome: z.enum(["deliverable", "no_work"]),
						procedure: z.string().trim().min(1).max(6_000),
						requiredCapabilities: z.array(text).max(30),
						requiredAuthorities: z.array(text).max(20),
						acceptanceContract: WorkItemAcceptanceContractSchema,
					})
					.strict(),
			)
			.min(2)
			.max(10),
		maintenance: z
			.object({
				successMetric: text,
				/**
				 * Retired: independent review is no longer part of the factory
				 * handoff (decisions/minimal-gates-over-pre-proof.md), so
				 * no authored blueprint carries it and nothing reads it. It stays
				 * declared and optional because this schema parses immutable
				 * blueprint revisions already stored in D1 — dropping the key
				 * from a strict object would turn one past write into a
				 * permanent read failure for every installed factory workspace.
				 */
				reviewPolicy: text
					.optional()
					.describe(
						"Retired legacy key. Absent on every authored blueprint and read by nothing; still declared so blueprint revisions already stored in D1 keep parsing.",
					),
				upgradePolicy: z.literal("explicit_pinned_revision"),
				certificationScenarios: z
					.array(
						z.enum([
							"normal",
							"no_work",
							"duplicate",
							"interruption",
							"rejection",
							"approval_blocked",
							"second_instance",
						]),
					)
					.length(7),
			})
			.strict(),
	})
	.strict()
	.superRefine((factory, ctx) => {
		if (
			new Set(factory.templates.map((item) => item.key)).size !==
			factory.templates.length
		) {
			ctx.addIssue({
				code: "custom",
				path: ["templates"],
				message: "Factory template keys must be unique",
			});
		}
		if (!factory.templates.some((item) => item.outcome === "no_work")) {
			ctx.addIssue({
				code: "custom",
				path: ["templates"],
				message: "A reviewed no-work template is required",
			});
		}
		if (!factory.templates.some((item) => item.outcome === "deliverable")) {
			ctx.addIssue({
				code: "custom",
				path: ["templates"],
				message: "A deliverable template is required",
			});
		}
		// Independent review is no longer a completion requirement
		// (decisions/minimal-gates-over-pre-proof.md), so a blueprint may
		// omit the claim/evidence shape entirely. Stored blueprints that still
		// carry it keep parsing unchanged.
		if (new Set(factory.maintenance.certificationScenarios).size !== 7) {
			ctx.addIssue({
				code: "custom",
				path: ["maintenance", "certificationScenarios"],
				message: "Every certification scenario must be represented once",
			});
		}
	});

export type FactoryBlueprint = z.infer<typeof FactoryBlueprintSchema>;
