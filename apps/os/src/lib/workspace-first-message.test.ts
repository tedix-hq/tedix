// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
	holdWorkspaceFirstMessage,
	takeWorkspaceFirstMessage,
	WORKSPACE_NAME_MAX_CHARS,
	workspaceNameFromQuestion,
} from "./workspace-first-message";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("workspaceNameFromQuestion", () => {
	it("keeps the first six words without trailing punctuation", () => {
		expect(
			workspaceNameFromQuestion(
				"How should we plan the spring offsite in Lisbon?",
			),
		).toBe("How should we plan the spring");
		expect(workspaceNameFromQuestion("Compare our Q3 numbers?")).toBe(
			"Compare our Q3 numbers",
		);
	});

	it("uses the first non-empty line and collapses spacing", () => {
		expect(
			workspaceNameFromQuestion("\n\n   Draft   the   launch email.\nDetails…"),
		).toBe("Draft the launch email");
	});

	it("caps long words at the contract limit", () => {
		const name = workspaceNameFromQuestion("x".repeat(500));
		expect(name).toHaveLength(WORKSPACE_NAME_MAX_CHARS);
	});

	it("falls back to a plain name when nothing usable is left", () => {
		expect(workspaceNameFromQuestion("   ")).toBe("New workspace");
		expect(workspaceNameFromQuestion("?!")).toBe("New workspace");
	});
});

describe("held first message", () => {
	beforeEach(() => window.sessionStorage.clear());

	it("is taken once, only for the conversation it was held for", () => {
		holdWorkspaceFirstMessage(WORKSPACE_ID, "Plan the offsite");
		expect(takeWorkspaceFirstMessage(WORKSPACE_ID, "home:os:x")).toBeNull();
		expect(takeWorkspaceFirstMessage(WORKSPACE_ID, null)).toBe(
			"Plan the offsite",
		);
		expect(takeWorkspaceFirstMessage(WORKSPACE_ID, null)).toBeNull();
	});

	it("drops an unreadable entry", () => {
		window.sessionStorage.setItem(
			`tedix.workspace-chat.pending.${WORKSPACE_ID}`,
			"{not json",
		);
		expect(takeWorkspaceFirstMessage(WORKSPACE_ID, null)).toBeNull();
		expect(
			window.sessionStorage.getItem(
				`tedix.workspace-chat.pending.${WORKSPACE_ID}`,
			),
		).toBeNull();
	});
});
