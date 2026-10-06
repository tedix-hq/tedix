import { describe, expect, it } from "vite-plus/test";
import {
	CANVAS_MAX_URL_WORKPIECES,
	canvasConversationFromSearch,
	canvasDocFromSearch,
	canvasDocsFromSearch,
	canvasDocsSearchValue,
	canvasDocKey,
	canvasModeIsValidForDoc,
	validateChatSearch,
	validateWorkspaceSearch,
} from "./canvas-search";

const OUTPUT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GADGET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("Canvas URL search", () => {
	it("accepts the native Work pane", () => {
		expect(validateWorkspaceSearch({ pane: "work" }).pane).toBe("work");
	});
	it("keeps only typed, bounded selections", () => {
		expect(
			validateWorkspaceSearch({
				workpiece: `output:${OUTPUT_ID}`,
				view: "connections",
				pane: "workpiece",
				focus: "true",
				secret: "must-not-survive",
			}),
		).toEqual({
			conversation: undefined,
			workpiece: `output:${OUTPUT_ID}`,
			view: "connections",
			pane: "workpiece",
			focus: true,
		});
	});

	it("drops malformed ids, arbitrary modes, and unbounded content", () => {
		expect(
			validateWorkspaceSearch({
				workspace: "../../another-tenant",
				workpiece: "output:not-a-uuid",
				view: "raw-secrets",
				pane: "admin",
				focus: "yes",
			}),
		).toEqual({
			conversation: undefined,
			workpiece: undefined,
			view: undefined,
			pane: undefined,
			focus: undefined,
		});
	});

	it("keeps a bounded Home conversation selection", () => {
		const conversation = "home:os:11111111-1111-4111-8111-111111111111";
		expect(canvasConversationFromSearch(conversation)).toBe(conversation);
		expect(canvasConversationFromSearch("home:main")).toBe("home:main");
		expect(
			canvasConversationFromSearch("home:os:../../secret"),
		).toBeUndefined();
		expect(validateWorkspaceSearch({ conversation }).conversation).toBe(
			conversation,
		);
	});

	it("preserves widget UUID conversations through workspace and chat handoffs", () => {
		const conversation = "6d64f5bd-fd12-45d3-9db7-a9f6eb5b9f8d";
		expect(canvasConversationFromSearch(conversation)).toBe(conversation);
		expect(validateWorkspaceSearch({ conversation }).conversation).toBe(
			conversation,
		);
		expect(validateChatSearch({ conversation })).toEqual({ conversation });
		for (const invalid of [
			"6d64f5bd",
			`${conversation}/other`,
			`https://example.com/${conversation}`,
		]) {
			expect(canvasConversationFromSearch(invalid)).toBeUndefined();
		}
	});

	it("round-trips gadget and output workpiece keys", () => {
		for (const doc of [
			{ type: "gadget" as const, id: GADGET_ID },
			{ type: "output" as const, id: OUTPUT_ID },
		]) {
			expect(canvasDocFromSearch(canvasDocKey(doc))).toEqual(doc);
		}
		expect(canvasDocFromSearch(`output:${OUTPUT_ID}:extra`)).toBeNull();
	});

	it("permits source view only for Gadgets", () => {
		expect(
			canvasModeIsValidForDoc("source", {
				type: "gadget",
				id: GADGET_ID,
			}),
		).toBe(true);
		expect(
			canvasModeIsValidForDoc("source", {
				type: "output",
				id: OUTPUT_ID,
			}),
		).toBe(false);
	});
});

describe("multi-workpiece URLs", () => {
	const a = "output:11111111-1111-4111-8111-111111111111";
	const b = "gadget:22222222-2222-4222-8222-222222222222";
	const c = "output:33333333-3333-4333-8333-333333333333";

	it("parses a comma-joined tab set, dropping bad entries per element", () => {
		// One stale or mangled entry in a shared link must not discard the rest.
		const docs = canvasDocsFromSearch(`${a},not-a-doc,${b},${a},output:nope`);
		expect(docs.map(canvasDocKey)).toEqual([a, b]);
	});

	it("bounds the set and preserves order", () => {
		const many = Array.from(
			{ length: 9 },
			(_, at) => `output:${at}1111111-1111-4111-8111-111111111111`,
		).join(",");
		expect(canvasDocsFromSearch(many)).toHaveLength(CANVAS_MAX_URL_WORKPIECES);
	});

	it("keeps single-tab URLs byte-identical to today's", () => {
		// `workpieces` appears only when there is genuinely a set to share.
		expect(canvasDocsSearchValue([])).toBeUndefined();
		expect(canvasDocsSearchValue([canvasDocFromSearch(a)!])).toBeUndefined();
		expect(
			canvasDocsSearchValue([
				canvasDocFromSearch(a)!,
				canvasDocFromSearch(b)!,
				canvasDocFromSearch(c)!,
			]),
		).toBe(`${a},${b},${c}`);
	});

	it("round-trips through validateWorkspaceSearch", () => {
		const search = validateWorkspaceSearch({
			workpiece: a,
			workpieces: `${a},${b},junk`,
		});
		expect(search.workpiece).toBe(a);
		expect(search.workpieces).toBe(`${a},${b}`);
		// A degenerate one-entry set collapses out of the URL entirely.
		expect(
			validateWorkspaceSearch({ workpiece: a, workpieces: a }).workpieces,
		).toBeUndefined();
	});
});

describe("/chat URL search", () => {
	it("keeps only a validated conversation id and nothing else", () => {
		expect(
			validateChatSearch({
				conversation: "home:os:11111111-1111-4111-8111-111111111111",
				pane: "chat",
				secret: "must-not-survive",
			}),
		).toEqual({ conversation: "home:os:11111111-1111-4111-8111-111111111111" });
		expect(validateChatSearch({ conversation: "home:main" })).toEqual({
			conversation: "home:main",
		});
	});

	it("lands on the new-conversation state for a missing or malformed id", () => {
		expect(validateChatSearch({})).toEqual({});
		expect(validateChatSearch({ conversation: "javascript:alert(1)" })).toEqual(
			{},
		);
		expect(validateChatSearch({ conversation: 42 })).toEqual({});
	});
});
