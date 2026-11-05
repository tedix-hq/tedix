import { describe, expect, it } from "vite-plus/test";
import { filterAggregateAppsForCodeNamespaces } from "../codemode-targeting";
import {
	extractCodeModeExecutionNamespacesFromCode,
	extractCodeModeProviderNamespacesFromCode,
	extractCodeModeShardDiscoveryNamespaces,
} from "./code-mode-namespaces";

describe("Code Mode execution bindings", () => {
	it.each([
		"sample_one",
		"sample_two",
		"sample_three",
		"sample_four",
		"sample_five",
		"sample_six",
		"sample_seven",
		"sample_eight",
		"sample_nine",
	])(
		"hydrates one organization for the production JavaScript discovery syntax: %s",
		(organization) => {
			const namespace = `${organization}_unified_tedix`;
			const code = `async () => { const r = await discover.search({query:'list_work_items',namespace:${JSON.stringify(namespace)},includeParameters:true}); const a = Array.isArray(r) ? r : r.results ?? []; return a.filter(x => x.callable === '${namespace}.list_work_items').map(x => ({callable:x.callable,authorized:x.authorized,requiredScopes:x.requiredScopes,missingScopes:x.missingScopes,parameterType:x.parameters?.type,additionalProperties:x.parameters?.additionalProperties,required:x.parameters?.required ?? [],limit:x.parameters?.properties?.limit,offset:x.parameters?.properties?.offset})); }`;
			const selected = extractCodeModeProviderNamespacesFromCode(code);
			// The existing conservative scanner also keeps the local array receiver.
			// It matches no aggregate app; only the named organization is hydrated.
			expect(selected).toEqual(new Set(["a", namespace]));
			expect(extractCodeModeExecutionNamespacesFromCode(code)).toEqual(
				new Set(["a"]),
			);
			expect(
				filterAggregateAppsForCodeNamespaces(
					[
						{
							slug: `${organization}-unified`,
							prefix: `${organization}_unified`,
							organizationMount: true,
						},
						{
							slug: "other-unified",
							prefix: "other_unified",
							organizationMount: true,
						},
					],
					selected,
				).map((entry) => entry.slug),
			).toEqual([`${organization}-unified`]);
		},
	);
	it.each([
		"discover.describe('acme.read_item')",
		"discover.describe({callable: 'acme.read_item',})",
		"discover.search({namespace: 'acme', query: 'work', limit: 1, includeParameters: true,})",
		"discover.search({'namespace': 'acme', query: 'work', filter: {values: [1, -2, true, null]}})",
	])("accepts constant JavaScript literal syntax: %s", (call) => {
		expect(
			extractCodeModeProviderNamespacesFromCode(`async () => ${call}`),
		).toEqual(new Set(["acme"]));
	});
	it.each([
		"{namespace: selected}",
		"{namespace: 'acme', ...other}",
		"{...other, namespace: 'acme'}",
		"{['namespace']: 'acme'}",
		"{get namespace() { throw new Error('must not run'); }}",
		"{namespace() { return 'acme'; }}",
		"{namespace: 'acme', namespace: 'other'}",
		"{namespace: 'acme', query: other.call()}",
		"{namespace: 'acme', __proto__: {namespace: 'other'}}",
		"{namespace: 'acme', query: /work/}",
		"{namespace: 'acme', query: `work`}",
		"{namespace: 'acme'}, {namespace: 'other'}",
	])(
		"retains complete hydration for ambiguous or executable arguments: %s",
		(argument) => {
			expect(
				extractCodeModeProviderNamespacesFromCode(
					`async () => discover.search(${argument})`,
				),
			).toBeNull();
		},
	);
	it("keeps unfiltered discovery's full catalog without binding its executable tools", () => {
		const code =
			'async () => { const result = await discover.search({ query: "work", includeParameters: true }); return result; }';
		expect(extractCodeModeProviderNamespacesFromCode(code)).toBeNull();
		expect(extractCodeModeExecutionNamespacesFromCode(code)).toEqual(new Set());
	});
	it("keeps direct calls beside discovery", () => {
		expect(
			extractCodeModeExecutionNamespacesFromCode(
				"async () => { await discover.list_namespaces(); return acme.list_items({limit: 1}); }",
			),
		).toEqual(new Set(["acme"]));
	});
	it.each([
		'async () => globalThis["acme"].list_items({})',
		'async () => { const result = await discover.search({query:"work"}); return globalThis[result.namespace].list_items({}); }',
		"async () => { const api = acme; return api.list_items({}); }",
		"async () => acme[method]({})",
		'async () => flow.status({runId:"run"})',
		"async () => `result ${acme[method]({})}`",
	])("retains all bindings for indirect execution: %s", (code) => {
		expect(extractCodeModeExecutionNamespacesFromCode(code)).toBeNull();
	});
});

describe("Code Mode discovery shards", () => {
	it("serves namespace-free searches from shards and hydrates named calls", () => {
		const code = `async () => { const out = []; for (const q of ["send email", "notion page"]) out.push(await discover.search({ query: q, limit: 3 })); out.push(await discover.search("calendar")); await discover.describe("acme_unified_cms.get_page"); return [out, await acme_unified_crm.list_contacts({})]; }`;
		// The full-catalog scan cannot bound this program.
		expect(extractCodeModeProviderNamespacesFromCode(code)).toBeNull();
		const namespaces = extractCodeModeShardDiscoveryNamespaces(code);
		expect(namespaces).toContain("acme_unified_cms");
		expect(namespaces).toContain("acme_unified_crm");
		expect(namespaces).not.toContain("discover");
	});

	it("allows list_namespaces and read_result", () => {
		expect(
			extractCodeModeShardDiscoveryNamespaces(
				`async () => [await discover.list_namespaces(), await discover.read_result({ handle: "h" })]`,
			),
		).toEqual(new Set());
	});

	it.each([
		// Already bounded: the normal targeting handles it.
		`async () => discover.search({ query: "x", namespace: "work" })`,
		`async () => work.list_work_items({})`,
		// Shard rows carry no schemas.
		`async () => discover.search({ query: "x", includeParameters: true })`,
		`async () => discover.search({ query: "x", includeOutputSchema: true })`,
		// Opaque arguments, aliasing or dynamic calls cannot be bounded.
		`async () => { const q = { query: "x" }; return discover.search(q); }`,
		`async () => { const o = { query: "x" }; return discover.search({ ...o }); }`,
		`async () => discover.search({ query: "x", [key]: "work" })`,
		`async () => flow.status({ runId: "r" }).then(() => discover.search("x"))`,
		`async () => { const d = discover; return d.search("x"); }`,
		`async () => { const r = await discover.search("x"); return globalThis[r.results[0].namespace].run({}); }`,
	])("keeps the full catalog path for %s", (code) => {
		expect(extractCodeModeShardDiscoveryNamespaces(code)).toBeNull();
	});
});
