/**
 * In-flight loads are never shared across requests. A load's database I/O
 * (Postgres sockets through Hyperdrive) belongs to the request that started
 * it, and with handle_cross_request_promise_resolution a promise created by
 * one request can't settle in another, so a joiner fails as soon as the
 * owning request ends. Each request runs its own load; the maps still record
 * loads, so wedge tracking keeps working.
 */
export function joinableInFlight<K, V>(
	_inFlight: Map<K, V>,
	_key: K,
): V | undefined {
	return undefined;
}
