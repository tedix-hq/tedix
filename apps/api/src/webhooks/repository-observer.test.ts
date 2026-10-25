import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { Hono } from "hono";
import { ORPCError } from "@orpc/server";
import { verifyGithubActionsWorkloadToken } from "@tedix/auth/workload-identity";
import { registerCorsAndLimits } from "../http/cors-and-limits";
import {
	observerConfig,
	observeRepositoryEvent,
} from "../services/repository-observer";
vi.mock("@tedix/auth/workload-identity", () => ({
	verifyGithubActionsWorkloadToken: vi.fn(),
}));
vi.mock("../rpc/orpc", () => ({
	createContext: () => ({ db: {} }),
}));
vi.mock("../rpc/routers/kernel/runtime-shared", () => ({
	buildInternalServiceBindingContext: (
		base: object,
		organizationId: string,
	) => ({ ...base, organizationId }),
}));
vi.mock("../services/repository-observer", () => ({
	observerConfig: vi.fn(),
	observeRepositoryEvent: vi.fn(),
}));
import {
	RepositoryObserverConfigSchema,
	RepositoryEventSchema,
} from "@tedix/api-contract/schemas/repository-observer";
import {
	acceptsObserverClaims,
	observerSubject,
	handleRepositoryObserverWebhook,
} from "./repository-observer";
const config = RepositoryObserverConfigSchema.parse({
	repository: "example/product",
	shipRepository: "example/ops",
	ownerTediId: "11111111-1111-4111-8111-111111111111",
	escalationUserId: "owner-example",
	instructions: "Diagnose events after reading canonical evidence.",
});
const event = RepositoryEventSchema.parse({
	projectId: "22222222-2222-4222-8222-222222222222",
	repository: "example/product",
	branch: "main",
	sha: "a".repeat(40),
	kind: "push",
	summary: "docs change",
	evidenceUrl: "https://github.com/example/product/commit/" + "a".repeat(40),
});
const claims = {
	repository: "example/product",
	ref: "refs/heads/main",
	workflow_ref:
		"example/product/.github/workflows/tedix-observer.yml@refs/heads/main",
	event_name: "push",
	sha: event.sha,
};
describe("observer subject formats", () => {
	it("binds legacy and immutable subjects to the configured repository and branch", () => {
		const legacy = "repo:example/product:ref:refs/heads/main";
		expect(observerSubject("example/product", "main", { sub: legacy })).toBe(
			legacy,
		);
		const immutable = {
			sub: "repo:example@123/product@456:ref:refs/heads/main",
			repository_owner_id: "123",
			repository_id: "456",
		};
		expect(observerSubject("example/product", "main", immutable)).toBe(
			immutable.sub,
		);
		for (const changed of [
			{ repository_owner_id: "999" },
			{ repository_id: "999" },
			{ repository_id: "456:ref:refs/heads/main" },
			{ repository_id: undefined },
			{ sub: "repo:attacker@123/product@456:ref:refs/heads/main" },
			{ sub: "repo:example@123/product@456:ref:refs/heads/topic" },
		])
			expect(
				observerSubject("example/product", "main", {
					...immutable,
					...changed,
				}),
			).toBeNull();
		expect(observerSubject("example/ops", "main", immutable)).toBeNull();
	});
});
describe("observer workload binding after signature verification", () => {
	it.each(["ci_red", "ci_green"] as const)(
		"binds %s reports to the configured product observer workflow",
		(kind) => {
			const red = { ...event, kind };
			const ci = { ...claims, event_name: "workflow_run", sha: "b".repeat(40) };
			expect(acceptsObserverClaims(config, red, ci)).toBe(true);
			for (const changed of [
				{ repository: "example/ops" },
				{ ref: "refs/heads/topic" },
				{
					workflow_ref:
						"example/product/.github/workflows/untrusted.yml@refs/heads/main",
				},
				{ event_name: "push" },
				{ event_name: "schedule" },
			])
				expect(acceptsObserverClaims(config, red, { ...ci, ...changed })).toBe(
					false,
				);
		},
	);
	it("accepts only the configured main workflow and exact pushed SHA", () => {
		expect(acceptsObserverClaims(config, event, claims)).toBe(true);
		for (const changed of [
			{ repository: "attacker/fork" },
			{ ref: "refs/heads/topic" },
			{
				workflow_ref:
					"example/product/.github/workflows/untrusted.yml@refs/heads/main",
			},
			{ event_name: "pull_request" },
			{ sha: "b".repeat(40) },
		])
			expect(
				acceptsObserverClaims(config, event, { ...claims, ...changed }),
			).toBe(false);
	});
	it("requires a separately configured Ship repository and workflow_run identity", () => {
		const red = { ...event, kind: "ship_red" as const };
		expect(acceptsObserverClaims(config, red, claims)).toBe(false);
		const ops = {
			...claims,
			repository: "example/ops",
			workflow_ref:
				"example/ops/.github/workflows/tedix-observer.yml@refs/heads/main",
			event_name: "workflow_run",
		};
		expect(acceptsObserverClaims(config, red, ops)).toBe(true);
		expect(
			acceptsObserverClaims({ ...config, shipRepository: undefined }, red, ops),
		).toBe(false);
	});
});

