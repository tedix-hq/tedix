/** Resolve at launch so callers may configure the environment after import. */
export function isTuiScreenReaderEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.TEDIX_SCREEN_READER === "1" || env.INK_SCREEN_READER === "true";
}
