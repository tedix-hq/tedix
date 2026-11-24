import { z } from "zod";

export const PublishAppDraftSchema = z.strictObject({
	appId: z.string().uuid(),
	proposalId: z.string().uuid(),
	expectedSequence: z.number().int().nonnegative(),
	rationale: z.string().trim().min(1).max(2000),
});
export type PublishAppDraft = z.infer<typeof PublishAppDraftSchema>;

/** Only the workspace store supplies the sender and source, never sandbox code. */
export const WorkspacePublishAppDraftSchema = PublishAppDraftSchema.extend({
	organizationId: z.string().min(1),
	workspaceId: z.string().uuid(),
	conversationId: z.string().uuid(),
	turnId: z.string().uuid(),
	userId: z.string().min(1),
});
export type WorkspacePublishAppDraft = z.infer<
	typeof WorkspacePublishAppDraftSchema
>;

export interface StagedAppDraft {
	appId: string;
	name: string;
	proposalId: string;
	sequence: number;
	baseRevisionId: string;
	files: string[];
}
