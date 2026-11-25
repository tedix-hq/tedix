# Third-Party Notices

This repository includes the third-party code listed below. Add an entry when
you copy or patch third-party code; every dependency patch must be named here
as "a patch to <package> <version>" (`bun run oss:check` enforces it).

## cloudflare-agents-facet-lifecycle-alarm-transport

Includes a patch to agents 0.33.0 that routes private facet Lifecycle alarms through registered parent-owned native jobs while preserving original facet class and path identity, Copyright (c) 2025 Cloudflare, Inc., under the MIT License.

License: MIT (`LICENSES/third-party/cloudflare-agents-MIT.txt`)

## cloudflare-computer-sqlite-test-storage

Includes a bun:sqlite adaptation of Cloudflare Computer's SQLite-backed Durable Object storage fixture, Copyright (c) 2026 Cloudflare, Inc., under the MIT License.

License: MIT (`LICENSES/third-party/cloudflare-computer-MIT.txt`)

## cloudflare-os-adapted-primitives

Includes modified logging, compaction, operational-transform, and theme primitives from Cloudflare OS under the Apache License 2.0.

License: Apache-2.0 (`LICENSES/third-party/cloudflare-os-Apache-2.0.txt`)

## emdash-blog-scaffold

Includes modified presentation and seed from EmDash templates/blog-cloudflare at revision b66d3d18df5ce8eb86fddba91d66ac3495c2cdfe, Copyright 2026 Cloudflare Inc., under the MIT License. Tedix supplies hosting, authentication and trusted plugin integration; local provenance is recorded in apps/cms/templates/blog/UPSTREAM.md.

License: MIT (`apps/cms/templates/blog/LICENSE`)

## emdash-cloudflare-collection-deletion-guard

Includes a patch to @emdash-cms/cloudflare 1.5.0 that guards collection deletion and widens the Kumo peer range, Copyright 2026 Cloudflare Inc., under the MIT License.

Includes a patch to @emdash-cms/cloudflare 1.6.0 that guards collection deletion, Copyright 2026 Cloudflare Inc., under the MIT License.

License: MIT (`LICENSES/third-party/emdash-cloudflare-MIT.txt`)

## emdash-core-collection-deletion-guard

Includes a patch to emdash 1.5.0 that preserves guarded collection deletion, import fencing, the Durable Object transaction bypass, external provider roles for first users, native atomic menu replacement, and normalized content validation on publish and revision restore, Copyright 2026 Cloudflare Inc., under the MIT License.

Includes a patch to emdash 1.6.0 that preserves guarded collection deletion, import fencing, the Durable Object transaction bypass, external provider roles for first users, native atomic menu replacement, and normalized content validation on publish and revision restore, Copyright 2026 Cloudflare Inc., under the MIT License.

License: MIT (`LICENSES/third-party/emdash-cloudflare-MIT.txt`)

## emdash-forms-submission-privacy-and-retention

Includes a patch to @emdash-cms/plugin-forms 0.2.13 that excludes raw visitor IPs from stored submissions, defaults new forms to 30-day retention, keeps form and submission routes admin-only and widens the Kumo peer range, Copyright 2026 Cloudflare Inc., under the MIT License.

Includes a patch to @emdash-cms/plugin-forms 0.2.14 that excludes raw visitor IPs from stored submissions, defaults new forms to 30-day retention, keeps form and submission routes admin-only and widens the Kumo peer range, Copyright 2026 Cloudflare Inc., under the MIT License.

License: MIT (`LICENSES/third-party/emdash-cloudflare-MIT.txt`)

## emdash-native-marketing-scaffold

Includes modified presentation and seed from EmDash templates/marketing-cloudflare at revision b66d3d18df5ce8eb86fddba91d66ac3495c2cdfe, Copyright 2026 Cloudflare Inc., under the MIT License. Tedix supplies hosting, authentication and trusted plugin integration; local provenance is recorded in apps/cms/templates/native-marketing/UPSTREAM.md.

License: MIT (`apps/cms/templates/native-marketing/LICENSE`)

## emdash-portfolio-scaffold

Includes modified presentation and seed from EmDash templates/portfolio-cloudflare at revision b66d3d18df5ce8eb86fddba91d66ac3495c2cdfe, Copyright 2026 Cloudflare Inc., under the MIT License. Tedix supplies hosting, authentication and trusted plugin integration; local provenance is recorded in apps/cms/templates/portfolio/UPSTREAM.md.

License: MIT (`apps/cms/templates/portfolio/LICENSE`)

## emdash-starter-scaffold

Includes modified presentation and seed from EmDash templates/starter-cloudflare at revision b66d3d18df5ce8eb86fddba91d66ac3495c2cdfe, Copyright 2026 Cloudflare Inc., under the MIT License. Tedix supplies hosting, authentication and trusted plugin integration; local provenance is recorded in apps/cms/templates/starter/UPSTREAM.md.

License: MIT (`apps/cms/templates/starter/LICENSE`)

## ink-text-input-composer

Includes a modified input rendering implementation from ink-text-input 6.0.0, Copyright (c) Vadim Demedes, under the MIT License.

License: MIT (`LICENSES/third-party/ink-text-input-MIT.txt`)

## mcp-reference-memory-license

Includes a patch to @modelcontextprotocol/server-memory 2.2.1 that restores the missing upstream `LICENSE` file verbatim and changes the manifest's `SEE LICENSE IN LICENSE` to `Apache-2.0 AND MIT`. No executable code is changed.

The [npm provenance for 2.2.1](https://registry.npmjs.org/-/npm/v1/attestations/@modelcontextprotocol%2fserver-memory@2.2.1) identifies modelcontextprotocol/servers revision `c799c8552b0f27b7a33a7b9233773da144dddcf5` (tag `v2.5.0`). Its [LICENSE](https://github.com/modelcontextprotocol/servers/blob/c799c8552b0f27b7a33a7b9233773da144dddcf5/LICENSE) licenses new and consented contributions under Apache-2.0, while contributions not yet relicensed remain MIT. The expression requires both licenses; it does not claim the code has been wholly relicensed or that recipients may choose either license. The restored file also retains upstream's CC-BY-4.0 documentation notice.

License: Apache-2.0 AND MIT (`LICENSE` restored by `patches/@modelcontextprotocol/server-memory@2.2.1.patch`), Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.

## openclaw-agent-skills

Includes modified debugging and test-audit agent skill instructions from OpenClaw at revision c8931b32d3d, Copyright (c) 2026 OpenClaw Foundation, under the MIT License. They live in .agents/skills/debug-tedix-run/SKILL.md and .agents/skills/test-audit/SKILL.md.

License: MIT (`LICENSES/third-party/openclaw-MIT.txt`)
