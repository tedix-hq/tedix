import assert from "node:assert/strict";
import { chromium } from "playwright";

// Run against an isolated `bun run-local` stack, without model calls.
const origin = `http://localhost:${process.env.TEDIX_LOCAL_OS_PORT || "3030"}`;
const rpc = async (method: string, input: unknown) => {
	const started = performance.now();
	const response = await fetch(`${origin}/api/rpc/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ json: input }),
	});
	if (!response.ok) throw new Error(`${method}: ${await response.text()}`);
	console.log(
		JSON.stringify({
			method,
			durationMs: Math.round(performance.now() - started),
			serverTiming: response.headers.get("server-timing"),
		}),
	);
	return (await response.json()).json;
};
const browser = await chromium.launch({ headless: true });
const timings: { kind: string; firstPaintMs: number }[] = [];
try {
	const { organization } = await rpc("organizations/getMyOrganization", {});
	if (!organization.features.os)
		await rpc("organizations/completeOsOnboarding", {
			organizationId: organization.id,
			name: "Local Editor",
			slug: "local-editor",
		});
	const tenantOrigin = new URL(origin);
	tenantOrigin.hostname = `${organization.features.os ? organization.slug : "local-editor"}.localhost`;
	const { workspace } = await rpc("osWorkspaces/workspaces/create", {
		name: `Editor ${crypto.randomUUID().slice(0, 8)}`,
		description: "First editor open timing proof, isolated local data only.",
	});
	for (const kind of ["sheet", "document"] as const) {
		const content =
			kind === "sheet"
				? {
						kind,
						columns: ["Name", "Amount"],
						rows: [
							["First", 1],
							["Second", 2],
							["Third", 3],
							["Fourth", 4],
						],
					}
				: "# First document\n\nSaved text for editor timing.";
		const { output } = await rpc("osWorkspaces/outputs/create", {
			workspaceId: workspace.id,
			kind,
			title: `First ${kind}`,
			content,
		});
		const { gadget } = await rpc("osWorkspaces/gadgets/installOutputEditor", {
			workspaceId: workspace.id,
			outputId: output.id,
			kind,
		});
		for (const mode of ["file", "attach", "delayed"] as const) {
			const page = await browser.newPage();
			let attached = mode !== "attach";
			// Simulate a saved file whose navigation hint has not caught up. The
			// attach and list refreshes still use the real local API.
			await page.route("**/osWorkspaces/resources/list*", async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				if (!attached)
					for (const row of body.json.items) {
						if (row.providerResourceId === output.id)
							delete row.metadata.gadgetId;
					}
				await route.fulfill({ response, json: body });
			});
			await page.route("**/gadgets/installOutputEditor*", async (route) => {
				attached = true;
				await route.continue();
			});
			const release = Promise.withResolvers<void>();
			let reads = 0;
			await page.route("**/osWorkspaces/outputs/get*", async (route) => {
				if (mode === "delayed" && ++reads > 1) await release.promise;
				await route.continue();
			});
			const requests: { path: string; start: number; end: number }[] = [];
			page.on("console", (message) => {
				if (!message.text().startsWith("EDITOR_STAGE ")) return;
				const stage = JSON.parse(message.text().slice("EDITOR_STAGE ".length));
				requests.push({
					path: `bridge/${stage.method}`,
					start: stage.at,
					end: stage.at,
				});
			});
			await page.addInitScript(
				({ editorTitle }) => {
					if (window !== window.top) return;
					const marked = new Set<string>();
					const markPaint = (name: string) => {
						if (marked.has(name)) return;
						marked.add(name);
						requestAnimationFrame(() =>
							requestAnimationFrame(() => performance.mark(name)),
						);
					};
					new MutationObserver(() => {
						if (!performance.getEntriesByName("editor-open-click").length)
							return;
						const editor = [
							...document.querySelectorAll("[data-app-runtime-frame]"),
						].find(
							(node) => node.querySelector("iframe")?.title === editorTitle,
						);
						if (editor?.getAttribute("data-content-ready") === "true")
							markPaint("editor-first-paint");
						const saved = editor?.querySelector(
							'[aria-label="Saved version while editor opens"]',
						);
						if (
							saved?.querySelector("td") ||
							saved?.textContent?.includes("Saved text for editor timing.")
						)
							markPaint("editor-saved-paint");
					}).observe(document, {
						subtree: true,
						childList: true,
						attributes: true,
						attributeFilter: ["data-content-ready"],
					});
					window.addEventListener("message", (event) => {
						const message = event.data;
						if (
							message?.method === "tedix/call" &&
							["context", "outputs.readRevision", "app.ready"].includes(
								message.params?.method,
							)
						) {
							console.debug(
								"EDITOR_STAGE " +
									JSON.stringify({
										method: message.params.method,
										at: performance.timeOrigin + performance.now(),
									}),
							);
						}
					});
				},
				{ editorTitle: gadget.name },
			);
			page.on("requestfinished", (request) => {
				const timing = request.timing();
				requests.push({
					path: new URL(request.url()).pathname,
					start: timing.startTime,
					end: timing.startTime + timing.responseEnd,
				});
			});
			// A link to a file whose editor is not attached yet attaches it and
			// opens the editor without a click, so that open is timed from the
			// navigation.
			let driverStarted = Date.now();
			let started = driverStarted;
			await page.goto(
				`${tenantOrigin.origin}/workspace/${workspace.id}?${mode === "attach" ? `workpiece=output%3A${output.id}&pane=workpiece` : "pane=chat"}`,
			);
			if (mode !== "attach") {
				const open = page
					.getByRole("list", { name: "Files", exact: true })
					.locator("button.workspace-outputs-row")
					.filter({ hasText: `First ${kind}` });
				await open.waitFor();
				await open.evaluate((element) =>
					element.addEventListener(
						"click",
						(event) => {
							performance.mark("editor-open-click", {
								startTime: event.timeStamp,
							});
						},
						{ once: true, capture: true },
					),
				);
				driverStarted = Date.now();
				await open.click();
				started = await page.evaluate(
					() =>
						performance.timeOrigin +
						performance.getEntriesByName("editor-open-click")[0]!.startTime,
				);
			}
			if (mode === "delayed") {
				try {
					const snapshot = page.getByRole("region", {
						name: "Saved version while editor opens",
					});
					await snapshot
						.getByText(
							kind === "sheet" ? "First" : "Saved text for editor timing.",
							{ exact: true },
						)
						.waitFor();
					await page.waitForFunction(
						() => performance.getEntriesByName("editor-saved-paint").length > 0,
					);
					const savedPaintMs = await page.evaluate(
						() =>
							performance.getEntriesByName("editor-saved-paint")[0]!.startTime -
							performance.getEntriesByName("editor-open-click")[0]!.startTime,
					);
					console.log(JSON.stringify({ kind, mode, savedPaintMs }));
					assert(
						savedPaintMs < 2000,
						`${kind} saved version must paint within 2000ms while editor reads are held`,
					);
				} finally {
					release.resolve();
				}
			}
			const frame = page
				.frameLocator(`iframe[title=${JSON.stringify(gadget.name)}]`)
				.frameLocator("iframe");
			await frame
				.locator(kind === "sheet" ? "td[data-row]" : ".tiptap")
				.first()
				.waitFor({ timeout: 30000 });
			if (mode !== "attach")
				await page.waitForFunction(
					() => performance.getEntriesByName("editor-first-paint").length > 0,
				);
			const paintedAt =
				mode === "attach"
					? Date.now()
					: await page.evaluate(
							() =>
								performance.timeOrigin +
								performance.getEntriesByName("editor-first-paint")[0]!
									.startTime,
						);
			const firstPaintMs = Math.round(paintedAt - started);
			console.log(
				JSON.stringify({
					kind,
					mode,
					firstPaintMs,
					driverElapsedMs: Date.now() - driverStarted,
					stages: requests
						.filter((r) => r.end >= started)
						.map((r) => ({
							path: r.path,
							startMs: Math.round(r.start - started),
							endMs: Math.round(r.end - started),
							durationMs: Math.round(r.end - r.start),
						})),
				}),
			);
			// The paint budget is for a click on a file; the attach open above
			// also loads the page.
			if (mode === "file")
				timings.push({ kind: `${kind}:${mode}`, firstPaintMs });
			assert(attached, "A file without an editor must get one attached");
			assert(
				!requests.some((row) => row.path.endsWith("/osAppRuntime/open")),
				"Office editors must open through the host without starting an app server session",
			);
			await page.close();
		}
	}
	assert(
		timings.every((row) => row.firstPaintMs < 2000),
		`Editor first paint budget 2000ms: ${JSON.stringify(timings)}`,
	);
} finally {
	await browser.close();
}
