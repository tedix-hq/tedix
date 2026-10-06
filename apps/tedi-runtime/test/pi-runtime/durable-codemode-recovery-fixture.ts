import { DurableObject } from "cloudflare:workers";
import {
	createCodemodeRuntime,
	type ExecutionState,
} from "@cloudflare/codemode";
import { TedixCodemodeRuntime } from "../../src/durable-codemode-runtime";
import {
	bindDurableCodeRecovery,
	DurableCodePassCoordinator,
	type NativeDurableCodeRecoveryInput,
} from "../../src/durable-codemode-recovery";
function snapshot(row: ExecutionState | null) {
	return row
		? {
				id: row.id,
				updatedAt: row.updatedAt,
				code: row.code,
				status: row.status,
				error: row.error ?? null,
				logJson: JSON.stringify(row.log),
				journal: JSON.stringify(row),
			}
		: null;
}
export class RecoveryRuntimeFixture extends TedixCodemodeRuntime {
	private testNow: number | null = null;
	setTestNow(now: number) {
		this.testNow = now;
	}
	protected override recoveryNow() {
		return this.testNow ?? Date.now();
	}
}
export class DurableCodeRecoveryFixture extends DurableObject {
	private readonly coordinator = new DurableCodePassCoordinator();
	private releasePass: (() => void) | undefined;
	private releaseRecovery: (() => void) | undefined;
	private runtime(name = "recovery-fixture") {
		const ctx = this.ctx as DurableObjectState & {
			exports: { CodemodeRuntime: unknown };
			facets: {
				get(
					name: string,
					factory: () => { class: unknown },
				): RecoveryRuntimeFixture;
			};
		};
		return ctx.facets.get(`codemode:${name}`, () => ({
			class: ctx.exports.CodemodeRuntime,
		}));
	}
	async seed(status: "running" | "paused" | "completed" = "running") {
		const runtime = this.runtime();
		const id = await runtime.begin("async () => 1");
		if (status === "paused")
			await runtime.decide(
				id,
				0,
				"workspace",
				"write_file",
				{ path: "marker", content: "value" },
				true,
			);
		if (status === "completed") await runtime.complete(id, 1, ["native log"]);
		return snapshot(await runtime.getExecution(id))!;
	}
	async seedUnknownEffect() {
		const runtime = this.runtime();
		const id = await runtime.begin("async () => workspace.write_file()");
		await runtime.decide(
			id,
			0,
			"workspace",
			"write_file",
			{ path: "marker", content: "value" },
			false,
		);
		return snapshot(await runtime.getExecution(id))!;
	}
	async readOtherFacet(id: string) {
		return snapshot(await this.runtime("other-workspace").getExecution(id));
	}
	async seedOtherFacet() {
		const runtime = this.runtime("other-workspace");
		const id = await runtime.begin("other workspace program");
		return snapshot(await runtime.getExecution(id))!;
	}
	async read(id: string) {
		return snapshot(await this.runtime().getExecution(id));
	}
	async recover(input: NativeDurableCodeRecoveryInput, now: number) {
		await this.runtime().setTestNow(now);
		return this.coordinator.recover("recovery-fixture", input, () =>
			this.runtime().recoverExecution(input),
		);
	}
	async lateComplete(id: string) {
		await this.runtime().complete(id, "late result", ["late log"]);
	}
	async lateFail(id: string) {
		await this.runtime().fail(id, "late failure", ["late log"]);
	}
	async markRolledBack(id: string) {
		await this.runtime().markRolledBack(id);
	}
	async holdPass() {
		const runtime = createCodemodeRuntime({
			ctx: this.ctx,
			name: "recovery-fixture",
			connectors: [],
			executor: {
				execute: async () =>
					new Promise<{ result: string; logs: string[] }>((resolve) => {
						this.releasePass = () =>
							resolve({ result: "completed native pass", logs: [] });
					}),
			},
		});
		const wrapped = bindDurableCodeRecovery({
			runtime,
			key: "recovery-fixture",
			coordinator: this.coordinator,
			recover: async () => ({
				recovered: false,
				execution_id: "unused",
				reason: "too_recent",
			}),
		});
		await wrapped.execute({ code: "async () => 1" });
	}
	async releaseHeldPass() {
		for (let n = 0; !this.releasePass && n < 100; n++)
			await new Promise((resolve) => setTimeout(resolve, 1));
		this.releasePass?.();
	}
	async holdRecovery(input: NativeDurableCodeRecoveryInput) {
		return this.coordinator.recover("recovery-fixture", input, async () => {
			await new Promise<void>((resolve) => {
				this.releaseRecovery = resolve;
			});
			return {
				recovered: false,
				execution_id: input.executionId,
				reason: "too_recent",
			};
		});
	}
	releaseHeldRecovery() {
		this.releaseRecovery?.();
	}
	async newPass() {
		try {
			return {
				ok: await this.coordinator.pass("recovery-fixture", async () => true),
			};
		} catch (error) {
			return { ok: false, error: String(error) };
		}
	}
}
