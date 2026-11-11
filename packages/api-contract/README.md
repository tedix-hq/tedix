# @tedix/api-contract

**Canonical source for shared types, oRPC contracts, and Zod schemas** for the Tedix API.

## Overview

This package is the **public interface** for API schemas and types. All apps import shared types from here.

```
┌─────────────────────────────────────────────────────────────┐
│  packages/db (Database Layer)                                │
│  SOURCE OF TRUTH: Drizzle schemas, DB types, relations      │
│  CONSUMERS: apps/api, apps/landing (SSR), packages          │
└──────────────────────────┬──────────────────────────────────┘
                           │ imports
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  packages/api-contract (API Layer - PUBLIC)                  │
│  CANONICAL SOURCE FOR:                                       │
│  ├── All shared types (Vertical, LayoutItem, AppCaps)       │
│  ├── All API schemas (Zod request/response validation)      │
│  ├── All oRPC contracts (API definitions)                   │
│  CONSUMERS: All apps (api, os, mcp, widget, landing)        │
└──────────────────────────┬──────────────────────────────────┘
                           │ imports
              ┌────────────┼────────────┬────────────┐
              ▼            ▼            ▼            ▼
         apps/api       apps/os      apps/mcp-ui  apps/mcp
                                                  apps/landing
```

**Key Rule:** Apps should import shared types from `@tedix/api-contract`, not from `@tedix/db`.

## Usage

### Import Schemas

Import from specific schema files (no barrel imports):

```typescript
// CORRECT: Direct path imports
import { AppSchema, VerticalSchema } from "@tedix/api-contract/schemas/app";
import {
	PaginationSchema,
	AppIdParamSchema,
} from "@tedix/api-contract/schemas/common";
import { OrganizationSchema } from "@tedix/api-contract/schemas/organization";

// Validate input
const app = AppSchema.parse(data);
const vertical = VerticalSchema.parse("ecommerce");
```

### Import Contracts

Import from specific contract files:

```typescript
// CORRECT: Direct path imports
import { apiContract } from "@tedix/api-contract/contracts/api";
import { appsContract } from "@tedix/api-contract/contracts/apps";

// Use with oRPC implement() - per-contract pattern (matches apps/api)
import { implement } from "@orpc/server";
const os = implement(appsContract).$context<BaseContext>();
```

### Type Inference

```typescript
import type {
	InferContractInput,
	InferContractOutput,
	InferContractRouterInputs,
	InferContractRouterOutputs,
} from "@tedix/api-contract/types";
import { apiContract } from "@tedix/api-contract/contracts/api";

// Input type for create app
type CreateAppInput = InferContractInput<typeof apiContract.apps.create>;

// Output type for get app
type AppOutput = InferContractOutput<typeof apiContract.apps.get>;

// All input types for apps router
type AppsInputs = InferContractRouterInputs<typeof apiContract.apps>;
```

## Package Exports

**Important:** This package uses direct path exports (no barrel files). Import from specific files.

### Schema Exports

| Export                                     | Description                                     |
| ------------------------------------------ | ----------------------------------------------- |
| `@tedix/api-contract/schemas/common`       | Pagination, ID params, responses                |
| `@tedix/api-contract/schemas/app`          | App-related schemas (AppSchema, VerticalSchema) |
| `@tedix/api-contract/schemas/organization` | Organization schemas                            |
| `@tedix/api-contract/schemas/config`       | Config validation schemas                       |
| `@tedix/api-contract/schemas/adapters`     | Adapter schemas                                 |
| `@tedix/api-contract/schemas/content`      | Content schemas                                 |
| `@tedix/api-contract/schemas/layout`       | Layout schemas                                  |
| `@tedix/api-contract/schemas/tools`        | Tool schemas                                    |

### Contract Exports

| Export                                        | Description                          |
| --------------------------------------------- | ------------------------------------ |
| `@tedix/api-contract/contracts/api`           | Combined apiContract with /v1 prefix |
| `@tedix/api-contract/contracts/apps`          | Apps contract                        |
| `@tedix/api-contract/contracts/organizations` | Organizations contract               |
| `@tedix/api-contract/contracts/members`       | Members contract                     |
| `@tedix/api-contract/contracts/items`         | Items contract                       |
| `@tedix/api-contract/contracts/content`       | Content contract                     |
| `@tedix/api-contract/contracts/analytics`     | Analytics contract                   |
| `@tedix/api-contract/contracts/blog`          | Blog contract                        |
| `@tedix/api-contract/contracts/widgets`       | Widgets contract                     |
| `@tedix/api-contract/contracts/templates`     | Templates contract                   |
| `@tedix/api-contract/contracts/secrets`       | Secrets contract                     |
| `@tedix/api-contract/contracts/listings`      | Listings contract                    |
| `@tedix/api-contract/contracts/workflows`     | Workflows contract                   |
| `@tedix/api-contract/contracts/chat`          | Chat contract                        |

