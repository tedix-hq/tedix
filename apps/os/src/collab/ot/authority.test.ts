// @vitest-environment node
// Adapted and modified from Cloudflare OS under Apache-2.0; see THIRD_PARTY_NOTICES.md.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CollabVerifiedIdentity } from "../presence";
import {
	applyCodeChange,
	type CodeChange,
	type CodeContent,
	diffFiles,
	MAX_FILE_TEXT_LENGTH,
	transformCodeChange,
} from "./code-change";
import {
	adoptCanonicalSynchronously,
	applySubmissionSynchronously,
	CAPACITY_MESSAGE,
	groundCanonicalSynchronously,
	type CanonicalStamp,
	MATERIALIZE_THRESHOLD_ROWS,
	materializeSynchronously,
	MAX_RETAINED_ROWS,
	MAX_STREAM_ROWS,
	type OtAuthorityDeps,
	type OtAuthorityStorage,
	type OtPrefetch,
	type OtStreamState,
	OtAuthority,
	type PreparedAdoption,
	type PreparedSubmission,
	pruneRetiredRows,
	RETIRED_ROW_TTL_MS,
	seedSynchronously,
} from "./authority";
import {
	type CodeChangeRow,
	type CodeChangeSubmission,
	selectUnappliedRows,
} from "./wire";

// The transform is spied on (delegating to the real implementation) so the ingestion-order test can
// assert it never ran for a change that failed schema validation.
vi.mock("./code-change", async (importActual) => {
	const actual = await importActual<typeof import("./code-change")>();
	return { ...actual, transformCodeChange: vi.fn(actual.transformCodeChange) };
});
const transformSpy = vi.mocked(transformCodeChange);

const ADA: CollabVerifiedIdentity = {
	key: "opaque-ada",
	displayName: "Ada",
	kind: "human",
	role: "owner",
	verified: true,
};
const GRACE: CollabVerifiedIdentity = {
	key: "opaque-grace",
	displayName: "Grace",
	kind: "human",
	role: "member",
	verified: true,
};

/** Rooms sync a single file today; the path mirrors `COLLAB_DOC_PATH`. */
const PATH = "content";

function doc(text: string): CodeContent {
	return new Map([[PATH, text]]);
}

function textOf(content: CodeContent): string {
	return content.get(PATH) ?? "";
}

/** The change a client would submit to turn `before` into `after`. */
function edit(before: string, after: string): CodeChange {
	return diffFiles(doc(before), doc(after));
}

interface Harness {
	authority: OtAuthority;
	deps: OtAuthorityDeps;
	values: Map<string, unknown>;
	broadcast: CodeChangeRow[];
	/**
	 * Intercepts the next `storage.get(key)`. `entered` resolves once that read is actually in
	 * flight, and `release` lets it finish -- so a test can open a precise window between the two.
	 */
	holdNextGet: (key: string) => { entered: Promise<void>; release: () => void };
	/** Jump the injected clock forward, so the retention horizon can be crossed deterministically. */
	advanceClock: (ms: number) => void;
	/** Every key the authority has hard-deleted, in order. */
	deleted: string[];
}

function harness(values = new Map<string, unknown>()): Harness {
	const broadcast: CodeChangeRow[] = [];
	const deleted: string[] = [];
	const holds = new Map<string, { entered: () => void; gate: Promise<void> }>();
	let clock = 1_700_000_000_000;

	const storage: OtAuthorityStorage = {
		// DO storage serializes; round-tripping through JSON keeps the tests honest about what
		// actually comes back after a hibernation wake (and exercises `parseCodeChangeRow`).
		get: async <T>(key: string) => {
			const hold = holds.get(key);
			if (hold !== undefined) {
				holds.delete(key);
				hold.entered();
				await hold.gate;
			}
			const value = values.get(key);
			return value === undefined
				? undefined
				: (JSON.parse(JSON.stringify(value)) as T);
		},
		list: async <T>({ prefix }: { prefix: string }) => {
			const out = new Map<string, T>();
			for (const key of [...values.keys()].sort()) {
				if (!key.startsWith(prefix)) continue;
				out.set(key, JSON.parse(JSON.stringify(values.get(key))) as T);
			}
			return out;
		},
		put: async (key: string, value: unknown) => {
			values.set(key, value);
		},
		delete: async (key: string) => {
			deleted.push(key);
			values.delete(key);
		},
	};

	const deps: OtAuthorityDeps = {
		storage,
		broadcast: (row) => void broadcast.push(row),
		now: () => (clock += 1),
	};

	return {
		authority: new OtAuthority(deps),
		deps,
		values,
		broadcast,
		deleted,
		advanceClock: (ms) => {
			clock += ms;
		},
		holdNextGet: (key) => {
			let release = (): void => {};
			let entered = (): void => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const reached = new Promise<void>((resolve) => {
				entered = resolve;
			});
			holds.set(key, { entered, gate });
			return { entered: reached, release };
		},
	};
}

/**
 * The grounding stamp a seed carries: which canonical revision the seeded content is. Every seed
 * states one, because a base whose grounding is unknown is exactly the state that let a commit
 * pin its compare-and-swap to a revision the room had never seen.
 */
const CANON: CanonicalStamp = { revision: 1, revisionId: "rev-1" };

/** A newer canonical revision, as `adoptCanonical` is offered one. */
function canonicalAt(revision: number): CanonicalStamp {
	return { revision, revisionId: `rev-${revision}` };
}

async function seeded(
	text: string,
	canonical: CanonicalStamp = CANON,
): Promise<Harness> {
	const h = harness();
	expect(await h.authority.seed(doc(text), canonical)).toEqual({
		seeded: true,
	});
	return h;
}

/** An adoption offer, with the identity the server-authored row is attributed to. */
function offer(
	canonical: CanonicalStamp,
	text: string,
	force = false,
): PreparedAdoption {
	return { canonical, files: doc(text), author: ADA, force };
}

/**
 * A prefetch as a span receives one. The span tests below carry no live rows, so the base is the
 * content unless a case says otherwise -- `baseFiles` is what a span re-folds from when it needs
 * the content at a revision other than head.
 */
function prefetch(partial: {
	generation?: number;
	revision: number;
	baseRevision: number;
	content: CodeContent | null;
	baseFiles?: [string, string][];
}): OtPrefetch {
	return {
		generation: partial.generation ?? 0,
		revision: partial.revision,
		baseRevision: partial.baseRevision,
		baseFiles: partial.baseFiles ?? [...(partial.content ?? [])],
		content: partial.content,
	};
}

function submission(
	partial: Partial<CodeChangeSubmission> & { change: CodeChange },
): CodeChangeSubmission {
	return {
		generation: 0,
		revision: 0,
		clientId: "cli-a",
		seq: 1,
		...partial,
	};
}

beforeEach(() => {
	transformSpy.mockClear();
});

// =======================================================================================

describe("OtAuthority.submit", () => {
	it("accepts a first change, appends one row, and broadcasts it", async () => {
		const h = await seeded("hello\n");

		const result = await h.authority.submit(
			submission({ change: edit("hello\n", "hello world\n") }),
			ADA,
		);

		expect(result).toEqual({
			ok: true,
			duplicate: false,
			generation: 0,
			revision: 1,
		});
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 1 });
		expect(textOf(await h.authority.content())).toBe("hello world\n");
		expect(h.broadcast).toHaveLength(1);
		expect(h.broadcast[0]).toMatchObject({
			generation: 0,
			revision: 1,
			author: ADA,
			submission: { clientId: "cli-a", seq: 1 },
		});
	});

	it("hands the broadcast sink a frozen row, not a mutable alias of stream state", async () => {
		const h = await seeded("hello\n");
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello!\n") }),
			ADA,
		);

		// The broadcast row is the object the stream holds and the object handed to `storage.put`.
		// `broadcast` is documented as "must not throw"; freezing is what makes "must not mutate"
		// true rather than merely hoped for.
		const row = h.broadcast[0]!;
		expect(Object.isFrozen(row)).toBe(true);
		expect(() => {
			(row as { revision: number }).revision = 99;
		}).toThrow(TypeError);
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 1 });
	});

	it("transforms a submission based on a stale revision over the rows since it", async () => {
		const h = await seeded("hello\n");
		// Ada appends at the end, twice.
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello\nada1\n") }),
			ADA,
		);
		await h.authority.submit(
			submission({
				revision: 1,
				seq: 2,
				change: edit("hello\nada1\n", "hello\nada1\nada2\n"),
			}),
			ADA,
		);

		// Grace never saw either row: she still believes the document is "hello\n" and inserts at
		// the front. Her change must land at the front of the current head, not clobber Ada's rows.
		const result = await h.authority.submit(
			submission({
				revision: 0,
				clientId: "cli-b",
				change: edit("hello\n", "grace\nhello\n"),
			}),
			GRACE,
		);

		expect(result).toMatchObject({ ok: true, revision: 3 });
		expect(textOf(await h.authority.content())).toBe(
			"grace\nhello\nada1\nada2\n",
		);
	});

	it("rejects a change that does not resolve at head, and one that changes nothing", async () => {
		const h = await seeded("hello\n");

		expect(
			await h.authority.submit(
				submission({ revision: 4, change: edit("hello\n", "x\n") }),
				ADA,
			),
		).toMatchObject({ ok: false, code: "stream-gone" });
		expect(
			await h.authority.submit(
				submission({ generation: 7, change: edit("hello\n", "x\n") }),
				ADA,
			),
		).toMatchObject({ ok: false, code: "stream-gone" });
		expect(
			await h.authority.submit(submission({ change: [] }), ADA),
		).toMatchObject({ ok: false, code: "malformed" });
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 0 });
	});

	it("rejects a change that cannot apply to the content it was transformed onto", async () => {
		const h = await seeded("hello\n");
		// An edit whose before-length (3) does not match the document (6). Schema-valid, so it
		// reaches the content stage -- which is exactly what stage 2 is for.
		expect(
			await h.authority.submit(
				submission({ change: [[PATH, { edit: [[3, "x"]] }]] }),
				ADA,
			),
		).toMatchObject({ ok: false, code: "malformed" });
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 0 });
	});
});

