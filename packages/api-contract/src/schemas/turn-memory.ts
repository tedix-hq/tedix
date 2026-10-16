import * as z from "zod";

export const TurnMemoryInputSchema = z.object({
	tediId: z.string().min(1),
	references: z.array(z.uuid()).max(100),
});

export const TaskStateSnapshotSchema = z.object({
	id: z.string(),
	kind: z.enum(["work", "approval"]),
	state: z.string(),
	title: z.string(),
	deadline: z.string().nullable(),
});
export type TaskStateSnapshot = z.infer<typeof TaskStateSnapshotSchema>;

export const TurnMemoryOutputSchema = z.object({
	checkedAt: z.string(),
	preferences: z.array(z.object({ id: z.string(), content: z.string() })),
	tasks: z.array(TaskStateSnapshotSchema),
	unresolvedReferences: z.array(z.string()),
	truncated: z.boolean(),
});
export type TurnMemory = z.infer<typeof TurnMemoryOutputSchema>;
