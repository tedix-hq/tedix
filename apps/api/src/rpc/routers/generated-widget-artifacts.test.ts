import { createRouterClient } from "@orpc/server";
import type { DbClient } from "@tedix/db/client";
import {
	generatedWidgetArtifacts,
	tediArtifacts,
	tediRuntimeEvents,
	tedis,
	widgetTestRuns,
} from "@tedix/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

// The publish-handler test exercises the full oRPC procedure; blind the
// Browser QA gate and audit sink so only the subscription publishes are real.
vi.mock("../../services/generated-widget-qa-gate", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		buildGeneratedWidgetQaSummary: vi.fn(() => ({})),
		validateGeneratedWidgetBrowserQaRun: vi.fn(() => ({
			ok: true,
			failures: [],
			evidence: {
				widgetTestRunId: "qa-run-1",
				mode: "browser",
				screenshotUrl: "https://os.tedix.dev/widgets/shot.png",
				screenshotCount: 1,
				consoleCaptured: true,
				consoleErrorCount: 0,
				networkCaptured: true,
				networkErrorCount: 0,
				layoutCaptured: true,
				visualDiffStatus: null,
				visualDiffPassed: null,
			},
		})),
	};
});

vi.mock("../audit-helpers", () => ({
	auditActor: () => ({
		actorId: "user-1",
		actorType: "user",
		actorMetadata: {},
	}),
	emitAuditEvent: vi.fn(async () => undefined),
}));

import {
	generatedWidgetArtifactsContractRouter,
	generatedWidgetTediArtifactFromRecord,
	recordGeneratedWidgetTediArtifact,
} from "./generated-widget-artifacts";

type ArtifactRow = typeof tediArtifacts.$inferInsert;
type EventRow = typeof tediRuntimeEvents.$inferInsert;

interface MockDbState {
	artifacts: ArtifactRow[];
	events: EventRow[];
	tedis: Array<{ id: string; organizationId: string }>;
}

function createMockDb(state: MockDbState): DbClient {
	return {
		select(_columns?: unknown) {
			return {
				from(table: unknown) {
					return {
						where(_w: unknown) {
							return {
								limit(_n: number) {
									if (table === tedis) {
										return Promise.resolve(state.tedis);
									}
									if (table === tediArtifacts) {
										return Promise.resolve(state.artifacts);
									}
									return Promise.resolve([]);
								},
							};
						},
					};
				},
			};
		},
		insert(table: unknown) {
			return {
				values(row: ArtifactRow | EventRow) {
					return {
						onConflictDoUpdate(_args: unknown) {
							if (table === tediArtifacts) {
								state.artifacts = state.artifacts.filter(
									(a) => a.id !== row.id,
								);
								state.artifacts.push(row as ArtifactRow);
							}
							return Promise.resolve(undefined);
						},
						onConflictDoNothing(_args: unknown) {
							let inserted = false;
							if (table === tediArtifacts) {
								if (!state.artifacts.some((a) => a.id === row.id)) {
									state.artifacts.push(row as ArtifactRow);
									inserted = true;
								}
							}
							if (table === tediRuntimeEvents) {
								if (!state.events.some((e) => e.id === row.id)) {
									state.events.push(row as EventRow);
								}
							}
							const promise = Promise.resolve(undefined);
							return Object.assign(promise, {
								returning: async () => (inserted ? [{ id: row.id }] : []),
							});
						},
					};
				},
			};
		},
	} as unknown as DbClient;
}

