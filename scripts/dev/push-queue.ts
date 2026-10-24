#!/usr/bin/env bun

/**
 * Pushes HEAD to main one session at a time on this machine.
 *
 * Parallel sessions used to run the pre-push gates side by side and then lose
 * the race to main, wasting a full gate run each time. This takes a lock in the
 * repository's common git dir (shared by every worktree), and only while
 * holding it fetches, rebases onto origin/main and runs a plain
 * `git push origin HEAD:main`, so the pre-push hook runs every gate as usual.
 * If the push still loses to a push made from another machine, it rebases and
 * retries up to twice. Waiting sessions block in arrival order. When multiple
 * compatible tickets wait, push-train.ts integrates up to MAX_TRAIN_LANES of
 * them (skipping, not stopping at, incompatible ones) in a temporary worktree
 * and pushes once through the same hook. Conflicting lanes are left out and
 * retried alone; a rejected candidate is split in halves and re-gated. A
 * single ticket keeps the original rebase/push path. Waiting sessions print
 * their place and an estimate from recent lock holds (push-queue-history.jsonl).
 *
 * Dead holders and tickets are removed. Single-lane locks also expire after
 * STALE_MS; living trains may need longer for fallback. No daemon.
 *
 * At most once a day, a successful push also starts `worktree:gc --apply` in
 * the background from the main checkout (log in
 * <git-common-dir>/worktree-gc.log), so finished worktrees and merged branches
 * are removed without anyone scheduling it. That command only removes merged,
 * clean, idle worktrees no process is using.
 *
 *   bun run push              # queue, rebase, gate, push
 *   bun run push --dry-run    # same, but `git push --dry-run` (gates still run)
 */

import { spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
	rmSync,
	statSync,
	writeSync,
	closeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runCurrentQueue } from "./push-bootstrap";
import {
	finishLane,
	laneUnchanged,
	readLane,
	readResult,
	recoverTrainResults,
	resultFile,
	runTrain,
	snapshotLane,
	type Lane,
} from "./push-train";

export const STALE_MS = 30 * 60 * 1000;
const POLL_MS = 2000;
const MAX_RETRIES = 2;
export const GC_EVERY_MS = 24 * 60 * 60 * 1000;

export type Holder = {
	pid: number;
	startedAt: number;
	train?: boolean;
	/** Ticket names in the running train, so waiters can tell they are in it. */
	lanes?: string[];
};

/** Lanes per candidate. A rejected candidate splits in halves, so a bad lane costs O(log n) gates. */
export const MAX_TRAIN_LANES = 12;
const HISTORY_KEEP = 50;

export type TrainRecord = {
	startedAt: number;
	finishedAt: number;
	lanes: number;
};

export type RetryRecord = {
	key: string;
	gate: string;
	result: "failed" | "passed";
	at: number;
};

/**
 * Waiting tickets that can join this train, oldest first, up to `max`.
 * Incompatible tickets (no lane snapshot, other dry-run mode, changed
 * checkout) are skipped rather than ending the train; they keep their place
 * and take the lock themselves next.
 */
export function selectTrain<T extends { lane: Lane | null }>(
	waiting: T[],
	dryRun: boolean,
	unchanged: (lane: Lane) => boolean,
	max = MAX_TRAIN_LANES,
): (T & { lane: Lane })[] {
	const train: (T & { lane: Lane })[] = [];
	for (const entry of waiting) {
		if (train.length >= max) break;
		const lane = entry.lane;
		if (!lane || lane.dryRun !== dryRun || !unchanged(lane)) continue;
		train.push({ ...entry, lane });
	}
	return train;
}

export function readHistory(file: string): TrainRecord[] {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as TrainRecord)
			.filter(
				(record) =>
					Number.isFinite(record.startedAt) &&
					Number.isFinite(record.finishedAt) &&
					Number.isFinite(record.lanes),
			);
	} catch {
		return [];
	}
}

