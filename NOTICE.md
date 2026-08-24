# 사용한 외부 저작물

## Tossface

이모지 아이콘(야구공 · 불꽃 · 비 · 체커기 · 트로피)은 토스 팀이 만든 이모지 서체
**Tossface**의 SVG 판입니다.

- 저작권: © Viva Republica, Inc. — Reserved Font Name "Tossface"
- 출처: https://github.com/toss/tossface
- 라이선스 전문: https://toss.im/tossface/copyright

폰트 전체(12MB)나 필요한 서브셋(약 4MB)을 싣는 대신, 같은 저작물의 SVG 아이콘 5개를
`<symbol>`로 변환해 `public/index.html`에 인라인했습니다(약 7KB).
변환 스크립트는 `scripts/gentossface.py`이며, 도형 데이터는 원본 그대로이고
`<svg>` 껍데기와 자리맞춤용 투명 사각형만 제거했습니다.

## es-hangul

한국어 조사 처리(`을/를`, `와/과`, `이/가`)에 **es-hangul**을 사용합니다.

- 저작권: © Viva Republica, Inc.
- 라이선스: MIT
- 출처: https://github.com/toss/es-hangul

직접 만든 받침 판별 함수를 대체했습니다. es-hangul은 영문 약어를 한글 발음으로 읽어
조사를 고르므로(`KT` → `케이티` → `와`) KBO 팀명을 예외 처리할 필요가 없습니다.

## Pretendard

본문 한글 서체.

- 저작권: © Kil Hyung-jin
- 라이선스: SIL Open Font License 1.1
- 출처: https://github.com/orioncactus/pretendard

## Cormorant Garamond · Inter · Noto Serif KR

Google Fonts를 통해 불러옵니다. 모두 SIL Open Font License 1.1입니다.
`DESIGN.md`가 지정한 Copernicus·StyreneB가 비공개 서체라, 문서가 명시한 대체재로 사용합니다.

## 디자인 시스템

`DESIGN.md`는 [awesome-design-md](https://github.com/VoltAgent/awesome-design-md)의
Claude 디자인 분석 문서를 그대로 가져온 것입니다 (MIT).
색상은 이 문서의 구조를 유지하되 강조색을 NC 다이노스 공식 색으로 교체했습니다.

## 경기 데이터

네이버 스포츠의 공개 엔드포인트에서 조회합니다. 공식 API가 아니며 상업적 이용을
전제하지 않습니다. 개인 용도로만 사용하세요.
