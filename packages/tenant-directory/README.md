# @tedix/tenant-directory

The single hostname-grammar authority for every Tedix surface.

## Overview

Tenant subdomains follow `{slug}.{surface}.{platformDomain}` across OS, MCP,
Tedi, and CMS. This package owns the one normalization, the one slug regex, and
the two functions every surface routes through:

- `resolveSurfaceTenant(hostname, opts?)` → `{ surface, slug, kind }`
- `buildSurfaceUrl(surface, slug, opts?)` → canonical HTTPS URL
- `SURFACE_SLUG_PATTERN` — the RFC-1035 DNS-label regex (the one)

It is runtime-neutral: no React, no Cloudflare bindings, no persistence, no
network. Surfaces layer their own custom-domain DB lookups on top of the
`custom-domain` verdict.

## Usage

```ts
import { resolveSurfaceTenant, buildSurfaceUrl } from "@tedix/tenant-directory";

resolveSurfaceTenant("globex.os.tedix.dev");
// → { surface: "os", slug: "globex", kind: "tenant" }

resolveSurfaceTenant("acme.mcp.tedix.dev", { expectedSurface: "mcp" });
// → { surface: "mcp", slug: "acme", kind: "tenant" }

resolveSurfaceTenant("blog.example.com", { expectedSurface: "cms" });
// → { surface: "cms", slug: null, kind: "custom-domain" }  (go look it up)

buildSurfaceUrl("tedi", "acme"); // → "https://acme.tedi.tedix.dev"
```

## Per-surface fallthrough

Each Worker passes its own `expectedSurface`. OS fails closed
(`kind: "invalid"` → edge 404); MCP/CMS/Tedi hand unrecognized hosts to their
custom-domain DB lookup (`kind: "custom-domain"`).
