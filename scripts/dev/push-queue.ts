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
 * compatible tickets wait, push-train.ts integrates them in a temporary
 * worktree and pushes once through the same hook, falling back to per-lane
 * gates on rejection. A single ticket keeps the original rebase/push path.
 *
 * Dead holders and tickets are removed. Single-lane locks also expire after
 * STALE_MS; living trains may need longer for fallback. No daemon.
 *
 * A successful push also asks tedix-cloud-ops to run Ship now (fail-soft, via
 * `gh`), so a change goes live in minutes instead of waiting for the
 * quarter-hourly schedule, which stays as the fallback for other pushes.
 *
 * At most once a week, a successful push also starts `worktree:gc --apply` in
 * the background (log in <git-common-dir>/worktree-gc.log), so finished
 * worktrees are removed without anyone scheduling it. That command only
 * removes merged, clean, idle worktrees no process is using.
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
	writeFileSync,
	rmSync,
	statSync,
	writeSync,
	closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	finishLane,
	laneUnchanged,
	readLane,
	readResult,
	recoverTrainResults,
	resultFile,
	runTrain,
	snapshotLane,
} from "./push-train";

export const STALE_MS = 30 * 60 * 1000;
const POLL_MS = 2000;
const MAX_RETRIES = 2;
export const GC_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

export type Holder = { pid: number; startedAt: number; train?: boolean };

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

function git(args: string[], inherit = false) {
	const result = spawnSync("git", args, {
		encoding: "utf8",
		stdio: inherit ? "inherit" : "pipe",
	});
	return {
		ok: result.status === 0,
		out: (result.stdout ?? "").trim(),
		err: (result.stderr ?? "").trim(),
	};
}

function fetchAndRebase(): boolean {
	if (!git(["fetch", "--quiet", "origin", "main"], true).ok) return false;
	const rebase = git(["rebase", "origin/main"], true);
	if (rebase.ok) return true;
	git(["rebase", "--abort"]);
	console.error(
		"push: rebase onto origin/main failed; resolve it and run again.",
	);
	return false;
}

function pushOnce(dryRun: boolean): "pushed" | "main-moved" | "failed" {
	const args = [
		"push",
		...(dryRun ? ["--dry-run"] : []),
		"origin",
		"HEAD:main",
	];
	if (git(args, true).ok) return "pushed";
	// Gates or the remote said no. It was a race only if main moved past us.
	git(["fetch", "--quiet", "origin", "main"]);
	return git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]).ok
		? "failed"
		: "main-moved";
}

/** True when the last weekly worktree gc (stamp mtime) is a week old or missing. */
export function gcDue(stampFile: string, now = Date.now()): boolean {
	try {
		return now - statSync(stampFile).mtimeMs >= GC_EVERY_MS;
	} catch {
		return true;
	}
}

function requestShip() {
	const run = spawnSync(
		"gh",
		["workflow", "run", "ship.yml", "--repo", "tedix-hq/tedix-cloud-ops"],
		{
			encoding: "utf8",
			timeout: 20_000,
		},
	);
	console.log(
		run.status === 0
			? "push: asked Ship to deploy now."
			: "push: could not start Ship (gh); the schedule will deploy this.",
	);
}

function startWeeklyWorktreeGc(commonDir: string) {
	const stamp = join(commonDir, "worktree-gc.stamp");
	if (!gcDue(stamp)) return;
	writeFileSync(stamp, `${new Date().toISOString()}\n`);
	const log = openSync(join(commonDir, "worktree-gc.log"), "w");
	const root = git(["rev-parse", "--show-toplevel"]).out;
	spawn(
		process.execPath,
		["scripts/dev/worktree-gc.ts", "--apply", "--base", "origin/main"],
		{
			cwd: root,
			detached: true,
			stdio: ["ignore", log, log],
		},
	).unref();
	console.log(
		`push: weekly worktree gc started (log: ${join(commonDir, "worktree-gc.log")}).`,
	);
}

async function main() {
	const dryRun = process.argv.includes("--dry-run");
	const commonDir = resolve(git(["rev-parse", "--git-common-dir"]).out);
	const queueDir = join(commonDir, "push-queue");
	const lockFile = join(commonDir, "push-queue.lock");
	mkdirSync(queueDir, { recursive: true });
	const ticket = join(queueDir, `${Date.now()}-${process.pid}`);
	const lane = snapshotLane(process.cwd(), dryRun);
	const resultsDir = join(commonDir, "push-results");
	mkdirSync(resultsDir, { recursive: true });
	const resultTicket = join(resultsDir, ticket.slice(queueDir.length + 1));
	writeFileSync(ticket, lane ? JSON.stringify(lane) : "");

	let held = false;
	const release = () => {
		rmSync(ticket, { force: true });
		if (held && readHolder(lockFile)?.pid === process.pid)
			rmSync(lockFile, { force: true });
	};
	process.on("exit", release);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
		process.on(signal, () => process.exit(130));

	let lastNote = "";
	while (true) {
		const result = readResult(resultTicket);
		if (result) {
			rmSync(resultFile(resultTicket), { force: true });
			process.exit(finishLane(lane, result, dryRun));
		}
		const tickets = liveTickets(queueDir);
		const ahead = tickets.indexOf(ticket.slice(queueDir.length + 1));
		if (ahead === 0 && tryAcquire(lockFile)) break;
		const waiting = Math.max(ahead, 0) + 1; // the ones ahead, plus the holder
		const note = `push: waiting for ${waiting} other push${waiting === 1 ? "" : "es"}...`;
		if (note !== lastNote) console.log((lastNote = note));
		await Bun.sleep(POLL_MS);
	}
	held = true;
	recoverTrainResults(process.cwd(), commonDir);
	const recovered = readResult(resultTicket);
	if (recovered) {
		rmSync(resultFile(resultTicket), { force: true });
		process.exit(finishLane(lane, recovered, dryRun));
	}
	// Snapshot only compatible tickets already waiting when the lock frees.
	const train = [];
	for (const name of liveTickets(queueDir)) {
		const file = join(queueDir, name);
		const waiting = readLane(file);
		if (!waiting || waiting.dryRun !== dryRun || !laneUnchanged(waiting)) break;
		train.push({ file, lane: waiting });
	}
	if (lane && train.length > 1 && train[0]?.file === ticket) {
		// A fallback may run several full gates. Never steal a living train's lock
		// on the single-lane timeout; a dead holder is still recoverable.
		writeFileSync(
			lockFile,
			JSON.stringify({
				pid: process.pid,
				startedAt: Date.now(),
				train: true,
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
		);
		if (published) {
			requestShip();
			startWeeklyWorktreeGc(commonDir);
		}
		const result = readResult(resultTicket);
		if (!result) throw new Error("train did not return this lane's result");
		rmSync(resultFile(resultTicket), { force: true });
		process.exit(finishLane(lane, result, dryRun));
	}
	rmSync(ticket, { force: true });
	console.log(
		`push: lock held; rebasing onto origin/main${dryRun ? " (dry run)" : ""}.`,
	);

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (!fetchAndRebase()) process.exit(1);
		const outcome = pushOnce(dryRun);
		if (outcome === "pushed") {
			console.log(
				dryRun
					? "push: dry run passed; nothing pushed."
					: "push: pushed to main.",
			);
			if (!dryRun) {
				requestShip();
				startWeeklyWorktreeGc(commonDir);
			}
			process.exit(0);
		}
		if (outcome === "failed") {
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

if (import.meta.main) await main();
