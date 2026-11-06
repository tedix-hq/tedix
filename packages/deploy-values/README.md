# @tedix/deploy-values

Lets a Worker's `cloudflare.config.ts` use real deploy values (account,
database, bucket and host names) without writing them into this public
repository.

## How it works

Set `TEDIX_DEPLOY_VALUES` to either an absolute path to a JSON file or the
JSON itself (any value starting with `{`). The values are used only for a
production build (`mode === "production"`) with the variable set. Otherwise
every accessor returns the placeholder the config passes in, so local
development needs nothing.

When values are in use, a missing key stops the build with an error naming
the key. It never quietly falls back to a placeholder.

```typescript
import { deployValues } from "@tedix/deploy-values";

export default defineConfig(({ mode }) => {
	const live = deployValues({ mode });
	const db = live.d1("core", { id: "local-core", name: "tedix-core" });
	const apiHost = live.host("api", "api.example.test");
	// ...
});
```

Accessors: `account`, `worker`, `d1`, `kv`, `r2`, `aiSearch`, `host`,
`routes`, `domains` and `vars`. Each takes the placeholder as its last argument.
`vars(surface, name, fallback)` looks in the surface's own section first,
then in `vars.shared`.

## Values file

`schemaVersion` must be `1`. Unknown keys are ignored.

```json
{
	"schemaVersion": 1,
	"account": { "id": "", "hash": "", "workersDevSubdomain": "" },
	"zone": { "name": "", "id": "", "cmsSaasZoneId": "" },
	"workers": { "<surface>": "<worker name>" },
	"d1": { "<key>": { "id": "", "name": "" } },
	"kv": { "<key>": { "id": "" } },
	"r2": { "jurisdiction": "eu", "buckets": { "<key>": "<bucket name>" } },
	"aiSearch": { "<key>": "<AI Search namespace>" },
	"queues": {},
	"aiGateway": {
		"accountId": "",
		"llmId": "",
		"autoAllowedProviders": [],
		"autoAllowedModels": [],
		"autoAllowedImageModels": []
	},
	"hostnames": { "<key>": "<host>" },
	"routes": { "<surface>": [{ "pattern": "", "zone": "" }] },
	"domains": { "<surface>": ["<host>"] },
	"vars": { "shared": {}, "<surface>": {} }
}
```

The real file lives with the private deploy configuration, never in this
repository.
