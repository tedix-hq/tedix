import {
	overdueRepositoryObservations,
	finishRepositoryObserverEscalation,
	settleAgedRepositoryPushObservations,
} from "@tedix/db/queries/repository-observer";
import { createContext } from "../rpc/orpc";
import { safeErrorMetadata } from "../lib/safe-log-metadata";
import {
	observerConfig,
	escalateObserver,
} from "../services/repository-observer";

/** The bounded platform tick exposes missed diagnoses even when the owner turn failed. */
export async function maintainRepositoryObservers(env: CloudflareEnv) {
	const context = createContext(
		new Request("https://api/internal/repository-observer"),
		env,
	);
	const deadline = Date.now() + 20_000;
	async function bounded<T>(
		operation: () => PromiseLike<T>,
		recordingFailure = false,
	): Promise<T> {
		const remaining = Math.min(
			5_000,
			deadline + (recordingFailure ? 5_000 : 0) - Date.now(),
		);
		if (remaining <= 0) throw new Error("observer_timeout");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				Promise.resolve(operation()),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("observer_timeout")),
						remaining,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	// Escalation must never starve the independent push-retention sweep.
	const settled = await bounded(() =>
		settleAgedRepositoryPushObservations(context.db, new Date().toISOString()),
	);
	let overdue = 0;
	let failed = 0;
	for (const row of await bounded(() =>
		overdueRepositoryObservations(context.db, new Date().toISOString()),
	)) {
		if (Date.now() >= deadline) break;
		try {
			const { config } = await bounded(() =>
				observerConfig(context, row.orgId, row.projectId!),
			);
			const report = (row.metadata?.latestReport ?? row.metadata?.report) as
				| { diagnosis?: string }
				| undefined;
			await bounded(() =>
				escalateObserver(
					context,
					row.orgId,
					row,
					config,
					report?.diagnosis
						? `Ship remains red after the observation window. Diagnosis: ${report.diagnosis}\nWork: ${row.id}. Read the current run before choosing another repair.`
						: `The 30-minute diagnosis promise was missed. The observer has no verified diagnosis. Read the Ship evidence on Work ${row.id}; check observer delivery before authorizing any repair.`,
				),
			);
			await bounded(() =>
				finishRepositoryObserverEscalation(
					context.db,
					row,
					new Date().toISOString(),
					"delivered",
				),
			);
		} catch (error) {
			failed++;
			const details = await safeErrorMetadata(error);
			const reason =
				error instanceof Error && error.message === "observer_timeout"
					? "observer_timeout"
					: JSON.stringify({ stage: "escalation", ...details });
			await bounded(
				() =>
					finishRepositoryObserverEscalation(
						context.db,
						row,
						new Date().toISOString(),
						reason,
					),
				true,
			);
			console.warn(
				"[repository-observer] overdue escalation failed",
				row.id,
				details,
			);
		}

		overdue++;
	}
	if (failed)
		throw new Error(
			`${failed} repository observer escalations failed; other incidents were processed`,
		);
	return { overdue, settled: settled.length };
}
