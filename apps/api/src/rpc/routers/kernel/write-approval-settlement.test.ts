import { describe, expect, it } from "vite-plus/test";
import {
	renderKernelWriteReceipt,
	kernelOutputReceipt,
	boundKernelWriteEvidence,
	kernelWriteCardContent,
	kernelWriteSummary,
} from "./write-approval-settlement";

const id = "7c0723ef-fed7-4482-9454-4716ddfd5879";

describe("Home write approval summary", () => {
	it("shares the one-line document summary with the approval message", () => {
		const proposal = {
			appSlug: "local-os",
			toolName: "os.create_os_output",
			args: { kind: "document", title: "Orion plan" },
		};
		expect(kernelWriteSummary(proposal)).toBe("Create document “Orion plan”");
		expect(
			kernelWriteCardContent({ approvalRequestId: id, proposal }).split(
				"\n",
			)[0],
		).toBe(`${kernelWriteSummary(proposal)}.`);
	});

	it.each(["os.set_os_sheet_range", "os__set_os_sheet_range"])(
		"names the cell rectangle and sheet for %s",
		(toolName) => {
			const content = kernelWriteCardContent({
				approvalRequestId: id,
				proposal: {
					appSlug: "local-os",
					toolName,
					outputTitle: "Budget",
					args: { outputId: id, startRow: 1, startColumn: 1, cells: [[42]] },
				},
			});
			const [summary, details] = content.split("### Details");
			expect(summary).toContain("Update cells B2 in “Budget”.");
			expect(summary).toContain("Reply “approve” or “yes”");
			expect(summary).not.toContain(id);
			expect(summary).not.toContain("{");
			expect(details).toContain(id);
			expect(details).toContain('"cells":[[42]]');
		},
	);

	it("handles ranges beyond column Z and multi-row writes", () => {
		const content = kernelWriteCardContent({
			approvalRequestId: id,
			proposal: {
				appSlug: "local-os",
				toolName: "os.set_os_sheet_range",
				args: {
					startRow: 0,
					startColumn: 26,
					cells: [
						[1, 2],
						[3, 4],
					],
				},
			},
		});
		expect(content.split("\n")[0]).toBe("Update cells AA1:AB2 in your sheet.");
	});

	it("names the created document and keeps markup out of its title", () => {
		const content = kernelWriteCardContent({
			approvalRequestId: id,
			proposal: {
				appSlug: "local-os",
				toolName: "os.create_os_output",
				args: { kind: "document", title: "**Project plan**\nDraft" },
			},
		});
		expect(content.split("\n")[0]).toBe(
			"Create document “Project plan Draft”.",
		);
	});

	it("keeps provider actions and their key arguments in plain words", () => {
		const content = kernelWriteCardContent({
			approvalRequestId: id,
			proposal: {
				appSlug: "fictional-mail",
				toolName: "mail__send_message",
				args: {
					to: "maya@example.com",
					subject: "Project plan",
					body: "Hello",
				},
			},
		});
		expect(content.split("\n")[0]).toBe(
			"Send message — to: maya@example.com; subject: Project plan.",
		);
	});
});

