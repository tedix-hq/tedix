import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { apps, appTools } from "@tedix/db/schema";
import { userContext } from "../rpc/test-context";
import {
	admitPersonalRequest,
	resolveRequestPersonalCredential,
} from "./personal-request-authority";

const mocks = vi.hoisted(() => ({
	consent: vi.fn(),
	home: vi.fn(),
	submission: vi.fn(),
	tool: vi.fn(),
	app: vi.fn(),
	instance: vi.fn(),
	token: vi.fn(),
	defaultToken: vi.fn(),
	namedToken: vi.fn(),
	audit: vi.fn(),
	homeEvent: vi.fn(),
	tediEvent: vi.fn(),
}));
vi.mock("@tedix/db/queries/personal-request-consent", () => ({
	getPersonalRequestConsent: mocks.consent,
}));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	getKernelRuntimeRun: mocks.home,
}));
vi.mock("@tedix/db/queries/runtime-submissions/read-models", () => ({
	getSubmissionById: mocks.submission,
}));
vi.mock("@tedix/db/queries/tools", () => ({
	getToolByAppAndToolIdForOrganization: mocks.tool,
}));
vi.mock("@tedix/db/queries/app-records", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/app-records")>()),
	getAppByIdForOrganization: mocks.app,
}));
vi.mock("@tedix/db/queries/connection-instances", () => ({
	getConnectionInstance: mocks.instance,
}));
vi.mock("@tedix/auth/connections", () => ({
	fetchConnectionToken: mocks.defaultToken,
	fetchConnectionTokenByScopes: mocks.token,
}));
vi.mock("../rpc/routers/connections/policy-resolution", () => ({
	fetchNamedConnection: mocks.namedToken,
}));
vi.mock("../lib/descope-management", () => ({
	getDescopeManagement: () => ({ vault: true }),
}));
vi.mock("@tedix/db/queries/audit", () => ({ insertAuditEvent: mocks.audit }));
vi.mock("@tedix/db/queries/kernel-runtime-events", () => ({
	insertKernelRuntimeEventIfAbsent: mocks.homeEvent,
}));
vi.mock("@tedix/db/queries/cognitive-runtime", () => ({
	insertTediRuntimeEvent: mocks.tediEvent,
}));
const input = {
	organizationId: "org-1",
	tediId: "ceo",
	providerId: "google-gmail",
	appId: "gmail-app",
};
function context() {
	return {
		...userContext(),
		authType: "service-binding" as const,
		tediId: "ceo",
		headers: new Headers({
			"X-Tedix-Request-Run-Id": "child",
			"X-Tedix-Request-Root-Run-Id": "root",
			"X-Tedix-Request-Work-Item-Id": "work",
			"X-Tedix-Mcp-Tool-Id": "search_threads",
		}),
	};
}
function consent(tediId: string | null = null) {
	return {
		actorId: "requester",
		timestamp: new Date(),
		metadata: {
			requesterUserId: "requester",
			rootRunId: "root",
			conversationId: "conversation",
			tediId,
			expiresAt: new Date(Date.now() + 899_000).toISOString(),
		},
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.app.mockResolvedValue(undefined);
	mocks.consent.mockResolvedValue(consent());
	mocks.home.mockResolvedValue({
		status: "running",
		conversationId: "conversation",
		delegatedTediId: "ceo",
		childRunId: "child",
		metadata: { workItemId: "work" },
	});
	mocks.submission.mockResolvedValue({
		status: "running",
		tediId: "ceo",
		runId: "root",
	});
	mocks.tool.mockResolvedValue({
		enabled: true,
		config: { mcpToolName: "search_threads" },
	});
	mocks.token.mockResolvedValue({
		id: "token-id",
		accessToken: "private-token",
		tokenSub: "owner@example.test",
		scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
	});
	mocks.defaultToken.mockResolvedValue(null);
	mocks.instance.mockResolvedValue(undefined);
});
describe("request-bound personal reads", () => {
	it("resolves the real gateway → proxy → base path and rejects a foreign base", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(apps));
		sqlite.exec(schemaDdl(appTools));
		const db = createDbClient(createD1Facade(sqlite));
		await db.insert(apps).values([
			{
				id: "gmail-app",
				organizationId: "org-1",
				name: "Gateway",
				slug: "gateway",
				metadata: {
					mcpConfig: { aggregateApps: [{ appId: "proxy", slug: "mail" }] },
				},
			},
			{
				id: "proxy",
				organizationId: "org-1",
				name: "Mail",
				slug: "mail",
				sourceAppId: "base",
				metadata: {
					mcpConfig: { aggregateApps: [{ appId: "base", slug: "mail-base" }] },
				},
			},
			{ id: "base", organizationId: "org-1", name: "Base", slug: "mail-base" },
		]);
		await db.insert(appTools).values({
			id: "read-tool",
			appId: "base",
			toolId: "search_threads",
			title: "Search mail",
			toolTypeId: "external",
			enabled: true,
			config: { mcpToolName: "search_threads" },
		});
		const tools = await vi.importActual<
			typeof import("@tedix/db/queries/tools")
		>("@tedix/db/queries/tools");
		const records = await vi.importActual<
			typeof import("@tedix/db/queries/app-records")
		>("@tedix/db/queries/app-records");
		mocks.tool.mockImplementation(tools.getToolByAppAndToolIdForOrganization);
		mocks.app.mockImplementation(records.getAppByIdForOrganization);
		const ctx = { ...context(), db };
		ctx.headers.set("X-Tedix-Mcp-Tool-Id", "mail__search_threads");
		expect(await resolveRequestPersonalCredential(ctx, input)).toHaveProperty(
			"accessToken",
		);
		mocks.token.mockClear();
		await db.insert(appTools).values({
			id: "send-tool",
			appId: "base",
			toolId: "send_email",
			title: "Send mail",
			toolTypeId: "external",
			enabled: true,
			config: { mcpToolName: "send_email" },
		});
		for (const toolId of ["forged__search_threads", "mail__send_email"]) {
			ctx.headers.set("X-Tedix-Mcp-Tool-Id", toolId);
			await expect(
				resolveRequestPersonalCredential(ctx, input),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		ctx.headers.set("X-Tedix-Mcp-Tool-Id", "mail__search_threads");
		sqlite
			.prepare("UPDATE apps SET organization_id = ? WHERE id = ?")
			.run("other-org", "base");
		await expect(
			resolveRequestPersonalCredential(ctx, input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.token).not.toHaveBeenCalled();
		sqlite.close();
	});
	it("bounds cyclic source links without looking outside the organization", async () => {
		mocks.tool.mockResolvedValue(undefined);
		mocks.app.mockResolvedValue({
			sourceAppId: "gmail-app",
			metadata: { mcpConfig: { aggregateApps: [{ appId: "gmail-app" }] } },
		});
		await expect(
			resolveRequestPersonalCredential(context(), input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.tool).toHaveBeenCalledTimes(1);
		expect(mocks.token).not.toHaveBeenCalled();
	});

	it("resolves an inherited reviewed read through its existing same-org proxy link", async () => {
		mocks.app.mockResolvedValue({
			sourceAppId: "gmail-base",
			metadata: { mcpConfig: { aggregateApps: [{ appId: "gmail-base" }] } },
		});
		mocks.tool.mockResolvedValueOnce(undefined);
		expect(
			await resolveRequestPersonalCredential(context(), input),
		).toHaveProperty("accessToken");
		expect(mocks.tool).toHaveBeenLastCalledWith(expect.anything(), {
			organizationId: "org-1",
			appId: "gmail-base",
			toolId: "search_threads",
		});
	});

	it.each([
		undefined,
		{
			sourceAppId: "gmail-base",
			metadata: { mcpConfig: { aggregateApps: [{ appId: "different" }] } },
		},
		{
			sourceAppId: "gmail-base",
			metadata: {
				mcpConfig: { aggregateApps: [{ appId: "gmail-base", toolIds: [] }] },
			},
		},
		{
			sourceAppId: "gmail-base",
			metadata: {
				mcpConfig: {
					aggregateApps: [{ appId: "gmail-base", endpointPrefixes: [] }],
				},
			},
		},
	])(
		"does not infer an inherited tool outside an unrestricted canonical link",
		async (app) => {
			mocks.app.mockResolvedValue(app);
			mocks.tool.mockResolvedValueOnce(undefined);
			await expect(
				resolveRequestPersonalCredential(context(), input),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.tool).toHaveBeenCalledTimes(1);
			expect(mocks.token).not.toHaveBeenCalled();
		},
	);

	it.each([
		undefined,
		{ enabled: false },
		{ enabled: true, config: { mcpToolName: "send_email" } },
	])(
		"does not authorize a missing, disabled or write tool inherited from a proxy",
		async (tool) => {
			mocks.app.mockResolvedValue({
				sourceAppId: "gmail-base",
				metadata: { mcpConfig: { aggregateApps: [{ appId: "gmail-base" }] } },
			});
			mocks.tool.mockResolvedValueOnce(undefined).mockResolvedValueOnce(tool);
			await expect(
				resolveRequestPersonalCredential(context(), input),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.token).not.toHaveBeenCalled();
		},
	);

	it("admits only the authenticated requester, with a fixed expiry and immutable id", async () => {
		const ctx = userContext({ userId: "canonical" });
		ctx.descopeUserId = "requester";
		const createdAt = new Date().toISOString();
		await admitPersonalRequest(ctx, {
			organizationId: "org-1",
			runId: "root",
			conversationId: "conversation",
			createdAt,
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			ctx.db,
			expect.objectContaining({
				id: "personal-request:org-1:root",
				actorId: "requester",
				ignoreDuplicates: true,
				metadata: expect.objectContaining({
					expiresAt: new Date(Date.parse(createdAt) + 900_000).toISOString(),
				}),
			}),
		);
	});
	it.each(["service-binding", "tedi", "m2m", "apikey"] as const)(
		"does not mint consent for %s or a scheduled acting user",
		async (authType) => {
			const ctx = { ...userContext(), authType, descopeUserId: "requester" };
			await admitPersonalRequest(ctx, {
				organizationId: "org-1",
				runId: "root",
				conversationId: "conversation",
				createdAt: new Date().toISOString(),
			});
			expect(mocks.audit).not.toHaveBeenCalled();
		},
	);
	it.each([
		["google-gmail", "search_threads", "gmail.readonly"],
		["google-calendar", "list_events", "calendar.events.readonly"],
	])(
		"allows a delegated read of the requester's own %s and audits account, tedi and tool",
		async (providerId, mcpToolName, scope) => {
			mocks.tool.mockResolvedValue({ enabled: true, config: { mcpToolName } });
			mocks.token.mockResolvedValue({
				id: "token-id",
				accessToken: "private-token",
				tokenSub: "owner@example.test",
				scopes: [`https://www.googleapis.com/auth/${scope}`],
			});
			const ctx = context();
			const result = await resolveRequestPersonalCredential(ctx, {
				...input,
				providerId,
			});
			expect(result?.scopes).toEqual([
				`https://www.googleapis.com/auth/${scope}`,
			]);
			expect(mocks.token).toHaveBeenCalledWith(
				expect.anything(),
				providerId,
				"requester",
				[`https://www.googleapis.com/auth/${scope}`],
			);
			expect(mocks.audit).toHaveBeenCalledWith(
				ctx.db,
				expect.objectContaining({
					action: "personal.request.read",
					actorId: "ceo",
					metadata: expect.objectContaining({
						requesterUserId: "requester",
						rootRunId: "root",
						runId: "child",
						account: "owner@example.test",
						toolId: "search_threads",
					}),
				}),
			);
			expect(mocks.homeEvent).toHaveBeenCalledWith(
				ctx.db,
				expect.objectContaining({
					runId: "root",
					payload: expect.objectContaining({
						content: expect.stringContaining("for this request"),
					}),
				}),
			);
		},
	);
	it("refuses another member's account and never falls back to the tedi owner", async () => {
		await expect(
			resolveRequestPersonalCredential(context(), {
				...input,
				userId: "another-member",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.token).not.toHaveBeenCalled();
		await expect(
			resolveRequestPersonalCredential(context(), {
				...input,
				connectionInstanceId: "another-account",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.namedToken).not.toHaveBeenCalled();
	});
	it("refuses a scheduled skill even if it replays a direct request id", async () => {
		const ctx = context();
		ctx.headers.set("X-Tedix-Skill-Run-Id", "scheduled");
		await expect(
			resolveRequestPersonalCredential(ctx, input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.token).not.toHaveBeenCalled();
	});
	it("leaves background runs without a request on the existing Workspace consent path", async () => {
		const ctx = context();
		ctx.headers.delete("X-Tedix-Request-Run-Id");
		expect(await resolveRequestPersonalCredential(ctx, input)).toBeNull();
		expect(mocks.token).not.toHaveBeenCalled();
	});
	it.each([
		"create_draft",
		"send_email",
		"label_thread",
		"create_event",
		"unknown",
	])("refuses write or unreviewed tool %s", async (mcpToolName) => {
		mocks.tool.mockResolvedValue({
			enabled: true,
			config: {
				mcpToolName,
				personalResourceBinding: {
					operation: "read",
					target: "account",
					resourceType: "mailbox",
				},
			},
		});
		await expect(
			resolveRequestPersonalCredential(context(), input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.token).not.toHaveBeenCalled();
	});
	it.each(["expired", "canceled", "other-child", "other-tedi"])(
		"refuses %s request authority",
		async (kind) => {
			if (kind === "expired")
				mocks.consent.mockResolvedValue({
					...consent(),
					metadata: {
						...consent().metadata,
						expiresAt: new Date(Date.now() - 1).toISOString(),
					},
				});
			if (kind === "canceled")
				mocks.home.mockResolvedValue({ status: "canceled" });
			if (kind === "other-child")
				mocks.home.mockResolvedValue({
					status: "running",
					delegatedTediId: "ceo",
					childRunId: "someone-else",
					metadata: { workItemId: "work" },
				});
			const ctx = context();
			if (kind === "other-tedi") ctx.tediId = "other";
			await expect(
				resolveRequestPersonalCredential(ctx, input),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.token).not.toHaveBeenCalled();
		},
	);
	it("accepts only an actually dispatched plan child", async () => {
		const assignment = {
			ownerTediId: "ceo",
			childRunId: "child",
			workItemId: "work",
			status: "running",
			dispatchedAt: new Date().toISOString(),
		};
		mocks.home.mockResolvedValue({
			status: "running",
			conversationId: "conversation",
			metadata: { homePlan: { assignments: [assignment] } },
		});
		expect(
			await resolveRequestPersonalCredential(context(), input),
		).toHaveProperty("accessToken");
		mocks.home.mockResolvedValue({
			status: "running",
			metadata: {
				homePlan: { assignments: [{ ...assignment, dispatchedAt: null }] },
			},
		});
		await expect(
			resolveRequestPersonalCredential(context(), input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("allows a direct tedi request only while that same run is active", async () => {
		mocks.consent.mockResolvedValue(consent("ceo"));
		const ctx = context();
		ctx.headers.set("X-Tedix-Request-Run-Id", "root");
		expect(await resolveRequestPersonalCredential(ctx, input)).toHaveProperty(
			"accessToken",
		);
		expect(mocks.tediEvent).toHaveBeenCalled();
		mocks.submission.mockResolvedValue({
			status: "settled",
			tediId: "ceo",
			runId: "root",
		});
		await expect(
			resolveRequestPersonalCredential(ctx, input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("does not create personal authority from an arbitrary native run id", async () => {
		mocks.consent.mockResolvedValue(undefined);
		expect(await resolveRequestPersonalCredential(context(), input)).toBeNull();
		expect(mocks.token).not.toHaveBeenCalled();
	});
	it("rechecks cancellation after the vault resolves", async () => {
		mocks.home
			.mockResolvedValueOnce({
				status: "running",
				conversationId: "conversation",
				delegatedTediId: "ceo",
				childRunId: "child",
				metadata: { workItemId: "work" },
			})
			.mockResolvedValueOnce({ status: "canceled" });
		await expect(
			resolveRequestPersonalCredential(context(), input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	it("keeps hybrid writes on the existing tenant gate without personal credentials", async () => {
		mocks.tool.mockResolvedValue({
			enabled: true,
			config: { mcpToolName: "send_email" },
		});
		expect(
			await resolveRequestPersonalCredential(context(), {
				...input,
				scope: "hybrid",
			}),
		).toBeNull();
		expect(mocks.token).not.toHaveBeenCalled();
	});
	it("refuses to rebind an admitted request to another person", async () => {
		mocks.consent.mockResolvedValue({ ...consent(), actorId: "another-human" });
		await expect(
			admitPersonalRequest(userContext(), {
				organizationId: "org-1",
				runId: "root",
				conversationId: "conversation",
				createdAt: new Date().toISOString(),
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("accepts an existing broader Calendar read grant only for a reviewed read", async () => {
		mocks.tool.mockResolvedValue({
			enabled: true,
			config: { mcpToolName: "list_events" },
		});
		mocks.token.mockResolvedValue(null);
		mocks.defaultToken.mockResolvedValue({
			id: "calendar-token",
			accessToken: "private-token",
			tokenSub: "owner@example.test",
			scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
		});
		expect(
			await resolveRequestPersonalCredential(context(), {
				...input,
				providerId: "google-calendar",
			}),
		).toMatchObject({
			scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
		});
	});
	it("checks scope coverage on the requester's exact named account", async () => {
		mocks.instance.mockResolvedValue({
			tokenSub: "owner@example.test",
			label: "Personal calendar",
		});
		mocks.namedToken.mockResolvedValue({
			id: "calendar-token",
			accessToken: "private-token",
			scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
		});
		mocks.tool.mockResolvedValue({
			enabled: true,
			config: { mcpToolName: "list_events" },
		});
		const selection = {
			...input,
			providerId: "google-calendar",
			connectionInstanceId: "own-calendar",
		};
		expect(
			await resolveRequestPersonalCredential(context(), selection),
		).toHaveProperty("accessToken");
		mocks.namedToken.mockResolvedValue({
			accessToken: "private-token",
			scopes: [],
		});
		await expect(
			resolveRequestPersonalCredential(context(), selection),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("fails closed when audit persistence fails", async () => {
		mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
		await expect(
			resolveRequestPersonalCredential(context(), input),
		).rejects.toThrow("audit unavailable");
	});
});
