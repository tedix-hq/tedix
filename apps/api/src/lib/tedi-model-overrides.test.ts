import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import { getRuntimeProfileById } from "@tedix/db/queries/control-plane/definitions";
import type { RuntimeProfileConfig } from "@tedix/db/schema/control-plane";
import {
	chatModelRefFromRuntimeOverrides,
	rawChatModelOverride,
	tediChatTurnModel,
} from "./tedi-model-overrides";

vi.mock("@tedix/db/queries/control-plane/definitions", () => ({
	getRuntimeProfileById: vi.fn(),
}));

const db = {} as DbClient;
const profileId = "profile-example";
const pin = "azure-openai/gpt-6.1-sol";
const fallback = "azure-openai/gpt-6-luna";
const chatGeneration = { reasoningEffort: "high", maxOutputTokens: 4096 };
const getProfile = vi.mocked(getRuntimeProfileById);

function overrides(primary: unknown): Record<string, unknown> {
	return { agents: { defaults: { model: { primary } } } };
}

function profile(config: RuntimeProfileConfig) {
	return {
		id: profileId,
		organizationId: "org-example",
		name: "Example profile",
		slug: "example-profile",
		description: null,
		scope: "organization" as const,
		status: "active" as const,
		version: 1,
		supersedesRevisionId: null,
		rollbackOfRevisionId: null,
		changeSummary: null,
		publishedAt: null,
		publishedBy: null,
		createdAt: null,
		updatedAt: null,
		config,
	};
}

function expectProfileRead() {
	expect(getProfile).toHaveBeenCalledTimes(1);
	expect(getProfile).toHaveBeenCalledWith(db, profileId);
}

beforeEach(() => {
	getProfile.mockReset();
	getProfile.mockResolvedValue(
		profile({
			modelPolicy: {
				chatModelRef: fallback,
				generation: { chat: chatGeneration },
			},
		}),
	);
});

