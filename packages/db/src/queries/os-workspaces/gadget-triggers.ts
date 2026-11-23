/** Matches the trigger tick's candidate predicate, including empty trigger arrays. */
export function osGadgetHasRuntimeTriggers(manifest: string): boolean {
	const parsed = JSON.parse(manifest);
	return (
		parsed?.entry === "tedix:runtime/v1" &&
		Array.isArray(parsed.config?.triggers)
	);
}
