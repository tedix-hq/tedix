# Tedi Workstation Runtime

This Worker owns the native Cloudflare Sandbox processes and filesystem for
leased tedi Linux workstations. It uses the pinned Sandbox v1 SDK and
matching image. Tini keeps the container alive; the entrypoint composes the
Cloudflare HTTPS interception trust bundle before commands run.

The Durable Object records a logical execution intent before dispatch, then
persists its native process ID before returning success. Unknown launch outcomes
are never replayed. After nine idle minutes, the Durable Object saves a native
image-bound filesystem snapshot and destroys the container. The next access on
the exact same lease fence restores that snapshot. Process memory is never
restored. Tedix also owns portable repository checkpoints and retained
artifacts; those remain the recovery path after snapshot expiry, an image
change, or a provider restore failure. The Agent runtime keeps tedi cognition
and lightweight Computer scratch storage separately.

| Path                                                | Purpose                                      |
| --------------------------------------------------- | -------------------------------------------- |
| `/home/tedi`                                        | Container home                               |
| `/workspace`                                        | Native container disk                        |
| `/home/tedi/workstation`                            | Symlink to `/workspace`; default command cwd |
| `/home/tedi/workstation/repos`                      | Repository checkouts                         |
| `/home/tedi/workstation/cache/package-managers/bun` | Shared Bun download cache                    |

`apps/tedi` uses the external `TEDI_WORKSTATION_RUNTIME_SANDBOX` namespace for
scoped computer tools. It owns lease authority, egress, repository preparation,
publication policy and preservation-aware cleanup. Native processes provide
status, output, timeout and cancellation; native file streams carry bytes.
There is no workstation computerd backend or stable SDK transport selection.

The `BACKUP_BUCKET` binding is required for recovery. `/health` reports its
presence and the exact deployed Git SHA. Worker and image versions must advance
together: guarded deployments request immediate container rollout with zero
active grace after current work has been preserved and drained.

An installation's Worker script and container application names are deployed
state, not free-form labels. Private release configuration owns those names.
Cloudflare binds a Durable Object namespace to one
container application; deploying a different application name for the same
workstation Durable Object namespace fails with
`DURABLE_OBJECT_ALREADY_HAS_APPLICATION`.

For an existing installation, preserve its Durable Object migration history.
Renaming `TediWorkstationSandbox` to `TediWorkstationRuntimeSandbox` requires
`renamed_classes`, not a fresh `new_sqlite_classes` entry for the existing
namespace. Never delete classes this Worker did not export. Managed deployment
runs through the guarded workflow in `tedix-hq/tedix-cloud-ops`.
