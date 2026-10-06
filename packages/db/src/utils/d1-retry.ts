function errorMessage(value: unknown): string {
	const seen = new Set<unknown>();
	const messages: string[] = [];
	for (
		let depth = 0;
		value && typeof value === "object" && depth < 8 && !seen.has(value);
		depth++
	) {
		seen.add(value);
		const error = value as { message?: unknown; cause?: unknown };
		if (typeof error.message === "string") messages.push(error.message);
		value = error.cause;
	}
	return messages.join(" ");
}

export class D1ReadTimeoutError extends Error {
	constructor() {
		super("D1 identity read timed out");
		this.name = "D1ReadTimeoutError";
	}
}

export function isTransientD1ReadError(value: unknown): boolean {
	const message = errorMessage(value);
	return (
		message.includes("D1_ERROR") &&
		(message.includes("Network connection lost") ||
			message.includes("Failed to parse body as JSON") ||
			message.includes("Temporarily unavailable"))
	);
}

export async function withTransientD1ReadRetry<T>(
	label: string,
	read: () => Promise<T>,
	options: { attempts?: number; delayMs?: number; timeoutMs?: number } = {},
): Promise<T> {
	const attempts = Math.max(1, options.attempts ?? 2);
	const delayMs = Math.max(0, options.delayMs ?? 150);
	if (
		options.timeoutMs !== undefined &&
		(!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
	)
		throw new Error("D1 read timeout must be positive and finite");
	const startedAt = Date.now();
	const deadline =
		options.timeoutMs === undefined ? Infinity : startedAt + options.timeoutMs;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const remaining = deadline - Date.now();
				if (remaining <= 0) throw new D1ReadTimeoutError();
				return await (Number.isFinite(remaining)
					? Promise.race([
							read(),
							new Promise<never>((_, reject) => {
								timer = setTimeout(
									() => reject(new D1ReadTimeoutError()),
									remaining,
								);
							}),
						])
					: read());
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		} catch (error) {
			lastError = error;
			// D1 I/O cannot be canceled: never replay a timed-out, still-running read.
			if (
				error instanceof D1ReadTimeoutError ||
				!isTransientD1ReadError(error) ||
				attempt >= attempts ||
				Date.now() + delayMs >= deadline
			) {
				if (options.timeoutMs !== undefined)
					console.error("[D1] read failed", {
						operation: label,
						elapsedMs: Date.now() - startedAt,
						attempt,
						timedOut: error instanceof D1ReadTimeoutError,
					});
				throw error;
			}
			console.warn(
				`[D1] transient read failure for ${label}; retrying (${attempt}/${attempts})`,
				{ operation: label, elapsedMs: Date.now() - startedAt },
			);
			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}
	throw lastError;
}
