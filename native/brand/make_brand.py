#!/usr/bin/env python3
"""DSMO brand art from one geometry: a speech bubble with a D, in the launcher's 108 grid.

    python3 native/brand/make_brand.py

Writes, next to this script:

    icon-512.png                         store / README icon
    res/mipmap-*/ic_launcher*.png        legacy and adaptive-foreground launcher icons (and
                                         dsh-Go's frost / ink / night variants)
    res/drawable/ic_launcher_monochrome.xml   themed-icon silhouette (the D cut out)
    res/drawable/ic_stat_dsh.xml         status-bar icon for every notification (same silhouette;
                                         replaces dsh-Go's, which is its brand glyph, not AGPL)
    masters/glyph-light.svg, glyph-dark.svg, glyph-mono.svg, tile.svg
                                         replacements for dsh-Go's app/assets/brand/ (not AGPL);
                                         native/apply.sh copies them and runs dsh-Go's
                                         app/tool/make_brand_mark.py, so the launch screen,
                                         drawer lockup and About page draw this mark.

dsh-Go's painter draws four layers (body, fin, belly, bubble; the single-colour mark only
body and bubble). Here body is the bubble with a D-shaped hole, fin and belly are the D,
and the bubble layer is the bubble's tail in the body's own gradient: in colour the hole
is filled with a contrasting D, in one colour the D stays cut out.

Needs Pillow for the PNGs.
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
K = 0.5522847498  # quarter circle as one cubic

BLUE_A, BLUE_B = '#6E8BFF', '#364FD9'  # launcher background (ic_launcher_background.xml)
WHITE_A, WHITE_B = '#FFFFFF', '#E4E9FF'
D_A, D_B = '#5B78F5', '#3A52D9'


# ---------------------------------------------------------------- geometry (cubic subpaths)

class Sub:
    """One closed subpath: a start point and absolute cubic segments."""

    def __init__(self, x, y):
        self.start, self.segs, self.cur = (x, y), [], (x, y)

    def line(self, x, y):
        (x0, y0) = self.cur
        self.segs.append(((x0 + (x - x0) / 3, y0 + (y - y0) / 3), (x0 + 2 * (x - x0) / 3, y0 + 2 * (y - y0) / 3), (x, y)))
        self.cur = (x, y)
        return self

    def arc(self, cx, cy, x, y):
        """Quarter circle about (cx, cy) from the current point to (x, y)."""
        (x0, y0) = self.cur
        # tangents are perpendicular to the radii
        t0 = (-(y0 - cy), x0 - cx)
        t1 = (-(y - cy), x - cx)
        # pick the tangent directions that point along the travel
        sgn = 1 if (t0[0] * (x - x0) + t0[1] * (y - y0)) > 0 else -1
        c1 = (x0 + sgn * K * t0[0], y0 + sgn * K * t0[1])
        c2 = (x - sgn * K * t1[0], y - sgn * K * t1[1])
        self.segs.append((c1, c2, (x, y)))
        self.cur = (x, y)
        return self


def bubble():  # clockwise on screen
    return (Sub(42, 32).line(66, 32).arc(66, 44, 78, 44).line(78, 58).arc(66, 58, 66, 70)
            .line(52, 70).line(36, 80).line(42, 70).arc(42, 58, 30, 58).line(30, 44).arc(42, 44, 42, 32))


def tail():
    return Sub(52, 70).line(36, 80).line(42, 70).line(52, 70)


def d_outer():  # counter-clockwise: a hole in the bubble
    return Sub(47, 41).line(47, 61).line(53, 61).arc(53, 51, 63, 51).arc(53, 51, 53, 41).line(47, 41)


def d_counter():  # clockwise: the hole in the D
    return Sub(52, 46).line(53, 46).arc(53, 51, 58, 51).arc(53, 51, 53, 56).line(52, 56).line(52, 46)


def tile():
    r, a, b = 16, 18, 90
    return (Sub(a + r, a).line(b - r, a).arc(b - r, a + r, b, a + r).line(b, b - r).arc(b - r, b - r, b - r, b)
            .line(a + r, b).arc(a + r, b - r, a, b - r).line(a, a + r).arc(a + r, a + r, a + r, a))


BODY = [bubble(), d_outer(), d_counter()]
LETTER = [d_outer(), d_counter()]


def n(v):
    return f'{v:.3f}'.rstrip('0').rstrip('.')


def d_attr(subs):
    out = []
    for s in subs:
        out.append(f'M{n(s.start[0])} {n(s.start[1])}')
        for c1, c2, p in s.segs:
            out.append(f'C{n(c1[0])} {n(c1[1])} {n(c2[0])} {n(c2[1])} {n(p[0])} {n(p[1])}')
        out.append('Z')
    return ''.join(out)


def flatten(subs, steps=24):
    polys = []
    for s in subs:
        pts, cur = [s.start], s.start
        for c1, c2, p in s.segs:
            for i in range(1, steps + 1):
                t = i / steps
                u = 1 - t
                pts.append((u ** 3 * cur[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p[0],
                            u ** 3 * cur[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p[1]))
            cur = p
        polys.append(pts)
    return polys


# ---------------------------------------------------------------- dsh-Go brand masters

def lin(gid, a, b, x1=30, y1=32, x2=78, y2=80):
    return (f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">'
            f'<stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>')


NOTE = ('<!-- DSMO mark: a speech bubble with a D, in the launcher\'s 108 grid. Generated by the DSMO repo\'s '
        'native/brand/make_brand.py; app/tool/make_brand_mark.py turns these files into '
        'app/lib/ui/shell/brand_glyph.g.dart. -->')


def glyph_svg(bubble_a, bubble_b, letter_a, letter_b, mono=False):
    fill = (lambda _: 'currentColor') if mono else (lambda g: f'url(#{g})')
    defs = '' if mono else ('<defs>' + lin('tail', bubble_a, bubble_b) + lin('fin', letter_a, letter_b, 47, 41, 63, 61)
                            + lin('belly', letter_a, letter_b, 47, 41, 63, 61) + lin('bubble', bubble_a, bubble_b) + '</defs>')
    # The single-colour mark is body and bubble only, as dsh-Go's painter draws it.
    letter = '' if mono else (f'<path id="fin-layer" fill="{fill("fin")}" d="{d_attr(LETTER)}"/>'
                              f'<path id="belly-layer" fill="{fill("belly")}" d="{d_attr(LETTER)}"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="30 32 48 48">\n{NOTE}\n{defs}'
            f'<path id="body" fill="{fill("tail")}" d="{d_attr(BODY)}"/>{letter}'
            f'<path id="bubble-layer" fill="{fill("bubble")}" d="{d_attr([tail()])}"/>\n</svg>\n')


def tile_svg():
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72">\n{NOTE}\n<defs>'
            + lin('tile-bg', BLUE_A, BLUE_B, 0, 0, 108, 108) + lin('tail', WHITE_A, WHITE_B) + lin('fin', D_A, D_B, 47, 41, 63, 61)
            + '</defs>'
            f'<path id="tile" fill="url(#tile-bg)" d="{d_attr([tile()])}"/>'
            f'<path id="body" fill="url(#tail)" d="{d_attr(BODY)}"/>'
            f'<path id="fin-layer" fill="url(#fin)" d="{d_attr(LETTER)}"/>\n</svg>\n')


# ---------------------------------------------------------------- PNGs

def gradient(size, a, b):
    """Diagonal linear gradient, top-left a to bottom-right b."""
    ca = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    cb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    g = Image.new('RGBA', (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(ca[i] + (cb[i] - ca[i]) * t) for i in range(3)) + (255,)
    return g


def mask(subs, size, scale, offset=0):
    """Even-odd fill of the subpaths, supersampled 4×."""
    ss = size * 4
    m = Image.new('L', (ss, ss), 0)
    for poly in flatten(subs):
        layer = Image.new('L', (ss, ss), 0)
        ImageDraw.Draw(layer).polygon([((x - offset) * scale * 4, (y - offset) * scale * 4) for x, y in poly], fill=255)
        m = _xor(m, layer)
    return m.resize((size, size), Image.LANCZOS)


def _xor(a, b):
    return Image.frombytes('L', a.size, bytes(x ^ y for x, y in zip(a.tobytes(), b.tobytes())))


def glyph_layer(size, scale, offset=0):
    """White bubble with a blue D, transparent elsewhere."""
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(Image.new('RGBA', (size, size), (255, 255, 255, 255)), (0, 0), mask([bubble()], size, scale, offset))
    out.paste(gradient(size, D_A, D_B), (0, 0), mask(LETTER, size, scale, offset))
    return out


def legacy(size, round_=False):
    """The whole 108 grid on a rounded (or round) gradient square."""
    bg = gradient(size, BLUE_A, BLUE_B)
    shape = Image.new('L', (size * 4, size * 4), 0)
    d = ImageDraw.Draw(shape)
    if round_:
        d.ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    else:
        d.rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=size * 4 * 0.18, fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(bg, (0, 0), shape.resize((size, size), Image.LANCZOS))
    return Image.alpha_composite(out, glyph_layer(size, size / 108))


VARIANTS = ['', '_frost', '_ink', '_night']
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def main():
    masters = os.path.join(HERE, 'masters')
    os.makedirs(masters, exist_ok=True)
    files = {
        'glyph-light.svg': glyph_svg(BLUE_A, BLUE_B, WHITE_A, WHITE_A),
        'glyph-dark.svg': glyph_svg(WHITE_A, WHITE_B, D_A, D_B),
        'glyph-mono.svg': glyph_svg(None, None, None, None, mono=True),
        'tile.svg': tile_svg(),
    }
    for name, text in files.items():
        open(os.path.join(masters, name), 'w', encoding='utf-8').write(text)

    res = os.path.join(HERE, 'res')
    for dens, k in DENSITIES.items():
        d = os.path.join(res, f'mipmap-{dens}')
        os.makedirs(d, exist_ok=True)
        fg = round(108 * k)
        icon, rnd, front = legacy(round(48 * k)), legacy(round(48 * k), round_=True), glyph_layer(fg, fg / 108)
        # dsh-Go's alternate icons (activity aliases) get the same art: theirs is not AGPL.
        for v in VARIANTS:
            icon.save(os.path.join(d, f'ic_launcher{v}.png'))
            rnd.save(os.path.join(d, f'ic_launcher{v}_round.png'))
            front.save(os.path.join(d, f'ic_launcher{v}_foreground.png'))
    legacy(512).save(os.path.join(HERE, 'icon-512.png'))

    open(os.path.join(res, 'drawable', 'ic_launcher_monochrome.xml'), 'w', encoding='utf-8').write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!-- DSMO themed-icon silhouette: the speech bubble with its D cut out (native/brand/make_brand.py). -->\n'
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    android:width="108dp"\n    android:height="108dp"\n'
        '    android:viewportWidth="108"\n    android:viewportHeight="108">\n'
        '    <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd"\n'
        f'        android:pathData="{d_attr(BODY)}" />\n'
        '</vector>\n')
    # Status-bar icon: the same silhouette cropped to the 24dp slot (glyph box 30..78 x 32..80
    # in a 52-unit viewport, so it fills ~22dp). Small icons are drawn from alpha only.
    open(os.path.join(res, 'drawable', 'ic_stat_dsh.xml'), 'w', encoding='utf-8').write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!-- DSMO status-bar icon for all notifications: the launcher silhouette (native/brand/make_brand.py). -->\n'
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    android:width="24dp"\n    android:height="24dp"\n'
        '    android:viewportWidth="52"\n    android:viewportHeight="52">\n'
        '    <group android:translateX="-28" android:translateY="-30">\n'
        '        <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd"\n'
        f'            android:pathData="{d_attr(BODY)}" />\n'
        '    </group>\n'
        '</vector>\n')
    bgx = os.path.join(res, 'drawable', 'ic_launcher_background.xml')
    s = open(bgx, encoding='utf-8').read().replace('API Demo launcher background', 'DSMO launcher background')
    open(bgx, 'w', encoding='utf-8').write(s)
    print('wrote', ', '.join(files), 'and the launcher icons')


if __name__ == '__main__':
    main()
