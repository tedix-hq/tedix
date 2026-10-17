import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'audit', Path(__file__).with_name('audit-cutover.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditTest(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
