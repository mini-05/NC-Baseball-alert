"""앱 아이콘 PNG를 생성한다.

Pillow 같은 외부 패키지 없이 zlib + struct 만으로 PNG를 직접 인코딩한다.
아이콘은 네이비 배경 위에 골드 야구공(빨간 실밥)을 올린 단순한 도형이라
폰트 렌더링이 필요 없다.

    python scripts/genicons.py
"""

import math
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "public"

# DESIGN.md 의 색 삼원(크림 + 코랄 + 다크)을 그대로 쓴다.
NAVY = (24, 23, 21)     # surface-dark #181715 — 배경
GOLD = (204, 120, 92)   # primary #cc785c — 공 테두리
CREAM = (250, 249, 245) # canvas #faf9f5 — 공 몸통
SEAM = (204, 120, 92)   # primary — 실밥

# 안티에일리어싱용 슈퍼샘플링 배율. 4면 육안으로 계단현상이 보이지 않는다.
SS = 4


def _blend(dst, src, alpha):
    """알파 합성. alpha 는 0.0~1.0."""
    return tuple(round(d + (s - d) * alpha) for d, s in zip(dst, src))


def _write_png(path, width, height, pixels):
    """RGBA 픽셀 배열(list of rows, 각 row는 (r,g,b,a) 튜플 리스트)을 PNG로 저장."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # 필터 타입 0 (None)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def _sample_icon(x, y, size, maskable):
    """좌표 (x, y)에서의 색과 알파를 돌려준다. 슈퍼샘플링 전 단계."""
    cx = cy = size / 2

    # 배경: maskable 은 잘려도 되도록 모서리를 채우고, 일반 아이콘은 둥근 사각형.
    if maskable:
        inside_bg = True
    else:
        radius = size * 0.22
        dx = abs(x - cx) - (size / 2 - radius)
        dy = abs(y - cy) - (size / 2 - radius)
        if dx > 0 and dy > 0:
            inside_bg = math.hypot(dx, dy) <= radius
        else:
            inside_bg = True

    if not inside_bg:
        return (0, 0, 0), 0.0

    # 야구공. maskable 은 바깥 20%가 잘릴 수 있으므로 더 작게 그린다.
    ball_r = size * (0.26 if maskable else 0.32)
    d = math.hypot(x - cx, y - cy)

    if d > ball_r:
        return NAVY, 1.0

    # 공 안쪽: 크림색 바탕 + 골드 테두리
    color = CREAM if d < ball_r * 0.9 else GOLD

    # 실밥: 좌우 대칭인 두 개의 호. 원의 중심에서 벗어난 두 큰 원의 교선으로 만든다.
    seam_center = ball_r * 1.42
    seam_radius = ball_r * 1.30
    seam_width = ball_r * 0.11

    for offset in (-seam_center, seam_center):
        dist = abs(math.hypot(x - (cx + offset), y - cy) - seam_radius)
        if dist < seam_width / 2:
            color = SEAM
            break

    return color, 1.0


def render(size, maskable=False):
    """슈퍼샘플링으로 안티에일리어싱된 RGBA 픽셀 배열을 만든다."""
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            acc_rgb = [0.0, 0.0, 0.0]
            acc_a = 0.0

            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    (r, g, b), a = _sample_icon(x, y, size, maskable)
                    acc_rgb[0] += r * a
                    acc_rgb[1] += g * a
                    acc_rgb[2] += b * a
                    acc_a += a

            n = SS * SS
            if acc_a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append(
                    (
                        round(acc_rgb[0] / acc_a),
                        round(acc_rgb[1] / acc_a),
                        round(acc_rgb[2] / acc_a),
                        round(255 * acc_a / n),
                    )
                )
        rows.append(row)
    return rows


def render_badge(size):
    """Android 알림 배지용. 단색 실루엣만 쓰이므로 흰색 원 + 투명 배경으로 만든다."""
    cx = cy = size / 2
    r = size * 0.42
    rows = []

    for py in range(size):
        row = []
        for px in range(size):
            acc = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    d = math.hypot(px + (sx + 0.5) / SS - cx, py + (sy + 0.5) / SS - cy)
                    # 도넛 모양(공 실루엣)이 배지에서 가장 알아보기 쉽다.
                    if d <= r and d >= r * 0.55:
                        acc += 1
            row.append((255, 255, 255, round(255 * acc / (SS * SS))))
        rows.append(row)
    return rows


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    targets = [
        ("icon-180.png", 180, False),
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
    ]

    for name, size, maskable in targets:
        _write_png(OUT_DIR / name, size, size, render(size, maskable))
        print(f"wrote {name} ({size}x{size})")

    _write_png(OUT_DIR / "badge-96.png", 96, 96, render_badge(96))
    print("wrote badge-96.png (96x96)")


if __name__ == "__main__":
    main()
