import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const workspacePath =
	"/workspace/00000030-0000-4000-8000-000000000001?workpiece=gadget%3A00000031-0000-4000-8000-00000000000a&pane=workpiece";
const server = await startFixtureServer("/work");
const browser = await chromium.launch({ headless: true });

try {
	const page = await browser.newPage({
		viewport: { width: 1280, height: 844 },
	});
	await page.routeWebSocket("**/collab/*/workspace%3A*", (socket) => {
		socket.onMessage((data) => {
			const frame = JSON.parse(String(data));
			if (frame.t !== "base") return;
			socket.send(JSON.stringify({ t: "hello", peerId: 1 }));
			socket.send(
				JSON.stringify({
					t: "base",
					id: frame.id,
					generation: 0,
					revision: 0,
					files: [["document", ""]],
					canonical: { revision: 0, revisionId: null },
				}),
			);
			socket.send(
				JSON.stringify({
					t: "presence",
					peers: [
						[
							2,
							{
								user: {
									key: "p_ada",
									displayName: "Ada Lovelace",
									kind: "human",
									role: "build",
									verified: true,
								},
								location: {
									surface: "canvas",
									artifactKind: "gadget",
									artifactLabel: "Revenue Dashboard",
									selectionLabel: "Editor",
								},
							},
						],
						[
							3,
							{
								user: {
									key: "p_grace",
									displayName: "Grace Hopper",
									kind: "human",
									role: "use",
									verified: true,
								},
								location: {
									surface: "canvas",
									selectionLabel: "Apps",
								},
							},
						],
					],
				}),
			);
		});
	});
	await page.goto(`${server.origin}${workspacePath}`, {
		waitUntil: "domcontentloaded",
		timeout: 90_000,
	});
	const roster = page.getByRole("button", {
		name: "2 collaborators here now. Open collaborator details.",
	});
	await roster.waitFor();
	for (const [width, visibleAvatars] of [
		[1280, 2],
		[375, 1],
	] as const) {
		await page.setViewportSize({ width, height: 844 });
		assert(
			await roster.evaluate((element) =>
				element.closest(".canvas-workspace-header"),
			),
			`${width}: roster is in the workspace header`,
		);
		assert.equal(
			await roster.locator(".canvas-presence-pop:visible").count(),
			visibleAvatars,
			`${width}: avatar stack fits the header`,
		);
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			`${width}: no horizontal overflow`,
		);
	}
	await roster.click();
	await page.getByText("Ada Lovelace", { exact: true }).waitFor();
	await page.getByText("Grace Hopper", { exact: true }).waitFor();
	await page.getByText("Build", { exact: true }).waitFor();
	await page.getByText("Use", { exact: true }).waitFor();
	await page.getByText("Viewing Revenue Dashboard", { exact: true }).waitFor();
	await page.getByText("In this workspace", { exact: true }).waitFor();
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
		"the open collaborator details fit the narrow viewport",
	);
	await page.close();
} finally {
	await browser.close();
	await server.stop();
}
