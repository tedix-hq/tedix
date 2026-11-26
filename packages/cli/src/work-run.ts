import { spawn } from "node:child_process";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { errorText } from "./format";
import { createLeaseRenewer } from "./lease-renewer";
import { cachedAttemptId, withSession, WORK_EXIT_FAIL } from "./work-identity";
import { workComplete, workSettle, workStart } from "./work-lifecycle";
import { boardCall, nativeCommands } from "./work-native";
import { resolveWorkItemId } from "./work-queries";
import type { WorkContext } from "./work";

export async function workRun(ctx: WorkContext, id: string): Promise<number> {
	const argv = ctx.work.command;
	if (!id || !argv?.[0])
		throw new Error("work run requires <id> -- <command> [args...]");
	id = await resolveWorkItemId(ctx, id);
	let expiresAt = NaN;
	const started = await workStart(ctx, id, (attempt) => {
		expiresAt =
			typeof attempt.expiresAt === "string"
				? Date.parse(attempt.expiresAt)
				: NaN;
	});
	if (started) return started;
	const attemptId = cachedAttemptId(ctx, id)!;
	let interrupted = ctx.signal?.aborted ?? false;
	let failure: string | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	let thrown: unknown;
	const stop = (signal: NodeJS.Signals) => {
		if (!child?.pid) return;
		try {
			if (process.platform === "win32") child.kill(signal);
			else process.kill(-child.pid, signal);
		} catch (error) {
			if (!isRecord(error) || error.code !== "ESRCH") throw error;
		}
	};
	const loseLease = (reason: string) => {
		failure = reason;
		stop("SIGKILL");
	};
	const resetDeadline = () => {
		// Each renewal and settlement gets its own bounded transport budget.
		nativeCommands.get(ctx)!.deadlineAt =
			Date.now() + ctx.client.getTimeoutMs();
	};
	const renewer = createLeaseRenewer({
		expiresAt:
			Number.isFinite(expiresAt) && expiresAt > Date.now()
				? expiresAt
				: undefined,
		onLost: () => loseLease("Attempt lease expired during renewal"),
		step: async () => {
			if (finished || interrupted || failure) return { kind: "stop" };
			if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
				loseLease("Attempt has no confirmed future lease");
				return { kind: "stop" };
			}
			if (cachedAttemptId(ctx, id) !== attemptId) {
				loseLease("Attempt fence changed while the command was running");
				return { kind: "stop" };
			}
			resetDeadline();
			try {
				const result = await boardCall(
					ctx,
					"work.heartbeat_work_item_attempt",
					withSession(ctx, { id, attemptId }),
				);
				if (finished || interrupted || failure) return { kind: "stop" };
				if (result.error) {
					loseLease(`Attempt renewal refused: ${result.error.message}`);
					return { kind: "stop" };
				}
				const renewedExpiry =
					isRecord(result.value) && typeof result.value.expiresAt === "string"
						? Date.parse(result.value.expiresAt)
						: NaN;
				if (!Number.isFinite(renewedExpiry)) {
					loseLease("Attempt has no confirmed future lease");
					return { kind: "stop" };
				}
				expiresAt = renewedExpiry;
				return { kind: "renewed", expiresAt: renewedExpiry };
			} catch (error) {
				thrown = error;
				return { kind: "stop" };
			}
		},
	});
	const onAbort = () => {
		interrupted = true;
		renewer.stop();
		stop("SIGINT");
		killTimer = setTimeout(() => stop("SIGKILL"), 1_000);
	};
	ctx.signal?.addEventListener("abort", onAbort, { once: true });
	let exitCode = 130;
	let reason = "Command interrupted";
	try {
		if (!interrupted) {
			if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
				loseLease("Attempt has no confirmed future lease");
			} else {
				child = spawn(argv[0], argv.slice(1), {
					stdio: "inherit",
					detached: process.platform !== "win32",
				});
				const result = await new Promise<{ code: number; reason: string }>(
					(resolve) => {
						child!.once("error", (error) =>
							resolve({ code: 1, reason: errorText(error) }),
						);
						child!.once("close", (code, signal) =>
							resolve({
								code: code ?? 1,
								reason: signal
									? `Command stopped by ${signal}`
									: `Command exited with code ${code}`,
							}),
						);
					},
				);
				exitCode = result.code;
				reason = result.reason;
			}
		}
	} finally {
		finished = true;
		renewer.stop();
		clearTimeout(killTimer);
		if (interrupted) stop("SIGKILL");
		ctx.signal?.removeEventListener("abort", onAbort);
	}
	// Do not race settlement against a heartbeat already in flight.
	await renewer.done;
	if (thrown !== undefined) throw thrown;
	if (failure) {
		console.error(failure);
		return WORK_EXIT_FAIL;
	}
	if (cachedAttemptId(ctx, id) !== attemptId) {
		console.error("Attempt fence changed; settlement refused");
		return WORK_EXIT_FAIL;
	}
	resetDeadline();
	const outcome = interrupted
		? "cancelled"
		: exitCode === 0
			? "succeeded"
			: "failed";
	const settlementContext: WorkContext = {
		...ctx,
		// Cancellation must still reach the server after the command was aborted.
		signal: undefined,
		work: {
			...ctx.work,
			outcome,
			note: interrupted
				? "Command interrupted"
				: exitCode === 0
					? (ctx.work.note ?? reason)
					: reason,
		},
	};
	nativeCommands.set(settlementContext, nativeCommands.get(ctx)!);
	const settled = await workSettle(settlementContext, id);
	if (settled) return settled;
	if (interrupted) return 130;
	if (exitCode !== 0) return exitCode;
	resetDeadline();
	return workComplete(settlementContext, id);
}
