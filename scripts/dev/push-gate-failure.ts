/**
 * What a failed pre-push run means for the change being pushed.
 *
 * The retry budget in push-queue.ts exists to stop a session looping on a
 * change that keeps failing. On 15 Nov 2026 it stranded a finished commit
 * instead: one gate failed because a test fixture timed out on a starved
 * machine, and that spent the budget like a failed assertion would. A day
 * later another push was refused for a type error that origin/main already
 * had. So a failure now has a kind, decided by the gate runner
 * (scripts/ci/preflight-gates.mjs) and read by the queue:
 *
 * - "change": the gate ran and rejected this change. Blocks and counts.
 * - "infrastructure": the gate was killed, or every failure in it was a test
 *   runner timeout or the machine running out of something. Blocks, counted
 *   on a separate, larger allowance.
 * - "main": the same gate fails on the push base without this change. Blocks,
 *   never counted.
 *
 * Anything unrecognized is "change". Nothing here lets a push through.
 */

export type GateFailureKind = "change" | "infrastructure" | "main";
export type GateVerdict = { kind: GateFailureKind; gate: string };

const VERDICT_PREFIX = "pre-push-verdict: ";

/** One failed test or suite as vitest (`FAIL`) and bun test (`(fail)`) print it. */
const FAILED_TEST = /^\s*(?:FAIL\s|\(fail\)\s)/gm;
/** The line each runner prints once per timed-out test or hook. */
const TIMED_OUT =
	/^\s*(?:Error: (?:Test|Hook) timed out in \d+ ?ms|\^ this test timed out after \d+ ?ms)/gm;
/**
 * A rejection no timeout explains, whatever else the output holds. A change
 * that makes a test hang reads as a timeout; it still blocks, and the
 * infrastructure allowance still ends the loop.
 */
