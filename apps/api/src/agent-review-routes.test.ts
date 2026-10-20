import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	tedi: vi.fn(),
	create: vi.fn(),
	byIntent: vi.fn(),
	byId: vi.fn(),
	comment: vi.fn(),
	getComment: vi.fn(),
	inject: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/projects", () => ({
	getProjectById: mocks.project,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	createWorkItem: mocks.create,
	getWorkItemBySourceIntentId: mocks.byIntent,
	getWorkItemById: mocks.byId,
}));
vi.mock("@tedix/db/queries/work-items/comments", () => ({
	addWorkItemCommentIfAbsent: mocks.comment,
	getWorkItemCommentById: mocks.getComment,
}));
vi.mock("@tedix/provisioning", () => ({
	buildProvisioningConfig: () => ({}),
	injectAgentMessage: mocks.inject,
}));

import { agentReviewRoutes } from "./agent-review-routes";
import {
	redactAgentReview,
	fileAgentReview,
	wakeAgentReview,
} from "./services/agent-review";

const project = {
	id: "fictional-project",
	orgId: "fictional-org",
	status: "active",
	objectiveId: "fictional-objective",
	leadTediId: "fictional-cto",
	metadata: { agentReviewEnabled: true },
};
const feedback = {
	version: 1,
	reviewedSha: "a".repeat(40),
	projectContext: "Fictional document review service",
	fitScore: 3,
	blockers: [],
	suggestions: [],
	bugs: [],
};
const payload = () => ({
	reportMarkdown: `# Tedix review\n${"A source inspection with no live execution. ".repeat(8)}\nContact demo@example.test. password=sample-sensitive-value`,
	feedback,
});
const limiter = vi.fn(async () => ({ success: true }));
function env() {
	return {
		AGENT_REVIEW_PROJECT_ID: project.id,
		AGENT_REVIEW_RATE_LIMITER: { limit: limiter },
		API_URL: "https://api.example.test",
		ENVIRONMENT: "production",
	} as unknown as CloudflareEnv;
}
function post(body: unknown = payload(), headers: Record<string, string> = {}) {
	return agentReviewRoutes.request(
		"https://api.example.test/",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		},
		env(),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	limiter.mockResolvedValue({ success: true });
	mocks.project.mockResolvedValue(project);
	mocks.tedi.mockResolvedValue({ slug: "fictional-cto" });
	mocks.byIntent.mockResolvedValue(null);
	mocks.create.mockImplementation(async (_db, item) => {
		mocks.byId.mockResolvedValue(item);
		return item;
	});
	mocks.getComment.mockResolvedValue(null);
	mocks.comment.mockImplementation(async (_db, comment) => {
		mocks.getComment.mockResolvedValue(comment);
		return { comment, inserted: true };
	});
	mocks.inject.mockResolvedValue({
		success: true,
		accepted: true,
		run_id: "fictional-run",
	});
});