it("rejects oversized notifications before tenant reads or dispatch", async () => {
	const app = new Hono<{ Bindings: CloudflareEnv }>();
	app.post(
		"/webhooks/repository-observer/:orgId/:projectId",
		handleRepositoryObserverWebhook,
	);
	const response = await app.request(
		"https://api.example/webhooks/repository-observer/org-example/project-example",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": "128001",
			},
			body: "x".repeat(128001),
		},
		{} as CloudflareEnv,
	);
	expect(response.status).toBe(413);
	expect(observerConfig).not.toHaveBeenCalled();
	expect(observeRepositoryEvent).not.toHaveBeenCalled();
});

describe("authenticated observer HTTP error boundary", () => {
	const traceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const token = [
		btoa(JSON.stringify({ alg: "RS256" })),
		btoa(
			JSON.stringify({
				...claims,
				sub: "repo:example/product:ref:refs/heads/main",
			}),
		),
		"fixture-signature",
	].join(".");
	const receipt = {
		observationId: "33333333-3333-4333-8333-333333333333",
		workItemId: "44444444-4444-4444-8444-444444444444",
		status: "queued",
	};
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(observerConfig).mockResolvedValue({ config } as Awaited<
			ReturnType<typeof observerConfig>
		>);
		vi.mocked(observeRepositoryEvent).mockResolvedValue(receipt);
		vi.mocked(verifyGithubActionsWorkloadToken).mockImplementation(
			async () =>
				({}) as Awaited<ReturnType<typeof verifyGithubActionsWorkloadToken>>,
		);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());
	async function notify(body: unknown = event) {
		const app = new Hono<{ Bindings: CloudflareEnv }>();
		registerCorsAndLimits(app);
		app.post(
			"/webhooks/repository-observer/:orgId/:projectId",
			handleRepositoryObserverWebhook,
		);
		return app.request(
			`https://api.example/webhooks/repository-observer/org-example/${event.projectId}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"X-Tedix-Trace-Id": traceId,
				},
				body: JSON.stringify(body),
			},
			{ API_URL: "https://api.example" } as CloudflareEnv,
		);
	}
	it("returns the accepted receipt only after exact workload identity verification", async () => {
		const response = await notify();
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual(receipt);
		expect(response.headers.get("X-Tedix-Trace-Id")).toBe(traceId);
		expect(verifyGithubActionsWorkloadToken).toHaveBeenCalledWith(token, {
			expectedAudience: "tedix:repository-observer",
			expectedSubject: "repo:example/product:ref:refs/heads/main",
		});
		expect(observeRepositoryEvent).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ organizationId: "org-example" }),
			"org-example",
			event,
		);
	});
	it.each([
		["FORBIDDEN", 403, "PRIVATE policy refusal"],
		[
			"BAD_REQUEST",
			400,
			"Event does not match the configured repository and branch",
		],
		["NOT_FOUND", 404, "Commit Work item unavailable"],
	] as const)(
		"preserves %s refusal with correlation and a redacted original cause",
		async (code, status, message) => {
			vi.mocked(observeRepositoryEvent).mockRejectedValue(
				new ORPCError(code, { message }),
			);
			const response = await notify();
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({ error: code, status });
			expect(response.headers.get("X-Tedix-Trace-Id")).toBe(traceId);
			expect(console.error).toHaveBeenCalledWith(
				"[API Error]",
				expect.objectContaining({
					cause: expect.objectContaining({
						name: "ORPCError",
						code,
						valueRedacted: true,
					}),
				}),
			);
			expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
				message,
			);
		},
	);
	it.each([
		new Error("PRIVATE upstream payload credential"),
		new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "PRIVATE dispatch failure",
		}),
		new ORPCError("CUSTOM_DOMAIN_FAILURE", {
			message: "PRIVATE custom failure",
		}),
	])(
		"keeps unexpected failures at 500 without exposing private text: %j",
		async (error) => {
			vi.mocked(observeRepositoryEvent).mockRejectedValue(error);
			const response = await notify();
			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: "Internal Server Error",
			});
			expect(response.headers.get("X-Tedix-Trace-Id")).toBe(traceId);
			expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
				"PRIVATE",
			);
		},
	);
	it("does not dispatch after failed signature verification", async () => {
		vi.mocked(verifyGithubActionsWorkloadToken).mockRejectedValue(
			new Error("PRIVATE invalid signature"),
		);
		const response = await notify();
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("Invalid event identity");
		expect(observeRepositoryEvent).not.toHaveBeenCalled();
	});
	it("does not authenticate or dispatch a malformed event", async () => {
		const response = await notify({ ...event, sha: "invalid" });
		expect(response.status).toBe(400);
		expect(verifyGithubActionsWorkloadToken).not.toHaveBeenCalled();
		expect(observeRepositoryEvent).not.toHaveBeenCalled();
	});
	it("rejects a valid event whose SHA differs from its workload claims", async () => {
		const response = await notify({ ...event, sha: "b".repeat(40) });
		expect(response.status).toBe(403);
		expect(verifyGithubActionsWorkloadToken).not.toHaveBeenCalled();
		expect(observeRepositoryEvent).not.toHaveBeenCalled();
	});
	it("keeps unavailable observer configuration private and stops before authentication", async () => {
		vi.mocked(observerConfig).mockRejectedValue(
			new Error("PRIVATE config detail"),
		);
		const response = await notify();
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Observer unavailable");
		expect(verifyGithubActionsWorkloadToken).not.toHaveBeenCalled();
		expect(observeRepositoryEvent).not.toHaveBeenCalled();
	});
});
