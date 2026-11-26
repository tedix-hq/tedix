import { z } from "zod";
import { JsonValueSchema } from "./common";

export const WorkspaceConnectionActorSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("user"), id: z.string().min(1) }),
	z.strictObject({ kind: z.literal("tedi"), tediId: z.string().min(1) }),
	z.strictObject({ kind: z.literal("schedule") }),
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
	/** Omitted for the existing read-only callers. Writes always require review. */
	operation: z.enum(["read", "write"]).optional(),
	approvalRequestId: z.uuid().optional(),
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

export const WorkspaceConnectionDecisionInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	workspaceId: z.string().min(1),
	conversationId: z.string().min(1),
	approvalRequestId: z.uuid(),
	by: z.string().min(1),
	decision: z.enum(["approve", "deny"]),
});

export type WorkspaceConnectionDecisionInput = z.infer<
	typeof WorkspaceConnectionDecisionInputSchema
>;
export type WorkspaceConnectionDecisionResult =
	| { status: "approved" | "denied" }
	| { status: "refused"; message: string };
