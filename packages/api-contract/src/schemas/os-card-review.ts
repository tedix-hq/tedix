import * as z from "zod";
import { DeckNotUsefulReasonSchema } from "./deck-pipeline";
import { ProtectedEffectSchema } from "./decision-effects";

/**
 * Settings of the built-in Card review app: an OS app whose manifest entry is
 * `tedix:app/card-review` and whose `config` matches `CardReviewConfigSchema`.
 * The app shows a factory's card sheets one card at a time and writes each
 * verdict into the card row's own cells. Every tenant-specific choice —
 * workspaces, sheet titles, columns, what "Do it" means — lives here, never in
 * code.
 */
export const CARD_REVIEW_ENTRY = "tedix:app/card-review";

const header = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.describe(
		"Sheet column header; matched case-insensitively, exactly or as the start of the header",
	);

/**
 * What a run_skill Do it can do. archive, mark_read, label, unsubscribe and
 * reply_draft change the owner's mailbox and need organise access; work files
 * a Tedix Work item with the card's context. bundle is a card that lists
 * several tidy-ups ("3 tidy-ups: Unsubscribe (Weekly News); Label as
 * Receipts (Shop)"): each listed action runs on its own thread by these same
 * rules, and the ones that map to no kind become one Work item.
 */
export const CARD_ACTION_KINDS = [
	"archive",
	"mark_read",
	"label",
	"unsubscribe",
	"reply_draft",
	"bundle",
	"work",
] as const;
export const CardActionKindSchema = z.enum(CARD_ACTION_KINDS);
export type CardActionKind = z.infer<typeof CardActionKindSchema>;

export const CardReviewRunSchema = z
	.object({
		skillId: z
			.string()
			.min(1)
			.max(200)
			.describe(
				"Skill linked to the source workspace under Skills and schedules; it runs with params {cardSheetId, row, kind, action, reason, columns, actions, workProjectId}",
			),
		workProjectId: z
			.string()
			.uuid()
			.optional()
			.describe("Project a work card is filed in"),
		actions: z
			.array(
				z
					.object({
						kind: CardActionKindSchema,
						match: z
							.array(z.string().trim().min(1).max(80))
							.min(1)
							.max(10)
							.describe(
								"Case-insensitive text found in the card's type or action cell",
							),
					})
					.strict(),
			)
			.max(10)
			.default([])
			.describe(
				"First match wins, checked in order against the type cell, then the action cell; a card matching none is filed as work",
			),
	})
	.strict();
export type CardReviewRun = z.infer<typeof CardReviewRunSchema>;

const featureName = z
	.string()
	.trim()
	.regex(/^[a-z][a-z0-9_]{0,39}$/, "Use a short snake_case feature name");

/**
 * How a factory ranks its own cards. The factory computes `score` (0–1) and
 * `features` when it writes a card row; the OS only re-sorts, caps and dedupes.
 */
const FeatureWeightsSchema = z
	.record(featureName, z.number().finite().min(-100).max(100))
	.refine((weights) => Object.keys(weights).length <= 30, {
		message: "At most 30 weights",
	});

