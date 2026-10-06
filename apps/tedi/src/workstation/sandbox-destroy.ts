export const SANDBOX_DESTROY_TIMEOUT_MS = 30_000;

export class SandboxDestroyTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`sandbox.destroy timed out after ${timeoutMs}ms`);
		this.name = "SandboxDestroyTimeoutError";
	}
}

export async function destroySandboxWithTimeout(
	sandbox: { destroy(): Promise<void> },
	options?: { timeoutMs?: number },
): Promise<{ completed: boolean; timedOut: boolean }> {
	const timeoutMs = options?.timeoutMs ?? SANDBOX_DESTROY_TIMEOUT_MS;
	let timeout: ReturnType<typeof setTimeout> | undefined;

	try {
		await Promise.race([
			sandbox.destroy(),
			new Promise<never>(
				(_, reject) =>
					(timeout = setTimeout(
						() => reject(new SandboxDestroyTimeoutError(timeoutMs)),
						timeoutMs,
					)),
			),
		]);
		return { completed: true, timedOut: false };
	} catch (error) {
		if (error instanceof SandboxDestroyTimeoutError) {
			return { completed: false, timedOut: true };
		}
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