export function recordTrain(file: string, record: TrainRecord) {
	const kept = readHistory(file).slice(-(HISTORY_KEEP - 1));
	writeFileSync(
		`${file}.tmp`,
		[...kept, record].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
	);
	renameSync(`${file}.tmp`, file);
}

export function readRetryHistory(file: string): RetryRecord[] {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as RetryRecord)
			.filter(
				(record) =>
					typeof record.key === "string" &&
					typeof record.gate === "string" &&
					(record.result === "failed" || record.result === "passed") &&
					Number.isFinite(record.at),
			);
	} catch {
		return [];
	}
}

export function recordRetry(file: string, record: RetryRecord) {
	const kept = readRetryHistory(file).slice(-(HISTORY_KEEP - 1));
	writeFileSync(
		`${file}.tmp`,
		[...kept, record].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
	);
	renameSync(`${file}.tmp`, file);
}

export function retryFailures(
	file: string,
	key: string,
	now = Date.now(),
): RetryRecord[] {
	const cutoff = now - 2 * 60 * 60 * 1000;
	let failures: RetryRecord[] = [];
	for (const record of readRetryHistory(file)) {
		if (record.key !== key || record.at < cutoff) continue;
		if (record.result === "passed") failures = [];
		else failures.push(record);
	}
	return failures;
}

export function retryRefusal(
	file: string,
	key: string,
	now = Date.now(),
): string | null {
	const failures = retryFailures(file, key, now);
	if (failures.length < 2 || process.env.TEDIX_PUSH_RETRY_OVERRIDE === "1")
		return null;
	return (
		`push: retry budget exhausted for ${key}; previous failures: ${failures
			.slice(-2)
			.map((failure) => failure.gate)
			.join(", ")}. ` +
		"post the failure on the Work item and hand off. " +
		"For a human override, set TEDIX_PUSH_RETRY_OVERRIDE=1."
	);
}

export function ticketKey(cwd: string): string {
	const workItem =
		process.env.TEDIX_WORK_ID?.trim() ||
		git(["log", "-1", "--format=%B"], false, cwd).out.match(
			/^Work-Item:\s*(\S+)/m,
		)?.[1] ||
		"unassigned";
	return `${resolve(cwd)}|${workItem}`;
}

