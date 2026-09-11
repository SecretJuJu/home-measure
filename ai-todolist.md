---
original_request: "압축 파일의 문서를 읽고 시작한다. 배포·커밋은 하지 않으며, 인프라와 웹을 분리한 모노레포와 master push 기반 GitHub Actions 배포 구성을 만든다."
goals:
  - 제공된 제품·UX·아키텍처 명세를 docs/에 보존한다.
  - Cloudflare Worker 단일 배포를 위한 웹·공유 도메인·인프라 모노레포를 만든다.
  - 로컬 우선 MVP와 master 배포 CI를 구현하되, 이 작업 중 실제 배포나 커밋은 하지 않는다.
execution_started: true
current_task: null
created_at: 2026-09-10T00:00:00+09:00
updated_at: 2026-09-10T13:06:00+09:00
---

# Work Plan: HomeMeasure MVP

## Goal

iPad-first HomeMeasure MVP를 Cloudflare Worker 단일 배포 단위로 구현하고, master 브랜치 푸시에서만 검증 후 배포하는 CI를 준비한다.

## Context

- Key files: `home-measure-spec/PRD.md`, `home-measure-spec/UXDR.md`, `home-measure-spec/ARCHITECTURE.md`
- Existing patterns: 기존 애플리케이션 코드와 Git 저장소가 없는 빈 작업 디렉터리
- Constraints: AWS·Cloudflare CLI 명령과 실제 배포를 하지 않는다. 커밋하지 않는다. 문서는 `docs/`에 둔다. production 배포는 GitHub Actions에서 `master` push일 때만 허용한다.

## Tasks

- [x] 1. 명세를 `docs/`로 정리하고, `apps/web`, `packages/domain`, `infra/worker`를 중심으로 한 워크스페이스·기본 CI 골격을 만든다. -> `docs/`, `apps/`, `packages/`, `infra/`, `.github/`
- [x] 2. 공유 도메인 스키마·D1 마이그레이션·Worker API 골격과 인증 경계를 구현한다. -> `packages/domain/`, `infra/worker/`
- [x] 3. IndexedDB 기반 local-first 저장소와 동기화 큐를 구현하고 테스트한다. -> `apps/web/src/`, `packages/domain/`
- [x] 4. 속성·공간 생성과 SVG 평면도 편집(문·창문·설비·문 열림)을 구현하고 geometry 테스트를 추가한다. -> `apps/web/src/features/floor-plan/`
- [x] 5. 공간별 체크리스트, 실측 모드, 완료도·요약 화면을 구현하고 로컬 보존 흐름을 검증한다. -> `apps/web/src/features/`
- [x] 6. 사진 압축·대기열·Worker/R2 업로드 경로를 구현하고 실패 재시도를 검증한다. -> `apps/web/src/features/photo/`, `infra/worker/`
- [x] 7. API 권한·스키마·동기화 테스트와 Playwright 핵심 흐름을 추가하고 lint/typecheck/test/build를 실행한다. -> `apps/web/`, `infra/worker/`
- [x] 8. 명세 감사에서 확인된 P0 편집 공백(집/공간 수정·삭제, 방 치수, 객체 위치 이동, 창문 개폐)을 local-first UI와 테스트로 완료한다. -> `apps/web/src/features/`
- [x] 9. 전체 명세·보안·CI 완료 감사를 실행하고 모든 검증 근거를 기록한다. -> `ai-todolist.md`, `docs/`
- [x] 10. Google OAuth authorize/callback·PKCE/state·D1 session·안전한 cookie 발급 및 테스트를 구현한다. -> `infra/worker/`, `docs/`
- [x] 11. 사진 메모 입력과 요약 화면의 연결 사진 열람 UI를 구현하고 테스트한다. -> `apps/web/src/features/photo/`, `apps/web/src/features/checklist/`
- [x] 12. 요약에 방별 문 폭과 주요 설비 위치를 표시하고 테스트한다. -> `apps/web/src/features/checklist/`

## Verification

- [x] 워크스페이스 설치 및 `lint`, `typecheck`, `test`, `build` 명령이 정의되어 있다.
- [x] CI는 pull request에서 검증만 하고 `master` push에서만 deploy job을 실행한다.
- [x] deploy job은 토큰·계정 ID를 GitHub Secrets로만 참조하며 이 작업에서 실행하지 않는다.

## Open Questions

