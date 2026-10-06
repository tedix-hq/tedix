import { describe, expect, it } from "vite-plus/test";
import { createProjectionStore } from "./projection-store";

type CounterState = { total: number; seen: readonly string[] };
type CounterEvent = { id: string; amount: number };

const syncScheduler = (callback: () => void) => callback();

function counterStore(scheduler = syncScheduler) {
	return createProjectionStore<CounterState, CounterEvent>({
		initial: () => ({ total: 0, seen: [] }),
		// The "no change means SAME reference" contract, exercised by an
		// idempotent id-keyed fold — exactly the shape a replayed stream needs.
		reduce: (state, event) =>
			state.seen.includes(event.id)
				? state
				: {
						total: state.total + event.amount,
						seen: [...state.seen, event.id],
					},
		scheduler,
	});
}

describe("createProjectionStore", () => {
	it("notifies once per coalesced burst and not at all for a no-op fold", () => {
		const flushes: Array<() => void> = [];
		const store = counterStore((callback) => {
			flushes.push(callback);
		});
		let notifications = 0;
		store.subscribe(() => {
			notifications += 1;
		});

		expect(store.apply({ id: "a", amount: 1 })).toBe(true);
		expect(store.apply({ id: "b", amount: 2 })).toBe(true);
		// A re-delivered event folds to the SAME reference: no notification, and
		// no extra scheduled frame.
		expect(store.apply({ id: "a", amount: 1 })).toBe(false);
		expect(notifications).toBe(0);
		expect(flushes).toHaveLength(1);

		flushes[0]?.();
		expect(notifications).toBe(1);
		expect(store.getSnapshot()).toEqual({ total: 3, seen: ["a", "b"] });
	});

	it("keeps getSnapshot referentially stable between changes", () => {
		const store = counterStore();
		const first = store.getSnapshot();
		expect(store.getSnapshot()).toBe(first);
		store.apply({ id: "a", amount: 1 });
		const second = store.getSnapshot();
		expect(second).not.toBe(first);
		expect(store.getSnapshot()).toBe(second);
	});
});
