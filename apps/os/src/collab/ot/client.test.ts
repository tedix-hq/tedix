// @vitest-environment node
// Adapted and modified from Cloudflare OS under Apache-2.0; see THIRD_PARTY_NOTICES.md.
import { describe, expect, it, vi } from "vite-plus/test";
import type { CollabVerifiedIdentity } from "../presence";
import {
	type CodeChange,
	type CodeContent,
	diffFiles,
	transformCodeChange,
} from "./code-change";
import {
	CAPACITY_MESSAGE,
	type OtAuthorityStorage,
	OtAuthority,
	type CodeChangeSubmitResult,
} from "./authority";
import type { CodeChangeRow, CodeChangeSubmission } from "./wire";
import {
	OtClient,
	type OtBaseSnapshot,
	type OtBlockedState,
	type OtClientDelegate,
	type RemoteFileEvent,
} from "./client";

// Two harnesses, deliberately:
//
//  - `TestHarness` drives the client against a scripted delegate, which is the only way to open the
//    exact windows the failure ladder lives in (a response that never arrives, an echo that is lost,
//    a `capacity` refusal). Rows are fed by hand, exactly as a transport would.
//  - `serverHarness` drives one or more clients through a REAL `OtAuthority`, so convergence is
//    proven against the actual ordering point rather than against a re-implementation of it.

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

/** The change that turns `before` into `after` -- what an editor would hand `applyLocalChange`. */
function edit(before: string, after: string): CodeChange {
	return diffFiles(doc(before), doc(after));
}

function flush(ms = 5): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function row(
	generation: number,
	revision: number,
	change: CodeChange,
	submission?: { clientId: string; seq: number },
): CodeChangeRow {
	return {
		generation,
		revision,
		timestampMs: 1_700_000_000_000 + revision,
		author: submission ? ADA : GRACE,
		change,
		...(submission !== undefined ? { submission } : {}),
	};
}

const ACCEPTED = (revision: number): CodeChangeSubmitResult => ({
	ok: true,
	duplicate: false,
	generation: 0,
	revision,
});

// =======================================================================================

class TestHarness {
	base: { position: { generation: number; revision: number }; text: string } = {
		position: { generation: 0, revision: 0 },
		text: "abc",
	};
	baseFetches = 0;
	submissions: CodeChangeSubmission[] = [];
	submitResult: (
		submission: CodeChangeSubmission,
	) => Promise<CodeChangeSubmitResult> = async () => ACCEPTED(1);

	discards = 0;
	fatal: unknown = null;
	remoteEvents: RemoteFileEvent[][] = [];
	dirty: boolean[] = [];
	/** Every `hasLocalEdits()` TRANSITION the client pushed, in order. */
	unacknowledged: boolean[] = [];
	blocked: (OtBlockedState | null)[] = [];

	readonly delegate: OtClientDelegate = {
		fetchBase: async () => {
			this.baseFetches += 1;
			return { position: this.base.position, content: doc(this.base.text) };
		},
		submit: (submission) => {
			this.submissions.push(submission);
			return this.submitResult(submission);
		},
		isTransientError: (error) =>
			error instanceof Error && error.message === "transient",
		onRemoteChange: (events) => {
			this.remoteEvents.push(events);
		},
		onLocalEditsDiscarded: () => {
			this.discards += 1;
		},
		onDirtyState: (dirty) => {
			this.dirty.push(dirty);
		},
		onUnacknowledgedEdits: (unacknowledged) => {
			this.unacknowledged.push(unacknowledged);
		},
		onBlocked: (blocked) => {
			this.blocked.push(blocked);
		},
		onFatalError: (error) => {
			this.fatal = error;
		},
	};

	readonly client = new OtClient(this.delegate);

	async started(): Promise<this> {
		this.client.start();
		await flush();
		this.remoteEvents.length = 0;
		return this;
	}

	text(): string {
		return textOf(this.client.getContent());
	}
}

// =======================================================================================

