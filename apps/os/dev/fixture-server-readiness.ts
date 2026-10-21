type FixtureProcess = {
	exitCode: number | null;
	exited: Promise<number>;
};

export async function waitForFixtureServer(
	url: string,
	{
		server,
		timeoutMs = 90_000,
		requestTimeoutMs = 2_000,
		pollIntervalMs = 200,
	}: {
		server?: FixtureProcess;
		timeoutMs?: number;
		requestTimeoutMs?: number;
		pollIntervalMs?: number;
	} = {},
) {
	const deadline = performance.now() + timeoutMs;
	let lastResponse = "No HTTP response";
	let lastError = "No request error";
	const failure = (reason: string) =>
		new Error(
			`Fixture server ${url}: ${reason}. Last response: ${lastResponse}. Last error: ${lastError}`,
		);
	const exited = server?.exited.then((code) => ({ code }));
	while (performance.now() < deadline) {
		if (server && server.exitCode !== null)
			throw failure(`exited early with code ${server.exitCode}`);
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			Math.min(requestTimeoutMs, deadline - performance.now()),
		);
		try {
			const request = fetch(url, { signal: controller.signal });
			const result = exited
				? await Promise.race([request, exited])
				: await request;
			if ("code" in result)
				throw failure(`exited early with code ${result.code}`);
			lastResponse = `HTTP ${result.status} ${result.statusText}`;
			await result.body?.cancel();
			if (result.ok) return;
		} catch (error) {
			lastError = String(error);
			if (server && server.exitCode !== null)
				throw failure(`exited early with code ${server.exitCode}`);
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
		const remaining = deadline - performance.now();
		if (remaining > 0) {
			let pollTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				const pause = new Promise<void>((resolve) => {
					pollTimer = setTimeout(resolve, Math.min(pollIntervalMs, remaining));
				});
				if (exited) {
					const result = await Promise.race([pause, exited]);
					if (result) throw failure(`exited early with code ${result.code}`);
				} else await pause;
			} finally {
				clearTimeout(pollTimer);
			}
		}
	}
	throw failure(`not ready within ${timeoutMs}ms`);
}
