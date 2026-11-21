import { CMS_RESTORE_LEASE_SECONDS } from "@tedix/db/queries/cms-restore-fences";

export interface RestoreLeaseContext {
	waitUntil(task: Promise<unknown>): void;
	abort(error: Error): void;
}

/** Stop the execution a full half-lease before D1 permits reclamation. The
 * independent deadline still fires when the renewal request never returns. */
export function startRestorePermitLease(
	context: RestoreLeaseContext,
	renew: () => Promise<boolean>,
	startedAt = Date.now(),
	now = () => Date.now(),
) {
	const authorityMs = CMS_RESTORE_LEASE_SECONDS * 500;
	let deadline = startedAt + authorityMs;
	let stopped = false;
	let lost: Error | undefined;
	let renewalTimer: ReturnType<typeof setTimeout> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const finished = Promise.withResolvers<void>();
	const stop = () => {
		stopped = true;
		if (renewalTimer !== undefined) clearTimeout(renewalTimer);
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		finished.resolve();
	};
	const lose = () => {
		if (stopped) return;
		lost = new Error("CMS restore permit lease lost");
		stop();
		context.abort(lost);
	};
	const arm = () => {
		deadlineTimer = setTimeout(lose, Math.max(0, deadline - now()));
		renewalTimer = setTimeout(async () => {
			const renewalStarted = now();
			let renewed: boolean;
			try {
				renewed = await renew();
			} catch {
				return lose();
			}
			if (stopped) return;
			if (!renewed || now() >= deadline) return lose();
			deadline = renewalStarted + authorityMs;
			clearTimeout(deadlineTimer);
			arm();
		}, authorityMs / 3);
	};
	context.waitUntil(finished.promise);
	if (now() >= deadline) lose();
	else arm();
	return {
		stop,
		assertActive() {
			if (lost) throw lost;
			if (now() >= deadline)
				throw new Error("CMS restore permit lease expired");
		},
	};
}
