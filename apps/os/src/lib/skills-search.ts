import type { SearchSchemaInput } from "@tanstack/react-router";
import * as z from "zod/mini";

export const SKILLS_SECTION_IDS = ["skills", "triggers", "workflows"] as const;
export const SKILLS_PAGE_SIZE = 20;
export type SkillsSection = (typeof SKILLS_SECTION_IDS)[number];

export const SKILLS_SECTIONS: readonly { id: SkillsSection; label: string }[] =
	[
		{ id: "skills", label: "Skills" },
		{ id: "triggers", label: "Triggers" },
		{ id: "workflows", label: "Automations" },
	];

export const skillsSearchSchema = z.object({
	section: z.catch(z.enum(SKILLS_SECTION_IDS), "skills"),
	q: z.catch(z.string().check(z.maxLength(120)), ""),
	page: z.catch(z.int().check(z.minimum(1)), 1),
});

export type SkillsSearch = z.infer<typeof skillsSearchSchema>;

export function validateSkillsSearch(
	search: {
		section?: SkillsSection;
		q?: string;
		page?: number;
	} & SearchSchemaInput,
): SkillsSearch {
	return skillsSearchSchema.parse(search);
}
