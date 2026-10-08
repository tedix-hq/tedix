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
 * retries up to twice. Waiting sessions block in arrival order.
 *
 * A lock whose process is gone, or that is older than STALE_MS, is removed, as
 * is a queue ticket whose process is gone. No daemon.
 *
 *   bun run push              # queue, rebase, gate, push
 *   bun run push --dry-run    # same, but `git push --dry-run` (gates still run)
 */

import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
	closeSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const STALE_MS = 30 * 60 * 1000;
const POLL_MS = 2000;
const MAX_RETRIES = 2;

export type Holder = { pid: number; startedAt: number };

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
	return !alive(holder.pid) || now - holder.startedAt > STALE_MS;
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

async function main() {
	const dryRun = process.argv.includes("--dry-run");
	const commonDir = resolve(git(["rev-parse", "--git-common-dir"]).out);
	const queueDir = join(commonDir, "push-queue");
	const lockFile = join(commonDir, "push-queue.lock");
	mkdirSync(queueDir, { recursive: true });
	const ticket = join(queueDir, `${Date.now()}-${process.pid}`);
	closeSync(openSync(ticket, "w"));

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
		const tickets = liveTickets(queueDir);
		const ahead = tickets.indexOf(ticket.slice(queueDir.length + 1));
		if (ahead === 0 && tryAcquire(lockFile)) break;
		const waiting = Math.max(ahead, 0) + 1; // the ones ahead, plus the holder
		const note = `push: waiting for ${waiting} other push${waiting === 1 ? "" : "es"}...`;
		if (note !== lastNote) console.log((lastNote = note));
		await Bun.sleep(POLL_MS);
	}
	held = true;
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
