# HomeMeasure Specs

이 폴더는 HomeMeasure MVP 개발용 문서 세트입니다.

## Files

- `PRD.md` — 제품 요구사항
- `UXDR.md` — iPad-first UI/UX 설계
- `ARCHITECTURE.md` — Cloudflare Workers + D1 + R2 기반 기술 구조
- `CODEX_TERRA_PROMPT.md` — Terra에게 로직/구현을 맡길 때 사용하는 프롬프트
- `CODEX_ASTRA_PROMPT.md` — Astra에게 시각/UX 개선을 맡길 때 사용하는 프롬프트

## Recommended Workflow

1. 저장소에 `docs/`를 만들고 PRD/UXDR/ARCHITECTURE를 넣습니다.
2. Terra에게 `CODEX_TERRA_PROMPT.md`를 전달해 functional MVP를 구현합니다.
3. Terra 구현이 끝난 뒤 Astra에게 `CODEX_ASTRA_PROMPT.md`를 전달합니다.
4. Astra는 데이터 모델/동기화/API 구조를 가급적 건드리지 않고 UI/UX를 개선합니다.

## Suggested Repository Placement

```text
home-measure/
├ docs/
│  ├ PRD.md
│  ├ UXDR.md
│  └ ARCHITECTURE.md
├ CODEX_TERRA_PROMPT.md
└ CODEX_ASTRA_PROMPT.md
```
