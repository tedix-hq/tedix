import {
	HistoricalLiabilityCustody,
	type ReplayIdentity,
} from "./historical-liability-custody";
import type { FiberContext } from "agents";

type Storage = Pick<DurableObjectStorage, "sql" | "kv" | "transactionSync">;
/** Existing seals prohibit execution. This port never admits, settles or changes a source row. */
export class HistoricalExecutionGuard {
	private readonly custody: HistoricalLiabilityCustody;
	constructor(
		private readonly storage: Storage,
		objectId: string,
	) {
		this.custody = new HistoricalLiabilityCustody(storage, objectId);
	}
	assert(values: ReplayIdentity[]): void {
		this.custody.assertNotSealedAll(values);
	}
	assertRun(runId: string | null | undefined): void {
		this.assert(runId ? [{ kind: "run", id: runId }] : []);
	}
	/** No Agent may start before this current, storage-only proof. Raw retains original receipt ports. */
	requiresRawStartup(): boolean {
		try {
			this.custody.assertNotSealedAll(() => {
				const names = new Set(
					this.storage.sql
						.exec<{ name: string }>(
							"SELECT name FROM sqlite_master WHERE type='table'",
						)
						.toArray()
						.map((r) => r.name),
				);
				const values: ReplayIdentity[] = [];
				if (names.has("cf_agents_workflows"))
					for (const r of this.storage.sql
						.exec<{ workflow_name: string; workflow_id: string }>(
							"SELECT workflow_name,workflow_id FROM cf_agents_workflows",
						)
						.toArray())
						values.push({
							kind: "workflow",
							binding: r.workflow_name,
							id: r.workflow_id,
						});
				if (names.has("cf_agents_fibers"))
					for (const r of this.storage.sql
						.exec<{ fiber_id: string; idempotency_key: string | null }>(
							"SELECT fiber_id,idempotency_key FROM cf_agents_fibers",
						)
						.toArray()) {
						values.push({ kind: "fiber", id: r.fiber_id });
						if (r.idempotency_key !== null)
							values.push({ kind: "fiber_key", id: r.idempotency_key });
					}
				if (names.has("cf_agents_runs"))
					for (const r of this.storage.sql
						.exec<{ id: string }>("SELECT id FROM cf_agents_runs")
						.toArray())
						values.push({ kind: "fiber", id: r.id });
				return values;
			});
			return false;
		} catch {
			return true;
		}
	}
	fiber<T>(
		fn: (ctx: FiberContext) => Promise<T>,
		key?: string,
	): (ctx: FiberContext) => Promise<T> {
		return (ctx) => {
			this.assert([
				{ kind: "fiber", id: ctx.id },
				...(key !== undefined ? [{ kind: "fiber_key" as const, id: key }] : []),
			]);
			return fn(ctx);
		};
	}
	startFiber(fiberId?: string, key?: string): void {
		this.assert([
			...(fiberId !== undefined
				? [{ kind: "fiber" as const, id: fiberId }]
				: []),
			...(key !== undefined ? [{ kind: "fiber_key" as const, id: key }] : []),
		]);
	}
	private workflow(id: unknown, params?: unknown): void {
		const values: ReplayIdentity[] = [];
		if (id !== undefined) {
			if (typeof id !== "string" || !id)
				throw new Error("Invalid workflow identity");
			values.push({ kind: "workflow", binding: "CHAT_TURN_WORKFLOW", id });
		}
		if (
			params &&
			typeof params === "object" &&
			Object.hasOwn(params, "runId")
		) {
			const runId = (params as { runId: unknown }).runId;
			if (typeof runId !== "string" || !runId)
				throw new Error("Invalid original workflow run identity");
			values.push({ kind: "run", id: runId });
		}
		this.assert(values);
	}
	private instance(
		instance: WorkflowInstance,
		expectedId?: string,
	): WorkflowInstance {
		const id = instance.id;
		if (expectedId !== undefined && id !== expectedId)
			throw new Error("Native workflow identity changed");
		return new Proxy(instance, {
			get: (target, key) => {
				const value = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				if (key === "restart" || key === "resume" || key === "sendEvent")
					return async (...args: unknown[]) => {
						this.workflow(id);
						return Reflect.apply(value, target, args);
					};
				return value.bind(target);
			},
		});
	}
	/** Permanent object-local port; native receivers and every unrelated binding retain their identities. */
	environment<Env extends object>(env: Env): Env {
		const descriptors: Record<string, PropertyDescriptor> =
				Object.getOwnPropertyDescriptors(env),
			descriptor = descriptors.CHAT_TURN_WORKFLOW;
		const binding = Reflect.get(env, "CHAT_TURN_WORKFLOW", env) as
			| Workflow<unknown>
			| undefined;
		if (binding === undefined || binding === null) return env;
		if (
			typeof binding.create !== "function" ||
			typeof binding.get !== "function"
		)
			throw new Error("Invalid native workflow binding");
		const port = new Proxy(binding, {
			get: (target, key) => {
				const value = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				if (key === "create")
					return async (options?: WorkflowInstanceCreateOptions<unknown>) => {
						this.workflow(options?.id, options?.params);
						return target
							.create(options)
							.then((instance: WorkflowInstance) =>
								this.instance(instance, options?.id),
							);
					};
				if (key === "createBatch")
					return async (batch: WorkflowInstanceCreateOptions<unknown>[]) => {
						if (!Array.isArray(batch))
							throw new Error("Invalid workflow batch");
						// Validate every identity with ONE proof before the first native batch dispatch.
						const identities: ReplayIdentity[] = [];
						for (const options of batch) {
							if (options.id !== undefined) {
								if (typeof options.id !== "string" || !options.id)
									throw new Error("Invalid workflow identity");
								identities.push({
									kind: "workflow",
									binding: "CHAT_TURN_WORKFLOW",
									id: options.id,
								});
							}
							if (
								options.params &&
								typeof options.params === "object" &&
								Object.hasOwn(options.params, "runId")
							) {
								const runId = (options.params as { runId: unknown }).runId;
								if (typeof runId !== "string" || !runId)
									throw new Error("Invalid original workflow run identity");
								identities.push({ kind: "run", id: runId });
							}
						}
						this.assert(identities);
						return target
							.createBatch(batch)
							.then((instances: WorkflowInstance[]) =>
								instances.map((instance, i) =>
									this.instance(instance, batch[i]?.id),
								),
							);
					};
				if (key === "get")
					return (id: string) =>
						target
							.get(id)
							.then((instance: WorkflowInstance) =>
								this.instance(instance, id),
							);
				return value.bind(target);
			},
		});
		// Copy descriptors into a new permanent env object; never mutate the platform env or swap it around an await.
		Object.defineProperty(descriptors, "CHAT_TURN_WORKFLOW", {
			value: {
				configurable: descriptor?.configurable ?? true,
				enumerable: descriptor?.enumerable ?? true,
				writable: descriptor?.writable ?? false,
				value: port,
			},
			enumerable: true,
			configurable: true,
			writable: true,
		});
		return Object.defineProperties(
			Object.create(Object.getPrototypeOf(env)),
			descriptors,
		) as Env;
	}
}
