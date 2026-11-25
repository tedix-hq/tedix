import { AsyncLocalStorage } from "node:async_hooks";

export class KernelReconcileDeferred extends Error {}

const budgets = new AsyncLocalStorage<{
	deadline: number;
	signal: AbortSignal;
	repositoryChecks: number;
	outboundFetches: number;
	outboundMs: number;
}>();

// Leave two seconds for retry persistence and the cron receipt's own writes.
export const KERNEL_RECONCILE_WORK_MS = 8_000;

export async function withKernelReconcileBudget<T>(
	deadline: number,
	run: () => Promise<T>,
) {
	const budget = {
		deadline,
		signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
		repositoryChecks: 0,
		outboundFetches: 0,
		outboundMs: 0,
	};
	try {
		return await budgets.run(budget, run);
	} finally {
		console.log({
			event: "kernel.request_reconcile.outbound",
			repositoryChecks: budget.repositoryChecks,
			outboundFetches: budget.outboundFetches,
			outboundMs: budget.outboundMs,
			deadlineReached: Date.now() >= budget.deadline,
		});
	}
}

export function admitKernelRepositoryCheck() {
	const budget = budgets.getStore();
	if (!budget) return;
	checkKernelReconcileDeadline();
	budget.repositoryChecks++;
}

export function checkKernelReconcileDeadline() {
	const budget = budgets.getStore();
	if (budget && Date.now() >= budget.deadline)
		throw new KernelReconcileDeferred("Reconcile deadline elapsed");
}

export function limitKernelReconcileDeadline(deadline: number) {
	const budget = budgets.getStore();
	if (!budget || deadline >= budget.deadline) return;
	budget.deadline = deadline;
	budget.signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
}

/** Race only read-only work: a late D1 response must never resume a mutation. */
export async function kernelReconcileRead<T>(
	read: () => Promise<T>,
): Promise<T> {
	const budget = budgets.getStore();
	if (!budget) return read();
	if (Date.now() >= budget.deadline)
		throw new KernelReconcileDeferred("Reconcile deadline elapsed");
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			read(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new KernelReconcileDeferred("Reconcile read deferred")),
					Math.max(1, budget.deadline - Date.now()),
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function kernelReconcileFetch(fetchFn: typeof fetch): typeof fetch {
	const budget = budgets.getStore();
	if (!budget) return fetchFn;
	return async (input, init) => {
		if (Date.now() >= budget.deadline || budget.signal.aborted)
			throw new KernelReconcileDeferred("Reconcile deadline elapsed");
		const started = Date.now();
		budget.outboundFetches++;
		try {
			return await fetchFn(input, {
				...init,
				signal: init?.signal
					? AbortSignal.any([init.signal, budget.signal])
					: budget.signal,
			});
		} finally {
			budget.outboundMs += Date.now() - started;
		}
	};
}
