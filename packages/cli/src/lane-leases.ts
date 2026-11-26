import { spawn, type ChildProcess } from "node:child_process";
import type { WorkAttemptSchema } from "@tedix/api-contract/schemas/work-items";
import type { infer as Infer } from "zod";
import type { createLaneHeartbeat } from "./lane-heartbeat";
import { inDarkWake } from "./oauth-provider";
import { LEASE_WORKER_ENV, selfCommand } from "./shared";
import {
	createLeaseRenewer,
	leaseRenewalDelayMs,
	type LeaseRenewer,
} from "./lease-renewer";

type LeaseReceipt = Parameters<ReturnType<typeof createLaneHeartbeat>>[0];
type LeaseState = {
	receipt: LeaseReceipt;
	expiry?: number;
	spawned?: boolean;
	lastAgentEventAt?: number;
};
type LeaseEvent =
	| { kind: "renewed"; expiry: number }
	| { kind: "lost" }
	| { kind: "log"; event: string; detail: string }
	| { kind: "confirmed"; expiry: number };
type Notify = (event: LeaseEvent) => void;
type LeaseUpdate = Pick<LeaseState, "spawned" | "lastAgentEventAt">;
type LeaseWatch = (
	state: LeaseState,
	notify: Notify,
) => {
	update: (state: LeaseUpdate) => void;
	stop: () => void;
};

export function createLeaseWatch(
	renew: ReturnType<typeof createLaneHeartbeat>,
	latestAttempt: (
		id: string,
	) => Promise<Infer<typeof WorkAttemptSchema> | undefined>,
	darkWake: () => boolean | Promise<boolean> = inDarkWake,
	timing?: { now?: () => number; wait?: (ms: number) => Promise<void> },
): LeaseWatch {
	return (state, notify) => {
		const { receipt } = state;
		const now = timing?.now ?? Date.now;
		let { expiry, spawned } = state;
		let lastLeaseCheck = now();
		let nextLeaseProbe = 0;
		let checking = false;
		let stopped = false;
		const emit: Notify = (event) => {
			if (!stopped) notify(event);
		};
		const log = (event: string, detail: string) =>
			emit({ kind: "log", event, detail });
		const leaseLost = () => {
			if (!spawned) return;
			emit({ kind: "lost" });
			stop();
		};
		const stop = () => {
			stopped = true;
			renewer.stop();
			if (check) clearInterval(check);
		};
		const checkLease = async () => {
			const at = now();
			if (at - lastLeaseCheck > 5_000)
				log(
					"lease-check-delayed",
					`Lease check delayed by ${at - lastLeaseCheck} ms`,
				);
			lastLeaseCheck = at;
			if (
				stopped ||
				!spawned ||
				checking ||
				expiry === undefined ||
				at < Math.max(expiry, nextLeaseProbe)
			)
				return;
			checking = true;
			try {
				if (await darkWake()) return;
				// A renewal may have reached the server even if its reply was lost.
				const latest = await latestAttempt(receipt.itemId);
				const confirmed = Date.parse(latest?.expiresAt ?? "");
				if (
					latest &&
					latest.id === receipt.attemptId &&
					latest.externalSessionKey === receipt.session &&
					["queued", "running", "waiting", "retrying"].includes(
						latest.runtimeState,
					) &&
					confirmed > now()
				) {
					expiry = confirmed;
					renewer.confirm(confirmed);
					emit({ kind: "confirmed", expiry });
				} else leaseLost();
			} catch (error) {
				if (await darkWake()) return;
				log("lease-check-failed", String(error));
				// An unavailable authority cannot confirm that this Attempt ended.
				nextLeaseProbe = now() + 10_000;
			} finally {
				checking = false;
			}
		};
		const check =
			expiry === undefined ? undefined : setInterval(checkLease, 1000);
		const renewer: LeaseRenewer = createLeaseRenewer({
			expiresAt: expiry,
			// Without a confirmed lease, keep the old minute cadence until the
			// first renewal answers; an expired one is probed the same way.
			firstDelayMs: expiry === undefined ? 60_000 : 0,
			now,
			wait: timing?.wait,
			onRenewed: (expiresAt) => {
				expiry = expiresAt;
				emit({ kind: "renewed", expiry });
			},
			// Before the run's child exists a lost lease kills nothing; keep
			// probing on the old cadence like the fixed heartbeat did.
			onLost: () => (spawned ? (leaseLost(), undefined) : 60_000),
			// An expired lease is not proof the Attempt ended: a dark wake
			// defers the check, and otherwise the renewal call lets the
			// server arbitrate before the watcher reports a loss.
			onExpired: async () => ((await darkWake()) ? 60_000 : "step"),
			step: async () => {
				if (await darkWake()) return { kind: "retry", delayMs: 60_000 };
				try {
					const renewed = await renew(receipt);
					const renewedExpiry = Date.parse(renewed.expiresAt);
					// A reply without an expiry still proves the lease is held;
					// keep the last confirmed horizon rather than reporting loss.
					return {
						kind: "renewed",
						expiresAt: Number.isFinite(renewedExpiry)
							? renewedExpiry
							: expiry !== undefined && expiry > now()
								? expiry
								: now() + 60_000,
					};
				} catch (error) {
					if (await darkWake()) return { kind: "retry", delayMs: 60_000 };
					log("heartbeat-failed", String(error));
					if (
						error instanceof Error &&
						"code" in error &&
						typeof error.code === "string" &&
						(["STALE_ATTEMPT", "NOT_FOUND", "INVALID_LEASE"].includes(
							error.code,
						) ||
							(error.code === "CONFLICT" &&
								error.message.includes("STALE_ATTEMPT")))
					)
						return { kind: "lost", reason: String(error) };
					const remaining = expiry !== undefined ? expiry - now() : NaN;
					return {
						kind: "retry",
						delayMs: Number.isFinite(remaining)
							? leaseRenewalDelayMs(remaining) || 60_000
							: 60_000,
					};
				}
			},
		});
		return {
			update: (state) => {
				spawned = state.spawned;
			},
			stop,
		};
	};
}

