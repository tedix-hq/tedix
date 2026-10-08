import { describe, expect, it } from "vite-plus/test";

import {
	ALLOW_FROM_HELP,
	DM_POLICY_OPTIONS,
	GROUP_POLICY_OPTIONS,
	liveChannelValues,
	parseAllowFrom,
	policyHelp,
} from "./tedi-settings-page";

/**
 * The runtime (`apps/tedi-runtime/src/telegram-turn-policy.ts`) reads the
 * stored enum values; the page may only change how they are described.
 */
describe("Telegram channel policy wording", () => {
	it("keeps the stored enum values the runtime reads", () => {
		expect(DM_POLICY_OPTIONS.map((option) => option.value)).toEqual([
			"pairing",
			"allowlist",
			"open",
			"disabled",
		]);
		expect(GROUP_POLICY_OPTIONS.map((option) => option.value)).toEqual([
			"allowlist",
			"open",
			"disabled",
		]);
	});

	it("labels pairing as allowlist because the runtime treats it that way", () => {
		expect(policyHelp(DM_POLICY_OPTIONS, "pairing")).toMatch(/like Allowlist/);
		expect(
			DM_POLICY_OPTIONS.find((option) => option.value === "pairing")?.label,
		).toBe("Allowlist (pairing not yet available)");
	});

	it("says what open and allowlist mean for unverified senders", () => {
		for (const options of [DM_POLICY_OPTIONS, GROUP_POLICY_OPTIONS]) {
			expect(policyHelp(options, "open")).toMatch(/short reply only/);
			expect(policyHelp(options, "open")).toMatch(/nothing is learned/);
			expect(policyHelp(options, "allowlist")).toMatch(/full tool set/);
			expect(policyHelp(options, "disabled")).toMatch(/dropped/);
		}
		expect(ALLOW_FROM_HELP).toBe(
			"Telegram user id or @username, one per line.",
		);
	});

	it("round-trips allowlists as one entry per line", () => {
		expect(parseAllowFrom(" 12345 \n\n@Alice\r\n")).toEqual([
			"12345",
			"@Alice",
		]);
		const values = liveChannelValues({
			telegram: {
				enabled: true,
				dmPolicy: "open",
				allowFrom: ["12345", "@alice"],
				groupAllowFrom: ["@bob"],
				requireMention: false,
			},
		});
		expect(values.telegram).toMatchObject({
			dmPolicy: "open",
			allowFrom: "12345\n@alice",
			groupPolicy: "allowlist",
			groupAllowFrom: "@bob",
			requireMention: false,
		});
		expect(liveChannelValues(undefined).telegram).toMatchObject({
			dmPolicy: "pairing",
			allowFrom: "",
			groupAllowFrom: "",
			requireMention: true,
		});
	});
});
