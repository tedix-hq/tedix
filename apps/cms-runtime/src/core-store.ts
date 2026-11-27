import type { WorkflowStep } from "cloudflare:workers";
import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import { coreDb, coreQueryDb, withCoreStore } from "@tedix/db/core-store/scope";

export interface CmsCoreStoreEnv extends Omit<CoreStoreEnv, "DB"> {
	PLATFORM_DB: D1Database;
}

export function cmsDb(env: CmsCoreStoreEnv) {
	return coreDb({ ...env, DB: env.PLATFORM_DB });
}

export function cmsQueryDb(env: CmsCoreStoreEnv) {
	return coreQueryDb({ ...env, DB: env.PLATFORM_DB });
}

export function withCmsCoreStore<T>(
	env: CmsCoreStoreEnv,
	run: () => T | Promise<T>,
	schedule?: (promise: Promise<unknown>) => void,
): Promise<T> {
	return withCoreStore({ ...env, DB: env.PLATFORM_DB }, run, schedule);
}

/** Workflow callbacks cross an RPC boundary that drops run()'s async context. */
export function withCmsCoreStoreSteps(
	env: CmsCoreStoreEnv,
	step: WorkflowStep,
): WorkflowStep {
	const doStep = (...args: unknown[]) => {
		const callbackIndex = typeof args[1] === "function" ? 1 : 2;
		const callback = args[callbackIndex] as (
			...args: unknown[]
		) => Promise<unknown>;
		args[callbackIndex] = (...callbackArgs: unknown[]) =>
			withCmsCoreStore(env, () => callback(...callbackArgs));
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
