import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelRequestPolicy } from "@tedix/api-contract/schemas/kernel-request";
import type { BaseContext } from "../rpc/orpc";
import {
	kernelAcceptanceReader,
	readConfiguredRepositoryDelivery,
} from "./request-target-readers";
const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	access: vi.fn(),
	output: vi.fn(),
	workspace: vi.fn(),
	defaultCredential: vi.fn(),
}));
vi.mock("../services/default-connection-reference", async (original) => ({
	...(await original<
		typeof import("../services/default-connection-reference")
	>()),
	readDefaultRepositoryCredential: mocks.defaultCredential,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
vi.mock("./conversation-access", () => ({
	resolveKernelConversationAccess: mocks.access,
}));
vi.mock("@tedix/db/queries/os-workspaces/outputs", () => ({
	getOsOutput: mocks.output,
}));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/os-workspaces/workspaces")
	>()),
	getOsWorkspace: mocks.workspace,
}));
const source = {
	organizationId: "org-example",
	ownerUserId: "user-ada",
	conversationId: "home-one",
};
const context = { db: {} } as BaseContext;
const sha = "a".repeat(40);
const policy: KernelRequestPolicy = {
	version: 1,
	enabled: true,
	nextOwner: "kernel",
	retryMs: 1000,
	probeTimeoutMs: 1000,
	maxProbeAttempts: 3,
	runBudgetMs: 1000,
	repositoryTargets: [
		{
			id: "repo-one",
			repository: "example/product",
			shipRepository: "example/operations",
			workflowId: "ship.yml",
			surface: "app",
			liveManifestUrl: "https://app.example.com/build.json",
			maxAgeMs: 60_000,
		},
	],
};
const outputCheck = {
	kind: "os_output_revision" as const,
	outputId: "output-one",
	revisionId: "revision-one",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.member.mockResolvedValue({ status: "active" });
	mocks.access.mockResolvedValue({ allowed: true });
	mocks.output.mockResolvedValue({
		id: "output-one",
		status: "active",
		workspaceId: "workspace-one",
		currentRevisionId: "revision-one",
	});
	mocks.workspace.mockResolvedValue({
		id: "workspace-one",
		visibility: "private",
		ownerUserId: source.ownerUserId,
	});
});
describe("trusted request target readers", () => {
	it("reads actual OS state under the current tenant and private workspace ACL", async () => {
		const reader = kernelAcceptanceReader(context, source, policy);
		expect((await reader.readOutputRevision(outputCheck)).revisionId).toBe(
			"revision-one",
		);
		expect(mocks.output).toHaveBeenCalledWith(context.db, {
			organizationId: source.organizationId,
			outputId: outputCheck.outputId,
		});
		mocks.workspace.mockResolvedValue({
			id: "workspace-one",
			visibility: "private",
			ownerUserId: "user-other",
		});
		await expect(reader.readOutputRevision(outputCheck)).rejects.toThrow(
			"denied",
		);
	});
	it("rejects revoked membership and source conversation access before reading targets", async () => {
		const reader = kernelAcceptanceReader(context, source, policy);
		mocks.member.mockResolvedValue({ status: "inactive" });
		await expect(reader.readOutputRevision(outputCheck)).rejects.toThrow(
			"active member",
		);
		mocks.member.mockResolvedValue({ status: "active" });
		mocks.access.mockResolvedValue({ allowed: false });
		await expect(reader.readOutputRevision(outputCheck)).rejects.toThrow(
			"revoked",
		);
		expect(mocks.output).not.toHaveBeenCalled();
	});
	it("ties successful Ship logs to the exact product SHA and live deployment manifest", async () => {
		const fetchFn = vi.fn(async (url: string | URL | Request) => {
			const path = String(url);
			if (path.endsWith("/commits/main")) return Response.json({ sha });
			if (path.endsWith("/actions/workflows/ship.yml"))
				return Response.json({ id: 42, path: ".github/workflows/ship.yml" });
			if (path.endsWith("/actions/runs/7")) return Response.json(shipRun());
			if (path.endsWith("build.json"))
				return Response.json({
					repository: "example/product",
					commitSha: sha,
					surface: "app",
					deploymentRunId: 7,
				});
			if (path.includes("/jobs?"))
				return Response.json({ jobs: [{ id: 9, conclusion: "success" }] });
			if (path.endsWith("/logs"))
				return new Response(`timestamp verified: app is live on ${sha}\n`);
			throw new Error("unexpected target");
		}) as typeof fetch;
		const reader = kernelAcceptanceReader(context, source, policy, fetchFn);
		expect(
			await reader.readRepositoryDelivery({
				kind: "repository_delivery",
				targetId: "repo-one",
				commitSha: sha,
				surface: "app",
			}),
		).toMatchObject({
			mainSha: sha,
			shipSha: sha,
			liveSha: sha,
			surface: "app",
			shipStatus: "success",
		});
	});
	it("does not accept an unconfigured target or generic healthy response as deployment proof", async () => {
		const fetchFn = vi.fn(async () =>
			Response.json({ healthy: true }),
		) as typeof fetch;
		const reader = kernelAcceptanceReader(context, source, policy, fetchFn);
		await expect(
			reader.readRepositoryDelivery({
				kind: "repository_delivery",
				targetId: "other",
				commitSha: sha,
				surface: "app",
			}),
		).rejects.toThrow("not configured");
		expect(fetchFn).not.toHaveBeenCalled();
		await expect(
			reader.readRepositoryDelivery({
				kind: "repository_delivery",
				targetId: "repo-one",
				commitSha: sha,
				surface: "app",
			}),
		).rejects.toThrow();
	});
});

