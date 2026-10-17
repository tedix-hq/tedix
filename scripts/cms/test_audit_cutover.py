import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'audit', Path(__file__).with_name('audit-cutover.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditTest(unittest.TestCase):
    def test_body_text_ignores_build_code_but_detects_content_changes(self):
        def digest(markup):
            text = audit.BodyText()
            text.feed(markup)
            return text.digest()
        markup = ('<head><title>Title</title><script>one()</script></head>'
                  '<body><h1>Recurring work</h1><p>A &amp; B</p>'
                  '<svg><title>Icon</title></svg><script>two()</script></body>')
        self.assertEqual(digest(markup), digest(markup.replace('two()', 'newCode()')))
        self.assertEqual(digest(markup), digest(markup.replace('A &amp; B', 'A  & B')))
        self.assertNotEqual(digest(markup), digest(markup.replace('Recurring', 'Other')))

    def test_title_and_social_metadata_changes_are_detected(self):
        markup = ('<head><title>Hand off work &amp; check proof</title>'
                  '<meta name="description" content="Recurring work">'
                  '<meta name="twitter:card" content="summary_large_image">'
                  '<meta property="og:image" content="https://example.com/og.jpg">'
                  '</head><body><svg><title>Icon</title></svg>'
                  '<meta itemprop="name" content="Body item"></body>')
        head = audit.Head()
        head.feed(markup)
        result = head.result()
        self.assertEqual(result['titles'], ['Hand off work & check proof'])
        self.assertEqual(len(result['meta']), 3)
        for before, after in [('summary_large_image', 'summary'),
                              ('og.jpg', 'wrong.jpg'),
                              ('Recurring work', 'Old wording'),
                              ('Hand off work', 'AI coworkers')]:
            changed = audit.Head()
            changed.feed(markup.replace(before, after))
            self.assertNotEqual(result, changed.result())

    def test_build_resources_are_recorded_without_masking_identity_links(self):
        head = audit.Head()
        head.feed('<head><link rel="icon" href="/favicon.ico">'
                  '<link rel="preload" href="/font.woff2" as="font">'
                  '<link rel="stylesheet" href="/build.css">'
                  '<script type="module" src="/build.js"></script></head>')
        self.assertEqual(head.result()['links'],
                         [[('href', '/favicon.ico'), ('rel', 'icon')]])
        self.assertEqual(len(head.resources), 3)
        self.assertEqual(head.resources[-1]['attributes']['src'], '/build.js')

    def test_head_preserves_json_and_attribute_values(self):
        head = audit.Head()
        head.feed('<link href="https://example.com/de/" hreflang="de" rel="alternate">'
                  '<link href="https://example.com/" rel="canonical">'
                  '<meta content="noindex" name="robots">'
                  '<script type="application/ld+json">'
                  '{"@type":"WebPage","name":"A & B"}</script>')
        result = head.result()
        self.assertEqual(result['canonical'], ['https://example.com/'])
        self.assertEqual(result['hreflang'], [('de', 'https://example.com/de/')])
        self.assertEqual(result['structured'][0]['name'], 'A & B')
        self.assertEqual(result['robots'], [('robots', 'noindex')])

    def test_invalid_json_is_explicit(self):
        head = audit.Head()
        head.feed('<script type="application/ld+json">{invalid}</script>')
        self.assertEqual(head.result()['invalid_json'], ['{invalid}'])

    def test_xml_order_and_whitespace_are_not_semantic_differences(self):
        self.assertEqual(audit.xml_tree(b'<a><b>x</b><b>y</b></a>'),
                         audit.xml_tree(b'<a> <b>y</b> <b>x</b> </a>'))
        self.assertNotEqual(audit.xml_tree(b'<a><b>x</b></a>'),
                            audit.xml_tree(b'<a><b>y</b></a>'))


    def test_discovery_ignores_only_catalog_generation_clock(self):
        a = b'Generated: 2026-01-01\nApps: 10\n'
        b = b'Generated: 2026-01-02\nApps: 10\n'
        self.assertEqual(audit.discovery_body('/apps/llms.txt', a),
                         audit.discovery_body('/apps/llms.txt', b))
        self.assertNotEqual(audit.discovery_body('/llms.txt', a),
                            audit.discovery_body('/llms.txt', b))
        self.assertNotEqual(audit.discovery_body('/apps/llms.txt', a),
                            audit.discovery_body('/apps/llms.txt', b.replace(b'10', b'11')))


if __name__ == '__main__':
    unittest.main()
