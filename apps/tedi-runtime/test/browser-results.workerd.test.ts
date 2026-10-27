import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { createQuickActionTools } from "agents/browser/ai";
import { browserTool } from "agents/browser/ai-sdk";
import { Lifecycle } from "agents/lifecycle";
import { expect, it } from "vite-plus/test";
import { z } from "zod";
import {
	createTediBrowser,
	createTediBrowserSession,
	browserSessionRuntimeEvent,
	type BrowserSessionLifecycleEvent,
	type BrowserSessionWindowEvent,
} from "../src/browser-session";
import {
	ScopedComputerWorkspace,
	computerWorkspaceScope,
} from "../src/computer-workspace-scope";
import type { TediComputerWorkspaceDO } from "../src/computer-workspace-do";
import {
	browserResultTools,
	retainBrowserResult,
} from "../src/browser-results";
import { DoBrowserBudgetStore } from "../src/browser-budget-store-do";

it("retains the SDK's full result in scoped Computer storage and recovers after restart", async () => {
	const binding = (
		env as unknown as {
			TEDI_COMPUTER_WORKSPACE: DurableObjectNamespace<TediComputerWorkspaceDO>;
		}
	).TEDI_COMPUTER_WORKSPACE;
	const sessionKey = crypto.randomUUID();
	const workspace = () =>
		new ScopedComputerWorkspace(
			binding,
			computerWorkspaceScope({ sessionKey }),
			"browser-test",
			async () => "test-tedi",
		).workspace;
	const source = `<rss><channel>${Array.from({ length: 20 }, (_, i) => `<item><title>Post ${i + 1}</title><description>Summary ${i + 1}</description><body>${"large article ".repeat(1500)}</body></item>`).join("")}</channel></rss>`;
	let calls = 0;
	const tools = createQuickActionTools({
		maxChars: 0,
		browser: {
			quickAction: async () => {
				calls++;
				return Response.json({ success: true, result: source });
			},
		},
	});
	const raw = await tools.browser_markdown!.execute!(
		{ url: "https://example.com/rss" } as never,
		{} as never,
	);
	expect(raw).toBe(source);
	const result = await retainBrowserResult(raw, workspace());
	expect(result).toMatchObject({
		totalEntries: 20,
		returnedEntries: 10,
		nextOffset: 10,
	});
	if (!("resultId" in result)) throw new Error("Missing retained result");
	await abortAllDurableObjects();
	const read = browserResultTools(workspace()).browser_read_result!.execute!;
	const second = await read(
		{ resultId: result.resultId, mode: "feed", offset: 10 } as never,
		{} as never,
	);
	expect(second).toMatchObject({ returnedEntries: 10, nextOffset: null });
	expect(calls).toBe(1);
	const other = new ScopedComputerWorkspace(
		binding,
		computerWorkspaceScope({ sessionKey: "other" }),
		"browser-test",
		async () => "test-tedi",
	).workspace;
	await expect(
		browserResultTools(other).browser_read_result!.execute!(
			{ resultId: result.resultId, mode: "text", offset: 0 } as never,
			{} as never,
		),
	).rejects.toThrow();
});

