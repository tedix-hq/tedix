import * as z from "zod";
import {
	WorkItemDispositionSchema,
	WorkItemPrioritySchema,
} from "./work-items";

export const WorkMapReadInputSchema = z
	.object({
		stalledAfterHours: z.number().int().min(1).max(168).default(12),
	})
	.default({ stalledAfterHours: 12 });

/** Who must act. `unassigned` is explicit: nobody owns it yet. */
export const WorkMapActorSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.enum(["user", "tedi", "team", "system", "external_agent"]),
		id: z.string().min(1).max(300),
	}),
	z.object({ type: z.literal("unassigned") }),
]);
export type WorkMapActor = z.infer<typeof WorkMapActorSchema>;

export const WorkMapSignalKindSchema = z.enum([
	"stalled",
	"held",
	"waiting_on_person",
	"waiting_for_approval",
	"blocked",
	"overlap",
	"conflict",
	"orphan",
]);
export type WorkMapSignalKind = z.infer<typeof WorkMapSignalKindSchema>;

export const WorkMapSignalSchema = z.object({
	kind: WorkMapSignalKindSchema,
	/** One plain sentence: why. */
	reason: z.string().min(1).max(600),
	/** When the condition began, when known. */
	since: z.iso.datetime().nullable(),
	actor: WorkMapActorSchema,
	relatedWorkItemId: z.string().optional(),
	interactionId: z.string().optional(),
});
export type WorkMapSignal = z.infer<typeof WorkMapSignalSchema>;

export const WorkMapItemSchema = z.object({
	id: z.string(),
	title: z.string(),
	disposition: WorkItemDispositionSchema,
	priority: WorkItemPrioritySchema,
	parentId: z.string().nullable(),
	projectId: z.string().nullable(),
	objectiveId: z.string().nullable(),
	executor: z.string().nullable(),
	attemptState: z.string().nullable(),
	lastEventAt: z.iso.datetime().nullable(),
	signals: z.array(WorkMapSignalSchema),
});
export type WorkMapItem = z.infer<typeof WorkMapItemSchema>;

export const WorkMapEpicSchema = z.object({
	id: z.string(),
	title: z.string(),
	disposition: WorkItemDispositionSchema,
	parentId: z.string().nullable(),
	projectId: z.string().nullable(),
	objectiveId: z.string().nullable(),
	progress: z.object({
		total: z.number().int().min(0),
		completed: z.number().int().min(0),
		cancelled: z.number().int().min(0),
		open: z.number().int().min(0),
		/** completed / (total - cancelled), 0..1 */
		percentDone: z.number().min(0).max(1),
	}),
});
export type WorkMapEpic = z.infer<typeof WorkMapEpicSchema>;

export const WorkMapLaneSchema = z.object({
	id: z.string(),
	reporterId: z.string(),
	kind: z.enum(["supervisor", "runner", "duty"]),
	executor: z.string(),
	lane: z.string(),
	/** up: heartbeat fresh; late: one beat missed; down: no heartbeat; stopped: reported not running; unknown: its supervisor is down. */
	state: z.enum(["up", "late", "down", "stopped", "unknown"]),
	reason: z.string().max(600),
	reportedAt: z.iso.datetime().nullable(),
	ageSeconds: z.number().int().min(0).nullable(),
	downAfterSeconds: z.number().int().positive(),
	slotsInUse: z.number().int().min(0),
	slotsTotal: z.number().int().min(0),
	/** False when inferred from runner reports by a CLI without its own heartbeat. */
	heartbeat: z.boolean(),
});
export type WorkMapLane = z.infer<typeof WorkMapLaneSchema>;

export const WorkMapNotMovingSchema = z.object({
	workItemId: z.string(),
	title: z.string(),
	kind: WorkMapSignalKindSchema,
	blocker: z.string(),
	since: z.iso.datetime().nullable(),
	actor: WorkMapActorSchema,
	interactionId: z.string().optional(),
});
export type WorkMapNotMoving = z.infer<typeof WorkMapNotMovingSchema>;

export const WorkMapSchema = z.object({
	organizationId: z.string(),
	readAt: z.iso.datetime(),
	stalledAfterHours: z.number().int(),
	truncated: z.boolean(),
	objectives: z.array(z.object({ id: z.string(), title: z.string() })),
	projects: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			objectiveId: z.string().nullable(),
		}),
	),
	epics: z.array(WorkMapEpicSchema),
	items: z.array(WorkMapItemSchema),
	lanes: z.array(WorkMapLaneSchema),
	notMoving: z.array(WorkMapNotMovingSchema),
});
export type WorkMap = z.infer<typeof WorkMapSchema>;