// =======================================================================================

describe("ingestion order", () => {
	it("schema-validates before any transform runs", async () => {
		const h = await seeded("hello\n");
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello!\n") }),
			ADA,
		);
		transformSpy.mockClear();

		// A negative section length: rejected by `validateCodeChangeSchema`. It claims revision 0,
		// so a loop that transformed first would call `transformCodeChange` over the row above --
		// with a change the algebra is documented never to see.
		const result = await h.authority.submit(
			submission({
				revision: 0,
				clientId: "cli-b",
				change: [[PATH, { edit: [[-1, "x"], 7] }]],
			}),
			ADA,
		);

		expect(result).toMatchObject({ ok: false, code: "malformed" });
		expect(transformSpy).not.toHaveBeenCalled();
	});

	it("dedupes before resolving the base, so a retry survives an unresolvable base", () => {
		// The property, stated directly against the span: a recognized retry gets its recorded
		// landing spot back even when its claimed position no longer resolves at all. Recognition
		// must never require the base to remain transformable -- otherwise a client that retried
		// across a destructive bump would be told to rebuild after its change had been applied.
		// (Single-generation today, so this is only reachable by construction; the later step that
		// adds generation bumps makes it a live path, and the ordering must already be right.)
		const h = harness();
		const retry = submission({ change: edit("hello\n", "hello!\n") });
		const recordKey = "ot:client:10:opaque-ada:cli-a";
		const state: OtStreamState = {
			generation: 4,
			revision: 0,
			rows: [],
			windowBase: 0,
			materialized: 0,
			liveChangeUnits: 0,
			canonical: { revision: 1, revisionId: "rev-1", atRevision: 0 },
			clients: new Map([
				[recordKey, { seq: 1, generation: 0, revision: 1, digest: "d" }],
			]),
		};

		const outcome = applySubmissionSynchronously(
			state,
			h.deps,
			{ submission: retry, author: ADA, digest: "d", recordKey },
			prefetch({
				generation: 4,
				revision: 0,
				baseRevision: 0,
				content: doc("hello\n"),
			}),
		);

		expect(outcome).toEqual({
			ok: true,
			duplicate: true,
			generation: 0,
			revision: 1,
		});
		expect(transformSpy).not.toHaveBeenCalled();
		expect(h.broadcast).toHaveLength(0);
	});

	it("content-validates the transformed change, not the submitted one", async () => {
		const h = await seeded("ab");
		// Ada deletes a character, so the document is 1 unit long at head.
		await h.authority.submit(submission({ change: edit("ab", "a") }), ADA);

		// Grace's change is valid against her stale 2-unit base and invalid against head; after
		// transforming, it is valid again (the delete/retain lengths are rebased for her). If the
		// loop validated her submitted change against head content, this would be rejected.
		const result = await h.authority.submit(
			submission({
				revision: 0,
				clientId: "cli-b",
				change: edit("ab", "abc"),
			}),
			GRACE,
		);
		expect(result).toMatchObject({ ok: true, revision: 2 });
		expect(textOf(await h.authority.content())).toBe("ac");
	});
});

// =======================================================================================

describe("dedupe", () => {
	it("acknowledges a retry with its recorded landing spot without re-applying", async () => {
		const h = await seeded("one\n");
		const first = submission({ change: edit("one\n", "xone\n") });

		const ack = await h.authority.submit(first, ADA);
		expect(ack).toEqual({
			ok: true,
			duplicate: false,
			generation: 0,
			revision: 1,
		});
		expect(await h.authority.submit(first, ADA)).toEqual({
			ok: true,
			duplicate: true,
			generation: 0,
			revision: 1,
		});
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 1 });
		expect(textOf(await h.authority.content())).toBe("xone\n");
		expect(h.broadcast).toHaveLength(1);
	});

	it("rejects seq reuse with different content, a gap, and an unknown session past seq 1", async () => {
		const h = await seeded("one\n");
		const first = submission({ change: edit("one\n", "xone\n") });
		await h.authority.submit(first, ADA);

		expect(
			await h.authority.submit(
				{ ...first, change: edit("one\n", "yone\n") },
				ADA,
			),
		).toMatchObject({ ok: false, code: "sequence" });
		// A gap: seq 3 when the record says 1. This is also what enforces one submission in flight.
		expect(
			await h.authority.submit(
				{ ...first, seq: 3, change: edit("xone\n", "xtwo\n") },
				ADA,
			),
		).toMatchObject({ ok: false, code: "sequence" });
		expect(
			await h.authority.submit(
				{ ...first, clientId: "fresh", seq: 2, change: edit("xone\n", "z\n") },
				ADA,
			),
		).toMatchObject({ ok: false, code: "sequence" });
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 1 });
	});

	it("scopes records to the authenticated user, not to the public clientId", async () => {
		const h = await seeded("one\n");
		// `clientId` rides the broadcast echo, so Grace can see -- and reuse -- Ada's.
		await h.authority.submit(
			submission({ clientId: "shared", change: edit("one\n", "xone\n") }),
			ADA,
		);

		const graces = await h.authority.submit(
			submission({
				revision: 1,
				clientId: "shared",
				change: edit("xone\n", "xone\ngrace\n"),
			}),
			GRACE,
		);

		// Grace's seq 1 is a fresh first change under her own record: it applies, and it neither
		// consumed nor advanced Ada's.
		expect(graces).toMatchObject({ ok: true, duplicate: false, revision: 2 });
		expect(textOf(await h.authority.content())).toBe("xone\ngrace\n");
		expect(
			await h.authority.submit(
				submission({
					revision: 2,
					clientId: "shared",
					seq: 2,
					change: edit("xone\ngrace\n", "xone\ngrace\nada\n"),
				}),
				ADA,
			),
		).toMatchObject({ ok: true, revision: 3 });
	});

	it("keeps recognizing a retry after the room is rehydrated from storage", async () => {
		const h = await seeded("one\n");
		const first = submission({ change: edit("one\n", "xone\n") });
		const ack = await h.authority.submit(first, ADA);

		// A hibernation wake: a brand-new authority over the same durable state. Dedupe records are
		// never pruned, so the retry is still recognized rather than applied a second time.
		const woken = harness(h.values);
		expect(await woken.authority.submit(first, ADA)).toEqual({
			...ack,
			duplicate: true,
		});
		expect(await woken.authority.head()).toEqual({
			generation: 0,
			revision: 1,
		});
		expect(textOf(await woken.authority.content())).toBe("xone\n");
		expect(woken.broadcast).toHaveLength(0);
	});
});

// =======================================================================================

