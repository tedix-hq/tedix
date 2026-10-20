import {
	overdueRepositoryObservations,
	settleAgedRepositoryPushObservations,
} from "@tedix/db/queries/repository-observer";
import { createContext } from "../rpc/orpc";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
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
	let overdue = 0;
	let failed = 0;
	for (const row of await overdueRepositoryObservations(
		context.db,
		new Date().toISOString(),
	)) {
		try {
			const { config } = await observerConfig(
				context,
				row.orgId,
				row.projectId!,
			);
			const report = (row.metadata?.latestReport ?? row.metadata?.report) as
				| { diagnosis?: string }
				| undefined;
			await escalateObserver(
				context,
				row.orgId,
				row,
				config,
				report?.diagnosis
					? `Ship remains red after the observation window. Diagnosis: ${report.diagnosis}\nWork: ${row.id}. Read the current run before choosing another repair.`
					: `The 30-minute diagnosis promise was missed. The observer has no verified diagnosis. Read the Ship evidence on Work ${row.id}; check observer delivery before authorizing any repair.`,
			);
		} catch (error) {
			failed++;
			console.warn(
				"[repository-observer] overdue escalation failed",
				row.id,
				safeExceptionTopology(error),
			);
		}

		overdue++;
	}
	const settled = await settleAgedRepositoryPushObservations(
		context.db,
		new Date().toISOString(),
	);
	if (failed)
		throw new Error(
			`${failed} repository observer escalations failed; other incidents were processed`,
		);
	return { overdue, settled: settled.length };
}
