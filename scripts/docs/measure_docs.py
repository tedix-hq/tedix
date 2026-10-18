import json
import pathlib
import re
import sys

TERMS = re.compile(r'\b(?:ai\s+(?:workers?|coworkers?)|ingress|stubs?|workers?|rpc|orpc|d1|schemas?|governance)\b', re.I)

def measure(text):
    text = re.sub(r'\A---\s*\n.*?\n---\s*(?:\n|$)', '', text, flags=re.S)
    lines, fence = [], None
    for line in text.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            if fence is None:
                fence = marker.group(1)[0]
            elif marker.group(1)[0] == fence:
                fence = None
            continue
        if fence is None:
            lines.append(line)
    text = '\n'.join(lines)
    text = re.sub(r'`+[^`]*`+', '', text)
    text = re.sub(r'!?\[[^\]]*\]\([^\n]*?\)', '', text)
    text = re.sub(r'^\s*\[[^\]]+\]:.*$', '', text, flags=re.M)
    text = re.sub(r'https?://\S+|<[^>]+>', '', text)
    text = re.sub(r'^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)', '', text, flags=re.M)
    text = re.sub(r'[*_~|]', '', text)
    paragraphs = re.split(r'\n\s*\n', text)
    sentences = [s.strip() for p in paragraphs for s in re.split(r'(?<=[.!?])\s+', ' '.join(p.split())) if re.search(r'\w', s)]
    counts = [len(re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", s)) for s in sentences]
    jargon = [m.group(0) for m in TERMS.finditer(text)] + re.findall(r'\bDO\b', text)
    return {'jargon': len(jargon), 'terms': jargon, 'sentences': len(counts), 'words': sum(counts), 'averageWords': round(sum(counts)/len(counts), 2) if counts else 0, 'over25Percent': round(100*sum(n > 25 for n in counts)/len(counts), 2) if counts else 0}

if __name__ == '__main__':
    for argument in sys.argv[1:]:
        path = pathlib.Path(argument)
        files = sorted(path.rglob('*.md')) if path.is_dir() else [path]
        rows = [{'path': str(p), **measure(p.read_text())} for p in files if p.name != 'support.md']
        for row in sorted(rows, key=lambda r: (-r['jargon'], -r['over25Percent'], r['path'])):
            print(json.dumps(row))
