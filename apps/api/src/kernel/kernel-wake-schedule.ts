/** Keep kernel timers in the same durable queue as SDK maintenance jobs. */
export const KERNEL_TIMER_WAKE_CALLBACK = "wakeKernelTimers";

interface WakeSchedule {
	id: string;
	callback: string;
	time: number;
}

interface KernelWakeScheduler {
	listSchedules(): Promise<WakeSchedule[]>;
	schedule(
		when: Date,
		callback: string,
		payload: { targetMs: number },
		options: { idempotent: true },
	): Promise<unknown>;
	cancelSchedule(id: string): Promise<unknown>;
}

export async function ensureKernelWakeSchedule(
	scheduler: KernelWakeScheduler,
	targetMs: number,
): Promise<void> {
	// SDK schedules have second precision. Round up so blocked-run deadlines
	// never wake early and immediately requeue themselves.
	const dueMs = Math.ceil(targetMs / 1_000) * 1_000;
	const pending = (await scheduler.listSchedules()).filter(
		(schedule) => schedule.callback === KERNEL_TIMER_WAKE_CALLBACK,
	);
	if (pending.some((schedule) => schedule.time * 1_000 <= dueMs)) return;
	// Include the deadline in the dedup payload: SDK idempotency alone ignores
	// the Date and would retain an existing later wake. Install first so a failed
	// cancellation cannot lose the wake; concurrent calls may leave a harmless
	// extra later job but cannot delete an earlier deadline.
	await scheduler.schedule(
		new Date(dueMs),
		KERNEL_TIMER_WAKE_CALLBACK,
		{ targetMs: dueMs },
		{ idempotent: true },
	);
	for (const schedule of pending) {
		await scheduler.cancelSchedule(schedule.id);
	}
}
