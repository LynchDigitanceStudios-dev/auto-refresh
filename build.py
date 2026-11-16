"""Build the Auto Refresh landing page + extension zip.

Reads the original snapshot markup (site-source.html), inlines styles.css and
app.js so the page can never break on a missing asset again, and packs the
extension folder into the .zip the download buttons point at.

Everything the live site needs lands in dist/ — that is the folder you drag
onto Netlify. Nothing else in here gets deployed.
"""
import json
import os
import re
import shutil
import sys
import zipfile

# Where the site lives. Pass a different origin to move it, e.g.
#   python build.py https://some-other-domain.example
# That rewrites the update-check URL inside the extension too, so the two can
# never disagree.
SITE_URL = 'https://autorefresh.lynchdigitancestudios.workers.dev'
if len(sys.argv) > 1:
    SITE_URL = sys.argv[1].rstrip('/')

ROOT = os.path.dirname(os.path.abspath(__file__))
p = lambda *a: os.path.join(ROOT, *a)

# Keep the extension's update-check URL in step with SITE_URL before zipping (popup + background).
for _name in ('popup.js', 'background.js'):
    _file = p('extension', _name)
    _src = open(_file, encoding='utf-8').read()
    _new = re.sub(r"const VERSION_URL = '[^']*';",
                  "const VERSION_URL = '" + SITE_URL + "/version.json';", _src)
    if _new != _src:
        open(_file, 'w', encoding='utf-8').write(_new)
        print('repointed update check in', _name, '->', SITE_URL + '/version.json')

# HOLD_RELEASE=1 rebuilds the SITE only and keeps the already-published zip and version.json exactly as they
# are in dist/. Use it while the next extension version is still being built, so a site/server deploy never
# tells users about (or hands out) a half-finished version. Without it, everything is rebuilt as before.
HOLD = os.environ.get('HOLD_RELEASE') == '1'

DIST = p('dist')
kept = {}
if HOLD:
    for _n in ('lynch-digitance-auto-refresh.zip', 'version.json'):
        _f = os.path.join(DIST, _n)
        assert os.path.exists(_f), 'HOLD_RELEASE needs ' + _n + ' already in dist/'
        kept[_n] = open(_f, 'rb').read()
    print('HOLD_RELEASE: keeping the published zip and version.json')
# Clear the contents rather than the folder itself: a running preview server
# holds a handle on the directory, which would make rmtree fail on Windows.
os.makedirs(DIST, exist_ok=True)
for name in os.listdir(DIST):
    target = os.path.join(DIST, name)
    shutil.rmtree(target, ignore_errors=True) if os.path.isdir(target) else os.remove(target)
d = lambda *a: os.path.join(DIST, *a)


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


# ---------- 1. extension zip ----------
zip_path = d('lynch-digitance-auto-refresh.zip')
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
    for folder, _, files in ([] if HOLD else os.walk(p('extension'))):
        for name in files:
            full = os.path.join(folder, name)
            # files sit at the ROOT of the zip. A wrapper folder inside it made every unzip
            # produce a folder inside a folder (the unzip tool names one after the zip, then
            # the zip supplies its own), and "Load unpacked" on the outer one fails.
            arc = os.path.relpath(full, p('extension'))
            z.write(full, arc.replace('\\', '/'))
if HOLD:
    open(zip_path, 'wb').write(kept['lynch-digitance-auto-refresh.zip'])
zip_kb = round(os.path.getsize(zip_path) / 1024)
print('zip:', zip_path, zip_kb, 'KB')

# ---------- 2. self-contained index.html ----------
html = read(p('site-source.html'))
css = read(p('styles.css'))
js = read(p('app.js'))

html = html.replace(
    '<link rel="stylesheet" href="styles.css" />',
    '<style>\n' + css + '\n</style>')
html = html.replace(
    '<script src="app.js"></script>',
    '<script>\n' + js + '\n</script>')

# stray trailing script after </html> in the snapshot -> move inside <body>
tail = re.search(r'</html>\s*(<script>.*?</script>)\s*$', html, re.S)
if tail:
    html = html.replace(tail.group(1), '')
    html = html.replace('</body>', tail.group(1) + '\n</body>', 1)
html = re.sub(r'\s*</html>\s*$', '\n</html>\n', html)

# keep the advertised download size honest
html = re.sub(r'\.zip · \d+ KB', '.zip · %d KB' % zip_kb, html)

with open(d('index.html'), 'w', encoding='utf-8') as f:
    f.write(html)

for tag in ('<link rel="stylesheet"', '<script src='):
    assert tag not in html, 'external asset still referenced: ' + tag
print('index.html:', round(len(html) / 1024), 'KB, fully self-contained')

# ---------- 3. remaining deploy assets ----------
shutil.copy(p('icon128.png'), d('icon128.png'))

# version.json — what the extension's "Check for updates" button reads.
# Generated from the manifest so it can never drift out of sync.
manifest = json.load(open(p('extension', 'manifest.json'), encoding='utf-8'))
with open(d('version.json'), 'w', encoding='utf-8') as f:
    json.dump({
        'version': manifest['version'],
        'downloadUrl': SITE_URL + '/lynch-digitance-auto-refresh.zip',
        # one short line shown in the "new version is out" alert; edit release-note.txt before each release
        'notes': read(p('release-note.txt')).strip() if os.path.exists(p('release-note.txt')) else '',
        'notesUrl': SITE_URL + '/#update'
    }, f, indent=2)
print('version.json:', manifest['version'])
if HOLD:
    open(d('version.json'), 'wb').write(kept['version.json'])
    print('HOLD_RELEASE: version.json left exactly as published')

# Netlify serves .zip as octet-stream by default; make the download explicit
# and stop it from trying to compress an already-compressed file.
with open(d('_headers'), 'w', encoding='utf-8') as f:
    f.write('/lynch-digitance-auto-refresh.zip\n'
            '  Content-Type: application/zip\n'
            '  Content-Disposition: attachment; '
            'filename="lynch-digitance-auto-refresh.zip"\n'
            '\n'
            # The extension fetches this from a chrome-extension:// origin, so
            # it needs CORS or the update check fails silently. Never cache it,
            # otherwise users keep seeing an old version number.
            '/version.json\n'
            '  Content-Type: application/json\n'
            '  Access-Control-Allow-Origin: *\n'
            '  Cache-Control: no-store, max-age=0\n')

print('\ndist/ ready to upload (Netlify or Cloudflare Pages):')
for name in sorted(os.listdir(DIST)):
    print('  %-38s %6d KB' % (name, round(os.path.getsize(d(name)) / 1024)))
