import { beforeEach, expect, it, vi } from "vite-plus/test";
import { cardFirstView } from "./card-first-view";
beforeEach(() => localStorage.clear());
it("keeps the original view across reloads without mixing people, source versions or cards", () => {
	expect(cardFirstView("org:person:card:1", 1000)).toBe(1000);
	expect(cardFirstView("org:person:card:1", 9000)).toBe(1000);
	expect(cardFirstView("org:other:card:1", 9000)).toBe(9000);
	expect(cardFirstView("org:person:card:2", 9000)).toBe(9000);
});
it("recovers from a corrupt or future browser timestamp", () => {
	localStorage.setItem("tedix:card-first-view:card", "bad");
	expect(cardFirstView("card", 1000)).toBe(1000);
	expect(cardFirstView("card", 500)).toBe(500);
});

it("does not report an instant choice when embedded storage is unavailable", () => {
	const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	expect(cardFirstView("embedded:person:card:1", 2000)).toBe(2000);
	expect(cardFirstView("embedded:person:card:1", 12000)).toBe(2000);
	get.mockRestore();
	set.mockRestore();
});

it("keeps detail use after a reload without mixing cards or source versions", async () => {
	const first = await import("./card-first-view");
	first.markCardDetails("person:revisited:1");
	vi.resetModules();
	const reloaded = await import("./card-first-view");
	expect(reloaded.cardDetailsOpened("person:revisited:1")).toBe(true);
	expect(reloaded.cardDetailsOpened("person:revisited:2")).toBe(false);
	expect(reloaded.cardDetailsOpened("other:revisited:1")).toBe(false);
});
