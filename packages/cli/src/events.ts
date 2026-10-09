import {
	HOME_RUN_EVENTS_START,
	type HomeRunEvent,
	type HomeRunEventsPage,
	isSettledHomeStatus,
	type ReadHomeRunEventsInput,
	settledStatusFromTerminal,
} from "./home-client";

// ---------------------------------------------------------------------------
// Source interface (structural, unit-testable with fakes)
// ---------------------------------------------------------------------------

export interface RunEventSource {
	readHomeRunEvents(
		input: ReadHomeRunEventsInput,
		signal?: AbortSignal,
	): Promise<HomeRunEventsPage>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRANSIENT_RE =
	/network|timeout|terminated|closed|ECONN|socket|stream|503|502|429/i;

function isTransient(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return TRANSIENT_RE.test(msg);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(id);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const id = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function clampBackoff(attempt: number): number {
	// 500ms * 2^attempt, capped at 5000ms
	return Math.min(500 * 2 ** attempt, 5000);
}

// ---------------------------------------------------------------------------
// streamHomeRunEvents
// ---------------------------------------------------------------------------

export interface StreamHomeRunEventsInput {
	childRunId?: string;
	delegatedTediId?: string;
	homeRunId: string;
	offset?: string;
}

export interface StreamHomeRunEventsOptions {
	live: boolean;
	pollIntervalMs?: number;
	signal?: AbortSignal;
	onConnectionChange?: (connected: boolean) => void;
}

export type HomeRunEventStream = AsyncIterable<HomeRunEvent> & {
	readonly status: string | undefined;
};

export function streamHomeRunEvents(
	source: RunEventSource,
	input: StreamHomeRunEventsInput,
	opts: StreamHomeRunEventsOptions,
): HomeRunEventStream {
	const pollIntervalMs = opts.pollIntervalMs ?? 2000;
	const waitMs = opts.live ? 25_000 : 0;

	let nextOffset: string = input.offset ?? HOME_RUN_EVENTS_START;
	let currentStatus: string | undefined;

	const combinedSignal = opts.signal ?? new AbortController().signal;

	async function* generate(): AsyncGenerator<HomeRunEvent> {
		let attempt = 0;
		// Terminal state is reported by the run's receipt, not by the page, so it
		// arrives before the events it describes. Accumulate the signals needed to
		// name the outcome across however many pages the stream takes.
		let closed = false;
		let explicitStatus: string | undefined;
		let terminalEventId: string | undefined;
		let sawTerminalEvent = false;
		const terminalSignals: HomeRunEvent[] = [];

		while (true) {
			if (combinedSignal.aborted) return;

			let page: HomeRunEventsPage;
			try {
				page = await source.readHomeRunEvents(
					{
						homeRunId: input.homeRunId,
						offset: nextOffset,
						...(waitMs > 0 ? { waitMs } : {}),
						...(input.childRunId !== undefined
							? { childRunId: input.childRunId }
							: {}),
						...(input.delegatedTediId !== undefined
							? { delegatedTediId: input.delegatedTediId }
							: {}),
					},
					combinedSignal,
				);
				if (attempt > 0) opts.onConnectionChange?.(true);
				attempt = 0; // reset backoff on success
			} catch (err) {
				if (combinedSignal.aborted) return;
				if (!isTransient(err)) throw err;
				if (attempt === 0) opts.onConnectionChange?.(false);
				await sleep(clampBackoff(attempt++), combinedSignal).catch(() => {});
				if (combinedSignal.aborted) return;
				continue;
			}

			// Advance offset and status from the page
			nextOffset = page.nextOffset;
			if (page.closed) closed = true;
			if (page.terminalEventId) terminalEventId = page.terminalEventId;
			if (page.explicitStatus !== undefined) {
				explicitStatus = page.explicitStatus;
			}
			if (page.status !== undefined) {
				currentStatus = page.status;
			}

			for (const event of page.events) {
				if (combinedSignal.aborted) return;
				if (event.id !== undefined && event.id === terminalEventId) {
					sawTerminalEvent = true;
					terminalSignals.push(event);
				} else if (
					/fail|error|cancel|approval|approve|await/i.test(event.kind ?? "")
				) {
					terminalSignals.push(event);
				}
				yield event;
			}

			// A full page is never caught up — keep draining at the new offset.
			if (!page.upToDate) continue;

			if (closed) {
				// Drained a terminal stream. The final page is EMPTY, so its own
				// derived status says nothing — resolve the outcome from the terminal
				// signals accumulated across every page instead.
				currentStatus =
					explicitStatus ??
					(terminalEventId && !sawTerminalEvent
						? "unknown"
						: settledStatusFromTerminal(terminalSignals, terminalEventId));
				return;
			}

			if (!opts.live) return;

			// FOLLOW: terminate when run is settled and we are caught up
			if (isSettledHomeStatus(currentStatus)) return;

			// A page that carried events means the run is active: read the next page
			// right away so the stream (and the settle wake it feeds) stays close to
			// the server. Only an EMPTY page is paced — the server's `waitMs` holds
			// it open as a budget, not a guarantee, and polling as fast as the
			// gateway answers is how this loop used to rate-limit itself out of the
			// run it was tailing.
			if (page.events.length > 0) continue;
			await sleep(pollIntervalMs, combinedSignal).catch(() => {});
			if (combinedSignal.aborted) return;
		}
	}

	const iter = generate();

	const stream: HomeRunEventStream = {
		[Symbol.asyncIterator]() {
			return iter;
		},
		get status() {
			return currentStatus;
		},
	};

	return stream;
}
