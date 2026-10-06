# @tedix/api-client

Canonical oRPC v2 client construction for Tedix browsers, CLIs, Workers, and
trusted service-binding calls.

## Overview

This package owns Tedix's oRPC link configuration, v2 serialization, response
decoding, retry policy, and internal caller headers. Consumers pass procedure
input objects; they never construct `{ json, meta }` request envelopes or
decode `{ json }` responses themselves.

Use the highest-level surface that fits the caller:

| Surface                         | Use                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `getApiClient<ApiContract>()`   | Public URL calls with user JWTs, API keys, cookies, or no auth                |
| `getInternalApiClient(env)`     | Statically known Worker-to-Worker procedures over `API_SERVICE`               |
| `callRpc(path, input, options)` | Runtime-selected procedure paths in config-driven adapters, CLIs, and scripts |
| `createLink()`                  | Low-level integration work only                                               |

## Public client

```typescript
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import { withBearerToken } from "@tedix/api-client/adapters";
import { getApiClient } from "@tedix/api-client/client";

const client = getApiClient<ApiContract>("https://api.tedix.dev", {
	getHeaders: withBearerToken(() => getAccessToken()),
	credentials: "include",
});

const apps = await client.apps.list({ limit: 10 });
```

`withApiKey(apiKey)` emits `X-API-Key`. `ClientOptions.headers` supplies static headers.

## Internal Worker client

Prefer the typed service-binding client whenever the procedure is known at
compile time:

```typescript
import { getInternalApiClient } from "@tedix/api-client/internal";

const client = getInternalApiClient(env, {
	organizationId,
	tediId,
	caller: "mcp",
});

const app = await client.internal.getAppBySlug({ slug });
```

`getInternalApiClient` requires `API_SERVICE`, adapts Cloudflare's Request-only
binding, and emits the canonical `X-Service-Binding` and optional
`X-Tedix-*` identity headers. The synthetic `https://api/rpc` URL never leaves
the service binding.

For a procedure path chosen at runtime, use the official-link escape hatch:

```typescript
import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";

const result = await callRpc("memory/learn", input, {
	apiUrl: "https://api",
	fetch: serviceBindingFetch(env.API_SERVICE),
	headers: {
		"X-Service-Binding": "true",
		"X-Tedix-Org-Id": organizationId,
	},
});
```

`RpcCallError` preserves the selected path plus raw HTTP status and response
detail when an upstream error is not decodable as a normal oRPC error.

## Retry and wire contract

`createLink` installs oRPC v2's `RetryLinkPlugin`, but defaults to zero retries:
every RPC uses POST and may perform a non-idempotent write. A caller may opt in
per call only for a read or an operation carrying an idempotency key. `callRpc`
exposes this as `retry` and `retryDelayMs`; typed clients accept the equivalent
oRPC call context. Both surfaces go through `RPCLink`, so oRPC owns the request
body, content type, error format, and output decoding. Tests in
`src/internal.test.ts` pin the v2 request shape, fail-closed retry policy, and
absence of the obsolete empty `meta` array.

Independently published Emdash plugins and standalone tenant templates cannot
resolve this private workspace package. Those deployment artifacts construct
an official `RPCLink` locally, while still leaving all wire serialization and
decoding to oRPC.

## Exports

```typescript
import { withApiKey, withBearerToken } from "@tedix/api-client/adapters";
import {
	createLink,
	createORPCClient,
	getApiClient,
} from "@tedix/api-client/client";

import {
	callRpc,
	getInternalApiClient,
	RpcCallError,
	serviceBindingFetch,
} from "@tedix/api-client/internal";
```

Direct subpaths are also available as `@tedix/api-client/client`,
and `@tedix/api-client/adapters`.

## Verification

```bash
bun run --cwd packages/api-client test:run
bun run --cwd packages/api-client type-check
```

See the public
[Cloudflare architecture](../../docs/public/cloudflare-architecture.md) and
[workers and governance](../../docs/public/workers-and-governance.md) overviews.
