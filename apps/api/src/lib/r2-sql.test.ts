import { describe, expect, it } from "vite-plus/test";
import {
	buildToolCallPayloadsQuery,
	escapeSql,
	getToolCallPayloadsFromR2,
	hasR2SqlConfig,
} from "./r2-sql";

const TABLE = "default.mcp_tool_calls";

describe("hasR2SqlConfig", () => {
	it("is false when nothing is configured", () => {
		expect(hasR2SqlConfig({} as CloudflareEnv)).toBe(false);
	});

	it("is false when the warehouse is missing", () => {
		const env = {
			CF_ACCOUNT_ID: "acc",
			CF_R2_SQL_TOKEN: "tok",
		} as unknown as CloudflareEnv;
		expect(hasR2SqlConfig(env)).toBe(false);
	});

	it("is false when no token (neither CF_R2_SQL_TOKEN nor CF_ANALYTICS_TOKEN)", () => {
		const env = {
			CF_ACCOUNT_ID: "acc",
			R2_SQL_WAREHOUSE: "wh",
		} as unknown as CloudflareEnv;
		expect(hasR2SqlConfig(env)).toBe(false);
	});

	it("is true with warehouse + CF_R2_SQL_TOKEN + account id", () => {
		const env = {
			CF_ACCOUNT_ID: "acc",
			R2_SQL_WAREHOUSE: "wh",
			CF_R2_SQL_TOKEN: "tok",
		} as unknown as CloudflareEnv;
		expect(hasR2SqlConfig(env)).toBe(true);
	});

	it("falls back to CF_ANALYTICS_TOKEN for auth", () => {
		const env = {
			CF_ACCOUNT_ID: "acc",
			R2_SQL_WAREHOUSE: "wh",
			CF_ANALYTICS_TOKEN: "acctok",
		} as unknown as CloudflareEnv;
		expect(hasR2SqlConfig(env)).toBe(true);
	});
});

describe("escapeSql", () => {
	it("doubles single quotes (standard SQL; backslash is a literal)", () => {
		expect(escapeSql("a'b")).toBe("a''b");
		expect(escapeSql("a\\b")).toBe("a\\b");
		expect(escapeSql("x'; DROP")).toBe("x''; DROP");
	});
});

const ORG = "0f0f0f0f-0000-4000-8000-000000000001";

describe("buildToolCallPayloadsQuery", () => {
	it("ALWAYS scopes by organizationId, then traceId; orders + limits", () => {
		const sql = buildToolCallPayloadsQuery(
			TABLE,
			{ organizationId: ORG, traceId: "trace-001" },
			20,
		);
		expect(sql).toContain(`FROM ${TABLE}`);
		expect(sql).toContain(
			`WHERE organizationId = '${ORG}' AND traceId = 'trace-001'`,
		);
		expect(sql).toContain("ORDER BY timestamp DESC");
		expect(sql).toContain("LIMIT 20");
		// every flat column is selected
		expect(sql).toContain("inputArgs");
		expect(sql).toContain("outputBody");
		expect(sql).toContain("truncated");
	});

	it("prefers traceId over executionId when both are given", () => {
		const sql = buildToolCallPayloadsQuery(
			TABLE,
			{ organizationId: ORG, traceId: "trace-001", executionId: "exec-0001" },
			10,
		);
		expect(sql).toContain("traceId = 'trace-001'");
		expect(sql).not.toContain("executionId = 'exec-0001'");
	});

	it("filters by executionId when traceId is absent (org still scoped)", () => {
		const sql = buildToolCallPayloadsQuery(
			TABLE,
			{ organizationId: ORG, executionId: "exec-0001" },
			10,
		);
		expect(sql).toContain(
			`WHERE organizationId = '${ORG}' AND executionId = 'exec-0001'`,
		);
		expect(sql).not.toContain("traceId =");
	});

	it("adds the optional toolName filter with AND", () => {
		const sql = buildToolCallPayloadsQuery(
			TABLE,
			{
				organizationId: ORG,
				traceId: "trace-001",
				toolName: "search_listings",
			},
			5,
		);
		expect(sql).toContain(
			`WHERE organizationId = '${ORG}' AND traceId = 'trace-001' AND toolName = 'search_listings'`,
		);
	});

	it("REJECTS injection-shaped identifiers outright (allowlist, not escaping)", () => {
		expect(() =>
			buildToolCallPayloadsQuery(
				TABLE,
				{ organizationId: ORG, traceId: "x' OR '1'='1" },
				5,
			),
		).toThrow(/Invalid traceId/);
		expect(() =>
			buildToolCallPayloadsQuery(
				TABLE,
				{ organizationId: "org' OR 1=1 --", traceId: "trace-001" },
				5,
			),
		).toThrow(/Invalid organizationId/);
		expect(() =>
			buildToolCallPayloadsQuery(
				TABLE,
				{ organizationId: ORG, traceId: "trace-001", toolName: "x'; DROP" },
				5,
			),
		).toThrow(/Invalid toolName/);
	});

	it("clamps the limit to the 1..50 bound", () => {
		expect(
			buildToolCallPayloadsQuery(
				TABLE,
				{ organizationId: ORG, traceId: "trace-001" },
				9999,
			),
		).toContain("LIMIT 50");
		expect(
			buildToolCallPayloadsQuery(
				TABLE,
				{ organizationId: ORG, traceId: "trace-001" },
				0,
			),
		).toContain("LIMIT 1");
	});
});

describe("getToolCallPayloadsFromR2 gating", () => {
	it("returns [] without hitting the network when unconfigured", async () => {
		const result = await getToolCallPayloadsFromR2({} as CloudflareEnv, {
			organizationId: ORG,
			traceId: "trace-001",
		});
		expect(result).toEqual([]);
	});
});
