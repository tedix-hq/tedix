/**
 * Approver-editable fields on an approval request.
 *
 * A pending action may declare a few top-level inputs the approver can change
 * before approving (destination, title, recipients). Each declaration carries
 * the tool input schema for that property, so an edit is validated against the
 * same schema the tool publishes.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

export const MAX_APPROVAL_EDITABLE_FIELDS = 8;

export const ApprovalEditableFieldSchema = z.strictObject({
	name: z.string().min(1).max(100),
	label: z.string().min(1).max(120),
	description: z
		.string()
		.max(500)
		.optional()
		.describe("Tool-provided help text; absent when the schema has none."),
	required: z.boolean(),
	schema: z
		.record(z.string(), JsonValueSchema)
		.describe("The tool input schema for this property."),
});
export type ApprovalEditableField = z.infer<typeof ApprovalEditableFieldSchema>;

export const ApprovalEditableFieldsSchema = z
	.array(ApprovalEditableFieldSchema)
	.max(MAX_APPROVAL_EDITABLE_FIELDS);

export const ApprovalEditsInputSchema = z
	.record(z.string().min(1).max(100), JsonValueSchema)
	.refine(
		(edits) => Object.keys(edits).length <= MAX_APPROVAL_EDITABLE_FIELDS,
		`At most ${MAX_APPROVAL_EDITABLE_FIELDS} fields can be changed`,
	);

export const ApprovalFieldChangeSchema = z.strictObject({
	field: z.string(),
	before: JsonValueSchema.describe("Null when the agent left the field unset."),
	after: JsonValueSchema,
});
export type ApprovalFieldChange = z.infer<typeof ApprovalFieldChangeSchema>;

/** Stored on the approval payload when the approver changed the action. */
export const ApproverEditsRecordSchema = z.strictObject({
	editedBy: z.string(),
	editedAt: z.string(),
	changes: z.array(ApprovalFieldChangeSchema).max(MAX_APPROVAL_EDITABLE_FIELDS),
});
export type ApproverEditsRecord = z.infer<typeof ApproverEditsRecordSchema>;
