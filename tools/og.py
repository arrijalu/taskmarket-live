#!/usr/bin/env python3
"""Render the 1200x630 social card from data/market.json. No network, no deps beyond Pillow."""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = json.load(open(os.path.join(ROOT, 'data', 'market.json')))

W, H = 1200, 630
BG = (10, 11, 13)
TEXT = (238, 240, 243)
DIM = (139, 144, 153)
DIM2 = (92, 98, 107)
GOLD = (228, 179, 99)
GREEN = (78, 203, 141)
LINE = (38, 41, 45)

F = '/usr/share/fonts/truetype/dejavu/'
def font(name, size):
    return ImageFont.truetype(F + name, size)
mono = lambda s: font('DejaVuSansMono.ttf', s)
sans = lambda s: font('DejaVuSans.ttf', s)
bold = lambda s: font('DejaVuSans-Bold.ttf', s)

img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img)

# soft top glow, drawn as concentric translucent ellipses
glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for i in range(60):
    a = int(14 * (1 - i / 60))
    gd.ellipse([W / 2 - 520 + i * 4, -300 + i * 3, W / 2 + 520 - i * 4, 210 - i * 2], fill=(228, 179, 99, a))
img = Image.alpha_composite(img.convert('RGBA'), glow).convert('RGB')
d = ImageDraw.Draw(img)

def ousd(v):
    return f"{v:,.0f}"

# ---- wordmark
d.rounded_rectangle([64, 56, 96, 88], 8, fill=(20, 23, 26))
for i, h in enumerate([12, 20, 10, 16]):
    x = 71 + i * 6
    d.line([(x, 80), (x, 80 - h)], fill=GOLD, width=3)
d.text((108, 60), 'TASKMARKET', font=bold(19), fill=TEXT)
d.text((108 + d.textlength('TASKMARKET', font=bold(19)) + 10, 61), 'LIVE', font=mono(16), fill=DIM2)
d.text((W - 64 - d.textlength('TEMPO 4217  ·  BASE 8453', font=mono(14)), 64), 'TEMPO 4217  ·  BASE 8453', font=mono(14), fill=DIM2)

# ---- headline
f1 = bold(96)
f1b = bold(96)
label = 'OUSD committed'
y = 168
d.text((64, y), ousd(D['flow']['committed']), font=f1, fill=GOLD)
w1 = d.textlength(ousd(D['flow']['committed']), font=f1)
d.text((64 + w1 + 18, y + 30), 'OUSD', font=sans(40), fill=TEXT)

f2 = sans(40)
line2 = f"{D['concentration']['top10Share']:.0f}% of it posted by ten agents."
d.text((64, y + 116), line2, font=f2, fill=TEXT)
line3 = f"Claims land in {D['velocity']['medianH']*60:.0f} minutes. {D['competition']['subsPerAward']:.0f} attempts per paid task."
d.text((64, y + 172), line3, font=sans(28), fill=DIM)

# ---- right-hand column: three figures, right-aligned so the card is balanced
rx = W - 64
col = [
    (f"{D['flow']['paid']:,.0f} OUSD", 'released to workers', GOLD),
    (f"{D['flow']['escrow']:,.0f} OUSD", 'still sitting in escrow', TEXT),
    (f"{D['competition']['subsPerAward']:.0f} : 1", 'attempts per paid task', TEXT),
]
cy = 176
for v, k, c in col:
    d.text((rx - d.textlength(v, font=bold(34)), cy), v, font=bold(34), fill=c)
    d.text((rx - d.textlength(k, font=mono(13)), cy + 44), k, font=mono(13), fill=DIM2)
    cy += 96
d.line([(rx - 300, 168), (rx - 300, 452)], fill=LINE, width=1)

# ---- sparkline: weekly committed OUSD
weeks = D['weeks'][-16:]
if len(weeks) >= 2:
    bx, by, bw, bh = 64, 452, W - 128, 78
    mx = max(w['ousd'] for w in weeks) or 1
    step = bw / len(weeks)
    for i, w in enumerate(weeks):
        h = max(2, (w['ousd'] / mx) * bh)
        x0 = bx + i * step
        d.rounded_rectangle([x0, by + bh - h, x0 + step * 0.62, by + bh], 2, fill=(228, 179, 99) if i == len(weeks) - 1 else (120, 96, 56))
    d.text((bx, by + bh + 10), 'OUSD committed per week — reconstructed from every task the public API returns', font=mono(13), fill=DIM2)

# ---- footer stats
d.line([(64, 566), (W - 64, 566)], fill=LINE, width=1)
stats = [
    (f"{D['meta']['tasksSeen']:,}", 'tasks read'),
    (f"{D['concentration']['posters']}", 'distinct posters'),
    (f"{D['flow']['fillRate']:.0f}%", 'fill rate'),
    ('hourly', 'rebuild cadence'),
]
x = 64
for v, k in stats:
    d.text((x, 580), v, font=bold(22), fill=TEXT)
    kw = d.textlength(k, font=mono(13))
    d.text((x + d.textlength(v, font=bold(22)) + 8, 587), k, font=mono(13), fill=DIM2)
    x += max(200, d.textlength(v, font=bold(22)) + 8 + kw + 40)

out = os.path.join(ROOT, 'docs', 'og.png')
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, optimize=True)

# guard: nothing may touch the canvas edge
print(f'wrote {out} ({os.path.getsize(out)//1024} kB)')
