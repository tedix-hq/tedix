import type { QueryClient } from "@tanstack/react-query";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";

const INTERVAL = 120_000;
const polls = new WeakMap<
	QueryClient,
	{
		users: number;
		lastRun: number;
		pending: boolean;
		timer?: ReturnType<typeof setInterval>;
	}
>();

/** The document's query client owns one recipient-wide source refresh. */
export function subscribeDecisionSourceRefresh(client: QueryClient) {
	let poll = polls.get(client);
	if (!poll) {
		poll = { users: 0, lastRun: -Infinity, pending: false };
		polls.set(client, poll);
	}
	const state = poll;
	const refresh = async () => {
		if (
			document.hidden ||
			state.pending ||
			Date.now() - state.lastRun < INTERVAL
		)
			return;
		state.pending = true;
		state.lastRun = Date.now();
		try {
			const result = await osApi.workInteractions.refreshDecisionSources({});
			if (result.created || result.superseded)
				await Promise.all([
					client.invalidateQueries({
						queryKey: osQuery.workInteractions.listInbox.key(),
					}),
					client.invalidateQueries({
						queryKey: osQuery.attention.listDeckCards.key(),
					}),
				]);
		} catch {
			// Retain the inbox and try again on the next shared tick.
		} finally {
			state.pending = false;
		}
	};
	if (state.users++ === 0) {
		void refresh();
		state.timer = setInterval(() => void refresh(), INTERVAL);
	}
	return () => {
		if (--state.users === 0) {
			clearInterval(state.timer);
			state.timer = undefined;
		}
	};
}
