import * as z from "zod";

/**
 * Row review: a Deck card that asks a person to confirm or correct a list of
 * proposed sheet rows in one answer. An agent stores the proposal as
 * `metadata.rowReview` on a question or input interaction and marks the
 * metadata `schema` {@link ROW_REVIEW_SCHEMA}. The answer writes the verdict
 * and any correction back into the sheet's named columns as a new revision,
 * then resolves the interaction so the answer is linked on its Work Item.
 */
export const ROW_REVIEW_SCHEMA = "tedix.row-review.v1";
export const ROW_REVIEW_RESULT_SCHEMA = "tedix.row-review-result.v1";

/** The named sheet the proposal was read from; the answer fences this revision. */
export const RowReviewSheetRefSchema = z.strictObject({
	outputId: z.uuid(),
	title: z.string().trim().min(1).max(300),
	revision: z.number().int().positive(),
});

/** Which sheet headers the verdict and correction are written into. */
export const RowReviewColumnsSchema = z.strictObject({
	status: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.describe("Header receiving the verdict text: confirmed or corrected."),
	correction: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.describe(
			"Header receiving the person's correction text; confirmed rows clear it.",
		),
});

/** One proposed row shown to the person, identified by its sheet row index. */
export const RowReviewRowSchema = z.strictObject({
	row: z
		.number()
		.int()
		.nonnegative()
		.describe("Zero-based index into the sheet's rows."),
	label: z
		.string()
		.trim()
		.min(1)
		.max(300)
		.describe("What the row is, in plain words."),
	proposal: z
		.string()
		.trim()
		.min(1)
		.max(2_000)
		.describe("The proposed values the person confirms or corrects."),
});

export const RowReviewSpecSchema = z.strictObject({
	sheet: RowReviewSheetRefSchema,
	columns: RowReviewColumnsSchema,
	rows: z
		.array(RowReviewRowSchema)
		.min(1)
		.max(25)
		.refine(
			(rows) => new Set(rows.map((row) => row.row)).size === rows.length,
			"Each sheet row may appear once",
		),
});
export type RowReviewSpec = z.infer<typeof RowReviewSpecSchema>;

export const RowReviewVerdictSchema = z.enum(["confirmed", "corrected"]);
export const RowReviewRowVerdictSchema = z
	.strictObject({
		row: z.number().int().nonnegative(),
		verdict: RowReviewVerdictSchema,
		correction: z
			.string()
			.trim()
			.min(1)
			.max(4_000)
			.optional()
			.describe("The corrected value; required when the verdict is corrected."),
	})
	.superRefine((value, context) => {
		if (value.verdict === "corrected" && !value.correction) {
			context.addIssue({
				code: "custom",
				message: "A corrected row needs its correction text",
				path: ["correction"],
			});
		}
		if (value.verdict === "confirmed" && value.correction !== undefined) {
			context.addIssue({
				code: "custom",
				message: "A confirmed row carries no correction",
				path: ["correction"],
			});
		}
	});
export type RowReviewRowVerdict = z.infer<typeof RowReviewRowVerdictSchema>;
