import { describe, expect, it } from "vite-plus/test";

import type { BaseContext } from "./orpc";
import appsSource from "./routers/apps.ts?raw";
import organizationsSource from "./routers/organizations.ts?raw";
import tedisCrudSource from "./routers/tedis/crud.ts?raw";
import { requireStepUp } from "./step-up";

function userContext(options: { su?: boolean } = {}): BaseContext {
	return {
		authType: "user",
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			sub: "user-1",
			...(options.su === undefined ? {} : { su: options.su }),
		},
	} as BaseContext;
}

describe("requireStepUp", () => {
	it("rejects an interactive caller without the claim", () => {
		expect(() => requireStepUp(userContext(), "Deleting an app")).toThrowError(
			/Deleting an app requires re-authentication/,
		);
	});

	it("admits an interactive caller carrying su: true", () => {
		expect(() =>
			requireStepUp(userContext({ su: true }), "Deleting an app"),
		).not.toThrow();
	});

	it("does not accept a truthy non-boolean claim", () => {
		const ctx = userContext();
		(ctx.user as { su?: unknown }).su = "true";
		expect(() => requireStepUp(ctx, "Deleting a tedi")).toThrow();
	});

	it("exempts principals that cannot run a step-up flow", () => {
		// API keys, M2M tokens, service bindings and tedi access keys have no
		// interactive session to step up. Demanding the claim would break
		// automation without proving anything about human intent.
		for (const authType of [
			"apikey",
			"m2m",
			"service-binding",
			"tedi",
		] as const) {
			expect(() =>
				requireStepUp({ authType } as BaseContext, "Deleting an app"),
			).not.toThrow();
		}
	});

	it("names the action so the operator knows what to retry", () => {
		expect(() =>
			requireStepUp(userContext(), "Deleting an organization"),
		).toThrowError(/Deleting an organization/);
	});
});

/**
 * Slice one exported procedure's source out of a router module.
 *
 * The guard below used to assert that the whole FILE contained
 * `requireStepUp(context,`, which proved nothing once a file held more than one
 * gated procedure: `organizations.rotateApiKey` would have passed on
 * `organizations.delete`'s call while carrying no gate of its own. Scoping the
 * assertion to the individual export is what makes it a real check.
 */
function procedureSource(source: string, exportName: string): string {
	const start = source.indexOf(`export const ${exportName}`);
	if (start === -1) {
		throw new Error(`export ${exportName} not found — the guard is stale`);
	}
	const next = source.indexOf("\nexport ", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

/**
 * Wiring guard. The suite above proves the helper behaves; this proves the
 * gated procedures still call it. Without it, deleting the call from a handler
 * passes everything — the helper's own tests stay green while the gate silently
 * disappears from the mutation it exists to protect.
 */
describe("step-up wiring on gated procedures", () => {
	const guarded: ReadonlyArray<readonly [string, string, string]> = [
		["organizations.delete", organizationsSource, "deleteOrganizationContract"],
		["organizations.rotateApiKey", organizationsSource, "rotateApiKeyContract"],
		["tedis.rotateAccessKey", tedisCrudSource, "rotateAccessKeyProcedure"],
	];

	for (const [procedure, source, exportName] of guarded) {
		it(`${procedure} still calls requireStepUp`, () => {
			expect(procedureSource(source, exportName)).toContain(
				"requireStepUp(context,",
			);
		});
	}

	it("does not require a fresh challenge to create a scoped organization key", () => {
		expect(
			procedureSource(organizationsSource, "createApiKeyContract"),
		).not.toContain("requireStepUp(context,");
	});

	it.each([
		["apps.delete", appsSource, "deleteAppProcedure"],
		["tedis.delete", tedisCrudSource, "deleteTediProcedure"],
	] as const)(
		"uses ordinary authorization for %s",
		(_name, source, exportName) => {
			const procedure = procedureSource(source, exportName);
			expect(procedure).toContain("withAuthorization(");
			expect(procedure).not.toContain("requireStepUp(context,");
		},
	);
});