interface ServerHarness {
	authority: OtAuthority;
	broadcasts: CodeChangeRow[];
	/** A client wired to the authority. `subscribed: false` simulates a lost echo stream. */
	attach(
		author: CollabVerifiedIdentity,
		options?: { subscribed?: boolean },
	): { client: OtClient; delegate: OtClientDelegate };
}

async function serverHarness(text: string): Promise<ServerHarness> {
	const values = new Map<string, unknown>();
	const sinks = new Set<(rows: readonly CodeChangeRow[]) => void>();
	const broadcasts: CodeChangeRow[] = [];
	let clock = 1_700_000_000_000;

	const storage: OtAuthorityStorage = {
		// Round-tripped through JSON, like the real DO storage and like `authority.test.ts`.
		get: async <T>(key: string) => {
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
			values.delete(key);
		},
	};

	const authority = new OtAuthority({
		storage,
		broadcast: (row) => {
			broadcasts.push(row);
			for (const sink of sinks) sink([row]);
		},
		now: () => (clock += 1),
	});
	// The stamp says WHICH canonical revision the seeded content is; these tests never move it,
	// so one grounding is enough for the whole harness.
	expect(
		await authority.seed(doc(text), { revision: 1, revisionId: "rev-1" }),
	).toEqual({ seeded: true });

	return {
		authority,
		broadcasts,
		attach: (author, options) => {
			const delegate: OtClientDelegate = {
				// ONE snapshot, exactly as the room's handshake takes it: position and content read in
				// the same synchronous continuation, so a client can never be handed content at one
				// revision stamped with another.
				fetchBase: async () => {
					const snapshot = await authority.snapshot();
					return {
						content: snapshot.content,
						position: snapshot.position,
					};
				},
				submit: (submission) => authority.submit(submission, author),
				isTransientError: (error) =>
					error instanceof Error && error.message === "transient",
				...(options?.subscribed === false
					? {}
					: {
							subscribe: (deliver) => {
								sinks.add(deliver);
								return () => sinks.delete(deliver);
							},
						}),
				onRemoteChange: () => {},
				onLocalEditsDiscarded: () => {},
				onDirtyState: () => {},
				onUnacknowledgedEdits: () => {},
				onBlocked: () => {},
				onFatalError: (error) => {
					throw error;
				},
			};
			return { client: new OtClient(delegate), delegate };
		},
	};
}

async function settle(clients: readonly OtClient[]): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		await flush(2);
		if (clients.every((client) => !client.hasLocalEdits())) return;
	}
	throw new Error("clients never settled");
}

// =======================================================================================

describe("OtClient: base and rows in", () => {
	it("builds content from the base snapshot and applies rows in order", async () => {
		const h = await new TestHarness().started();
		expect(h.client.isReady()).toBe(true);
		expect(h.text()).toBe("abc");

		h.client.pushRow(row(0, 1, edit("abc", "abcd")));
		h.client.pushRow(row(0, 2, edit("abcd", "abcde")));
		await flush();

		expect(h.text()).toBe("abcde");
		expect(h.client.getPosition()).toEqual({ generation: 0, revision: 2 });
	});

	it("holds rows that outrun the stream, and a gap holds the whole stream", async () => {
		const h = await new TestHarness().started();

		// Revisions 2 and 3 arrive before 1: neither may apply, because applying 2 against content
		// that has not seen 1 would mistransform every later position.
		h.client.pushRow(row(0, 2, edit("abcd", "abcdE")));
		h.client.pushRow(row(0, 3, edit("abcdE", "abcdEF")));
		await flush();
		expect(h.text()).toBe("abc");
		expect(h.client.getPosition().revision).toBe(0);

		// The gap closes: all three drain, in strict revision order.
		h.client.pushRow(row(0, 1, edit("abc", "abcd")));
		await flush();
		expect(h.text()).toBe("abcdEF");
		expect(h.client.getPosition().revision).toBe(3);
	});

	it("ignores duplicate and replayed rows", async () => {
		const h = await new TestHarness().started();

		const first = row(0, 1, edit("abc", "abcd"));
		h.client.pushRow(first);
		// A second delivery of revision 1 -- a live broadcast racing a reconnect replay. It must be
		// ignored on identity `(generation, revision)`, not merged: OT does not tolerate double
		// application, and here re-applying would clobber the file outright.
		h.client.pushRow(row(0, 1, [[PATH, { set: "CLOBBER" }]]));
		h.client.pushRow(row(0, 2, edit("abcd", "abcde")));
		await flush();
		expect(h.text()).toBe("abcde");

		// A whole batch replayed after the fact, including rows already applied.
		h.client.pushRows([first, row(0, 2, edit("abcd", "abcde"))]);
		await flush();
		expect(h.text()).toBe("abcde");
		expect(h.client.getPosition().revision).toBe(2);
	});
});

