import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import {
	refreshSupplierImport,
	supplierDocument,
} from "./supplier-review-document";
import {
	checkedSupplierReply,
	checkSupplierReply,
	supplierCalculationGrounding,
	supplierFacts,
} from "./supplier-review-quality";

const folder = join(import.meta.dir, "supplier-folder");
const sources = await Promise.all(
	(await readdir(folder))
		.filter((name) => name.endsWith(".md"))
		.map(async (name) => ({
			name,
			text: await readFile(join(folder, name), "utf8"),
		})),
);
const good =
	"Price increase: 5.9%\nAdditional cost: 11,500 EUR\nOn-time deliveries: 2/4\nQuote expired: yes";

describe("supplier calculation checks", () => {
	test("derives expectations from the fixture, including the expired quote", () => {
		expect(supplierFacts(sources, "2026-10-04")).toMatchObject({
			priceIncreasePercent: 5.9,
			additionalCost: 11500,
			onTime: 2,
			deliveries: 4,
			expiryDate: "2026-09-30",
			expired: true,
		});
		expect(supplierFacts(sources, "2026-09-30").expired).toBe(false);
	});
	test("grounds calculations in changed files and explicit delivery comparisons", () => {
		const changed = sources.map((source) => ({
			...source,
			text: source.text
				.replace("41.20 EUR", "42.79 EUR")
				.replace("delivered 13 May", "delivered 12 May"),
		}));
		const grounding = supplierCalculationGrounding(
			supplierFacts(changed, "2026-10-04"),
			"2026-10-04",
		);
		expect(grounding).toContain("quote-2026-q3.md: (42.79 - 38.90)");
		expect(grounding).toContain("10.0%");
		expect(grounding).toContain("19450 EUR");
		expect(grounding).toContain(
			"delivery-log.md: promised 12 May; delivered 12 May; on time.",
		);
		expect(grounding).toContain("3/4 on time (75%)");
	});
	test("shows failed checks before the unchanged model answer", () => {
		const reply = good.replace("2/4", "3/4");
		const checked = checkedSupplierReply(
			reply,
			checkSupplierReply(reply, supplierFacts(sources, "2026-10-04")),
			"2026-10-04",
		);
		expect(checked.startsWith("## Calculation check\n\nNeeds review")).toBe(
			true,
		);
		expect(checked.endsWith(reply)).toBe(true);
		expect(supplierDocument(checked).blocks[0]).toEqual({
			type: "heading",
			level: 2,
			text: "Calculation check",
		});
	});
	test("accepts the correct summary without certifying the recommendation", () => {
		expect(
			checkSupplierReply(good, supplierFacts(sources, "2026-10-04")),
		).toEqual([]);
	});
	test("reports incorrect arithmetic, delivery count and expired validity without changing the answer", () => {
		const wrong = good
			.replace("5.9%", "6.5%")
			.replace("11,500", "11,500.99")
			.replace("2/4", "3/4")
			.replace("yes", "no");
		expect(
			checkSupplierReply(wrong, supplierFacts(sources, "2026-10-04")),
		).toHaveLength(4);
		expect(wrong).toContain("6.5%");
	});
	test("missing calculations require review, not a fabricated successful answer", () => {
		expect(
			checkSupplierReply(
				"Accept the quote.",
				supplierFacts(sources, "2026-10-04"),
			),
		).toHaveLength(4);
		expect(() => supplierFacts([], "2026-10-04")).toThrow(
			"Cannot check this folder",
		);
	});
	test("tracks fixture changes instead of hardcoding the correct model output", () => {
		const changed = sources.map((source) => ({
			...source,
			text: source.text.replace("41.20 EUR", "42.79 EUR"),
		}));
		expect(supplierFacts(changed, "2026-10-04").priceIncreasePercent).toBe(10);
		expect(
			checkSupplierReply(good, supplierFacts(changed, "2026-10-04")),
		).toHaveLength(2);
	});
});

describe("native supplier documents", () => {
	test("reruns reuse matching imports without writing", async () => {
		const content = supplierDocument("# Folder\n\nCurrent files");
		let writes = 0;
		await refreshSupplierImport(
			{ content, revision: 3 },
			content,
			false,
			async () => {
				writes++;
			},
		);
		expect(writes).toBe(0);
	});
	test("formatted imports still match after API schema normalization", async () => {
		const content = supplierDocument(
			"# Folder\n\n**Review** the `quote`.\n\n- First\n- Second",
		);
		const saved = OsOutputContentSchema.parse(content);
		let writes = 0;
		await refreshSupplierImport(
			{ content: saved, revision: 3 },
			content,
			false,
			async () => {
				writes++;
			},
		);
		expect(writes).toBe(0);
	});
	test("preserves different old imports and user edits without explicit refresh", async () => {
		let writes = 0;
		await expect(
			refreshSupplierImport(
				{ content: supplierDocument("User edits"), revision: 4 },
				supplierDocument("Fresh files"),
				false,
				async () => {
					writes++;
				},
			),
		).rejects.toThrow("--refresh-import");
		expect(writes).toBe(0);
	});
	test("explicit refresh uses the read revision and never retries a CAS conflict", async () => {
		const content = supplierDocument("Fresh files");
		const calls: unknown[] = [];
		await expect(
			refreshSupplierImport(
				{ content: supplierDocument("Old import"), revision: 4 },
				content,
				true,
				async (update) => {
					calls.push(update);
					throw new Error("CONFLICT");
				},
			),
		).rejects.toThrow("CONFLICT");
		expect(calls).toEqual([{ content, expectedRevision: 4 }]);
	});
	test("renders headings, bold text, lists, links and code as editor nodes", () => {
		const document = supplierDocument(
			"## Decision\n\n**Review** the `quote` and *ask* [Globex](https://example.com).\n\n- First\n- Second\n\n1. Draft\n2. Do not send\n\n> Needs review\n\n```txt\n**literal code**\n```",
		);
		expect(OsOutputContentSchema.safeParse(document).success).toBe(true);
		expect(document.blocks.map((block) => block.type)).toEqual([
			"heading",
			"paragraph",
			"list",
			"list",
			"quote",
			"code",
		]);
		expect(document.richText?.content[1]?.content?.[0]).toEqual({
			type: "text",
			text: "Review",
			marks: [{ type: "bold" }],
		});
		expect(document.richText?.content[2]?.type).toBe("bulletList");
		expect(document.richText?.content[3]?.type).toBe("orderedList");
		expect(document.blocks.at(-1)).toEqual({
			type: "code",
			language: "txt",
			text: "**literal code**",
		});
	});
	test("preserves raw HTML and unsafe links as text rather than executable content", () => {
		const document = supplierDocument(
			"<script>alert(1)</script>\n\n[unsafe](javascript:alert)",
		);
		expect(JSON.stringify(document.richText)).toContain(
			"<script>alert(1)</script>",
		);
		expect(document.richText?.content[1]?.content?.[0]?.marks).toBeUndefined();
		expect(document.blocks[1]).toEqual({
			type: "paragraph",
			text: "[unsafe](javascript:alert)",
		});
	});
});
