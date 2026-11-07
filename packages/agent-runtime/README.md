# @tedix/agent-runtime

The runtime a single-writer agent object codes against. An agent object keeps
its own data and runs its own loop: a workspace is one such object, a tedi can
be another. This package gives that object five things through one interface,
so the same object runs on Tedix Cloud, on a self-hosted workerd process, and
later on other hosts. It is runtime-neutral: nothing in it knows what a
workspace or a tedi is, and it imports nothing from `apps/*`. Policy, approvals
and the change ledger are the sibling package `@tedix/agent-governance`
(`GovernanceAdapters`); wrap a binding's stub with it before registering the
binding here.

- `storage`: single-writer SQL for the object, with migrations.
- `sandbox`: runs agent-written code with no network, only named bindings.
- `bindings`: the `env.NAME` capabilities that code can reach, each described
  in full with one call.
- `events`: a feed connected clients read over WebSocket, with a cursor they
  can resume from.
- `alarms`: timers with payloads, many per object.

Import the contract from the package root and an implementation from its
subpath:

```ts
import type { AgentRuntime } from "@tedix/agent-runtime";
import {
	CloudflareAgentRuntime,
	cloudflareAgentObjectStub,
} from "@tedix/agent-runtime/cloudflare";
import {
	WorkerdAgentRuntime,
	workerdAgentObjectStub,
} from "@tedix/agent-runtime/workerd";
```

## Using it from an agent object

The object constructs the runtime once and delegates the four host hooks to
it. Nothing else in the object needs to know which host it runs on.

```ts
import { DurableObject } from "cloudflare:workers";
import { CloudflareAgentRuntime } from "@tedix/agent-runtime/cloudflare";

export class AgentObject extends DurableObject<Env> {
	readonly runtime: CloudflareAgentRuntime;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.runtime = new CloudflareAgentRuntime(ctx, env, {
			objectId: ctx.id.name!,
			jurisdiction: "eu", // from the organization's residency
		});
		this.runtime.alarms.onAlarm(async (alarm) => {
			/* run the due work */
		});
		this.runtime.bindings.register({
			name: "OUTPUTS",
			description: "Read and write this workspace's outputs.",
			declaration: "interface Outputs { list(): Promise<Output[]>; ... }",
			stub: new OutputsTarget(this.runtime.storage),
		});
	}

	fetch(request: Request) {
		return this.runtime.events.connect(request);
	}
	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		return this.runtime.events.handleMessage(ws, message);
	}
	async alarm() {
		await this.runtime.alarms.dispatchDue();
	}
}
```

Open an object with the address helper, never with the raw namespace. For an
EU organization the object is created inside the EU jurisdiction, and the same
id addressed without it would be a different, empty object:

```ts
const stub = cloudflareAgentObjectStub(env.WORKSPACE, {
	objectId,
	jurisdiction: organization.residency === "eu" ? "eu" : "global",
});
```

## The interface

Every method is asynchronous, even where today's host is synchronous, so the
object never changes when the host does. `src/index.ts` is the full contract;
the summary:

| Part       | Methods                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `storage`  | `exec(sql, params)`, `query(sql, params)`, `batch(statements)` (atomic), `migrate(list)`, `appliedMigrations()` |
| `sandbox`  | `run({ code, bindings?, limits? })` → `{ ok, value, logs, truncated }` or `{ ok: false, reason, error, logs }`  |
| `bindings` | `register(binding)`, `unregister(name)`, `describe(name)`, `list()`, `catalog()`                                |
| `events`   | `publish(event)`, `subscribe(listener, { after })`, `replay(after)`, `head()`, `connect(request)`               |
| `alarms`   | `schedule(at, payload)`, `cancel(id)`, `list()`, `onAlarm(handler)`, `dispatchDue()`                            |

### Sandbox

