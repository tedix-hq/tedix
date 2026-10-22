import { describe, expect, it } from "vite-plus/test";
import {
	CONNECTION_STATUS_FILTERS,
	adminConnectionsSearchSchema,
	validateAdminConnectionsSearch,
} from "./admin-connections-search";

const validate = (search: Record<string, unknown>) =>
	validateAdminConnectionsSearch(
		search as Parameters<typeof validateAdminConnectionsSearch>[0],
	);

const defaults = { q: "", status: "all" };

describe("admin connections search", () => {
	it.each(["used", "all", "connected", "not_connected", "attention", "unused"])(
		"preserves the %s status and exact handoff strings",
		(status) => {
			const search = {
				status,
				q: " fictional connector ",
				connect: "sample-provider",
				capability: "files.read",
				connectionInstanceId: "sample-connection",
				scopes: "files.read,files.write",
			};
			expect(CONNECTION_STATUS_FILTERS).toContain(status);
			expect(validate(search)).toStrictEqual(search);
			expect(adminConnectionsSearchSchema.parse(search)).toStrictEqual(search);
		},
	);

	it("defaults missing fields and drops unknown and legacy keys", () => {
		expect(validate({})).toStrictEqual(defaults);
		expect(
			validate({ tab: "connected", provider: "old-provider", extra: true }),
		).toStrictEqual(defaults);
	});

	it.each([
		undefined,
		null,
		"",
		"active",
		"disconnected",
		"CONNECTED",
		1,
		false,
		[],
		{},
	])(
		"falls back to all for invalid status %j without discarding valid fields",
		(status) => {
			expect(
				validate({ status, q: "connector", connect: "sample-provider" }),
			).toStrictEqual({
				q: "connector",
				status: "all",
				connect: "sample-provider",
			});
		},
	);

	it.each([null, 42, true, [], {}])(
		"defaults wrong-type string fields %j",
		(value) => {
			expect(
				validate({
					q: value,
					status: "used",
					connect: value,
					capability: value,
					connectionInstanceId: value,
					scopes: value,
				}),
			).toStrictEqual({
				q: "",
				status: "used",
				connect: undefined,
				capability: undefined,
				connectionInstanceId: undefined,
				scopes: undefined,
			});
		},
	);

	it("preserves empty optional strings and an empty search query", () => {
		const search = {
			q: "",
			status: "all",
			connect: "",
			capability: "",
			connectionInstanceId: "",
			scopes: "",
		};
		expect(validate(search)).toStrictEqual(search);
	});
});
