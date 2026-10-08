# @tedix/chat-transport

Framework-neutral Cap'n Web session and embedded-chat transport primitives shared by Tedix OS and host-product widgets.

## Overview

The package owns socket sharing, explicit capability disposal, embedded-session contracts, in-band authentication, committed-cursor replay, and the runtime's private SSE frame adapter. Host authentication remains in each application adapter; the package never reads ambient cookies or invents tenant authority.

## Exports

- `session-hub` shares one live capability while consumers hold leases.
- `embedded-client` provides the browser transport and reconnects with the last fully delivered event ID without re-submitting a turn.
- `canonical-projection` provides canonical-read convergence, delivery-committed revisions, coalesced wake hints, and active/idle reconciliation cadence.
- `embedded-capability` exposes a bounded session rooted in verified tenant, origin, user, and conversation claims.
- `embedded-mount` mounts the WebSocket-only Cap'n Web root.
- `runtime-frames` adapts the existing private runtime event stream into capability callbacks.

The embedded widget's canonical source is `apps/widget/src/embed/embed.mjs`; its classic-script bundle is generated, not hand-edited.

## Delivery and authority

The embedded turn stream reconnects with the last event ID whose frame the
consumer finished delivering. A frame that throws or is aborted during
delivery does not advance that cursor, so reconnect replay may include it
again. Event IDs are deduplicated only after successful delivery. A `done`
frame ends the stream successfully; an `error` frame ends it with an error.

These transport guarantees do not make a callback authoritative. Live
notifications and replayed frames are delivery hints used to refresh or fold a
projection. Canonical conversation, run, approval, and message state remains
owned by the API and its durable stores. Consumers must tolerate duplicate,
overlapping, delayed, and out-of-order delivery, and must not let an older
non-terminal observation downgrade a terminal state already observed or read
canonically.

## Canonical projection watcher

`canonical-projection` is the shared convergence engine used by OS Chat's
run-set cadence and the embedded widget's approval projection. Its contract is:

- subscribe for live hints before taking the first canonical snapshot, so a
  change between snapshot and subscription cannot be missed;
- commit its local revision only after the consumer accepts the canonical
  snapshot, so a failed callback retries rather than parking stale state;
- reconcile from canonical reads on startup, reconnect, hint delivery, and a
  bounded timer while mutable conversation work remains active;
- use a 15-second active cadence and an optional 60-second idle cadence by
  default; and
- coalesce wake hints that arrive while a canonical read is in flight.

The subscribe-before-read guarantee applies when a caller supplies a durable
hint subscription. The current embedded approval projection uses canonical
timer reads plus local mutation wakes; OS uses its run-scoped event pump plus
15-second active and 60-second idle canonical run-set reads. No
conversation-scoped server subscription covers changes made outside a run yet. The watcher does not promise
exactly-once notifications or ordering across independent producers, and a
healthy socket never implies a fresh projection.