it("reuses the Lifecycle-installed named browser across turns and restarts after expiry", async () => {
	const binding = (
		env as unknown as {
			TEDI_COMPUTER_WORKSPACE: DurableObjectNamespace<TediComputerWorkspaceDO>;
		}
	).TEDI_COMPUTER_WORKSPACE;
	const stub = binding.get(binding.idFromName("tedi-browser-test"));
	const alive = new Map<string, { tabs: string[]; cookies: string[] }>();
	let created = 0;
	const keepAlives: string[] = [];
	const run = {
		binding: {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				const url = new URL(String(input));
				if (
					init?.method === "POST" &&
					url.pathname === "/v1/devtools/browser"
				) {
					keepAlives.push(url.searchParams.get("keep_alive")!);
					const sessionId = `session-${++created}`;
					alive.set(sessionId, { tabs: [], cookies: [] });
					return Response.json({ sessionId });
				}
				const id = url.pathname.split("/")[4] ?? "";
				const data = alive.get(id);
				if (data && new Headers(init?.headers).get("Upgrade") === "websocket") {
					const pair = new WebSocketPair();
					pair[1].accept();
					pair[1].addEventListener("message", (event) => {
						const { id: commandId, method } = JSON.parse(String(event.data));
						let result: unknown;
						switch (method) {
							case "Target.createTarget":
								data.tabs.push("research-tab");
								result = { targetId: "research-tab" };
								break;
							case "Network.setCookie":
								data.cookies.push("signed-in");
								result = { success: true };
								break;
							case "Target.getTargets":
								result = { tabs: data.tabs };
								break;
							case "Network.getCookies":
								result = { cookies: data.cookies };
								break;
							default:
								throw new Error(`Unexpected CDP command: ${method}`);
						}
						pair[1].send(JSON.stringify({ id: commandId, result }));
					});
					return new Response(null, { status: 101, webSocket: pair[0] });
				}
				if (init?.method === "DELETE") {
					alive.delete(id);
					return new Response(null, { status: 204 });
				}
				return alive.has(id)
					? Response.json([])
					: new Response("gone", { status: 410 });
			},
			quickAction: async () => Response.json({ success: true, result: "" }),
		},
	};
	// Script CDP calls instead of executing model-authored code in Worker Loader.
	const mockTool = ((options: {
		browser: import("agents/browser").Browser;
	}) => ({
		description: "browser",
		inputSchema: z.object({ code: z.string() }),
		execute: async ({ code }: { code: string }) => {
			// A fresh scope has no SDK restart signal; the host must still report expiry.
			const connection = await options.browser.connect({
				scope: crypto.randomUUID(),
			});
			try {
				if (code === "write") {
					await connection.cdp.send("Target.createTarget", {
						url: "https://example.com",
					});
					await connection.cdp.send("Network.setCookie", {
						name: "login",
						value: "signed-in",
						url: "https://example.com",
					});
				}
				return {
					status: "complete",
					result: {
						...((await connection.cdp.send("Target.getTargets")) as {
							tabs: string[];
						}),
						...((await connection.cdp.send("Network.getCookies")) as {
							cookies: string[];
						}),
					},
				};
			} finally {
				connection.cdp.disconnect();
			}
		},
		toModelOutput: browserTool({ ...options, loader: {} as WorkerLoader })
			.toModelOutput,
	})) as never;
	const events: BrowserSessionLifecycleEvent[] = [];
	const windows: BrowserSessionWindowEvent[] = [];
	await runInDurableObject(stub, async (instance, state) => {
		const budget = new DoBrowserBudgetStore({
			sql: (strings, ...values) =>
				state.storage.sql.exec(strings.join("?"), ...values).toArray() as never,
		});
		const policy = {
			mode: "persistent" as const,
			name: "research",
			keepAliveMs: 300_000,
		};
		// Each turn builds a fresh Browser over the DO's own storage through a
		// Lifecycle install — the same shape the tedi DO uses.
		const turn = () => {
			const named = createTediBrowser({
				binding: run.binding as never,
				keepAliveMs: () => policy.keepAliveMs,
				guardrails: () => undefined,
			});
			new Lifecycle(instance).use(named);
			return createTediBrowserSession({
				ctx: state,
				browser: run.binding as never,
				loader: {} as WorkerLoader,
				policy,
				launchMarkers: state.storage,
				namedBrowser: named,
				onLifecycle: async (event) => {
					events.push(event);
					await state.storage.put(
						`ledger:${events.length}`,
						browserSessionRuntimeEvent(event, {
							tediId: "test-tedi",
							runId: `turn-${events.length}`,
							conversationId: "test-conversation",
						}),
					);
				},
				onWindow: (event) => {
					windows.push(event);
					if (event.kind === "active")
						budget.observePersistentWindow(event, new Date(event.lastSeenAt));
					else
						budget.endPersistentWindow(
							event.sessionId,
							new Date(event.endedAt),
						);
				},
				persistentTool: mockTool,
			});
		};
		const exec = (session: ReturnType<typeof turn>, code = "read") =>
			session.tools.browser_execute!.execute!(
				{ code } as never,
				{} as never,
			) as Promise<{
				result: { tabs: string[]; cookies: string[] };
				restarted?: true;
				notice?: string;
			}>;
		const first = await exec(turn(), "write");
		const second = await exec(turn());
		expect(first.result).toEqual({
			tabs: ["research-tab"],
			cookies: ["signed-in"],
		});
		expect(second.result).toEqual(first.result);
		expect(second.restarted).toBeUndefined();
		expect(created).toBe(1);
		// Forced expiry: the provider has reclaimed the browser.
		alive.clear();
		const session = turn();
		const third = await exec(session);
		expect(third.result).toEqual({ tabs: [], cookies: [] });
		expect(third.restarted).toBe(true);
		expect(third.notice).toContain("restarted");
		expect(events.map((event) => event.kind)).toEqual([
			"opened",
			"reused",
			"restarted",
		]);
		expect(windows.filter((event) => event.kind === "active").length).toBe(3);
		expect(await state.storage.get("ledger:3")).toMatchObject({
			kind: "browser.session.restarted",
		});
		const model = await session.tools.browser_execute!.toModelOutput!({
			output: third,
		} as never);
		expect(JSON.stringify(model)).toContain('"restarted":true');
		expect(JSON.stringify(model)).not.toMatch(/session-[12]|devtools|liveView/);
		expect(
			budget.persistentMinutes(new Date(Date.now() + 600_000)).minutes,
		).toBeGreaterThanOrEqual(5);
		// A renamed policy still governs the same installed Browser.
		policy.name = "next-task";
		policy.keepAliveMs = 60_000;
		expect((await exec(turn())).restarted).toBe(true);
		expect(keepAlives).toEqual(["300000", "300000", "60000"]);
	});
});
