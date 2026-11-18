import { describe, expect, it } from "vite-plus/test";

import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import {
	formatWorkspaceLastUsed,
	groupWorkspaceLibrary,
	workspaceDescriptionForDisplay,
} from "./workspace-library";

function workspace(id: string, name: string, description?: string) {
	return { id, name, description: description ?? null } as OsWorkspace;
}

function preference(
	workspaceId: string,
	favorite: boolean,
	lastOpenedAt: string | null,
) {
	return { workspaceId, favorite, lastOpenedAt, updatedAt: "2026-08-17" };
}

describe("groupWorkspaceLibrary", () => {
	const workspaces = [
		workspace("never-b", "Bravo"),
		workspace("never-a", "Alpha"),
		workspace("old", "Charlie"),
		workspace("new", "Zulu"),
		workspace("pin-old", "Delta"),
		workspace("pin-new", "Yankee"),
		workspace("pin-never", "Echo"),
	];
	const preferences = [
		preference("old", false, "2026-08-01T09:00:00.000Z"),
		preference("new", false, "2026-08-17T09:00:00.000Z"),
		preference("pin-old", true, "2026-07-01T09:00:00.000Z"),
		preference("pin-new", true, "2026-08-10T09:00:00.000Z"),
		preference("pin-never", true, null),
	];
	const ids = (entries: { workspace: OsWorkspace }[]) =>
		entries.map((entry) => entry.workspace.id);

	it("lists pinned workspaces first, then the most recently opened, then the rest by name", () => {
		const groups = groupWorkspaceLibrary(workspaces, preferences, "");
		expect(ids(groups.all)).toEqual([
			"pin-new",
			"pin-old",
			"pin-never",
			"new",
			"old",
			"never-a",
			"never-b",
		]);
		expect(ids(groups.favorites)).toEqual(["pin-new", "pin-old", "pin-never"]);
	});

	it("keeps Recent in last-opened order, pinned or not", () => {
		const groups = groupWorkspaceLibrary(workspaces, preferences, "");
		expect(ids(groups.recent)).toEqual(["new", "pin-new", "old", "pin-old"]);
	});

	it("keeps the order when a search narrows the list", () => {
		const groups = groupWorkspaceLibrary(
			[...workspaces, workspace("described", "Foxtrot", "the alpha plan")],
			preferences,
			" ALPHA ",
		);
		expect(ids(groups.all)).toEqual(["never-a", "described"]);
	});
});

describe("last used", () => {
	it("orders a never-opened workspace by when it last changed", () => {
		const groups = groupWorkspaceLibrary(
			[
				workspace("opened", "Alpha"),
				{ ...workspace("changed", "Bravo"), updatedAt: "2026-08-10T09:00:00Z" },
				{ ...workspace("stale", "Charlie"), updatedAt: "2026-07-01T09:00:00Z" },
			],
			[preference("opened", false, "2026-08-01T09:00:00.000Z")],
			"",
		);
		expect(groups.all.map((entry) => entry.workspace.id)).toEqual([
			"changed",
			"opened",
			"stale",
		]);
	});

	it("reads as a short time ago, then as a date", () => {
		const now = new Date("2026-11-18T12:00:00.000Z");
		const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
		const day = 86_400_000;
		expect(formatWorkspaceLastUsed(ago(3 * 3_600_000), now)).toBe("3h ago");
		expect(formatWorkspaceLastUsed(ago(day + 1), now)).toBe("yesterday");
		expect(formatWorkspaceLastUsed(ago(10 * day), now)).toBe("10 days ago");
		expect(formatWorkspaceLastUsed(ago(30 * day), now)).toBe("30 days ago");
		expect(formatWorkspaceLastUsed(ago(45 * day), now)).toBe("Oct 4");
	});
});

describe("workspaceDescriptionForDisplay", () => {
	it("drops a parenthetical that carries a raw user id", () => {
		expect(
			workspaceDescriptionForDisplay(
				"Private notes for Sam (tedix user Q7xk2Lm9Np4Rt8Vw3Yz6Bc1Df5)",
			),
		).toBe("Private notes for Sam");
	});

	it("removes a bare UUID and tidies punctuation", () => {
		expect(
			workspaceDescriptionForDisplay(
				"Owned by 8f2ca634-dbd4-410e-80a0-16eaeac0cfe9. Weekly review.",
			),
		).toBe("Owned by. Weekly review.");
	});

	it("keeps an id that is part of a link", () => {
		expect(
			workspaceDescriptionForDisplay(
				"Design: https://tedix.os.tedix.dev/outputs/641d8739-2e09-4b4a-b694-cd4601a8269b",
			),
		).toBe(
			"Design: https://tedix.os.tedix.dev/outputs/641d8739-2e09-4b4a-b694-cd4601a8269b",
		);
	});

	it("keeps readable text and readable parentheticals", () => {
		expect(
			workspaceDescriptionForDisplay("Revenue reporting (weekly, 2026)"),
		).toBe("Revenue reporting (weekly, 2026)");
	});

	it("returns null when only an id or nothing is left", () => {
		expect(workspaceDescriptionForDisplay("Q7xk2Lm9Np4Rt8Vw3Yz6Bc1Df5")).toBe(
			null,
		);
		expect(workspaceDescriptionForDisplay("")).toBe(null);
		expect(workspaceDescriptionForDisplay(null)).toBe(null);
	});
});
