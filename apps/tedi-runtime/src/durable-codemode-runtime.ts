import { CodemodeRuntime as NativeCodemodeRuntime } from "@cloudflare/codemode";
import { TEDI_DURABLE_CODE_TRANSPORT_TIMEOUT_MS } from "@tedix/api-contract/schemas/tedi-durable-code";
import {
	DURABLE_CODE_RECOVERY_MESSAGE,
	type NativeDurableCodeRecoveryInput,
	type DurableCodeRecoveryResult,
} from "./durable-codemode-recovery";

/** Keeps the SDK's existing facet name, SQLite journal and public operations. */
export class TedixCodemodeRuntime extends NativeCodemodeRuntime {
	protected recoveryNow(): number {
		return Date.now();
	}
	async recoverExecution(
		input: NativeDurableCodeRecoveryInput,
	): Promise<DurableCodeRecoveryResult> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const row = await super.getExecution(input.executionId);
			const decline = (
				reason: Exclude<
					DurableCodeRecoveryResult,
					{ recovered: true }
				>["reason"],
			): DurableCodeRecoveryResult => ({
				recovered: false,
				execution_id: input.executionId,
				reason,
			});
			if (!row) return decline("execution_not_found");
			if (row.status !== "running") return decline("not_running");
			if (row.updatedAt !== input.expectedUpdatedAt)
				return decline("revision_changed");
			if (
				!Number.isFinite(input.expectedUpdatedAt) ||
				this.recoveryNow() - row.updatedAt <
					TEDI_DURABLE_CODE_TRANSPORT_TIMEOUT_MS
			)
				return decline("too_recent");
			// Native fail preserves code, result and call entries; supply existing logs.
			await super.fail(row.id, DURABLE_CODE_RECOVERY_MESSAGE, row.logs);
			return {
				recovered: true,
				execution_id: row.id,
				execution_status: "error",
				completion: "unconfirmed",
				effects_may_have_occurred: true,
			};
		});
	}
	override async complete(
		id: string,
		result: unknown,
		logs?: string[],
	): Promise<void> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const row = await super.getExecution(id);
			if (row?.error === DURABLE_CODE_RECOVERY_MESSAGE) return;
			await super.complete(id, result, logs);
		});
	}
	override async fail(
		id: string,
		error: string,
		logs?: string[],
	): Promise<void> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const row = await super.getExecution(id);
			if (row?.error === DURABLE_CODE_RECOVERY_MESSAGE) return;
			await super.fail(id, error, logs);
		});
	}
}
