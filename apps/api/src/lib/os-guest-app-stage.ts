/** Completion-only timings are lost when a visitor closes a stalled request. */
export async function guestAppStage<T>(
	operation: "share_open" | "open" | "call",
	phase:
		| "request"
		| "recipient"
		| "redemption"
		| "share_session"
		| "app_code"
		| "guest_grants"
		| "app_session"
		| "runtime",
	run: () => Promise<T>,
): Promise<T> {
	const started = Date.now();
	const timer = setTimeout(() => {
		console.warn({
			event: "os_guest_app_pending",
			operation,
			phase,
			phaseMs: Date.now() - started,
		});
	}, 10_000);
	try {
		return await run();
	} finally {
		clearTimeout(timer);
	}
}
