import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	assertTenantAiSearchLogicalName,
	tenantAiSearchCreateConfig,
	tenantAiSearchInstanceId,
	tenantAiSearchUpdateConfig,
	TENANT_AI_SEARCH_LOGICAL_NAME,
} from "../src/tenant-ai-search-policy";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const facadeSource = readFileSync(
	join(repoRoot, "apps/cms-runtime/src/tenant-ai-search.ts"),
	"utf8",
);

const tedix = await tenantAiSearchInstanceId("tedix");
assert.match(tedix, /^cms-[0-9a-f]{24}$/);
assert.notEqual(tedix, await tenantAiSearchInstanceId("acme"));
assert.equal(
	tenantAiSearchCreateConfig({ id: TENANT_AI_SEARCH_LOGICAL_NAME }, tedix).id,
	tedix,
);
assert.throws(
	() => tenantAiSearchCreateConfig({ id: "other" }, tedix),
	/pinned AI Search instance/,
);
assert.throws(
	() =>
		tenantAiSearchCreateConfig(
			{ id: TENANT_AI_SEARCH_LOGICAL_NAME, chat: true },
			tedix,
		),
	/arbitrary AI Search options/,
);
assert.throws(
	() => assertTenantAiSearchLogicalName("other"),
	/pinned AI Search instance/,
);
assert.throws(
	() => tenantAiSearchUpdateConfig({ chat: true }),
	/metadata fields/,
);
assert.match(
	facadeSource,
	/class TenantAiSearchInstance extends RpcTarget[\s\S]*get items\(\)[\s\S]*return this\.itemOperations/,
	"AI Search item operations must be exposed by a prototype getter because RpcTarget hides instance properties",
);
assert.doesNotMatch(
	facadeSource,
	/class TenantAiSearchInstance extends RpcTarget[\s\S]*readonly items:/,
	"AI Search item operations must not regress to an RPC-invisible instance property",
);
