import type { CodemodeRuntimeHandle } from "@cloudflare/codemode";
import type { ComputerWorkspaceScope } from "./computer-workspace-scope";

import type { ComputerEnvironment } from "./computer-environment";
export type ComputerCodeBinding = ComputerWorkspaceScope & {
	environment?: ComputerEnvironment | null;
};

const REGISTRY_PREFIX = "durable-code:registered-workspace:";
const EXECUTION_PREFIX = "durable-code:workspace:";

type RoutingStorage = Pick<DurableObjectStorage, "get" | "put" | "list">;
type RoutingRuntime = Pick<CodemodeRuntimeHandle, "executions">;

function parseScope(value: unknown): ComputerCodeBinding {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid durable Code Mode workspace scope");
	}
	const scope = value as Record<string, unknown>;
	if (
		(scope.kind !== "conversation" &&
			scope.kind !== "delegated-run" &&
			scope.kind !== "operator") ||
		typeof scope.key !== "string" ||
		!scope.key ||
		Object.keys(scope).some(
			(key) => key !== "kind" && key !== "key" && key !== "environment",
		)
	)
		throw new Error("Invalid durable Code Mode workspace scope");
	if (scope.environment !== undefined && scope.environment !== null) {
		const env = scope.environment as ComputerEnvironment;
		if (
			typeof env !== "object" ||
			typeof env.leaseId !== "string" ||
			typeof env.cwd !== "string" ||
			!["shell", "repository"].includes(env.preparation)
		)
			throw new Error("Invalid Code Mode computer binding");
	}
	return {
		kind: scope.kind,
		key: scope.key,
		...(Object.hasOwn(scope, "environment")
			? { environment: scope.environment as ComputerEnvironment | null }
			: {}),
	};
}

function sameScope(
	left: ComputerCodeBinding,
	right: ComputerCodeBinding,
): boolean {
	return (
		left.kind === right.kind &&
		left.key === right.key &&
		left.environment?.leaseId === right.environment?.leaseId
	);
}

/** Persist runtime ownership before execution starts. The SDK generates IDs
 * internally, so a restart can recover an unrecorded ID from registered runtimes
 * without guessing the currently active conversation or operator workspace. */
export class ComputerCodeRouting {
	private writes: Promise<void> = Promise.resolve();

	constructor(
		private readonly storage: RoutingStorage,
		private readonly getRuntime: (
			scope: ComputerCodeBinding,
		) => Promise<RoutingRuntime>,
	) {}

	async isRegistered(scopeId: string): Promise<boolean> {
		return (
			(await this.storage.get(`${REGISTRY_PREFIX}${scopeId}`)) !== undefined
		);
	}

	async register(scopeId: string, scope: ComputerCodeBinding): Promise<void> {
		if (!scopeId) throw new Error("Computer runtime scope ID is required");
		await this.putImmutable(`${REGISTRY_PREFIX}${scopeId}`, scope);
	}

	async record(executionId: string, scope: ComputerCodeBinding): Promise<void> {
		if (!executionId) throw new Error("Computer execution ID is required");
		await this.putImmutable(`${EXECUTION_PREFIX}${executionId}`, scope);
	}

	async resolve(executionId: string): Promise<ComputerCodeBinding> {
		if (!executionId) throw new Error("Computer execution ID is required");
		const existing = await this.storage.get(
			`${EXECUTION_PREFIX}${executionId}`,
		);
		if (existing !== undefined) return parseScope(existing);
		const registered = await this.storage.list({ prefix: REGISTRY_PREFIX });
		let owner: ComputerCodeBinding | undefined;
		for (const value of registered.values()) {
			const scope = parseScope(value);
			const runtime = await this.getRuntime(scope);
			// Paused/running executions are not bounded by terminal retention. A
			// capped history read could make an older pending approval unreachable.
			if (
				!(await runtime.executions()).some(
					(execution) => execution.id === executionId,
				)
			)
				continue;
			if (owner && !sameScope(owner, scope)) {
				throw new Error(
					"Durable Code Mode execution has ambiguous workspace ownership",
				);
			}
			owner = scope;
		}
		if (!owner)
			throw new Error("Durable Code Mode execution workspace is unavailable");
		await this.record(executionId, owner);
		return owner;
	}

	private async putImmutable(
		key: string,
		value: ComputerCodeBinding,
	): Promise<void> {
		const scope = parseScope(value);
		const write = this.writes.then(async () => {
			const current = await this.storage.get(key);
			if (current !== undefined) {
				if (!sameScope(parseScope(current), scope))
					throw new Error(
						"Durable Code Mode workspace ownership cannot change",
					);
				return;
			}
			await this.storage.put(key, scope);
		});
		this.writes = write.catch(() => undefined);
		await write;
	}
}