describe("convergence", () => {
	/**
	 * A client replica: the two-buffer model the wire protocol assumes. It applies its own edit
	 * optimistically, keeps it pending until the server echoes it, and rebases the pending change
	 * over every foreign row that arrives meanwhile -- the mirror image of the server's transform.
	 */
	class Replica {
		content: CodeContent;
		applied = { generation: 0, revision: 0 };
		pending: CodeChange | null = null;
		seq = 0;

		constructor(
			readonly clientId: string,
			text: string,
		) {
			this.content = doc(text);
		}

		propose(after: string): CodeChangeSubmission {
			const change = edit(textOf(this.content), after);
			this.content = applyCodeChange(this.content, change);
			this.pending = change;
			this.seq += 1;
			return {
				generation: this.applied.generation,
				revision: this.applied.revision,
				clientId: this.clientId,
				seq: this.seq,
				change,
			};
		}

		receive(rows: readonly CodeChangeRow[]): void {
			const pending = selectUnappliedRows(this.applied, rows);
			expect(pending).not.toBeNull();
			for (const row of pending!) {
				if (row.submission?.clientId === this.clientId) {
					// Our own change coming back: already applied locally, and the server's stored
					// change is exactly our rebased pending one.
					this.pending = null;
				} else if (this.pending === null) {
					this.content = applyCodeChange(this.content, row.change);
				} else {
					const { a, b } = transformCodeChange(row.change, this.pending);
					this.content = applyCodeChange(this.content, a);
					this.pending = b;
				}
				this.applied = { generation: row.generation, revision: row.revision };
			}
		}
	}

	it("brings two concurrent clients to a byte-identical document", async () => {
		const h = await seeded("hello\n");
		const ada = new Replica("cli-ada", "hello\n");
		const grace = new Replica("cli-grace", "hello\n");

		// Both edit the same revision, in different places, before seeing each other's change.
		const adaSubmission = ada.propose("hello\nada\n");
		const graceSubmission = grace.propose("grace\nhello\n");

		expect(await h.authority.submit(adaSubmission, ADA)).toMatchObject({
			ok: true,
			revision: 1,
		});
		expect(await h.authority.submit(graceSubmission, GRACE)).toMatchObject({
			ok: true,
			revision: 2,
		});

		// Every subscriber sees the same rows in the same order.
		ada.receive(h.broadcast);
		grace.receive(h.broadcast);

		const server = textOf(await h.authority.content());
		expect(textOf(ada.content)).toBe(server);
		expect(textOf(grace.content)).toBe(server);
		expect(server).toBe("grace\nhello\nada\n");
		expect(ada.pending).toBeNull();
		expect(grace.pending).toBeNull();
	});

	it("replays rows to a reconnecting client and deduplicates the overlap", async () => {
		const h = await seeded("hello\n");
		const ada = new Replica("cli-ada", "hello\n");
		await h.authority.submit(ada.propose("hello\nada1\n"), ADA);
		ada.receive(h.broadcast);
		expect(ada.applied).toEqual({ generation: 0, revision: 1 });

		// Ada drops off; Grace keeps editing.
		const grace = new Replica("cli-grace", "hello\nada1\n");
		grace.applied = { generation: 0, revision: 1 };
		await h.authority.submit(grace.propose("hello\nada1\ngrace\n"), GRACE);

		// On reconnect Ada asks for everything after the last revision she applied -- and the live
		// broadcast she also still holds overlaps it. Deduplication is by (generation, revision).
		const replay = await h.authority.rowsSince(ada.applied);
		expect(replay).toHaveLength(1);
		ada.receive([...h.broadcast, ...replay!]);

		expect(textOf(ada.content)).toBe(textOf(await h.authority.content()));
		expect(ada.applied).toEqual({ generation: 0, revision: 2 });
		// A position that never existed cannot be replayed; the client must reseed.
		expect(
			await h.authority.rowsSince({ generation: 0, revision: 9 }),
		).toBeNull();
		expect(
			await h.authority.rowsSince({ generation: 1, revision: 0 }),
		).toBeNull();
	});
});

// =======================================================================================

describe("the synchronous span", () => {
	// The load-bearing structural guard. Every async step -- rehydration, the digest, the content
	// prefetch -- happens before the span is entered; an `await` inside it would let another
	// submission land between the state re-read and the row write, which is exactly the race the
	// Durable Object's run-to-completion isolation is being used to avoid.
	it("contains no await and is not async", () => {
		// Comments in the span talk about awaits, so compare against the code with comments removed.
		const code = applySubmissionSynchronously
			.toString()
			.replaceAll(/\/\*[\s\S]*?\*\//g, "")
			.replaceAll(/\/\/[^\n]*/g, "");
		expect(code).not.toMatch(/\bawait\b/);
		expect(code).not.toMatch(/^async\b/);
		expect(applySubmissionSynchronously.constructor.name).toBe("Function");
	});

	it("returns a retry signal when the prefetch it was given is stale", () => {
		const h = harness();
		const state: OtStreamState = {
			generation: 0,
			revision: 1,
			rows: [],
			windowBase: 1,
			materialized: 0,
			liveChangeUnits: 0,
			canonical: { revision: 1, revisionId: "rev-1", atRevision: 0 },
			clients: new Map(),
		};
		const prepared: PreparedSubmission = {
			submission: submission({ change: edit("a", "b") }),
			author: ADA,
			digest: "digest",
			recordKey: "ot:client:1:x:cli-a",
		};

		expect(
			applySubmissionSynchronously(
				state,
				h.deps,
				prepared,
				prefetch({
					revision: 0, // the stream moved to revision 1 under this prefetch
					baseRevision: 0,
					content: doc("a"),
				}),
			),
		).toBe("retry");
		expect(h.broadcast).toHaveLength(0);
	});

	it("re-resolves rather than appending onto content that moved during the prefetch", async () => {
		const h = await seeded("hello\n");
		await h.authority.head(); // rehydrate first, so only the prefetch is in flight below

		// Ada's prefetch is held open. Grace's whole submission lands inside that window, so what
		// Ada prefetched no longer describes head. If the span used it anyway, Ada's row would be
		// computed against content the server never had and the document would diverge.
		const hold = h.holdNextGet("ot:base");
		const adaResult = h.authority.submit(
			submission({ change: edit("hello\n", "hello\nada\n") }),
			ADA,
		);
		await hold.entered;
		expect(
			await h.authority.submit(
				submission({
					clientId: "cli-b",
					change: edit("hello\n", "grace\nhello\n"),
				}),
				GRACE,
			),
		).toMatchObject({ ok: true, revision: 1 });
		hold.release();

		expect(await adaResult).toMatchObject({ ok: true, revision: 2 });
		expect(textOf(await h.authority.content())).toBe("grace\nhello\nada\n");
		expect(h.broadcast.map((row) => row.revision)).toEqual([1, 2]);
	});
});

// =======================================================================================

describe("bounds and durability", () => {
	it("refuses a submission once the row window is full", () => {
		const h = harness();
		const rows: CodeChangeRow[] = Array.from(
			{ length: MAX_STREAM_ROWS },
			(_unused, index) => ({
				generation: 0,
				revision: index + 1,
				timestampMs: index,
				author: ADA,
				change: [],
			}),
		);
		const state: OtStreamState = {
			generation: 0,
			revision: rows.length,
			rows,
			windowBase: 0,
			// Every row live: nothing has been materialized, so nothing is prunable and the
			// fail-safe is the only thing left to stop the window.
			materialized: 0,
			liveChangeUnits: 0,
			canonical: { revision: 1, revisionId: "rev-1", atRevision: 0 },
			clients: new Map(),
		};

		const outcome = applySubmissionSynchronously(
			state,
			h.deps,
			{
				submission: submission({
					revision: rows.length,
					change: edit("a", "b"),
				}),
				author: ADA,
				digest: "digest",
				recordKey: "ot:client:1:x:cli-a",
			},
			prefetch({
				revision: rows.length,
				baseRevision: 0,
				content: doc("a"),
			}),
		);

		expect(outcome).toMatchObject({
			ok: false,
			code: "capacity",
			message: CAPACITY_MESSAGE,
		});
		expect(state.revision).toBe(MAX_STREAM_ROWS);
		// And the message must not tell the user to commit. This state is only reachable if the
		// reclamation in this file regressed, and it is precisely the state in which the surface has
		// had to disable Commit -- a client with an unacknowledged submission has no stream position
		// to commit from. Sending the user at the one button that cannot help is worse than silence.
		expect(CAPACITY_MESSAGE).not.toMatch(/commit/i);
		expect(CAPACITY_MESSAGE).toMatch(/fault on our side/);
		expect(CAPACITY_MESSAGE).toMatch(/edits are kept/);
	});

	it("rebuilds head, content, and rows from storage after a hibernation wake", async () => {
		const h = await seeded("hello\n");
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello\nada\n") }),
			ADA,
		);
		await h.authority.submit(
			submission({
				revision: 1,
				clientId: "cli-b",
				change: edit("hello\nada\n", "grace\nhello\nada\n"),
			}),
			GRACE,
		);

		const woken = harness(h.values);
		expect(await woken.authority.head()).toEqual({
			generation: 0,
			revision: 2,
		});
		expect(textOf(await woken.authority.content())).toBe("grace\nhello\nada\n");
		expect(
			(await woken.authority.rowsSince({ generation: 0, revision: 0 }))?.map(
				(row) => row.revision,
			),
		).toEqual([1, 2]);
		// The woken room keeps extending the same stream.
		expect(
			await woken.authority.submit(
				submission({
					revision: 2,
					clientId: "cli-c",
					change: edit("grace\nhello\nada\n", "grace\nhello\nada\nlast\n"),
				}),
				ADA,
			),
		).toMatchObject({ ok: true, revision: 3 });
	});

	it("refuses to seed when a submission lands inside the base read", async () => {
		const h = harness();
		await h.authority.head(); // rehydrate first, so only the seed's base read is in flight

		// The seed's `ot:base` read is held open, and a submission lands inside that window on the
		// still-unseeded room -- so it is transformed and content-validated against the empty base.
		// A seed whose "nothing accepted yet" guard sat on the far side of its own read would now
		// write the base underneath that accepted row: `content()` becomes a fold over content the
		// server never had (and an `edit`-bearing row would throw outright).
		const hold = h.holdNextGet("ot:base");
		const seeding = h.authority.seed(
			new Map([
				[PATH, "seeded\n"],
				["other.txt", "unrelated\n"],
			]),
			CANON,
		);
		await hold.entered;
		expect(
			await h.authority.submit(
				submission({ change: [[PATH, { set: "typed\n" }]] }),
				ADA,
			),
		).toMatchObject({ ok: true, revision: 1 });
		hold.release();

		expect(await seeding).toEqual({ seeded: false });
		expect(h.values.get("ot:base")).toBeUndefined();
		expect([...(await h.authority.content())]).toEqual([[PATH, "typed\n"]]);
	});

	it("refuses a second concurrent seed rather than writing two different bases", async () => {
		const h = harness();
		await h.authority.head();

		// Both calls issue their hoisted `ot:base` read before either writes, so neither read can
		// report the other's base however promptly it commits. Exactly one must win.
		const hold = h.holdNextGet("ot:base");
		const first = h.authority.seed(doc("first\n"), CANON);
		await hold.entered;
		const second = h.authority.seed(doc("second\n"), canonicalAt(2));
		hold.release();

		const results = await Promise.all([first, second]);
		expect(results.filter((result) => result.seeded)).toHaveLength(1);
		expect(textOf(await h.authority.content())).toBe(
			results[0]!.seeded ? "first\n" : "second\n",
		);
	});

	it("seeds inside a synchronous span, like the accept path", () => {
		// The same structural guard the submission span carries, for the same reason: the decision
		// and the base write must not be separable by an await. Comments talk about awaits, so they
		// are stripped before the check.
		const code = seedSynchronously
			.toString()
			.replaceAll(/\/\*[\s\S]*?\*\//g, "")
			.replaceAll(/\/\/[^\n]*/g, "");
		expect(code).not.toMatch(/\bawait\b/);
		expect(code).not.toMatch(/^async\b/);
		expect(seedSynchronously.constructor.name).toBe("Function");

		// And the re-check itself, stated directly against the span: a stream that has moved is
		// never re-based, whatever the hoisted read reported.
		const h = harness();
		const state: OtStreamState = {
			generation: 0,
			revision: 1,
			rows: [
				{
					generation: 0,
					revision: 1,
					timestampMs: 1,
					author: ADA,
					change: [[PATH, { set: "typed\n" }]],
				},
			],
			windowBase: 0,
			materialized: 0,
			liveChangeUnits: 0,
			canonical: { revision: 0, revisionId: null, atRevision: 0 },
			clients: new Map(),
		};
		expect(
			seedSynchronously(state, h.deps, doc("seeded\n"), CANON, false),
		).toEqual({ seeded: false });
		expect(h.values.get("ot:base")).toBeUndefined();
		// And the grounding stamp is not written either: a stamp without the base it describes
		// would claim the room represents a canonical revision its content never came from.
		expect(h.values.get("ot:canonical")).toBeUndefined();
	});

	it("refuses to reseed a stream that has already accepted a change", async () => {
		const h = await seeded("hello\n");
		expect(await h.authority.seed(doc("other\n"), canonicalAt(2))).toEqual({
			seeded: false,
		});
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello!\n") }),
			ADA,
		);
		expect(await h.authority.seed(doc("other\n"), canonicalAt(2))).toEqual({
			seeded: false,
		});
		// The refused seed moved nothing, the grounding stamp included.
		expect(await h.authority.canonical()).toEqual(CANON);
		expect(textOf(await h.authority.content())).toBe("hello!\n");
	});
});

