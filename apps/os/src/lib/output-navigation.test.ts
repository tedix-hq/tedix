import type { OsOutput } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	outputOpenAffordance,
	primaryOutputNavigationTarget,
} from "./output-navigation";

const OUTPUT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