function ancestryFetch(
	change?: (body: Record<string, unknown>, index: number) => unknown,
) {
	const live = "b".repeat(40),
		main = "c".repeat(40);
	let compares = 0;
	const paths: string[] = [];
	const fetchFn = vi.fn(async (url: string | URL | Request) => {
		const path = String(url);
		paths.push(path);
		if (path.endsWith("/commits/main")) return Response.json({ sha: main });
		if (path.endsWith("/actions/workflows/ship.yml"))
			return Response.json({ id: 42, path: ".github/workflows/ship.yml" });
		if (path.endsWith("/actions/runs/7")) return Response.json(shipRun());
		if (path.endsWith("build.json"))
			return Response.json({
				repository: "example/product",
				commitSha: live,
				surface: "app",
				deploymentRunId: 7,
			});
		if (path.includes("/jobs?"))
			return Response.json({ jobs: [{ id: 9, conclusion: "success" }] });
		if (path.endsWith("/logs"))
			return new Response(`timestamp verified: app is live on ${live}\n`);
		const pair =
			/\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=1$/.exec(path);
		if (pair) {
			const body = {
				status: pair[1] === pair[2] ? "identical" : "ahead",
				ahead_by: pair[1] === pair[2] ? 0 : 1,
				behind_by: 0,
				base_commit: { sha: pair[1] },
				merge_base_commit: { sha: pair[1] },
			};
			const changed = change?.(body, compares++);
			return changed instanceof Response
				? changed
				: Response.json(changed ?? body);
		}
		throw new Error("Unexpected provider request");
	}) as typeof fetch;
	return { fetchFn, paths, live, main };
}

