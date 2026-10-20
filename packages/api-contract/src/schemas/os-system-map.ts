import * as z from "zod";

export const SYSTEM_MAP_ENTRY = "tedix:app/system-map";

/** Read-only app: no sources to choose, so the config only pins its version. */
export const SystemMapConfigSchema = z.strictObject({
	version: z.literal(1),
	/** Show shared (organization) workspaces; private ones always appear. */
	showSharedWorkspaces: z.boolean().default(false),
});
export type SystemMapConfig = z.infer<typeof SystemMapConfigSchema>;