describe("OtClient: submissions and acks", () => {
	it("submits a local edit and retires it on the echo row, notifying editors of nothing", async () => {
		const h = await new TestHarness().started();
		// Hold the RPC response so the echo row -- which precedes it in reality, because the authority
		// broadcasts inside its span and responds afterwards -- does the clearing.
		h.submitResult = () => new Promise(() => {});

		h.client.applyLocalChange(edit("abc", "abcd"));
		expect(h.text()).toBe("abcd");
		await flush();

		expect(h.submissions).toHaveLength(1);
		const submission = h.submissions[0]!;
		expect(submission.seq).toBe(1);
		expect(submission.generation).toBe(0);
		expect(submission.revision).toBe(0);
		expect(h.client.hasLocalEdits()).toBe(true);

		h.client.pushRow(
			row(0, 1, submission.change, {
				clientId: submission.clientId,
				seq: submission.seq,
			}),
		);
		await flush();

		expect(h.client.hasLocalEdits()).toBe(false);
		expect(h.text()).toBe("abcd");
		expect(h.client.getPosition().revision).toBe(1);
		// The echo changes nothing displayed, so it must deliver NO notification at all -- in
		// particular not an empty array, which means "coarse reset, reload wholesale" and would make
		// the view rebuild its open editors, dropping focus and selection, after every acked keystroke.
		expect(h.remoteEvents).toEqual([]);
	});

	it("clears an accepted submission from the ack alone when its echo row never arrives", async () => {
		const h = await new TestHarness().started();
		h.submitResult = async () => ACCEPTED(1);

		h.client.applyLocalChange(edit("abc", "abcd"));
		await flush();

		// No row was ever delivered (materialized during a disconnect, so no replay carries it): the
		// backstop applies our own change at exactly the position the response named.
		expect(h.submissions).toHaveLength(1);
		expect(h.client.hasLocalEdits()).toBe(false);
		expect(h.text()).toBe("abcd");
		expect(h.client.getPosition()).toEqual({ generation: 0, revision: 1 });
		expect(h.remoteEvents).toEqual([]);

		// The next edit submits normally at the advanced stream position.
		h.submitResult = async () => ACCEPTED(2);
		h.client.applyLocalChange(edit("abcd", "abcde"));
		await flush();
		expect(h.submissions[1]!.revision).toBe(1);
		expect(h.submissions[1]!.seq).toBe(2);
		expect(h.text()).toBe("abcde");
	});

	it("holds the ack backstop until the stream reaches the position below it", async () => {
		const h = await new TestHarness().started();
		// The submission landed at revision 2 -- someone else's row 1 got there first.
		h.submitResult = async () => ACCEPTED(2);

		h.client.applyLocalChange(edit("abc", "abcd"));
		await flush();
		// Row 1 is still missing, so the backstop must NOT fire: applying our change at revision 1
		// would put it in front of a row the server ordered before it.
		expect(h.client.hasLocalEdits()).toBe(true);
		expect(h.client.getPosition().revision).toBe(0);

		h.client.pushRow(row(0, 1, edit("abc", "Zabc")));
		await flush();
		expect(h.client.hasLocalEdits()).toBe(false);
		expect(h.client.getPosition().revision).toBe(2);
		expect(h.text()).toBe("Zabcd");
	});

	it("composes every edit typed since the last ack into one submission", async () => {
		const h = await new TestHarness().started();
		let release: (() => void) | null = null;
		h.submitResult = () =>
			new Promise((resolve) => {
				release = () => resolve(ACCEPTED(1));
			});

		h.client.applyLocalChange(edit("abc", "abcd"));
		await flush();
		expect(h.submissions).toHaveLength(1);

		// Three more keystrokes while the first submission is out: they compose into ONE pending
		// buffer and ride a single later submit, so submissions land at ~RTT granularity.
		h.client.applyLocalChange(edit("abcd", "abcde"));
		h.client.applyLocalChange(edit("abcde", "abcdef"));
		h.client.applyLocalChange(edit("abcdef", "abcdefg"));
		await flush();
		expect(h.submissions).toHaveLength(1);
		expect(h.text()).toBe("abcdefg");

		release!();
		h.submitResult = async () => ACCEPTED(2);
		h.client.pushRow(
			row(0, 1, h.submissions[0]!.change, {
				clientId: h.submissions[0]!.clientId,
				seq: 1,
			}),
		);
		await flush();

		expect(h.submissions).toHaveLength(2);
		expect(h.submissions[1]!.seq).toBe(2);
		expect(h.submissions[1]!.revision).toBe(1);
		// One submission carrying all three keystrokes.
		expect(textOf(h.client.getContent())).toBe("abcdefg");
	});
});

