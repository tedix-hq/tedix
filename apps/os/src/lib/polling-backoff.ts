type PollQuery = {
	state: {
		data: unknown;
		dataUpdateCount: number;
		errorUpdateCount: number;
	};
};

const observations = new WeakMap<
	PollQuery,
	{ data: unknown; updates: number; unchanged: number }
>();

/** Structural sharing keeps identical responses referentially equal. Track the
 * query, rather than its observers, so rerenders cannot reset the backoff.
 * Callers with read timestamps can observe only the stable response rows. */
export function pollingBackoff(
	query: PollQuery,
	baseMs: number | false,
	maxMs: number,
	data: unknown = query.state.data,
): number | false {
	if (baseMs === false) return false;
	const { dataUpdateCount, errorUpdateCount } = query.state;
	const updates = dataUpdateCount + errorUpdateCount;
	const previous = observations.get(query);
	const unchanged =
		previous && previous.data === data
			? Math.min(10, previous.unchanged + Number(previous.updates !== updates))
			: 0;
	observations.set(query, { data, updates, unchanged });
	return Math.min(maxMs, baseMs * 2 ** unchanged);
}
