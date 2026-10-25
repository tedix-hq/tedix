---
status: accepted
date: 2026-10-26
summary: "A conversation stays a facet of its tedi; a routed agent per conversation is not adopted yet"
read_when:
  - Changing how a tedi runs several conversations at once
  - Weighing the Agents SDK guidance on facets against our tool-proxy design
title: "Conversations stay facets of their tedi"
---

# Conversations stay facets of their tedi

A tedi runs each conversation as a facet of its own Durable Object
(`ConversationFacet` under `AgentTediDO` in `apps/tedi-runtime`). Upstream
Agents SDK guidance now positions facets as an isolation primitive and points
at one top-level object per conversation plus a catalog for many chats per
user. This record makes our divergence deliberate.

## Decision

Keep one facet per conversation under the tedi for now. Do not migrate to a
routed object per conversation.

Why:

- The facets close over parent state on purpose: the per-run tool registry,
  the MCP runtime and workstation handles live in the tedi and are reached by
  cheap colocated calls. A top-level object per conversation would make every
  tool call cross-machine, so the tool-proxy design would have to be redesigned
  first. That redesign is the real cost, and nothing today forces it.
- The documented costs of the facet shape are known and bounded for us: one
  alarm slot for the tree, one placement, one storage root, and streamed chat
  frames waking the parent. Turn admission is already bounded per tedi
  (`Bound concurrent turns per tedi Durable Object`), which caps the blast
  radius of a busy conversation.
- Workspace apps took the other shape where it fits: `WorkspaceAppHostDO`
  hosts one facet per app with isolated storage and no shared parent state,
  so the pattern upstream warns about is used only where the parent state is
  the point.

## Consequences

- Conversation count per tedi stays a capacity dimension of the tedi, not of
  the platform. Watch the turn-admission and alarm metrics per tedi.
- Revisit when either happens: the tool registry moves out of the tedi object
  (which makes a routed child cheap), or measured alarm or placement
  contention on a busy tedi affects users. Either reopens this record; neither
  is expected before the Reddit pilot ships.