### Type Exports

| Export                      | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| `@tedix/api-contract/types` | Type utilities (InferContractInput, InferContractOutput) |

## Key Schemas

### Common

- `PaginationSchema` - Pagination params (limit, offset)
- `AppIdParamSchema` - UUID app ID parameter
- `SlugParamSchema` - URL-safe slug parameter
- `SuccessResponseSchema` - Standard success response

### App

- `AppSchema` - Full app entity
- `VerticalSchema` - App vertical enum
- `AppVisibilitySchema` - Visibility enum
- `DiscoveryStatusSchema` - Discovery pipeline status
- `AppStoreStatusSchema` - App Store status

### Organization

- `OrganizationSchema` - Organization entity
- `MemberSchema` - Organization member
- `ApiKeySchema` - API key entity

## Design Principles

1. **Canonical source for shared types** - All apps import `Vertical`, `LayoutItem`, `AppCapabilities`, etc. from here
2. **Apps import from here** - Most apps never import from `@tedix/db` (exceptions: `apps/api`, `apps/landing`)
3. **Contract-first** - Define schemas before implementation
4. **Type inference** - Use `InferContractInput/Output` for type safety
5. **Single source** - No duplicate schemas across packages

## What This Package Provides

| Category                 | Examples                                               | Import Path                                |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------ |
| **App Schemas**          | `AppSchema`, `VerticalSchema`, `AppCapabilitiesSchema` | `@tedix/api-contract/schemas/app`          |
| **Common Schemas**       | `PaginationSchema`, `AppIdParamSchema`                 | `@tedix/api-contract/schemas/common`       |
| **Layout Schemas**       | `LayoutItemSchema`, `WidgetKey`                        | `@tedix/api-contract/schemas/layout`       |
| **oRPC Contracts**       | `apiContract`                                          | `@tedix/api-contract/contracts/api`        |
| **Individual Contracts** | `appsContract`, `organizationsContract`                | `@tedix/api-contract/contracts/apps`, etc. |
| **Type Utilities**       | `InferContractInput`, `InferContractOutput`            | `@tedix/api-contract/types`                |

## Work Task Contract adapter

Import schemas from `@tedix/api-contract/schemas/task-contract` and adapter
functions from `@tedix/api-contract/utils/task-contract`. `exportWorkTaskContract`
exports an accepted Work snapshot, its version, accepted outcome, description
checkboxes (checked boxes still require verification), capabilities and required
authorities. The caller supplies the admitted resource scope, budget, human gates,
external runtime registration, expiry and fresh contract ID/nonce. Missing checks
or an accepted outcome fail export. Do not derive human approval from a checked box.

`executeTaskContract` passes that contract and signed approvals to an injected
external gateway with the contract digest as its idempotency key. The external
runtime owns its hierarchy and model calls through its own gateway/LiteLLM.
This package has no model client. The mock gateway test is the local adapter
proof; it does not establish compatibility with an external runtime's wire protocol.

`importTaskResult` verifies Ed25519 signatures, tenant, contract digest, nonce and
the registered runtime/SPIFFE identity. Approval signatures bind the complete
contract digest, gate, human approver, canonical reference and expiry. Trust keys
come from the host's registration, never from the result. A SPIFFE string and
signature alone are not workload attestation: the host must provision trusted
keys using its authenticated runtime identity system.

The kernel implements `assertActive` to check the current canonical Work version,
full admitted contract, scopes, budget, authorities, human gates and cancellation.
It implements `assertApproval` against canonical human decisions and revocation.
Both checks run before dispatch/import and again before storing a new receipt.
The independent verifier returns exactly one outcome with evidence per acceptance
check. Failed checks are stored alongside the original signed runtime claims;
claims cannot turn a failed verification into success or complete Work.

The host implements `TaskReceiptStore` using existing Work evidence storage.
`insertOnce` must atomically persist the receipt and its Work evidence link with
a unique `(orgId, contractId)` key and return the original row on conflict.
Conflicting results are rejected; identical retries return that row without
repeating gateway execution or verification. Concurrent first calls can reach
the gateway with the same idempotency key, which it must honor. Gateway timeout
retries also reuse that key. Never allocate a new contract/nonce just to retry.

No production transport, SPIFFE enrollment, approval issuer or database binding
is installed by this library. The injected services preserve the kernel's existing
admission, cancellation and settlement ownership; receipt import is evidence,
not Work completion or proof of external effects.