// =======================================================================================

describe("materialization, retirement, and pruning", () => {
	/**
	 * Drive `count` sequential accepts from one client, each replacing the document with `v<rev>`.
	 * The document stays one short line on purpose: these tests are about the shape of the window,
	 * and a document that grew with it would make a few hundred accepts slow for no extra coverage.
	 */
	async function bump(
		h: Harness,
		count: number,
		clientId = "cli-typer",
	): Promise<void> {
		for (let index = 0; index < count; index += 1) {
			const head = await h.authority.head();
			const before = textOf(await h.authority.content());
			const record = h.values.get(
				`ot:client:${ADA.key.length}:${ADA.key}:${clientId}`,
			) as { seq: number } | undefined;
			const result = await h.authority.submit(
				{
					generation: 0,
					revision: head.revision,
					clientId,
					seq: (record?.seq ?? 0) + 1,
					change: edit(before, `v${head.revision + 1}\n`),
				},
				ADA,
			);
			expect(result).toMatchObject({ ok: true, duplicate: false });
		}
	}

	function storedBase(h: Harness): {
		revision: number;
		files: [string, string][];
	} {
		return h.values.get("ot:base") as {
			revision: number;
			files: [string, string][];
		};
	}

	function rowKeys(h: Harness): string[] {
		return [...h.values.keys()]
			.filter((key) => key.startsWith("ot:row:"))
			.sort();
	}

	/** A retired, TTL-expired row window, for the direct prune-span tests. */
	function retiredRows(count: number, timestampMs: number): CodeChangeRow[] {
		return Array.from({ length: count }, (_unused, index) => ({
			generation: 0,
			revision: index + 1,
			timestampMs,
			author: ADA,
			change: [] as CodeChange,
		}));
	}

	it("moves the base once the live window crosses the row threshold", async () => {
		const h = await seeded("v0\n");
		await bump(h, MATERIALIZE_THRESHOLD_ROWS - 1);

		// Still the seeded base: the window has not earned a rewrite yet.
		expect(storedBase(h).revision).toBe(0);
		expect(storedBase(h).files).toEqual([[PATH, "v0\n"]]);

		await bump(h, 1);
		expect(storedBase(h).revision).toBe(MATERIALIZE_THRESHOLD_ROWS);
		expect(storedBase(h).files).toEqual([
			[PATH, `v${MATERIALIZE_THRESHOLD_ROWS}\n`],
		]);
		// And the window immediately starts over: the very next accept is fold-cheap again.
		await bump(h, 1);
		expect(storedBase(h).revision).toBe(MATERIALIZE_THRESHOLD_ROWS);
	});

	it("leaves content identical across the accept that materializes", async () => {
		const h = await seeded("v0\n");
		await bump(h, MATERIALIZE_THRESHOLD_ROWS - 1);
		const before = await h.authority.content();
		expect(storedBase(h).revision).toBe(0);

		await bump(h, 1);

		// The property, stated exactly: materialization is content-preserving. Head content after
		// the materializing accept is the content before it with that one row applied -- nothing
		// dropped by retirement, nothing folded twice by the base having moved underneath.
		const applied = applyCodeChange(before, h.broadcast.at(-1)!.change);
		expect([...(await h.authority.content())]).toEqual([...applied]);
		expect(storedBase(h).revision).toBe(MATERIALIZE_THRESHOLD_ROWS);
	});

	it("transforms a submission based INSIDE the materialized range", async () => {
		// The headline property. Grace went offline at revision 5, the room materialized past her
		// twice while she was gone, and her change must still land -- transformed over every row
		// since, retired ones included -- rather than being rejected as unresolvable.
		const h = await seeded("v0\n");
		await bump(h, 5);
		const graceBase = textOf(await h.authority.content());
		await bump(h, MATERIALIZE_THRESHOLD_ROWS * 2);

		expect(storedBase(h).revision).toBeGreaterThan(5);
		const headBefore = textOf(await h.authority.content());

		const result = await h.authority.submit(
			{
				generation: 0,
				revision: 5,
				clientId: "cli-grace",
				seq: 1,
				change: edit(graceBase, `grace ${graceBase}`),
			},
			GRACE,
		);

		expect(result).toMatchObject({ ok: true, duplicate: false });
		// Her insert was at the very front of her stale document; every row since edited the digits
		// after it, so the correctly rebased change is still an insert at the front of head.
		expect(textOf(await h.authority.content())).toBe(`grace ${headBefore}`);
	});

	it("keeps serving retired rows to a reconnecting subscriber", async () => {
		const h = await seeded("v0\n");
		await bump(h, MATERIALIZE_THRESHOLD_ROWS + 3);
		expect(storedBase(h).revision).toBe(MATERIALIZE_THRESHOLD_ROWS);

		// Rows 1..128 are retired -- inside the base, out of the content fold -- and still replayable.
		const replay = await h.authority.rowsSince({ generation: 0, revision: 2 });
		expect(replay?.map((row) => row.revision)).toEqual(
			Array.from(
				{ length: MATERIALIZE_THRESHOLD_ROWS + 1 },
				(_unused, index) => index + 3,
			),
		);
		// A client that applies them on top of what it had at revision 2 reaches head.
		let content = doc("v2\n");
		for (const row of replay!) content = applyCodeChange(content, row.change);
		expect([...content]).toEqual([...(await h.authority.content())]);
	});

	it("prunes retired rows only once they are past the TTL, and never a live one", async () => {
		const h = await seeded("v0\n");
		await bump(h, MATERIALIZE_THRESHOLD_ROWS + 2);
		// Everything through 128 is retired, and none of it is old enough to drop yet.
		expect(h.deleted).toEqual([]);
		expect(rowKeys(h)).toHaveLength(MATERIALIZE_THRESHOLD_ROWS + 2);

		h.advanceClock(RETIRED_ROW_TTL_MS + 1);
		await bump(h, 1);

		// Exactly the retired prefix went, and the two live rows stayed: the base does not contain
		// them, so dropping them would drop content.
		expect(h.deleted).toHaveLength(MATERIALIZE_THRESHOLD_ROWS);
		expect(h.deleted[0]).toBe("ot:row:000000000001");
		expect(rowKeys(h)).toEqual([
			`ot:row:${String(MATERIALIZE_THRESHOLD_ROWS + 1).padStart(12, "0")}`,
			`ot:row:${String(MATERIALIZE_THRESHOLD_ROWS + 2).padStart(12, "0")}`,
			`ot:row:${String(MATERIALIZE_THRESHOLD_ROWS + 3).padStart(12, "0")}`,
		]);
		// Content is untouched by the deletion -- the base already held those rows.
		expect(textOf(await h.authority.content())).toBe(
			`v${MATERIALIZE_THRESHOLD_ROWS + 3}\n`,
		);

		// A position inside the pruned range is now a clean, explicit rebuild instruction.
		expect(
			await h.authority.submit(
				{
					generation: 0,
					revision: 5,
					clientId: "cli-late",
					seq: 1,
					change: edit("v5\n", "late v5\n"),
				},
				GRACE,
			),
		).toMatchObject({ ok: false, code: "stream-gone" });
		expect(
			await h.authority.rowsSince({ generation: 0, revision: 5 }),
		).toBeNull();
		// And a position inside the surviving window still transforms.
		expect(
			await h.authority.submit(
				{
					generation: 0,
					revision: MATERIALIZE_THRESHOLD_ROWS + 1,
					clientId: "cli-recent",
					seq: 1,
					change: edit(
						`v${MATERIALIZE_THRESHOLD_ROWS + 1}\n`,
						`recent v${MATERIALIZE_THRESHOLD_ROWS + 1}\n`,
					),
				},
				GRACE,
			),
		).toMatchObject({ ok: true });
	});

	it("does not let pruning reach the dedupe records", async () => {
		const h = await seeded("v0\n");
		await bump(h, MATERIALIZE_THRESHOLD_ROWS + 1);
		const head = await h.authority.head();
		const before = textOf(await h.authority.content());
		const late = {
			generation: 0,
			revision: head.revision,
			clientId: "cli-late",
			seq: 1,
			change: edit(before, `late ${before}`),
		};
		expect(await h.authority.submit(late, GRACE)).toMatchObject({ ok: true });

		h.advanceClock(RETIRED_ROW_TTL_MS * 10);
		await bump(h, 1);
		expect(h.deleted.length).toBeGreaterThan(0);
		expect(h.deleted.every((key) => key.startsWith("ot:row:"))).toBe(true);

		// The record is far older than the retention horizon and must still be there: expiring one
		// would let this delayed retry masquerade as a fresh seq 1 and apply a second time.
		expect(await h.authority.submit(late, GRACE)).toMatchObject({
			ok: true,
			duplicate: true,
		});
		expect(textOf(await h.authority.content())).toBe(
			`v${MATERIALIZE_THRESHOLD_ROWS + 3}\n`,
		);
	});

	it("caps the retained window by rows as well as by age", () => {
		// Driving 2048 real accepts would prove nothing extra, so the span is exercised directly.
		const h = harness();
		const rows = retiredRows(MAX_RETAINED_ROWS + 10, 1_700_000_000_000);
		const state: OtStreamState = {
			generation: 0,
			revision: rows.length,
			rows,
			windowBase: 0,
			materialized: rows.length,
			liveChangeUnits: 0,
			canonical: { revision: 1, revisionId: "rev-1", atRevision: 0 },
			clients: new Map(),
		};

		// Every row is retired but none is anywhere near the TTL: age alone would keep them all.
		pruneRetiredRows(state, h.deps);

		expect(h.deleted).toHaveLength(10);
		expect(state.rows).toHaveLength(MAX_RETAINED_ROWS);
		expect(state.windowBase).toBe(10);
		expect(state.rows[0]!.revision).toBe(11);
	});

	it("never prunes past the watermark, whatever the row cap says", () => {
		const h = harness();
		const rows = retiredRows(MAX_RETAINED_ROWS + 10, 1_700_000_000_000);
		const state: OtStreamState = {
			generation: 0,
			revision: rows.length,
			rows,
			windowBase: 0,
			// Only the first three rows are inside the base; everything above is live content that
			// exists nowhere else, so the row cap must stop dead at the watermark.
			materialized: 3,
			liveChangeUnits: 0,
			canonical: { revision: 1, revisionId: "rev-1", atRevision: 0 },
			clients: new Map(),
		};

		pruneRetiredRows(state, h.deps);

		expect(h.deleted).toEqual([
			"ot:row:000000000001",
			"ot:row:000000000002",
			"ot:row:000000000003",
		]);
		expect(state.windowBase).toBe(3);
		expect(state.rows[0]!.revision).toBe(4);
	});

	it("neither loses nor double-applies a row accepted while another submission is prefetching across a materialization", async () => {
		const h = await seeded("v0\n");
		await bump(h, MATERIALIZE_THRESHOLD_ROWS - 1);
		const staleText = textOf(await h.authority.content());
		expect(storedBase(h).revision).toBe(0);

		// Ada's base read is held open, so her prefetch reflects the pre-materialization world.
		const hold = h.holdNextGet("ot:base");
		const adaResult = h.authority.submit(
			{
				generation: 0,
				revision: MATERIALIZE_THRESHOLD_ROWS - 1,
				clientId: "cli-ada",
				seq: 1,
				change: edit(staleText, `ada ${staleText}`),
			},
			ADA,
		);
		await hold.entered;
		// Grace's accept lands inside that window and is the one that crosses the threshold, so the
		// base moves under Ada's prefetch. If the span trusted it, Ada's change would be applied to
		// content that already contains every row the new base absorbed -- each of them twice.
		await bump(h, 1, "cli-grace");
		expect(storedBase(h).revision).toBe(MATERIALIZE_THRESHOLD_ROWS);
		hold.release();

		expect(await adaResult).toMatchObject({
			ok: true,
			revision: MATERIALIZE_THRESHOLD_ROWS + 1,
		});
		// Grace's row and Ada's row, each applied exactly once, in server order.
		expect(textOf(await h.authority.content())).toBe(
			`ada v${MATERIALIZE_THRESHOLD_ROWS}\n`,
		);
		expect(h.broadcast.at(-1)!.revision).toBe(MATERIALIZE_THRESHOLD_ROWS + 1);
		expect(h.broadcast).toHaveLength(MATERIALIZE_THRESHOLD_ROWS + 1);
	});

	it("refuses a prefetch whose base is not the one the stream has materialized", () => {
		// The span's own guard on the base move, stated directly. The stamp matches, so the position
		// check passes; only the base check stands between this submission and being folded onto a
		// base that already contains rows 1..3.
		const h = harness();
		const state: OtStreamState = {
			generation: 0,
			revision: 3,
			rows: retiredRows(3, 1_700_000_000_000),
			windowBase: 0,
			materialized: 3,
			liveChangeUnits: 0,
			canonical: { revision: 1, revisionId: "rev-1", atRevision: 0 },
			clients: new Map(),
		};

		expect(
			applySubmissionSynchronously(
				state,
				h.deps,
				{
					submission: submission({ revision: 3, change: edit("a", "b") }),
					author: ADA,
					digest: "digest",
					recordKey: "ot:client:1:x:cli-a",
				},
				prefetch({
					revision: 3,
					baseRevision: 0, // an older base than the stream has materialized
					content: doc("a"),
				}),
			),
		).toBe("retry");
		expect(h.broadcast).toHaveLength(0);
	});

	it("survives a hibernation wake mid-materialization", async () => {
		const h = await seeded("v0\n");
		await bump(h, MATERIALIZE_THRESHOLD_ROWS + 4);
		const content = textOf(await h.authority.content());
		const head = await h.authority.head();

		// A brand-new authority over the same durable state: the watermark (carried by the base
		// record), the retired rows, and the base must all come back.
		const woken = harness(h.values);
		expect(await woken.authority.head()).toEqual(head);
		expect(textOf(await woken.authority.content())).toBe(content);

		// Retirement survived: a position inside the materialized range still transforms, and the
		// content fold did not re-apply the rows the base already holds.
		expect(
			await woken.authority.submit(
				{
					generation: 0,
					revision: 4,
					clientId: "cli-woken",
					seq: 1,
					change: edit("v4\n", "woken v4\n"),
				},
				GRACE,
			),
		).toMatchObject({ ok: true, revision: head.revision + 1 });
		expect(textOf(await woken.authority.content())).toBe(`woken ${content}`);
	});

	it("survives a hibernation wake after the window has been pruned", async () => {
		const h = await seeded("v0\n");
		await bump(h, MATERIALIZE_THRESHOLD_ROWS + 1);
		h.advanceClock(RETIRED_ROW_TTL_MS + 1);
		await bump(h, 1);
		expect(h.deleted).toHaveLength(MATERIALIZE_THRESHOLD_ROWS);
		const content = textOf(await h.authority.content());
		const head = await h.authority.head();

		const woken = harness(h.values);
		expect(await woken.authority.head()).toEqual(head);
		expect(textOf(await woken.authority.content())).toBe(content);
		// The window's new origin came back with it: below it is a rebuild, at or above it is not.
		expect(
			await woken.authority.rowsSince({ generation: 0, revision: 3 }),
		).toBeNull();
		expect(
			(
				await woken.authority.rowsSince({
					generation: 0,
					revision: MATERIALIZE_THRESHOLD_ROWS,
				})
			)?.map((row) => row.revision),
		).toEqual([MATERIALIZE_THRESHOLD_ROWS + 1, MATERIALIZE_THRESHOLD_ROWS + 2]);
		expect(
			await woken.authority.submit(
				{
					generation: 0,
					revision: MATERIALIZE_THRESHOLD_ROWS,
					clientId: "cli-woken",
					seq: 1,
					change: edit(
						`v${MATERIALIZE_THRESHOLD_ROWS}\n`,
						`woken v${MATERIALIZE_THRESHOLD_ROWS}\n`,
					),
				},
				GRACE,
			),
		).toMatchObject({ ok: true });
	});

	it("keeps the live window self-limiting, so `capacity` is never reached", async () => {
		const h = await seeded("v0\n");
		await bump(h, MATERIALIZE_THRESHOLD_ROWS * 3 + 7);

		const head = await h.authority.head();
		// The invariant that retires the old 1024-row ceiling: the unmaterialized window is capped
		// by construction, however long the room is edited without a canonical commit.
		expect(head.revision - storedBase(h).revision).toBeLessThan(
			MATERIALIZE_THRESHOLD_ROWS,
		);
		expect(head.revision).toBeGreaterThan(MAX_STREAM_ROWS / 16);
	});

	it("materializes and prunes inside synchronous spans, like the accept and seed paths", () => {
		// The same structural guard, extended to the two spans this step adds. Moving the base or
		// deleting a row across an await would put an accept inside the window it is dismantling.
		for (const span of [materializeSynchronously, pruneRetiredRows]) {
			const code = span
				.toString()
				.replaceAll(/\/\*[\s\S]*?\*\//g, "")
				.replaceAll(/\/\/[^\n]*/g, "");
			expect(code).not.toMatch(/\bawait\b/);
			expect(code).not.toMatch(/^async\b/);
			expect(span.constructor.name).toBe("Function");
		}
	});
});

// =======================================================================================

describe("OtAuthority.adoptCanonical", () => {
	it("records which canonical revision a seed grounded the room on", async () => {
		const h = await seeded("hello\n", canonicalAt(5));
		expect(await h.authority.canonical()).toEqual({
			revision: 5,
			revisionId: "rev-5",
		});
		// And it is durable: a commit's compare-and-swap is pinned to it, so a room that forgot its
		// grounding across a hibernation wake would be a room whose next commit overwrites whatever
		// landed out of band. A wake is a new instance over the same storage.
		const woken = new OtAuthority(h.deps);
		expect(await woken.canonical()).toEqual({
			revision: 5,
			revisionId: "rev-5",
		});
	});

	it("reads an ungrounded room as revision 0 rather than as something plausible", async () => {
		const h = harness();
		// Nothing seeded: `revision: 0` is behind every real canonical revision, so the surface
		// blocks Commit and the room re-grounds through an ordinary offer instead of pinning a CAS
		// to a revision it invented.
		expect(await h.authority.canonical()).toEqual({
			revision: 0,
			revisionId: null,
		});
	});

	it("carries an UNEDITED room forward as one server-authored row", async () => {
		const h = await seeded("hello\n", canonicalAt(5));

		const result = await h.authority.adoptCanonical(
			offer(canonicalAt(6), "hello world\n"),
		);

		expect(result).toEqual({
			ok: true,
			effect: "adopted",
			canonical: { revision: 6, revisionId: "rev-6" },
		});
		// A row, not a base swap. Swapping the base would move every replica's ground truth with
		// nothing to tell them; a row reaches every socket through the ordinary broadcast path.
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 1 });
		expect(h.broadcast).toHaveLength(1);
		expect(h.broadcast[0]).toMatchObject({ generation: 0, revision: 1 });
		// Server-authored: no `submission` echo, because no client has a pending edit to retire.
		expect(h.broadcast[0]?.submission).toBeUndefined();
		expect(h.broadcast[0]?.author).toEqual(ADA);
		expect(textOf(await h.authority.content())).toBe("hello world\n");
	});

	it("leaves an adopted room reading UNEDITED, so the next revision adopts too", async () => {
		const h = await seeded("one\n", canonicalAt(1));
		await h.authority.adoptCanonical(offer(canonicalAt(2), "two\n"));

		// The stamp is written in the same step as the row, so `atRevision` names the row the
		// adoption just appended. A stamp written a step later would leave the room permanently
		// looking edited by its own adoption and refuse every later one.
		expect(
			await h.authority.adoptCanonical(offer(canonicalAt(3), "three\n")),
		).toMatchObject({ ok: true, effect: "adopted" });
		expect(textOf(await h.authority.content())).toBe("three\n");
	});

	it("every replica converges on an adoption through the ordinary transform path", async () => {
		const h = await seeded("hello\n", canonicalAt(1));
		await h.authority.adoptCanonical(offer(canonicalAt(2), "hello world\n"));

		// A peer that was mid-edit when the adoption landed submits against the revision it last
		// saw. Its change is rebased over the adoption row exactly like any other remote change --
		// which is the property a base swap would have destroyed.
		const result = await h.authority.submit(
			submission({ revision: 0, change: edit("hello\n", "hello there\n") }),
			GRACE,
		);
		expect(result).toMatchObject({ ok: true, revision: 2 });
		// The adoption row has priority -- the server ordered it first -- so the peer's insert lands
		// after it. Nothing is lost; the two replicas converge on one text.
		expect(textOf(await h.authority.content())).toBe("hello world there\n");

		// And a peer that was merely disconnected replays the adoption as an ordinary row.
		const replay = await h.authority.rowsSince({ generation: 0, revision: 0 });
		expect(replay?.map((row) => row.revision)).toEqual([1, 2]);
	});

	it("moves the stamp ALONE when the offer is byte-identical, even in an edited room", async () => {
		const h = await seeded("hello\n", canonicalAt(1));
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello world\n") }),
			ADA,
		);
		const head = await h.authority.head();
		h.broadcast.length = 0;

		// This is the path a room takes after committing its own text: the commit produced a new
		// canonical revision whose content is exactly what the room already holds, so there is no
		// difference to write and nothing any edit could lose.
		const result = await h.authority.adoptCanonical(
			offer(canonicalAt(2), "hello world\n"),
		);

		expect(result).toEqual({
			ok: true,
			effect: "repaired",
			canonical: { revision: 2, revisionId: "rev-2" },
		});
		expect(await h.authority.head()).toEqual(head);
		expect(h.broadcast).toEqual([]);
		expect(textOf(await h.authority.content())).toBe("hello world\n");
	});

	it("REFUSES an edited room and leaves it exactly as it was", async () => {
		const h = await seeded("hello\n", canonicalAt(1));
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello, unsaved\n") }),
			ADA,
		);
		const head = await h.authority.head();
		h.broadcast.length = 0;

		const result = await h.authority.adoptCanonical(
			offer(canonicalAt(2), "something else entirely\n"),
		);

		// The refusal is the product behaviour: a server that silently replaced a colleague's
		// unsaved work would be the same class of data loss the grounding stamp exists to prevent.
		expect(result).toMatchObject({ ok: false, code: "edited" });
		// The refusal still carries the stamp in force, so a refused caller learns what its
		// commits must be pinned to rather than falling back to the store's latest.
		expect(result.canonical).toEqual({ revision: 1, revisionId: "rev-1" });
		expect(await h.authority.head()).toEqual(head);
		expect(h.broadcast).toEqual([]);
		expect(textOf(await h.authority.content())).toBe("hello, unsaved\n");
	});

	it("replaces an edited room only when the user explicitly forced it", async () => {
		const h = await seeded("hello\n", canonicalAt(1));
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello, unsaved\n") }),
			ADA,
		);

		const result = await h.authority.adoptCanonical(
			offer(canonicalAt(2), "replaced\n", true),
		);

		expect(result).toMatchObject({ ok: true, effect: "adopted" });
		expect(textOf(await h.authority.content())).toBe("replaced\n");
		// Still one ordinary row, so the peers watching this document see it converge rather than
		// being reset underneath them.
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 2 });
		expect(h.broadcast.at(-1)?.revision).toBe(2);
	});

	it("explicitly restores the current saved version through the shared stream", async () => {
		const h = await seeded("saved\n", canonicalAt(2));
		await h.authority.submit(
			submission({ change: edit("saved\n", "broken draft\n") }),
			ADA,
		);
		const result = await h.authority.adoptCanonical(
			offer(canonicalAt(2), "saved\n", true),
		);
		expect(result).toMatchObject({ ok: true, effect: "adopted" });
		expect(textOf(await h.authority.content())).toBe("saved\n");
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 2 });
		expect(await h.authority.canonical()).toEqual({
			revision: 2,
			revisionId: "rev-2",
		});
		expect(h.broadcast.at(-1)?.revision).toBe(2);
		// After recovery, an ordinary newer version can be adopted without a stale-draft conflict.
		expect(
			await h.authority.adoptCanonical(offer(canonicalAt(3), "next\n")),
		).toMatchObject({ ok: true, effect: "adopted" });
	});

	it.each([canonicalAt(1), { revision: 2, revisionId: "different-id" }])(
		"does not force-restore an older or differently identified saved version %s",
		async (canonical) => {
			const h = await seeded("saved\n", canonicalAt(2));
			await h.authority.submit(
				submission({ change: edit("saved\n", "preserve my draft\n") }),
				ADA,
			);
			h.broadcast.length = 0;
			expect(
				await h.authority.adoptCanonical(
					offer(canonical, "replacement\n", true),
				),
			).toMatchObject({ ok: true, effect: "current" });
			expect(textOf(await h.authority.content())).toBe("preserve my draft\n");
			expect(h.broadcast).toEqual([]);
		},
	);

	it("treats an offer that is not newer as `current`, so concurrent offers are idempotent", async () => {
		const h = await seeded("hello\n", canonicalAt(1));
		const [first, second] = await Promise.all([
			h.authority.adoptCanonical(offer(canonicalAt(2), "adopted\n")),
			h.authority.adoptCanonical(offer(canonicalAt(2), "adopted\n")),
		]);

		// Every peer offers the revision it just loaded; the first moves the stamp and the rest must
		// be no-ops rather than a second row saying the same thing.
		const effects = [first, second].map((result) =>
			result.ok ? result.effect : result.code,
		);
		expect(effects.filter((effect) => effect === "adopted")).toHaveLength(1);
		// `current`, exactly -- not "current or repaired". The loser is decided by the not-newer
		// short-circuit, which runs before the byte-identical branch can look at content at all;
		// accepting either outcome here leaves that short-circuit untested, and a `<=` weakened to
		// `<` survives the whole suite.
		expect(effects.filter((effect) => effect !== "adopted")).toEqual([
			"current",
		]);
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 1 });
		// An older offer never walks the stamp backwards.
		expect(
			await h.authority.adoptCanonical(offer(canonicalAt(1), "hello\n")),
		).toEqual({
			ok: true,
			effect: "current",
			canonical: { revision: 2, revisionId: "rev-2" },
		});
	});

	it("short-circuits an offer at the SAME revision, whatever that revision says", async () => {
		const h = await seeded("hello\n", canonicalAt(2));
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello, unsaved\n") }),
			ADA,
		);
		const head = await h.authority.head();
		h.broadcast.length = 0;

		// The stamp is already at revision 2, and this offer names revision 2 with different
		// content. The room must decide on the revision number alone and stop: falling through
		// would diff an edited room against text nobody asked for and refuse it as `edited`, so
		// every re-delivery of an offer the room has already taken would read as a conflict the
		// user has to resolve. Equality is the whole of "not newer".
		const result = await h.authority.adoptCanonical(
			offer(canonicalAt(2), "a different revision 2\n"),
		);

		expect(result).toEqual({
			ok: true,
			effect: "current",
			canonical: { revision: 2, revisionId: "rev-2" },
		});
		expect(await h.authority.head()).toEqual(head);
		expect(h.broadcast).toEqual([]);
		expect(textOf(await h.authority.content())).toBe("hello, unsaved\n");
		// And the room is still grounded exactly where it was, edits and all.
		expect(await h.authority.canonical()).toEqual({
			revision: 2,
			revisionId: "rev-2",
		});
	});

	it("reads a malformed grounding record as ungrounded, never as something plausible", async () => {
		const h = await seeded("hello\n", canonicalAt(5));
		// A corrupt `ot:canonical`. `revision: 0` is behind every real canonical revision, so the
		// surface blocks Commit and the room re-grounds through an ordinary offer; inventing a
		// plausible stamp would pin a compare-and-swap to a revision the room never saw.
		h.values.set("ot:canonical", { revision: "five", atRevision: 0 });

		const woken = new OtAuthority(h.deps);
		expect(await woken.canonical()).toEqual({ revision: 0, revisionId: null });
		// And an ordinary offer re-grounds it without anything having to be repaired by hand.
		expect(
			await woken.adoptCanonical(offer(canonicalAt(5), "hello\n")),
		).toMatchObject({ ok: true, effect: "repaired" });
	});

	it("refuses a canonical revision the document's own limits reject, rather than appending it", async () => {
		const h = await seeded("hello\n", canonicalAt(1));
		const oversized = "x".repeat(MAX_FILE_TEXT_LENGTH + 1);

		const result = await h.authority.adoptCanonical(
			offer(canonicalAt(2), oversized),
		);

		// Server-built, but validated like anything else that enters the stream: appending it and
		// discovering the problem later would wedge the room on a row nothing can apply.
		expect(result).toMatchObject({ ok: false, code: "malformed" });
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 0 });
		expect(await h.authority.canonical()).toEqual({
			revision: 1,
			revisionId: "rev-1",
		});
	});

	it("adopts inside a synchronous span, like the accept and seed paths", () => {
		// The decision this span makes is "does the room hold edits an adoption would destroy", and
		// the write it authorizes is a row that destroys exactly those edits. A guard on the far
		// side of an await would decide about a room that has since been typed in.
		const code = adoptCanonicalSynchronously
			.toString()
			.replaceAll(/\/\*[\s\S]*?\*\//g, "")
			.replaceAll(/\/\/[^\n]*/g, "");
		expect(code).not.toMatch(/\bawait\b/);
		expect(code).not.toMatch(/^async\b/);
		expect(adoptCanonicalSynchronously.constructor.name).toBe("Function");
	});

	it("re-checks the prefetch inside the span and retries rather than adopting onto stale content", () => {
		const h = harness();
		const state: OtStreamState = {
			generation: 0,
			revision: 4,
			rows: [],
			windowBase: 4,
			materialized: 4,
			liveChangeUnits: 0,
			canonical: { revision: 1, revisionId: "rev-1", atRevision: 4 },
			clients: new Map(),
		};

		// A stamp the stream has moved past: the difference below would be computed against content
		// the room no longer has, and the row appended at a position that is no longer head.
		expect(
			adoptCanonicalSynchronously(
				state,
				h.deps,
				offer(canonicalAt(2), "x"),
				prefetch({ revision: 3, baseRevision: 4, content: doc("stale") }),
			),
		).toBe("retry");
		// And the base the content was folded from, for the reason the accept span states.
		expect(
			adoptCanonicalSynchronously(
				state,
				h.deps,
				offer(canonicalAt(2), "x"),
				prefetch({ revision: 4, baseRevision: 3, content: doc("stale") }),
			),
		).toBe("retry");
		expect(h.values.get("ot:canonical")).toBeUndefined();
	});

	it("refuses `stream-gone` when the base and the retained window do not bridge", () => {
		const h = harness();
		const state: OtStreamState = {
			generation: 0,
			revision: 4,
			rows: [],
			windowBase: 4,
			materialized: 4,
			liveChangeUnits: 0,
			canonical: { revision: 1, revisionId: "rev-1", atRevision: 4 },
			clients: new Map(),
		};

		// There is no content to diff against, and inventing one would be the silent divergence the
		// whole module exists to prevent.
		expect(
			adoptCanonicalSynchronously(
				state,
				h.deps,
				offer(canonicalAt(2), "x"),
				prefetch({ revision: 4, baseRevision: 4, content: null }),
			),
		).toMatchObject({
			ok: false,
			code: "stream-gone",
			canonical: { revision: 1, revisionId: "rev-1" },
		});
	});
});

