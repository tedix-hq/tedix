import * as z from "zod";

const OpenApiWidgetColumnSchema = z.object({
	field: z.string().min(1).describe("Field path in each row object."),
	header: z
		.string()
		.min(1)
		.optional()
		.describe("Column label. Defaults to a title-cased field name."),
	format: z
		.enum(["text", "number", "currency", "percent", "date", "badge"])
		.optional(),
	align: z.enum(["left", "center", "right"]).optional(),
	sortable: z.boolean().optional(),
	width: z.string().min(1).optional(),
});
export const OpenApiWidgetDefaultsSchema = z.object({
	enabled: z
		.boolean()
		.optional()
		.describe("Set false to skip default json-render widget generation."),
	layoutId: z
		.string()
		.min(1)
		.optional()
		.describe("Widget route/layout id. Defaults to the output array key."),
	title: z
		.string()
		.min(1)
		.optional()
		.describe("Optional heading text. Defaults to the output array label."),
	showTitle: z.boolean().optional().describe("Defaults to true."),
	dataPath: z
		.string()
		.min(1)
		.optional()
		.describe(
			"JSON Pointer state path for table rows, e.g. /deployments. Defaults to the first top-level output array.",
		),
	columns: z
		.array(OpenApiWidgetColumnSchema)
		.optional()
		.describe("Explicit table columns. Defaults to scalar output fields."),
	columnLimit: z
		.number()
		.int()
		.positive()
		.max(24)
		.optional()
		.describe("Maximum generated columns when columns is omitted."),
	pageSize: z.number().int().positive().max(100).optional(),
	compact: z.boolean().optional(),
	striped: z.boolean().optional(),
});