export function gateName(output: string): string {
	const names = [...output.matchAll(/^✗\s+(.+?)(?:\s+\([^\n]*\))?$/gm)].map(
		(match) => match[1]!.trim(),
	);
	return names.at(-1) ?? "pre-push gates";
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60000))} min`;

/**
 * The line a waiting process prints: its place, the running train, and an
 * estimate from the median of recent lock holds (trains of up to
 * MAX_TRAIN_LANES lanes). No history means no estimate rather than a guess.
 */
export function waitNote({
	ticket,
	tickets,
	holder,
	history,
	now,
}: {
	ticket: string;
	tickets: string[];
	holder: Holder | null;
	history: TrainRecord[];
	now: number;
}): string {
	const inTrain = holder?.lanes?.includes(ticket) ?? false;
	const running = holder
		? holder.lanes?.length
			? `a train of ${holder.lanes.length} lanes has run for ${minutes(now - holder.startedAt)}`
			: `a push has run for ${minutes(now - holder.startedAt)}`
		: "the lock is free";
	if (inTrain) return `push: your lane is in the running train; ${running}.`;
	const ahead = tickets
		.slice(0, Math.max(tickets.indexOf(ticket), 0))
		.filter((name) => !holder?.lanes?.includes(name)).length;
	const durations = history
		.slice(-10)
		.map((record) => record.finishedAt - record.startedAt)
		.sort((a, b) => a - b);
	const place = `push: ${ahead} waiting ahead of you; ${running}`;
	if (!durations.length) return `${place}.`;
	const median = durations[Math.floor(durations.length / 2)]!;
	const remaining = holder ? Math.max(median - (now - holder.startedAt), 0) : 0;
	const start = remaining + Math.floor(ahead / MAX_TRAIN_LANES) * median;
	return `${place}. Estimated start in ~${minutes(start)}, done in ~${minutes(start + median)} (recent lock holds: ${minutes(median)} median).`;
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function isStale(
	holder: Holder | null,
	now: number,
	alive: (pid: number) => boolean = isAlive,
): boolean {
	if (
		!holder ||
		!Number.isFinite(holder.pid) ||
		!Number.isFinite(holder.startedAt)
	)
		return true;
	return (
		!alive(holder.pid) || (!holder.train && now - holder.startedAt > STALE_MS)
	);
}

function readHolder(file: string): Holder | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Holder;
	} catch {
		return null;
	}
}

/** Creates `file` atomically; on contention clears a stale holder once and retries. */
export function tryAcquire(
	file: string,
	now = Date.now(),
	alive: (pid: number) => boolean = isAlive,
): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(file, "wx");
			writeSync(
				fd,
				JSON.stringify({ pid: process.pid, startedAt: now } satisfies Holder),
			);
			closeSync(fd);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = readHolder(file);
			// A holder still writing its JSON reads as null; give it a moment.
			const stat = statSync(file, { throwIfNoEntry: false });
			if (holder === null && stat && now - stat.mtimeMs < 5000) return false;
			if (holder !== null && !isStale(holder, now, alive)) return false;
			rmSync(file, { force: true });
		}
	}
	return false;
}

/** Queue tickets (`<arrivalMs>-<pid>`) of live processes, oldest first; dead ones are removed. */
export function liveTickets(
	dir: string,
	alive: (pid: number) => boolean = isAlive,
): string[] {
	const tickets: string[] = [];
	for (const name of readdirSync(dir)) {
		const pid = Number(name.split("-")[1]);
		if (Number.isInteger(pid) && alive(pid)) tickets.push(name);
		else rmSync(join(dir, name), { force: true });
	}
	return tickets.sort(
		(a, b) =>
			Number(a.split("-")[0]) - Number(b.split("-")[0]) || a.localeCompare(b),
	);
}

function git(args: string[], inherit = false, cwd = process.cwd()) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: inherit ? "inherit" : "pipe",
	});
	return {
		ok: result.status === 0,
		out: (result.stdout ?? "").trim(),
		err: (result.stderr ?? "").trim(),
	};
}

function fetchAndRebase(expectedMain?: string): boolean {
	if (!git(["fetch", "--quiet", "origin", "main"], true).ok) return false;
	if (expectedMain && git(["rev-parse", "origin/main"]).out !== expectedMain) {
		console.error("push: main changed; refusing the conditional push.");
		return false;
	}
	const rebase = git(["rebase", "origin/main"], true);
	if (rebase.ok) return true;
	git(["rebase", "--abort"]);
	console.error(
		"push: rebase onto origin/main failed; resolve it and run again.",
	);
	return false;
}

function pushOnce(dryRun: boolean): {
	outcome: "pushed" | "main-moved" | "failed";
	gate?: string;
} {
	const args = [
		"push",
		...(dryRun ? ["--dry-run"] : []),
		"origin",
		"HEAD:main",
	];
	const push = git(args);
	if (push.out) console.log(push.out);
	if (push.err) console.error(push.err);
	if (push.ok) return { outcome: "pushed" };
	// Gates or the remote said no. It was a race only if main moved past us.
	git(["fetch", "--quiet", "origin", "main"]);
	return git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]).ok
		? { outcome: "failed", gate: gateName(`${push.out}\n${push.err}`) }
		: { outcome: "main-moved" };
}

/** True when the last worktree gc (stamp mtime) is a day old or missing. */
export function gcDue(stampFile: string, now = Date.now()): boolean {
	try {
		return now - statSync(stampFile).mtimeMs >= GC_EVERY_MS;
	} catch {
		return true;
	}
}

function startDailyWorktreeGc(commonDir: string) {
	if (process.env.TEDIX_DEVIN_HEADLESS === "1") return;
	const stamp = join(commonDir, "worktree-gc.stamp");
	if (!gcDue(stamp)) return;
	writeFileSync(stamp, `${new Date().toISOString()}\n`);
	const log = openSync(join(commonDir, "worktree-gc.log"), "w");
	const root = git(["rev-parse", "--show-toplevel"]).out;
	// Run from the main checkout: the pushing worktree is often removed right
	// after the push, which would leave the gc without a working directory.
	spawn(
		process.execPath,
		[
			join(root, "scripts/dev/worktree-gc.ts"),
			"--apply",
			"--base",
			"origin/main",
		],
		{
			cwd: dirname(commonDir),
			detached: true,
			stdio: ["ignore", log, log],
		},
	).unref();
	console.log(
		`push: daily worktree gc started (log: ${join(commonDir, "worktree-gc.log")}).`,
	);
}

async function main() {
	const dryRun = process.argv.includes("--dry-run");
	const expectedIndex = process.argv.indexOf("--expect-main");
	const expectedMain =
		expectedIndex < 0 ? undefined : process.argv[expectedIndex + 1];
	if (expectedIndex >= 0 && !/^[a-f0-9]{40}$/.test(expectedMain ?? ""))
		throw new Error("--expect-main needs an exact SHA");
	const commonDir = resolve(git(["rev-parse", "--git-common-dir"]).out);
	const queueDir = join(commonDir, "push-queue");
	const lockFile = join(commonDir, "push-queue.lock");
	mkdirSync(queueDir, { recursive: true });
	// Zero is understood by existing clients; priority never preempts the holder.
	const arrival = process.argv.includes("--priority") ? 0 : Date.now();
	const ticket = join(queueDir, `${arrival}-${process.pid}`);
	// A sandboxed lane cannot integrate or clean peer worktrees.
	const lane =
		expectedMain || process.env.TEDIX_DEVIN_HEADLESS === "1"
			? null
			: snapshotLane(process.cwd(), dryRun);
	const resultsDir = join(commonDir, "push-results");
	mkdirSync(resultsDir, { recursive: true });
	const retryFile = join(commonDir, "push-queue-retries.jsonl");
	const key = ticketKey(process.cwd());
	const refusal = retryRefusal(retryFile, key);
	if (refusal) {
		console.error(refusal);
		process.exit(1);
	}
	const resultTicket = join(resultsDir, ticket.slice(queueDir.length + 1));
	writeFileSync(ticket, lane ? JSON.stringify(lane) : "");

	const historyFile = join(commonDir, "push-queue-history.jsonl");
	const ticketName = ticket.slice(queueDir.length + 1);
	let held = false;
	let heldAt = 0;
	let heldLanes = 0;
	const release = () => {
		rmSync(ticket, { force: true });
		if (held && readHolder(lockFile)?.pid === process.pid) {
			if (heldLanes)
				try {
					recordTrain(historyFile, {
						startedAt: heldAt,
						finishedAt: Date.now(),
						lanes: heldLanes,
					});
				} catch {
					// The estimate is advisory; never fail a push over it.
				}
			rmSync(lockFile, { force: true });
		}
	};
	process.on("exit", release);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
		process.on(signal, () => process.exit(130));

	let lastKey = "";
	let lastPrinted = 0;
	while (true) {
		const result = readResult(resultTicket);
		if (result) {
			rmSync(resultFile(resultTicket), { force: true });
			process.exit(finishLane(lane, result, dryRun));
		}
		const tickets = liveTickets(queueDir);
		const ahead = tickets.indexOf(ticketName);
		if (ahead === 0 && tryAcquire(lockFile)) break;
		// Reprint on a new place or holder, otherwise once a minute.
		const holder = readHolder(lockFile);
		const key = `${ahead}:${holder?.pid}:${holder?.lanes?.length ?? 0}`;
		const now = Date.now();
		if (key !== lastKey || now - lastPrinted >= 60_000) {
			console.log(
				waitNote({
					ticket: ticketName,
					tickets,
					holder,
					history: readHistory(historyFile),
					now,
				}),
			);
			lastKey = key;
			lastPrinted = now;
		}
		await Bun.sleep(POLL_MS);
	}
	held = true;
	heldAt = Date.now();
	if (lane) recoverTrainResults(process.cwd(), commonDir);
	const recovered = readResult(resultTicket);
	if (recovered) {
		rmSync(resultFile(resultTicket), { force: true });
		process.exit(finishLane(lane, recovered, dryRun));
	}
	// Snapshot compatible tickets already waiting when the lock frees.
	const train = selectTrain(
		liveTickets(queueDir).map((name) => {
			const file = join(queueDir, name);
			return { file, lane: readLane(file) };
		}),
		dryRun,
		laneUnchanged,
	);
	if (lane && train.length > 1 && train[0]?.file === ticket) {
		heldLanes = train.length;
		// A fallback may run several full gates. Never steal a living train's lock
		// on the single-lane timeout; a dead holder is still recoverable.
		writeFileSync(
			lockFile,
			JSON.stringify({
				pid: process.pid,
				startedAt: Date.now(),
				train: true,
				lanes: train.map((entry) => entry.file.slice(queueDir.length + 1)),
			} satisfies Holder),
		);
		console.log(`push: lock held; forming train of ${train.length} lanes.`);
		const published = runTrain(
			process.cwd(),
			commonDir,
			train.map((entry) => ({
				...entry,
				result: join(resultsDir, entry.file.slice(queueDir.length + 1)),
			})),
			{
				onFailure: (cwd, gate) =>
					recordRetry(retryFile, {
						key: ticketKey(cwd),
						gate,
						result: "failed",
						at: Date.now(),
					}),
				onPass: (cwd) =>
					recordRetry(retryFile, {
						key: ticketKey(cwd),
						gate: "pass",
						result: "passed",
						at: Date.now(),
					}),
			},
		);
		if (published) {
			startDailyWorktreeGc(commonDir);
		}
		const result = readResult(resultTicket);
		if (!result) throw new Error("train did not return this lane's result");
		rmSync(resultFile(resultTicket), { force: true });
		process.exit(finishLane(lane, result, dryRun));
	}
	rmSync(ticket, { force: true });
	heldLanes = 1;
	console.log(
		`push: lock held; rebasing onto origin/main${dryRun ? " (dry run)" : ""}.`,
	);

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (!fetchAndRebase(expectedMain)) process.exit(1);
		const outcome = pushOnce(dryRun);
		if (outcome.outcome === "pushed") {
			recordRetry(retryFile, {
				key,
				gate: "pass",
				result: "passed",
				at: Date.now(),
			});
			console.log(
				dryRun
					? "push: dry run passed; nothing pushed."
					: "push: pushed to main.",
			);
			if (!dryRun) {
				startDailyWorktreeGc(commonDir);
			}
			process.exit(0);
		}
		if (outcome.outcome === "failed") {
			recordRetry(retryFile, {
				key,
				gate: outcome.gate ?? "pre-push gates",
				result: "failed",
				at: Date.now(),
			});
			console.error(
				"push: rejected by a gate or the remote; fix it and run again.",
			);
			process.exit(1);
		}
		if (attempt < MAX_RETRIES)
			console.log(
				`push: main moved elsewhere; rebasing and retrying (${attempt + 1}/${MAX_RETRIES}).`,
			);
	}
	console.error("push: main kept moving; run again.");
	process.exit(1);
}

if (import.meta.main) {
	if (!process.env.TEDIX_PUSH_QUEUE_SNAPSHOT) process.exit(runCurrentQueue());
	await main();
}