export const CardScoringSchema = z
	.object({
		weights: FeatureWeightsSchema.default({}).describe(
			"Factory default weight per feature; the factory's score is the weighted sum it wrote",
		),
		reviewerWeights: z
			.record(z.string().trim().min(1).max(200), FeatureWeightsSchema)
			.refine((reviewers) => Object.keys(reviewers).length <= 20, {
				message: "At most 20 reviewers",
			})
			.optional()
			.describe(
				"Accepted per-reviewer weights by the reviewer's user id; reviewers without an entry use weights",
			),
		topN: z
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.describe(
				"Cards shown per run day, best score first; ties keep sheet order",
			),
		maxAgeDays: z
			.number()
			.int()
			.min(1)
			.max(365)
			.optional()
			.describe("Hide cards from runs older than this many days"),
		skipReasonChips: z
			.array(
				z
					.object({
						label: z.string().trim().min(1).max(40),
						mapsTo: DeckNotUsefulReasonSchema.nullable().describe(
							"Shared Not useful reason this chip teaches, or null for a factory-only reason",
						),
					})
					.strict(),
			)
			.max(8)
			.default([])
			.describe(
				"Not useful chips for this factory; they replace reasonChips.notUseful",
			),
		weightUpdate: z
			.object({
				cadence: z.literal("weekly"),
				mode: z.enum(["off", "shadow", "enforce"]),
				minSamples: z
					.number()
					.int()
					.min(1)
					.max(10_000)
					.describe(
						"Verdicts with features needed before weights are proposed, per source and per reviewer",
					),
				maxChange: z
					.number()
					.finite()
					.min(0.01)
					.max(10)
					.optional()
					.describe(
						"Largest change one weekly proposal may make to one weight; default 0.25",
					),
				reasonWeights: z
					.record(
						z.string().trim().min(1).max(40),
						z.number().finite().min(0).max(1),
					)
					.refine((reasons) => Object.keys(reasons).length <= 20, {
						message: "At most 20 reason weights",
					})
					.optional()
					.describe(
						"How much a Not useful verdict counts, by skip chip label or shared reason, from 0 to 1; overrides the defaults",
					),
			})
			.strict()
			.optional()
			.describe(
				"How verdicts retune the weights each week; shadow only reports, enforce proposes through the rules sheet and applies accepted proposals",
			),
		agentDecidableClasses: z
			.array(z.string().trim().min(1).max(100))
			.max(50)
			.default([])
			.describe(
				"Card types each person can earn quiet delivery for: factory:<label>:<type> after unchanged Do it verdicts, with audits; protected and reserved classes never graduate",
			),
	})
	.strict();
export type CardScoring = z.infer<typeof CardScoringSchema>;

export const CardReviewSourceSchema = z
	.object({
		label: z
			.string()
			.trim()
			.min(1)
			.max(40)
			.describe('Plain name of this card source, e.g. "Inbox"'),
		workspaceId: z
			.string()
			.uuid()
			.describe("Workspace whose card sheets this source reads"),
		cardSheetPrefix: z
			.string()
			.min(1)
			.max(200)
			.describe(
				'Title prefix of the card sheets, e.g. "Inbox cards "; the newest sheets are reviewed first',
			),
		maxRuns: z
			.number()
			.int()
			.min(1)
			.max(20)
			.default(3)
			.describe("How many of the newest card sheets to review"),
		columns: z
			.object({
				number: header.optional(),
				type: header.optional(),
				source: header,
				who: header.optional(),
				why: header,
				action: header
					.optional()
					.describe(
						'Short concrete action that names the Do it button, e.g. "Draft a reply to Mia"; an empty cell hides the button',
					),
				draft: header.optional(),
				useful: header.describe("Verdict column written yes or no"),
				reason: header.describe("Column receiving the reason text"),
				done: header.describe(
					'Column written yes by "Do it" (e.g. "Approve action?" or "Did it?")',
				),
				result: header
					.optional()
					.describe(
						'Column a run_skill Do it writes its outcome to: "Done ✓", "Draft ready", "Filed as Work /work/items/<id>" or "Failed: <reason>". The run adds it to a sheet that lacks it',
					),
				score: header
					.optional()
					.describe("Factory score from 0 to 1, written with the card"),
				features: header
					.optional()
					.describe(
						'Compact JSON object of named numeric score inputs, e.g. {"fresh":0.9,"intent":0.6}',
					),
				effort: header
					.optional()
					.describe('Effort chip on the card face, e.g. "5 min"'),
				timing: header
					.optional()
					.describe('Timing chip on the card face, e.g. "Today"'),
			})
			.strict(),
		doIt: z
			.enum(["approve", "copy_and_open", "run_skill"])
			.describe(
				"approve: mark the done column yes and change nothing else; copy_and_open: copy the draft, open the source link, mark done; run_skill: start the skill in run at once to carry out the card's action and show its outcome. None of them sends or posts anything",
			),
		run: CardReviewRunSchema.optional().describe(
			"Required for doIt run_skill: which skill carries the action out and how card actions map to kinds",
		),
		doItLabel: z.string().trim().min(1).max(40).optional(),
		rules: z
			.object({
				sheetTitle: header,
				idColumn: header,
				textColumn: header,
				statusColumn: header,
			})
			.strict()
			.optional()
			.describe(
				'Rules sheet in the same workspace; rows with status "proposed" are offered for Accept (accepted) or Reject (rejected)',
			),
		feedbackSheetTitle: header
			.optional()
			.describe("Feedback log sheet the factory appends verdicts to"),
		reasonChips: z
			.object({
				useful: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
				notUseful: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
			})
			.strict()
			.optional()
			.describe("One-tap reasons written into the reason column"),
		channels: z
			.array(
				z
					.object({
						label: z.string().trim().min(1).max(40),
						match: z
							.array(z.string().trim().min(1).max(80))
							.min(1)
							.max(10)
							.describe(
								"Case-insensitive text found in the card's source, who or type cells",
							),
					})
					.strict(),
			)
			.max(10)
			.optional()
			.describe(
				"Filter labels such as LinkedIn or X; a card matching none uses the source label",
			),
		scoring: CardScoringSchema.optional().describe(
			"Score-based ranking, caps and skip reasons; without it cards keep sheet order",
		),
		protectedEffects: z
			.array(ProtectedEffectSchema)
			.max(7)
			.optional()
			.describe(
				"Effects this factory's cards carry when promoted to Work; they keep a person in the loop",
			),
	})
	.strict()
	.refine((source) => source.doIt !== "run_skill" || source.run, {
		message: "doIt run_skill needs run settings",
		path: ["run"],
	});