`run` loads the snippet into a fresh isolate with `globalOutbound: null` and
the `disallow_importable_env` flag. The code can call `fetch` and get nothing,
cannot import its own env, and reaches only the bindings named in the run
(every registered binding when `bindings` is omitted). A snippet is a module
with a default export `async (env) => value`, or a bare function body that
receives `env`. Limits default to 30 s, 200 000 result characters and 200 log
lines; a cut result comes back with `truncated: true`.

The manifest is built in `src/sandbox.ts` and nowhere else, and that file is
listed in `scripts/lint-loader-sandbox.ts`, which fails the push when a
loader site forgets the outbound policy.

### Bindings

A binding is a name, a one-line description, the complete TypeScript
declaration and the stub the sandbox receives. `describe(name)` returns the
description and the whole declaration in one call, so an agent never has to
search first and describe second. `catalog()` is the prompt text listing
every binding with its one-line description.

### Events

Each published event gets a strictly increasing cursor and is stored (the
newest 10 000 by default). A client connects with
`GET /…?after=<cursor>` and an `Upgrade: websocket` header; it first receives
every stored event after that cursor, then live ones, each as one JSON
message `{ kind: "event", cursor, type, payload, at }`. After a reconnect it
can also send `{ kind: "replay", after }`. In-object code uses `subscribe`
the same way.

### Alarms

Many alarms share the host's single timer. Each alarm is a stored row; the
timer is always armed for the soonest. `dispatchDue()` deletes each due alarm
before handing it to the handler, so a handler that throws does not fire
again forever.

## Hosts

### Cloudflare (`./cloudflare`)

Durable Object SQLite storage, the `LOADER` Worker Loader binding, hibernating
WebSockets and the object's alarm. The Worker declares:

```jsonc
{
	"durable_objects": {
		"bindings": [{ "name": "WORKSPACE", "class_name": "AgentObject" }],
	},
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["AgentObject"] }],
	"worker_loaders": [{ "binding": "LOADER" }],
}
```

`cloudflareAgentObjectStub` selects `jurisdiction("eu")` for an EU object
through `@tedix/worker-kit/durable-objects`, the one module allowed to address
objects.

### Self-hosted workerd (`./workerd`)

The same object storage, loader, WebSocket and alarm APIs on a workerd process
you run yourself. State is file-backed: `workerd/agent-object.capnp` points the
object namespace at a directory on disk, so each object's SQLite file lives
there and survives restarts. The jurisdiction is `local`: residency is where
the process runs, and the implementation refuses any narrower claim. The
config compiles with workerd 1.20261101.1 (`workerd compile agent-object.capnp`);
it has not been run as a service from this repository, so check it on your
own workerd before relying on it.

### Kubernetes and Postgres (sketch, not implemented)

The contract is deliberately host-neutral so a customer on Kubernetes can run
the same agent object. What such an implementation needs:

- **Single writer.** One process owns one object at a time. A lease row in
  Postgres (`agent_object_leases(object_id, holder, expires_at)`) renewed by
  the holder gives the same guarantee a Durable Object gives for free; every
  method checks the lease before touching data.
- **Storage.** One Postgres schema per object (`obj_<id>`), `batch` as a
  transaction, migrations recorded in the same table shape as here.
- **Sandbox.** A local workerd process beside the service, started with a
  config like `workerd/agent-object.capnp` minus the disk, with the bindings
  served back to it over a loopback socket. Nothing in the contract depends on
  the loader being in-process.
- **Events.** The events table in Postgres plus `LISTEN/NOTIFY` for live
  delivery; the WebSocket endpoint lives in the service.
- **Alarms.** The alarms table plus one poller per process, or a scheduler
  that calls `dispatchDue()` over HTTP.

The conformance suite (`./conformance`) is the acceptance test for any such
implementation.

## Checking it

```bash
bun run --cwd packages/agent-runtime test:run
```

```bash
bun run --cwd packages/agent-runtime type-check
```

The suite runs inside workerd and exercises both implementations against real
object storage, a real loader and real WebSockets. `describeAgentRuntimeConformance`
from `./conformance` takes a harness, so a new host runs the same suite.
