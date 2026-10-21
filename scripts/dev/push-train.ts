import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { detachedGitEnv } from "../oss/git-env";
import { pushesToCanonicalRepo } from "../ci/push-range-selection.mjs";

export type Lane = {
	version: 1;
	cwd: string;
	head: string;
	base: string;
	branch: string;
	dryRun: boolean;
};
export type TrainTicket = { file: string; result: string; lane: Lane };
export type TrainResult = { code: number; sha?: string; message: string };

function git(cwd: string, args: string[], ranges?: string[]) {
	const result = spawnSync("git", args, {
		cwd,
		env: {
			...detachedGitEnv(),
			TEDIX_PUSH_TRAIN_RANGES: JSON.stringify(ranges ?? []),
		},
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return {
		ok: result.status === 0,
		out: result.stdout?.trim() ?? "",
		err: result.stderr?.trim() ?? "",
	};
}

export function snapshotLane(cwd: string, dryRun: boolean): Lane | null {
	const head = git(cwd, ["rev-parse", "HEAD"]);
	const base = git(cwd, ["merge-base", "HEAD", "origin/main"]);
	const branch = git(cwd, ["symbolic-ref", "-q", "HEAD"]);
	if (
		!head.ok ||
		!base.ok ||
		!branch.ok ||
		git(cwd, ["status", "--porcelain"]).out
	)
		return null;
	// Keep merge histories on the established single-lane rebase path.
	const merges = git(cwd, ["rev-list", "--merges", `${base.out}..${head.out}`]);
	if (!merges.ok || merges.out) return null;
	return {
		version: 1,
		cwd,
		head: head.out,
		base: base.out,
		branch: branch.out,
		dryRun,
	};
}

export function readLane(file: string): Lane | null {
	try {
		const lane = JSON.parse(readFileSync(file, "utf8"));
		return lane.version === 1 &&
			typeof lane.cwd === "string" &&
			/^[a-f0-9]{40}$/.test(lane.head) &&
			/^[a-f0-9]{40}$/.test(lane.base) &&
			typeof lane.branch === "string" &&
			typeof lane.dryRun === "boolean"
			? lane
			: null;
	} catch {
		return null;
	}
}

export function laneUnchanged(lane: Lane): boolean {
	return (
		git(lane.cwd, ["rev-parse", "HEAD"]).out === lane.head &&
		git(lane.cwd, ["symbolic-ref", "-q", "HEAD"]).out === lane.branch &&
		git(lane.cwd, ["status", "--porcelain"]).out === ""
	);
}

export function resultFile(ticket: string): string {
	return `${ticket}.json`;
}

export function writeResult(ticket: string, result: TrainResult) {
	const file = resultFile(ticket);
	writeFileSync(`${file}.tmp`, JSON.stringify(result));
	renameSync(`${file}.tmp`, file);
}

export function readResult(ticket: string): TrainResult | null {
	try {
		return JSON.parse(readFileSync(resultFile(ticket), "utf8"));
	} catch {
		return null;
	}
}

/** Recover receipts only after proving that the prepared candidate reached main. */
export function recoverTrainResults(cwd: string, commonDir: string) {
	const journals = readdirSync(commonDir).filter((name) =>
		/^push-train-.*\.json$/.test(name),
	);
	if (!journals.length || !git(cwd, ["fetch", "--quiet", "origin", "main"]).ok)
		return;
	for (const name of journals) {
		const file = join(commonDir, name);
		const journal = JSON.parse(readFileSync(file, "utf8")) as {
			head: string;
			accepted: { ticket: TrainTicket; sha: string }[];
		};
		if (
			!git(cwd, ["merge-base", "--is-ancestor", journal.head, "origin/main"]).ok
		)
			continue;
		for (const { ticket, sha } of journal.accepted) {
			writeResult(ticket.result, {
				code: 0,
				sha,
				message: "recovered published train",
			});
			rmSync(ticket.file, { force: true });
		}
		rmSync(file);
	}
}

export function finishLane(
	lane: Lane | null,
	result: TrainResult,
	dryRun: boolean,
): number {
	console.log(
		`push: ${result.message}${result.sha ? `; pushed SHA ${result.sha}` : ""}.`,
	);
	if (result.code === 0 && result.sha && !dryRun && lane) {
		if (
			!laneUnchanged(lane) ||
			!git(lane.cwd, ["reset", "--keep", result.sha]).ok
		)
			console.log(
				"push: checkout changed while queued; left it intact. Reconcile with the pushed SHA before further work.",
			);
	}
	return result.code;
}

/** Batches at or below this size fall back lane by lane; larger ones split in half. */
export const LINEAR_FALLBACK_MAX = 3;

/**
 * Arrival-ordered halves for a rejected candidate. One red lane among n costs
 * about 1 + 2·log2(n) gate runs instead of 1 + n; batches of up to
 * LINEAR_FALLBACK_MAX lanes go one by one, where that is no worse.
 */
export function splitRejected<T>(batch: T[]): T[][] {
	if (batch.length <= LINEAR_FALLBACK_MAX) return batch.map((item) => [item]);
	const middle = Math.ceil(batch.length / 2);
	return [batch.slice(0, middle), batch.slice(middle)];
}

type Skip = { ticket: TrainTicket; reason: "conflict" | "scan" };
type Attempt = {
	pushed: boolean;
	accepted: { ticket: TrainTicket; sha: string }[];
	skipped: Skip[];
};

const REJECTED = "lane rejected by a gate or the remote; fix it and run again";
const UNREACHABLE = "could not fetch or reset to origin/main; run again";
const SKIP_MESSAGES: Record<Skip["reason"], string> = {
	conflict:
		"lane conflicts with main or with lanes published before it; rebase onto origin/main and run again",
	scan: "secret scan rejected a commit in this lane; fix it and run again",
};

/**
 * One normal push/hook per candidate. A lane that conflicts or fails the
 * per-commit scan is left out and retried alone after the rest; a rejected
 * candidate is split (splitRejected) and each part re-gated from fresh main.
 */
export function runTrain(
	cwd: string,
	commonDir: string,
	tickets: TrainTicket[],
): boolean {
	// Vite cannot load workspace tests from Git's metadata directory.
	const worktreeRoot = join(commonDir, "..", ".worktrees");
	mkdirSync(worktreeRoot, { recursive: true });
	const integration = mkdtempSync(join(worktreeRoot, "push-train-"));
	const journal = join(commonDir, `${basename(integration)}.json`);
	let published = false;
	const complete = (ticket: TrainTicket, result: TrainResult) => {
		// Results are outside the ticket directory: old queue binaries must not
		// mistake them for waiting processes during a rolling upgrade.
		writeResult(ticket.result, result);
		rmSync(ticket.file, { force: true });
	};
	try {
		if (
			!git(cwd, [
				"worktree",
				"add",
				"--detach",
				integration,
				tickets[0]!.lane.head,
			]).ok
		)
			throw new Error("could not create integration worktree");
		const requirePrivateRules = pushesToCanonicalRepo(
			git(integration, ["remote", "get-url", "--push", "origin"]).out,
		);
		/** Applies one lane on HEAD; on failure HEAD is back where it started. */
		const apply = (ticket: TrainTicket): Skip["reason"] | null => {
			const start = git(integration, ["rev-parse", "HEAD"]).out;
			const undo = (reason: Skip["reason"]) => {
				git(integration, ["cherry-pick", "--abort"]);
				git(integration, ["reset", "--hard", start]);
				return reason;
			};
			const commits = git(integration, [
				"rev-list",
				"--reverse",
				"--cherry-pick",
				"--right-only",
				`HEAD...${ticket.lane.head}`,
				`^${ticket.lane.base}`,
			]);
			if (!commits.ok) return undo("conflict");
			for (const commit of commits.out.split("\n").filter(Boolean)) {
				// Shared commits between lanes may already be applied.
				const parent = git(integration, ["rev-parse", "HEAD"]).out;
				if (!git(integration, ["cherry-pick", "--empty=drop", commit]).ok)
					return undo("conflict");
				const head = git(integration, ["rev-parse", "HEAD"]).out;
				if (head === parent) continue;
				const files = git(integration, [
					"diff",
					"--name-only",
					"--no-renames",
					"-z",
					parent,
					head,
				]);
				if (!files.ok) return undo("conflict");
				// Scan each intermediate tree before another lane can remove a
				// secret from the final diff. Heavy preflight still runs once.
				const scan = spawnSync(
					process.execPath,
					[
						"scripts/oss/secret-scan.ts",
						"--public",
						...(requirePrivateRules ? ["--require-private-rules"] : []),
						"--base",
						parent,
						"--head",
						head,
						"--paths",
						...files.out.split("\0").filter(Boolean),
					],
					{ cwd: integration, env: detachedGitEnv(), encoding: "utf8" },
				);
				if (scan.status !== 0) {
					console.error(scan.stdout, scan.stderr);
					return undo("scan");
				}
			}
			return null;
		};
		const attempt = (batch: TrainTicket[]): Attempt => {
			let accepted: Attempt["accepted"] = [];
			let skipped: Skip[] = [];
			for (let retry = 0; retry <= 2; retry++) {
				if (!git(integration, ["fetch", "--quiet", "origin", "main"]).ok) break;
				const base = git(integration, ["rev-parse", "origin/main"]).out;
				if (!git(integration, ["reset", "--hard", base]).ok) break;
				accepted = [];
				skipped = [];
				const ranges: string[] = [];
				for (const ticket of batch) {
					const reason = apply(ticket);
					if (reason) {
						console.log(
							`push: left ${basename(ticket.file)} out of this candidate (${reason}); it is retried alone afterwards.`,
						);
						skipped.push({ ticket, reason });
						continue;
					}
					accepted.push({
						ticket,
						sha: git(integration, ["rev-parse", "HEAD"]).out,
					});
					// Original ranges retain checks hidden by later lanes reverting
					// files. The normal hook also supplies the actual published range.
					ranges.push("--base", ticket.lane.base, "--head", ticket.lane.head);
				}
				if (!accepted.length) return { pushed: false, accepted, skipped };
				const dryRun = batch[0]!.lane.dryRun;
				if (!dryRun) {
					writeFileSync(
						`${journal}.tmp`,
						JSON.stringify({
							head: git(integration, ["rev-parse", "HEAD"]).out,
							accepted,
						}),
					);
					renameSync(`${journal}.tmp`, journal);
				}
				const push = git(
					integration,
					["push", ...(dryRun ? ["--dry-run"] : []), "origin", "HEAD:main"],
					ranges,
				);
				if (push.out) console.log(push.out);
				if (push.err) console.error(push.err);
				if (push.ok) {
					for (const { ticket, sha } of accepted)
						complete(ticket, {
							code: 0,
							...(dryRun ? {} : { sha }),
							message: dryRun
								? "train dry run passed; nothing pushed"
								: "train pushed to main",
						});
					rmSync(journal, { force: true });
					published ||= !dryRun;
					return { pushed: true, accepted, skipped };
				}
				rmSync(journal, { force: true });
				if (
					!git(integration, ["fetch", "--quiet", "origin", "main"]).ok ||
					git(integration, ["rev-parse", "origin/main"]).out === base
				)
					break;
			}
			return { pushed: false, accepted, skipped };
		};
		const deferred: Skip[] = [];
		const run = (batch: TrainTicket[]) => {
			const outcome = attempt(batch);
			deferred.push(...outcome.skipped);
			if (outcome.pushed) return;
			if (!outcome.accepted.length && !outcome.skipped.length) {
				// Fetch or reset failed before any lane was integrated.
				for (const ticket of batch)
					complete(ticket, { code: 1, message: UNREACHABLE });
				return;
			}
			const rejected = outcome.accepted.map(({ ticket }) => ticket);
			if (rejected.length === 1) {
				complete(rejected[0]!, { code: 1, message: REJECTED });
				return;
			}
			const parts = splitRejected(rejected);
			console.log(
				`push: candidate of ${rejected.length} lanes rejected; re-gating as ${parts.map((part) => part.length).join(" + ")}.`,
			);
			for (const part of parts) run(part);
		};
		run(tickets);
		// Left-out lanes run alone on the new main: a conflict with a lane that
		// has since published fails without a gate; an unrelated one still lands.
		for (const { ticket, reason } of deferred) {
			const solo = attempt([ticket]);
			if (solo.pushed) continue;
			complete(ticket, {
				code: 1,
				message: solo.skipped.length
					? SKIP_MESSAGES[solo.skipped[0]!.reason]
					: solo.accepted.length
						? REJECTED
						: SKIP_MESSAGES[reason],
			});
		}
	} finally {
		git(cwd, ["worktree", "remove", "--force", integration]);
		rmSync(integration, { recursive: true, force: true });
	}
	return published;
}