describe("OtClient: rebasing", () => {
	it("transforms in-flight and pending edits over a remote row", async () => {
		const h = await new TestHarness().started();
		h.submitResult = () => new Promise(() => {});

		h.client.applyLocalChange(edit("abc", "Xabc")); // in flight
		await flush();
		h.client.applyLocalChange(edit("Xabc", "XabcP")); // pending behind it
		expect(h.submissions).toHaveLength(1);
		const local = h.submissions[0]!;

		// A remote row the server ordered FIRST: append "Y" to "abc".
		const remote = edit("abc", "abcY");
		h.remoteEvents.length = 0;
		h.client.pushRow(row(0, 1, remote));
		await flush();

		// Display is the doubly-transformed row on top of everything local.
		expect(h.text()).toBe("XabcYP");
		expect(h.remoteEvents).toHaveLength(1);
		expect(h.remoteEvents[0]!.map((event) => event.path)).toEqual([PATH]);

		// The server transforms the in-flight change over the row exactly as we just did, so its echo
		// is a display no-op.
		const serverSide = transformCodeChange(remote, local.change).b;
		h.remoteEvents.length = 0;
		h.client.pushRow(
			row(0, 2, serverSide, { clientId: local.clientId, seq: local.seq }),
		);
		await flush();
		expect(h.remoteEvents).toEqual([]);
		expect(h.text()).toBe("XabcYP");
	});

	it("stays silent on a remote row whose transformed form changes nothing displayed", async () => {
		const h = await new TestHarness().started();
		h.submitResult = () => new Promise(() => {});

		// Our own remove is in flight when another author's identical remove lands first.
		h.client.applyLocalChange([[PATH, { remove: true }]]);
		await flush();
		expect(h.submissions).toHaveLength(1);
		h.remoteEvents.length = 0;

		// remove vs remove: the earlier writer's side is dropped, so the row's doubly-transformed form
		// is empty. Deliver NOTHING -- especially not an empty (coarse) notification.
		h.client.pushRow(row(0, 1, [[PATH, { remove: true }]]));
		await flush();
		expect(h.remoteEvents).toEqual([]);
		expect(h.client.getContent().has(PATH)).toBe(false);
	});
});

