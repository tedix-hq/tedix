// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import {
	COLLAB_DOC_PATH,
	contentToFiles,
	encodeFrame,
	isOversizedMessage,
	MAX_MESSAGE_BYTES,
	parseClientFrame,
	parseServerFrame,
} from "./protocol";
import type { CodeChangeRow, CodeChangeSubmission } from "./ot/wire";
import type { CollabVerifiedIdentity } from "./presence";

const identity: CollabVerifiedIdentity = {
	displayName: "Ada",
	key: "opaque-ada",
	kind: "human",
	role: "owner",
	verified: true,
};

/** A canonical revision as a client offers it: the stamp plus that revision's content. */
const offer = {
	revision: 4,
	revisionId: "0f5f1c5e-7d2f-4a6a-9f3b-2f1b6cbb1f77",
	files: [[COLLAB_DOC_PATH, "{}"]] as [string, string][],
};

const submission: CodeChangeSubmission = {
	generation: 0,
	revision: 3,
	clientId: "client-a",
	seq: 1,
	change: [[COLLAB_DOC_PATH, { edit: [2, [1, "X"], 4] }]],
};

const row: CodeChangeRow = {
	generation: 0,
	revision: 4,
	timestampMs: 1_700_000_000_000,
	author: identity,
	change: [[COLLAB_DOC_PATH, { edit: [2, [1, "X"], 4] }]],
	submission: { clientId: "client-a", seq: 1 },
};

describe("collab client frames", () => {
	it("round-trips every client frame", () => {
		expect(parseClientFrame(encodeFrame({ t: "base", id: 1 }))).toEqual({
			t: "base",
			id: 1,
		});
		expect(
			parseClientFrame(encodeFrame({ t: "base", id: 2, seed: offer })),
		).toEqual({ t: "base", id: 2, seed: offer });
		expect(
			parseClientFrame(encodeFrame({ t: "canonical", id: 5, offer })),
		).toEqual({ t: "canonical", id: 5, offer });
		// `force` is a deliberate user action, so only an explicit `true` is one: anything else
		// decodes as an ordinary offer the server may still refuse.
		expect(
			parseClientFrame(
				encodeFrame({ t: "canonical", id: 6, offer, force: true }),
			),
		).toEqual({ t: "canonical", id: 6, offer, force: true });
		expect(
			parseClientFrame(
				JSON.stringify({ t: "canonical", id: 7, offer, force: "yes" }),
			),
		).toEqual({ t: "canonical", id: 7, offer });
		// A grounding claim carries the position its content came from; the room
		// validates it against the stream, this decoder only establishes shape.
		expect(
			parseClientFrame(
				encodeFrame({
					t: "ground",
					id: 8,
					offer,
					at: { generation: 0, revision: 4 },
				}),
			),
		).toEqual({
			t: "ground",
			id: 8,
			offer,
			at: { generation: 0, revision: 4 },
		});
		expect(
			parseClientFrame(encodeFrame({ t: "submit", id: 3, submission })),
		).toEqual({ t: "submit", id: 3, submission });
		expect(
			parseClientFrame(
				encodeFrame({
					t: "presence",
					state: { location: { surface: "canvas" } },
				}),
			),
		).toEqual({ t: "presence", state: { location: { surface: "canvas" } } });
	});

	it("drops malformed frames instead of throwing", () => {
		for (const data of [
			"not json",
			"[]",
			"null",
			JSON.stringify({ t: "unknown", id: 1 }),
			JSON.stringify({ t: "base" }),
			JSON.stringify({ t: "base", id: -1 }),
			JSON.stringify({ t: "base", id: 1, seed: { ...offer, files: [["a"]] } }),
			// A seed with no grounding stamp is exactly the state that let a commit pin its
			// compare-and-swap to a revision the room had never seen.
			JSON.stringify({ t: "base", id: 1, seed: { files: offer.files } }),
			JSON.stringify({ t: "canonical", id: 1 }),
			JSON.stringify({ t: "canonical", id: 1, offer: { revision: 1 } }),
			// A grounding claim with no position claims nothing checkable.
			JSON.stringify({ t: "ground", id: 1, offer }),
			JSON.stringify({ t: "ground", id: 1, offer, at: { revision: 4 } }),
			JSON.stringify({
				t: "ground",
				id: 1,
				offer,
				at: { generation: 0, revision: -1 },
			}),
			JSON.stringify({
				t: "ground",
				id: 1,
				offer: { files: offer.files },
				at: { generation: 0, revision: 4 },
			}),
			JSON.stringify({ t: "submit", id: 1 }),
			// A submission whose change is not decodable is refused here, before it
			// can ever reach a transform.
			JSON.stringify({
				t: "submit",
				id: 1,
				submission: { ...submission, change: [[COLLAB_DOC_PATH, {}]] },
			}),
			// seq is 1-based; 0 is not a session position.
			JSON.stringify({
				t: "submit",
				id: 1,
				submission: { ...submission, seq: 0 },
			}),
		]) {
			expect(parseClientFrame(data)).toBeNull();
		}
	});

	it("passes the presence payload through untouched, sanitization being the room's", () => {
		const frame = parseClientFrame(
			encodeFrame({
				t: "presence",
				state: { user: { spoofed: true }, token: "secret" },
			}),
		);
		// The decoder establishes the ENVELOPE only; `sanitizeCollabPresenceState`
		// owns the allowlist, and duplicating it here would put the trust boundary
		// in two places.
		expect(frame).toEqual({
			t: "presence",
			state: { user: { spoofed: true }, token: "secret" },
		});
	});
});

