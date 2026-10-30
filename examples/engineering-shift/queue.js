export function workQueueState(item, now = Date.now()) {
	if (item.activeAttempt) {
		const expiry = item.activeAttempt.expiresAt;
		return expiry && Date.parse(expiry) <= now ? "waiting" : "running";
	}
	if (item.latestAttempt === undefined) return "unknown";
	const latest = item.latestAttempt;
	const sameRevision =
		latest &&
		(latest.workItemVersion === null ||
			latest.workItemVersion === item.version);
	if (sameRevision && latest.outcome === "succeeded") return "awaiting-closure";
	if (sameRevision && latest.outcome) return "failed";
	if (item.startAt && Date.parse(item.startAt) > now) return "waiting";
	if (item.metadata?.executor && item.metadata?.laneDispatch?.state !== "ready")
		return "waiting";
	return "queued";
}