const REJECTED =
	/AssertionError|\berror TS\d+|^error: expect\(|Unhandled (?:Rejection|Error)|Snapshot .* mismatched/m;
const MACHINE_EXHAUSTED =
	/JavaScript heap out of memory|\bENOSPC\b|\bENOMEM\b|\bEMFILE\b|\bENFILE\b|Cannot allocate memory|too many open files/i;

/**
 * Why a gate that exited non-zero failed. A timeout only excuses the gate when
 * every failed test in it timed out: one assertion beside a timeout is still
 * the change's failure.
 */
export function gateFailureKind(run: {
	output: string;
	/** The signal that ended the gate process, when one did. */
	signal?: string | null;
	/** The gate process could not be started or collected. */
	spawnFailed?: boolean;
}): "change" | "infrastructure" {
	if (run.signal || run.spawnFailed) return "infrastructure";
	if (REJECTED.test(run.output)) return "change";
	const failed = run.output.match(FAILED_TEST)?.length ?? 0;
	const timedOut = run.output.match(TIMED_OUT)?.length ?? 0;
	if (timedOut > 0 && failed <= timedOut) return "infrastructure";
	if (failed === 0 && MACHINE_EXHAUSTED.test(run.output))
		return "infrastructure";
	return "change";
}

/**
 * One verdict for the whole run. A failure of the change outranks the others
 * (it has to be fixed whatever main does); a red main outranks a timeout (a
 * retry cannot pass until main is fixed).
 */
export function overallVerdict(failures: GateVerdict[]): GateVerdict | null {
	for (const kind of ["change", "main", "infrastructure"] as const) {
		const found = failures.filter((failure) => failure.kind === kind).at(-1);
		if (found) return found;
	}
	return null;
}

export function formatVerdict(verdict: GateVerdict): string {
	return `${VERDICT_PREFIX}${JSON.stringify(verdict)}`;
}

/** The verdict line of the gate runner, or null when the output has none. */
export function parseVerdict(output: string): GateVerdict | null {
	for (const line of output.split("\n").reverse()) {
		const at = line.indexOf(VERDICT_PREFIX);
		if (at < 0) continue;
		try {
			const verdict = JSON.parse(line.slice(at + VERDICT_PREFIX.length));
			if (
				typeof verdict?.gate === "string" &&
				["change", "infrastructure", "main"].includes(verdict.kind)
			)
				return { kind: verdict.kind, gate: verdict.gate };
		} catch {
			// A torn line is no verdict; the caller falls back to "change".
		}
		return null;
	}
	return null;
}

/** Null means preflight could not load; no gate result exists to charge. */
export function failedPushGate(output: string): string | null {
	const names = [...output.matchAll(/^✗\s+(.+?)(?:\s+\([^\n]*\))?$/gm)].map(
		(match) => match[1]!.trim(),
	);
	if (
		names.length === 0 &&
		!/pre-push: .*(?:\(\d+\/\d+\)|: (?:passed|failed)|gates? (?:passed|failed))/.test(
			output,
		) &&
		/(?:^error: Cannot find (?:package|module)|\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b)/m.test(
			output,
		)
	)
		return null;
	return names.at(-1) ?? UNNAMED_GATE;
}

/** The hook or the remote said no without naming a gate. */
export const UNNAMED_GATE = "pre-push gates";

/**
 * What a rejected `git push` means: the gate runner's verdict when it gave
 * one, otherwise a failure of the change (an older checkout's hook, a hook
 * script outside the gate runner, or the remote). Null: preflight never loaded.
 */
export function pushRejection(output: string): GateVerdict | null {
	const verdict = parseVerdict(output);
	if (verdict) return verdict;
	const gate = failedPushGate(output);
	return gate === null ? null : { kind: "change", gate };
}

/** How many gate failures of each kind one checkout and Work Item gets in the window. */
export const RETRY_WINDOW_MS = 2 * 60 * 60 * 1000;
export const CHANGE_FAILURE_LIMIT = 2;
export const INFRASTRUCTURE_FAILURE_LIMIT = 6;

export type PushRefusal =
	| { reason: "gate"; verdict: GateVerdict }
	| { reason: "change-budget"; gates: string[] }
	| { reason: "infrastructure-budget"; gate: string }
	| { reason: "dependencies" }
	| { reason: "fetch" }
	| { reason: "conflict" }
	| { reason: "expected-main" }
	| { reason: "main-moving" }
	| { reason: "secret-scan" };

/**
 * The one sentence every refused push ends with, written so a runner can copy
 * it onto its Work Item unchanged: what stopped the push and what to do next.
 */
export function refusalSentence(refusal: PushRefusal): string {
	switch (refusal.reason) {
		case "gate": {
			const gate = `the pre-push gate "${refusal.verdict.gate}"`;
			if (refusal.verdict.kind === "main")
				return `Push refused: origin/main itself fails ${gate}, so this change is not the cause and is not charged; wait for main to be fixed, then run bun run push again.`;
			if (refusal.verdict.kind === "infrastructure")
				return `Push refused: ${gate} timed out or hit a machine error instead of failing an assertion, so the change is not blamed; run bun run push again.`;
			if (refusal.verdict.gate === UNNAMED_GATE)
				return "Push refused: the pre-push hook or the remote rejected this change without naming a gate; fix what the output above reports, then run bun run push again.";
			return `Push refused: ${gate} failed on this change; fix what it reports, then run bun run push again.`;
		}
		case "change-budget":
			return `Push refused: this change already failed pre-push gates ${CHANGE_FAILURE_LIMIT} times in 2 hours (${refusal.gates.join(", ")}), so post that on the Work Item and hand off; only a person may override with TEDIX_PUSH_RETRY_OVERRIDE=1.`;
		case "infrastructure-budget":
			return `Push refused: pre-push gates timed out or hit machine errors ${INFRASTRUCTURE_FAILURE_LIMIT} times in 2 hours (last: ${refusal.gate}), so the machine is too loaded to check this change; post that on the Work Item and hand off.`;
		case "dependencies":
			return "Push refused: the pre-push checks could not load their dependencies, and the retry budget is unchanged; run bun install --frozen-lockfile, then bun run push again.";
		case "fetch":
			return "Push refused: origin/main could not be fetched or checked out; check the network, then run bun run push again.";
		case "conflict":
			return "Push refused: this change conflicts with origin/main or with a change published just before it; rebase onto origin/main, resolve the conflict, then run bun run push again.";
		case "expected-main":
			return "Push refused: main is no longer at the commit this conditional push expected; nothing was checked or pushed.";
		case "main-moving":
			return "Push refused: main moved every time this change was checked; run bun run push again.";
		case "secret-scan":
			return "Push refused: the secret scan rejected a commit in this change; remove the value from the commit, then run bun run push again.";
	}
}