- [ ] GitHub Actions의 실제 배포 인증 방식(API token 권한 범위, Cloudflare account ID, Worker name)은 저장소 연결 후 Secret으로 설정해야 한다.
- [ ] Google OAuth 클라이언트 ID/secret이 아직 제공되지 않았다. production에서 dev auth가 활성화되지 않도록 별도 설계가 필요하다.

## Execution Notes

- 2026-09-10: `home-measure-spec.zip`을 풀고 PRD, UXDR, 아키텍처와 Terra/Astra 지침을 모두 읽었다.
- 2026-09-10: 작업 디렉터리는 Git 저장소가 아니며 기존 앱 소스가 없다.
- 2026-09-10: 사용자 지시대로 AWS·Cloudflare 명령, 실제 배포, Git 커밋을 수행하지 않는다.
- 2026-09-10: Task 1에서 명세를 `docs/`로 이동하고 pnpm 워크스페이스·Vite 앱·Worker binding 골격·GitHub Actions를 만들었다. `pnpm verify`가 lint, typecheck, test, build를 통과했다.
- 2026-09-10: 최신 TypeScript 7은 설치 시점의 `typescript-eslint` 지원 범위를 벗어나므로 TypeScript 6.0.3으로 고정했다.
- 2026-09-10: Task 7 — Playwright loopback-only smoke flow(집→공간→문→문 폭 실측→reload)를 추가했다. `pnpm verify`가 unit 31개, e2e 1개, lint/typecheck/build를 통과했다. Vitest가 e2e 파일을 수집하지 않도록 `apps/web/vitest.config.ts`에서 제외했다.
- 2026-09-10: 명세 감사에서 UI의 property/room 수정·삭제, room size 변경, object reposition, window opening control 공백을 확인하여 Task 8로 추가했다. API는 이미 property/room delete와 update를 제공한다.
- 2026-09-10: Task 9 audit found remaining product gaps: production Google OAuth/session issuance is absent, and photo note/summary browsing UI is incomplete. Task 9 remains in progress until Tasks 10–11 are complete and the audit is rerun.
- 2026-09-10: Task 2 검증 완료 — 공유 Zod 도메인 스키마, D1 초기 마이그레이션과 idempotent mutation 저장소, Hono API 및 production fail-closed development auth boundary를 구현했다. fake D1 Worker API 테스트와 `pnpm verify`가 통과했다. 실제 배포·AWS/Cloudflare CLI·커밋은 실행하지 않았다.
- 2026-09-10: Task 3 검증 완료 — Dexie 기반 typed local entity store와 single-flush sync queue를 구현했다. shared mutation envelope와 stable clientMutationId를 보존하며, optimistic state→IndexedDB transaction→HTTP 순서, failure retention/retry, reconnect retry, rehydration merge를 fake-indexeddb 테스트로 확인했다. `pnpm verify`가 통과했고 실제 배포·AWS/Cloudflare CLI·커밋은 실행하지 않았다.
- 2026-09-10: Task 4 검증 완료 — local-first 속성·공간 생성, SVG 직사각형 평면도 이동·벽/객체 선택·문/창문/8개 설비 배치와 문 열림 Inspector를 구현했다. geometry 및 jsdom 통합 흐름 테스트와 `pnpm verify`가 통과했다. 실제 배포·AWS/Cloudflare CLI·커밋은 실행하지 않았다.
- 2026-09-10: Task 5 검증 완료 — room type별 required/recommended 기본 checklist, manual item과 평면도 객체 연결, field measurement 저장·다음 항목 이동, completion/missing-only 및 shopping-oriented summary를 구현했다. Dexie reload와 linked canvas/Inspector focus 테스트를 포함해 `pnpm verify`가 통과했다. 실제 배포·AWS/Cloudflare CLI·커밋은 실행하지 않았다.
- 2026-09-10: Task 6 검증 완료 — 최대 1920px WebP/JPEG 사진 압축, context-bound 첨부 UI, IndexedDB Blob cache, metadata-first/R2-second retry queue와 Worker의 MIME·크기·ownership·idempotent R2 upload를 구현했다. fake-R2 Worker tests와 photo compression/retry tests를 추가했고 `pnpm verify`가 통과했다. 실제 배포·AWS/Cloudflare CLI·커밋은 실행하지 않았다.
- 2026-09-10: Task 8 검증 완료 — 집 이름·주소·메모 수정 및 확인형 집/공간 삭제 UI를 추가했다. 삭제는 관련 IndexedDB 엔터티와 이전 대기 작업을 정리하고 안정적인 DELETE tombstone만 남긴다. 방 치수 변경은 문/창문/설비를 새 경계 안으로 보정하며, Pointer Events로 문·창문·설비를 합법 범위 안에서 이동한다. 창문 Inspector에 개폐 방식을 추가했다. `pnpm verify`가 domain 3, web 28, worker 7, Playwright 1을 포함해 통과했다. 실제 배포·AWS/Cloudflare CLI·커밋은 실행하지 않았다.
- 2026-09-10: Task 9 감사 진행 — `pnpm verify` 재실행은 domain 3, web 28, worker 7, Playwright 1을 포함해 통과했다. 다만 production OAuth 로그인·callback·세션 발급이 구현되지 않아 production 사용자가 인증 세션을 만들 수 없고, 사진 메모 입력/요약 사진 표시도 없다. 따라서 Task 9와 전체 완료 checklist는 미완료로 유지한다. 근거와 추가 공백은 `docs/COMPLETION_AUDIT.md`에 기록했다.
- 2026-09-10: Task 10 — Google OAuth authorization-code + PKCE S256/nonce/state와 D1 single-use transaction, JWKS RS256 ID token verification, opaque D1 session 및 secure cookie/logout을 구현했다. Worker crypto/fake Google JWKS 11개 tests를 포함해 `pnpm verify`가 통과했다. 실제 배포·AWS/Cloudflare CLI·커밋은 실행하지 않았다.
- 2026-09-10: Task 11 — 실측 항목의 사진 첨부 전에 4,000자 제한 사진 메모를 입력해 context-bound metadata envelope로 저장하도록 했다. 요약은 로컬 Blob만 미리보기로 쓰고, 공간·체크리스트·업로드 상태·메모를 표시하는 상세 overlay를 제공한다. `pnpm verify`가 domain 3, web 31, worker 11, Playwright 1을 포함해 통과했다. 실제 배포·AWS/Cloudflare CLI·커밋은 실행하지 않았다.

