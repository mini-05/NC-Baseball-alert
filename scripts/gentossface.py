"""Tossface SVG 아이콘에서 인라인 스프라이트를 만든다.

토스페이스 이모지 폰트 전체는 12MB, 필요한 서브셋만 골라도 4MB에 달한다.
같은 저작물의 SVG 판을 쓰면 아이콘 5개가 8KB 안쪽으로 끝나므로 SVG 쪽을 택했다.

    python scripts/gentossface.py <tossface 저장소 경로> [출력파일]

생성된 스프라이트를 public/index.html 의 <svg class="sprite"> 블록에 넣는다.
출력파일을 생략하면 scripts/tossface-sprite.svg 에 쓴다.
"""

import re
import sys
from pathlib import Path

# 알림 종류 → Tossface 코드포인트
ICONS = {
    "start": ("u26BE", "야구공 — 경기 시작"),
    "score": ("u1F525", "불꽃 — 득점"),
    "cancel": ("u1F327", "비 — 우천 취소"),
    "end": ("u1F3C1", "체커기 — 경기 종료"),
    "post": ("u1F3C6", "트로피 — 포스트시즌"),
}


def extract(svg_text):
    """<svg> 껍데기와 여백용 <rect>를 벗겨 내부 도형만 남긴다."""
    inner = re.sub(r"^.*?<svg[^>]*>", "", svg_text, flags=re.S)
    inner = re.sub(r"</svg>\s*$", "", inner, flags=re.S)
    # 40x40 투명 사각형은 자리맞춤용이라 symbol 안에서는 불필요하다.
    inner = re.sub(r'<rect\s+width="40"\s+height="40"\s+fill="none"\s*/>', "", inner)
    # id 충돌을 막기 위해 원본의 id 속성을 제거한다.
    inner = re.sub(r'\s+id="[^"]*"', "", inner)
    return inner.strip()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    svg_dir = Path(sys.argv[1]) / "dist" / "svg"
    if not svg_dir.is_dir():
        print(f"SVG 디렉터리를 찾을 수 없습니다: {svg_dir}")
        sys.exit(1)

    parts = []
    total = 0

    for name, (code, note) in ICONS.items():
        path = svg_dir / f"{code}.svg"
        if not path.exists():
            print(f"없음: {path}")
            continue

        body = extract(path.read_text(encoding="utf-8"))
        total += len(body)
        parts.append(f'  <!-- {note} -->\n  <symbol id="tf-{name}" viewBox="0 0 40 40">{body}</symbol>')

    # Windows 콘솔 기본 인코딩(cp949)으로는 한글 주석을 쓸 수 없어 파일로 직접 쓴다.
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).parent / "tossface-sprite.svg"
    out.write_text("\n".join(parts) + "\n", encoding="utf-8")

    print(f"wrote {out.name} ({total:,} bytes of path data, {len(parts)} symbols)")


if __name__ == "__main__":
    main()