describe("OtClient: the failure ladder", () => {
	it("retries a transient failure with a byte-identical payload, never re-based", async () => {
		const h = await new TestHarness().started();
		let attempts = 0;
		let resolveDone: () => void = () => {};
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		h.submitResult = async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient");
			resolveDone();
			return ACCEPTED(2);
		};

		h.client.applyLocalChange(edit("abc", "abcd"));
		await flush();
		expect(attempts).toBe(1);
		expect(h.dirty).toContain(true);

		// A remote row lands during the backoff, rebasing the in-flight CHANGE. The retry's WIRE
		// must be unaffected: the authority's dedupe digest covers the claimed generation and
		// revision as well as the change, so a retry that renumbered or re-based itself would be
		// read as different content under a used seq and rejected.
		h.client.pushRow(row(0, 1, edit("abc", "Zabc")));
		await flush();
		expect(h.client.getPosition().revision).toBe(1);

		await done;
		await flush();
		expect(attempts).toBe(2);
		expect(h.submissions).toHaveLength(2);
		expect(h.submissions[1]).toEqual(h.submissions[0]);
		expect(h.submissions[1]!.seq).toBe(1);
		expect(h.submissions[1]!.revision).toBe(0);
	}, 10_000);

	it("retries a `busy` rejection and keeps the local buffers", async () => {
		const h = await new TestHarness().started();
		let attempts = 0;
		h.submitResult = async () => {
			attempts += 1;
			return attempts === 1
				? {
						ok: false,
						code: "busy",
						message: "The room is changing too quickly.",
					}
				: ACCEPTED(1);
		};

		h.client.applyLocalChange(edit("abc", "abcd"));
		await flush(1500);

		expect(attempts).toBe(2);
		expect(h.submissions[1]).toEqual(h.submissions[0]);
		expect(h.discards).toBe(0);
		expect(h.text()).toBe("abcd");
	}, 10_000);

	it("publishes the unacknowledged-edits transition on the keystroke, and clears it on the ack", async () => {
		const h = await new TestHarness().started();
		expect(h.client.hasLocalEdits()).toBe(false);
		// The rebuild tail publishes `false` UNCONDITIONALLY rather than through the
		// transition guard, so a start -- or a reconnect that replaced a dirty client --
		// always tells the surface the truth. The gated form is silent here (guard and
		// answer are both `false`), which is exactly how it wedged Commit forever on a
		// reconnect; `use-collab-doc.test.ts` holds the session-level proof.
		expect(h.unacknowledged).toEqual([false]);

		// SYNCHRONOUS WITH THE KEYSTROKE, before anything is scheduled or sent. A surface that
		// gates Commit on this must never render a live Commit button over a buffer the server has
		// not agreed to -- committing from one has no stream position to re-ground the room with.
		h.client.applyLocalChange(edit("abc", "abcd"));
		expect(h.unacknowledged).toEqual([false, true]);
		// TRANSITIONS ONLY: a second keystroke changes nothing about the answer, and republishing
		// it would flicker the button once per character.
		h.client.applyLocalChange(edit("abcd", "abcde"));
		expect(h.unacknowledged).toEqual([false, true]);

		// The acknowledgement clears it, which is the whole reason waiting on it is not a livelock:
		// everything typed since the last one rode ONE composed submission.
		await flush();
		expect(h.submissions).toHaveLength(1);
		expect(h.client.hasLocalEdits()).toBe(false);
		expect(h.unacknowledged).toEqual([false, true, false]);
	});

	it("surfaces `capacity` as a blocked state that holds the edits and clears on acceptance", async () => {
		const h = await new TestHarness().started();
		let attempts = 0;
		h.submitResult = async () => {
			attempts += 1;
			return attempts === 1
				? {
						ok: false,
						code: "capacity",
						message: CAPACITY_MESSAGE,
					}
				: ACCEPTED(1);
		};

		h.client.applyLocalChange(edit("abc", "abcd"));
		await flush();
		// Not a silent stall: the state reaches the surface, and nothing is discarded. The message
		// does NOT tell the user to commit -- see `CAPACITY_MESSAGE`.
		expect(h.client.getBlocked()).toEqual({
			code: "capacity",
			message: CAPACITY_MESSAGE,
		});
		// `.at(-1)`, not `[0]`: the rebuild tail republishes all three recovery signals
		// unconditionally, so a started client has already pushed one `null`. Asserting a
		// fixed index here would break the moment another unconditional republish is added,
		// which is exactly the kind of edit that must stay easy to make.
		expect(h.blocked.at(-1)?.code).toBe("capacity");
		expect(h.discards).toBe(0);
		expect(h.client.hasLocalEdits()).toBe(true);

		// The window is reclaimed again; the identical retry is accepted and the block lifts.
		await flush(1500);
		expect(attempts).toBe(2);
		expect(h.client.getBlocked()).toBeNull();
		expect(h.blocked.at(-1)).toBeNull();
	}, 10_000);

	it("discards local edits on a hard rejection and rebuilds under a fresh clientId", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const h = await new TestHarness().started();
			const firstClientId = h.client.getClientId();
			h.submitResult = async () => ({
				ok: false,
				code: "stream-gone",
				message: "The room's change stream moved on.",
			});

			h.client.applyLocalChange(edit("abc", "abcd"));
			await flush();

			expect(h.discards).toBe(1);
			expect(h.client.hasLocalEdits()).toBe(false);
			// Rebuilt from a fresh base fetch: local work is gone, and so is its session.
			expect(h.baseFetches).toBe(2);
			expect(h.text()).toBe("abc");
			expect(h.client.getClientId()).not.toBe(firstClientId);
			// Coarse notification: open editors must reload wholesale.
			expect(h.remoteEvents).toEqual([[]]);

			// The next edit starts a fresh client session at seq 1.
			h.submitResult = async () => ACCEPTED(1);
			h.client.applyLocalChange(edit("abc", "abcX"));
			await flush();
			expect(h.submissions).toHaveLength(2);
			expect(h.submissions[1]!.clientId).not.toBe(h.submissions[0]!.clientId);
			expect(h.submissions[1]!.seq).toBe(1);
		} finally {
			errors.mockRestore();
		}
	});

	it("clears BOTH recovery signals on a discarding rebuild, so neither banner sticks", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const h = await new TestHarness().started();
			h.submitResult = async () => ({
				ok: false,
				code: "stream-gone",
				message: "The room's change stream moved on.",
			});

			h.client.applyLocalChange(edit("abc", "abcd"));
			expect(h.unacknowledged.at(-1)).toBe(true);

			await flush();

			// The rebuild threw the edits away, so nothing is unacknowledged and nothing is
			// unsynced. BOTH must be republished, because they drive the same recovery affordance
			// from two directions -- a stale `dirty` leaves an "unsynced edits" banner over a
			// document that has none, and a stale `unacknowledged` leaves Commit disabled.
			//
			// THIS TEST CANNOT SEE THE WEDGE THAT MADE THE REBUILD TAIL UNCONDITIONAL, and it must
			// not claim to: the harness reuses ONE client, whose guard is still `true` here, so the
			// gated form publishes correctly too. The wedge needs the client to be REPLACED while
			// the session survives -- `use-collab-doc.test.ts`, "clears `unacknowledged` when a
			// reconnect replaces a client that held edits", is the test that fails without it.
			expect(h.discards).toBe(1);
			expect(h.client.hasLocalEdits()).toBe(false);
			expect(h.unacknowledged.at(-1)).toBe(false);
			expect(h.dirty.at(-1)).toBe(false);
		} finally {
			errors.mockRestore();
		}
	});

	it("discards and rebuilds when a row from a later generation arrives", async () => {
		const h = await new TestHarness().started();
		h.submitResult = () => new Promise(() => {});
		h.client.applyLocalChange(edit("abc", "abcd"));
		await flush();
		expect(h.client.hasLocalEdits()).toBe(true);

		// The single-generation stub: a generation change is a boundary this client cannot bridge.
		h.base = { position: { generation: 1, revision: 0 }, text: "fresh" };
		h.client.pushRow(row(1, 1, [[PATH, { set: "fresh!" }]]));
		await flush();

		expect(h.discards).toBe(1);
		expect(h.client.hasLocalEdits()).toBe(false);
		expect(h.client.getPosition().generation).toBe(1);
		// Rebuilt at the new generation, then the held row drained on top of it.
		expect(h.text()).toBe("fresh!");
	});

	it("reports a keystroke typed WHILE the rebuild's base fetch was in flight", async () => {
		const h = await new TestHarness().started();

		// This rebuild BEGINS WITH CLEAN BUFFERS -- it is triggered by a foreign-generation row,
		// not by a rejected submission of the user's own -- so there is nothing for a pre-fetch
		// read to see.
		let releaseBase: (() => void) | undefined;
		h.delegate.fetchBase = () =>
			new Promise<OtBaseSnapshot>((resolve) => {
				releaseBase = () =>
					resolve({
						position: { generation: 1, revision: 0 },
						content: doc("fresh"),
					});
			});
		expect(h.client.hasLocalEdits()).toBe(false);
		h.client.pushRow(row(1, 1, [[PATH, { set: "fresh!" }]]));
		await flush();

		// The keystroke lands DURING the fetch. `applyLocalChange` is synchronous and deliberately
		// unqueued, so it reaches `#pending` while the rebuild is parked on its await -- and the
		// synchronous tail is about to throw it away. Deciding "was anything lost?" BEFORE the
		// fetch, as the deleted `#discardLocalAndRebuild` wrapper did, reads `false` here and
		// discards this character in complete silence. THAT ORDERING IS WHAT THIS TEST PINS: the
		// read has to sit in the same await-free span as the write that clears the buffers.
		h.client.applyLocalChange(edit("abc", "abcX"));
		expect(h.client.hasLocalEdits()).toBe(true);

		const release = releaseBase;
		if (release === undefined) throw new Error("the base fetch never started");
		release();
		await flush();

		expect(h.text()).toBe("fresh!");
		expect(h.client.hasLocalEdits()).toBe(false);
		expect(h.discards).toBe(1);
	});

	it("publishes the rebuilt content BEFORE it reports the discard", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const h = await new TestHarness().started();
			// AN ORDERING DISCRIMINATOR, not a supported delegate: `onRemoteChange` may not throw.
			// It is the only way to observe which of the two calls happens first, and the order is
			// load-bearing for the surface's copy -- the warning says "the document below is what
			// every connected editor now sees", which is a lie about a document the editor never
			// received. So the discard must be the LAST thing the rebuild's tail does.
			h.delegate.onRemoteChange = (events) => {
				if (events.length === 0) throw new Error("editor reload failed");
				h.remoteEvents.push(events);
			};
			h.submitResult = async () => ({
				ok: false,
				code: "stream-gone",
				message: "The room's change stream moved on.",
			});

			h.client.applyLocalChange(edit("abc", "abcd"));
			await flush();

			// The coarse publish never completed, so no discard was claimed: the failure is
			// contained as exactly one fatal error instead. Reporting first would have raised the
			// warning over a document still showing the text it says was discarded.
			expect(h.fatal).toBeInstanceOf(Error);
			expect(h.discards).toBe(0);
		} finally {
			errors.mockRestore();
		}
	});

	it("goes fatal when the base cannot be fetched", async () => {
		const h = new TestHarness();
		const failure = new Error("no base");
		h.delegate.fetchBase = async () => {
			throw failure;
		};
		h.client.start();
		await flush();

		expect(h.client.isReady()).toBe(false);
		expect(h.fatal).toBe(failure);
	});
});

