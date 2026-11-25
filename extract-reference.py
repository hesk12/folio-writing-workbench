import io
import sys
from zipfile import ZipFile
from xml.etree import ElementTree

source = io.BytesIO(sys.stdin.buffer.read())
if sys.argv[1] == '.pdf':
    from pypdf import PdfReader
    reader = PdfReader(source)
    text = '\n\n'.join(page.extract_text() for page in reader.pages)
else:
    ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    with ZipFile(source) as archive:
        item = archive.getinfo('word/document.xml')
        if item.file_size > 32 * 1024 * 1024:
            raise ValueError('Document too large')
        root = ElementTree.fromstring(archive.read(item))
    text = '\n'.join(''.join(node.text or '' for node in p.iter(ns + 't'))
                     for p in root.iter(ns + 'p'))
sys.stdout.buffer.write(text.encode('utf-8'))
