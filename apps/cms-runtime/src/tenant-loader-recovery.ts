const CLONE_VERSION_ERROR =
	"Unable to deserialize cloned data due to invalid or unsupported version.";

type TenantFetcher = { fetch(request: Request): Promise<Response> };

interface LoaderSnapshot {
	generation: number;
	key: string;
}

/** A Worker Loader isolate can keep loopback bindings from an incompatible workerd version. */
export class TenantLoaderRecovery {
	private readonly generations = new Map<string, number>();

	snapshot(baseKey: string): LoaderSnapshot {
		const generation = this.generations.get(baseKey) ?? 0;
		return {
			generation,
			key: generation === 0 ? baseKey : `${baseKey}#recovery:${generation}`,
		};
	}

	retire(baseKey: string, observedGeneration: number): void {
		if ((this.generations.get(baseKey) ?? 0) !== observedGeneration) return;
		this.generations.set(baseKey, observedGeneration + 1);
	}
}

function isCloneVersionError(error: unknown): boolean {
	return error instanceof Error && error.message === CLONE_VERSION_ERROR;
}

/** Replay only bodyless reads; the first invocation may have run before its result failed to clone. */
export async function fetchWithTenantLoaderRecovery(
	request: Request,
	baseKey: string,
	recovery: TenantLoaderRecovery,
	load: (key: string) => TenantFetcher,
	onRetry: () => void,
): Promise<Response> {
	const replayable =
		(request.method === "GET" || request.method === "HEAD") &&
		request.body === null;
	const replayRequest = replayable ? new Request(request) : undefined;
	const first = recovery.snapshot(baseKey);
	try {
		return await load(first.key).fetch(request);
	} catch (error) {
		if (!isCloneVersionError(error)) throw error;
		recovery.retire(baseKey, first.generation);
		if (!replayRequest) throw error;
		onRetry();
	}

	const second = recovery.snapshot(baseKey);
	try {
		return await load(second.key).fetch(replayRequest);
	} catch (error) {
		if (isCloneVersionError(error)) {
			recovery.retire(baseKey, second.generation);
		}
		throw error;
	}
}