- 2026-09-10: Task 9 재감사 — Task 10 OAuth와 Task 11 사진 공백은 근거·테스트로 해소됐다. 하지만 P0 Summary가 요구하는 문 폭과 주요 설비 위치를 `PropertySummary`가 표시하지 않는다. 따라서 Task 9는 `[>]`로 유지하고 전체 completion checklist는 완료 처리하지 않는다. 최신 `pnpm verify`는 domain 3, web 31, worker 11, Playwright 1을 포함해 통과했다.

- 2026-09-10: Task 9 최종 감사 — Task 12가 P0 Summary의 방별 문 폭과 주요 설비 위치를 구현·테스트해 기존 공백을 해소했다. `pnpm verify` 최종 실행은 domain 3, web 32, worker 11, Playwright 1과 lint/typecheck/build를 통과했다. 모든 scoped task와 정적 CI/secret 검증 근거가 충족되어 Task 9 및 completion checklist를 완료 처리했다. 실제 배포·AWS/Cloudflare CLI·커밋은 수행하지 않았다.

## Completion Checklist

- [x] Scoped tasks complete
- [x] Verification passes
- [x] No scope creep
- [x] Follow-up items separated


## UI/UX refinement — 2026-09-10

목표: canvas 중심의 절제된 iPad 현장 편집기. 기존 기능·도메인·인프라 보존. 실제 배포, AWS/Cloudflare CLI, 커밋 금지.

