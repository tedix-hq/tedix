import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	history: vi.fn(),
	get: vi.fn(),
	revise: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			outputs: { history: api.history, get: api.get, revise: api.revise },
			gadgets: {},
			workspaces: {},
		},
	},
}));
vi.mock("@/components/output-content", () => ({
	SavedOutputContentView: ({ content }: { content: { text: string } }) => (
		<div data-saved-content>{content.text}</div>
	),
}));

import {
	OutputVersionHistoryDialog,
	versionSavedBy,
} from "./output-version-history";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const outputId = "22222222-2222-4222-8222-222222222222";
const version = (revision: number, extra: Record<string, unknown> = {}) => ({
	id: `revision-${revision}`,
	outputId,
	revision,
	note: null,
	createdByKind: "user",
	createdById: "user-1",
	createdAt: "2026-11-17T10:00:00.000Z",
	...extra,
});
const versions = [
	version(3, { author: { name: "Ada", self: true } }),
	version(2, { createdByKind: "tedi", note: "Tightened the summary" }),
	version(1, { author: { name: "Grace Hopper", self: false } }),
];

afterEach(() => {
	document.body.replaceChildren();
	vi.clearAllMocks();
});

const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

/** Let queries and effects settle until `ready` holds, so a busy machine cannot race the test. */
async function until(ready: () => boolean) {
	for (let turn = 0; turn < 200 && !ready(); turn++) await settle();
}

async function setup() {
	api.history.mockImplementation(async (input: { revision?: number }) =>
		input.revision
			? {
					revisions: [
						{
							...version(input.revision),
							content: { text: `Body of version ${input.revision}` },
						},
					],
					nextBeforeRevision: null,
					pending: [],
				}
			: { revisions: versions, nextBeforeRevision: null, pending: [] },
	);
	api.get.mockResolvedValue({ currentRevision: { id: "revision-3" } });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const invalidate = vi
		.spyOn(client, "invalidateQueries")
		.mockResolvedValue(undefined);
	const onClose = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<OutputVersionHistoryDialog
					outputId={outputId}
					title="Plan"
					onClose={onClose}
				/>
			</QueryClientProvider>,
		),
	);
	await until(() => document.querySelector("[data-version]") !== null);
	const click = async (label: string) => {
		const button = [
			...document.querySelectorAll<HTMLButtonElement>("button"),
		].find(
			(node) =>
				node.getAttribute("aria-label") === label ||
				node.textContent?.trim() === label,
		);
		expect(button, label).toBeDefined();
		await act(async () => button!.click());
		await settle();
	};
	const row = (revision: number) =>
		document.querySelector<HTMLElement>(`[data-version="${revision}"]`)!;
	return { click, row, invalidate, onClose };
}

describe("OutputVersionHistoryDialog", () => {
	it("lists every version with its number, who saved it, when and its note", async () => {
		const view = await setup();
		expect(api.history.mock.calls[0]![0]).toEqual({
			outputId,
			beforeRevision: undefined,
		});
		expect(view.row(3).textContent).toContain("Version 3");
		expect(view.row(3).textContent).toContain("Current");
		expect(view.row(3).textContent).toContain("You");
		expect(view.row(2).textContent).toContain("An agent");
		expect(view.row(2).textContent).toContain("Tightened the summary");
		expect(view.row(1).textContent).toContain("Grace Hopper");
		expect(view.row(1).querySelector("time")?.getAttribute("datetime")).toBe(
			"2026-11-17T10:00:00.000Z",
		);
		// The current version has nothing to restore to.
		expect(view.row(3).textContent).not.toContain("Restore");
		expect(view.row(2).textContent).toContain("Restore this version");
	});

	it("opens a version to read without saving anything", async () => {
		const view = await setup();
		await view.click("View version 2");
		await until(() => document.querySelector("[data-saved-content]") !== null);
		expect(api.history.mock.calls.at(-1)![0]).toEqual({
			outputId,
			revision: 2,
		});
		expect(document.querySelector("[data-saved-content]")?.textContent).toBe(
			"Body of version 2",
		);
		expect(document.body.textContent).toContain("Nothing here can be edited");
		expect(api.revise).not.toHaveBeenCalled();
		await view.click("All versions");
		expect(view.row(1)).not.toBeNull();
	});

	it("restores a version as a new version after a confirmation", async () => {
		api.revise.mockResolvedValue({});
		const view = await setup();
		await view.click("Restore version 1");
		expect(document.body.textContent).toContain("Nothing is deleted");
		expect(api.revise).not.toHaveBeenCalled();
		await view.click("Restore");
		await until(() => view.invalidate.mock.calls.length > 0);
		expect(api.revise).toHaveBeenCalledWith({
			outputId,
			content: { text: "Body of version 1" },
			expectedRevisionId: "revision-3",
			note: "Restored version 1",
		});
		expect(view.invalidate).toHaveBeenCalledTimes(1);
	});

	it("says plainly when a view-only person may not restore", async () => {
		api.revise.mockRejectedValue(
			Object.assign(new Error("Missing permission"), { code: "FORBIDDEN" }),
		);
		const view = await setup();
		await view.click("Restore version 2");
		await view.click("Restore");
		await until(() => document.querySelector("[data-confirm-error]") !== null);
		expect(
			document.querySelector("[data-confirm-error]")?.textContent,
		).toContain("You are not allowed to restore this version");
		expect(view.invalidate).not.toHaveBeenCalled();
	});
});

describe("versionSavedBy", () => {
	it("names share-link visitors, automations and unknown people", () => {
		const base = { revision: 1, note: null, createdAt: "" };
		expect(
			versionSavedBy({
				...base,
				createdByKind: "service",
				savedBy: { name: null, email: "guest@example.test" },
			}),
		).toBe("guest@example.test (share link)");
		expect(versionSavedBy({ ...base, createdByKind: "service" })).toBe(
			"An automation",
		);
		expect(versionSavedBy({ ...base, createdByKind: "user" })).toBe("A person");
		expect(versionSavedBy({ ...base, createdByKind: "external_agent" })).toBe(
			"An agent",
		);
	});
});
