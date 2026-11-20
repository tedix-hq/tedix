import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import { expect, it } from "vite-plus/test";
import { homeChatPickedTediId } from "./home-chat-model";

const run = (
	createdAt: string,
	overrides: Partial<HomeRun> = {},
	metadata: Record<string, unknown> = {},
): HomeRun => ({
	id: createdAt,
	organizationId: "org",
	conversationId: "home:os:1",
	status: "completed",
	createdAt,
	...overrides,
	metadata: { pushRecipient: { personStarted: true }, ...metadata },
});

it("keeps the tedi of the person's latest message for the conversation", () => {
	const picked = run(
		"2026-11-20T10:02:00.000Z",
		{ delegatedTediId: "cto" },
		{ pickedByPerson: true },
	);
	// A run-ended notice and a hand-over Home chose are not the person's pick.
	const notice = run("2026-11-20T10:03:00.000Z", {}, { pushRecipient: null });
	expect(homeChatPickedTediId("home:os:1", [notice, picked])).toBe("cto");
	expect(homeChatPickedTediId("home:os:2", [notice, picked])).toBeNull();

	const toHome = run("2026-11-20T10:05:00.000Z", { delegatedTediId: "ops" });
	expect(homeChatPickedTediId("home:os:1", [picked, toHome])).toBeNull();
});
