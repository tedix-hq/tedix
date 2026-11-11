import * as z from "zod";
import { JsonValueSchema } from "./common";

/**
 * The wire shape of a changed-only patch of a workspace file. The meaning of
 * each operation, and why parts are addressed this way, is documented with
 * `applyOutputPatch` in `utils/output-patch.ts`. A patch is bounded only by
 * the request that carries it; the content it produces is checked against
 * the content schema before it is stored.
 */
const segment = z.union([
	z
		.string()
		.min(1)
		.max(200)
		.describe('A property name, such as "deck" or "workbook"'),
	z
		.number()
		.int()
		.nonnegative()
		.describe("A position in a list: a sheet row, or a cell within a row"),
	z
		.strictObject({ id: z.string().min(1).max(200) })
		.describe("The list item with this id: a slide, an element, a sheet tab"),
]);
const path = z
	.array(segment)
	.min(1)
	.max(16)
	.describe(
		'Where the part is, from the content\'s root, e.g. ["deck","slides",{"id":"slide-2"},"elements",{"id":"title"},"text"] or ["workbook","sheets",{"id":"sheet-1"},"rows",4,2]',
	);

export const OsOutputContentPatchOpSchema = z.discriminatedUnion("op", [
	z
		.strictObject({ op: z.literal("set"), path, value: JsonValueSchema })
		.describe("Write one part: a property, a cell, or a whole list item"),
	z
		.strictObject({ op: z.literal("unset"), path })
		.describe("Remove a property"),
	z
		.strictObject({
			op: z.literal("arrange"),
			path,
			order: z
				.array(z.string().min(1).max(200))
				.describe(
					"Ids of the list's items in their new order; an item left out is removed",
				),
			insert: z
				.array(JsonValueSchema)
				.optional()
				.describe("Items the list does not hold yet, each with its id"),
		})
		.describe("Reorder, add to or remove from a list whose items carry ids"),
	z
		.strictObject({
			op: z.literal("splice"),
			path,
			hunks: z
				.array(
					z.strictObject({
						at: z.number().int().nonnegative(),
						remove: z.number().int().nonnegative(),
						insert: z.array(JsonValueSchema),
					}),
				)
				.min(1)
				.describe(
					"Runs to replace, in ascending order without overlap. `at` counts in the list as it is in the base revision.",
				),
		})
		.describe(
			"Replace runs of a list without ids: a document's top-level blocks (richText.content), or sheet rows when rows are inserted or removed",
		),
]);

export const OsOutputContentPatchSchema = z.strictObject({
	kind: z.enum(["document", "sheet", "presentation"]),
	ops: z.array(OsOutputContentPatchOpSchema).min(1),
});
export type OsOutputContentPatch = z.infer<typeof OsOutputContentPatchSchema>;
