export type DurableGraphProjectionWriteResult =
	| { status: "projected" }
	| { status: "lease_lost" }
	| { status: "projection_failed"; error: string };

function projectionErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return (message || "unknown graph projection failure").slice(0, 2000);
}

/**
 * Keep the lease assertion adjacent to the external write. A lease miss is a
 * coordination failure, while only an error thrown by the Neo4j writer is a
 * projection-data failure eligible for outbox retry/poison accounting.
 *
 * Errors thrown while renewing the lease intentionally escape this function.
 * The Workflow step may retry those transient D1 failures, but must never turn
 * them into failures of the outbox events it happened to be coordinating.
 */
export async function runFencedGraphProjectionWrite(input: {
	renewLease: () => Promise<boolean>;
	project: () => Promise<void>;
}): Promise<DurableGraphProjectionWriteResult> {
	const renewed = await input.renewLease();
	if (!renewed) return { status: "lease_lost" };

	try {
		await input.project();
		return { status: "projected" };
	} catch (error) {
		return {
			status: "projection_failed",
			error: projectionErrorMessage(error),
		};
	}
}
