# Investment Intelligence Platform

개인 포트폴리오 원장, 모바일 거래 기록, 통합 상황실, 시장 분석 및 브라우저 기반 전략 연구실을 제공하는 웹 애플리케이션입니다.

## 로컬 실행 및 검증

Node.js가 설치된 환경에서 다음 명령을 사용합니다.

```powershell
npm run build
npm test
npm run test:visual
npm run test:phase0-prototype
```

정적 화면을 확인하려면 `dist/`를 로컬 HTTP 서버로 제공합니다. API 기능은 Worker 환경 변수와 Supabase 연결이 필요합니다.

## 배포 구성

- Cloudflare Worker 호환 서버 산출물: `dist/server/index.js`
- 정적 자산 번들: `dist/server/assets.js`
- Sites 프로젝트 설정: `.openai/hosting.json`
- 원본 배포는 `npm run build` 후 생성된 동일 커밋을 사용해야 합니다.

필수 런타임 값은 배포 환경에만 저장하며 저장소에 커밋하지 않습니다.

- `DASHBOARD_PASSWORD`
- `SESSION_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PORTFOLIO_USER_ID`

## 데이터와 비용 주의사항

- 기존 Supabase Free 프로젝트 하나를 유지하며 거래·스냅샷·설정을 보존합니다.
- 시장 가격은 서버에서 Yahoo Finance 데이터를 읽으며 호출 실패나 지연을 화면에 표시합니다.
- 연구실 계산과 최대 264개 자동 탐색은 브라우저에서 수행하고 중간 결과를 DB에 저장하지 않습니다.
- 외부 가격 공급처의 호출 한도와 이용 조건은 운영 시 다시 확인해야 합니다.
- Supabase 및 호스팅 무료 사용량은 제공사 정책에 따라 달라질 수 있으므로 정기적으로 확인합니다.

## 연구 결과 한계

- 조정가격에 배당이 반영된 것으로 보고 별도 배당을 더하지 않습니다.
- TWR은 전략 성과, XIRR은 납입 시점 효과를 포함한 개인 수익률로 구분합니다.
- 세후 값은 단순 세율 가정이며 실제 납세액이 아닙니다.
- 과거 유사 시장, 위험점수, 자동 탐색 결과는 투자 권고나 미래 수익 예측이 아닙니다.
