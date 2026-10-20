import { describe, expect, it } from "vite-plus/test";
import type { TediSetup } from "@tedix/api-contract/contracts/tedis";
import { renderTediWiring, type TediWiringInput } from "./tedi-wiring";

const base: TediWiringInput = {
	name: "ada",
	displayName: "Ada",
	personality: "Keeps the Example Co. books tidy.",
	installedSkills: ["close-the-month"],
	installedPlugins: null,
	toolPolicy: {
		bash: "always-approve",
		browser: "always-allow",
		github: "always-allow",
		deploy: "always-approve",
	},
	cronJobs: [
		{ name: "Morning digest", schedule: "0 8 * * *", enabled: true },
		{ name: "Weekly sweep", schedule: "0 9 * * 1", enabled: false },
	],
	runtimeOverrides: {
		agents: {
			defaults: { model: { primary: "kimi-k2", fallbacks: ["deepseek-v3"] } },
		},
	},
};

const section = (w: ReturnType<typeof renderTediWiring>, id: string) =>
	w.sections.find((s) => s.id === id)!;

describe("renderTediWiring", () => {
	it("renders a full tedi with a generated marker first", () => {
		const setup: TediSetup = {
			tediId: "x",
			observedAt: "2026-10-21T00:00:00.000Z",
			items: [
				{
					id: "a",
					kind: "connection",
					state: "ready",
					label: "Ledger app",
					detail: "Connected",
					href: "/apps",
					capabilities: [
						{
							id: "read",
							label: "Read invoices",
							requiredScopes: [],
							state: "connected",
							verified: true,
							setupUrl: "/apps",
						},
					],
				},
			],
		};
		const w = renderTediWiring(base, setup);
		expect(w.markdown.split("\n")[0]).toMatch(/^<!-- generated:/);
		expect(section(w, "model").lines).toEqual([
			"Main model: kimi-k2",
			"Falls back to: deepseek-v3",
		]);
		expect(section(w, "tools").lines).toContain("  - Read invoices");
		expect(section(w, "schedules").lines[1]).toContain("(paused)");
		expect(section(w, "setup").lines[0]).toMatch(/^Nothing/);
	});

	it("handles a tedi with no tools, skills, or schedules", () => {
		const w = renderTediWiring({
			name: "bare",
			displayName: null,
			personality: null,
			installedSkills: null,
			installedPlugins: null,
			cronJobs: null,
			runtimeOverrides: null,
		});
		expect(section(w, "tools").lines).toEqual(["None configured."]);
		expect(section(w, "skills").lines).toEqual(["None configured."]);
		expect(section(w, "schedules").lines).toEqual(["Nothing is scheduled."]);
		expect(section(w, "model").lines[0]).toMatch(/organization default/);
		expect(w.title).toBe("bare: wiring");
	});

	it("lists missing connections under what needs setup", () => {
		const w = renderTediWiring(base, {
			tediId: "x",
			observedAt: "2026-10-21T00:00:00.000Z",
			items: [
				{
					id: "m",
					kind: "connection",
					state: "missing",
					label: "Mail app",
					detail: "Not connected",
					href: "/apps",
				},
				{
					id: "h",
					kind: "human",
					state: "needs_you",
					label: "Approve sender",
					detail: "Waiting",
					href: "/team",
				},
			],
		});
		expect(section(w, "setup").lines).toEqual([
			"Mail app (missing): Not connected",
			"Approve sender (needs a person): Waiting",
		]);
		expect(section(w, "tools").lines[0]).toBe("Mail app (missing)");
		expect(w.markdown).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
	});
});
