import type { CodemodeRuntimeHandle } from "@cloudflare/codemode";
import type { RecoverTediCodeExecutionOutputSchema } from "@tedix/api-contract/schemas/tedi-durable-code";
import type * as z from "zod";

export type DurableCodeRecoveryInput = { executionId: string };
export type NativeDurableCodeRecoveryInput = DurableCodeRecoveryInput & {
	expectedUpdatedAt: number;
};
export type DurableCodeRecoveryResult = z.infer<
	typeof RecoverTediCodeExecutionOutputSchema
>;
export const DURABLE_CODE_RECOVERY_MESSAGE =
	"Completion was not recorded after interruption. Side effects may have occurred; inspect them before repeating any action.";

/** Owned by one parent DO, shared by every handle of the same native facet. */
export class DurableCodePassCoordinator {
	private readonly states = new Map<
		string,
		{ active: number; recovering: boolean }
	>();
	private state(key: string) {
		let state = this.states.get(key);
		if (!state) {
			state = { active: 0, recovering: false };
			this.states.set(key, state);
		}
		return state;
	}
	private release(key: string, state: { active: number; recovering: boolean }) {
		if (!state.active && !state.recovering) this.states.delete(key);
	}
	async pass<T>(key: string, run: () => Promise<T>): Promise<T> {
		const state = this.state(key);
		if (state.recovering)
			throw new Error("Durable execution recovery is in progress");
		state.active++;
		try {
			return await run();
		} finally {
			state.active--;
			this.release(key, state);
		}
	}
	async recover(
		key: string,
		input: DurableCodeRecoveryInput,
		run: () => Promise<DurableCodeRecoveryResult>,
	): Promise<DurableCodeRecoveryResult> {
		const state = this.state(key);
		if (state.active || state.recovering)
			return {
				recovered: false,
				execution_id: input.executionId,
				reason: "active_pass",
			};
		state.recovering = true;
		try {
			return await run();
		} finally {
			state.recovering = false;
			this.release(key, state);
		}
	}
}
export type RecoverableCodemodeRuntimeHandle = CodemodeRuntimeHandle & {
	recover(input: DurableCodeRecoveryInput): Promise<DurableCodeRecoveryResult>;
};

export function bindDurableCodeRecovery(input: {
	runtime: CodemodeRuntimeHandle;
	key: string;
	coordinator: DurableCodePassCoordinator;
	recover: (
		input: DurableCodeRecoveryInput,
	) => Promise<DurableCodeRecoveryResult>;
}): RecoverableCodemodeRuntimeHandle {
	const { runtime, key, coordinator } = input;
	return new Proxy(runtime, {
		get(target, property) {
			if (property === "recover")
				return (args: DurableCodeRecoveryInput) =>
					coordinator.recover(key, args, () => input.recover(args));
			if (property === "execute" || property === "approve")
				return (...args: unknown[]) =>
					coordinator.pass(key, () =>
						Reflect.apply(Reflect.get(target, property), target, args),
					);
			if (property === "tool")
				return (...args: unknown[]) => {
					const tool = Reflect.apply(target.tool, target, args);
					return {
						...tool,
						execute: (...executeArgs: unknown[]) =>
							coordinator.pass(key, () =>
								Promise.resolve(Reflect.apply(tool.execute, tool, executeArgs)),
							),
					};
				};
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as RecoverableCodemodeRuntimeHandle;
}

export function createDurableCodeRecovery<
	Scope extends { kind: string; key: string },
>(input: {
	resolve: (id: string) => Promise<Scope>;
	runtime: (scope: Scope) => Promise<RecoverableCodemodeRuntimeHandle>;
	scope: { kind: string; key: string };
}) {
	return async ({ execution_id }: { execution_id: string }) => {
		const scope = await input.resolve(execution_id);
		if (scope.kind !== input.scope.kind || scope.key !== input.scope.key)
			throw new Error("Execution belongs to another Computer workspace");
		return (await input.runtime(scope)).recover({ executionId: execution_id });
	};
}
