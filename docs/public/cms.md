---
sidebar:
  order: 105
title: "Websites and CMS"
topic: "Platform"
resource_type: guide
description: "Create and publish a CMS website in an invited Tedix Cloud organization."
summary: "CMS availability, prerequisites, and the first draft-to-publish workflow"
read_when:
  - Evaluating Tedix for website content and publishing
  - Helping an agent create or use a CMS site
visibility: public
---

# Websites and CMS

Tedix CMS uses Emdash for website content and Astro themes. A human or agent
can inspect a site's collections, create a draft, revise it, and publish it.
Theme editing and deployment are separate from everyday content publishing.
For Git-backed product documentation, use [Documentation sites](./docs-sites.md).

## Availability

CMS is part of the invited Cloud beta. An organization admin can open **Sites**
and create a CMS site with a name, globally unique slug, and starter template.
The action creates the site's authoring connection and media storage. The site
is ready for authoring but remains unpublished until its first theme deploy.
Someone without the organization's `settings:manage` permission can view owned
sites but cannot create one. The **Sites** page shows the organization's CMS
site usage and plan limit. Paused sites still use a slot; completed deprovisioning
frees it. A matching retry does not consume another slot.

An authorized coding agent can call `sites.create_cms_site` through that
organization's Tedix gateway with the `mcp:content.admin` scope. Confirm the
workspace with `tedix -w <workspace> auth status`, discover the exact tool schema,
then supply the same name, slug, and template. A matching retry returns the
existing site. A slug already owned by another organization is rejected.
Custom hostnames can be connected from **Sites** when the organization's
`customDomain` feature is enabled. Business and Enterprise plans enable it by
default; an organization-specific feature override can change availability.

The root local launcher does not provide a ready-to-use CMS trial. Starting a
CMS Worker locally does not provision its tenant, content collections, theme
bundle, or authenticated authoring connection. Own-account CMS installation
remains experimental [operator work](./self-hosted-boundary.md).

## Connect a custom hostname

An organization admin with `settings:manage` can open an active CMS site in
**Sites → Custom domain**. An authorized agent can use the organization's
`begin_cms_domain`, `get_cms_domain`, `verify_cms_domain`, and
`remove_cms_domain` gateway tools. Changes require both `settings:manage` and
`mcp:content.admin`; reads require `settings:manage` and `mcp:content.read`.

1. Begin a claim for your main hostname, such as `example.com` or
   `blog.example.com`. Tedix shows the exact DNS names and values for this
   claim. Copy them from **Sites**; the ownership value is unique to the claim,
   which expires after seven days.
2. Add the records at your DNS provider:

   | Hostname                              | Records to add                                                                                                                                                                         |
   | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Every claim                           | TXT at the returned `_tedix-cms.<hostname>` name with the returned value.                                                                                                              |
   | Subdomain, such as `blog.example.com` | Direct, publicly visible CNAME from the hostname to the returned `{site-slug}.cms.tedix.dev` target. If your provider offers a proxy switch, use **DNS only**.                         |
   | Zone apex, such as `example.com`      | Provider-supported flattened CNAME, ALIAS, or ANAME at `@` pointing to the returned target. Do not use a fixed IP address. Your DNS provider must support an apex alias or flattening. |

3. Once the records appear in public DNS, select **Verify domain**. If Sites
   then shows more TXT or CNAME records for Cloudflare hostname or certificate
   validation, add each exact name and value and verify again. DNS consoles
   differ in whether they append the zone name, so check the resulting public
   record name before retrying.
4. Wait until Sites reports the hostname **and** its TLS certificate active.
   Then open the HTTPS URL and confirm that it serves your site. DNS ownership
   alone does not make the site live.

For an apex domain, you can also redirect `www.example.com` to `example.com`.
After the apex is active, start the separate **www redirect** claim in Sites.
Add its own `_tedix-cms.www.example.com` TXT and a direct, DNS-only CNAME for
`www` to the target shown for that claim. Add any further validation records
Sites shows, then verify until the `www` hostname and certificate are active.
Tedix then sends an HTTPS 301 redirect to the apex and preserves the path and
query string. A `www` DNS record by itself does not create a redirect. An agent
can start this companion with `begin_cms_domain` using
`hostname: "www.example.com"` and `redirectToApex: true`.

Status may briefly say **Provisioning** while Cloudflare creates the hostname.
Retry verification on the same claim. If removal says provisioning is still in
progress, retry it shortly. A failed provider deletion may also leave a
removing claim that you can retry.

To replace a hostname, begin and verify a new claim; the current hostname stays
active until the replacement is ready. Removing a claim restores the site's
`{site-slug}.cms.tedix.dev` canonical URL. The platform origin can retain a
cached canonical URL for a few minutes; check the rendered page after the
change. Update your DNS afterward. Subdomain CNAMEs must remain publicly
visible; a proxied Cloudflare-to-Cloudflare (O2O) record can hide the required
target. A pending main-hostname claim for another hostname must be removed
before starting a different one.

If your site already has a direct custom hostname from before this manager was
introduced, begin that same hostname to bring it into the manager. Tedix checks
the exact Cloudflare record and certificate first, then adopts it without
interrupting the existing route. This remains available after a plan downgrade;
adding a different hostname still requires the custom-domain feature. Removing
or deprovisioning the site also removes its Cloudflare hostname. Deprovisioning
waits and retries if provisioning is still in progress.

## Publish one small item

1. Confirm the intended organization with `tedix -w acme auth status`, replacing
   `acme` with your workspace. Use the [agent guide](./agent-guide.md) to discover
   its CMS tools and request the exact input schemas. Namespace names depend on
   the connected site; do not copy another organization's namespace.
2. Read `get_site_overview`, then `schema_get_collection` for the collection you
   want to use. Follow its actual fields and types rather than assuming every
   site has a `posts` collection.
3. Use `content_create` to create a small draft. Read it back with `content_get`
   and review the title, body, slug, and intended destination with the human.
4. When publication is authorized, call `content_publish` for that exact item.
   Open its canonical public URL and verify the rendered content. A successful
   draft save is not evidence that the item is publicly visible.

This editorial loop does not require a Worker deployment. If a tool is absent
or access is denied, report the missing connection or permission rather than
guessing a callable or switching organizations.

For source work, start with `apps/cms` (authoring and theme builds) and
`apps/cms-runtime` (serving tenant sites). Read their scoped guides before editing.