describe("tediChatTurnModel", () => {
	it("prefers a catalog pin while retaining profile chat generation", async () => {
		const runtimeOverrides = overrides(pin);
		expect(rawChatModelOverride(runtimeOverrides)).toBe(pin);
		expect(chatModelRefFromRuntimeOverrides(runtimeOverrides)).toBe(pin);
		expect(
			await tediChatTurnModel(db, {
				runtimeProfileId: profileId,
				runtimeOverrides,
			}),
		).toStrictEqual({ modelRef: pin, generation: chatGeneration });
		expectProfileRead();
	});

	it.each([
		{ label: "absent overrides", runtimeOverrides: null },
		{ label: "absent model branch", runtimeOverrides: {} },
		{
			label: "unknown catalog model",
			runtimeOverrides: overrides("azure-openai/no-such-model"),
		},
		{ label: "malformed pin", runtimeOverrides: overrides("not-a-ref") },
		{ label: "non-string pin", runtimeOverrides: overrides(42) },
	])("falls back to the profile for $label", async ({ runtimeOverrides }) => {
		expect(chatModelRefFromRuntimeOverrides(runtimeOverrides)).toBeNull();
		expect(
			await tediChatTurnModel(db, {
				runtimeProfileId: profileId,
				runtimeOverrides,
			}),
		).toStrictEqual({ modelRef: fallback, generation: chatGeneration });
		expectProfileRead();
	});

	it.each([pin, null])(
		"handles a missing profile with pin %s",
		async (primary) => {
			getProfile.mockResolvedValue(null);
			expect(
				await tediChatTurnModel(db, {
					runtimeProfileId: profileId,
					runtimeOverrides: overrides(primary),
				}),
			).toStrictEqual(
				primary ? { modelRef: pin, generation: undefined } : null,
			);
			expectProfileRead();
		},
	);

	it.each([pin, null])(
		"skips DB access without a profile identity, pin %s",
		async (primary) => {
			expect(
				await tediChatTurnModel(db, {
					runtimeProfileId: null,
					runtimeOverrides: overrides(primary),
				}),
			).toStrictEqual(
				primary ? { modelRef: pin, generation: undefined } : null,
			);
			expect(getProfile).not.toHaveBeenCalled();
		},
	);

	it.each([
		{},
		{ modelPolicy: {} },
		{ modelPolicy: { chatModelRef: "" } },
		{ modelPolicy: { chatModelRef: 42 } },
		{ modelPolicy: { cronModelRef: fallback, observerModelRef: pin } },
	])(
		"returns no selection for a profile without a chat model: %j",
		async (config) => {
			getProfile.mockResolvedValue(profile(config));
			expect(
				await tediChatTurnModel(db, {
					runtimeProfileId: profileId,
					runtimeOverrides: null,
				}),
			).toBeNull();
			expectProfileRead();
		},
	);

	it("rejects a malformed profile model reference", async () => {
		getProfile.mockResolvedValue(
			profile({ modelPolicy: { chatModelRef: "not-a-ref" } }),
		);
		expect(
			await tediChatTurnModel(db, {
				runtimeProfileId: profileId,
				runtimeOverrides: null,
			}),
		).toBeNull();
		expectProfileRead();
	});

	it.each([
		{ reasoningEffort: "unsupported" },
		{ maxOutputTokens: 0 },
		{ maxOutputTokens: 1.5 },
		{ maxOutputTokens: 128001 },
		{ temperature: 0.5 },
		null,
	])(
		"rejects invalid profile chat generation even with a valid pin: %j",
		async (chat) => {
			getProfile.mockResolvedValue(
				profile({
					modelPolicy: { chatModelRef: fallback, generation: { chat } },
				}),
			);
			for (const runtimeOverrides of [overrides(pin), null]) {
				expect(
					await tediChatTurnModel(db, {
						runtimeProfileId: profileId,
						runtimeOverrides,
					}),
				).toBeNull();
			}
			expect(getProfile.mock.calls).toStrictEqual([
				[db, profileId],
				[db, profileId],
			]);
		},
	);

	it.each([
		{ cron: { reasoningEffort: "low", maxOutputTokens: 64 } },
		{ cron: { reasoningEffort: "invalid" }, observer: { temperature: 0.5 } },
	])(
		"does not borrow or validate non-chat generation: %j",
		async (generation) => {
			getProfile.mockResolvedValue(
				profile({ modelPolicy: { chatModelRef: fallback, generation } }),
			);
			expect(
				await tediChatTurnModel(db, {
					runtimeProfileId: profileId,
					runtimeOverrides: null,
				}),
			).toStrictEqual({ modelRef: fallback, generation: undefined });
			expectProfileRead();
		},
	);

	it("selects chat generation independently of cron settings", async () => {
		getProfile.mockResolvedValue(
			profile({
				modelPolicy: {
					chatModelRef: fallback,
					generation: {
						chat: chatGeneration,
						cron: { reasoningEffort: "invalid" },
					},
				},
			}),
		);
		expect(
			await tediChatTurnModel(db, {
				runtimeProfileId: profileId,
				runtimeOverrides: null,
			}),
		).toStrictEqual({ modelRef: fallback, generation: chatGeneration });
		expectProfileRead();
	});

	it.each([pin, null])(
		"propagates profile DB failures with pin %s",
		async (primary) => {
			const error = new Error("profile read failed");
			getProfile.mockRejectedValue(error);
			await expect(
				tediChatTurnModel(db, {
					runtimeProfileId: profileId,
					runtimeOverrides: overrides(primary),
				}),
			).rejects.toBe(error);
			expectProfileRead();
		},
	);
});

describe("rawChatModelOverride", () => {
	it.each([
		"azure-openai/no-such-model",
		"unknown-provider/model",
		"not-a-ref",
		" ",
	])(
		"retains the invalid stored string %j for diagnosis while normalization rejects it",
		(primary) => {
			const runtimeOverrides = overrides(primary);
			expect(rawChatModelOverride(runtimeOverrides)).toBe(primary);
			expect(chatModelRefFromRuntimeOverrides(runtimeOverrides)).toBeNull();
			expect(getProfile).not.toHaveBeenCalled();
		},
	);

	it.each([
		null,
		undefined,
		{},
		overrides(""),
		overrides(42),
		overrides(false),
		overrides(null),
	])(
		"returns null when there is no stored nonempty string: %j",
		(runtimeOverrides) => {
			expect(rawChatModelOverride(runtimeOverrides)).toBeNull();
			expect(chatModelRefFromRuntimeOverrides(runtimeOverrides)).toBeNull();
			expect(getProfile).not.toHaveBeenCalled();
		},
	);
});