type WatchCommand =
	| { id: number; watch: LeaseState }
	| { id: number; update: LeaseUpdate }
	| { id: number; stop: true };

type WorkerMessage = { ready: true } | { id: number; event: LeaseEvent };

export function serveLeaseWatches(watch: LeaseWatch) {
	const watches = new Map<number, ReturnType<LeaseWatch>>();
	process.on("message", (message: WatchCommand) => {
		const { id } = message;
		if ("watch" in message) {
			watches.set(
				id,
				watch(message.watch, (event) => {
					if (process.connected) process.send?.({ id, event });
				}),
			);
		} else if ("update" in message) {
			watches.get(id)?.update(message.update);
		} else {
			watches.get(id)?.stop();
			watches.delete(id);
		}
	});
	process.on("disconnect", () => process.exit(0));
	process.send?.({ ready: true } satisfies WorkerMessage);
}

export function childLeaseWatch(
	scope: string[],
	env: NodeJS.ProcessEnv,
	program = selfCommand,
): LeaseWatch {
	const watches = new Map<number, { state: LeaseState; notify: Notify }>();
	let nextId = 0;
	let child: ChildProcess | undefined;
	let ready = false;
	const send = (command: WatchCommand) => {
		if (ready && child?.connected) child.send(command, () => {});
	};
	const start = () => {
		const [command, prefix] = program();
		const worker = spawn(command, [...prefix, ...scope], {
			env: { ...env, [LEASE_WORKER_ENV]: "1" },
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		child = worker;
		ready = false;
		worker.on("message", (message: WorkerMessage) => {
			if (child !== worker) return;
			if ("ready" in message) {
				ready = true;
				for (const [id, { state }] of watches) send({ id, watch: state });
				return;
			}
			const { id, event } = message;
			const entry = watches.get(id);
			if (!entry) return;
			if (
				(event.kind === "renewed" || event.kind === "confirmed") &&
				entry.state.expiry !== undefined &&
				Number.isFinite(event.expiry)
			)
				entry.state.expiry = event.expiry;
			if (event.kind === "lost") watches.delete(id);
			entry.notify(event);
		});
		worker.on("error", (error) =>
			console.error("Lease worker:", error.message),
		);
		worker.once("close", () => {
			if (child !== worker) return;
			child = undefined;
			if (watches.size) {
				console.error("Lease worker exited while watching active Attempts");
				setTimeout(() => {
					if (!child && watches.size) start();
				}, 1000).unref();
			}
		});
		worker.unref();
	};
	return (state, notify) => {
		const id = ++nextId;
		watches.set(id, { state, notify });
		if (child?.connected) send({ id, watch: state });
		else start();
		return {
			update: (update) => {
				Object.assign(state, update);
				send({ id, update });
			},
			stop: () => {
				watches.delete(id);
				send({ id, stop: true });
				if (!watches.size && child?.connected) {
					child.disconnect();
					child = undefined;
				}
			},
		};
	};
}
