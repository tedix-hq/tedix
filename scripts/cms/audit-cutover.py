#!/usr/bin/env python3
"""Compare a public site with a CMS origin, without changing DNS or routing.

Uses curl for explicit address/host overrides. Writes machine-readable evidence
outside the repository; never follows a redirect back to the production site.
"""
import argparse
import concurrent.futures
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import random
import statistics
import subprocess
import tempfile
import time
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET


class Head(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.canonical = []
        self.hreflang = []
        self.robots = []
        self.structured = []
        self.invalid_json = []
        self.capture = False
        self.script = ''

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'link' and a.get('rel') == 'canonical':
            self.canonical.append(a.get('href'))
        if tag == 'link' and a.get('hreflang'):
            self.hreflang.append((a['hreflang'], a.get('href')))
        if tag == 'meta' and a.get('name', '').lower() in ('robots', 'googlebot'):
            self.robots.append((a['name'].lower(), a.get('content', '')))
        if tag == 'script' and a.get('type') == 'application/ld+json':
            self.capture = True
            self.script = ''

    def handle_data(self, data):
        if self.capture:
            self.script += data

    def handle_endtag(self, tag):
        if tag == 'script' and self.capture:
            self.capture = False
            try:
                self.structured.append(json.loads(self.script))
            except ValueError:
                self.invalid_json.append(self.script)

    def result(self):
        return dict(canonical=sorted(self.canonical), hreflang=sorted(self.hreflang),
                    robots=sorted(self.robots), structured=sorted(
                        self.structured, key=lambda x: json.dumps(x, sort_keys=True)),
                    invalid_json=self.invalid_json)


def xml_tree(body):
    def node(e):
        return [e.tag, sorted(e.attrib.items()), (e.text or '').strip(),
                sorted([node(c) for c in e], key=lambda x: json.dumps(x))]
    return node(ET.fromstring(body))


def robot_rules(body):
    return [line.strip() for line in body.decode().splitlines()
            if line.strip() and not line.lstrip().startswith('#')]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', required=True)
    p.add_argument('--cms', required=True)
    p.add_argument('--public-host', required=True)
    p.add_argument('--source-ip')
    p.add_argument('--pages', type=Path, required=True,
                   help='Source Astro pages directory (inventory only)')
    p.add_argument('--assets', type=Path)
    p.add_argument('--app-sample', type=int, default=200)
    p.add_argument('--workers', type=int, default=4)
    p.add_argument('--latency-samples', type=int, default=20)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)

    def fetch(side, path):
        origin = a.source if side == 'source' else a.cms
        with tempfile.TemporaryDirectory() as d:
            cmd = ['curl', '-sS', '--compressed', '--max-time', '40',
                   '-D', d + '/headers', '-o', d + '/body',
                   '-w', '%{http_code} %{time_starttransfer} %{time_pretransfer} %{remote_ip}',
                   origin.rstrip('/') + path]
            if side == 'cms':
                cmd += ['-H', 'X-Tedix-Public-Host: ' + a.public_host]
            elif a.source_ip:
                cmd += ['--resolve', urlsplit(a.source).hostname + ':443:' + a.source_ip]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode:
                raise RuntimeError(f'{side} {path}: {r.stderr}')
            status, ttfb, pre, ip = r.stdout.split()
            raw = Path(d + '/headers').read_text()
            headers = {}
            for line in raw.splitlines():
                if line.startswith('HTTP/'):
                    headers = {}
                elif ':' in line:
                    k, v = line.split(':', 1)
                    headers[k.lower()] = headers.get(k.lower(), '') + v.strip()
            body = Path(d + '/body').read_bytes()
            return dict(status=int(status), headers=headers, bytes=len(body),
                        sha256=hashlib.sha256(body).hexdigest(),
                        ttfb_ms=round(float(ttfb) * 1000, 2),
                        wait_ms=round((float(ttfb) - float(pre)) * 1000, 2),
                        ip=ip), body

    fetched = {}
    differences = []

    def pair(path):
        results = {}
        bodies = {}
        for side in ('source', 'cms'):
            results[side], bodies[side] = fetch(side, path)
            h = results[side]['headers']
            if 'text/html' in h.get('content-type', ''):
                head = Head()
                head.feed(bodies[side].decode(errors='replace'))
                results[side]['seo'] = head.result()
        return path, results, bodies

    machine = ['/robots.txt', '/sitemap-index.xml', '/sitemap-pages.xml',
               '/sitemap-apps.xml', '/sitemap-posts.xml', '/rss.xml',
               '/sitemap.xml', '/llms.txt', '/apps/llms.txt', '/health', '/health/',
               '/.well-known/agent-card.json', '/site.webmanifest', '/indexnow-key.txt']
    sitemap_paths = set()
    app_paths = set()
    for path, results, bodies in map(pair, machine):
        fetched[path] = results
        if path.startswith('/sitemap-') and path.endswith('.xml'):
            try:
                trees = {s: xml_tree(bodies[s]) for s in bodies}
                if trees['source'] != trees['cms']:
                    differences.append(dict(path=path, field='sitemap'))
                for side, body in bodies.items():
                    for e in ET.fromstring(body).iter():
                        if e.tag.endswith('}loc') and e.text:
                            target = urlsplit(e.text).path
                            if target.startswith('/apps/') and target not in ('/apps/', '/apps/insights/'):
                                app_paths.add(target)
                            elif not target.endswith('.xml'):
                                sitemap_paths.add(target)
            except ET.ParseError:
                differences.append(dict(path=path, field='invalid_sitemap'))
        elif path == '/robots.txt' and robot_rules(bodies['source']) != robot_rules(bodies['cms']):
            differences.append(dict(path=path, field='robots_policy'))
        elif path in ('/rss.xml', '/llms.txt', '/apps/llms.txt', '/.well-known/agent-card.json', '/site.webmanifest'):
            if bodies['source'] != bodies['cms']:
                differences.append(dict(path=path, field='body'))
        if path.rstrip('/') == '/health':
            for side in bodies:
                if results[side]['status'] != 200:
                    continue
                try:
                    results[side]['health'] = json.loads(bodies[side])
                except ValueError:
                    differences.append(dict(path=path, field='invalid_health', side=side))

    routes = set(sitemap_paths)
    for file in a.pages.rglob('*'):
        if file.suffix not in ('.astro', '.ts') or '[' in str(file.relative_to(a.pages)):
            continue
        route = str(file.relative_to(a.pages)).removesuffix('.astro').removesuffix('.ts')
        if route.startswith('api/'):
            continue  # API responses are not indexable pages; no form submissions.
        route = route.removesuffix('/index')
        routes.add('/' if route == 'index' else '/' + route + ('/' if file.suffix == '.astro' else ''))
    routes.update(['/de/', '/es/', '/en/', '/blog/', '/404/', '/does-not-exist-cutover-audit/', '/apps/does-not-exist-cutover-audit/'])
    sample = random.Random(0).sample(sorted(app_paths), min(a.app_sample, len(app_paths)))
    routes.update(sample)
    # Also check source trailing-slash redirects for every named HTML route.
    routes.update(x.rstrip('/') for x in list(routes) if x.endswith('/') and x != '/')
    routes -= set(fetched)
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        for path, results, _ in pool.map(pair, sorted(routes)):
            fetched[path] = results
            print(path, results['source']['status'], results['cms']['status'], flush=True)

    for path, results in sorted(fetched.items()):
        l, c = results['source'], results['cms']
        for field in ('status', 'seo'):
            if l.get(field) != c.get(field):
                if field == 'seo' and l['status'] == c['status'] and 'seo' in l and 'seo' in c:
                    for key in sorted(set(l.get(field, {})) | set(c.get(field, {}))):
                        if l.get(field, {}).get(key) != c.get(field, {}).get(key):
                            differences.append(dict(path=path, field=key))
                elif field == 'status':
                    differences.append(dict(path=path, field=field))
        for field in ('location', 'x-robots-tag'):
            if l['headers'].get(field) != c['headers'].get(field):
                differences.append(dict(path=path, field=field))

    assets = []
    if a.assets:
        paths = ['/' + str(f.relative_to(a.assets)) for f in a.assets.rglob('*')
                 if f.is_file() and f.name not in ('.assetsignore', '_headers', '_redirects')]
        with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
            for path, results, _ in pool.map(pair, sorted(paths)):
                for side in results:
                    original = results[side]
                    current = original
                    chain = []
                    for _ in range(5):
                        location = current['headers'].get('location')
                        if not (300 <= current['status'] < 400 and location):
                            break
                        url = urlsplit(location)
                        if url.netloc and url.netloc not in (a.public_host, urlsplit(a.cms).netloc):
                            break
                        target = url.path + ('?' + url.query if url.query else '')
                        chain.append(dict(status=current['status'], location=location))
                        current, _ = fetch(side, target)
                    original['redirects'] = chain
                    original['final'] = current.copy()
                assets.append(dict(path=path, **results))
                if results['cms']['final']['status'] != 200 or results['source']['final']['sha256'] != results['cms']['final']['sha256']:
                    differences.append(dict(path=path, field='asset'))

    latency = {}
    for path in ('/', '/apps/slack/'):
        samples = {'source': [], 'cms': []}
        for n in range(a.latency_samples + 1):
            for side in ('source', 'cms') if n % 2 else ('cms', 'source'):
                result, _ = fetch(side, path)
                if n:
                    samples[side].append(result)
        latency[path] = samples

    weights = []
    for path, results in fetched.items():
        c = results['cms']
        if c['status'] == 200 and 'seo' in c:
            budget = 400000 if path in ('/', '/de/', '/es/') else 250000
            weights.append(dict(path=path, bytes=c['bytes'], budget=budget, passed=c['bytes'] < budget))
    report = dict(observed_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  source=a.source, cms=a.cms, public_host=a.public_host,
                  app_population=len(app_paths), app_sample=sample,
                  routes=fetched, differences=differences, assets=assets,
                  weights=weights, latency=latency)
    (a.output / 'audit.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(dict(routes=len(fetched), app_population=len(app_paths),
                          app_sample=len(sample), assets=len(assets), differences=differences,
                          overweight=[w for w in weights if not w['passed']],
                          latency={p: {s: dict(median_ttfb_ms=statistics.median(x['ttfb_ms'] for x in v),
                                              median_wait_ms=statistics.median(x['wait_ms'] for x in v),
                                              hits=sum(x['headers'].get('x-tedix-page-cache') == 'HIT' for x in v))
                                       for s, v in sides.items()} for p, sides in latency.items()}), indent=2))


if __name__ == '__main__':
    main()