// =======================================================================================

describe("OtAuthority.groundCanonical", () => {
	/** The stream position a commit was written from, and the text it wrote. */
	async function committedFrom(h: Harness): Promise<{
		at: { generation: number; revision: number };
		files: CodeContent;
	}> {
		const snapshot = await h.authority.snapshot();
		return { at: snapshot.position, files: snapshot.content };
	}

	it("grounds a room that kept typing through its own commit", async () => {
		const h = await seeded("hello\n", canonicalAt(5));
		// Ada types, and commits what the room holds at revision 1.
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello world\n") }),
			ADA,
		);
		const commit = await committedFrom(h);
		// ...and keeps typing while the commit is in flight.
		await h.authority.submit(
			submission({
				revision: 1,
				seq: 2,
				change: edit("hello world\n", "hello world!\n"),
			}),
			ADA,
		);

		// Offered as an adoption, the room's own commit is refused: it is neither unedited nor
		// byte-identical any more. That refusal is what wedged the document -- the surface says the
		// shared source is "behind" a revision the room is ahead of, blocks Commit, and offers only
		// a replacement that discards everything typed since.
		expect(
			await h.authority.adoptCanonical(offer(canonicalAt(6), "hello world\n")),
		).toMatchObject({ ok: false, code: "edited" });

		// Grounded at the position it was committed from, it is accepted.
		const result = await h.authority.groundCanonical({
			canonical: canonicalAt(6),
			files: commit.files,
			at: commit.at,
		});

		expect(result).toEqual({
			ok: true,
			effect: "repaired",
			canonical: { revision: 6, revisionId: "rev-6" },
		});
		// Nothing was written to the document: no row, no broadcast, not a byte moved.
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 2 });
		expect(textOf(await h.authority.content())).toBe("hello world!\n");
		// The room now pins its commits to 6, which is the revision its text descends from.
		expect(await h.authority.canonical()).toEqual({
			revision: 6,
			revisionId: "rev-6",
		});
	});

	it("still refuses a revision that landed OUT OF BAND after a grounding", async () => {
		const h = await seeded("hello\n", canonicalAt(5));
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello world\n") }),
			ADA,
		);
		const commit = await committedFrom(h);
		await h.authority.submit(
			submission({
				revision: 1,
				seq: 2,
				change: edit("hello world\n", "hello world!\n"),
			}),
			ADA,
		);
		await h.authority.groundCanonical({
			canonical: canonicalAt(6),
			files: commit.files,
			at: commit.at,
		});

		// A proposal merge, a tedi tool edit or an API write produced revision 7 while this room
		// held revision 6's text plus unsaved edits. That is the case the whole record exists for,
		// and grounding must not have weakened it.
		const result = await h.authority.adoptCanonical(
			offer(canonicalAt(7), "somebody else's merge\n"),
		);

		expect(result).toMatchObject({ ok: false, code: "edited" });
		expect(result.canonical).toEqual({ revision: 6, revisionId: "rev-6" });
		expect(textOf(await h.authority.content())).toBe("hello world!\n");
	});

	it("refuses a claim whose position the stream does not corroborate", async () => {
		const h = await seeded("hello\n", canonicalAt(5));
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello world\n") }),
			ADA,
		);
		const committed = await committedFrom(h);
		// Ada types on. Her keystrokes are unsaved: no revision contains them.
		await h.authority.submit(
			submission({
				revision: 1,
				seq: 2,
				change: edit("hello world\n", "hello world, still typing\n"),
			}),
			ADA,
		);
		const head = await h.authority.head();

		// Grace supplies revision 6's REAL content but names the room's HEAD as where it came
		// from. Believing that would mark Ada's unsaved keystrokes as already committed, and the
		// next commit's compare-and-swap would then write straight over revision 6.
		const forged = await h.authority.groundCanonical({
			canonical: canonicalAt(6),
			files: committed.files,
			at: head,
		});

		expect(forged).toMatchObject({ ok: false, code: "edited" });
		expect(await h.authority.canonical()).toEqual({
			revision: 5,
			revisionId: "rev-5",
		});
		// The honest claim, at the position that content really came from, is accepted.
		expect(
			await h.authority.groundCanonical({
				canonical: canonicalAt(6),
				files: committed.files,
				at: committed.at,
			}),
		).toMatchObject({ ok: true, effect: "repaired" });
	});

	it("refuses a position the stream has not reached, and one it has pruned past", async () => {
		const h = await seeded("hello\n", canonicalAt(5));

		expect(
			await h.authority.groundCanonical({
				canonical: canonicalAt(6),
				files: doc("hello\n"),
				at: { generation: 0, revision: 9 },
			}),
		).toMatchObject({ ok: false, code: "stream-gone" });
		// Another generation names a different row under the same number.
		expect(
			await h.authority.groundCanonical({
				canonical: canonicalAt(6),
				files: doc("hello\n"),
				at: { generation: 3, revision: 0 },
			}),
		).toMatchObject({ ok: false, code: "stream-gone" });
		expect(await h.authority.canonical()).toEqual({
			revision: 5,
			revisionId: "rev-5",
		});
	});

	it("treats a re-delivered ground at the SAME revision as current, without re-verifying", async () => {
		const h = await seeded("hello\n", canonicalAt(5));
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello world\n") }),
			ADA,
		);
		const commit = await committedFrom(h);
		expect(
			await h.authority.groundCanonical({
				canonical: canonicalAt(6),
				files: commit.files,
				at: commit.at,
			}),
		).toMatchObject({ ok: true, effect: "repaired" });

		// The room types on, so it is now edited relative to revision 6 -- the ordinary state after
		// a commit, and the state the whole record exists to keep safe.
		await h.authority.submit(
			submission({
				revision: 1,
				seq: 2,
				change: edit("hello world\n", "hello world!\n"),
			}),
			ADA,
		);

		// The same commit answer arrives again -- a retried claim, a reconnect's late refetch, a
		// second tab. The equality case of the not-newer branch is what makes that a no-op. Weaken
		// `<=` to `<` and this falls through to re-verify a decision already in force: on a room
		// that has moved past its window that is a refusal, and a refused ground is the wedge --
		// Commit blocked, and only the destructive Replace offered.
		const again = await h.authority.groundCanonical({
			canonical: canonicalAt(6),
			files: commit.files,
			at: commit.at,
		});

		expect(again).toEqual({
			ok: true,
			effect: "current",
			canonical: { revision: 6, revisionId: "rev-6" },
		});
		// Nothing moved: not the stamp, not the head, not a byte of the document.
		expect(await h.authority.canonical()).toEqual({
			revision: 6,
			revisionId: "rev-6",
		});
		expect(await h.authority.head()).toEqual({ generation: 0, revision: 2 });
		expect(textOf(await h.authority.content())).toBe("hello world!\n");
	});

	it("never walks the stamp backwards, however old the claim is", async () => {
		const h = await seeded("hello\n", canonicalAt(5));
		const commit = await committedFrom(h);

		// A re-delivered answer from a commit the room has already been grounded past.
		expect(
			await h.authority.groundCanonical({
				canonical: canonicalAt(4),
				files: commit.files,
				at: commit.at,
			}),
		).toEqual({
			ok: true,
			effect: "current",
			canonical: { revision: 5, revisionId: "rev-5" },
		});
	});

	it("grounds inside a synchronous span, like every other write in this file", () => {
		const code = groundCanonicalSynchronously
			.toString()
			.replaceAll(/\/\*[\s\S]*?\*\//g, "")
			.replaceAll(/\/\/[^\n]*/g, "");
		expect(code).not.toMatch(/\bawait\b/);
		expect(code).not.toMatch(/^async\b/);
		expect(groundCanonicalSynchronously.constructor.name).toBe("Function");
	});

	it("re-reads the grounding stamp inside the span rather than trusting the prefetch", () => {
		const h = harness();
		const state: OtStreamState = {
			generation: 0,
			revision: 4,
			rows: [],
			windowBase: 4,
			materialized: 4,
			liveChangeUnits: 0,
			// A peer's grounding landed while this claim's prefetch was in flight.
			canonical: { revision: 7, revisionId: "rev-7", atRevision: 4 },
			clients: new Map(),
		};

		expect(
			groundCanonicalSynchronously(
				state,
				h.deps,
				{
					canonical: canonicalAt(6),
					files: doc("hello"),
					at: { generation: 0, revision: 4 },
				},
				prefetch({ revision: 4, baseRevision: 4, content: doc("hello") }),
			),
		).toEqual({
			ok: true,
			effect: "current",
			canonical: { revision: 7, revisionId: "rev-7" },
		});
		expect(h.values.get("ot:canonical")).toBeUndefined();
	});
});

