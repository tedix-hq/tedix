import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAuthzFindings } from "./lint-authz.ts";

const fixtures: string[] = [];

afterEach(() => {
	for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true });
});

test.each([
	['withPermission("apps:read")', "rbac-only"],
	['createScopeMiddleware("apps:read")', "scope-only"],
	[null, "no-plane"],
	['withAuthorization("apps:read", "apps:read")', null],
] as const)(
	"keeps aliased authenticated builders visible with %s",
	(guard, kind) => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-authz-alias-"));
		fixtures.push(dir);
		writeFileSync(
			join(dir, "policy.ts"),
			"export const authenticated = os.use(withAuth);\n",
		);
		writeFileSync(
			join(dir, "shared.ts"),
			'import { authenticated as base } from "./policy";\nexport const scoped = base;\n',
		);
		for (const aliased of [false, true]) {
			const name = aliased ? "guarded" : "scoped";
			writeFileSync(
				join(dir, "route.ts"),
				[
					`import { scoped${aliased ? " as guarded" : ""} } from "./shared";`,
					`export const route = ${name}${guard ? `.use(${guard})` : ""}.handler(() => ({}));`,
				].join("\n"),
			);
			const result = collectAuthzFindings(dir, {});
			expect(result.totals).toEqual({
				procedures: 1,
				both: kind === null ? 1 : 0,
			});
			expect(result.findings.map(({ key, kind }) => ({ key, kind }))).toEqual(
				kind === null ? [] : [{ key: "route.ts::route", kind }],
			);
		}
	},
);
