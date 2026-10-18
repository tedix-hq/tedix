import * as z from "zod";
import { LessonEvidenceSchema } from "./agent-session-lessons";

/** Uses the same canonical citations and held-evidence model as mined lessons. */
export const MemoryConsolidationSchema = z.object({
	version: z.literal(1),
	kind: z.enum(["observation", "standing_summary"]),
	entityKey: z.string(),
	topicKey: z.string().nullable(),
	revision: z.number().int().positive(),
	fingerprint: z.string(),
	state: z.enum(["live", "disputed", "retracted", "held"]),
	evidence: LessonEvidenceSchema,
	sourceHashes: z.record(z.string(), z.string()),
	scope: z.object({
		tediId: z.string().nullable(),
		visibility: z.string().nullable(),
		memoryScope: z.string().nullable(),
	}),
	observationIds: z.array(z.string()),
	firstSeen: z.string().nullable(),
	lastSeen: z.string().nullable(),
	previousVersionId: z.string().nullable(),
	isHistory: z.boolean().default(false),
	refresh: z.object({
		at: z.string(),
		reason: z.enum([
			"new_evidence",
			"source_changed",
			"source_invalidated",
			"contradiction",
		]),
		sourceFactIds: z.array(z.string()),
		removedSourceFactIds: z.array(z.string()),
		previousText: z.string().nullable(),
	}),
});
export type MemoryConsolidation = z.infer<typeof MemoryConsolidationSchema>;
