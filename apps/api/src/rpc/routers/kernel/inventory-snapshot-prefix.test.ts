/**
 * Measures how many bytes of the Home planner prompt each turn shares with the
 * previous turn's prompt — what a provider prefix cache can reuse — across a
 * five-turn conversation whose inventory changes twice. "Before" rebuilds the
 * inventory every turn; "after" renders the conversation's frozen snapshot and
 * puts the changes after the history.
 */
import { describe, expect, it } from "vite-plus/test";
import {
	type HomeInventorySnapshot,
	resolveInventorySnapshot,
} from "../../../kernel/inventory-snapshot";
import { type KernelContext, renderHomeInventory } from "./context-assembly";
import { buildUserPrompt } from "./route-planner";

type Tedi = KernelContext["tedis"][number];

function tedi(slug: string, status: string, successRate?: number): Tedi {
	return {
		id: `tedi-${slug}`,
		slug,
		name: slug.toUpperCase(),
		role: `${slug} lead`,
		status,
		...(successRate === undefined
			? {}
			: { selectionPrior: { successRate, total: 12 } }),
	};
}

function turnContext(turn: number): KernelContext {
	const tedis = [
		tedi("cfo", "running", 0.9),
		tedi("cmo", "running", 0.75),
		tedi("coo", "standby"),
		// Turn 2: a tedi goes to standby.
		tedi("cto", turn >= 2 ? "standby" : "running", 0.8),
		tedi("legal", "running"),
		// Turn 4: a graded delegation moves a track record.
		tedi("sales", "running", turn >= 4 ? 0.83 : 0.8),
	];
	const apps = [
		"calendar",
		"crm",
		"docs",
		"drive",
		"gmail",
		"linear",
		"notion",
		"slack",
		// Turn 4: an app is installed.
		...(turn >= 4 ? ["github"] : []),
	].map((slug) => ({
		slug,
		name: slug,
		capabilities: ["read", "search", "draft"],
	}));
	const workflows = [
		"weekly-report",
		"invoice-review",
		"lead-intake",
		"release-notes",
	].map((slug) => ({ slug, title: slug.replace("-", " ") }));
	const history = Array.from({ length: (turn - 1) * 2 }, (_, index) => ({
		role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		// ~800 bytes, about one short Home answer.
		content: `Message ${index + 1}: ${"Revenue, open invoices and the hiring plan for next quarter. ".repeat(13)}`,
	}));
	return {
		tedis,
		apps,
		workflows,
		workItems: [
			{
				id: "work-1",
				title: "Close October books",
				status: "in_progress",
				updatedAt: `2026-10-21T0${turn}:00:00Z`,
			},
		],
		facts: [],
		rationale: [],
		speaker: {
			role: "owner",
			email: "owner@example.com",
			approvalAuthority: true,
		},
		history,
	} as KernelContext;
}

function commonPrefixBytes(a: string, b: string): number {
	const left = new TextEncoder().encode(a);
	const right = new TextEncoder().encode(b);
	let index = 0;
	while (
		index < left.length &&
		index < right.length &&
		left[index] === right[index]
	)
		index++;
	return index;
}

async function measure(snapshotted: boolean) {
	const prompts: string[] = [];
	let stored: HomeInventorySnapshot | null = null;
	for (let turn = 1; turn <= 5; turn++) {
		const context = turnContext(turn);
		if (snapshotted) {
			const resolved = await resolveInventorySnapshot(
				stored,
				renderHomeInventory(context),
			);
			if (resolved.taken) stored = resolved.snapshot;
			context.inventorySnapshot = resolved.snapshot;
			if (resolved.changeNote)
				context.inventoryChangeNote = resolved.changeNote;
		}
		prompts.push(buildUserPrompt(`Question for turn ${turn}`, context));
	}
	const reused = prompts
		.slice(1)
		.map((prompt, index) => commonPrefixBytes(prompts[index]!, prompt));
	const uncached = prompts
		.slice(1)
		.map(
			(prompt, index) =>
				new TextEncoder().encode(prompt).length - reused[index]!,
		);
	const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
	return {
		prompts,
		reused,
		uncached,
		totalReused: sum(reused),
		totalUncached: sum(uncached),
	};
}

describe("Home inventory snapshot keeps the prompt prefix stable", () => {
	it("reuses more prefix bytes across five turns than rebuilding the inventory", async () => {
		const before = await measure(false);
		const after = await measure(true);
		console.info({
			event: "inventory_prefix_measurement",
			beforeReusedBytesPerTurn: before.reused,
			afterReusedBytesPerTurn: after.reused,
			beforeUncachedBytesPerTurn: before.uncached,
			afterUncachedBytesPerTurn: after.uncached,
			beforeTotalReused: before.totalReused,
			afterTotalReused: after.totalReused,
			beforeTotalUncached: before.totalUncached,
			afterTotalUncached: after.totalUncached,
		});
		// Turns 2 and 4 change the inventory: rebuilding it breaks the prefix
		// inside the inventory; the snapshot keeps every earlier turn's bytes.
		expect(after.reused[0]).toBeGreaterThan(before.reused[0]!);
		expect(after.reused[2]).toBeGreaterThan(before.reused[2]!);
		expect(after.totalReused).toBeGreaterThan(before.totalReused);
		expect(after.totalUncached).toBeLessThan(before.totalUncached);
		// With the snapshot every turn reuses the previous turn's whole history.
		for (let index = 1; index < after.reused.length; index++)
			expect(after.reused[index]).toBeGreaterThan(
				after.prompts[index]!.indexOf("</conversation_history>"),
			);
	});

	it("keeps the stable half byte-identical and states the changes after the history", async () => {
		const after = await measure(true);
		const stableEnd = (prompt: string) =>
			prompt.slice(0, prompt.indexOf("<conversation_history>"));
		const first = after.prompts[1]!;
		for (const prompt of after.prompts.slice(2))
			expect(stableEnd(prompt)).toBe(stableEnd(first));
		const last = after.prompts[4]!;
		expect(last.indexOf("INVENTORY CHANGES SINCE")).toBeGreaterThan(
			last.indexOf("</conversation_history>"),
		);
		expect(last).toContain("- github [slug=github]");
		expect(last).toContain("status=standby");
	});

	it("renders exactly the live inventory when no snapshot is set", () => {
		const context = turnContext(3);
		expect(buildUserPrompt("q", context)).toContain(
			renderHomeInventory(context),
		);
	});
});
