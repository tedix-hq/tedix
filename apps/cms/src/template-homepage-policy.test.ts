import type { ContentPolicyEvent, PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vite-plus/test";
import copyKeys from "../templates/tedix/src/lib/tedix-home-copy-keys.json";
import {
	DEFAULT_HOMEPAGE_POLICY,
	type HomepagePolicy,
} from "../templates/tedix/src/lib/tedix-home-validation";
import homepagePolicy from "../templates/tedix/src/plugins/tedix-homepage-policy/index";

const dashboard = () => ({
	_type: "tedix_dashboard_demo",
	_key: "dashboard",
	_version: 2,
	copy: copyKeys.map((key) => ({ key, value: "Example" })),
});
async function publishDecision(
	content: unknown,
	options: {
		slug?: string;
		collection?: string;
		policy?: HomepagePolicy | null;
	} = {},
) {
	return homepagePolicy.hooks["content:beforePublish"].handler(
		{
			collection: options.collection ?? "pages",
			content: {
				id: "any-native-id",
				slug: options.slug ?? "home",
				data: { content },
			},
			origin: { source: "api" },
		} as ContentPolicyEvent,
		{
			settings: { get: async () => options.policy ?? null },
		} as unknown as PluginContext,
	);
}
describe("Tedix landing renderer publication policy", () => {
	it("leaves independent section count, ordering and version validation to native schemas", async () => {
		expect(await publishDecision([])).toBeUndefined();
		expect(
			await publishDecision([
				dashboard(),
				{ _type: "marketing_prose", _key: "intro", _version: 3 },
			]),
		).toBeUndefined();
	});
	it("rejects malformed restored block containers before rendering", async () => {
		expect(await publishDecision([null])).toMatchObject({ cancel: true });
	});

	it("rejects sections whose renderer demo is absent", async () => {
		expect(await publishDecision([{ _type: "tedix_use_cases" }])).toMatchObject(
			{ cancel: true },
		);
		expect(
			await publishDecision([
				dashboard(),
				{ _type: "tedix_commerce_demo" },
				{ _type: "tedix_use_cases" },
			]),
		).toBeUndefined();
	});
	it("requires the dashboard only for the timeline and commerce only for use cases", async () => {
		expect(await publishDecision([{ _type: "tedix_timeline" }])).toMatchObject({
			cancel: true,
		});
		expect(
			await publishDecision([dashboard(), { _type: "tedix_timeline" }]),
		).toBeUndefined();
		expect(
			await publishDecision([
				{ _type: "tedix_commerce_demo" },
				{ _type: "tedix_use_cases" },
			]),
		).toBeUndefined();
	});

	it("protects actual dashboard interface lookup keys", async () => {
		const missingCopy = dashboard();
		missingCopy.copy.pop();
		expect(await publishDecision([missingCopy])).toMatchObject({
			cancel: true,
		});
		const duplicateCopy = dashboard();
		duplicateCopy.copy.push(duplicateCopy.copy[0]!);
		expect(await publishDecision([duplicateCopy])).toMatchObject({
			cancel: true,
		});
	});
	it("selects native slugs rather than imported IDs and supports configured targets", async () => {
		expect(await publishDecision(undefined, { slug: "about" })).toBeUndefined();
		expect(
			await publishDecision(undefined, { collection: "posts" }),
		).toBeUndefined();
		const policy = { ...DEFAULT_HOMEPAGE_POLICY, slugs: ["start", "inicio"] };
		expect(await publishDecision(undefined, { policy })).toBeUndefined();
		expect(
			await publishDecision(undefined, { policy, slug: "inicio" }),
		).toMatchObject({ cancel: true });
	});
	it("gives no legacy exception to configured dependencies", async () => {
		const policy = {
			collection: "pages",
			slugs: ["home"],
			dependencies: [
				{ when: "marketing_prose", requires: ["tedix_dashboard_demo"] },
			],
		};
		const legacy = Array.from({ length: 30 }, (_, index) => ({
			_type: "marketing_prose",
			_key: index === 0 ? "restored-hero" : `legacy-${index}`,
			_version: 1,
		}));
		expect(await publishDecision(legacy, { policy })).toMatchObject({
			cancel: true,
		});
	});
	it("fails closed on malformed policy settings", async () => {
		await expect(
			publishDecision([], {
				policy: { collection: "pages" } as HomepagePolicy,
			}),
		).rejects.toThrow("settings are invalid");
	});
});
