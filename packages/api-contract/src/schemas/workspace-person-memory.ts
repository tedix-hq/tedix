/**
 * What the workspace store sends when its agent reads the personal memory of
 * the person who sent a chat turn. The store only names who is acting; the
 * API checks again, when the read is made, that the person is an active
 * member and that nobody but them can open the workspace.
 */

import * as z from "zod";

export const PERSON_MEMORY_MAX_RECORDS = 20;

export const WorkspacePersonMemoryInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	workspaceId: z.string().min(1),
	/** The signed-in person who sent the turn. */
	userId: z.string().min(1),
	/** Words to rank the records by; without them the most important come first. */
	query: z.string().max(500).optional(),
	limit: z.number().int().min(1).max(PERSON_MEMORY_MAX_RECORDS).optional(),
});

export type WorkspacePersonMemoryInput = z.input<
	typeof WorkspacePersonMemoryInputSchema
>;

export interface PersonMemoryRecord {
	id: string;
	content: string;
	updatedAt: string | null;
}

export type WorkspacePersonMemoryResult =
	| { status: "memory"; records: PersonMemoryRecord[] }
	| { status: "refused"; message: string };