describe("configured source ancestry through actual live to current main", () => {
	it.each(["ancestor", "identical"])(
		"verifies %s using two exact configured compare pairs",
		async (kind) => {
			const f = ancestryFetch();
			const sourceCommit = kind === "identical" ? f.live : sha;
			const result = await readConfiguredRepositoryDelivery(
				context,
				source.organizationId,
				policy,
				{
					kind: "repository_delivery",
					targetId: "repo-one",
					surface: "app",
					commitSha: f.live,
					sourceCommit,
				},
				f.fetchFn,
			);
			expect(result.sourceAncestry).toEqual({
				sourceCommit,
				liveCommitSha: f.live,
				mainCommitSha: f.main,
			});
			expect(f.paths.filter((path) => path.includes("/compare/"))).toEqual([
				`https://api.github.com/repos/example/product/compare/${sourceCommit}...${f.live}?per_page=1`,
				`https://api.github.com/repos/example/product/compare/${f.live}...${f.main}?per_page=1`,
			]);
		},
	);
	it.each([
		"source diverged",
		"main diverged",
		"behind",
		"base mismatch",
		"merge-base mismatch",
		"malformed",
		"over budget",
	])("refuses %s instead of inferring push ancestry", async (kind) => {
		const f = ancestryFetch((body, index) => {
			if (kind === "main diverged" && index !== 1) return body;
			if (kind === "source diverged" && index !== 0) return body;
			if (kind === "source diverged" || kind === "main diverged")
				return {
					...body,
					status: "diverged",
					behind_by: 1,
					merge_base_commit: { sha: "d".repeat(40) },
				};
			if (kind === "behind") return { ...body, status: "behind", behind_by: 1 };
			if (kind === "base mismatch")
				return { ...body, base_commit: { sha: "d".repeat(40) } };
			if (kind === "merge-base mismatch")
				return { ...body, merge_base_commit: { sha: "d".repeat(40) } };
			if (kind === "malformed") return { status: "ahead" };
			if (kind === "over budget") return new Response("x".repeat(1_000_001));
			return body;
		});
		await expect(
			readConfiguredRepositoryDelivery(
				context,
				source.organizationId,
				policy,
				{
					kind: "repository_delivery",
					targetId: "repo-one",
					surface: "app",
					commitSha: f.live,
					sourceCommit: sha,
				},
				f.fetchFn,
			),
		).rejects.toThrow();
		expect(
			f.paths.filter((path) => path.includes("/compare/")).length,
		).toBeLessThanOrEqual(2);
	});
	it("refuses a short source identity before any provider read", async () => {
		const f = ancestryFetch();
		await expect(
			readConfiguredRepositoryDelivery(
				context,
				source.organizationId,
				policy,
				{
					kind: "repository_delivery",
					targetId: "repo-one",
					surface: "app",
					commitSha: f.live,
					sourceCommit: "abc",
				},
				f.fetchFn,
			),
		).rejects.toThrow("Invalid source");
		expect(f.paths).toEqual([]);
	});
	it("refuses live manifest drift before compare reads", async () => {
		const f = ancestryFetch();
		await expect(
			readConfiguredRepositoryDelivery(
				context,
				source.organizationId,
				policy,
				{
					kind: "repository_delivery",
					targetId: "repo-one",
					surface: "app",
					commitSha: sha,
					sourceCommit: sha,
				},
				f.fetchFn,
			),
		).rejects.toThrow();
		expect(f.paths.filter((path) => path.includes("/compare/"))).toEqual([]);
	});
	it("keeps legacy callers free of added compare reads or response fields", async () => {
		const f = ancestryFetch();
		const result = await readConfiguredRepositoryDelivery(
			context,
			source.organizationId,
			policy,
			{
				kind: "repository_delivery",
				targetId: "repo-one",
				surface: "app",
				commitSha: f.live,
			},
			f.fetchFn,
		);
		expect(result.sourceAncestry).toBeUndefined();
		expect(f.paths.filter((path) => path.includes("/compare/"))).toEqual([]);
	});
});

function shipRun() {
	return {
		id: 7,
		workflow_id: 42,
		path: ".github/workflows/ship.yml",
		repository: { full_name: "example/operations" },
		status: "completed",
		conclusion: "success",
		html_url: "https://github.com/example/operations/actions/runs/7",
		updated_at: new Date().toISOString(),
	};
}

