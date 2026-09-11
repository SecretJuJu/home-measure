# HomeMeasure

이사·입주 전 현장 실측을 위한 iPad-first 웹 애플리케이션입니다.

## Repository layout

```text
apps/web/          React + Vite 클라이언트
packages/domain/   클라이언트와 Worker가 공유하는 도메인 타입·스키마
infra/worker/      Cloudflare Worker, D1/R2 binding, 데이터 마이그레이션
docs/              제품·UX·아키텍처·배포 문서
```

## Local development

```sh
pnpm install
pnpm dev
```

`pnpm verify`는 lint, typecheck, test, build를 순서대로 실행합니다.

실제 배포는 이 작업에서 수행하지 않습니다. 배포 준비 절차는 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)를 확인하세요.
