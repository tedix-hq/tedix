import type { PlatformClient } from "./brain/platform-client";
import { scrubText } from "@tedix/context-core/trace-safety";
import { tool } from "ai";
import * as z from "zod";

type SkillReader = Pick<PlatformClient, "getSkillForMcp">;
const MAX_SKILL_READ_ERROR_CHARS = 1_000;

function boundedSkillReadError(error: unknown): string {
	let raw = "skill read failed";
	try {
		raw = error instanceof Error ? error.message : String(error);
	} catch {
		// Even an unprintable thrown value must yield a bounded failure.
	}
	const redacted = scrubText(raw);
	return redacted.length <= MAX_SKILL_READ_ERROR_CHARS
		? redacted
		: `${redacted.slice(0, MAX_SKILL_READ_ERROR_CHARS)}\n…(truncated)`;
}

/** Loading instructions is observation; only execution/reporting records usage. */
export function createSkillReadTool(
	getPlatform: () => SkillReader | null | Promise<SkillReader | null>,
) {
	return tool({
		description:
			"Read the full content (SKILL.md procedure + metadata) for one of your platform skills by slug or id. " +
			"Use this after reviewing the skill summaries in your system prompt to load the procedure you need before following it. " +
			"Returns the skill body, frontmatter, tags, and lifecycle state.",
		inputSchema: z.object({
			slug: z
				.string()
				.max(200)
				.optional()
				.describe("Skill slug (preferred, from the guidance summary)"),
			id: z
				.string()
				.uuid()
				.optional()
				.describe("Skill UUID (alternative to slug)"),
		}),
		execute: async ({ slug, id }): Promise<Record<string, unknown>> => {
			if (!slug && !id)
				return { ok: false, error: "Provide either slug or id" };
			const platform = await getPlatform();
			if (!platform)
				return {
					ok: false,
					error:
						"Platform client not available — tedi identity may not be resolved yet",
				};
			try {
				const result = await platform.getSkillForMcp(
					slug ? { slug } : { id: id! },
				);
				if (!result.entry)
					return {
						ok: false,
						error: boundedSkillReadError(`Skill not found: ${slug ?? id}`),
					};
				return {
					ok: true,
					id: result.entry.id,
					slug: result.entry.slug ?? slug,
					title: result.entry.title,
					summary: result.entry.summary ?? null,
					lifecycleState: result.entry.lifecycleState ?? null,
					content: result.entry.content ?? null,
					tags: result.entry.tags ?? [],
					domain: result.entry.domain ?? null,
					files: result.entry.files ? Object.keys(result.entry.files) : [],
				};
			} catch (error) {
				return { ok: false, error: boundedSkillReadError(error) };
			}
		},
	});
}
