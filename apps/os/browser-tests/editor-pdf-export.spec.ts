import assert from "node:assert/strict";
import { startEditorTabs } from "./doc-editor-tabs";

for (const kind of ["document", "sheet"] as const) {
	const tabs = await startEditorTabs({
		kind,
		...(kind === "sheet"
			? {
					content: { kind: "sheet", columns: ["Amount"], rows: [[42]] },
					ready: "td[data-row]",
				}
			: {}),
	});
	try {
		const { page, frame } = await tabs.open();
		await page.route(
			"**/api/rpc/osWorkspaces/outputs/export",
			async (route) => {
				const input = route.request().postDataJSON().json;
				await route.fulfill({
					json: {
						json: {
							url: new URL("/os-exports/editor.pdf", page.url()).href,
							revision: input.expectedRevision,
							format: "pdf",
						},
					},
				});
			},
		);
		await page.route("**/os-exports/editor.pdf", (route) =>
			route.fulfill({
				contentType: "application/pdf",
				headers: { "Content-Disposition": 'attachment; filename="editor.pdf"' },
				body: "%PDF-1.4\n%%EOF",
			}),
		);
		for (const revisionHeader of [false, true]) {
			if (kind === "document") {
				if (!(await frame.locator('.doc-menu[aria-label="More"]').isVisible()))
					await frame
						.getByRole("button", { name: "More", exact: true })
						.click();
			} else await frame.locator("#download").click();
			const label = revisionHeader ? "PDF with title and revision" : "PDF";
			const request = page.waitForRequest((request) =>
				request.url().endsWith("/api/rpc/osWorkspaces/outputs/export"),
			);
			const download = page.waitForEvent("download");
			await frame
				.getByRole("menuitem", {
					name: kind === "document" ? `Export as ${label}` : label,
					exact: true,
				})
				.click();
			const input = (await request).postDataJSON().json;
			assert.equal(input.outputId, tabs.outputId);
			assert.equal(input.expectedRevision, (await tabs.saved()).revision);
			assert.equal(input.format, "pdf");
			assert.equal(input.revisionHeader, revisionHeader ? true : undefined);
			assert.equal((await download).suggestedFilename(), "editor.pdf");
		}
		console.log(
			`${kind}: plain and titled PDF traverse the editor sandbox and host with the saved revision`,
		);
	} finally {
		await tabs.stop();
	}
}
