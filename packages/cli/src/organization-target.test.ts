import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	organizationScopedAttemptStore,
	resolveOrganizationTarget,
} from "./organization-target";
import { createFileWorkAttemptStore } from "./work-attempt-store";
import { parseOptions } from "./options";

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
