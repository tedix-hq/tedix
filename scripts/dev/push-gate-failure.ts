/** Null means preflight could not load; no gate result exists to charge. */
export function failedPushGate(output: string): string | null {
	const names = [...output.matchAll(/^✗\s+(.+?)(?:\s+\([^\n]*\))?$/gm)].map(
		(match) => match[1]!.trim(),
	);
	if (
		names.length === 0 &&
		!/pre-push: .*(?:\(\d+\/\d+\)|: (?:passed|failed)|gates? (?:passed|failed))/.test(
			output,
		) &&
		/(?:^error: Cannot find (?:package|module)|\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b)/m.test(
			output,
		)
	)
		return null;
	return names.at(-1) ?? "pre-push gates";
}
