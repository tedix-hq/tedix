import { describe, expect, it } from "vite-plus/test";
import {
	createResumeWatermarkStore,
	RESUME_WATERMARK_CAPACITY,
} from "./resume-watermark";

type Cursor = { runId: string; offset: number };

describe("createResumeWatermarkStore", () => {
	it("parks a position only from a session that settled cleanly", () => {
		const store = createResumeWatermarkStore<Cursor>();
		const session = store.open("home:main");
		expect(session.seed).toBeNull();
		session.advance({ runId: "run-1", offset: 7 });
		session.settle();
		expect(session.close()).toBe(true);
		expect(store.peek("home:main")).toEqual({ runId: "run-1", offset: 7 });
		expect(store.open("home:main").seed).toEqual({
			runId: "run-1",
			offset: 7,
		});
	});

	it("parks nothing from a session that never settled", () => {
		const store = createResumeWatermarkStore<Cursor>();
		const session = store.open("home:main");
		// Frames were delivered, but the subscribe never resolved — the exact
		// state in which "we are at offset 7" is not a claim anyone may resume on.
		session.advance({ runId: "run-1", offset: 7 });
		expect(session.close()).toBe(false);
		expect(store.peek("home:main")).toBeNull();
	});

	it("disarms a settled session again as soon as anything goes unclean", () => {
		const store = createResumeWatermarkStore<Cursor>();
		const session = store.open("home:main");
		session.advance({ runId: "run-1", offset: 7 });
		session.settle();
		session.advance({ runId: "run-1", offset: 9 });
		session.unsettle();
		expect(session.close()).toBe(false);
		expect(store.peek("home:main")).toBeNull();
	});

	it("re-arms on a later clean settle and parks the newest position", () => {
		const store = createResumeWatermarkStore<Cursor>();
		const session = store.open("home:main");
		session.advance({ runId: "run-1", offset: 7 });
		session.settle();
		session.unsettle();
		session.advance({ runId: "run-1", offset: 12 });
		session.settle();
		expect(session.close()).toBe(true);
		expect(store.peek("home:main")).toEqual({ runId: "run-1", offset: 12 });
	});

	it("keeps a predecessor's watermark when a session parks nothing", () => {
		// A failed successor must not DESTROY a good watermark either — it simply
		// contributes none of its own.
		const store = createResumeWatermarkStore<Cursor>();
		const first = store.open("home:main");
		first.advance({ runId: "run-1", offset: 4 });
		first.settle();
		first.close();
		const second = store.open("home:main");
		expect(second.seed).toEqual({ runId: "run-1", offset: 4 });
		second.unsettle();
		expect(second.close()).toBe(false);
		expect(store.peek("home:main")).toEqual({ runId: "run-1", offset: 4 });
	});

	it("reset drops the parked watermark so a poison cursor cannot reseed", () => {
		const store = createResumeWatermarkStore<Cursor>();
		const first = store.open("home:main");
		first.advance({ runId: "run-1", offset: 4 });
		first.settle();
		first.close();
		const second = store.open("home:main");
		expect(second.seed).toEqual({ runId: "run-1", offset: 4 });
		// The run stopped resolving: the watermark is unusable, and a store that
		// outlives the session would otherwise hand the same dead cursor back.
		second.reset();
		expect(store.peek("home:main")).toBeNull();
		second.settle();
		expect(second.close()).toBe(false);
		expect(store.open("home:main").seed).toBeNull();
	});

	it("is idempotent on close and never parks twice", () => {
		const store = createResumeWatermarkStore<Cursor>();
		const session = store.open("home:main");
		session.advance({ runId: "run-1", offset: 3 });
		session.settle();
		expect(session.close()).toBe(true);
		session.advance({ runId: "run-1", offset: 99 });
		session.settle();
		expect(session.close()).toBe(false);
		expect(store.peek("home:main")).toEqual({ runId: "run-1", offset: 3 });
	});

	it("keeps keys apart and evicts the least recently parked at capacity", () => {
		const store = createResumeWatermarkStore<Cursor>({ capacity: 2 });
		const park = (key: string, offset: number) => {
			const session = store.open(key);
			session.advance({ runId: "run-1", offset });
			session.settle();
			session.close();
		};
		park("a", 1);
		park("b", 2);
		park("c", 3);
		expect(store.size()).toBe(2);
		expect(store.peek("a")).toBeNull();
		expect(store.peek("b")).toEqual({ runId: "run-1", offset: 2 });
		expect(store.peek("c")).toEqual({ runId: "run-1", offset: 3 });
	});

	it("refreshing a key makes it the most recent, not the oldest", () => {
		const store = createResumeWatermarkStore<Cursor>({ capacity: 2 });
		const park = (key: string, offset: number) => {
			const session = store.open(key);
			session.advance({ runId: "run-1", offset });
			session.settle();
			session.close();
		};
		park("a", 1);
		park("b", 2);
		park("a", 5);
		park("c", 3);
		expect(store.peek("b")).toBeNull();
		expect(store.peek("a")).toEqual({ runId: "run-1", offset: 5 });
	});

	it("defaults to a bounded capacity rather than growing forever", () => {
		const store = createResumeWatermarkStore<Cursor>();
		for (let index = 0; index < RESUME_WATERMARK_CAPACITY + 10; index += 1) {
			const session = store.open(`conversation-${index}`);
			session.advance({ runId: "run-1", offset: index });
			session.settle();
			session.close();
		}
		expect(store.size()).toBe(RESUME_WATERMARK_CAPACITY);
		expect(store.peek("conversation-0")).toBeNull();
	});

	it("forget and clear drop parked watermarks", () => {
		const store = createResumeWatermarkStore<Cursor>();
		const session = store.open("home:main");
		session.advance({ runId: "run-1", offset: 1 });
		session.settle();
		session.close();
		store.forget("home:main");
		expect(store.peek("home:main")).toBeNull();
		const other = store.open("other");
		other.advance({ runId: "run-1", offset: 2 });
		other.settle();
		other.close();
		store.clear();
		expect(store.size()).toBe(0);
	});
});
