import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage<object>();
const clients = new WeakMap<object, object>();

export function configureAuditDelivery<T extends object>(
	db: T,
	bindings: object,
): T {
	clients.set(db, bindings);
	return db;
}

/** Every D1 entrypoint queues audit delivery, including clients made inside it. */
export function withAuditDelivery<T>(bindings: object, run: () => T): T {
	return context.run(bindings, run);
}

export function auditDeliveryBindings(db: object): object | undefined {
	return clients.get(db) ?? context.getStore();
}