describe("Home saved-output receipt", () => {
	it.each(["kernel.rename_conversation", "kernel__rename_conversation"])(
		"renders the confirmed conversation title for %s",
		(toolName) => {
			expect(
				renderKernelWriteReceipt({
					toolName,
					appSlug: "local",
					data: { conversation: { id, title: "**Orion plan**\nDraft" } },
				}),
			).toBe("Renamed this conversation to “Orion plan Draft”.");
		},
	);

	it("renders per-app catalog installation outcomes", () => {
		expect(
			renderKernelWriteReceipt({
				toolName: "tenant.install_tenant_mcp_apps",
				appSlug: "acme-unified",
				data: {
					summary: "1 catalog app installed; 1 blocked or not found.",
					results: [
						{
							catalogAppName: "Google Calendar",
							status: "installed",
						},
						{
							catalogAppName: "Microsoft 365",
							status: "blocked",
							reason: "A platform operator must prepare its base app.",
						},
					],
				},
			}),
		).toBe(
			"1 catalog app installed; 1 blocked or not found.\n- Google Calendar: installed\n- Microsoft 365: blocked — A platform operator must prepare its base app.",
		);
	});

	it.each(["os.create_os_output", "os__create_os_output"])(
		"links the returned output for %s without rendering tool-authored markup",
		(toolName) => {
			expect(
				renderKernelWriteReceipt({
					toolName,
					appSlug: "my-local-os-unified",
					data: {
						output: {
							id,
							kind: "document",
							title: "[Unsafe](https://example.com)",
						},
					},
				}),
			).toBe(`Saved your document. [Open document](/outputs/${id}).`);
		},
	);

	it.each([
		["os.patch_os_document", "Updated “Q3 plan”. [Open document]"],
		["os__set_os_sheet_range", "Updated “Q3 plan”. [Open document]"],
		["os.patch_os_slides", "Updated “Q3 plan”. [Open document]"],
		["os.rename_os_output", "Renamed to “Q3 plan”. [Open document]"],
	])("renders a short human receipt for %s", (toolName, expected) => {
		const receipt = renderKernelWriteReceipt({
			toolName,
			appSlug: "my-local-os-unified",
			data: {
				output: { id, kind: "document", title: "Q3 *plan*" },
				revision: { id, outputId: id, content: { blocks: [] } },
			},
		});
		expect(receipt).toBe(`${expected}(/outputs/${id}).`);
		expect(receipt).not.toContain("{");
	});

	it("keeps tool-authored titles from becoming markup in edit receipts", () => {
		expect(
			renderKernelWriteReceipt({
				toolName: "os.patch_os_document",
				appSlug: "os",
				data: {
					output: {
						id,
						kind: "sheet",
						title: "[Unsafe](https://example.com)",
					},
				},
			}),
		).toBe(
			`Updated “Unsafehttps://example.com”. [Open sheet](/outputs/${id}).`,
		);
	});

	it.each([
		{ toolName: "provider.create_document", output: { id, kind: "document" } },
		{
			toolName: "provider.patch_os_document",
			output: { id, kind: "document", title: "x" },
		},
		{
			toolName: "os.create_os_output",
			output: { id: "../../settings", kind: "document" },
		},
		{ toolName: "os.create_os_output", output: { id, kind: "unknown" } },
		{ toolName: "os.create_os_output", output: null },
	])(
		"does not manufacture output links from unrelated or invalid results",
		({ toolName, output }) => {
			const receipt = renderKernelWriteReceipt({
				toolName,
				appSlug: "app",
				data: { output },
			});
			expect(receipt).toContain(`Executed ${toolName} on app:`);
			expect(receipt).not.toContain("](/outputs/");
		},
	);
});

describe("Home output authoring identity", () => {
	const revisionId = "8ce30f58-5a86-4e49-aea5-7a2dbccc34ea";
	const data = {
		output: { id, kind: "document" },
		revision: { id: revisionId, outputId: id },
	};
	it.each(["os.create_os_output", "os__create_os_output"])(
		"retains exact identity despite truncated result evidence for %s",
		(toolName) => {
			const result = {
				...data,
				rows: Array.from({ length: 10 }, () => ({
					a: "x".repeat(500),
					b: "y".repeat(500),
				})),
			};
			expect(
				boundKernelWriteEvidence({ appSlug: "local", toolName, data: result })
					?.data,
			).toMatchObject({ truncated: true });
			expect(kernelOutputReceipt({ toolName, data: result })).toEqual({
				outputId: id,
				revisionId,
			});
		},
	);
	it.each([
		{ toolName: "provider.create_document", data },
		{ toolName: "os.create_os_output", data: { output: data.output } },
		{
			toolName: "os.create_os_output",
			data: { ...data, revision: { id: revisionId, outputId: revisionId } },
		},
		{
			toolName: "os.create_os_output",
			data: { ...data, revision: { id: "not-a-uuid", outputId: id } },
		},
	])("does not infer lineage from unverified results", (input) => {
		expect(kernelOutputReceipt(input)).toBeNull();
	});
});
