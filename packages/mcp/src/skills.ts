import * as z from "zod";

/** Skills-over-MCP extension identifier (final SEP-2640). */
export const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

export const SkillResourceDigestSchema = z.object({
	uri: z.string(),
	digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	size: z.number().int().nonnegative(),
});

export const McpSkillEntrySchema = z.object({
	uri: z.string(),
	frontmatter: z.record(z.string(), z.unknown()),
	resources: z.union([
		z.array(SkillResourceDigestSchema),
		z.literal("dynamic"),
	]),
});

export const ListSkillsParamsSchema = z.object({
	cursor: z.string().optional(),
});
export const ListSkillsResultSchema = z.object({
	skills: z.array(McpSkillEntrySchema),
	nextCursor: z.string().optional(),
});
export const GetSkillParamsSchema = z.object({ uri: z.string() });
export const GetSkillResultSchema = z.object({ skill: McpSkillEntrySchema });

export type McpSkillEntry = z.infer<typeof McpSkillEntrySchema>;
