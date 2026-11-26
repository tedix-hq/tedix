// Four 70-second handlers can overlap without starting the whole fleet at once.
// Keep each slot through readiness, admission, handler drain and permit cleanup.
const SCHEDULED_TENANT_CONCURRENCY = 4;

export async function runScheduledFanout<T>(
	tenants: readonly T[],
	run: (tenant: T, attempted: () => void) => Promise<"succeeded" | "skipped">,
	onError: (tenant: T, error: unknown) => void,
) {
	const counters = { attempted: 0, succeeded: 0, skipped: 0, failed: 0 };
	let next = 0;
	async function worker() {
		while (next < tenants.length) {
			const tenant = tenants[next++]!;
			try {
				const result = await run(tenant, () => {
					counters.attempted++;
				});
				counters[result]++;
			} catch (error) {
				counters.failed++;
				onError(tenant, error);
			}
		}
	}
	await Promise.all(
		Array.from(
			{ length: Math.min(SCHEDULED_TENANT_CONCURRENCY, tenants.length) },
			worker,
		),
	);
	return counters;
}
