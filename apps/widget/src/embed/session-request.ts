export function createInFlightRequestCoalescer<T>() {
	let inFlight: { key: string; promise: Promise<T> } | null = null;

	return {
		run(key: string, request: () => Promise<T>): Promise<T> {
			if (inFlight?.key === key) return inFlight.promise;

			const requestState: { key: string; promise: Promise<T> } = {
				key,
				promise: null as unknown as Promise<T>,
			};
			requestState.promise = (async () => {
				try {
					return await request();
				} finally {
					if (inFlight === requestState) inFlight = null;
				}
			})();
			inFlight = requestState;
			return requestState.promise;
		},
	};
}