// =======================================================================================

describe("OtAuthority.snapshot", () => {
	it("answers the position, the content and the grounding from ONE instant", async () => {
		const h = await seeded("hello\n", canonicalAt(5));
		await h.authority.submit(
			submission({ change: edit("hello\n", "hello world\n") }),
			ADA,
		);

		const snapshot = await h.authority.snapshot();
		expect(snapshot.position).toEqual({ generation: 0, revision: 1 });
		expect(textOf(snapshot.content)).toBe("hello world\n");
		expect(snapshot.canonical).toEqual({ revision: 5, revisionId: "rev-5" });
	});

	it("never stamps post-adoption content with the pre-adoption grounding", async () => {
		const h = await seeded("hello\n", canonicalAt(5));
		// The base read the snapshot yields on is the exact window an adoption can land in. Assembled
		// from separate `head()`/`content()`/`canonical()` reads, the answer could carry the adopted
		// content under the old stamp -- or the old content at the new revision, which makes a
		// joining client apply a row it already has and throw out of its own fold.
		const hold = h.holdNextGet("ot:base");
		const reading = h.authority.snapshot();
		await hold.entered;
		// The adoption lands completely while the handshake's read is parked: a row is
		// appended, the head moves, and the grounding stamp moves with it.
		expect(
			await h.authority.adoptCanonical(offer(canonicalAt(6), "hello world\n")),
		).toMatchObject({ ok: true, effect: "adopted" });
		hold.release();
		const snapshot = await reading;

		// Whichever side of the adoption it fell on, it is one side of it. Content read after the
		// row under a position read before it is content at revision 1 stamped revision 0 -- and a
		// client handed that applies the adoption row a second time and throws out of its own fold.
		const stamped =
			snapshot.canonical.revision === 6
				? { revision: 1, text: "hello world\n" }
				: { revision: 0, text: "hello\n" };
		expect(snapshot.position.revision).toBe(stamped.revision);
		expect(textOf(snapshot.content)).toBe(stamped.text);
	});
});
