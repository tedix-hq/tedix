import { describe, expect, test } from "bun:test";
import {
	preflightDescopeIdentity,
	renderIdentityReadinessReport,
} from "./identity-readiness";

interface RecordedRequest {
	method: string;
	url: string;
	authorization?: string;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fakeDescope(options?: {
	disabledFlow?: boolean;
	issuer?: string;
	status?: number;
	trustedDomains?: string;
	omitOwnerPermission?: boolean;
	exportPermissionShape?: boolean;
	requests?: RecordedRequest[];
}): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		options?.requests?.push({
			url,
			method,
			authorization: headers.get("authorization") ?? undefined,
		});
		if (url.endsWith("/.well-known/openid-configuration")) {
			return jsonResponse(options?.status ?? 200, {
				issuer: options?.issuer ?? "https://api.descope.com/P3example",
			});
		}
		return jsonResponse(options?.status ?? 200, {
			files: {
				"roles.json": {
					roles: ["owner", "admin", "member", "viewer"].map((name) => ({
						name,
						[options?.exportPermissionShape
							? "permissions"
							: "permissionNames"]:
							name === "owner" && options?.omitOwnerPermission
								? []
								: ["tedis:read"],
					})),
				},
				"project.json": {
					trustedDomains:
						options?.trustedDomains ?? "browser.example.com,os.example.com",
				},
				"flows/sign-up-or-in/metadata.json": {
					disabled: options?.disabledFlow ?? false,
					name: "Sign Up or In",
				},
			},
		});
	}) as typeof fetch;
}

const baseOptions = {
	projectId: "P3example",
	managementKey: "management-secret",
	osUrl: "https://os.example.com/chat",
};

describe("preflightDescopeIdentity", () => {
	test("passes with read-only discovery and project export requests", async () => {
		const requests: RecordedRequest[] = [];
		const report = await preflightDescopeIdentity({
			...baseOptions,
			fetchImplementation: fakeDescope({ requests }),
		});

		expect(report.ok).toBe(true);
		expect(report.mutationAllowed).toBe(true);
		expect(report.surfaces).toEqual([
			{
				kind: "os",
				origin: "https://os.example.com",
				approvedWebDomain: "os.example.com",
				redirectUrl: "https://os.example.com/login",
			},
		]);
		expect(requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
		expect(requests[1]?.authorization).toBe(
			"Bearer P3example:management-secret",
		);
		expect(JSON.stringify(report)).not.toContain("management-secret");
	});

	test("accepts Descope's exported permissions field", async () => {
		const report = await preflightDescopeIdentity({
			...baseOptions,
			fetchImplementation: fakeDescope({ exportPermissionShape: true }),
		});

		expect(report.ok).toBe(true);
		expect(
			report.checks.find((check) => check.id === "descope.role.owner"),
		).toEqual({
			id: "descope.role.owner",
			status: "passed",
			detail: "owner grants tedis:read",
		});
	});

	test("fails closed and names the exact missing Approved Web Domain", async () => {
		const report = await preflightDescopeIdentity({
			...baseOptions,
			fetchImplementation: fakeDescope({
				trustedDomains: "browser.example.com",
			}),
		});

		expect(report.ok).toBe(false);
		expect(report.mutationAllowed).toBe(false);
		expect(
			report.checks.find((check) => check.id === "descope.approved-domain.os"),
		).toEqual({
			id: "descope.approved-domain.os",
			status: "failed",
			detail: "add os.example.com to Project Settings > Approved Domains",
		});
	});

	test("fails on a disabled login flow or mismatched project issuer", async () => {
		const report = await preflightDescopeIdentity({
			...baseOptions,
			fetchImplementation: fakeDescope({
				disabledFlow: true,
				issuer: "https://api.descope.com/P3different",
			}),
		});

		expect(report.ok).toBe(false);
		expect(
			report.checks.find((check) => check.id === "descope.project-discovery")
				?.status,
		).toBe("failed");
		expect(
			report.checks.find((check) => check.id === "descope.login-flow")?.status,
		).toBe("failed");
	});

	test("does not leak the management key in HTTP failure output", async () => {
		const report = await preflightDescopeIdentity({
			...baseOptions,
			fetchImplementation: fakeDescope({ status: 403 }),
		});
		const rendered = renderIdentityReadinessReport(report);

		expect(report.ok).toBe(false);
		expect(rendered).toContain("project export returned HTTP 403");
		expect(rendered).not.toContain("management-secret");
	});

	test("fails when a human tenant role cannot read tedis", async () => {
		const report = await preflightDescopeIdentity({
			...baseOptions,
			fetchImplementation: fakeDescope({ omitOwnerPermission: true }),
		});

		expect(report.ok).toBe(false);
		expect(
			report.checks.find((check) => check.id === "descope.role.owner"),
		).toEqual({
			id: "descope.role.owner",
			status: "failed",
			detail: "create or update owner with tedis:read",
		});
	});

	for (const operation of ["discovery", "project-export"] as const) {
		for (const thrownKind of ["error", "string", "object"] as const) {
			test(`redacts ${operation} thrown ${thrownKind} without coercion`, async () => {
				const secret = "dummy-transport-secret";
				const transportDetail = "raw-sensitive-transport-detail";
				let coerced = false;
				const thrown =
					thrownKind === "error"
						? new Error(`${transportDetail}: ${secret}`, {
								cause: new Error(secret),
							})
						: thrownKind === "string"
							? `${transportDetail}: ${secret}`
							: {
									toString() {
										coerced = true;
										throw new Error(secret);
									},
								};
				const healthy = fakeDescope();
				const report = await preflightDescopeIdentity({
					...baseOptions,
					managementKey: secret,
					fetchImplementation: (async (input, init) => {
						const discovery = String(input).endsWith(
							"/.well-known/openid-configuration",
						);
						if (discovery === (operation === "discovery")) throw thrown;
						return healthy(input, init);
					}) as typeof fetch,
				});
				expect(coerced).toBe(false);
				expect(report.ok).toBe(false);
				expect(report.mutationAllowed).toBe(false);
				expect(
					report.checks.find(
						({ id }) =>
							id ===
							(operation === "discovery"
								? "descope.project-discovery"
								: "descope.management-access"),
					),
				).toEqual({
					id:
						operation === "discovery"
							? "descope.project-discovery"
							: "descope.management-access",
					status: "error",
					detail:
						operation === "discovery"
							? "OIDC discovery request failed"
							: "project export request failed",
				});
				expect(
					report.checks.find(
						({ id }) =>
							id ===
							(operation === "discovery"
								? "descope.management-access"
								: "descope.project-discovery"),
					)?.status,
				).toBe("passed");
				for (const output of [
					JSON.stringify(report),
					renderIdentityReadinessReport(report),
				]) {
					expect(output).not.toContain(secret);
					expect(output).not.toContain(transportDetail);
				}
			});
		}
	}
});
