import { Agent } from "agents";
import {
	ensureKernelWakeSchedule,
	KERNEL_TIMER_WAKE_CALLBACK,
} from "../../../api/src/kernel/kernel-wake-schedule";

/** Exercise the same public scheduler API used by KernelDOv4 in real SQLite. */
export class KernelWakeFixture extends Agent {
	async wakeKernelTimers(): Promise<void> {}
	async maintenance(): Promise<void> {}

	async probe() {
		const now = Date.now();
		const early = Math.ceil((now + 60_000) / 1_000) * 1_000;
		await this.ctx.storage.setAlarm(early);
		const maintenance = await this.schedule(300, "maintenance");
		const overwrittenRawAlarm = await this.ctx.storage.getAlarm();
		await ensureKernelWakeSchedule(this, early);
		const queuedAlarm = await this.ctx.storage.getAlarm();
		await this.cancelSchedule(maintenance.id);
		const afterCancellation = await this.ctx.storage.getAlarm();
		await this.schedule(600, "maintenance");
		const afterMaintenance = await this.ctx.storage.getAlarm();
		await Promise.all([
			ensureKernelWakeSchedule(this, early),
			ensureKernelWakeSchedule(this, early),
		]);
		return {
			early,
			overwrittenRawAlarm,
			queuedAlarm,
			afterCancellation,
			afterMaintenance,
			snapshot: await this.inspect(),
		};
	}

	async inspect() {
		return {
			alarm: await this.ctx.storage.getAlarm(),
			wakes: (await this.listSchedules())
				.filter((row) => row.callback === KERNEL_TIMER_WAKE_CALLBACK)
				.map(({ id, time }) => ({ id, time })),
		};
	}
}
