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
// ✅ CORRECT: Direct path imports
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
// ✅ CORRECT: Direct path imports
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