describe("generated widget artifact ownership", () => {
	it("builds a durable tedi artifact when generated widget metadata carries tedi ownership", () => {
		const artifact = generatedWidgetTediArtifactFromRecord({
			appId: "5eed0020-0000-4000-8000-000000000020",
			appSlug: "tedix",
			appToolId: "2a4254ce-7b57-4334-a34f-3370eb284c83",
			createdAt: "2026-05-25T10:00:00.000Z",
			id: "generated-widget-1",
			kind: "json_render_layout",
			metadata: {
				conversationId: "agent:main:dashboard",
				runId: "run-1",
				tediId: "tedi-1",
			},
			previewUrl: "https://os.tedix.dev/widgets/generated-widget-1/preview",
			resourceUri: "ui://widgets/mcp-app/tedix/r/dashboard.html",
			status: "published",
			title: "Dashboard widget",
			toolId: "create_view",
			toolName: "create_view",
			widgetTestRunId: "qa-run-1",
			widgetUrl: "https://os.tedix.dev/widgets/generated-widget-1",
		});

		expect(artifact).toMatchObject({
			conversationId: "agent:main:dashboard",
			id: "generated-widget-1",
			kind: "widget",
			mimeType: "application/vnd.tedix.widget+json",
			name: "Dashboard widget",
			runId: "run-1",
			tediId: "tedi-1",
			uri: "ui://widgets/mcp-app/tedix/r/dashboard.html",
		});
		expect(artifact?.metadata).toMatchObject({
			appSlug: "tedix",
			generatedWidgetArtifactId: "generated-widget-1",
			source: "generated_widget_artifact",
			status: "published",
			toolName: "create_view",
			widgetTestRunId: "qa-run-1",
		});
	});

	it("does not infer ownership for browser-only generated widget records without tedi context", () => {
		const artifact = generatedWidgetTediArtifactFromRecord({
			appId: "5eed0020-0000-4000-8000-000000000020",
			appSlug: "tedix",
			createdAt: "2026-05-25T10:00:00.000Z",
			id: "generated-widget-1",
			kind: "json_render_layout",
			metadata: { source: "browser-preview" },
			previewUrl: "https://os.tedix.dev/widgets/generated-widget-1/preview",
			status: "draft",
			title: "Dashboard widget",
		});

		expect(artifact).toBeNull();
	});

	it("records a tedi_artifacts row + artifact.created event when same-org ownership is present", async () => {
		const state: MockDbState = {
			artifacts: [],
			events: [],
			tedis: [{ id: "tedi-1", organizationId: "org-1" }],
		};
		const db = createMockDb(state);
		const recorded = await recordGeneratedWidgetTediArtifact(db, "org-1", {
			appId: "app-1",
			appSlug: "tedix",
			createdAt: "2026-05-25T10:00:00.000Z",
			id: "generated-widget-1",
			kind: "json_render_layout",
			metadata: {
				conversationId: "agent:main:dashboard",
				runId: "run-1",
				tediId: "tedi-1",
			},
			resourceUri: "ui://widgets/tedix/r/dashboard.html",
			status: "published",
			title: "Dashboard widget",
			toolName: "create_view",
		});
		expect(recorded).not.toBeNull();
		expect(recorded?.tediId).toBe("tedi-1");
		expect(recorded?.uri).toBeUndefined();
		expect(recorded?.metadata).toBeUndefined();
		expect(recorded?.accessClassification).toBe("runtime_private");
		expect(state.artifacts).toHaveLength(1);
		expect(state.artifacts[0]).toMatchObject({
			id: "generated-widget-1",
			organizationId: "org-1",
			tediId: "tedi-1",
			conversationId: "agent:main:dashboard",
			runId: "run-1",
		});
		expect(state.events).toHaveLength(1);
		expect(state.events[0]).toMatchObject({
			kind: "artifact.created",
			organizationId: "org-1",
			tediId: "tedi-1",
			artifactId: "generated-widget-1",
		});
		expect(
			(
				state.events[0]?.payload as {
					artifact?: { uri?: string; metadata?: unknown };
				}
			).artifact?.uri,
		).toBeUndefined();
		expect(
			(
				state.events[0]?.payload as {
					artifact?: { uri?: string; metadata?: unknown };
				}
			).artifact?.metadata,
		).toBeUndefined();
	});

	it("does not record any tedi_artifacts row when ownership is ambiguous (browser-only)", async () => {
		const state: MockDbState = { artifacts: [], events: [], tedis: [] };
		const db = createMockDb(state);
		const recorded = await recordGeneratedWidgetTediArtifact(db, "org-1", {
			appId: "app-1",
			appSlug: "tedix",
			createdAt: "2026-05-25T10:00:00.000Z",
			id: "browser-only-1",
			kind: "json_render_layout",
			metadata: { source: "browser-preview" },
			status: "draft",
			title: "Browser-only widget",
		});
		expect(recorded).toBeNull();
		expect(state.artifacts).toHaveLength(0);
		expect(state.events).toHaveLength(0);
	});

	it("refuses to overwrite a tedi_artifacts row owned by a different organization", async () => {
		const state: MockDbState = {
			artifacts: [
				{
					id: "generated-widget-1",
					organizationId: "org-other",
					tediId: "tedi-other",
					kind: "widget",
					name: "Other org widget",
					mimeType: "application/vnd.tedix.widget+json",
					createdAt: "2026-05-24T10:00:00.000Z",
				} as ArtifactRow,
			],
			events: [],
			tedis: [{ id: "tedi-1", organizationId: "org-1" }],
		};
		const db = createMockDb(state);
		const recorded = await recordGeneratedWidgetTediArtifact(db, "org-1", {
			appId: "app-1",
			appSlug: "tedix",
			createdAt: "2026-05-25T10:00:00.000Z",
			id: "generated-widget-1",
			kind: "json_render_layout",
			metadata: { tediId: "tedi-1" },
			resourceUri: "ui://widgets/tedix/r/dashboard.html",
			status: "draft",
			title: "Dashboard widget",
		});
		expect(recorded).toBeNull();
		expect(state.artifacts).toHaveLength(1);
		expect(state.artifacts[0]?.organizationId).toBe("org-other");
		expect(state.events).toHaveLength(0);
	});

	it("treats Browser QA reports as document artifacts", () => {
		const artifact = generatedWidgetTediArtifactFromRecord({
			appId: "5eed0020-0000-4000-8000-000000000020",
			appSlug: "tedix",
			createdAt: "2026-05-25T10:00:00.000Z",
			id: "qa-report-1",
			kind: "browser_qa_report",
			metadata: { tediId: "tedi-1" },
			screenshotUrl: "https://os.tedix.dev/widgets/qa-report-1.png",
			status: "qa_passed",
			title: "Browser QA report",
		});

		expect(artifact).toMatchObject({
			id: "qa-report-1",
			kind: "document",
			mimeType: "application/json",
			tediId: "tedi-1",
			uri: "https://os.tedix.dev/widgets/qa-report-1.png",
		});
	});
});