describe("collab server frames", () => {
	it("round-trips every server frame", () => {
		expect(parseServerFrame(encodeFrame({ t: "hello", peerId: 42 }))).toEqual({
			t: "hello",
			peerId: 42,
		});
		expect(
			parseServerFrame(
				encodeFrame({
					t: "base",
					id: 1,
					generation: 0,
					revision: 7,
					files: contentToFiles(new Map([[COLLAB_DOC_PATH, "hello"]])),
					canonical: { revision: 4, revisionId: offer.revisionId },
				}),
			),
		).toEqual({
			t: "base",
			id: 1,
			generation: 0,
			revision: 7,
			files: [[COLLAB_DOC_PATH, "hello"]],
			canonical: { revision: 4, revisionId: offer.revisionId },
		});
		// A document with no committed revision yet: `revisionId` is null, `revision` 0.
		expect(
			parseServerFrame(
				encodeFrame({
					t: "canonicalResult",
					id: 2,
					outcome: "edited",
					canonical: { revision: 0, revisionId: null },
				}),
			),
		).toEqual({
			t: "canonicalResult",
			id: 2,
			outcome: "edited",
			canonical: { revision: 0, revisionId: null },
		});
		expect(
			parseServerFrame(
				encodeFrame({
					t: "canonical",
					canonical: { revision: 4, revisionId: offer.revisionId },
				}),
			),
		).toEqual({
			t: "canonical",
			canonical: { revision: 4, revisionId: offer.revisionId },
		});
		expect(parseServerFrame(encodeFrame({ t: "row", row }))).toEqual({
			t: "row",
			row,
		});
		expect(
			parseServerFrame(
				encodeFrame({
					t: "result",
					id: 2,
					result: { ok: true, duplicate: false, generation: 0, revision: 8 },
				}),
			),
		).toEqual({
			t: "result",
			id: 2,
			result: { ok: true, duplicate: false, generation: 0, revision: 8 },
		});
		expect(
			parseServerFrame(
				encodeFrame({
					t: "result",
					id: 3,
					result: { ok: false, code: "stream-gone", message: "rebuild" },
				}),
			),
		).toEqual({
			t: "result",
			id: 3,
			result: { ok: false, code: "stream-gone", message: "rebuild" },
		});
		expect(
			parseServerFrame(encodeFrame({ t: "presence", peers: [[1, { a: 1 }]] })),
		).toEqual({ t: "presence", peers: [[1, { a: 1 }]] });
		expect(
			parseServerFrame(encodeFrame({ t: "error", id: 4, message: "gone" })),
		).toEqual({ t: "error", id: 4, message: "gone" });
	});

	it("drops a row whose author is not a verified identity", () => {
		expect(
			parseServerFrame(
				encodeFrame({
					t: "row",
					row: { ...row, author: { ...identity, verified: false } },
				} as never),
			),
		).toBeNull();
	});

	it("drops a base frame that does not say which canonical revision it is", () => {
		// Without the stamp the client has nothing to pin a commit's compare-and-swap to, and
		// falling back to whatever the canonical store reports at commit time is the exact silent
		// overwrite the stamp exists to prevent. Drop the frame rather than guess.
		expect(
			parseServerFrame(
				JSON.stringify({
					t: "base",
					id: 1,
					generation: 0,
					revision: 7,
					files: [[COLLAB_DOC_PATH, "hello"]],
				}),
			),
		).toBeNull();
	});

	it("drops a canonical outcome the authority cannot have produced", () => {
		expect(
			parseServerFrame(
				JSON.stringify({
					t: "canonicalResult",
					id: 1,
					outcome: "invented",
					canonical: { revision: 1, revisionId: null },
				}),
			),
		).toBeNull();
	});

	it("drops a rejection carrying an unknown code", () => {
		expect(
			parseServerFrame(
				JSON.stringify({
					t: "result",
					id: 1,
					result: { ok: false, code: "invented", message: "x" },
				}),
			),
		).toBeNull();
	});
});

describe("frame size", () => {
	it("flags only payloads beyond the 1 MiB transport cap", () => {
		expect(isOversizedMessage(MAX_MESSAGE_BYTES)).toBe(false);
		expect(isOversizedMessage(MAX_MESSAGE_BYTES + 1)).toBe(true);
	});
});
