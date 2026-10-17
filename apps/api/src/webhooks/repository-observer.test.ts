import { describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
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
});
