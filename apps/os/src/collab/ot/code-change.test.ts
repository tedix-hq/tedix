// @vitest-environment node
// Adapted and modified from Cloudflare OS under Apache-2.0; see THIRD_PARTY_NOTICES.md.
import { deserialize, serialize } from "capnweb";
import { describe, expect, it } from "vite-plus/test";
import {
	applyCodeChange,
	changedPaths,
	type CodeChange,
	type CodeContent,
	composeCodeChange,
	diffFiles,
	type FileChange,
	MAX_CODE_CHANGE_SIZE,
	MAX_FILE_PATH_LENGTH,
	MAX_FILE_TEXT_LENGTH,
	type TextChange,
	transformCodeChange,
	validateCodeChangeContent,
	validateCodeChangeSchema,
} from "./code-change";

// The fuzz harnesses deliberately build TextChanges by hand (rather than importing
// @codemirror/state, which is module-private to code-change.ts): sections tile the whole original
// text, a bare number retains, and [deletedLen, ...insertedLines] replaces.

// =======================================================================================
// Deterministic fuzz helpers

// mulberry32: tiny deterministic PRNG so failures reproduce.
function makeRng(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomInt(rng: () => number, max: number): number {
	return Math.floor(rng() * max);
}

function pick<T>(rng: () => number, items: readonly T[]): T {
	return items[randomInt(rng, items.length)]!;
}

// Deliberately astral- and separator-heavy: surrogate pairs (😀, 🧠), an emoji-with-modifier
// (two code points, four UTF-16 units), combining text, and every line-separator exotic the
// codebase promises to round-trip (bare \r, U+2028, U+2029, NUL).
const ALPHABET = [
	"a",
	"b",
	"x",
	" ",
	"é",
	"😀",
	"🧠",
	"👍🏽",
	"\n",
	"\n",
	"\r",
	"\r\n",
	"\u2028",
	"\u2029",
	"\0",
];

function randomText(rng: () => number, maxPieces: number): string {
	let out = "";
	for (let i = 0, n = randomInt(rng, maxPieces + 1); i < n; i++) {
		out += pick(rng, ALPHABET);
	}
	return out;
}

// All positions in `text` that don't split a surrogate pair.
function codePointBoundaries(text: string): number[] {
	const out = [0];
	for (let i = 1; i <= text.length; i++) {
		const prev = text.charCodeAt(i - 1);
		const cur = i < text.length ? text.charCodeAt(i) : 0;
		if (prev >= 0xd800 && prev < 0xdc00 && cur >= 0xdc00 && cur < 0xe000) {
			continue;
		}
		out.push(i);
	}
	return out;
}

// Builds the compact-JSON TextChange for a sorted list of non-overlapping replacements.
function makeEdit(
	baseLength: number,
	specs: { from: number; to: number; insert: string }[],
): TextChange {
	const change: TextChange = [];
	let pos = 0;
	for (const { from, to, insert } of specs) {
		if (from > pos) change.push(from - pos);
		change.push(
			insert === "" ? [to - from] : [to - from, ...insert.split("\n")],
		);
		pos = to;
	}
	if (pos < baseLength) change.push(baseLength - pos);
	return change;
}

// A random valid edit against `base`: a few non-overlapping replacements on code-point
// boundaries, each possibly a pure insert, deletion, or replacement.
function randomEdit(rng: () => number, base: string): TextChange {
	const bounds = codePointBoundaries(base);
	const specs: { from: number; to: number; insert: string }[] = [];
	let i = 0;
	while (i < bounds.length) {
		if (rng() < 0.4) {
			const from = bounds[i]!;
			const j = Math.min(bounds.length - 1, i + randomInt(rng, 4));
			const to = bounds[j]!;
			const insert = rng() < 0.8 ? randomText(rng, 4) : "";
			if (from !== to || insert !== "") specs.push({ from, to, insert });
			i = j + 1;
		} else {
			i++;
		}
	}
	return makeEdit(base.length, specs);
}

function randomContent(rng: () => number): CodeContent {
	const out: CodeContent = new Map();
	for (let j = 0, m = randomInt(rng, 4); j < m; j++) {
		out.set(`f${j}.txt`, randomText(rng, 12));
	}
	return out;
}

// A random valid change against `content`: mixes edits, sets (of existing and new files), and
// removes (of existing and absent files).
function randomCodeChange(rng: () => number, base: CodeContent): CodeChange {
	const files = new Map<string, FileChange>();
	for (const [path, text] of base) {
		const r = rng();
		if (r < 0.35) continue;
		else if (r < 0.65) files.set(path, { edit: randomEdit(rng, text) });
		else if (r < 0.85) files.set(path, { set: randomText(rng, 8) });
		else files.set(path, { remove: true });
	}
	if (rng() < 0.3) {
		files.set(`new${randomInt(rng, 2)}.txt`, { set: randomText(rng, 8) });
	}
	if (rng() < 0.1) files.set("ghost.txt", { remove: true });
	return [...files];
}

// Content as a plain object for deep comparison.
function toPlain(value: CodeContent): Record<string, string> {
	return Object.fromEntries(value);
}

function content(files: Record<string, string>): CodeContent {
	return new Map(Object.entries(files));
}

// =======================================================================================
// Fuzz: the OT laws

describe("transformCodeChange convergence", () => {
	// The load-bearing law, at the widest sample this suite runs: for concurrent A and B,
	// `A.compose(B.map(A))` and `B.compose(A.map(B, true))` produce the same document. Both the
	// composed form and the stepwise form are asserted, because they are the two ways the runtime
	// actually applies a rebased pair -- the room composes accepted changes into one stored change,
	// while a client applies the broadcast change and then its rebased pending change in sequence.
	//
	// The law is a statement about the resulting DOCUMENT, not about the change encoding: the two
	// composed ChangeSets are routinely equal-as-documents while tiling their sections differently
	// (a deletion adjacent to an insertion can be emitted as one replacement section or as two, and
	// composition picks whichever the operand order produced). Asserting deep equality of the two
	// composed changes fails on that benign difference, so convergence is asserted on content --
	// which still pins the priority convention, since two inserts at equal positions land in a
	// definite order in the resulting text (see the dedicated ordering test below).
	it("obeys the ChangeSet transform law over 20000 concurrent edit pairs", () => {
		const rng = makeRng(7);
		for (let i = 0; i < 20_000; i++) {
			const base = randomText(rng, 20);
			const c = content({ "f.txt": base });
			const a: CodeChange = [["f.txt", { edit: randomEdit(rng, base) }]];
			const b: CodeChange = [["f.txt", { edit: randomEdit(rng, base) }]];
			validateCodeChangeSchema(a);
			validateCodeChangeSchema(b);

			const t = transformCodeChange(a, b);
			// A.compose(B.map(A)) and B.compose(A.map(B, true)) agree, applied to the same base.
			const composedA = applyCodeChange(c, composeCodeChange(a, t.b));
			const composedB = applyCodeChange(c, composeCodeChange(b, t.a));
			expect(toPlain(composedA)).toEqual(toPlain(composedB));
			// ...and the stepwise pairing both replicas actually run converges on the same content.
			const viaA = applyCodeChange(applyCodeChange(c, a), t.b);
			const viaB = applyCodeChange(applyCodeChange(c, b), t.a);
			expect(toPlain(viaA)).toEqual(toPlain(viaB));
			expect(toPlain(viaA)).toEqual(toPlain(composedA));
		}
	});

	it("converges for concurrent edit pairs, stepwise and composed", () => {
		const rng = makeRng(1);
		for (let i = 0; i < 1500; i++) {
			const base = randomText(rng, 20);
			const c = content({ "f.txt": base });
			const a: CodeChange = [["f.txt", { edit: randomEdit(rng, base) }]];
			const b: CodeChange = [["f.txt", { edit: randomEdit(rng, base) }]];
			validateCodeChangeSchema(a);
			validateCodeChangeSchema(b);

			const t = transformCodeChange(a, b);
			// Both transformed halves must pass content validation at their new bases: transform
			// preserves code-point-boundary cleanliness.
			validateCodeChangeContent(t.b, applyCodeChange(c, a));
			validateCodeChangeContent(t.a, applyCodeChange(c, b));

			// Stepwise convergence...
			const viaA = applyCodeChange(applyCodeChange(c, a), t.b);
			const viaB = applyCodeChange(applyCodeChange(c, b), t.a);
			expect(toPlain(viaA)).toEqual(toPlain(viaB));
			// ...and the composed form of the same law.
			expect(toPlain(applyCodeChange(c, composeCodeChange(a, t.b)))).toEqual(
				toPlain(viaA),
			);
			expect(toPlain(applyCodeChange(c, composeCodeChange(b, t.a)))).toEqual(
				toPlain(viaA),
			);
		}
	});

	it("converges for mixed concurrent changes (edit/set/remove across files)", () => {
		const rng = makeRng(2);
		for (let i = 0; i < 1500; i++) {
			const c = randomContent(rng);
			const a = randomCodeChange(rng, c);
			const b = randomCodeChange(rng, c);
			validateCodeChangeSchema(a);
			validateCodeChangeSchema(b);

			const t = transformCodeChange(a, b);
			const viaA = applyCodeChange(applyCodeChange(c, a), t.b);
			const viaB = applyCodeChange(applyCodeChange(c, b), t.a);
			expect(toPlain(viaA)).toEqual(toPlain(viaB));
			expect(toPlain(applyCodeChange(c, composeCodeChange(a, t.b)))).toEqual(
				toPlain(viaA),
			);
			expect(toPlain(applyCodeChange(c, composeCodeChange(b, t.a)))).toEqual(
				toPlain(viaA),
			);
		}
	});

	it("orders the earlier change's inserts first at equal positions", () => {
		const c = content({ "f.txt": "xy" });
		const a: CodeChange = [["f.txt", { edit: [[0, "A"], 2] }]];
		const b: CodeChange = [["f.txt", { edit: [[0, "B"], 2] }]];
		const t = transformCodeChange(a, b);
		expect(toPlain(applyCodeChange(applyCodeChange(c, a), t.b))).toEqual({
			"f.txt": "ABxy",
		});
		expect(toPlain(applyCodeChange(applyCodeChange(c, b), t.a))).toEqual({
			"f.txt": "ABxy",
		});
	});

	it("leaves disjoint paths untouched", () => {
		const a: CodeChange = [["f.txt", { set: "A" }]];
		const b: CodeChange = [["g.txt", { remove: true }]];
		expect(transformCodeChange(a, b)).toEqual({ a, b });
	});
});

describe("transformCodeChange set/remove last-writer-wins", () => {
	const BASE = content({ "f.txt": "hello" });

	// Each case: [a, b, expected t.a, expected t.b, expected converged file state].
	const CASES: [
		FileChange,
		FileChange,
		FileChange | undefined,
		FileChange | undefined,
		string | undefined,
	][] = [
		[{ set: "A" }, { set: "B" }, undefined, { set: "B" }, "B"],
		[{ set: "A" }, { remove: true }, undefined, { remove: true }, undefined],
		[{ remove: true }, { set: "B" }, undefined, { set: "B" }, "B"],
		[
			{ remove: true },
			{ remove: true },
			undefined,
			{ remove: true },
			undefined,
		],
		[{ set: "A" }, { edit: [[5, "!"]] }, { set: "A" }, undefined, "A"],
		[
			{ remove: true },
			{ edit: [[5, "!"]] },
			{ remove: true },
			undefined,
			undefined,
		],
		[{ edit: [[5, "!"]] }, { set: "B" }, undefined, { set: "B" }, "B"],
		[
			{ edit: [[5, "!"]] },
			{ remove: true },
			undefined,
			{ remove: true },
			undefined,
		],
	];

	for (const [aChange, bChange, expectA, expectB, merged] of CASES) {
		it(`${Object.keys(aChange)[0]} vs ${Object.keys(bChange)[0]}`, () => {
			const a: CodeChange = [["f.txt", aChange]];
			const b: CodeChange = [["f.txt", bChange]];
			const t = transformCodeChange(a, b);
			expect(t.a).toEqual(expectA === undefined ? [] : [["f.txt", expectA]]);
			expect(t.b).toEqual(expectB === undefined ? [] : [["f.txt", expectB]]);

			const viaA = applyCodeChange(applyCodeChange(BASE, a), t.b);
			const viaB = applyCodeChange(applyCodeChange(BASE, b), t.a);
			expect(toPlain(viaA)).toEqual(toPlain(viaB));
			expect(viaA.get("f.txt")).toBe(merged);
		});
	}
});

// =======================================================================================
// Fuzz: compose vs apply

describe("composeCodeChange", () => {
	it("matches sequential application", () => {
		const rng = makeRng(3);
		for (let i = 0; i < 1000; i++) {
			const c = randomContent(rng);
			const a = randomCodeChange(rng, c);
			const c2 = applyCodeChange(c, a);
			const b = randomCodeChange(rng, c2);
			expect(toPlain(applyCodeChange(c, composeCodeChange(a, b)))).toEqual(
				toPlain(applyCodeChange(c2, b)),
			);
		}
	});

	it("composes a set followed by an edit into a set", () => {
		const a: CodeChange = [["f.txt", { set: "hello" }]];
		const b: CodeChange = [["f.txt", { edit: [5, [0, " world"]] }]];
		expect(composeCodeChange(a, b)).toEqual([
			["f.txt", { set: "hello world" }],
		]);
	});

	it("rejects an edit composed after a remove", () => {
		const a: CodeChange = [["f.txt", { remove: true }]];
		const b: CodeChange = [["f.txt", { edit: [[1, "x"]] }]];
		expect(() => composeCodeChange(a, b)).toThrow(/compose edit after remove/);
	});
});

// =======================================================================================
// Fuzz: diffFiles

describe("diffFiles", () => {
	it("produces valid, boundary-clean changes whose application reproduces the target", () => {
		const rng = makeRng(4);
		for (let i = 0; i < 1200; i++) {
			const before = randomContent(rng);
			// Derive `after` by mutating: changed, removed, added, and untouched files.
			const after: CodeContent = new Map();
			for (const [path, text] of before) {
				const r = rng();
				if (r < 0.25) continue; // removed
				else if (r < 0.5) after.set(path, text); // untouched
				else after.set(path, randomText(rng, 12)); // replaced
			}
			if (rng() < 0.4) after.set("added.txt", randomText(rng, 8));

			const change = diffFiles(before, after);
			validateCodeChangeSchema(change);
			// Content validation proves every edit boundary lands on a code-point boundary and no
			// insert carries a lone surrogate, even over astral-heavy content.
			validateCodeChangeContent(change, before);
			expect(toPlain(applyCodeChange(before, change))).toEqual(toPlain(after));
		}
	});

	it("is deterministic with sorted entries", () => {
		const before = content({ "b.txt": "x", "a.txt": "y" });
		const after = content({ "b.txt": "x2", "a.txt": "y2" });
		const change = diffFiles(before, after);
		expect(JSON.stringify(change)).toBe(
			JSON.stringify(diffFiles(before, after)),
		);
		expect(changedPaths(change)).toEqual(["a.txt", "b.txt"]);
		expect(change.map(([path]) => path)).toEqual(["a.txt", "b.txt"]);
	});

	it("emits set/remove/edit per file state transition and [] for identical content", () => {
		const before = content({
			"keep.txt": "same",
			"gone.txt": "bye",
			"mod.txt": "aXc",
		});
		const after = content({
			"keep.txt": "same",
			"new.txt": "hi",
			"mod.txt": "aYc",
		});
		const entries = new Map(diffFiles(before, after));
		expect(entries.get("gone.txt")).toEqual({ remove: true });
		expect(entries.get("new.txt")).toEqual({ set: "hi" });
		expect("edit" in entries.get("mod.txt")!).toBe(true);
		expect(entries.get("keep.txt")).toBeUndefined();

		expect(diffFiles(before, before)).toEqual([]);
	});

	it("never splits surrogate pairs in astral-adjacent replacements", () => {
		const before = content({ "f.txt": "😀😀😀" });
		const after = content({ "f.txt": "😀🧠😀" });
		const change = diffFiles(before, after);
		validateCodeChangeContent(change, before);
		expect(toPlain(applyCodeChange(before, change))).toEqual(toPlain(after));
	});
});

// =======================================================================================
// Line-separator round-trips

describe("line separator handling", () => {
	const EXOTIC = "a\r\nb\rc\u2028d\u2029e\0f\nno trailing newline";

	it("round-trips exotic separators through set, edit, and diff", () => {
		const c = content({ "f.txt": "placeholder" });
		const viaSet = applyCodeChange(c, [["f.txt", { set: EXOTIC }]]);
		expect(viaSet.get("f.txt")).toBe(EXOTIC);

		// An edit that retains everything reproduces the text exactly (the apply path round-trips
		// the content through the OT core's internal document representation).
		const identity = applyCodeChange(viaSet, [
			["f.txt", { edit: [EXOTIC.length] }],
		]);
		expect(identity.get("f.txt")).toBe(EXOTIC);

		// A diffed edit between exotic variants applies losslessly, including an insert that
		// itself contains a bare "\r".
		const target = `x\r${EXOTIC}\u2028y`;
		const change = diffFiles(viaSet, content({ "f.txt": target }));
		expect("edit" in change[0]![1]).toBe(true);
		expect(applyCodeChange(viaSet, change).get("f.txt")).toBe(target);
	});
});

// =======================================================================================
// Application semantics

describe("applyCodeChange", () => {
	it("does not modify its input", () => {
		const c = content({ "f.txt": "hello" });
		applyCodeChange(c, [
			["f.txt", { set: "changed" }],
			["g.txt", { set: "new" }],
		]);
		expect(toPlain(c)).toEqual({ "f.txt": "hello" });
	});

	it("throws on an edit of an absent file or a wrong-length base", () => {
		const c = content({ "f.txt": "ab" });
		expect(() => applyCodeChange(c, [["g.txt", { edit: [2] }]])).toThrow(
			/absent file/,
		);
		expect(() => applyCodeChange(c, [["f.txt", { edit: [5] }]])).toThrow(
			/wrong length/,
		);
	});

	it("treats remove of an absent file as a no-op", () => {
		const c = content({ "f.txt": "hello" });
		const result = applyCodeChange(c, [["g.txt", { remove: true }]]);
		expect(toPlain(result)).toEqual({ "f.txt": "hello" });
	});
});

describe("changedPaths", () => {
	it("returns touched paths in sorted order", () => {
		expect(
			changedPaths([
				["b", { remove: true }],
				["a", { set: "x" }],
			]),
		).toEqual(["a", "b"]);
		expect(changedPaths([])).toEqual([]);
	});
});

// =======================================================================================
// Validation matrix

describe("validateCodeChangeSchema", () => {
	it("accepts the identity change and well-formed changes", () => {
		validateCodeChangeSchema([]);
		validateCodeChangeSchema([
			["a.txt", { set: "" }],
			["b/c.txt", { edit: [1, [2, "x", ""], 3] }],
			["d.txt", { remove: true }],
		]);
	});

	// Wire-shape rejection -- a change that isn't an array of [string, FileChange] pairs, a
	// FileChange variant of the wrong type -- is the transport decoder's job, established before a
	// change reaches this module (see the trust boundary note in code-change.ts). These cases cover
	// only what a well-typed CodeChange can still get wrong.
	it("rejects malformed entries", () => {
		expect(() => validateCodeChangeSchema([["", { remove: true }]])).toThrow(
			/path is empty/,
		);
		expect(() =>
			validateCodeChangeSchema([
				["f", { remove: true }],
				["f", { set: "x" }],
			]),
		).toThrow(/duplicate/);
	});

	// A first-match FileChange union tolerating extra properties makes a multi-variant file change
	// ours to reject (applyCodeChange and transformCodeChange would read it differently and
	// diverge two replicas).
	it("rejects file changes that are not exactly one variant", () => {
		const bad = (fileChange: unknown) =>
			expect(() => validateCodeChangeSchema([["f", fileChange as FileChange]]));
		bad({}).toThrow(/exactly one/);
		bad({ set: "x", remove: true }).toThrow(/exactly one/);
		bad({ frobnicate: 1 }).toThrow(/exactly one/);
	});

	// Likewise: a section length is a `number` to a wire validator, which says nothing about
	// integrality or sign.
	it("rejects malformed text changes", () => {
		const bad = (edit: TextChange) =>
			expect(() => validateCodeChangeSchema([["f", { edit }]]));
		bad([-1]).toThrow(/invalid section length/);
		bad([1.5]).toThrow(/invalid section length/);
		bad([[-2, "x"]]).toThrow(/invalid section length/);
	});

	it("rejects do-nothing sections and embedded newlines in inserted lines", () => {
		const bad = (edit: unknown) =>
			expect(() =>
				validateCodeChangeSchema([["f", { edit: edit as TextChange }]]),
			);
		// Zero-progress padding would evade the size caps.
		bad([0]).toThrow(/do-nothing/);
		bad([1, 0, 1]).toThrow(/do-nothing/);
		bad([[0]]).toThrow(/do-nothing/);
		bad([[0, ""]]).toThrow(/do-nothing/);
		// An inserted "line" containing "\n" desynchronizes line metadata from the text.
		bad([[0, "a\nb"], 3]).toThrow(/contains a newline/);
		// The legitimate forms of the same content still pass.
		validateCodeChangeSchema([["f", { edit: [[0, "a", "b"], 3] }]]); // multi-line insert
		validateCodeChangeSchema([["f", { edit: [[0, "", ""], 3] }]]); // pure "\n" insert
	});

	it("enforces the per-file, per-path, and per-change size caps", () => {
		const big = "x".repeat(MAX_FILE_TEXT_LENGTH + 1);
		expect(() => validateCodeChangeSchema([["f", { set: big }]])).toThrow(
			/too large/,
		);
		expect(() =>
			validateCodeChangeSchema([["f", { edit: [[0, big]] }]]),
		).toThrow(/too large/);
		// Growing an existing file past the cap trips on newLength even with a small insertion.
		expect(() =>
			validateCodeChangeSchema([
				["f", { edit: [MAX_FILE_TEXT_LENGTH, [0, "!"]] }],
			]),
		).toThrow(/too large/);

		expect(() =>
			validateCodeChangeSchema([
				["p".repeat(MAX_FILE_PATH_LENGTH + 1), { remove: true }],
			]),
		).toThrow(/path is too long/);

		const chunk = "x".repeat(MAX_FILE_TEXT_LENGTH);
		const files: CodeChange = [];
		const count = Math.ceil(MAX_CODE_CHANGE_SIZE / MAX_FILE_TEXT_LENGTH) + 1;
		for (let i = 0; i < count; i++) files.push([`f${i}`, { set: chunk }]);
		expect(() => validateCodeChangeSchema(files)).toThrow(
			/change is too large/,
		);
	});

	it("caps changes made of many payload-free entries", () => {
		// Removes insert nothing, but each entry still counts toward the change size.
		const path = "p".repeat(1000);
		const removes: CodeChange = [];
		for (let i = 0; i * 1000 <= MAX_CODE_CHANGE_SIZE; i++) {
			removes.push([`${path}${i}`, { remove: true }]);
		}
		expect(() => validateCodeChangeSchema(removes)).toThrow(
			/change is too large/,
		);

		// Likewise an edit's sections: maximal fragmentation (one section per retained unit)
		// counts toward the change size even though it inserts nothing.
		const sections: TextChange = Array.from(
			{ length: MAX_FILE_TEXT_LENGTH },
			() => 1,
		);
		const edits: CodeChange = [];
		for (let i = 0; i < 5; i++) edits.push([`e${i}`, { edit: sections }]);
		expect(() => validateCodeChangeSchema(edits)).toThrow(
			/change is too large/,
		);
	});

	it("rejects oversized edits before walking or re-parsing them", () => {
		// A hostile section count is rejected by the O(1) pre-check: had the sections been walked,
		// these holes would report "invalid section length" instead (and had it reached
		// ChangeSet.fromJSON, a second multi-million-element representation would be allocated).
		const holes: TextChange = [];
		holes.length = 100_000_000;
		expect(() => validateCodeChangeSchema([["f", { edit: holes }]])).toThrow(
			/code change is too large/,
		);

		// Inserted text is budget-checked as it accrues: this edit's total insertion exceeds the
		// *change* budget mid-walk, which fires before the per-file newLength check ("file is too
		// large") that runs after fromJSON.
		const chunk = "x".repeat(MAX_FILE_TEXT_LENGTH);
		const inserts: TextChange = Array.from(
			{ length: 5 },
			() => [0, chunk] as [number, string],
		);
		expect(() => validateCodeChangeSchema([["f", { edit: inserts }]])).toThrow(
			/code change is too large/,
		);

		// A single section padded with empty lines is rejected on its separator count alone,
		// before its lines are walked: the poisoned last line would otherwise report "contains a
		// newline".
		const padded: TextChange = [
			[0, ...Array.from({ length: 2_100_000 }, () => ""), "a\nb"],
		];
		expect(() => validateCodeChangeSchema([["f", { edit: padded }]])).toThrow(
			/code change is too large/,
		);
	});
});

// =======================================================================================
// Exotic file names
//
// Document content can legitimately contain files named after Object.prototype members. Paths are
// entry-list *values*, never object keys, precisely so these survive both object construction (a
// computed "__proto__" assignment sets the prototype instead of creating a key) and RPC transit
// (Cap'n Web deletes prototype-shadowing keys, and "toJSON", from every object it deserializes --
// a path-keyed map would silently lose these files on the wire).

describe("file names colliding with Object.prototype members", () => {
	const NAMES = [
		"__proto__",
		"constructor",
		"toString",
		"hasOwnProperty",
		"toJSON",
	];

	it("round-trips them through diffFiles, apply, JSON, and Cap'n Web", () => {
		const before: CodeContent = new Map();
		const after: CodeContent = new Map(
			NAMES.map((name, i) => [name, `v${i}`] as const),
		);

		const change = diffFiles(before, after);
		validateCodeChangeSchema(change);
		expect(change.map(([path]) => path)).toEqual([...NAMES].sort());
		expect(toPlain(applyCodeChange(before, change))).toEqual(toPlain(after));

		// The change survives JSON serialization (as stored rows do)...
		const reparsed = JSON.parse(JSON.stringify(change)) as CodeChange;
		expect(toPlain(applyCodeChange(before, reparsed))).toEqual(toPlain(after));

		// ...and Cap'n Web serialization (as broadcast frames and submitted changes do), which is
		// the round-trip a path-keyed representation could not make.
		const overRpc = deserialize(serialize(change)) as CodeChange;
		expect(overRpc).toEqual(change);
		expect(toPlain(applyCodeChange(before, overRpc))).toEqual(toPlain(after));
	});

	it("keeps them intact through transform and compose", () => {
		const c = content({ "f.txt": "hello" });
		const a: CodeChange = [
			["constructor", { set: "x" }],
			["__proto__", { set: "y" }],
		];
		const b: CodeChange = [["f.txt", { set: "z" }]];

		// The expected content is built with JSON.parse: a literal "__proto__" property in source
		// would set the prototype rather than the key. (toPlain's Object.fromEntries creates real
		// keys for such names.)
		const expected = JSON.parse(
			'{"f.txt": "z", "constructor": "x", "__proto__": "y"}',
		);

		const t = transformCodeChange(a, b);
		expect(toPlain(applyCodeChange(applyCodeChange(c, a), t.b))).toEqual(
			toPlain(applyCodeChange(applyCodeChange(c, b), t.a)),
		);
		expect(toPlain(applyCodeChange(applyCodeChange(c, a), t.b))).toEqual(
			expected,
		);

		const composed = composeCodeChange(a, b);
		expect(toPlain(applyCodeChange(c, composed))).toEqual(expected);
	});
});

describe("validateCodeChangeContent", () => {
	const CONTENT = content({ "f.txt": "😀x" });

	it("accepts boundary-clean edits, sets, and removes of anything", () => {
		validateCodeChangeContent([["f.txt", { edit: [[2], 1] }]], CONTENT); // delete the 😀
		validateCodeChangeContent([["f.txt", { edit: [3] }]], CONTENT); // identity retain
		validateCodeChangeContent([["f.txt", { edit: [[0, "🧠"], 3] }]], CONTENT);
		validateCodeChangeContent([["absent.txt", { set: "hi" }]], CONTENT);
		validateCodeChangeContent([["nowhere.txt", { remove: true }]], CONTENT);
	});

	it("rejects edits of absent files and wrong-length bases", () => {
		expect(() =>
			validateCodeChangeContent([["g.txt", { edit: [3] }]], CONTENT),
		).toThrow(/absent file/);
		expect(() =>
			validateCodeChangeContent([["f.txt", { edit: [7] }]], CONTENT),
		).toThrow(/length mismatch/);
	});

	it("rejects boundaries that split a surrogate pair", () => {
		// Delete just the high half of the 😀.
		expect(() =>
			validateCodeChangeContent([["f.txt", { edit: [[1], 2] }]], CONTENT),
		).toThrow(/splits a surrogate pair/);
		// Replace starting mid-pair.
		expect(() =>
			validateCodeChangeContent(
				[["f.txt", { edit: [1, [1, "y"], 1] }]],
				CONTENT,
			),
		).toThrow(/splits a surrogate pair/);
	});

	it("rejects lone surrogates in inserted and set text", () => {
		expect(() =>
			validateCodeChangeContent(
				[["f.txt", { edit: [[0, "\ud83d"], 3] }]],
				CONTENT,
			),
		).toThrow(/lone surrogate/);
		expect(() =>
			validateCodeChangeContent([["g.txt", { set: "ok\udc00" }]], CONTENT),
		).toThrow(/lone surrogate/);
		// A well-formed pair in an insert passes.
		validateCodeChangeContent([["f.txt", { edit: [[0, "😀"], 3] }]], CONTENT);
	});
});