describe("generated widget artifact publish subscription events", () => {
	const ORG_ID = "org-1";
	const APP_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
	const RESOURCE_URI = "ui://widgets/mcp-app/tedix/r/dashboard.html";

	function makeArtifactRow(): Record<string, unknown> {
		return {
			id: "generated-widget-1",
			organizationId: ORG_ID,
			appId: APP_ID,
			appSlug: "tedix",
			appToolId: null,
			toolId: null,
			toolName: null,
			kind: "json_render_layout",
			source: "tedi_generated",
			status: "qa_passed",
			title: "Dashboard widget",
			description: null,
			layoutSpec: null,
			inputSnapshot: null,
			outputSnapshot: null,
			resourceUri: RESOURCE_URI,
			widgetUrl: null,
			previewUrl: null,
			screenshotUrl: null,
			widgetTestRunId: "qa-run-1",
			workflowId: null,
			progressMessage: null,
			qaSummary: null,
			metadata: null,
			createdBy: null,
			publishedAt: null,
			createdAt: "2026-05-25T10:00:00.000Z",
			updatedAt: "2026-05-25T10:00:00.000Z",
		};
	}

	function makePublishHarness() {
		const artifactRow = makeArtifactRow();
		const runRow = {
			id: "qa-run-1",
			organizationId: ORG_ID,
			appId: APP_ID,
			appSlug: "tedix",
			toolName: "create_view",
			mode: "browser",
			passed: true,
			previewUrl: null,
		};
		const db = {
			select() {
				return {
					from(table: unknown) {
						return {
							where() {
								return {
									limit: async () => {
										if (table === widgetTestRuns) return [runRow];
										if (table === generatedWidgetArtifacts) {
											return [artifactRow];
										}
										return [];
									},
								};
							},
						};
					},
				};
			},
			update() {
				return {
					set(patch: Record<string, unknown>) {
						return {
							where: async () => {
								Object.assign(artifactRow, patch);
							},
						};
					},
				};
			},
		} as unknown as DbClient;

		const published: Array<{
			appId?: string;
			method: string;
			uri?: string;
		}> = [];
		const pending: Promise<unknown>[] = [];
		const env = {
			ENVIRONMENT: "test",
			MCP_SERVICE: {
				fetch: async (req: Request) => {
					published.push(
						(await req.json()) as {
							appId?: string;
							method: string;
							uri?: string;
						},
					);
					return new Response(null, { status: 200 });
				},
			},
		} as unknown as CloudflareEnv;

		const context = {
			authType: "user",
			db,
			env,
			headers: new Headers(),
			organizationId: ORG_ID,
			rateLimiter: {
				limit: vi.fn(async () => ({ success: true })),
			},
			url: new URL("https://api.tedix.test/rpc/generated-widget-artifacts"),
			user: {
				aud: "test",
				exp: 2,
				iat: 1,
				iss: "https://auth.tedix.test",
				sub: "user-1",
				dct: "tenant-1",
				permissions: ["apps:update"],
				roles: [],
			},
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(promise);
			},
		} as unknown as BaseContext;

		const client = createRouterClient(generatedWidgetArtifactsContractRouter, {
			context,
		});
		const flush = () => Promise.all(pending);
		return { client, flush, published };
	}

	it("publish emits resources/list_changed + resources/updated for the published resourceUri", async () => {
		const { client, flush, published } = makePublishHarness();

		const result = await client.publish({ id: "generated-widget-1" });
		await flush();

		expect(result.artifact.status).toBe("published");
		expect(published.map((p) => p.method)).toEqual([
			"notifications/resources/list_changed",
			"notifications/resources/updated",
		]);
		for (const event of published) {
			expect(event.appId).toBe(APP_ID);
		}
		expect(published[1]?.uri).toBe(RESOURCE_URI);
	});
});
