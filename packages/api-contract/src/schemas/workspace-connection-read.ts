import { z } from "zod";
import { JsonValueSchema } from "./common";

export const WorkspaceConnectionActorSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("user"), id: z.string().min(1) }),
	z.strictObject({
		kind: z.literal("unattended"),
		startedBy: z.enum(["schedule", "tedi"]),
		tediId: z.string().min(1).optional(),
	}),
]);

export const WorkspaceConnectionReadInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	workspaceId: z.string().min(1),
	resourceId: z.string().min(1),
	/** Exact configured tool ID; ambiguous names are refused. */
	toolName: z.string().min(1),
	args: z.record(z.string(), JsonValueSchema),
	conversationId: z.string().min(1),
	actor: WorkspaceConnectionActorSchema,
});

export const WorkspaceConnectionReadResultSchema = z.discriminatedUnion(
	"status",
	[
		z.strictObject({ status: z.literal("ok"), result: JsonValueSchema }),
		z.strictObject({
			status: z.literal("not_connected"),
			providerId: z.string().min(1),
			scope: z.enum(["user", "tenant"]),
			connectPath: z.string().min(1),
		}),
		z.strictObject({
			status: z.literal("approval_required"),
			approvalId: z.uuid(),
		}),
		z.strictObject({
			status: z.literal("refused"),
			message: z.string().min(1),
		}),
	],
);

export type WorkspaceConnectionActor = z.infer<
	typeof WorkspaceConnectionActorSchema
>;
export type WorkspaceConnectionReadInput = z.infer<
	typeof WorkspaceConnectionReadInputSchema
>;
export type WorkspaceConnectionReadResult = z.infer<
	typeof WorkspaceConnectionReadResultSchema
>;
