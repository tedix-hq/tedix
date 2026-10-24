export function specOutcome(
	code: number | null,
	fixtureCode: number | null,
	signal: string | number | null = null,
): string {
	if (code === null) return `NOT RUN (fixture server exited ${fixtureCode})`;
	const specExit = signal ? `signal ${signal}; exit ${code}` : `exit ${code}`;
	if (fixtureCode !== null)
		return `FAIL (fixture server exited ${fixtureCode}; spec ${specExit})`;
	return code !== 0 || signal ? `FAIL (${specExit})` : "PASS";
}
