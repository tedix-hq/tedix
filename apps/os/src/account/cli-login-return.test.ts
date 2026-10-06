import { describe, expect, it } from "vite-plus/test";
import {
	buildCliLoginBrokerTarget,
	buildCliLoginReturnTarget,
} from "./cli-login-return";

describe("buildCliLoginReturnTarget", () => {
	it("builds the loopback callback URL the CLI waits on", () => {
		expect(
			buildCliLoginReturnTarget({
				port: "8976",
				state: "abc-123_XYZ.def",
				organization: "acme",
				tenant: "org_123",
			}),
		).toBe(
			"http://127.0.0.1:8976/workspace?state=abc-123_XYZ.def&organization=acme&tenant=org_123",
		);
	});

	it("lowercases the organization slug", () => {
		expect(
			buildCliLoginReturnTarget({
				port: "8976",
				state: "s",
				organization: "AcMe",
				tenant: "org_123",
			}),
		).toContain("organization=acme");
	});

	it("rejects a non-loopback redirect attempt via port injection", () => {
		// A crafted port must not become a host or path — Number() rejects it, so
		// no redirect target is produced.
		for (const port of [
			"8976@evil.com",
			"8976/../..",
			"0",
			"65536",
			"-1",
			"abc",
			"",
			null,
		]) {
			expect(
				buildCliLoginReturnTarget({
					port,
					state: "s",
					organization: "acme",
					tenant: "org_123",
				}),
			).toBeNull();
		}
	});

	it("rejects a malformed or missing state nonce", () => {
		for (const state of ["", "   ", null, "a b", "a/b", "x".repeat(201)]) {
			expect(
				buildCliLoginReturnTarget({
					port: "8976",
					state,
					organization: "acme",
					tenant: "org_123",
				}),
			).toBeNull();
		}
	});

	it("rejects an invalid organization slug", () => {
		for (const organization of [
			"",
			"-bad",
			"bad-",
			"has space",
			"UPPER_ONLY!",
			"a/b",
			"..",
		]) {
			expect(
				buildCliLoginReturnTarget({
					port: "8976",
					state: "s",
					organization,
					tenant: "org_123",
				}),
			).toBeNull();
		}
	});

	it("rejects a missing or malformed Descope tenant binding", () => {
		for (const tenant of [
			"",
			"has space",
			"https://evil.example",
			"x".repeat(201),
		]) {
			expect(
				buildCliLoginReturnTarget({
					port: "8976",
					state: "s",
					organization: "acme",
					tenant,
				}),
			).toBeNull();
		}
	});
});

describe("buildCliLoginBrokerTarget", () => {
	it("carries only validated organizations and exact permission choices through the broker", () => {
		const target = buildCliLoginBrokerTarget({
			port: "8976",
			state: "abc-123",
			organization: "acme",
			tenant: "org_acme",
			selections: [
				{ organization: "acme", tenant: "org_acme" },
				{ organization: "sample", tenant: "org_sample" },
			],
			scopes: ["mcp:apps.read", "connections.execute"],
		});
		expect(target).not.toBeNull();
		const resume = new URL(
			new URL(target!, "https://os.tedix.dev").searchParams.get("redirect_to")!,
			"https://os.tedix.dev",
		);
		expect(resume.searchParams.getAll("batch_org")).toEqual(["acme", "sample"]);
		expect(resume.searchParams.getAll("scope")).toEqual([
			"mcp:apps.read",
			"connections.execute",
		]);
		expect(
			buildCliLoginReturnTarget({
				port: "8976",
				state: "abc-123",
				organization: "acme",
				tenant: "org_acme",
				selections: [
					{ organization: "acme", tenant: "org_acme" },
					{ organization: "sample", tenant: "org_sample" },
				],
				scopes: ["mcp:apps.read", "connections.execute"],
			}),
		).toContain("selected_org=sample");
	});

	it("rejects duplicate tenants and unrecognized permission names", () => {
		const input = {
			port: "8976",
			state: "abc-123",
			organization: "tedix",
			tenant: "org_tedix",
		};
		expect(
			buildCliLoginBrokerTarget({
				...input,
				selections: [
					{ organization: "tedix", tenant: "org_tedix" },
					{ organization: "other", tenant: "org_tedix" },
				],
			}),
		).toBeNull();
		expect(
			buildCliLoginBrokerTarget({ ...input, scopes: ["platform:root"] }),
		).toBeNull();
	});

	it("routes a validated selection through the central refresh owner", () => {
		expect(
			buildCliLoginBrokerTarget({
				port: "8976",
				state: "abc-123",
				organization: "AcMe",
				tenant: "org_acme",
			}),
		).toBe(
			"/cli/session-broker/start?tenant_id=org_acme&redirect_to=%2Fcli%2Flogin%3Fport%3D8976%26state%3Dabc-123%26organization%3Dacme%26selected_organization%3Dacme%26selected_tenant%3Dorg_acme",
		);
	});

	it("rejects invalid loopback state before starting the broker", () => {
		expect(
			buildCliLoginBrokerTarget({
				port: "8976@evil.example",
				state: "abc-123",
				organization: "acme",
				tenant: "org_acme",
			}),
		).toBeNull();
	});
});
