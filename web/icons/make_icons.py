"""Regenerate the PNG app icons (pure stdlib): python3 make_icons.py"""
import math, struct, zlib
from pathlib import Path

BG, FG, ACCENT = (15, 118, 110), (255, 255, 255), (253, 224, 71)


def pixel(x, y, maskable):
    # x, y in [0,1). Rounded square (full bleed for maskable), radar rings + dot.
    r = 0.0 if maskable else 0.22
    dx, dy = max(abs(x - .5) - (.5 - r), 0), max(abs(y - .5) - (.5 - r), 0)
    if not maskable and math.hypot(dx, dy) > r:
        return None
    s = 0.72 if maskable else 1.0          # keep art inside the maskable safe zone
    d = math.hypot(x - .5, y - .5) / s
    if d < 0.085:
        return ACCENT
    if 0.17 < d < 0.23 or 0.30 < d < 0.36:
        return FG
    return BG


def png(size, maskable, path, ss=4):
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        for px in range(size):
            acc, n = [0, 0, 0, 0], ss * ss
            for sy in range(ss):
                for sx in range(ss):
                    c = pixel((px + (sx + .5) / ss) / size, (py + (sy + .5) / ss) / size, maskable)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            a = acc[3] // n
            cov = acc[3] // 255 or 1
            rows += bytes([acc[0] // cov, acc[1] // cov, acc[2] // cov, a])
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


here = Path(__file__).parent
png(192, False, here / "icon-192.png")
png(512, False, here / "icon-512.png")
png(512, True, here / "maskable-512.png")
png(180, True, here / "apple-touch-icon.png")   # iOS rounds corners itself
