# @tedix/provisioning

Shared client library for interacting with tedi runtime Workers (tedi Worker admin API).

## Overview

Tedi runtimes are addressed through their derived tedi Worker URL. Every tedi is
the Agent runtime (Cloudflare Agents with native Pi Worker + Durable Object); OS/process
capability is an additive workstation lease. The root export is limited
to current Agent-runtime and generic tedi Worker admin routes. CMS bundle
provisioning remains under `@tedix/provisioning/cms`.

## Usage

```typescript
import { getAgentDiagnostics, wakeTedi } from "@tedix/provisioning";

const config = {
	workerUrl: "https://research.acme.tedi.tedix.dev",
};

// Wake the Agent-runtime tedi and read diagnostics.
const wake = await wakeTedi(config);
const diagnostics = await getAgentDiagnostics(config);
```

## API Endpoints

| Method | Endpoint                 | Auth            | Description                   |
| ------ | ------------------------ | --------------- | ----------------------------- |
| POST   | `/api/admin/status/wake` | Service binding | Wake runtime                  |
| GET    | `/__admin/agent-diag`    | Service binding | Agent-runtime diagnostics     |
| POST   | `/hooks/inject`          | Service binding | Inject one Agent-runtime turn |
| POST   | `/hooks/cancel-turn`     | Service binding | Cancel one Agent-runtime turn |

## Authentication

Admin routes are authenticated via Cloudflare Service Bindings. When called through a service binding, no auth headers are needed.

## Types

```typescript
interface ProvisioningConfig {
	workerUrl: string;
}

interface WakeTediResult {
	success: boolean;
	ready: boolean;
	status: string;
}
interface AgentDiagnosticsResult {
	ok: boolean;
	[key: string]: unknown;
}
```
