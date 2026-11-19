import * as z from "zod";

/**
 * A narrow right for the tedi runtime's trusted service binding: read and
 * change the calling tedi's own core memory and notes. It reaches no other
 * tedi's memory and nothing else in the organization.
 */
export const TEDI_MEMORY_SCOPE = "tedi:memory";

/** The sections of a tedi's core memory, in the order they are shown. */
export const TEDI_CORE_MEMORY_SECTIONS = [
	{ key: "people", title: "How this person and team work" },
	{ key: "project", title: "This project" },
	{ key: "lessons", title: "What worked and what did not" },
	{ key: "open_threads", title: "Open threads" },
] as const;

export const TEDI_CORE_MEMORY_SECTION_KEYS = [
	"people",
	"project",
	"lessons",
	"open_threads",
] as const;
export type TediCoreMemorySectionKey =
	(typeof TEDI_CORE_MEMORY_SECTION_KEYS)[number];

/** Characters across all sections together. An edit that would pass it is refused. */
export const TEDI_CORE_MEMORY_LIMIT = 6000;
/** How many versions of the core memory are kept for history and restore. */
export const TEDI_CORE_MEMORY_VERSIONS_KEPT = 100;

export const TediMemoryAuthorSchema = z.object({
	type: z.enum(["tedi", "reflection", "user"]),
	id: z.string(),
});

const TediCoreMemorySectionSchema = z.object({
	key: z.enum(TEDI_CORE_MEMORY_SECTION_KEYS),
	title: z.string(),
	text: z.string(),
});

export const TediCoreMemorySchema = z.object({
	tediId: z.string(),
	/** 0 until the first change. */
	version: z.number().int().min(0),
	sections: z.array(TediCoreMemorySectionSchema),
	usedChars: z.number().int().min(0),
	limitChars: z.number().int(),
	updatedAt: z.string().nullable(),
});
export type TediCoreMemory = z.infer<typeof TediCoreMemorySchema>;

const TediIdSchema = z.string().trim().min(1).max(128);

export const ReadTediCoreMemoryInputSchema = z.object({ tediId: TediIdSchema });

export const EditTediCoreMemoryInputSchema = z.object({
	tediId: TediIdSchema,
	section: z.enum(TEDI_CORE_MEMORY_SECTION_KEYS),
	/** `replace` sets the section's text; `append` adds a line to it. */
	mode: z.enum(["replace", "append"]),
	text: z.string().max(TEDI_CORE_MEMORY_LIMIT),
	/** Set by the runtime when the change comes from a reflection turn. */
	origin: z.enum(["conversation", "reflection"]).optional(),
});

/** A refused edit changes nothing and says why. */
export const EditTediCoreMemoryOutputSchema = z.object({
	status: z.enum(["saved", "unchanged", "refused"]),
	reason: z.string().optional(),
	memory: TediCoreMemorySchema,
});
export type EditTediCoreMemoryOutput = z.infer<
	typeof EditTediCoreMemoryOutputSchema
>;

export const ListTediCoreMemoryVersionsInputSchema = z.strictObject({
	tediId: TediIdSchema,
	limit: z.number().int().min(1).max(TEDI_CORE_MEMORY_VERSIONS_KEPT).optional(),
});

export const ListTediCoreMemoryVersionsOutputSchema = z.object({
	versions: z.array(
		z.object({
			version: z.number().int(),
			sections: z.array(TediCoreMemorySectionSchema),
			usedChars: z.number().int(),
			changedBy: TediMemoryAuthorSchema,
			change: z.string(),
			createdAt: z.string(),
		}),
	),
});

export const RestoreTediCoreMemoryVersionInputSchema = z.object({
	tediId: TediIdSchema,
	version: z.number().int().min(1),
});
