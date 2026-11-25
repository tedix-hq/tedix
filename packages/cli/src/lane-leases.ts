import { spawn, type ChildProcess } from "node:child_process";
import type { WorkAttemptSchema } from "@tedix/api-contract/schemas/work-items";
import type { infer as Infer } from "zod";
import type { createLaneHeartbeat } from "./lane-heartbeat";
import { inDarkWake } from "./oauth-provider";
import { LEASE_WORKER_ENV, selfCommand } from "./shared";

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
): LeaseWatch {
	return (state, notify) => {
		const { receipt } = state;
		let { expiry, spawned } = state;
		let lastLeaseCheck = Date.now();
		let nextLeaseProbe = 0;
		let renewing = false;
		let checking = false;
		let stopped = false;
		const emit: Notify = (event) => {
			if (!stopped) notify(event);
		};
		const log = (event: string, detail: string) =>
			emit({ kind: "log", event, detail });
		const stop = () => {
			stopped = true;
			clearInterval(heartbeat);
			if (check) clearInterval(check);
		};
		const lost = () => {
			if (!spawned) return;
			emit({ kind: "lost" });
			stop();
		};
		const checkLease = async () => {
			const now = Date.now();
			if (now - lastLeaseCheck > 5_000)
				log(
					"lease-check-delayed",
					`Lease check delayed by ${now - lastLeaseCheck} ms`,
				);
			lastLeaseCheck = now;
			if (
				stopped ||
				!spawned ||
				checking ||
				expiry === undefined ||
				now < Math.max(expiry, nextLeaseProbe)
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
					confirmed > Date.now()
				) {
					expiry = confirmed;
					emit({ kind: "confirmed", expiry });
				} else lost();
			} catch (error) {
				if (await darkWake()) return;
				log("lease-check-failed", String(error));
				// An unavailable authority cannot confirm that this Attempt ended.
				nextLeaseProbe = Date.now() + 10_000;
			} finally {
				checking = false;
			}
		};
		const check =
			expiry === undefined ? undefined : setInterval(checkLease, 1000);
		const heartbeat = setInterval(async () => {
			if (stopped || renewing) return;
			renewing = true;
			try {
				if (await darkWake()) return;
				const renewed = await renew(receipt);
				const renewedExpiry = Date.parse(renewed.expiresAt);
				if (Number.isFinite(renewedExpiry) && expiry !== undefined)
					expiry = renewedExpiry;
				emit({ kind: "renewed", expiry: renewedExpiry });
			} catch (error) {
				if (await darkWake()) return;
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
					lost();
			} finally {
				renewing = false;
			}
		}, 60_000);
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
