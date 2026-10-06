import type { SearchSchemaInput } from "@tanstack/react-router";
import * as z from "zod/mini";

export const appsSearchSchema = z.object({
	q: z.catch(z.string().check(z.maxLength(120)), ""),
});

export type AppsSearch = z.infer<typeof appsSearchSchema>;

export function validateAppsSearch(
	search: { q?: string } & SearchSchemaInput,
): AppsSearch {
	return appsSearchSchema.parse(search);
}
