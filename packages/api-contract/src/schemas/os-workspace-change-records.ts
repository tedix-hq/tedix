import * as z from "zod";

const timestamp = z
	.string()
	.datetime({ offset: true })
	.transform((value) => new Date(value).toISOString());

export const OsWorkspaceChangeRecordsInputSchema = z
	.object({
		workspaceId: z.string().uuid(),
		from: timestamp.describe("Inclusive start of the recorded-at time range"),
		until: timestamp.describe("Exclusive end of the recorded-at time range"),
		afterSequence: z.number().int().nonnegative().optional(),
		limit: z.number().int().min(1).max(200).default(100),
	})
	.refine((input) => input.from < input.until, {
		message: "from must precede until",
		path: ["until"],
	});

// Preserve the complete governance record, including approval and undo evidence.
export const OsWorkspaceChangeRecordsExportSchema = z.object({
	workspaceId: z.string().uuid(),
	from: z.string(),
	until: z.string(),
	exportedAt: z.string(),
	count: z
		.number()
		.int()
		.nonnegative()
		.describe(
			"Total records in the time range, independent of page size and cursor",
		),
	records: z.array(
		z.looseObject({
			id: z.string(),
			sequence: z.number().int(),
			recordedAt: z.string(),
			resource: z.string(),
			operation: z.string(),
		}),
	),
	nextAfterSequence: z.number().int().nullable(),
});

export type OsWorkspaceChangeRecordsQuery = Omit<
	z.infer<typeof OsWorkspaceChangeRecordsInputSchema>,
	"workspaceId"
>;
export type OsWorkspaceChangeRecordsExport = z.infer<
	typeof OsWorkspaceChangeRecordsExportSchema
>;
