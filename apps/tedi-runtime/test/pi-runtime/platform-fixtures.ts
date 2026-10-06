import { Agent, type FiberRecoveryContext } from "agents";

/** Native Agents lifecycle proof. No model or cognitive harness is simulated. */
export class PiPlatformFixture extends Agent {
	async startPendingChildFiber() {
		await (await this.subAgent(PiPlatformFixture, "child")).startPendingFiber();
	}
	async inspectPendingChildFiber() {
		return (
			await this.subAgent(PiPlatformFixture, "child")
		).inspectPendingFiber();
	}
	async allowPendingChildRecovery() {
		await (
			await this.subAgent(PiPlatformFixture, "child")
		).allowPendingRecovery();
	}
	async inspectRootRecovery() {
		return {
			alarm: await this.ctx.storage.getAlarm(),
			facetRuns: this.sql<{
				count: number;
			}>`SELECT COUNT(*) AS count FROM cf_agents_facet_runs`[0]?.count,
		};
	}
	async startPendingFiber() {
		this.ctx.waitUntil(
			this.runFiber("pending-recovery-probe", async (fiber) => {
				fiber.stash({ checkpoint: "before-interruption" });
				await this.ctx.storage.put("probe-started", true);
				await new Promise<void>(() => {});
			}),
		);
	}
	async inspectPendingFiber() {
		return {
			started: await this.ctx.storage.get<boolean>("probe-started"),
			recoveryAttempts:
				(await this.ctx.storage.get<number>("probe-recovery-attempts")) ?? 0,
			recoveredCheckpoint: await this.ctx.storage.get<{ checkpoint: string }>(
				"probe-recovered-checkpoint",
			),
			pending: this.sql<{
				count: number;
			}>`SELECT COUNT(*) AS count FROM cf_agents_runs`[0]?.count,
		};
	}
	async allowPendingRecovery() {
		await this.ctx.storage.put("probe-allow-recovery", true);
	}
	override async onFiberRecovered(context: FiberRecoveryContext) {
		if (context.name !== "pending-recovery-probe")
			return super.onFiberRecovered(context);
		await this.ctx.storage.put(
			"probe-recovery-attempts",
			((await this.ctx.storage.get<number>("probe-recovery-attempts")) ?? 0) +
				1,
		);
		if (!(await this.ctx.storage.get("probe-allow-recovery")))
			throw new Error("transient recovery dependency unavailable");
		await this.ctx.storage.put("probe-recovered-checkpoint", context.snapshot);
	}
}
