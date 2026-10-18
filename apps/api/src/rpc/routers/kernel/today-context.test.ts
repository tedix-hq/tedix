import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import { listOsWorkApps } from "@tedix/db/queries/os-workspaces/gadgets";
import {
	getOsOutput,
	getOsOutputRevision,
} from "@tedix/db/queries/os-workspaces/outputs";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { readSavedToday } from "./today-context";

vi.mock("@tedix/db/queries/os-workspaces/gadgets", () => ({
	listOsWorkApps: vi.fn(),
}));
vi.mock("@tedix/db/queries/os-workspaces/outputs", () => ({
	getOsOutput: vi.fn(),
	getOsOutputRevision: vi.fn(),
}));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", () => ({
	getOsWorkspace: vi.fn(),
}));
const db = {} as DbClient;
const outputId = "11111111-1111-4111-8111-111111111111";
const content = {
	kind: "document",
	blocks: [
		{ type: "paragraph", text: "Help the team." },
		{ type: "paragraph", text: "Updated 18 October at 06:45." },
		{ type: "paragraph", text: "6 projects quiet" },
		{
			type: "table",
			headers: [
				"Project",
				"Goal",
				"Progress",
				"Running",
				"Needs you",
				"Project link",
				"Receipts link",
				"Deck link",
			],
			rows: [
				[
					"Website",
					"Make it useful.",
					"1 task finished.",
					"Running now: Review (Codex)",
					"2",
					"/work/projects/website",
					"/work?view=feed&project=website",
					"/work?view=deck&project=website",
				],
			],
		},
	],
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(listOsWorkApps).mockResolvedValue([
		{
			revision: {
				manifest: JSON.stringify({
					entry: "tedix:app/activity-feed",
					config: {
						version: 1,
						scope: "organization",
						projects: [],
						today: {
							outputId,
							skillId: outputId,
							tediId: outputId,
							personId: "fictional-person",
						},
					},
				}),
			},
		},
	] as never);
	vi.mocked(getOsOutput).mockResolvedValue({
		id: outputId,
		currentRevisionId: "edition",
		workspaceId: "shared",
		status: "active",
	} as never);
	vi.mocked(getOsWorkspace).mockResolvedValue({
		visibility: "org",
		status: "active",
	} as never);
	vi.mocked(getOsOutputRevision).mockResolvedValue({
		outputId,
		content: JSON.stringify(content),
		accessEnvelope: '{"version":1,"sources":[]}',
	} as never);
});
it("reads the saved Feed edition without recomputing progress, retaining its date and links", async () => {
	const text = await readSavedToday(db, "fictional-org", "fictional-person");
	expect(text).toContain("Help the team.");
	expect(text).toContain("Updated 18 October at 06:45.");
	expect(text).toContain("[Website](/work/projects/website)");
	expect(text).toContain("[1 task finished.](/work?view=feed&project=website)");
	expect(text).toContain("6 projects quiet");
	expect(listOsWorkApps).toHaveBeenCalledWith(
		db,
		"fictional-org",
		{ userIds: [] },
		201,
	);
});
it("does not read another person's configured digest", async () => {
	expect(
		await readSavedToday(db, "fictional-org", "another-person"),
	).toBeNull();
	expect(getOsOutput).not.toHaveBeenCalled();
});
it("excludes private workspaces even when the Feed refers to one", async () => {
	vi.mocked(getOsWorkspace).mockResolvedValue({
		visibility: "private",
		status: "active",
	} as never);
	expect(
		await readSavedToday(db, "fictional-org", "fictional-person"),
	).toBeNull();
	expect(getOsOutputRevision).not.toHaveBeenCalled();
});
it("does not inject content carrying derived resource restrictions", async () => {
	vi.mocked(getOsOutputRevision).mockResolvedValue({
		outputId,
		content: JSON.stringify(content),
		accessEnvelope: '{"version":1,"sources":[{}]}',
	} as never);
	expect(
		await readSavedToday(db, "fictional-org", "fictional-person"),
	).toBeNull();
});
