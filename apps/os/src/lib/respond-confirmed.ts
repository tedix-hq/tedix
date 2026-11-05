type RespondInput = {
	requestId: string;
	expectedRequestVersion: number;
	body: string;
};
type Detail = {
	request: { version: number };
	responses: { data: { body: string }[] };
};

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Save an answer and stop waiting once the card shows it. A reply that never
 * arrives must not leave the card saving: after a short wait the card is read
 * back, and an answer already stored there counts as saved.
 */
export async function respondConfirmed<I extends RespondInput, R>(
	api: {
		respond: (input: I) => Promise<R>;
		get: (input: { requestId: string }) => Promise<Detail>;
	},
	input: I,
	{ checkAfterMs = 8_000, everyMs = 4_000, giveUpMs = 60_000 } = {},
): Promise<R | { request: Detail["request"]; response: { body: string } }> {
	let done = false;
	const readBack = async () => {
		await sleep(checkAfterMs);
		const deadline = Date.now() + giveUpMs;
		while (!done) {
			const detail = await api
				.get({ requestId: input.requestId })
				.catch(() => null);
			const saved =
				detail && detail.request.version > input.expectedRequestVersion
					? detail.responses.data.find(
							(response) => response.body === input.body,
						)
					: undefined;
			if (detail && saved) return { request: detail.request, response: saved };
			if (Date.now() > deadline)
				throw new Error(
					"Your answer may not have been saved. Reload the card to check before answering again.",
				);
			await sleep(everyMs);
		}
		return new Promise<never>(() => {});
	};
	try {
		return await Promise.race([api.respond(input), readBack()]);
	} finally {
		done = true;
	}
}
