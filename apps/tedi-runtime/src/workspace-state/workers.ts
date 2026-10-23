// Derived from the MIT-licensed state API in Cloudflare Shell 0.4.3.
// Copyright (c) 2025 Cloudflare, Inc. See LICENSE in this directory.
import type { ToolProvider } from "@cloudflare/codemode";
import { STATE_METHOD_NAMES, type StateMethodName } from "./backend";
import type { TediWorkspaceFs } from "../workspace-fs";
import { createWorkspaceStateBackend } from "./workspace";
import { STATE_TYPES } from "./prompt";
import { STATE_METHODS, callStateMethod, paramNames } from "./state-methods";

// The advertised sandbox API (STATE_TYPES) is object-args:
// `state.readFile({ path })`. Detect that shape — a single plain object whose
// keys are a subset of the method's parameter names — and route it through
// the shared object→positional mapping. Anything else is treated as the
// original positional call, so pre-object-args sandbox code keeps working.
function isObjectArgsCall(
	method: StateMethodName,
	args: unknown[],
): args is [Record<string, unknown>] {
	if (args.length !== 1) return false;
	const [first] = args;
	if (
		typeof first !== "object" ||
		first === null ||
		Array.isArray(first) ||
		first instanceof Uint8Array
	) {
		return false;
	}
	const names = paramNames(STATE_METHODS[method]);
	const keys = Object.keys(first);
	return keys.length > 0 && keys.every((key) => names.includes(key));
}

/** Preserve the sandbox state API over the live Computer-backed workspace. */
export function stateTools(workspace: TediWorkspaceFs): ToolProvider {
	const backend = createWorkspaceStateBackend(workspace);
	const tools: Record<
		string,
		{ description: string; execute: (...args: unknown[]) => Promise<unknown> }
	> = {};

	for (const method of STATE_METHOD_NAMES) {
		const fn = backend[method];

		tools[method] = {
			description: STATE_METHODS[method].description,
			execute: (...args: unknown[]) =>
				isObjectArgsCall(method, args)
					? callStateMethod(backend, method, args[0])
					: Reflect.apply(fn, backend, args),
		};
	}

	return {
		name: "state",
		tools,
		types: STATE_TYPES,
	};
}
