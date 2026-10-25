import type { DbClient } from "@tedix/db/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	directRenameKernelResult,
	nameBeforeRename,
	resolveDirectRename,
} from "./direct-rename";
import { correctWriteRoute } from "./write-tool-intent";

const mocks = vi.hoisted(() => ({
	listOsGadgets: vi.fn(),
	listKernelRuntimeRuns: vi.fn(),
	getAuditEventsByResource: vi.fn(),
}));
vi.mock("@tedix/db/queries/os-workspaces/gadgets", () => ({
	listOsGadgets: mocks.listOsGadgets,
}));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	listKernelRuntimeRuns: mocks.listKernelRuntimeRuns,
}));
vi.mock("@tedix/db/queries/audit", () => ({
	getAuditEventsByResource: mocks.getAuditEventsByResource,
}));
vi.mock("@tedix/db/queries/apps", () => ({ getAppBySlugForOrg: vi.fn() }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: vi.fn(),
}));

const db = {} as DbClient;
const workspaceId = "22222222-2222-4222-8222-222222222222";
const appId = "33333333-3333-4333-8333-333333333333";
const sheetId = "44444444-4444-4444-8444-444444444444";
const sheetSelected = {
	workspaceId,
	workpiece: { kind: "output" as const, id: sheetId },
};
const base = {
	organizationId: "org-orchard",
	conversationId: "home:os:chat-1",
	runId: "run-now",
};

beforeEach(() => vi.resetAllMocks());

describe("a request naming the app while a sheet is attached", () => {
	it("renames the Workspace app, not the attached sheet", async () => {
		mocks.listOsGadgets.mockResolvedValue([
			{ id: appId, name: "Harvest · Daily review" },
		]);
		const resolved = await resolveDirectRename(db, {
			...base,
			content: `[[tedix-context:output:${sheetId}:Output%20resource]]\n\nrename the app gadget to "Harvest Review App"`,
			workspaceContext: sheetSelected,
		});
		expect(resolved?.intent).toEqual({
			capability: "gadgets.rename",
			toolName: "os.rename_os_gadget",
			args: { workspaceId, gadgetId: appId, name: "Harvest Review App" },
		});
		expect(mocks.listOsGadgets).toHaveBeenCalledWith(db, "org-orchard", {
			workspaceId,
			status: "active",
			limit: 50,
		});
	});

	it("does not guess between several apps, and never routes the app request to the sheet tool", async () => {
		mocks.listOsGadgets.mockResolvedValue([
			{ id: appId, name: "Daily review" },
			{ id: "other", name: "Weekly digest" },
		]);
		const content = "rename the app gadget to Harvest Review App";
		expect(
			await resolveDirectRename(db, {
				...base,
				content,
				workspaceContext: sheetSelected,
			}),
		).toBeNull();
		const route = {
			routeKind: "propose_tool_write",
			toolIntent: { capability: "outputs.update" },
		};
		expect(
			correctWriteRoute(route, content, sheetSelected).toolIntent.capability,
		).toBe("gadgets.rename");
	});

	it("picks the app the request names among several", async () => {
		mocks.listOsGadgets.mockResolvedValue([
			{ id: appId, name: "Daily review" },
			{ id: "other", name: "Weekly digest" },
		]);
		const resolved = await resolveDirectRename(db, {
			...base,
			content: "rename the Daily review app to Harvest Review",
			workspaceContext: sheetSelected,
		});
		expect(resolved?.intent.args).toMatchObject({ gadgetId: appId });
	});
});

describe("reverse that change", () => {
	const renamedRun = {
		id: "run-before",
		metadata: {
			kernelWriteExecutedAt: "2026-10-25T17:37:30.000Z",
			kernelWriteProposal: {
				appSlug: "orchard-unified",
				toolName: "os.rename_os_output",
				args: { outputId: sheetId, title: "Harvest Review App" },
			},
		},
	};

	it("restores the name the item had before the conversation's last rename", async () => {
		mocks.listKernelRuntimeRuns.mockResolvedValue([
			{ id: "run-now", metadata: {} },
			{ id: "run-question", metadata: {} },
			renamedRun,
		]);
		mocks.getAuditEventsByResource.mockResolvedValue([
			{
				action: "os.output.renamed",
				metadata: { title: "Harvest Review App" },
			},
			{ action: "os.output.revised", metadata: {} },
			{ action: "os.output.created", metadata: { title: "Opportunities" } },
		]);
		const resolved = await resolveDirectRename(db, {
			...base,
			content: `[[tedix-context:output:${sheetId}:Output%20resource]]\n\nthat was wrong. reverse that change.`,
			workspaceContext: sheetSelected,
		});
		expect(resolved).toEqual({
			reason: "undo",
			appSlug: "orchard-unified",
			intent: {
				capability: "outputs.rename",
				toolName: "os.rename_os_output",
				args: { outputId: sheetId, title: "Opportunities" },
			},
		});
		expect(mocks.getAuditEventsByResource).toHaveBeenCalledWith(
			db,
			"org-orchard",
			"os_output",
			sheetId,
			50,
		);
	});

	it("undoes nothing when the latest executed write was not a rename", async () => {
		mocks.listKernelRuntimeRuns.mockResolvedValue([
			{
				id: "run-sheet-edit",
				metadata: {
					kernelWriteExecutedAt: "2026-10-25T17:40:00.000Z",
					kernelWriteProposal: {
						appSlug: "orchard-unified",
						toolName: "os.set_os_sheet_range",
						args: { outputId: sheetId },
					},
				},
			},
			renamedRun,
		]);
		expect(
			await resolveDirectRename(db, { ...base, content: "undo that" }),
		).toBeNull();
		expect(mocks.getAuditEventsByResource).not.toHaveBeenCalled();
	});

	it("ignores ordinary requests", async () => {
		expect(
			await resolveDirectRename(db, {
				...base,
				content: "revert the invoice total to 40 EUR in the sheet",
			}),
		).toBeNull();
		expect(mocks.listKernelRuntimeRuns).not.toHaveBeenCalled();
	});

	it("reads the name before a later manual rename", async () => {
		mocks.getAuditEventsByResource.mockResolvedValue([
			{ action: "os.output.renamed", metadata: { title: "Opportunitites" } },
			{
				action: "os.output.renamed",
				metadata: { title: "Harvest Review App" },
			},
			{ action: "os.output.renamed", metadata: { title: "Opportunities" } },
			{ action: "os.output.created", metadata: { title: "Draft" } },
		]);
		expect(
			await nameBeforeRename(db, {
				organizationId: "org-orchard",
				kind: "output",
				id: sheetId,
				renamedTo: "Harvest Review App",
			}),
		).toBe("Opportunities");
	});
});

it("plans a rename when the router produced no decision", () => {
	const result = directRenameKernelResult(
		{
			reason: "rename",
			intent: {
				capability: "gadgets.rename",
				toolName: "os.rename_os_gadget",
				args: { workspaceId, gadgetId: appId, name: "Harvest Review App" },
			},
		},
		"orchard-unified",
	);
	expect(result.route).toMatchObject({
		routeKind: "propose_tool_write",
		toolIntent: { appSlug: "orchard-unified", capability: "gadgets.rename" },
	});
});
