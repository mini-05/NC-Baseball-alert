# 배포 자동화

`main` 에 push(=PR merge)되면 `.github/workflows/deploy.yml` 이 테스트 후
`wrangler deploy` 를 자동 실행한다. Cloudflare 인증은 GitHub의
**Environment secret**(`production`)로 넘긴다 — 저장소 전체 Secret이 아니다.
이유: 저장소 Secret은 모든 브랜치의 워크플로가 읽을 수 있어 main 브랜치
보호를 우회당하지만, Environment secret은 특정 브랜치로 접근을 제한할 수
있다.

## 토큰 만료 시 갱신 절차

### 1. Cloudflare에서 새 토큰 발급

1. https://dash.cloudflare.com/profile/api-tokens → **Create Token**
2. **"Start from scratch"** (템플릿은 권한이 이 프로젝트가 쓰는 것보다 넓다)
3. **Permission policies** → 검색창에 하나씩 입력해 추가:
   - `Workers Scripts` → **Edit**
   - `D1` → **Edit**
   - (Read를 따로 추가할 필요 없음 — Edit이 Read를 포함한다)
4. **Account Resources**: 본인 계정 하나만 선택 (All accounts 금지)
5. **Token expiration**: **1 year** (No expiration 금지 — 유출 시 무기한 유효해짐)
6. **Client IP address filtering**: 비워둠 (GitHub Actions 러너 IP는 매번 바뀜)
7. **Review token** → 권한이 `Workers Scripts Write`, `D1 Write` 두 줄만 있는지 확인 → **Create Token**
8. 뜬 화면에서 **큰 텍스트 박스 안의 값**을 복사한다. 옆에 별도로 뜨는
   "Token ID"(짧은 UUID)는 다른 값이니 착각하지 않는다 — 이 착각이
   실제로 3연속 배포 실패의 원인이었다(2026-08-25).

### 2. Account ID 확인

Cloudflare 대시보드 아무 페이지에서 **주소창의 URL**을 본다.

```
https://dash.cloudflare.com/1a2b3c4d5e6f7g8h9i0j.../workers-and-pages
                            └──────────┬──────────┘
                                 Account ID (32자리 16진수)
```

계정을 바꾼 적 없다면 이 값은 안 바뀐다 — 토큰만 갱신하면 되는 경우가 대부분.

### 3. GitHub Environment secret 갱신

⚠️ **"Settings → Secrets and variables"가 아니다.** 그 메뉴에서 추가하면
Repository secret이 되어 모든 브랜치가 접근 가능해진다.

1. 저장소 → **Settings → Environments** (왼쪽 사이드바, "Secrets and
   variables" 밑이 아니라 별도 항목)
2. **production** 클릭
3. **Environment secrets** 섹션에서 `CLOUDFLARE_API_TOKEN` 옆 연필 아이콘
   → 새 값 붙여넣기 → Update
4. Account ID가 바뀐 경우만 `CLOUDFLARE_ACCOUNT_ID` 도 같은 방식으로 갱신
5. **Deployment branches and tags**가 `Selected branches` → `main`으로
   되어 있는지 함께 확인 (풀려 있으면 다시 좁힌다)

### 4. 확인

Actions 탭 → 가장 최근 실패한 "Deploy" 워크플로 → **Re-run failed jobs**.
`deploy` job이 성공하면 끝.

## 배포가 "Authentication error [code: 10000]"로 실패할 때

값을 재입력해도 반복되면, 재입력이 아니라 **Cloudflare API로 토큰 자체를
직접 검증**하는 게 빠르다. `deploy` job의 `wrangler deploy` 스텝 앞에
아래를 임시로 넣고 실행해보면, 로그에 원인이 그대로 나온다(토큰 값은
출력에 안 남으니 안전하다).

```yaml
- name: "[진단] 토큰·계정 검증"
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  run: |
    curl -s "https://api.cloudflare.com/client/v4/user/tokens/verify" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    curl -s "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
```

`/user/tokens/verify`가 `"success":false`면 **토큰 자체가 무효** — 재발급
필요 (Token ID를 잘못 복사했을 가능성이 가장 크다). 그게 `true`인데
`/accounts/{id}`만 실패하면 **Account ID가 틀렸거나 그 계정에 이 토큰의
접근 권한이 없음**. 원인 확인 후 이 스텝은 지운다.