describe("exact managed Ship identity", () => {
	it.each([".github/workflows/ship.yml", ".github/workflows/ship.yml@main"])(
		"reads exact run outside any latest-runs window: %s",
		async (workflowPath) => {
			const f = ancestryFetch();
			const fetchFn = vi.fn(async (...args: Parameters<typeof fetch>) =>
				String(args[0]).endsWith("/actions/runs/7")
					? Response.json({ ...shipRun(), path: workflowPath })
					: f.fetchFn(...args),
			) as typeof fetch;
			await readConfiguredRepositoryDelivery(
				context,
				source.organizationId,
				policy,
				{
					kind: "repository_delivery",
					targetId: "repo-one",
					surface: "app",
					commitSha: f.live,
				},
				fetchFn,
			);
			expect(
				fetchFn.mock.calls.some((call) => String(call[0]).includes("/runs?")),
			).toBe(false);
		},
	);
	it.each([
		{ id: 8 },
		{ workflow_id: 99 },
		{ repository: { full_name: "other/operations" } },
		{ path: ".github/workflows/other.yml" },
		{ path: ".github/workflows/ship.yml@" },
		{ path: ".github/workflows/ship.yml.evil" },
		{ status: "in_progress" },
		{ conclusion: "failure" },
		{ updated_at: new Date(Date.now() - 120000).toISOString() },
		{ updated_at: new Date(Date.now() + 60000).toISOString() },
	])("refuses a mismatched or stale exact run", async (change) => {
		const f = ancestryFetch();
		const fetchFn = vi.fn(async (...args: Parameters<typeof fetch>) =>
			String(args[0]).endsWith("/actions/runs/7")
				? Response.json({ ...shipRun(), ...change })
				: f.fetchFn(...args),
		) as typeof fetch;
		await expect(
			readConfiguredRepositoryDelivery(
				context,
				source.organizationId,
				policy,
				{
					kind: "repository_delivery",
					targetId: "repo-one",
					surface: "app",
					commitSha: f.live,
				},
				fetchFn,
			),
		).rejects.toThrow();
		expect(f.paths.some((path) => path.includes("/jobs?"))).toBe(false);
	});
	it.each(["workflow", "run"])(
		"bounds %s response bytes before parsing",
		async (kind) => {
			const f = ancestryFetch();
			const fetchFn = vi.fn(async (...args: Parameters<typeof fetch>) =>
				String(args[0]).endsWith(
					kind === "run" ? "/actions/runs/7" : "/actions/workflows/ship.yml",
				)
					? new Response(" ".repeat(1000001))
					: f.fetchFn(...args),
			) as typeof fetch;
			await expect(
				readConfiguredRepositoryDelivery(
					context,
					source.organizationId,
					policy,
					{
						kind: "repository_delivery",
						targetId: "repo-one",
						surface: "app",
						commitSha: f.live,
					},
					fetchFn,
				),
			).rejects.toThrow("budget");
		},
	);
});