export const CardReviewConfigSchema = z
	.object({
		version: z.literal(1),
		sources: z.array(CardReviewSourceSchema).min(1).max(10),
	})
	.strict();

export type CardReviewSource = z.infer<typeof CardReviewSourceSchema>;
export type CardReviewConfig = z.infer<typeof CardReviewConfigSchema>;

const ProposalWeightsSchema = z.record(z.string(), z.number().finite());

/**
 * One weekly weight proposal for a factory source, kept on the organization.
 * The stored weights are the only ones ever applied; the rules sheet row only
 * carries the person's Accept or Reject.
 */
export const FactoryWeightProposalSchema = z
	.object({
		id: z.string().min(1).max(100),
		factoryKey: z.string().min(1).max(400),
		sourceLabel: z.string().min(1).max(40),
		workspaceId: z.string().min(1).max(100),
		mode: z.enum(["shadow", "enforce"]),
		createdAt: z.string().min(1).max(40),
		status: z.enum([
			"insufficient",
			"no_change",
			"shadow",
			"proposed",
			"applied",
			"rejected",
			"stale",
		]),
		ruleId: z.string().max(200).nullable(),
		previousWeights: ProposalWeightsSchema,
		weights: ProposalWeightsSchema,
		previousReviewerWeights: z.record(z.string(), ProposalWeightsSchema),
		reviewerWeights: z.record(z.string(), ProposalWeightsSchema),
		report: z
			.object({
				samples: z.number().int().min(0),
				positives: z.number().int().min(0),
				negatives: z.number().int().min(0),
				heldOut: z.number().int().min(0),
				accuracyBefore: z.number().min(0).max(1).nullable(),
				accuracyAfter: z.number().min(0).max(1).nullable(),
				topN: z.number().int().min(1),
				topNChanged: z.number().int().min(0),
				reasons: z.record(z.string(), z.number().int().min(0)),
				reviewers: z.number().int().min(0),
				note: z.string().max(500).optional(),
			})
			.strict(),
		decidedAt: z.string().max(40).optional(),
		appliedTo: z
			.array(z.object({ gadgetId: z.string(), revision: z.number().int() }))
			.max(20)
			.optional(),
	})
	.strict();
export type FactoryWeightProposal = z.infer<typeof FactoryWeightProposalSchema>;
