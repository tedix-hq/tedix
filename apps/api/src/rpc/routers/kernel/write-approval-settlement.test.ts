import { describe, expect, it } from "vite-plus/test";
import {
	renderKernelWriteReceipt,
	kernelOutputReceipt,
	boundKernelWriteEvidence,
} from "./write-approval-settlement";

const id = "7c0723ef-fed7-4482-9454-4716ddfd5879";

describe("Home saved-output receipt", () => {
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
		{ toolName: "provider.create_document", output: { id, kind: "document" } },
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