- [x] UI1. 작은 CSS 토큰 체계와 화면 높이에 맞는 편집기 shell, 공간 진행률, 선택 강조, 컴팩트 Inspector, 체크리스트 상태, contextual quick-add, tablet slide-over 및 phone 현장 탐색을 구현한다. 소유: `apps/web/src/styles.css`, `features/floor-plan/FloorPlanEditor.tsx`, `features/checklist/{ChecklistPanel,HomeMeasureWorkspace}.tsx` 및 관련 테스트. 수용: 1024+ 3-pane / 768–1023 slide-over / phone checklist 중심, 44px controls, canvas geometry·저장 계약 보존, web lint/typecheck/unit 통과.
- [x] UI2. 실측 모드의 VisualViewport 대응과 고정 저장/다음 영역, 실용적 Summary, 사진 context/status/detail 접근성을 개선한다. 소유: `features/checklist/{MeasurementMode,PropertySummary}.tsx`, `features/photo/{PhotoCaptureControl,PhotoReferenceBrowser}.tsx`, UI helper 및 관련 CSS/테스트. 수용: 짧은 화면에서도 입력·저장 접근, 숫자/완료/queue 로직 보존, 사진 overlay 닫기·초점 복귀, 관련 테스트 통과.
- [>] UI3. Playwright로 iPad landscape·짧은 viewport·tablet·phone, empty/offline/syncing/upload failure, touch targets/overflow를 검증하고 필요한 UI 수정 후 `pnpm verify` 및 시각 QA 근거를 기록한다. 소유: `apps/web/e2e/`, scoped UI 수정, `artifacts/ui-ux/`, `docs/UI_UX_REFINEMENT.md`. 수용: 기존 E2E와 전체 verify 성공, screenshot 실제 확인, 실기기 미검증 범위 명시.

### UI Execution Notes
- 수정 전 지정 문서·기존 CSS/컴포넌트를 확인. 레포에 AGENTS.md/.claude/.harness/.git은 존재하지 않음. 전역 사용자 지침 적용.
- baseline Playwright 1194×834: 문서 높이 1151px. `artifacts/ui-ux/before-editor.png`. 집 정보 폼·Inspector 누적 높이와 canvas min-height가 문제.
- 토큰: neutral ink/surface/line, blue accent, amber missing, green complete, red failure. 기능 상태를 문자와 함께 표시.

- 2026-09-11 09:13 UI1: CSS 토큰(중립 surface/ink/line, blue 선택, amber 누락, green 완료, red 실패)을 기존 모든 화면 색에 적용했다. 100dvh shell/독립 panel scroll, 접힌 집 정보, 방 진행도, 방 치수, 객체 선택/44px 투명 hit 영역, 하단 일반 도구+설비 확장 구현. 1024+ 3-pane, 768–1023 닫기/Escape/초점 trap/복귀를 가진 Inspector overlay, phone은 공간 select와 Checklist/평면도/요약 navigation 제공.
- UI1 최소 UI 로직 수정: SVG getScreenCTM 역변환으로 화면 letterbox를 포함해 pointer 좌표를 환산한다(geometry 계산/저장값 보존). Inspector는 drag pointerdown에서 열지 않고 명시적 버튼으로 연다. 데스크톱 breakpoint 복귀 시 modal/inert 해제. checklist active row는 연결 객체가 여러 항목을 공유해도 하나만 선택한다. sync 문구는 online event + 기존 sync/queue/dirty state로 표시한다.
- UI1 검증: web lint/typecheck 성공, 9 files/33 unit tests 성공. 기존 property 수정 테스트는 details를 열도록 보강. Inspector Escape/초점 복귀와 동일 객체를 연결한 checklist의 단일 current row 회귀 검증 추가. 부모 독립 browser QA에서 1194×834 문서 높이 834, CTM 실제 벽 click 문 생성, tablet Inspector Escape, phone checklist CTA 확인. 전체 verify/전체 visual state QA는 UI3에서 수행.
- UI1 범위 밖: measurement keyboard viewport, Summary 정보 구조와 photo detail focus는 UI2에 남겼다. UI1에서는 CSS 공통 토큰 적용만 했다. AWS/Cloudflare 명령·배포·커밋 없음.

- 2026-09-11 UI2: 위임 executor 사용량 제한 재발로 부모가 직접 이어 구현/검증했다. VisualViewport height/offsetTop + compact 상태, scroll body와 하단 액션 분리, 저장 중 중복 탭 차단, 사진 context/detail portal 및 Escape/focus/inert, Summary 우선순위/축별 치수/필수 미측정 목록 적용. 저장/완료/geometry 알고리즘 보존. web lint/typecheck와 unit 35개 통과. 1024×400 screenshot에서 숫자 입력 y=138–202, 저장 버튼 y=344–392로 겹침 없음, 저장 후 다음 항목 이동 확인.
- 사용자 추가 승인: 일반 데이터·사진 HTTP 클라이언트의 기본 fetch를 arrow wrapper로 호출하도록 수정. 기존 `this.fetcher()` native receiver 오류로 네트워크 요청 전 Illegal invocation이 발생했음. API 계약·큐·idempotent mutation 내용 변경 없음. UI3에서 실제 request와 실패/재시도 검증.
