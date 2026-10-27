import { describe, expect, it } from "vite-plus/test";
import { resolveConnectionResourceAccess } from "./connection-resource-policy";

const policy = [
	{ resourceType: "github_repository", resourceId: "example/repo-x" },
];
const config = {
	transport: "mcp",
	mcpToolName: "issue_write",
	mcpServerUrl: "https://api.githubcopilot.com/mcp/",
	auth: { type: "connection", connectionId: "github" },
};
const args = {
	owner: "example",
	repo: "repo-x",
	method: "update",
	issue_number: 1,
	title: "Updated",
};
const resolve = (
	arguments_?: unknown,
	overrides: Partial<
		Parameters<typeof resolveConnectionResourceAccess>[0]
	> = {},
) =>
	resolveConnectionResourceAccess({
		allowedResources: policy,
		providerId: "github",
		config,
		...(arguments_ === undefined ? {} : { arguments: arguments_ }),
		...overrides,
	});

describe("shared connection resource decision", () => {
	it("offers the same reviewed operation for binding and discovery that dispatch can execute", () => {
		expect(resolve().allowed).toBe(true);
		expect(resolve(args)).toEqual({
			allowed: true,
			resourceId: "example/repo-x",
		});
		expect(resolve({ ...args, owner: "EXAMPLE", repo: "REPO-X" }).allowed).toBe(
			true,
		);
		expect(resolve({ ...args, repo: "repo-y" }).allowed).toBe(false);
	});
	it.each([
		{ ...args, parent_owner: "other", parent_repo: "repo-y" },
		{ ...args, method: "create" },
		{ ...args, duplicate_of: 2 },
		{ ...args, owner: "example/../other" },
		{ ...args, repo: "repo-x%2f..%2frepo-y" },
		{ ...args, repository: "example/repo-y" },
		{ ...args, repo: ["repo-x", "repo-y"] },
	])("refuses malformed or additional targets %j", (input) => {
		expect(resolve(input).allowed).toBe(false);
	});
	it.each(["rpc", "rest", "external", "code", "catalog"])(
		"fails closed for unsupported %s transport",
		(transport) => {
			expect(resolve(args, { config: { ...config, transport } }).allowed).toBe(
				false,
			);
			expect(
				resolve(undefined, { config: { ...config, transport } }).allowed,
			).toBe(false);
		},
	);
	it.each([
		"search_repositories",
		"fork_repository",
		"transfer_issue",
		"toString",
		"constructor",
		"future_tool",
	])("refuses unreviewed %s at discovery and dispatch", (mcpToolName) => {
		expect(
			resolve(undefined, { config: { ...config, mcpToolName } }).allowed,
		).toBe(false);
		expect(resolve(args, { config: { ...config, mcpToolName } }).allowed).toBe(
			false,
		);
	});
	it.each([
		[],
		{},
		undefined,
		[{ resourceType: "unknown", resourceId: "example/repo-x" }],
		[
			{
				resourceType: "notion_page",
				resourceId: "10000000-0000-4000-8000-000000000001",
			},
		],
	])(
		"refuses empty, unsupported or malformed limits %j",
		(allowedResources) => {
			expect(resolve(args, { allowedResources }).allowed).toBe(false);
		},
	);
	it("leaves whole-account slots unrestricted and rechecks revocation on replay", () => {
		expect(resolve(args, { allowedResources: null }).allowed).toBe(true);
		expect(resolve(args).allowed).toBe(true);
		expect(resolve(args, { allowedResources: [] }).allowed).toBe(false);
	});
	it.each([
		"https://evil.example/mcp/",
		"https://api.githubcopilot.com.evil.example/mcp/",
		"https://api.githubcopilot.com/mcp/?target=repo-y",
	])("refuses an unverified upstream %s", (mcpServerUrl) => {
		expect(resolve(args, { config: { ...config, mcpServerUrl } }).allowed).toBe(
			false,
		);
	});
});

it("intersects provider and account limits for binding and execution", () => {
	const additionalLimits = [
		[{ resourceType: "github_repository", resourceId: "example/repo-y" }],
	];
	expect(resolve(undefined, { additionalLimits }).allowed).toBe(false);
	expect(resolve(args, { additionalLimits }).allowed).toBe(false);
	expect(resolve(args, { additionalLimits: [null, policy] }).allowed).toBe(
		true,
	);
	expect(
		resolve(args, {
			allowedResources: [
				...policy,
				{
					resourceType: "notion_page",
					resourceId: "10000000-0000-4000-8000-000000000001",
				},
			],
		}).allowed,
	).toBe(false);
});

it.each([
	{
		mcpToolName: "create_or_update_file",
		arguments: {
			owner: "example",
			repo: "repo-x",
			branch: "proof",
			content: "proof",
			message: "Update",
			path: "proof.txt",
		},
	},
	{
		mcpToolName: "get_file_contents",
		arguments: { owner: "example", repo: "repo-x", path: "proof.txt" },
	},
])("limits reviewed $mcpToolName calls to X", (tool) => {
	const overrides = { config: { ...config, mcpToolName: tool.mcpToolName } };
	expect(resolve(tool.arguments, overrides).allowed).toBe(true);
	expect(
		resolve({ ...tool.arguments, repo: "repo-y" }, overrides).allowed,
	).toBe(false);
});

it("refuses credentials embedded in the official provider URL", () => {
	const url = new URL(config.mcpServerUrl);
	url.username = "fixture";
	url.password = "fixture";
	expect(
		resolve(args, { config: { ...config, mcpServerUrl: url.href } }).allowed,
	).toBe(false);
});
