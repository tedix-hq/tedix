import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
	buildBrowserWorkspaceSelectionUrl,
	parseBrowserWorkspaceSelection,
	selectWorkspaceInBrowser,
} from "./browser-workspace-selection";

describe("browser workspace selection", () => {
	for (const failure of ["closed", "expired", "invalid"] as const) {
		test(`stops browser polling when the loopback callback is ${failure}`, async () => {
			let page!: Promise<string>;
			const session = await selectWorkspaceInBrowser({
				state: "expired-callback",
				openBrowser: (rawUrl) => {
					const port = new URL(rawUrl).searchParams.get("port");
					page = fetch(
						`http://127.0.0.1:${port}/workspace?state=expired-callback&organization=acme&tenant=org_acme`,
					).then((response) => response.text());
				},
			});
			const html = await page;
			expect(() => session.continueInBrowser("http://unsafe.example")).toThrow(
				"unsafe URL",
			);
			const heading = { textContent: "" };
			const body = { textContent: "" };
			const mark = { textContent: "" };
			const timers: unknown[] = [];
			let requests = 0;
			await runInNewContext(
				html
					.match(/<script>([\s\S]*?)<\/script>/)![1]!
					.replace("void poll()", "poll()"),
				{
					URLSearchParams,
					location: { search: "?state=expired-callback" },
					document: {
						querySelector: (selector: string) =>
							selector === "h1" ? heading : selector === ".mark" ? mark : body,
					},
					setTimeout: (callback: unknown) => timers.push(callback),
					fetch: async () => {
						requests++;
						if (failure === "closed") throw new TypeError("Failed to fetch");
						return failure === "expired"
							? new Response(null, { status: 400 })
							: Response.json({});
					},
				},
			);
			expect(requests).toBe(1);
			expect(timers).toHaveLength(0);
			expect(heading.textContent).toBe("Authorization stopped");
			expect(body.textContent).toBe(
				"Return to your terminal and run tedix login again.",
			);
		});
	}

	test("rejects duplicate organization slugs even with distinct tenants", () => {
		expect(
			parseBrowserWorkspaceSelection(
				"/workspace?state=one-time&organization=acme&tenant=org_acme&selected_org=acme&selected_tenant=org_acme&selected_org=acme&selected_tenant=org_other",
				"one-time",
			),
		).toBeNull();
	});

	test("opens the OS launcher with a loopback port and one-time state", () => {
		const url = new URL(
			buildBrowserWorkspaceSelectionUrl({
				port: 9123,
				state: "a9e9d9b9-8bc0-4ec2-a771-3fc9c46e1080",
			}),
		);
		expect(url.origin).toBe("https://os.tedix.dev");
		expect(url.pathname).toBe("/cli/login");
		expect(url.searchParams.get("port")).toBe("9123");
		expect(url.searchParams.get("state")).toBe(
			"a9e9d9b9-8bc0-4ec2-a771-3fc9c46e1080",
		);
	});

	test("preselects a positional organization through the same OS launcher", () => {
		const url = new URL(
			buildBrowserWorkspaceSelectionUrl({
				organization: "globex",
				port: 9123,
				state: "one-time",
			}),
		);
		expect(url.searchParams.get("organization")).toBe("globex");
	});

	test("waits for a state-bound selection on an ephemeral loopback port", async () => {
		const state = "a9e9d9b9-8bc0-4ec2-a771-3fc9c46e1080";
		const selected = selectWorkspaceInBrowser({
			state,
			timeoutMs: 1_000,
			openBrowser: (rawUrl) => {
				const selectionUrl = new URL(rawUrl);
				const port = selectionUrl.searchParams.get("port");
				void fetch(
					`http://127.0.0.1:${port}/workspace?state=${state}&organization=acme&tenant=org_acme`,
				);
			},
		});

		const session = await selected;
		expect(session).toMatchObject({
			organization: "acme",
			tenant: "org_acme",
		});
		expect(session.continueInBrowser).toBeFunction();
		session.continueInBrowser(
			"https://auth.tedix.dev/oauth2/v1/apps/authorize",
		);
	});

	test("continues the selected browser tab into OAuth without opening another tab", async () => {
		const state = "single-tab";
		let continuedTo = "";
		const selected = selectWorkspaceInBrowser({
			state,
			timeoutMs: 1_000,
			openBrowser: async (rawUrl) => {
				const port = new URL(rawUrl).searchParams.get("port");
				const response = await fetch(
					`http://127.0.0.1:${port}/workspace?state=${state}&organization=tedix&tenant=org_tedix`,
				);
				expect(await response.text()).toContain(
					"Preparing secure authorization",
				);
				for (;;) {
					const continuation = await fetch(
						`http://127.0.0.1:${port}/continue?state=${state}`,
					);
					if (continuation.status === 204) continue;
					continuedTo = (
						(await continuation.json()) as { authorizationUrl: string }
					).authorizationUrl;
					break;
				}
			},
		});
		const session = await selected;
		session.continueInBrowser(
			"https://auth.tedix.dev/oauth2/v1/apps/authorize?prompt=consent",
		);
		await Bun.sleep(10);
		expect(continuedTo).toBe(
			"https://auth.tedix.dev/oauth2/v1/apps/authorize?prompt=consent",
		);
	});

	test("accepts only the expected callback state and a valid slug", () => {
		expect(
			parseBrowserWorkspaceSelection(
				"/workspace?state=one-time&organization=acme&tenant=org_acme",
				"one-time",
			),
		).toEqual({
			organization: "acme",
			tenant: "org_acme",
			organizations: [{ organization: "acme", tenant: "org_acme" }],
		});
		expect(
			parseBrowserWorkspaceSelection(
				"/workspace?state=wrong&organization=acme&tenant=org_acme",
				"one-time",
			),
		).toBeNull();
		expect(
			parseBrowserWorkspaceSelection(
				"/workspace?state=one-time&organization=https://evil.example&tenant=org_acme",
				"one-time",
			),
		).toBeNull();
		expect(
			parseBrowserWorkspaceSelection(
				"/workspace?state=one-time&organization=acme&tenant=https://evil.example",
				"one-time",
			),
		).toBeNull();
		const selected = parseBrowserWorkspaceSelection(
			"/workspace?state=one-time&organization=acme&tenant=org_acme&selected_org=acme&selected_tenant=org_acme&selected_org=other&selected_tenant=org_other&scope=mcp%3Aapps.read&scope=connections.execute",
			"one-time",
		);
		expect(selected?.organizations).toEqual([
			{ organization: "acme", tenant: "org_acme" },
			{ organization: "other", tenant: "org_other" },
		]);
		expect(selected?.scopes).toEqual(["mcp:apps.read", "connections.execute"]);
		expect(
			parseBrowserWorkspaceSelection(
				"/workspace?state=one-time&organization=acme&tenant=org_acme&selected_org=other&selected_tenant=org_other",
				"one-time",
			),
		).toBeNull();
	});
});
