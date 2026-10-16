import * as z from "zod";

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
				action: header.optional(),
				draft: header.optional(),
				useful: header.describe("Verdict column written yes or no"),
				reason: header.describe("Column receiving the reason text"),
				done: header.describe(
					'Column written yes by "Do it" (e.g. "Approve action?" or "Did it?")',
				),
			})
			.strict(),
		doIt: z
			.enum(["approve", "copy_and_open"])
			.describe(
				"approve: mark the done column yes and change nothing else; copy_and_open: copy the draft, open the source link, mark done. Neither sends or posts anything",
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
	})
	.strict();

export const CardReviewConfigSchema = z
	.object({
		version: z.literal(1),
		sources: z.array(CardReviewSourceSchema).min(1).max(10),
	})
	.strict();

export type CardReviewSource = z.infer<typeof CardReviewSourceSchema>;
export type CardReviewConfig = z.infer<typeof CardReviewConfigSchema>;