describe("OtClient against a real OtAuthority", () => {
	it("converges two clients editing concurrently", async () => {
		const server = await serverHarness("hello\n");
		const a = server.attach(ADA).client;
		const b = server.attach(GRACE).client;
		a.start();
		b.start();
		await flush();

		// Round one: concurrent edits at different ends of the line, submitted before either has seen
		// the other's.
		a.applyLocalChange(edit("hello\n", "hello world\n"));
		b.applyLocalChange(edit("hello\n", "HELLO\n"));
		await settle([a, b]);

		const converged = textOf(a.getContent());
		expect(textOf(b.getContent())).toBe(converged);
		expect(textOf(await server.authority.content())).toBe(converged);

		// Round two: each client edits its own (now identical) display, again concurrently.
		a.applyLocalChange(edit(converged, `${converged}A`));
		b.applyLocalChange(edit(converged, `B${converged}`));
		await settle([a, b]);

		const final = textOf(a.getContent());
		expect(textOf(b.getContent())).toBe(final);
		expect(textOf(await server.authority.content())).toBe(final);
		expect(final).toContain("world");
		expect(final.startsWith("B")).toBe(true);
		expect(final.endsWith("A\n") || final.endsWith("A")).toBe(true);
		expect((await server.authority.head()).revision).toBe(4);
	});

	it("dedupes a retried submission on the server and lands it exactly once", async () => {
		const server = await serverHarness("abc");
		// No subscription: the echo row never reaches this client, which is the case the retry has to
		// survive -- the first attempt was in fact accepted and only its response was lost.
		const { client, delegate } = server.attach(ADA, { subscribed: false });
		const sent: CodeChangeSubmission[] = [];
		let attempts = 0;
		const realSubmit = delegate.submit.bind(delegate);
		delegate.submit = async (submission) => {
			sent.push(submission);
			attempts += 1;
			const result = await realSubmit(submission);
			if (attempts === 1) throw new Error("transient");
			return result;
		};

		client.start();
		await flush();
		client.applyLocalChange(edit("abc", "abcd"));
		await flush(1500);

		expect(attempts).toBe(2);
		// Byte-identical resend, which is what lets the digest recognize it.
		expect(sent[1]).toEqual(sent[0]);
		// Accepted ONCE: the second attempt was recognized as the same submission, not applied again.
		expect((await server.authority.head()).revision).toBe(1);
		expect(server.broadcasts).toHaveLength(1);
		expect(textOf(await server.authority.content())).toBe("abcd");
		// And the lost-echo backstop folded our own change in at the position the ack named.
		expect(client.hasLocalEdits()).toBe(false);
		expect(client.getPosition()).toEqual({ generation: 0, revision: 1 });
		expect(textOf(client.getContent())).toBe("abcd");
	}, 10_000);

	it("converges a client that reconnects and replays the rows it missed", async () => {
		const server = await serverHarness("abc");
		const a = server.attach(ADA).client;
		a.start();
		await flush();

		// A second, disconnected participant submits straight to the authority.
		expect(
			await server.authority.submit(
				{
					generation: 0,
					revision: 0,
					clientId: "offline-peer",
					seq: 1,
					change: edit("abc", "abcZ"),
				},
				GRACE,
			),
		).toMatchObject({ ok: true, revision: 1 });
		await flush();
		expect(textOf(a.getContent())).toBe("abcZ");

		// The reconnect replay hands back everything from position 0 -- including the row already
		// applied. `selectUnappliedRows` drops it; nothing is applied twice.
		const replay = await server.authority.rowsSince({
			generation: 0,
			revision: 0,
		});
		expect(replay).not.toBeNull();
		a.pushRows(replay!);
		await flush();
		expect(textOf(a.getContent())).toBe("abcZ");
		expect(a.getPosition().revision).toBe(1);
	});
});

