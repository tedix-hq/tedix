import type { WorkflowStep } from "cloudflare:workers";
import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import { withCoreStore } from "@tedix/db/core-store/scope";

/** Workflow callbacks cross an RPC boundary that drops run()'s async context. */
export function withCoreStoreSteps(
	env: CoreStoreEnv,
	step: WorkflowStep,
): WorkflowStep {
	const doStep = (...args: unknown[]) => {
		const callbackIndex = typeof args[1] === "function" ? 1 : 2;
		const callback = args[callbackIndex] as (
			...args: unknown[]
		) => Promise<unknown>;
		args[callbackIndex] = (...callbackArgs: unknown[]) =>
			withCoreStore(env, () => callback(...callbackArgs));
		return Reflect.apply(step.do, step, args);
	};
	return new Proxy(step, {
		get(target, key) {
			if (key === "do") return doStep;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
