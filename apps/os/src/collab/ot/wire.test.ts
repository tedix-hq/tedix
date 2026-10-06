// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import type { CollabVerifiedIdentity } from "../presence";
import {
	type CodeChangeRow,
	parseCodeChangeRow,
	parseCodeChangeSubmission,
	selectUnappliedRows,
} from "./wire";

const author: CollabVerifiedIdentity = {
	key: "opaque-ada",
	displayName: "Ada",
	kind: "human",
	role: "owner",
	verified: true,
};

function row(revision: number, generation = 0): CodeChangeRow {
	return {
		generation,
		revision,
		timestampMs: 1_000 + revision,
		author,
		change: [["content", { set: `v${revision}` }]],
	};
}

describe("parseCodeChangeSubmission change payload", () => {
	const envelope = { generation: 0, revision: 0, clientId: "cli-a", seq: 1 };
	it("accepts the three file-change variants and an empty change", () => {
		expect(
			parseCodeChangeSubmission({ ...envelope, change: [] })?.change,
		).toEqual([]);
		expect(
			parseCodeChangeSubmission({
				...envelope,
				change: [
					["a.txt", { edit: [2, [2, "x"], 3] }],
					["b.txt", { set: "hello" }],
					["c.txt", { remove: true }],
				],
			})?.change,
		).toHaveLength(3);
	});

	it("rejects anything that is not structurally a change", () => {
		expect(parseCodeChangeSubmission({ ...envelope, change: null })).toBeNull();
		expect(
			parseCodeChangeSubmission({
				...envelope,
				change: { "a.txt": { set: "x" } },
			}),
		).toBeNull();
		expect(
			parseCodeChangeSubmission({ ...envelope, change: [["a.txt"]] }),
		).toBeNull();
		expect(
			parseCodeChangeSubmission({ ...envelope, change: [[1, { set: "x" }]] }),
		).toBeNull();
		expect(
			parseCodeChangeSubmission({ ...envelope, change: [["a.txt", {}]] }),
		).toBeNull();
		expect(
			parseCodeChangeSubmission({
				...envelope,
				change: [["a.txt", { set: 5 }]],
			}),
		).toBeNull();
		expect(
			parseCodeChangeSubmission({
				...envelope,
				change: [["a.txt", { remove: false }]],
			}),
		).toBeNull();
		expect(
			parseCodeChangeSubmission({
				...envelope,
				change: [["a.txt", { edit: "nope" }]],
			}),
		).toBeNull();
		expect(
			parseCodeChangeSubmission({
				...envelope,
				change: [["a.txt", { edit: [{}] }]],
			}),
		).toBeNull();
		expect(
			parseCodeChangeSubmission({
				...envelope,
				change: [["a.txt", { edit: [[1, 2]] }]],
			}),
		).toBeNull();
	});

	it("rejects a variant key the validator would not count as a key", () => {
		// The decoder and `validateCodeChangeSchema` must agree on what a key IS. The validator
		// counts variants with `Object.keys` (own-only) while `applyCodeChange` and
		// `transformCodeChange` DISPATCH with `in` (prototype-aware), so an own `set` under a
		// prototype carrying `edit` satisfies the one-variant rule and is then read as a `set` by
		// one replica and an `edit` by the other -- the divergence that rule exists to prevent.
		const inherited: { set: string } = Object.create({ edit: [1] });
		inherited.set = "x";
		expect(Object.keys(inherited)).toEqual(["set"]); // what the validator sees
		expect("edit" in inherited).toBe(true); // what the transform sees
		expect(
			parseCodeChangeSubmission({
				...envelope,
				change: [["a.txt", inherited]],
			}),
		).toBeNull();

		// An accessor is refused WITHOUT being invoked: it may throw, and it may answer one thing
		// to the validating read and another to the applying read.
		let reads = 0;
		const accessor = {
			get set(): string {
				reads += 1;
				throw new Error("variant getter must never be invoked");
			},
		};
		expect(
			parseCodeChangeSubmission({ ...envelope, change: [["a.txt", accessor]] }),
		).toBeNull();
		expect(reads).toBe(0);
	});

	it("never throws, whatever a non-JSON producer hands it", () => {
		// `JSON.parse` cannot build this, but `submit` is reachable from in-process producers, and
		// this module's contract is that a bad frame is DROPPED rather than propagated as an
		// exception that would tear the room down.
		const exploding: unknown[] = [];
		Object.defineProperty(exploding, Symbol.iterator, {
			value: () => {
				throw new Error("hostile iterator");
			},
		});

		expect(
			parseCodeChangeSubmission({
				generation: 0,
				revision: 0,
				clientId: "cli-a",
				seq: 1,
				change: exploding,
			}),
		).toBeNull();
		expect(parseCodeChangeRow({ ...row(1), change: exploding })).toBeNull();
	});

	it("passes a two-variant file change through intact", () => {
		// The decoder must NOT pick a first match and rebuild: `validateCodeChangeSchema` is the only
		// thing that rejects a two-variant change, and it can only do so if both keys survive here.
		const decoded = parseCodeChangeSubmission({
			...envelope,
			change: [["a.txt", { set: "x", remove: true }]],
		});
		expect(decoded).not.toBeNull();
		expect(Object.keys(decoded!.change[0]![1])).toEqual(["set", "remove"]);
	});
});

