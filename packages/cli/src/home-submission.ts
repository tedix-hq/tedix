import { isAuthError, isRecoverableTurnError } from "./operator/runtime-errors";
import {
	type AskHomeInput,
	type HomeRunSummary,
	type TedixHomeClient,
	latestRunFromSet,
	summarizeHomePayload,
} from "./home-client";
import { withTimeout } from "./shared";

export class HomeSubmissionUnresolvedError extends Error {
	constructor(
		readonly clientSubmissionId: string,
		cause: unknown,
		readonly homeRunId?: string,
	) {
		super(
			homeRunId
				? `Your run ${homeRunId} was recovered, but its result could not be read. It was not resent; use \`tedix tail ${homeRunId}\` to reconnect.`
				: "Your message may still be running, but its exact run is not visible. It was not resent; check `tedix runs` before retrying.",
			{ cause },
		);
		this.name = "HomeSubmissionUnresolvedError";
	}
}

/** Submit once; recover only this submission, never another concurrent turn. */
export async function askHomeOnce(
	opts: AskHomeInput & {
		client: Pick<TedixHomeClient, "askHome" | "readHomeRunSet" | "readHomeRun">;
		timeoutMs?: number;
		onRecover?: () => void;
	},
): Promise<{ summary: HomeRunSummary; recovered: boolean }> {
	const clientSubmissionId = crypto.randomUUID();
	const askAbort = new AbortController();
	try {
		const asked = await withTimeout(
			opts.client.askHome(
				{
					content: opts.content,
					conversationId: opts.conversationId,
					delegateToTediId: opts.delegateToTediId,
					verifyCommand: opts.verifyCommand,
					metadata: { ...opts.metadata, clientSubmissionId },
				},
				{ signal: askAbort.signal },
			),
			opts.timeoutMs ?? 30_000,
			"ASK_HOME_TIMEOUT",
			() => askAbort.abort(new Error("ASK_HOME_TIMEOUT")),
		);
		const summary = summarizeHomePayload(asked);
		if (!summary) throw new Error("ask returned no homeRunId");
		return { summary, recovered: false };
	} catch (error) {
		if (isAuthError(error) || !isRecoverableTurnError(error)) throw error;
		opts.onRecover?.();
		const recovered = await opts.client
			.readHomeRunSet({ conversationId: opts.conversationId, limit: 5 })
			.then((payload) => latestRunFromSet(payload, clientSubmissionId))
			.catch(() => null);
		if (!recovered)
			throw new HomeSubmissionUnresolvedError(clientSubmissionId, error);
		try {
			const summary = summarizeHomePayload(
				await opts.client.readHomeRun(recovered.homeRunId),
			);
			if (!summary || summary.homeRunId !== recovered.homeRunId) {
				throw new Error("recovered run read returned no matching run");
			}
			return { summary, recovered: true };
		} catch (readError) {
			throw new HomeSubmissionUnresolvedError(
				clientSubmissionId,
				readError,
				recovered.homeRunId,
			);
		}
	}
}
