import type { OsOutput } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	assistantLinkedOutputIds,
	outputIdFromHref,
	outputOpenAffordance,
	primaryOutputNavigationTarget,
} from "./output-navigation";

const OUTPUT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECOND_OUTPUT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("output links", () => {
	it("reads the output id of a same-origin output route only", () => {
		expect(outputIdFromHref(`/outputs/${OUTPUT_ID}`)).toBe(OUTPUT_ID);
		expect(outputIdFromHref(`/outputs/${OUTPUT_ID}?view=source`)).toBe(
			OUTPUT_ID,
		);
		expect(outputIdFromHref("/outputs")).toBeNull();
		expect(outputIdFromHref(`/workspace/${OUTPUT_ID}`)).toBeNull();
		expect(outputIdFromHref(`https://x.test/outputs/${OUTPUT_ID}`)).toBeNull();
		expect(outputIdFromHref(undefined)).toBeNull();
	});

	it("collects output links from assistant messages, never the operator's", () => {
		expect(
			assistantLinkedOutputIds([
				{ role: "user", content: `see [mine](/outputs/${SECOND_OUTPUT_ID})` },
				{
					role: "assistant",
					content: `Saved your presentation. [Open presentation](/outputs/${OUTPUT_ID}).`,
				},
				{ role: "assistant", content: `Again [here](/outputs/${OUTPUT_ID})` },
				{ role: "assistant", content: "No link, just /outputs/ text." },
			]),
		).toEqual([OUTPUT_ID]);
	});
});

const output: OsOutput = {
	id: OUTPUT_ID,
	organizationId: "org-1",
	workspaceId: WORKSPACE_ID,
	kind: "document",
	title: "Weekly report",
	status: "active",
	currentRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	createdByKind: "user",
	createdById: "user-1",
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-12T10:00:00.000Z",
};

describe("primaryOutputNavigationTarget", () => {
	it("opens active workspace-backed outputs in the collaborative workbench", () => {
		expect(
			primaryOutputNavigationTarget(
				{ id: OUTPUT_ID, workspaceId: WORKSPACE_ID },
				new Set([WORKSPACE_ID]),
			),
		).toEqual({
			kind: "workspace",
			workspaceId: WORKSPACE_ID,
			search: {
				workpiece: `output:${OUTPUT_ID}`,
				pane: "workpiece",
			},
		});
	});

	it("keeps organization-level and unavailable-workspace outputs standalone", () => {
		expect(
			primaryOutputNavigationTarget(
				{ id: OUTPUT_ID, workspaceId: null },
				new Set([WORKSPACE_ID]),
			),
		).toEqual({ kind: "standalone", outputId: OUTPUT_ID });
		expect(
			primaryOutputNavigationTarget(
				{ id: OUTPUT_ID, workspaceId: WORKSPACE_ID },
				new Set(),
			),
		).toEqual({ kind: "standalone", outputId: OUTPUT_ID });
	});
});

describe("outputOpenAffordance", () => {
	it("names the workbench destination for a live workspace-backed output", () => {
		expect(
			outputOpenAffordance({
				output,
				workspace: { id: WORKSPACE_ID, name: "Q3 planning", status: "active" },
			}),
		).toEqual({
			target: {
				kind: "workspace",
				workspaceId: WORKSPACE_ID,
				search: { workpiece: `output:${OUTPUT_ID}`, pane: "workpiece" },
			},
			cardLabel: "Open Weekly report in Q3 planning",
			menuLabel: "Open in workspace",
		});
	});

	it("gives a workspace-less output the same affordance at its own route", () => {
		expect(
			outputOpenAffordance({
				output: { ...output, workspaceId: null },
				workspace: null,
			}),
		).toEqual({
			target: { kind: "standalone", outputId: OUTPUT_ID },
			cardLabel: "Open Weekly report",
			menuLabel: "Open output",
		});
	});

	it("keeps an archived workspace's output on its durable detail route", () => {
		expect(
			outputOpenAffordance({
				output,
				workspace: {
					id: WORKSPACE_ID,
					name: "Archived planning",
					status: "archived",
				},
			}).target,
		).toEqual({ kind: "standalone", outputId: OUTPUT_ID });
	});
});
