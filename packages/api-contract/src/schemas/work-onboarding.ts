import * as z from "zod";
import { OsBlueprintDefinitionSchema } from "./os-workspaces";

export const WorkOnboardingSchema = z.strictObject({
	version: z.literal(1),
	definition: OsBlueprintDefinitionSchema.refine(
		(definition) => definition.requirements === null,
		"Default Work onboarding cannot bypass blueprint requirements",
	),
});
export type WorkOnboarding = z.infer<typeof WorkOnboardingSchema>;
