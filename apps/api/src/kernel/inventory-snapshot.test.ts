import { describe, expect, it } from "vite-plus/test";
import {
	hashInventoryText,
	INVENTORY_CHANGE_NOTE_MAX_CHARS,
	INVENTORY_SNAPSHOT_VERSION,
	isUsableInventorySnapshot,
	renderInventoryChangeNote,
	resolveInventorySnapshot,
} from "./inventory-snapshot";

const NOW = () => new Date("2026-10-21T12:00:00.000Z");

const INVENTORY = [
	"AVAILABLE TEDIS (2):",
	"- CFO [slug=cfo, id=t1] (status=running)",
	"- CTO [slug=cto, id=t2] (status=running)",
	"",
	"AVAILABLE APPS (1):",
	"- Gmail [slug=gmail]",
	"",
	"AVAILABLE WORKFLOWS: none",
].join("\n");

describe("resolveInventorySnapshot", () => {
	it("takes a snapshot when the conversation has none", async () => {
		const resolved = await resolveInventorySnapshot(null, INVENTORY, NOW);
		expect(resolved.taken).toBe(true);
		expect(resolved.changeNote).toBeNull();
		expect(resolved.snapshot).toEqual({
			version: INVENTORY_SNAPSHOT_VERSION,
			hash: await hashInventoryText(INVENTORY),
			text: INVENTORY,
			takenAt: "2026-10-21T12:00:00.000Z",
		});
	});

	it("keeps an unchanged snapshot without a note", async () => {
		const first = await resolveInventorySnapshot(null, INVENTORY, NOW);
		const second = await resolveInventorySnapshot(
			first.snapshot,
			INVENTORY,
			NOW,
		);
		expect(second).toEqual({
			snapshot: first.snapshot,
			changeNote: null,
			taken: false,
		});
	});

	it("keeps the old text and notes what changed", async () => {
		const first = await resolveInventorySnapshot(null, INVENTORY, NOW);
		const live = INVENTORY.replace(
			"- CTO [slug=cto, id=t2] (status=running)",
			"- CTO [slug=cto, id=t2] (status=standby)",
		).replace(
			"AVAILABLE APPS (1):\n- Gmail [slug=gmail]",
			"AVAILABLE APPS (2):\n- GitHub [slug=github]\n- Gmail [slug=gmail]",
		);
		const second = await resolveInventorySnapshot(first.snapshot, live, NOW);
		expect(second.taken).toBe(false);
		expect(second.snapshot.text).toBe(INVENTORY);
		expect(second.changeNote).toBe(
			[
				"INVENTORY CHANGES SINCE THIS CONVERSATION STARTED (the current state; it overrides the inventory listed above):",
				"No longer listed as shown above:",
				"- CTO [slug=cto, id=t2] (status=running) [tedis]",
				"Now listed:",
				"- CTO [slug=cto, id=t2] (status=standby) [tedis]",
				"- GitHub [slug=github] [apps]",
			].join("\n"),
		);
	});

	it("retakes the snapshot once the note would be too long", async () => {
		const first = await resolveInventorySnapshot(null, INVENTORY, NOW);
		const manyApps = Array.from(
			{ length: 80 },
			(_, index) => `- App ${index} [slug=app-${index}]`,
		);
		const live = `${INVENTORY}\n\nAVAILABLE APPS (80):\n${manyApps.join("\n")}`;
		expect(renderInventoryChangeNote(INVENTORY, live)!.length).toBeGreaterThan(
			INVENTORY_CHANGE_NOTE_MAX_CHARS,
		);
		const second = await resolveInventorySnapshot(first.snapshot, live, NOW);
		expect(second.taken).toBe(true);
		expect(second.changeNote).toBeNull();
		expect(second.snapshot.text).toBe(live);
	});

	it("keeps the snapshot when only a section count changed", async () => {
		const first = await resolveInventorySnapshot(null, INVENTORY, NOW);
		const live = INVENTORY.replace(
			"AVAILABLE APPS (1):",
			"AVAILABLE APPS (9):",
		);
		const second = await resolveInventorySnapshot(first.snapshot, live, NOW);
		expect(second).toEqual({
			snapshot: first.snapshot,
			changeNote: null,
			taken: false,
		});
	});

	it("ignores stored values from another version or shape", async () => {
		expect(isUsableInventorySnapshot(null)).toBe(false);
		expect(
			isUsableInventorySnapshot({
				version: INVENTORY_SNAPSHOT_VERSION + 1,
				hash: "x",
				text: "y",
				takenAt: "z",
			}),
		).toBe(false);
		const resolved = await resolveInventorySnapshot(
			{ version: 0, hash: "x", text: "y", takenAt: "z" },
			INVENTORY,
			NOW,
		);
		expect(resolved.taken).toBe(true);
	});
});
