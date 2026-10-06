import { describe, expect, it } from "vite-plus/test";
import {
	ensurePlatformOperatorAggregateApps,
	PLATFORM_OPERATOR_ADMIN_APP_SLUG,
} from "./platform-operator-aggregation";
import { PLATFORM_OPERATOR_APP_SLUG } from "./platform-operator-tools";

describe("platform operator aggregation", () => {
	it("prepends the Tedix admin app for tedix-unified when missing", () => {
		const entries = ensurePlatformOperatorAggregateApps(
			PLATFORM_OPERATOR_APP_SLUG,
			[{ slug: "github-tedix" }],
		);

		expect(entries).toEqual([
			{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG },
			{ slug: "github-tedix" },
		]);
	});

	it("does not duplicate the Tedix admin app when configured explicitly", () => {
		const entries = ensurePlatformOperatorAggregateApps(
			PLATFORM_OPERATOR_APP_SLUG,
			[{ slug: "github-tedix" }, { slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG }],
		);

		expect(entries).toEqual([
			{ slug: "github-tedix" },
			{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG },
		]);
	});

	it("preserves explicit Tedix tool and endpoint filters", () => {
		const entries = ensurePlatformOperatorAggregateApps("acme-unified", [
			{ slug: "github-tedix" },
			{
				slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG,
				prefix: "tedix",
				toolIds: ["list_tedis"],
				endpointPrefixes: ["work"],
			},
		]);

		expect(entries).toEqual([
			{ slug: "github-tedix" },
			{
				slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG,
				prefix: "tedix",
				toolIds: ["list_tedis"],
				endpointPrefixes: ["work"],
			},
		]);
	});

	it("preserves explicit platform operator allowlists", () => {
		const entries = ensurePlatformOperatorAggregateApps(
			PLATFORM_OPERATOR_APP_SLUG,
			[
				{
					slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG,
					toolIds: ["rotate_access_key", "list_workflow_definitions"],
				},
			],
		);

		expect(entries).toEqual([
			{
				slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG,
				toolIds: ["rotate_access_key", "list_workflow_definitions"],
			},
		]);
	});

	it("keeps the complete Tedix admin surface when no allowlist is set", () => {
		const entries = ensurePlatformOperatorAggregateApps(
			PLATFORM_OPERATOR_APP_SLUG,
			[{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG, prefix: "tedix" }],
		);

		expect(entries).toEqual([
			{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG, prefix: "tedix" },
		]);
	});

	it("adds the complete admin app to tenant unified hosts", () => {
		const entries = ensurePlatformOperatorAggregateApps("acme-unified", [
			{ slug: "github-tedix" },
		]);

		expect(entries).toEqual([
			{ slug: PLATFORM_OPERATOR_ADMIN_APP_SLUG },
			{ slug: "github-tedix" },
		]);
	});

	it("leaves non-unified apps unchanged", () => {
		const entries = ensurePlatformOperatorAggregateApps("github", [
			{ slug: "github-tedix" },
		]);

		expect(entries).toEqual([{ slug: "github-tedix" }]);
	});
});
