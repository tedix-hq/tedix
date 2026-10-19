import * as z from "zod";
import policy from "../config/work-specification-policy.v1.json";

export const memberEditableWorkFields: readonly string[] =
	policy.memberEditableFields;

/** Stored in project metadata; only an active owner/admin may change grants. */
export const WorkSpecificationContributorsSchema = z.strictObject({
	version: z.literal(1),
	userIds: z.array(z.string().min(1).max(300)).max(100),
});
