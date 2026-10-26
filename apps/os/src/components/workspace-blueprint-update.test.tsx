import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	getBlueprint: vi.fn(),
	preview: vi.fn(),
	decide: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			blueprints: { get: api.getBlueprint },
			workspaces: {
				previewBlueprintUpgrade: api.preview,
				decideBlueprintUpgrade: api.decide,
			},
		},
	},
}));

import {
	BlueprintUpdateButton,
	BlueprintUpdateDialog,
	blueprintUpdateCandidate,
	blueprintUpdateChanges,
	useBlueprintUpdate,
} from "./workspace-blueprint-update";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BLUEPRINT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PINNED_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEXT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const workspace = {
	id: WORKSPACE_ID,
	name: "Support Desk",
	sourceBlueprintId: BLUEPRINT_ID,
	sourceBlueprintRevisionId: PINNED_ID,
	sourceBlueprintRevisionNumber: 1,
	blueprintDecision: null,
} as unknown as OsWorkspace;

const published = { id: NEXT_ID, revision: 2, publishedAt: "2026-10-01" };

describe("blueprintUpdateCandidate", () => {
	it("offers a newer published version", () => {
		expect(blueprintUpdateCandidate(workspace, published)).toEqual({
			id: NEXT_ID,
			revision: 2,
		});
	});

	it("stays quiet when up to date, unpublished, or hand-made", () => {
		expect(
			blueprintUpdateCandidate(workspace, { ...published, revision: 1 }),
		).toBeNull();
		expect(
			blueprintUpdateCandidate(workspace, { ...published, publishedAt: null }),
		).toBeNull();
		expect(
			blueprintUpdateCandidate(
				{ ...workspace, sourceBlueprintRevisionNumber: null },
				published,
			),
		).toBeNull();
	});

	it("stays quiet after the owner chose to stay on this version for that update", () => {
		const stayed = {
			...workspace,
			blueprintDecision: {
				decision: "stay_pinned",
				reviewedRevisionId: NEXT_ID,
			},
		} as unknown as OsWorkspace;
		expect(blueprintUpdateCandidate(stayed, published)).toBeNull();
		// A later version is a new update, so the marker comes back.
		expect(
			blueprintUpdateCandidate(stayed, {
				id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				revision: 3,
				publishedAt: "2026-10-20",
			}),
		).not.toBeNull();
	});
});

describe("blueprintUpdateChanges", () => {
	it("names each change in plain words and skips what stays the same", () => {
		expect(
			blueprintUpdateChanges({
				gadgetChanges: [
					{ name: "Follow-up List", change: "added" },
					{ name: "Ticket Triage Board", change: "unchanged" },
					{ name: "Old Board", change: "removed" },
				],
				requirementChanges: [
					{ subject: "gmail", change: "added" },
					{ subject: "weekly-report", change: "unchanged" },
				] as never,
			}),
		).toEqual([
			"New app: Follow-up List",
			"Removed app (archived, not deleted): Old Board",
			"Now needs gmail",
		]);
	});
});

/** The marker and dialog wired the way the workspace header wires them. */
function UpdateMarker() {
	const update = useBlueprintUpdate(workspace);
	const [open, setOpen] = useState(false);
	if (!update) return null;
	return (
		<>
			<BlueprintUpdateButton
				compact={false}
				revision={update.candidate.revision}
				blueprintName={update.blueprintName}
				onOpen={() => setOpen(true)}
			/>
			{open ? (
				<BlueprintUpdateDialog
					workspace={workspace}
					blueprintName={update.blueprintName}
					candidate={update.candidate}
					onOpenChange={setOpen}
				/>
			) : null}
		</>
	);
}

describe("blueprint update marker", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.clearAllMocks();
	});

	async function settle() {
		await act(async () => {
			for (let tick = 0; tick < 5; tick += 1)
				await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	async function render() {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		act(() =>
			root.render(
				<QueryClientProvider client={client}>
					<UpdateMarker />
				</QueryClientProvider>,
			),
		);
		cleanups.push(() => {
			act(() => root.unmount());
			container.remove();
		});
		await settle();
		return document.body;
	}

	function button(root: HTMLElement, label: string) {
		const match = [...root.querySelectorAll("button")].find((node) =>
			node.textContent?.includes(label),
		);
		if (!match) throw new Error(`button not found: ${label}`);
		return match;
	}

	it("previews the update and applies it", async () => {
		api.getBlueprint.mockResolvedValue({
			blueprint: { id: BLUEPRINT_ID, name: "Support Desk Starter" },
			currentRevision: published,
		});
		api.preview.mockResolvedValue({
			report: {
				gadgetChanges: [{ name: "Follow-up List", change: "added" }],
				requirementChanges: [],
				applyAllowed: true,
				blockingReasons: [],
				consentReasons: [],
			},
		});
		api.decide.mockResolvedValue({});
		const root = await render();
		act(() => button(root, "Update available").click());
		await settle();
		expect(api.preview).toHaveBeenCalledWith(
			{ workspaceId: WORKSPACE_ID, candidateRevisionId: NEXT_ID },
			expect.anything(),
		);
		expect(root.textContent).toContain("Update to version 2?");
		expect(root.textContent).toContain("New app: Follow-up List");
		act(() => button(root, "Apply update").click());
		await settle();
		expect(api.decide).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			decision: "apply",
			candidateRevisionId: NEXT_ID,
		});
	});

	it("says why an update can't be applied and still lets the owner stay", async () => {
		api.getBlueprint.mockResolvedValue({
			blueprint: { id: BLUEPRINT_ID, name: "Support Desk Starter" },
			currentRevision: published,
		});
		api.preview.mockResolvedValue({
			report: {
				gadgetChanges: [],
				requirementChanges: [],
				applyAllowed: false,
				blockingReasons: ["Skill weekly-report version 4 is missing"],
				consentReasons: [],
			},
		});
		api.decide.mockResolvedValue({});
		const root = await render();
		act(() => button(root, "Update available").click());
		await settle();
		expect(root.textContent).toContain("This update can't be applied yet");
		expect(button(root, "Apply update").disabled).toBe(true);
		act(() => button(root, "Stay on version 1").click());
		await settle();
		expect(api.decide).toHaveBeenCalledWith(
			expect.objectContaining({ decision: "stay_pinned" }),
		);
	});
});
