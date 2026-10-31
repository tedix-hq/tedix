import { describe, expect, it } from "vite-plus/test";
import { filterAggregateAppsForCodeNamespaces } from "../codemode-targeting";
import {
	extractCodeModeExecutionNamespacesFromCode,
	extractCodeModeProviderNamespacesFromCode,
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
