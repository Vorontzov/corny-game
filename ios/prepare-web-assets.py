#!/usr/bin/env python3
"""Bundle the same published game, with local libraries and the Apple store bridge."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil

ios = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=ios.parent / 'index.html')
parser.add_argument('--destination', type=Path, required=True)
args = parser.parse_args()
source = args.source.resolve()
destination = args.destination.resolve()
destination.mkdir(parents=True, exist_ok=True)
html = source.read_text(encoding='utf-8-sig')

def replace_once(old, new):
    global html
    if html.count(old) != 1:
        raise ValueError('The game integration point changed: ' + old[:100])
    html = html.replace(old, new, 1)

vendor = ios / 'Vendor'
for name, item in json.loads((vendor / 'sources.json').read_text()).items():
    if hashlib.sha256((vendor / name).read_bytes()).hexdigest() != item['sha256']:
        raise ValueError('Bundled dependency checksum mismatch: ' + name)

# Classic local scripts work in WKWebView's file origin without module CORS rules.
three = (vendor / 'three.module.js').read_text(encoding='utf-8')
exports = re.search(r'export\s*\{([^}]+)\};\s*$', three)
if not exports:
    raise ValueError('Three.js export list changed')
properties = []
for item in exports.group(1).split(','):
    pieces = re.split(r'\s+as\s+', item.strip())
    properties.append(json.dumps(pieces[-1]) + ':' + pieces[0])
three = '(function(){\n' + three[:exports.start()] + '\nwindow.THREE={' + ','.join(properties) + '};\n})();'
(destination / 'vendor').mkdir(exist_ok=True)
(destination / 'vendor/three.js').write_text(three, encoding='utf-8')
shutil.copy2(vendor / 'peerjs.min.js', destination / 'vendor/peerjs.min.js')
for name in ['three-LICENSE.txt', 'peerjs-LICENSE.txt', 'VT323-OFL.txt']:
    shutil.copy2(vendor / name, destination / 'vendor' / name)

font = base64.b64encode((vendor / 'VT323-Regular.ttf').read_bytes()).decode('ascii')
html = re.sub(r'<link\b[^>]+href="https://fonts\.(?:googleapis|gstatic)\.com[^>]+>\s*', '', html)
replace_once('</head>', '<style>@font-face{font-family:VT323;font-style:normal;font-weight:400;font-display:swap;src:url(data:font/ttf;base64,' + font + ') format("truetype")}</style>\n</head>')
replace_once('const THREE=await import("https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js");', 'const THREE=window.THREE;')
replace_once('const m=await import("https://cdn.jsdelivr.net/npm/peerjs@1.5.5/+esm"),P=m.Peer||m.default?.Peer||m.default;', 'const P=window.Peer;')
replace_once('<script type="module">', '<script src="vendor/three.js"></script>\n<script src="vendor/peerjs.min.js"></script>\n<script>')

# Web checkout configuration is intentionally absent from the bundled app.
for name in ['winterStoreUrl', 'winterStoreKey']:
    html, count = re.subn(r'(<meta\s+id="' + name + r'"[^>]*\bcontent=")[^"]*(")', r'\1\2', html)
    if count != 1:
        raise ValueError('Store configuration metadata missing: ' + name)

if '/* Corny mobile controls */' not in html:
    replace_once('</head>', '<style>\n' + (ios / 'Bridge/mobile-controls.css').read_text() + '\n</style></head>')
    replace_once('/* Startup and shared animation loop. */', '/* Corny mobile controls */\n' + (ios / 'Bridge/mobile-controls.js').read_text() + '\n/* Startup and shared animation loop. */')
replace_once('/* Startup and shared animation loop. */', (ios / 'Bridge/apple-store.js').read_text() + '\n/* Startup and shared animation loop. */')
replace_once('let libraryOpen=false,unlocked=false', 'let appActive=true,libraryOpen=false,unlocked=false')
replace_once('const allowed=()=>unlocked&&!libraryOpen', 'const allowed=()=>appActive&&unlocked&&!libraryOpen')
replace_once("window.addEventListener('pageshow',()=>sync());", "window.addEventListener('pageshow',()=>sync());\n window.addEventListener('corny-app-background',()=>{appActive=false;music.pause();stopEffects();});\n window.addEventListener('corny-app-active',()=>{appActive=true;sync();});")

match = re.search(r'<script id="corny-audio-assets" type="application/json">(.*?)</script>', html, re.S)
if not match:
    raise ValueError('Game music manifest missing')
tracks = json.loads(match.group(1))
for track in tracks.values():
    relative = Path(track['src'])
    if relative.is_absolute() or relative.parts[0] != 'audio' or '..' in relative.parts:
        raise ValueError('Expected a local game audio file')
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source.parent / relative, target)
(destination / 'index.html').write_text(html, encoding='utf-8')
print('Bundled Corny Game with', len(tracks), 'songs and offline graphics libraries.')
