/**
 * Optional observability only: never use this for policy or required writes.
 * Create once per sink at module scope to bound diagnostics across requests.
 */
export function createTelemetryWriter(
	component: string,
): (
	write: () => unknown,
	waitUntil?: (pending: Promise<void>) => void,
) => void {
	let nextWarningAt = -Infinity;
	const failed = () => {
		const now = Date.now();
		if (now < nextWarningAt) return;
		nextWarningAt = now + 60_000;
		try {
			// No thrown value or request data: sink failures can contain secrets.
			const diagnostic = console.warn({
				component,
				event: "telemetry.write_failed",
				message:
					"Optional telemetry unavailable; further failures suppressed for 60s",
			});
			void Promise.resolve(diagnostic).catch(() => undefined);
		} catch {
			// The diagnostic sink may be unavailable too.
		}
	};
	return (write, waitUntil) => {
		try {
			const pending = Promise.resolve(write()).then(() => undefined, failed);
			waitUntil?.(pending);
		} catch {
			failed();
		}
	};
}

interface TelemetrySpan {
	setAttribute(key: string, value: string | number | boolean): unknown;
}

const writeSpan = createTelemetryWriter("worker.tracing");

/** A tracer may fail before or after dispatch; the operation still runs once. */
export function runWithTelemetrySpan<T>(
	enter: (callback: (span: TelemetrySpan) => Promise<NoInfer<T>>) => unknown,
	run: (span: TelemetrySpan) => Promise<T>,
): Promise<T> {
	let result: Promise<T> | undefined;
	let operationFailed = false;
	let operationError: unknown;
	const invoke = (span?: TelemetrySpan): Promise<T> => {
		result ??= Promise.resolve()
			.then(() =>
				run({
					setAttribute: (key, value) =>
						writeSpan(() => span?.setAttribute(key, value)),
				}),
			)
			.catch((error: unknown) => {
				operationFailed = true;
				operationError = error;
				throw error;
			});
		return result;
	};
	writeSpan(() =>
		Promise.resolve(enter(invoke)).catch((error: unknown) => {
			if (!operationFailed || error !== operationError) throw error;
		}),
	);
	return invoke();
}
