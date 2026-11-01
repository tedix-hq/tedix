import { describe, expect, it, vi } from "vite-plus/test";
import {
	getSiteBuilderSandbox,
	siteBuilderSandboxTenantLabel,
} from "./sandbox";

describe("CMS Site Builder Sandbox lookup", () => {
	it("keeps long server-generated job names out of provider labels", () => {
		const getByName = vi.fn((name: string) => ({ name }));
		getSiteBuilderSandbox(
			{ SITE_BUILDER_SANDBOX: { getByName } as never },
			"acme",
			{ kind: "deploy", jobId: "cms-" + "a".repeat(140) },
		);
		const name = getByName.mock.calls[0]![0];
		expect(name.length).toBeGreaterThan(64);
		expect(siteBuilderSandboxTenantLabel(name)).toBe("acme");
		expect(siteBuilderSandboxTenantLabel("acme")).toBe("acme");
		expect(() => siteBuilderSandboxTenantLabel("a".repeat(65))).toThrow(
			"Invalid CMS tenant label",
		);
	});
	it("keeps jobs separate from authoring, other jobs, and other tenants", () => {
		const getByName = vi.fn((name: string) => ({ name }));
		const env = { SITE_BUILDER_SANDBOX: { getByName } as never };
		const first = getSiteBuilderSandbox(env, "acme", {
			kind: "deploy",
			jobId: "job-one",
		});
		expect(
			getSiteBuilderSandbox(env, "acme", { kind: "deploy", jobId: "job-one" }),
		).toEqual(first);
		const names = [
			first,
			getSiteBuilderSandbox(env, "acme", { kind: "deploy", jobId: "job-two" }),
			getSiteBuilderSandbox(env, "other", { kind: "deploy", jobId: "job-one" }),
			getSiteBuilderSandbox(env, "acme", {
				kind: "artifact-commit",
				jobId: "job-one",
			}),
			getSiteBuilderSandbox(env, "acme"),
		].map((value) => (value as unknown as { name: string }).name);
		expect(new Set(names).size).toBe(5);
	});

	it("rejects an invalid job before resolving a container", () => {
		const getByName = vi.fn();
		expect(() =>
			getSiteBuilderSandbox(
				{ SITE_BUILDER_SANDBOX: { getByName } as never },
				"acme",
				{ kind: "deploy", jobId: "../authoring" },
			),
		).toThrow("Invalid CMS execution job identity");
		expect(getByName).not.toHaveBeenCalled();
	});

	it("addresses the app-owned Durable Object by organization slug", () => {
		const resolved = { id: "sandbox" };
		const getByName = vi.fn(() => resolved);
		expect(
			getSiteBuilderSandbox(
				{ SITE_BUILDER_SANDBOX: { getByName } as never },
				"acme",
			),
		).toBe(resolved);
		expect(getByName).toHaveBeenCalledWith("acme");
	});
});