describe("parseCodeChangeSubmission", () => {
	const valid = {
		generation: 0,
		revision: 3,
		clientId: "cli-a",
		seq: 1,
		change: [["content", { set: "x" }]],
	};

	it("accepts a well-formed envelope", () => {
		expect(parseCodeChangeSubmission(valid)).toEqual(valid);
	});

	it("rejects malformed envelopes", () => {
		expect(parseCodeChangeSubmission({ ...valid, seq: 0 })).toBeNull();
		expect(parseCodeChangeSubmission({ ...valid, seq: 1.5 })).toBeNull();
		expect(parseCodeChangeSubmission({ ...valid, revision: -1 })).toBeNull();
		expect(parseCodeChangeSubmission({ ...valid, generation: "0" })).toBeNull();
		expect(parseCodeChangeSubmission({ ...valid, clientId: "" })).toBeNull();
		expect(
			parseCodeChangeSubmission({ ...valid, clientId: "has spaces" }),
		).toBeNull();
		expect(parseCodeChangeSubmission({ ...valid, change: {} })).toBeNull();
		expect(parseCodeChangeSubmission("nope")).toBeNull();
	});

	it("drops unknown envelope fields rather than forwarding them", () => {
		const decoded = parseCodeChangeSubmission({ ...valid, author: "mallory" });
		expect(decoded).not.toBeNull();
		expect("author" in decoded!).toBe(false);
	});
});

describe("parseCodeChangeRow", () => {
	it("round-trips a row through JSON, the way DO storage stores it", () => {
		const stored = JSON.parse(JSON.stringify(row(2)));
		expect(parseCodeChangeRow(stored)).toEqual(row(2));
	});

	it("keeps the submission echo when present and omits it otherwise", () => {
		const withEcho = { ...row(1), submission: { clientId: "cli", seq: 4 } };
		expect(parseCodeChangeRow(withEcho)?.submission).toEqual({
			clientId: "cli",
			seq: 4,
		});
		expect("submission" in parseCodeChangeRow(row(1))!).toBe(false);
	});

	it("rejects a row with no verified author, revision 0, or a bad echo", () => {
		expect(parseCodeChangeRow({ ...row(1), author: { key: "x" } })).toBeNull();
		expect(
			parseCodeChangeRow({ ...row(1), author: { ...author, verified: false } }),
		).toBeNull();
		expect(parseCodeChangeRow({ ...row(1), revision: 0 })).toBeNull();
		expect(
			parseCodeChangeRow({
				...row(1),
				submission: { clientId: "cli", seq: 0 },
			}),
		).toBeNull();
	});
});

describe("selectUnappliedRows", () => {
	it("deduplicates rows a reconnecting subscriber has already applied", () => {
		const applied = { generation: 0, revision: 2 };
		expect(
			selectUnappliedRows(applied, [row(1), row(2), row(3), row(4)]),
		).toEqual([row(3), row(4)]);
		// The whole replay is already applied: nothing to do, and no error.
		expect(selectUnappliedRows(applied, [row(1), row(2)])).toEqual([]);
	});

	it("refuses a gap rather than mistransforming across it", () => {
		expect(
			selectUnappliedRows({ generation: 0, revision: 1 }, [row(3)]),
		).toBeNull();
	});

	it("refuses rows from another generation", () => {
		expect(
			selectUnappliedRows({ generation: 0, revision: 0 }, [row(1, 1)]),
		).toBeNull();
	});
});
