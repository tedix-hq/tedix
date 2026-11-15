import assert from "node:assert/strict";
import { startEditorTabs } from "./doc-editor-tabs";

const content = {
	kind: "document",
	blocks: [],
	file: {
		workspaceId: "00000030-0000-4000-8000-000000000001",
		resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	},
};
const tabs = await startEditorTabs({
	kind: "document",
	content,
	ready: ".doc-toolbar[hidden]",
	readyState: "attached",
});
try {
	const { page, frame } = await tabs.open();
	await page.route("**/api/rpc/osWorkspaces/resources/getFile*", (route) =>
		route.fulfill({
			json: {
				json: {
					filename: "fictional-photo.png",
					mimeType: "image/png",
					size: 68,
					resourceId: content.file.resourceId,
					url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=",
					expiresAt: "2099-01-01T00:00:00.000Z",
				},
			},
		}),
	);
	await page.reload();
	await frame.locator(".doc-toolbar[hidden]").waitFor({ state: "attached" });
	assert.equal(await frame.getByRole("toolbar").isVisible(), false);
	const image = page.getByRole("img", { name: "fictional-photo.png" });
	await image.waitFor();
	assert(
		await image.evaluate(
			(node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
		),
	);
	assert.equal(await frame.locator(".tiptap").count(), 0);
	assert.equal(
		await frame.locator('.doc-status[data-error="true"]').count(),
		0,
	);
	assert.equal(await frame.getByText("Try again", { exact: true }).count(), 0);
	assert.deepEqual((await tabs.saved()).content, content);
	console.log(
		"File-only Doc shows the image without editing controls or an error",
	);
} finally {
	await tabs.stop();
}
