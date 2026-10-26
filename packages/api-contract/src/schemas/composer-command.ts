import * as z from "zod";

/** Discovery only: selecting a command prepares a Home message, never a tool call. */
export const ComposerCommandSchema = z.object({
	command: z.string().regex(/^\/[a-z0-9-]+\.[a-zA-Z0-9_.-]+$/),
	description: z.string(),
	instruction: z.string(),
});
export type ComposerCommand = z.infer<typeof ComposerCommandSchema>;

export function appToolComposerCommand(tool: {
	appSlug: string;
	toolId: string;
	title: string;
	description: string | null;
}): ComposerCommand {
	const name = `${tool.appSlug}.${tool.toolId}`;
	return ComposerCommandSchema.parse({
		command: `/${name}`,
		description: tool.description ?? tool.title,
		instruction: `Use the app tool ${name} for this request. Follow the existing approval policy before making changes.`,
	});
}
