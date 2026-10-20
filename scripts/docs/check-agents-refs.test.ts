import { describe, expect, test } from "bun:test";
import {
	findLineAnchors,
	findMissingReferences,
	isLineAnchor,
	isPathReference,
	referenceCandidates,
} from "./check-agents-refs.ts";

const nowhere = () => false;

describe("isPathReference", () => {
	test("accepts slash-separated source and doc paths", () => {
		for (const token of [
			"src/auth-helpers.ts",
			"apps/api/src/rpc/routers/apps.ts",
			"docs/public/agent-guide.md",
			"packages/design-tokens/src/kumo.css",
			"scripts/lint-loader-sandbox.ts",
		]) {
			expect(isPathReference(token)).toBe(true);
		}
	});

	test("accepts a trailing-slash directory reference", () => {
		expect(isPathReference("src/mcp/tools/")).toBe(true);
		expect(isPathReference("packages/api-contract/src/contracts/")).toBe(true);
	});

	test("rejects commands, placeholders, globs and package specifiers", () => {
		for (const token of [
			"bun run-local",
			"bun run docs:public:check",
			"@tedix/mcp-shared/transport",
			"@/components/kumo/*",
			"@cloudflare/kumo/ai/component-registry.json",
			"src/components/*-webmcp-tools.ts",
			"src/queries/<domain>.ts",
			"drizzle/*/migration.sql",
			'import("./worker-app")',
			'["os-outputs", workspaceId]',
		]) {
			expect(isPathReference(token)).toBe(false);
		}
	});

	test("rejects names that lack a verifiable file shape", () => {
		for (const token of [
			"do.ts",
			"worker.ts",
			"migration-integrity.json",
			"catalog/search",
			"tedix-hq/tedix-cloud-ops",
			"drizzle-orm/zod",
			"apps/api",
			"/openapi.json",
			"mcp.tedix.dev",
			"resolvedApp.tools",
		]) {
			expect(isPathReference(token)).toBe(false);
		}
	});
});

describe("isLineAnchor", () => {
	test("flags a file:line anchor", () => {
		expect(isLineAnchor("src/mcp/handler.ts:300")).toBe(true);
		expect(isLineAnchor("foo.ts:12")).toBe(true);
		expect(isLineAnchor("docs/public/index.md:40")).toBe(true);
	});

	test("ignores plain paths and annotated values", () => {
		expect(isLineAnchor("src/mcp/handler.ts")).toBe(false);
		expect(isLineAnchor("exact: true")).toBe(false);
		expect(isLineAnchor("readOnlyHint: true")).toBe(false);
		expect(isLineAnchor("plugin:tedix-homepage-policy:settings:policy")).toBe(
			false,
		);
	});
});

describe("findLineAnchors", () => {
	test("rejects every backticked path:line with the symbol-reference message", () => {
		const findings = findLineAnchors(
			"apps/mcp/AGENTS.md",
			"see `src/mcp/handler.ts:300` and `src/auth-helpers.ts:556`",
		);
		expect(findings).toHaveLength(2);
		expect(findings[0]?.message).toContain("use a symbol reference");
	});

	test("ignores anchors inside fenced code blocks", () => {
		const findings = findLineAnchors(
			"apps/mcp/AGENTS.md",
			'```\nconst ref = "src/handler.ts:300";\n```',
		);
		expect(findings).toEqual([]);
	});
});

describe("referenceCandidates", () => {
	test("tries the guide directory, its src/, then the repository root", () => {
		expect(referenceCandidates("apps/api/AGENTS.md", "rpc/orpc.ts")).toEqual([
			"apps/api/rpc/orpc.ts",
			"apps/api/src/rpc/orpc.ts",
			"rpc/orpc.ts",
		]);
	});
});

describe("findMissingReferences", () => {
	test("flags a backticked path that resolves nowhere", () => {
		const findings = findMissingReferences(
			"apps/mcp/AGENTS.md",
			"gate lives in `src/mcp/handler.ts`",
			nowhere,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.token).toBe("src/mcp/handler.ts");
	});

	test("passes when any candidate exists", () => {
		const findings = findMissingReferences(
			"apps/api/AGENTS.md",
			"see `rpc/orpc.ts`",
			(candidate) => candidate === "apps/api/src/rpc/orpc.ts",
		);
		expect(findings).toEqual([]);
	});

	test("exempts the documented allowed-missing reference", () => {
		const findings = findMissingReferences(
			"packages/db/AGENTS.md",
			"do not create `queries/index.ts`",
			nowhere,
		);
		expect(findings).toEqual([]);
	});

	test("skips the root guide and its public copy", () => {
		for (const file of ["AGENTS.md", "docs/public/AGENTS.md"]) {
			expect(findMissingReferences(file, "`src/do.ts`", nowhere)).toEqual([]);
		}
	});
});