describe("private GitHub logs download", () => {
	const selectedPolicy: KernelRequestPolicy = {
		...policy,
		repositoryTargets: policy.repositoryTargets.map((target) => ({
			...target,
			defaultTenantCredential: {
				organizationId: source.organizationId,
				providerId: "github-pat-key",
				scope: "tenant",
				accountRevisionDigest: "a".repeat(64),
			},
		})),
	};
	const check = {
		kind: "repository_delivery" as const,
		targetId: "repo-one",
		surface: "app",
		commitSha: "b".repeat(40),
	};
	it("uses the PAT only for GitHub and downloads the signed receipt without headers", async () => {
		mocks.defaultCredential.mockResolvedValue("fictional-pat");
		const f = ancestryFetch();
		const signed = "https://downloads.example.com/logs?signature=private";
		const fetchFn = vi.fn(async (...args: Parameters<typeof fetch>) =>
			String(args[0]).endsWith("/logs")
				? new Response(null, { status: 302, headers: { Location: signed } })
				: String(args[0]) === signed
					? new Response(`verified: app is live on ${f.live}`)
					: f.fetchFn(...args),
		);
		await readConfiguredRepositoryDelivery(
			context,
			source.organizationId,
			selectedPolicy,
			check,
			fetchFn as typeof fetch,
		);
		const download = fetchFn.mock.calls.find(
			(call) => String(call[0]) === signed,
		)!;
		expect(download[1]?.headers).toBeUndefined();
		expect(download[1]?.redirect).toBe("manual");
		const api = fetchFn.mock.calls.find((call) =>
			String(call[0]).endsWith("/logs"),
		)!;
		expect(new Headers(api[1]?.headers).get("Authorization")).toBe(
			"Bearer fictional-pat",
		);
	});
	it.each(["unsafe", "missing", "redirect", "oversized"])(
		"fails closed on %s signed download",
		async (kind) => {
			const f = ancestryFetch();
			const signed = "https://downloads.example.com/logs?signature=private";
			const fetchFn = vi.fn(async (...args: Parameters<typeof fetch>) => {
				const path = String(args[0]);
				if (
					path.endsWith("/logs") &&
					path.startsWith("https://api.github.com/")
				)
					return new Response(null, {
						status: 302,
						headers:
							kind === "missing"
								? {}
								: {
										Location:
											kind === "unsafe" ? "https://127.0.0.1/logs" : signed,
									},
					});
				if (path === signed)
					return kind === "redirect"
						? new Response(null, {
								status: 302,
								headers: { Location: "https://other.example.com/logs" },
							})
						: new Response("x".repeat(1000001));
				return f.fetchFn(...args);
			});
			await expect(
				readConfiguredRepositoryDelivery(
					context,
					source.organizationId,
					policy,
					check,
					fetchFn as typeof fetch,
				),
			).rejects.toThrow();
			expect(
				fetchFn.mock.calls.some((call) =>
					String(call[0]).startsWith("https://127.0.0.1"),
				),
			).toBe(false);
			expect(
				fetchFn.mock.calls.some((call) =>
					String(call[0]).startsWith("https://other.example.com"),
				),
			).toBe(false);
		},
	);
	it("does not call GitHub after live credential verification fails", async () => {
		mocks.defaultCredential.mockRejectedValue(
			new Error("Default connection revision changed or unavailable"),
		);
		const fetchFn = vi.fn();
		await expect(
			readConfiguredRepositoryDelivery(
				context,
				source.organizationId,
				selectedPolicy,
				check,
				fetchFn,
			),
		).rejects.toThrow("revision changed");
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("configured workflow lookup", () => {
	it.each(["ship.yml", "42"])(
		"checks configured workflow identity for %s",
		async (workflowId) => {
			const f = ancestryFetch();
			const p = {
				...policy,
				repositoryTargets: policy.repositoryTargets.map((target) => ({
					...target,
					workflowId,
				})),
			};
			const fetchFn = vi.fn(async (...args: Parameters<typeof fetch>) =>
				String(args[0]).endsWith(`/actions/workflows/${workflowId}`)
					? Response.json({ id: 42, path: ".github/workflows/ship.yml" })
					: f.fetchFn(...args),
			);
			await expect(
				readConfiguredRepositoryDelivery(
					context,
					source.organizationId,
					p,
					{
						kind: "repository_delivery",
						targetId: "repo-one",
						surface: "app",
						commitSha: f.live,
					},
					fetchFn as typeof fetch,
				),
			).resolves.toMatchObject({ shipStatus: "success" });
		},
	);
	it.each([
		{ id: 43, path: ".github/workflows/ship.yml" },
		{ id: 42, path: ".github/workflows/wrong.yml" },
	])("refuses configured workflow mismatch", async (workflow) => {
		const f = ancestryFetch();
		const numeric = workflow.id === 43;
		const p = {
			...policy,
			repositoryTargets: policy.repositoryTargets.map((target) => ({
				...target,
				workflowId: numeric ? "42" : "ship.yml",
			})),
		};
		const fetchFn = vi.fn(async (...args: Parameters<typeof fetch>) =>
			String(args[0]).includes("/actions/workflows/")
				? Response.json(workflow)
				: f.fetchFn(...args),
		);
		await expect(
			readConfiguredRepositoryDelivery(
				context,
				source.organizationId,
				p,
				{
					kind: "repository_delivery",
					targetId: "repo-one",
					surface: "app",
					commitSha: f.live,
				},
				fetchFn as typeof fetch,
			),
		).rejects.toThrow("workflow identity");
		expect(f.paths.some((path) => path.includes("/actions/runs/"))).toBe(false);
	});
});

it("redacts a signed URL from a downstream streamed-body error", async () => {
	const f = ancestryFetch();
	const signed =
		"https://downloads.example.com/log?signature=must-stay-private";
	const fetchFn = vi.fn(async (...args: Parameters<typeof fetch>) => {
		if (String(args[0]).endsWith("/logs"))
			return new Response(null, { status: 302, headers: { Location: signed } });
		if (String(args[0]) === signed)
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error(`Transport failed at ${signed}`));
					},
				}),
			);
		return f.fetchFn(...args);
	});
	await expect(
		readConfiguredRepositoryDelivery(
			context,
			source.organizationId,
			policy,
			{
				kind: "repository_delivery",
				targetId: "repo-one",
				surface: "app",
				commitSha: f.live,
			},
			fetchFn as typeof fetch,
		),
	).rejects.toThrow("Managed Ship log download unavailable");
});
