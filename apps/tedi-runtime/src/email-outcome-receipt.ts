import { getInternalApiClient } from "@tedix/api-client/internal";

type RuntimeOutcome = {
	tediId: string;
	messageIdHeader: string | null;
	runId: string;
	result: "completed" | "failed";
	elapsedMs: number;
	replied: boolean | null;
};

/** A mailbox observation only. Never changes the in-band reply result. */
export async function recordEmailRuntimeOutcome(
	env: { API_SERVICE?: Fetcher },
	input: RuntimeOutcome,
): Promise<void> {
	// The API must resolve an exact, unique durable mailbox message. A locally
	// generated turn key is not evidence that the Worker persisted that message.
	if (!input.messageIdHeader || !env.API_SERVICE) return;
	try {
		await getInternalApiClient(env).tediEmail.recordOutcome({
			kind: "runtime_turn",
			tediId: input.tediId,
			messageIdHeader: input.messageIdHeader,
			runId: input.runId,
			result: input.result,
			elapsedMs: Math.min(86_400_000, Math.max(0, Math.floor(input.elapsedMs))),
			replied: input.replied,
		});
	} catch {
		// No source identifiers or vendor response bodies in operational logs.
		console.warn("[isolate.email] outcome receipt unavailable");
	}
}