// =======================================================================================

describe("OtClient: failure containment", () => {
	it("routes a row it cannot apply to onFatalError instead of an unhandled rejection", async () => {
		const h = await new TestHarness().started();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			// A row whose edit claims a document length the client does not have. Only a corrupt
			// stream or a handshake that stamped content with the wrong revision can produce one --
			// which is exactly why it must surface as a fatal error the surface can reconnect from,
			// not as a rejection nobody is listening for.
			h.client.pushRow(row(0, 1, [[PATH, { edit: [10] }]]));
			await flush();
			await flush();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(h.fatal).toBeInstanceOf(Error);
		expect(unhandled).toEqual([]);
		expect(h.client.isReady()).toBe(false);
	});

	it("keeps the task queue usable when onFatalError itself throws", async () => {
		const h = new TestHarness();
		const delegate: OtClientDelegate = {
			...h.delegate,
			onFatalError: (error) => {
				h.fatal = error;
				throw new Error("the surface's own handler failed");
			},
		};
		const client = new OtClient(delegate);
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			client.start();
			await flush();
			client.pushRow(row(0, 1, [[PATH, { edit: [10] }]]));
			await flush();
			// The queue is a chained promise: a rejection left on it would propagate into every task
			// enqueued afterwards, so one throwing handler would produce an unbounded run of
			// unhandled rejections rather than one.
			client.pushRow(row(0, 1, edit("abc", "abcd")));
			await flush();
			await flush();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(h.fatal).toBeInstanceOf(Error);
		expect(unhandled).toEqual([]);
	});
});
