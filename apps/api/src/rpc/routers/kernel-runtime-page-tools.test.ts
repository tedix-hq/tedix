import "./__tests__/kernel-runtime-work-mocks";
import { PageToolBroker } from "@tedix/chat-transport/page-tool-broker";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	ORG_ID,
	normalizeKernelRuntimeRunInsert,
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
	grantRow,
} from "./__tests__/kernel-runtime-db";

describe("kernel runtime router: page-tools", () => {
	describe("resolvePageTool", () => {
		const MEMBER = "member-1";
		const OTHER_MEMBER = "member-2";
		const pageResult = { ok: true, content: "filled" };
		function pageToolRun(input: {
			id: string;
			startedBy?: string | null;
			status?: "running" | "completed";
			organizationId?: string;
		}) {
			return normalizeKernelRuntimeRunInsert({
				id: input.id,
				organizationId: input.organizationId ?? ORG_ID,
				conversationId: `home:${input.id}`,
				status: input.status ?? "running",
				metadata:
					input.startedBy === null
						? { source: "kernelRuntime.enqueueMessage" }
						: {
								source: "kernelRuntime.enqueueMessage",
								redriveInput: { descopeUserId: input.startedBy ?? MEMBER },
							},
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			});
		}
		/** A real broker: the call id is single-use and bound to its run. */
		function fakeKernel(broker: PageToolBroker) {
			return {
				idFromName: (name: string) => name,
				get: (doId: string) => ({
					resolvePageTool: async (
						runId: string,
						callId: string,
						result: { ok: boolean; content: string },
					) => doId === ORG_ID && (await broker.resolve(runId, callId, result)),
				}),
			};
		}
		async function openCall(broker: PageToolBroker, runId: string) {
			let emitted: (callId: string) => void = () => {};
			const callId = new Promise<string>((resolve) => {
				emitted = resolve;
			});
			const settled = broker.request({
				runId,
				name: "fill_card",
				args: {},
				confirm: false,
				emit: (event) => emitted(String(event.callId)),
			});
			return { callId: await callId, settled };
		}
		function memberClient(
			db: ReturnType<typeof createKernelRuntimeDb>,
			broker: PageToolBroker,
			overrides?: {
				userSub?: string;
				userRole?: "member" | "viewer" | "admin";
			},
		) {
			return createKernelRuntimeClient({
				...createContext(db, {
					userSub: overrides?.userSub ?? MEMBER,
					env: { KERNEL: fakeKernel(broker) },
				}),
				apiKey: undefined,
				authType: "user" as const,
				userRole: overrides?.userRole ?? ("member" as const),
			});
		}

		it("lets a member answer an open call on the running run they started, once", async () => {
			const db = createKernelRuntimeDb();
			db.runs.push(pageToolRun({ id: "page-own" }));
			const broker = new PageToolBroker();
			const { callId, settled } = await openCall(broker, "page-own");
			const client = memberClient(db, broker);

			await expect(
				client.resolvePageTool({
					runId: "page-own",
					callId,
					result: pageResult,
				}),
			).resolves.toEqual({ accepted: true });
			await expect(settled).resolves.toEqual(pageResult);
			// The same call id a second time settles nothing (single use).
			await expect(
				client.resolvePageTool({
					runId: "page-own",
					callId,
					result: { ok: true, content: "replayed" },
				}),
			).resolves.toEqual({ accepted: false });
			// A guessed call id settles nothing either.
			await expect(
				client.resolvePageTool({
					runId: "page-own",
					callId: "call-guessed-1",
					result: pageResult,
				}),
			).resolves.toEqual({ accepted: false });
		});

		it("lets a member answer a shared conversation they were granted edit on", async () => {
			const db = createKernelRuntimeDb({
				grantRows: [
					grantRow({
						access: "owner",
						conversationId: "home:page-shared",
						userId: OTHER_MEMBER,
					}),
					grantRow({
						access: "edit",
						conversationId: "home:page-shared",
						userId: MEMBER,
					}),
				],
			});
			db.runs.push(pageToolRun({ id: "page-shared" }));
			const broker = new PageToolBroker();
			const { callId } = await openCall(broker, "page-shared");

			await expect(
				memberClient(db, broker).resolvePageTool({
					runId: "page-shared",
					callId,
					result: pageResult,
				}),
			).resolves.toEqual({ accepted: true });
		});

		it("refuses a member on another person's run, even in an org-wide conversation", async () => {
			const db = createKernelRuntimeDb();
			db.runs.push(pageToolRun({ id: "page-other", startedBy: OTHER_MEMBER }));
			db.runs.push(
				pageToolRun({ id: "page-unknown-starter", startedBy: null }),
			);
			const broker = new PageToolBroker();
			const { callId, settled } = await openCall(broker, "page-other");
			const client = memberClient(db, broker);

			await expect(
				client.resolvePageTool({
					runId: "page-other",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message:
					"Only the person who started this Home run can answer its page tools",
			});
			// A run with no recorded starter is nobody's to answer.
			await expect(
				client.resolvePageTool({
					runId: "page-unknown-starter",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			// An admin is a person too: the page is the starter's, not the org's.
			await expect(
				memberClient(db, broker, { userRole: "admin" }).resolvePageTool({
					runId: "page-other",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				Promise.race([settled, Promise.resolve("still open")]),
			).resolves.toBe("still open");
		});

		it("refuses a member the conversation grants exclude, before the run is touched", async () => {
			const db = createKernelRuntimeDb({
				grantRows: [
					grantRow({
						access: "owner",
						conversationId: "home:page-locked",
						userId: OTHER_MEMBER,
					}),
				],
			});
			db.runs.push(pageToolRun({ id: "page-locked" }));
			const broker = new PageToolBroker();
			const { callId } = await openCall(broker, "page-locked");

			await expect(
				memberClient(db, broker).resolvePageTool({
					runId: "page-locked",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: "Access denied to Home conversation home:page-locked",
			});
		});

		it("refuses a viewer (no os:run) and a run in another organization", async () => {
			const db = createKernelRuntimeDb();
			db.runs.push(pageToolRun({ id: "page-viewer" }));
			db.runs.push(
				pageToolRun({ id: "page-elsewhere", organizationId: "org-2" }),
			);
			const broker = new PageToolBroker();
			const { callId } = await openCall(broker, "page-viewer");

			await expect(
				memberClient(db, broker, { userRole: "viewer" }).resolvePageTool({
					runId: "page-viewer",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: "Insufficient permissions. Required: os:run",
			});
			await expect(
				memberClient(db, broker).resolvePageTool({
					runId: "page-elsewhere",
					callId,
					result: pageResult,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});

		it("accepts nothing for a finished run or a missing run", async () => {
			const db = createKernelRuntimeDb();
			db.runs.push(pageToolRun({ id: "page-done", status: "completed" }));
			const broker = new PageToolBroker();
			const resolve = vi.spyOn(broker, "resolve");
			const client = memberClient(db, broker);

			await expect(
				client.resolvePageTool({
					runId: "page-done",
					callId: "call-00000001",
					result: pageResult,
				}),
			).resolves.toEqual({ accepted: false });
			await expect(
				client.resolvePageTool({
					runId: "page-missing",
					callId: "call-00000001",
					result: pageResult,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(resolve).not.toHaveBeenCalled();
		});

		it("refuses tedi callers: the page is the person's, not the worker's", async () => {
			const db = createKernelRuntimeDb();
			db.runs.push(pageToolRun({ id: "page-tedi" }));
			const broker = new PageToolBroker();
			const resolve = vi.spyOn(broker, "resolve");
			const { callId } = await openCall(broker, "page-tedi");
			const base = createContext(db, { env: { KERNEL: fakeKernel(broker) } });
			const tediCallers: BaseContext[] = [
				// The MCP edge forwarding a tedi's declared tool over the service
				// binding: withAuth resolves the principal from these headers.
				{
					...base,
					apiKey: undefined,
					authType: undefined,
					headers: new Headers({
						"X-Service-Binding": "true",
						"X-Tedix-Org-Id": ORG_ID,
						"X-Tedix-Tedi-Id": "tedi-cto",
						"X-Tedix-Tedi-Scopes": "tedis:write",
						"X-Tedix-Mcp-Tool-Id": "resolve_page_tool",
					}),
				} as unknown as BaseContext,
				// A direct tedi JWT (what authenticateTediJwt leaves on the context).
				{
					...base,
					apiKey: undefined,
					authType: "tedi",
					tediId: "tedi-cto",
					descopeUserId: "tedi-cto-identity",
					tediScopes: ["tedis:write"],
					user: { sub: "tedi-cto-identity" } as BaseContext["user"],
				} as BaseContext,
			];
			for (const context of tediCallers) {
				await expect(
					createKernelRuntimeClient(context).resolvePageTool({
						runId: "page-tedi",
						callId,
						result: pageResult,
					}),
				).rejects.toMatchObject({
					code: "FORBIDDEN",
					message:
						"Page tools are answered by the person's page, never by a tedi",
				});
			}
			expect(resolve).not.toHaveBeenCalled();
		});
	});
});