describe("anonymous agent review intake", () => {
	it("requires TLS and rejects a filled honeypot before persistence", async () => {
		expect(
			(await agentReviewRoutes.request("http://api.example.test/", {}, env()))
				.status,
		).toBe(400);
		expect(
			(await post({ ...payload(), website: "https://spam.example.test" }))
				.status,
		).toBe(400);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("stores redacted proposed Work in the configured project and queues the existing wake", async () => {
		const response = await post();
		expect(response.status).toBe(201);
		const saved = mocks.create.mock.calls[0]![1];
		expect(saved).toMatchObject({
			orgId: project.orgId,
			projectId: project.id,
			objectiveId: project.objectiveId,
			metadata: { agentReview: true },
		});
		expect(saved.description).not.toContain("demo@example.test");
		expect(saved.description).not.toContain("sample-sensitive-value");
		expect(mocks.tedi).toHaveBeenCalledWith(
			{},
			project.leadTediId,
			project.orgId,
		);
		expect(mocks.inject.mock.calls[0]![1]).toMatchObject({
			async: true,
			clientRequestId: `agent-review:${saved.id}`,
		});
		const receipt = await response.json();
		expect(receipt.status).toBe("received");
		expect(mocks.comment.mock.calls[0]![1]).toMatchObject({
			workItemId: saved.id,
			metadata: { agentReviewWake: true },
		});
		expect(receipt.receiptUrl).toContain(
			"https://api.example.test/public/agent-review/",
		);
		expect(JSON.stringify(receipt)).not.toContain("projectContext");
		expect(JSON.stringify(receipt)).not.toContain(project.orgId);
	});
	it("deduplicates identical retries and never wakes twice after a queued receipt", async () => {
		await post();
		const item = mocks.create.mock.calls[0]![1];
		mocks.byIntent.mockResolvedValue(item);
		mocks.getComment.mockResolvedValue({
			metadata: { runId: "fictional-run" },
		});
		expect((await post()).status).toBe(201);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.inject).toHaveBeenCalledTimes(1);
	});
	it("recovers a concurrent unique-key race by reading the canonical Work", async () => {
		const item = {
			id: crypto.randomUUID(),
			projectId: project.id,
			metadata: { agentReview: true },
		};
		mocks.create.mockRejectedValue(new Error("unique constraint"));
		mocks.byIntent.mockResolvedValueOnce(null).mockResolvedValueOnce(item);
		mocks.byId.mockResolvedValue(item);
		expect((await post()).status).toBe(201);
	});
	it("keeps a stored report pending when wake fails, so identical retry can recover", async () => {
		mocks.inject.mockRejectedValue(new Error("offline"));
		const response = await post();
		expect(response.status).toBe(201);
		expect((await response.json()).status).toBe("received");
		expect(mocks.comment).not.toHaveBeenCalled();
	});
	it.each([
		undefined,
		{ ...project, status: "paused" },
		{ ...project, metadata: {} },
	])("fails closed for an unavailable destination", async (destination) => {
		mocks.project.mockResolvedValue(destination);
		expect((await post()).status).toBe(503);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("does not bypass the IP limit for forged service credentials", async () => {
		limiter.mockResolvedValue({ success: false });
		const response = await post(payload(), {
			"X-Service-Binding": "true",
			"CF-Connecting-IP": "192.0.2.8",
		});
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("caps rotating-IP traffic with a global submission bucket", async () => {
		limiter
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: false });
		expect((await post()).status).toBe(429);
		expect(limiter).toHaveBeenLastCalledWith({ key: "agent-review:global" });
	});
	it("fails closed when the limiter throws or is missing", async () => {
		limiter.mockRejectedValueOnce(new Error("offline"));
		expect((await post()).status).toBe(503);
		const unavailable = {
			...env(),
			AGENT_REVIEW_RATE_LIMITER: undefined,
		} as unknown as CloudflareEnv;
		expect(
			(
				await agentReviewRoutes.request(
					"https://api.example.test/",
					{},
					unavailable,
				)
			).status,
		).toBe(503);
	});
	it("caps bodies regardless of Content-Length", async () => {
		expect(
			(await post({ ...payload(), reportMarkdown: "🛰".repeat(20000) })).status,
		).toBe(413);
	});
	it.each([
		{ ...payload(), orgId: "other-org" },
		{ ...payload(), feedback: { ...feedback, fitScore: 6 } },
		{ ...payload(), reportMarkdown: "x".repeat(200) },
	])("rejects invalid or spam input before persistence", async (body) => {
		expect((await post(body)).status).toBe(400);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("does not disclose arbitrary Work or cross-project reports through receipts", async () => {
		mocks.byId.mockResolvedValue({
			id: "unknown",
			projectId: "other-project",
			metadata: { agentReview: true },
		});
		const response = await agentReviewRoutes.request(
			`https://api.example.test/${crypto.randomUUID()}`,
			{},
			env(),
		);
		expect(response.status).toBe(404);
		expect(mocks.byId.mock.calls[0]![2]).toBe(project.orgId);
	});
	it("redacts credentials and URL credentials/query without destroying Markdown", () => {
		const source =
			"Bearer example-token password=example-password demo@example.test https://user:pass@example.test/path?token=private#secret";
		const result = redactAgentReview(source);
		expect(result).not.toContain("example-token");
		expect(result).not.toContain("example-password");
		expect(result).not.toContain("user:pass");
		expect(result).not.toContain("token=private");
		expect(result).toContain("https://example.test/path");
	});
});

describe("review privacy boundary", () => {
	it("rejects HTTP without redirecting or reading the body", async () => {
		const response = await agentReviewRoutes.request(
			"http://api.example.test/",
			{ method: "POST", body: JSON.stringify(payload()) },
			env(),
		);
		expect(response.status).toBe(400);
		expect(response.headers.get("Location")).toBeNull();
		expect(mocks.create).not.toHaveBeenCalled();
		expect(limiter).not.toHaveBeenCalled();
	});
	it("rejects an insecure receipt origin before storage", async () => {
		const response = await agentReviewRoutes.request(
			"https://api.example.test/",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload()),
			},
			{ ...env(), API_URL: "http://api.example.test" },
		);
		expect(response.status).toBe(503);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("rejects a filled honeypot before storage or wake", async () => {
		expect(
			(await post({ ...payload(), website: "https://spam.example.test" }))
				.status,
		).toBe(400);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.inject).not.toHaveBeenCalled();
		expect((await post({ ...payload(), website: "" })).status).toBe(201);
	});
	it("enforces actual streamed bytes even with a dishonest Content-Length", async () => {
		const body = `${JSON.stringify(payload())}${" ".repeat(32 * 1024)}`;
		const response = await agentReviewRoutes.request(
			"https://api.example.test/",
			{
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": "1" },
				body,
			},
			env(),
		);
		expect(response.status).toBe(413);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("returns an unguessable receipt that shows only received", async () => {
		const response = await post();
		const receipt = await response.json();
		expect(Object.keys(receipt).sort()).toEqual(["receiptUrl", "status"]);
		const id = new URL(receipt.receiptUrl).pathname.split("/").at(-1);
		expect(id).toMatch(
			/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
		);
		const read = await agentReviewRoutes.request(
			`https://api.example.test/${id}`,
			{},
			env(),
		);
		expect(await read.text()).toBe("received");
		expect(read.headers.get("Cache-Control")).toBe("no-store");
		expect(read.headers.get("Referrer-Policy")).toBe("no-referrer");
	});
	it("redacts structured feedback and never logs a submitted body", async () => {
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await post({
				...payload(),
				feedback: {
					...feedback,
					projectContext:
						"email demo@example.test password=private-secret-value",
				},
			});
			const saved = mocks.create.mock.calls[0]![1];
			expect(saved.metadata.feedback.projectContext).not.toContain(
				"demo@example.test",
			);
			expect(saved.metadata.feedback.projectContext).not.toContain(
				"private-secret-value",
			);
			mocks.project.mockRejectedValueOnce(new Error(payload().reportMarkdown));
			expect((await post()).status).toBe(503);
			const logged = JSON.stringify([
				logs.mock.calls,
				warnings.mock.calls,
				errors.mock.calls,
			]);
			expect(logged).not.toContain("demo@example.test");
			expect(logged).not.toContain("sample-sensitive-value");
			const wake = mocks.inject.mock.calls[0]![1].message;
			expect(wake).toContain("Never publish");
			expect(wake).toContain("same Agent reviews project");
			expect(wake).not.toContain("sample-sensitive-value");
		} finally {
			logs.mockRestore();
			warnings.mockRestore();
			errors.mockRestore();
		}
	});
});

it("keeps intake disabled in local onboarding even when a project placeholder is present", async () => {
	await expect(
		fileAgentReview(
			{} as never,
			{
				...env(),
				ENVIRONMENT: "development",
				DESCOPE_PROJECT_ID: "local-development-disabled",
			},
			payload(),
		),
	).rejects.toMatchObject({ status: 503 });
	expect(mocks.project).not.toHaveBeenCalled();
	expect(mocks.create).not.toHaveBeenCalled();
});
it("recovery uses a new turn key and requests a durable result without embedding review content", async () => {
	await wakeAgentReview(
		{} as never,
		env(),
		project as never,
		{ id: "review-id" },
		2,
	);
	expect(mocks.inject).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			clientRequestId: "agent-review:review-id:retry:2",
			message: expect.stringContaining("metadata.agentReviewTriageResult=true"),
		}),
	);
});
