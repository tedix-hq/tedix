import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	organizationScopedAttemptStore,
	resolveOrganizationTarget as resolveTarget,
} from "./organization-target";
import { createFileWorkAttemptStore } from "./work-attempt-store";
import { parseOptions } from "./options";

const configDir = mkdtempSync(join(tmpdir(), "tedix-org-target-"));
afterAll(() => rmSync(configDir, { recursive: true, force: true }));
const resolveOrganizationTarget: typeof resolveTarget = (
	input,
	options = { configDir },
) => resolveTarget(input, options);

const url = "https://connect.mcp.tedix.dev/mcp";
const token = (selected: unknown) =>
	`x.${Buffer.from(JSON.stringify({ tedixSelectedOrganizations: selected })).toString("base64url")}.x`;
const base = {
	url,
	command: "work",
	environmentOrganization: "",
	workspace: "connect",
	accessToken: token(["org_tedix"]),
};

describe("CLI organization target", () => {
	test("routes explicit organizations without token selection claims", () => {
		for (const accessToken of [undefined, "opaque-bearer", token(undefined)]) {
			for (const target of [
				{ organization: "org_example" },
				{ environmentOrganization: " org_example " },
			]) {
				expect(
					resolveOrganizationTarget({ ...base, accessToken, ...target }),
				).toEqual({
					headers: { "X-Tedix-Organization": "org_example" },
					workspace: JSON.stringify(["connect", "org_example"]),
					organization: "org_example",
				});
			}
		}
	});
	test("missing token selection explains how to supply a routing target", () => {
		expect(() =>
			resolveOrganizationTarget({ ...base, accessToken: "opaque-bearer" }),
		).toThrow("--organization <id-or-slug> or set TEDIX_ORGANIZATION");
	});
	test("ambiguity lists every selected ID and the exact flag to add", () => {
		expect(() =>
			resolveOrganizationTarget({
				...base,
				accessToken: token(["org_example", "org_customer"]),
			}),
		).toThrow(
			"Selectable organizations:\n  --organization org_example\n  --organization org_customer",
		);
	});
	test("uses the saved default only for its workspace and current selection", () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-org-default-"));
		try {
			writeFileSync(
				join(configDir, "agent-contexts.json"),
				JSON.stringify({
					version: 1,
					repositories: [],
					defaultOrganization: {
						workspace: "connect",
						organization: "org_customer",
					},
				}),
			);
			const input = {
				...base,
				accessToken: token(["org_example", "org_customer"]),
			};
			expect(resolveOrganizationTarget(input, { configDir })).toMatchObject({
				organization: "org_customer",
				headers: { "X-Tedix-Organization": "org_customer" },
				workspace: JSON.stringify(["connect", "org_customer"]),
			});
			expect(
				resolveOrganizationTarget(
					{ ...input, organization: "example" },
					{ configDir },
				).organization,
			).toBe("example");
			expect(
				resolveOrganizationTarget(
					{ ...input, environmentOrganization: "example" },
					{ configDir },
				).organization,
			).toBe("example");
			for (const invalid of [
				{ ...input, workspace: "another" },
				{ ...input, accessToken: token(["org_example", "org_other"]) },
			])
				expect(() => resolveOrganizationTarget(invalid, { configDir })).toThrow(
					"Several organizations",
				);
			for (const command of ["code", "mcp"]) {
				expect(
					resolveOrganizationTarget({ ...input, command }, { configDir }),
				).toEqual({ headers: {}, workspace: "connect" });
			}
			expect(
				resolveOrganizationTarget(
					{ ...input, externalAgent: true },
					{ configDir },
				),
			).toEqual({ headers: {}, workspace: "connect" });
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});
	test("parses explicit target and auto-resolves a sole selected org", () => {
		expect(
			parseOptions(["work", "list", "--organization", "tedix"]).options
				.organization,
		).toBe("tedix");
		expect(resolveOrganizationTarget(base).headers).toEqual({
			"X-Tedix-Organization": "org_tedix",
		});
		expect(
			resolveOrganizationTarget({
				...base,
				organization: "sample",
				accessToken: token(["org_tedix", "org_sample"]),
			}).headers,
		).toEqual({ "X-Tedix-Organization": "sample" });
	});
	test("fails before ordinary operations with missing or ambiguous selection", () => {
		for (const selected of [
			undefined,
			[],
			["org_tedix", "org_sample"],
			["org_tedix", "org_tedix"],
			[42],
		]) {
			expect(() =>
				resolveOrganizationTarget({ ...base, accessToken: token(selected) }),
			).toThrow();
		}
	});
	test("preserves raw Code Mode and direct tenant profiles", () => {
		expect(
			resolveOrganizationTarget({
				...base,
				command: "code",
				accessToken: undefined,
			}),
		).toEqual({ headers: {}, workspace: "connect" });
		expect(
			resolveOrganizationTarget({
				...base,
				url: "https://tedix-unified.mcp.tedix.dev/mcp",
			}),
		).toEqual({ headers: {}, workspace: "connect" });
		expect(() =>
			resolveOrganizationTarget({
				...base,
				url: "https://tedix-unified.mcp.tedix.dev/mcp",
				organization: "tedix",
			}),
		).toThrow();
	});
	test("terminal organization targets Connect commands and code; explicit target wins", () => {
		const defaults = {
			...base,
			accessToken: token(["org_tedix", "org_sample"]),
			environmentOrganization: " sample ",
		};
		expect(resolveOrganizationTarget(defaults).organization).toBe("sample");
		expect(
			resolveOrganizationTarget({ ...defaults, command: "code" }).headers,
		).toEqual({ "X-Tedix-Organization": "sample" });
		expect(
			resolveOrganizationTarget({ ...defaults, organization: "tedix" })
				.organization,
		).toBe("tedix");
		expect(
			resolveOrganizationTarget({
				...defaults,
				url: "https://tedix-unified.mcp.tedix.dev/mcp",
			}),
		).toEqual({ headers: {}, workspace: "connect" });
	});
	test("a shared profile cannot load another organization's Work Attempt", () => {
		const store = createFileWorkAttemptStore({
			configDir: mkdtempSync(join(tmpdir(), "tedix-org-fence-")),
		});
		const key = {
			workspace: resolveOrganizationTarget(base).workspace,
			actor: "credential",
			agentSession: "session",
			workItemId: "work",
		};
		const scopedStore = organizationScopedAttemptStore(store, key.workspace);
		scopedStore.set({ ...key, workspace: "connect" }, "attempt");
		expect(
			store.get({
				...key,
				workspace: resolveOrganizationTarget({
					...base,
					accessToken: token(["org_sample"]),
				}).workspace,
			}),
		).toBeNull();
		expect(store.get(key)).toBe("attempt");
	});
});
