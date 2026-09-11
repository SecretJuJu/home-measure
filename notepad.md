# Execution Started: 2026-09-10T13:07:25+09:00

## Project constraints

- 실제 배포, AWS·Cloudflare CLI 실행, Git 커밋을 하지 않는다.
- `master` push에서만 GitHub Actions deploy job이 실행되도록 유지한다.
- Cloudflare 인증 값은 GitHub Secrets/Variables 또는 Worker secrets에만 둔다.
- TypeScript는 `typescript-eslint` 호환을 위해 6.0.3으로 고정했다.

## Current layout

- `apps/web`: Vite + React client
- `packages/domain`: client/Worker shared schemas and types
- `infra/worker`: Worker source, bindings, migrations

[2026-09-10 13:21] - 공유 도메인 스키마·D1 마이그레이션·Worker API 골격과 인증 경계

### DISCOVERED ISSUES
- D1의 `properties.user_id`와 기타 도메인 테이블은 `users` 외래 키를 사용하므로, 개발 전용 인증이 `users` 행을 보장하지 않으면 첫 로컬 쓰기가 외래 키 제약에서 실패한다.
- `Fetcher`는 `fetch` 외에 `connect`를 요구하는 Cloudflare 타입이므로, 단순 local fake를 직접 `Fetcher`로 단언하면 Worker 테스트 typecheck가 실패한다.

### DECISIONS
- 모든 엔터티와 재시도 가능한 쓰기에 8–128자 stable client ID/client mutation ID를 요구하고, `idempotent_mutations`에 사용자별 응답을 저장한다.
- 평면도는 version 1의 직사각형 `position`/`size`와 room-local door/window/utility 배열로 저장한다. 문·창문은 연결된 벽 길이 안에 들어와야 하고, 요소 ID는 방 안에서 유일해야 한다.
- 모든 `/api/*` 도메인 경로는 세션 또는 명시적 development 경계로 인증한다. development 경계는 `ENVIRONMENT=development`와 유효한 두 `DEV_AUTH_*` 값이 모두 있을 때만 활성화되고, production과 미설정 환경에서는 무시된다.
- development 경계는 외래 키를 만족시키기 위해 provider `development`의 고정 user를 `INSERT OR IGNORE`한다. 세션·패스워드·OAuth credential은 만들지 않는다.
- Worker는 generic 오류 코드만 반환하고 요청 본문·인증 정보·내부 오류를 로그에 남기지 않는다. 모든 D1 값은 bound parameter로 전달한다.

### FAILED APPROACHES
- test fake `ASSETS` 객체를 바로 `Fetcher`로 단언하려 했으나 `connect` 메서드가 누락되어 TypeScript가 거부했다. 테스트 경계에서만 `unknown as Fetcher`로 변환했다.

### LEARNINGS
- 관련 검증: `pnpm --filter @home-measure/domain test`, `pnpm --filter @home-measure/worker test`, `pnpm verify`.
- `infra/worker/src/index.test.ts`는 Wrangler 없이 Hono `app.fetch`와 fake D1 bindings로 public health, 미인증 거부, production에서 dev-auth 무시, 타인 property 404, 요청 스키마 검증을 확인한다.
- OAuth 연결 전 로컬 경계와 production fail-closed 동작은 `docs/DEVELOPMENT_AUTH.md`가 source of truth다.

### NEXT TASK TIPS
- Task 3의 IndexedDB sync queue는 `packages/domain`의 `{ clientMutationId, data }` envelope를 그대로 전송하고, 같은 mutation ID로 재시도해야 한다.
- 새 domain write API를 추가할 때는 owner check, stable ID validation, parameterized D1 statement, idempotent mutation 저장을 함께 적용한다.
- 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.

[2026-09-10 13:27] - IndexedDB 기반 local-first 저장소와 동기화 큐

### DISCOVERED ISSUES
- Dexie는 자동 증가(`++`) 인덱스를 primary key에만 허용한다. clientMutationId를 primary key로 유지하면서 별도 자동 증가 인덱스를 사용하면 schema 생성이 실패한다.
- `exactOptionalPropertyTypes` 환경에서는 Zustand 상태의 `undefined` 가능한 오류 값과 Dexie에 저장하는 cleared mutation ID를 명시적으로 `| undefined`로 모델링해야 한다.

### DECISIONS
- `HomeMeasureDatabase`는 property, room, checklist item, measurement, photo metadata, queued operation을 별도 테이블로 저장한다. 사진 table에는 R2 key·mime·크기·참조 metadata만 있어 blob/base64를 저장하지 않는다.
- operation은 shared `{ clientMutationId, data }` envelope를 `body`에 그대로 저장하고, API client가 재시도 시 같은 객체 내용을 `/api` 상대 경로로 전송한다. queue primary key는 clientMutationId이고, 생성 순서는 단일 Dexie read/write transaction에서 수동으로 부여하는 monotonic `sequence`으로 보존한다.
- Zustand 상태는 즉시 dirty entity를 반영한다. entity와 queue operation이 IndexedDB transaction에 보존된 뒤에만 flush를 시작하고, HTTP 성공 뒤 최신 mutation ID가 일치하는 entity만 dirty를 해제한다. 실패한 operation은 attempts/error를 갱신한 채 보존한다.
- repository는 동시에 하나의 flush Promise만 유지하며, browser `online` 이벤트에서 안전하게 다시 flush한다. rehydrate는 메모리에 있는 더 최신 dirty entity를 덮어쓰지 않는다.

### FAILED APPROACHES
- operations table에서 `++sequence`을 secondary index로 정의했으나 Dexie `SchemaError: Only primary key can be marked as autoIncrement (++)`가 발생했다. clientMutationId idempotency를 훼손하지 않기 위해 sequence를 transaction 내에서 직접 계산하도록 바꿨다.

### LEARNINGS
- local-first 구현: `apps/web/src/local/{entities,database,api-client,local-first-store}.ts`; public exports는 `apps/web/src/local/index.ts`다.
- `fake-indexeddb`를 web devDependency로 추가했고 `local-first-store.test.ts`는 optimistic persist, offline measurement retained/retry, dirty in-memory edit를 보존하는 rehydration을 검증한다.
- 검증 통과: `pnpm --filter @home-measure/web test`, `pnpm --filter @home-measure/web typecheck`, `pnpm --filter @home-measure/web lint`, `pnpm verify` (domain 3, worker 4, web 3 tests 포함).

### NEXT TASK TIPS
- Task 4/5 UI는 `LocalFirstRepository.persistOptimisticChange`에 도메인 mutation envelope를 전달해 사용한다. envelope의 clientMutationId를 매 retry마다 새로 만들면 idempotency가 깨진다.
- 현재 delete tombstone/사진 blob upload는 이 task 범위에 포함하지 않았다. Task 6에서는 photo metadata operation을 유지한 채 blob을 별도 local cache 및 R2 upload queue로 다뤄야 한다.
- 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.

[2026-09-10 13:38] - 속성·공간 생성과 SVG 평면도 편집(문·창문·설비·문 열림)

### DISCOVERED ISSUES
- Web 패키지에는 DOM 기반 컴포넌트 테스트 런타임이 없어서 실제 생성·선택·문 열림 제어 흐름을 검증할 수 없었다.
- 브라우저 수동 화면 확인은 macOS가 잠겨 있어 수행하지 못했다. 자동화가 아닌 `pnpm verify`와 jsdom 통합 테스트로 검증했다.

### DECISIONS
- 직사각형만 허용하는 domain layout을 그대로 유지하고, `geometry.ts`에 SVG 좌표 변환·벽의 시계방향 세그먼트·벽 투영·경계 보정·문 swing arc 계산을 React 밖으로 분리했다.
- 문은 벽을 시계방향으로 따라 `left`를 시작점, `right`를 끝점으로 정의한다. 두 경첩과 안쪽/바깥쪽 네 조합은 모두 서로 다른 sweep 및 arc 끝점을 만들며, north/east/south/west 벽에서 일관되게 동작한다.
- 속성·공간·레이아웃 수정은 `LocalFirstRepository.persistOptimisticChange`로만 저장한다. 새 UI 동작은 한 번 생성한 mutation envelope를 queue가 그대로 보존·재시도하므로 서버가 아직 없어도 IndexedDB에서 사용 가능하다.
- iPad landscape에서는 좌측 공간 목록·가운데 SVG·우측 Inspector와 하단 quick-add를 사용하고, 모든 주요 버튼과 입력은 44px 이상으로 구성했다.
- 실제 생성/선택/편집 검증을 위해 web devDependency에 Testing Library, user-event, jsdom을 추가했다.

### FAILED APPROACHES
- 새로 만든 문이 Optimistic 저장 직후에는 SVG에 먼저 나타나고 Inspector 선택 state는 async 저장 완료 뒤 갱신된다. 통합 테스트에서 객체 존재만 즉시 확인하면 Inspector 제어를 찾지 못했으므로 Inspector 버튼을 `findByRole`로 기다리도록 했다.

### LEARNINGS
- `apps/web/src/features/floor-plan/geometry.test.ts`는 모든 문 경첩·열림 조합, wall overflow 보정, corner 밖 wall targeting, client→SVG 좌표 변환, room origin clamp, viewBox 경계를 검증한다.
- `FloorPlanEditor.test.tsx`는 IndexedDB를 이용해 속성 생성 → 공간 생성/선택/이름 수정 → 벽 클릭으로 문 배치 → 바깥 열림 arc 변경을 확인한다.
- 검증 통과: `pnpm --filter @home-measure/web test -- --run src/features/floor-plan/FloorPlanEditor.test.tsx`, `pnpm --filter @home-measure/web lint`, `pnpm --filter @home-measure/web typecheck`, `pnpm --filter @home-measure/web build`, `pnpm verify` (domain 3, worker 4, web 13 tests).

### NEXT TASK TIPS
- Task 5 checklist/실측 화면은 현재 room의 `layout.doors/windows/utilities` ID를 checklist `elementId`로 연결하고, 클릭 시 FloorPlanEditor 선택과 Inspector field focus로 이어야 한다.
- Task 6 사진 메타데이터는 이 task의 room/element selection context를 사용하되, blob을 layout 또는 Dexie sync entity에 넣지 않는다.
- 새 layout mutation은 `PUT /rooms/:id/layout`과 동일한 shared `{ clientMutationId, data: layout }` envelope를 사용해야 한다. 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.

[2026-09-10 13:52] - 공간별 체크리스트, 실측 모드, 완료도·요약 화면

### DISCOVERED ISSUES
- 평면도 편집기가 자체 `LocalFirstRepository`와 내부 선택 상태를 소유하고 있어, 별도 체크리스트 화면을 붙이면 같은 IndexedDB 상태를 보지 못하고 객체 선택도 전달할 수 없었다.
- 실측 모드가 항상 가장 최근 property를 사용하면, 사용자가 property 선택 목록에서 다른 집을 고른 경우 해당 방의 체크리스트를 찾지 못한다.
- 기존 Task 4에서 이미 생성되어 IndexedDB에 남아 있는 공간은 새 공간 생성 callback만으로 기본 체크리스트를 받지 못한다.

### DECISIONS
- `HomeMeasureWorkspace`가 단일 repository를 소유하고 FloorPlanEditor, ChecklistPanel, MeasurementMode, PropertySummary에 주입한다. 모든 checklist/measurement write는 `persistOptimisticChange`에 stable mutation envelope를 한 번만 만들어 전달한다.
- `FloorPlanEditor`에 좁은 controlled selection/callback과 inspector supplement API를 추가했다. 체크리스트 행은 `elementId`로 문·창문·설비를 선택하고 active canvas state와 Inspector input focus를 같이 갱신한다.
- room type별 기본 항목은 required/recommended 및 category를 포함한 정의로 생성한다. 새 room callback과 rehydrate 후 checklist가 전혀 없는 기존 room 보정이 같은 room ID guard를 공유하여 중복 생성하지 않는다.
- 실측 저장은 measurement를 먼저 local-first 저장한 뒤 checklist를 `complete`와 measurement ID로 local-first 저장한다. 숫자는 1–100,000 정수 mm만 허용하며, 다음 pending 항목으로 이동한다. skip은 `skipped`로 보존한다.
- Summary는 방의 layout 치수, 기록된 냉장고/세탁기 공간, 최소 통과 폭, 필수 누락, photo metadata 참조만 표시해 쇼핑/배치 판단용으로 유지한다.

### FAILED APPROACHES
- Summary의 정규식 capture group을 바로 Map key로 쓰려 했지만 `noUncheckedIndexedAccess`가 `string | undefined`를 허용하지 않아 typecheck가 실패했다. capture group 존재를 명시적으로 검사하도록 수정했다.

### LEARNINGS
- 구현 위치: `apps/web/src/features/checklist/{definitions,completion,ChecklistPanel,MeasurementMode,PropertySummary,HomeMeasureWorkspace}.ts(x)`; App은 workspace를 시작점으로 사용한다.
- linked checklist 테스트는 preloaded Dexie room/door를 사용해 checklist click → `.door-drawing.selected` → `문 폭 밀리미터` input focus를 확인한다.
- 검증 통과: `pnpm --filter @home-measure/web typecheck`, `lint`, `test` (5 files/17 tests), `build`, `pnpm verify` (domain 3, worker 4, web 17 tests). 실제 배포·AWS/Cloudflare CLI·커밋은 실행하지 않았다.

### NEXT TASK TIPS
- Task 6은 MeasurementMode의 `사진 첨부` 버튼이 이미 제공하는 property/room/checklist/element context를 사용해 blob cache, 압축, upload queue를 추가한다. 현재는 photo metadata reference를 읽기만 하며 blob/base64를 저장하지 않는다.
- photo metadata write도 `persistOptimisticChange`의 stable `{ clientMutationId, data }` envelope를 유지하고, 업로드 실패가 checklist/measurement local state를 덮어쓰지 않게 한다.
- FloorPlanEditor의 external repository는 owning workspace가 dispose한다. 독립 렌더 시에만 editor가 repository를 dispose한다. 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.

[2026-09-10 14:02] - 사진 압축·대기열·Worker/R2 업로드 경로와 실패 재시도

### DISCOVERED ISSUES
- 기존 사진 메타데이터 테이블은 D1 행이 생성된 사실과 R2 바이너리가 저장된 사실을 구분하지 못했다. 메타데이터 POST만 성공하면 UI가 업로드 완료처럼 보일 위험이 있었다.
- R2와 D1은 하나의 트랜잭션으로 묶을 수 없으므로 R2 성공 뒤 D1 상태 기록이 실패할 수 있다.
- 기존 Worker fake는 속성만 모사하여 binary R2 write, 소유권, idempotency 상태를 검증할 수 없었다.

### DECISIONS
- 사진 Blob은 `photoBlobs` IndexedDB 테이블에만 저장하고, `photoMetadata`/동기화 mutation JSON에는 Blob·base64를 넣지 않는다. Blob은 Worker가 R2/D1 성공을 응답한 뒤에만 삭제한다.
- 클라이언트는 최대 1920px으로 축소하고 WebP를 우선 인코딩하며 지원하지 않을 때 JPEG를 쓴다. 원본은 24MiB, Worker 전송 본문은 실제/선언 크기 모두 12MiB 이하로 제한한다.
- D1 사진 행은 `pending`으로 생성하며 `/api/photos/:id/upload`만 R2 put 뒤 `uploaded`로 전환한다. R2 후 D1 실패는 같은 deterministic key를 다시 put하는 안전한 재시도로 복구한다.
- 업로드는 별도 stable `x-client-mutation-id`로 idempotency result를 보관한다. Worker는 MIME·크기·사진/속성 소유권·metadata MIME 일치를 확인하고, R2 key를 property/photo/mime으로 제한한다.
- 사진 삭제는 R2 object를 먼저 삭제하고 D1 metadata를 삭제한다. D1 단계가 실패하면 같은 key의 R2 delete를 재시도해도 안전하다.

### FAILED APPROACHES
- Worker fake R2의 optional `R2PutOptions`를 `undefined`로 명시해 저장하려 했지만 `exactOptionalPropertyTypes`가 거부했다. options가 있을 때만 속성을 넣도록 수정했다.
- R2 HTTP metadata는 `Headers | R2HTTPMetadata` union이므로 테스트에서 `contentType`을 바로 읽을 수 없었다. Headers 여부를 먼저 분기했다.

### LEARNINGS
- 구현 위치: `apps/web/src/features/photo/`, `apps/web/src/local/{database,entities,local-first-store}.ts`, `infra/worker/src/index.ts`, `infra/worker/migrations/0002_photo_upload_state.sql`.
- 관련 focused 검증: `pnpm --filter @home-measure/web test -- --run src/features/photo`, `pnpm --filter @home-measure/worker test`.
- 전체 검증: `pnpm verify` 통과 (domain 3, web 21, worker 7 테스트; lint/typecheck/build 포함).

### NEXT TASK TIPS
- Task 7의 API/Playwright 검증은 photo metadata가 `pending`일 수 있고 local upload status가 `uploaded`가 되기 전에는 완료로 간주하면 안 된다.
- Worker upload는 request body나 auth/photo 정보를 로그로 남기지 않는다. 새 사진 API를 추가하면 이 generic error, ownership, parameterized D1 규칙을 유지한다.
- 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.

[2026-09-10 16:32] - P0 편집 공백(집/공간 수정·삭제, 방 치수, 객체 위치 이동, 창문 개폐)

### DISCOVERED ISSUES
- 기존 local-first 저장소는 생성·수정 entity만 optimistic하게 저장할 수 있어, 삭제 시 이전 오프라인 write를 지우고 안정적인 DELETE 요청 하나를 남기는 경로가 없었다.
- SVG 요소의 `setPointerCapture`는 실제 브라우저에는 있지만 jsdom SVG 구현에는 없으므로, 테스트 환경에서 무조건 호출하면 포인터 이동 흐름이 중단된다.

### DECISIONS
- `persistOptimisticDeletion`은 property/room과 연결된 checklist·measurement·photo metadata 및 이전 대기 작업을 IndexedDB 트랜잭션에서 제거한 뒤, 동일한 `clientMutationId`의 DELETE tombstone을 큐에 보존한다.
- 방 치수 변경은 `resizeRoom`에서 모든 door/window offset·width와 utility position을 새 직사각형 경계로 보정한다. 객체 이동은 room drag를 바꾸지 않고 별도 Pointer Event drag state로 처리한다.
- 집과 공간 삭제에는 native confirmation을 요구하고, 집 정보는 이름·주소·메모를 하나의 local-first PATCH mutation으로 저장한다.

### FAILED APPROACHES
- repository dispose 시 Dexie 연결을 즉시 닫으려 했으나 진행 중인 best-effort flush가 `DatabaseClosedError`로 거부됐다. dispose는 기존처럼 reconnect listener만 해제해야 한다.

### LEARNINGS
- 구현 위치: `apps/web/src/features/floor-plan/{FloorPlanEditor,geometry}.ts(x)`, `apps/web/src/local/{entities,local-first-store,index}.ts`.
- `FloorPlanEditor.test.tsx`는 property 수정/확인형 삭제, room 치수와 확인형 삭제, door/window/utility Pointer Event drag, window opening control을 확인한다. `local-first-store.test.ts`는 local cleanup과 DELETE tombstone envelope를 확인한다.
- 전체 검증: `pnpm verify` 통과 — domain 3, web 28, worker 7 unit tests 및 Playwright 1개, lint/typecheck/build 포함.

### NEXT TASK TIPS
- Task 9 감사에서는 GitHub Actions deploy job이 `master` push에서만 실행되고 인증 값이 secrets/variables로만 참조되는지 파일 기준으로 확인한다.
- 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.

[2026-09-10 16:35] - 전체 명세·보안·CI 완료 감사

### DISCOVERED ISSUES
- production Worker는 유효한 D1 session cookie를 검증하지만 Google OAuth 시작·callback·session 생성·secure cookie 발급 경로가 없다. production에서 개발용 인증은 fail-closed라 정상 사용자가 API 세션을 만들 수 없다.
- `photos.note` 스키마와 metadata pipeline은 존재하지만 사진 첨부 UI에 메모 입력이 없다.
- Summary는 사진 수/연결 context만 보여주고 사진을 열람하지 않는다.
- 전체 verify 첫 실행에서 `FloorPlanEditor`의 IndexedDB cleanup 타이밍으로 test 1건이 간헐 실패했지만, 동일 suite와 이어진 전체 `pnpm verify` 재실행은 모두 통과했다.

### DECISIONS
- production authentication은 보안 경계가 있어도 사용자가 세션을 만들 수 없으므로 P0/아키텍처 미충족으로 판정했다. Task 9 체크박스와 전체 완료 checklist를 미완료로 유지했다.
- 사진 메모와 Summary 사진 표시도 PRD Photos/Summary 요구사항의 미충족으로 분리 기록했다.

### FAILED APPROACHES
- 없음. 감사 범위이므로 애플리케이션 코드를 수정하거나 OAuth/배포 설정을 추측해 추가하지 않았다.

### LEARNINGS
- 감사 근거 전체는 `docs/COMPLETION_AUDIT.md`에 있다.
- 2026-09-10 16:35 KST `pnpm verify` 성공: domain 3, web 28, worker 7 unit tests와 Playwright 1, lint/typecheck/build.
- `.github/workflows/ci.yml`은 PR 검증만 수행하고 `master` push에서 verify 성공 뒤에만 Cloudflare deploy action을 실행한다. token/account ID는 GitHub Secrets이고 D1 ID는 GitHub Variable이다.

### NEXT TASK TIPS
- 다음 코드 작업은 OAuth authorize/callback, opaque D1 session 생성, `HttpOnly; Secure; SameSite=Lax` cookie 발급/검증 테스트를 먼저 완성해야 한다.
- 이어서 사진 메모 input과 Summary photo preview/열람을 local IndexedDB cache 및 R2-uploaded 상태에 맞춰 구현·테스트한다.
- IndexedDB test cleanup이 다시 간헐 실패하면 실행 중인 repository/Dexie connection을 명시적으로 dispose/close하는 test teardown을 점검한다.

[2026-09-10 16:46] - Google OAuth authorize/callback·PKCE/state·D1 session·안전한 cookie 발급 및 테스트

### DISCOVERED ISSUES
- 기존 production Worker는 D1 session을 읽기만 하고 OAuth authorization-code 흐름, 세션 생성, logout 경로가 없어 정상 사용자가 production API 세션을 만들 수 없었다.
- Google ID token을 payload decode만으로 신뢰하면 서명 위조와 issuer/audience 혼동을 막을 수 없으므로, JWKS RSA 공개키를 실제 Web Crypto로 검증해야 했다.

### DECISIONS
- OAuth transaction은 D1의 `oauth_transactions`에 SHA-256 state hash, PKCE verifier, nonce, 만료, 사용 시각을 저장한다. callback은 conditional `UPDATE ... used_at IS NULL`의 `meta.changes`로 먼저 단회 claim하여 replay를 차단한다.
- state·nonce·session은 각각 256-bit CSPRNG 값, PKCE verifier는 512-bit CSPRNG 값이다. 브라우저 URL에는 opaque state와 challenge만 있으며 verifier·nonce는 D1에만 남는다.
- ID token은 Google JWKS의 matching RSA key로 RS256 signature를 검증한 뒤 issuer, audience/authorized party, 시간 claims, nonce, subject, verified email을 검사한다. 성공 후에는 opaque D1 session만 만들며 provider token은 저장하지 않는다.
- session cookie는 `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`이고, logout은 D1 row를 지우고 `Max-Age=0`으로 같은 cookie를 만료한다. OAuth configuration이 없거나 형식이 틀리면 OAuth endpoints만 503 fail-closed다.

### FAILED APPROACHES
- Workers 타입의 `Uint8Array<ArrayBufferLike>`를 Web Crypto verify에 직접 넘기면 최신 TypeScript가 `BufferSource` 호환 문제로 거부했다. 검증 전용으로 명시적 `ArrayBuffer` copy를 만들어 해결했다.
- OAuth fake가 map의 첫 transaction을 반환해 만료 state test가 이전 transaction을 수정했다. `latestOAuthTransaction`이 마지막 삽입 transaction을 반환하도록 바꿔 실제 callback state를 검증했다.

### LEARNINGS
- 구현: `infra/worker/src/index.ts`, migration `infra/worker/migrations/0003_google_oauth_transactions.sql`, tests `infra/worker/src/index.test.ts`, docs `docs/GOOGLE_OAUTH.md`, `docs/DEVELOPMENT_AUTH.md`, `docs/DEPLOYMENT.md`.
- Worker tests는 실제 Web Crypto RSA key로 서명한 JWT와 injected fake token/JWKS fetch를 사용하여 PKCE redirect, CSRF mismatch, invalid issuer/signature rejection, secure session cookie, `/api/me`, logout invalidation을 확인한다.
- `pnpm verify` 통과: domain 3, web 28, worker 11 unit tests와 Playwright 1, lint/typecheck/build.

### NEXT TASK TIPS
- Task 11은 사진 note를 `PhotoCaptureControl`의 create metadata context에 넣고, Summary는 Blob cache/R2 uploaded 상태를 구분해 열람 UI를 추가해야 한다.
- Task 9 최종 감사 시 OAuth docs와 migration까지 포함해 production auth 생성 경로가 실제 Worker test에서 검증되는지 재확인한다.
- 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.

[2026-09-10 16:53] - 사진 메모 입력과 요약 화면의 연결 사진 열람 UI

### DISCOVERED ISSUES
- 사진 metadata에 `note` 필드는 있었지만 첨부 화면에서 입력할 방법이 없어 항상 null로 저장됐다.
- 요약은 사진 개수와 참조 종류만 표시해 사진이 어느 공간·체크리스트에서 만들어졌는지, 기기에서 미리볼 수 있는지 확인할 수 없었다.
- R2 key를 브라우저 URL로 직접 만들면 인증·권한·만료 URL 경계를 우회할 수 있으므로 로컬 미리보기 source로 사용하면 안 된다.

### DECISIONS
- 사진 첨부 control은 active property/room/checklist context와 함께 4,000자 제한 메모를 queue에 넘긴다. queue도 trim 후 같은 한도를 다시 검증해 UI 밖 호출이 invalid metadata envelope를 만들지 못하게 했다.
- Summary는 property 범위의 사진을 시간순으로 정리하고 room, checklist label, upload status, note를 카드와 detail overlay에 표시한다.
- 미리보기는 IndexedDB `photoBlobs`의 `URL.createObjectURL`만 사용한다. 업로드 뒤 Blob이 정리되면 placeholder와 연결 metadata만 표시하며 R2 key를 클라이언트 URL로 추측하지 않는다.

### FAILED APPROACHES
- 신규 UI 테스트에서 jest-dom matcher(`toHaveAttribute`, `toHaveValue`)를 사용했지만 이 Vitest 설정에는 해당 matcher extension이 없어 실패했다. 표준 DOM property와 `getAttribute` assertion으로 바꿨다.

### LEARNINGS
- 구현: `apps/web/src/features/photo/{PhotoCaptureControl,PhotoReferenceBrowser,photo-upload-queue}.ts(x)`, `apps/web/src/features/checklist/PropertySummary.tsx`, `apps/web/src/styles.css`.
- 새 테스트는 UI의 note/context enqueue, queue metadata envelope note persistence 및 max 4,000 validation, summary local Blob preview/detail context를 다룬다.
- 전체 검증: `pnpm verify` 성공 — domain 3, web 31, worker 11 unit tests와 Playwright 1, lint/typecheck/build.

### NEXT TASK TIPS
- Task 9 최종 감사에서 Task 10 OAuth와 Task 11 photo 흐름을 포함해 completion audit를 다시 실행하고, 검사 범위별 근거를 갱신한다.
- 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.

[2026-09-10 17:02] - 요약에 방별 문 폭과 주요 설비 위치 표시

### DISCOVERED ISSUES
- `PropertySummary`는 방 크기와 checklist 기반 가전 공간만 표시하고, room-local `layout.doors`와 `layout.utilities`를 읽지 않아 PRD Summary의 문 폭·주요 설비 위치를 확인할 수 없었다.
- `pnpm --filter @home-measure/web test -- PropertySummary.test.tsx`는 package script의 인자 전달 방식상 web 전체 test suite를 실행했다. 그 첫 실행에서는 기존 `FloorPlanEditor` pointer-event test가 IndexedDB 삭제 타이밍으로 1회 실패했으며, 새 Summary test는 통과했다.

### DECISIONS
- Summary의 별도 `문과 주요 설비` 섹션에서 모든 방을 카드로 표시한다. 각 문에는 방 안의 순번·붙은 벽·폭을, 각 설비에는 한국어 설비명과 저장된 room-local x × y mm 좌표를 표시한다.
- 빈 배열인 방도 `기록된 문 없음`과 `기록된 주요 설비 없음`을 표시해, 미기록을 다른 방의 데이터 누락으로 오해하지 않게 했다.
- 사진 브라우저 및 기존 summary 데이터 경로는 변경하지 않았고, 기존 사진 열람 테스트를 유지했다.

### FAILED APPROACHES
- package script에 파일명을 추가해 focused test를 실행하려 했지만 전체 suite가 실행되어 기존 비결정적 FloorPlanEditor test failure를 함께 관찰했다. `pnpm --filter @home-measure/web exec vitest run src/features/checklist/PropertySummary.test.tsx`로 정확히 대상 파일을 검증했다.

### LEARNINGS
- 구현·테스트: `apps/web/src/features/checklist/PropertySummary.tsx`, `apps/web/src/features/checklist/PropertySummary.test.tsx`, `apps/web/src/styles.css`.
- 관련 검증: focused Summary test 2개, web lint/typecheck, `pnpm verify` 성공. 전체는 domain 3, web 32, worker 11 unit tests 및 Playwright 1개와 lint/typecheck/build를 통과했다.
- `layout.utilities[].position`은 floor-plan 전체가 아닌 room-local mm 좌표이며, Summary가 표시할 때도 변환하지 않고 그대로 표시해야 Inspector와 같은 수치를 보여준다.

### NEXT TASK TIPS
- Task 9 최종 감사에서 P0 Summary는 방 치수, 문 폭, 가전 설치 공간, 최소 통과 폭, 주요 설비 위치, 사진을 모두 파일과 테스트 근거로 다시 대조한다.
- 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.

[2026-09-10 16:56] - 전체 명세·보안·CI 완료 재감사

### DISCOVERED ISSUES
- Task 10으로 OAuth authorization-code/PKCE/state/JWKS/session cookie가, Task 11로 사진 메모와 Summary 사진 열람이 구현됐지만, `PropertySummary`는 `room.layout.doors`와 `room.layout.utilities`를 읽지 않는다.
- 따라서 PRD P0 Summary의 문 폭과 주요 설비 위치가 Summary 화면에 없다.

### DECISIONS
- P0 Summary 공백이 남아 있으므로 Task 9는 `[>]`로 유지했다. `Verification passes`만 최신 성공 실행에 맞춰 `[x]`로 기록하고, 전체 완료 checklist는 미완료로 유지했다.

### FAILED APPROACHES
- 없음. 감사 범위이므로 발견한 Summary 공백을 구현하지 않았다.

### LEARNINGS
- 최신 `pnpm verify` 성공: domain 3, web 31, worker 11 unit tests와 Playwright 1, lint/typecheck/build.
- OAuth Worker tests는 PKCE S256, state 단회 소비, signed JWKS RS256 token claim 검증, secure cookie 발급·logout invalidation을 확인한다.
- 사진 tests는 note envelope와 local Blob Summary preview/detail context를 확인한다.

### NEXT TASK TIPS
- 다음 구현 task는 `PropertySummary`에 room별 문 폭과 utility type·room-local 좌표를 표시하고, 이 P0 data가 local state에서 Summary까지 전달되는 테스트를 추가해야 한다.
- 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.

[2026-09-10 17:04] - 전체 명세·보안·CI 최종 감사

### DISCOVERED ISSUES
- 없음. Task 12가 `PropertySummary`에서 room-local door width와 utility type/좌표를 표시하고 populated/empty room test로 이전 P0 Summary 공백을 해소했다.

### DECISIONS
- 모든 scoped P0 및 아키텍처 요구사항이 코드·테스트·CI 설정 근거로 확인되어 Task 9와 Completion Checklist를 `[x]`로 처리했다.
- 실제 Cloudflare 계정/Secret 설정과 배포는 코드 공백으로 분류하지 않았다. 사용자 지시상 보류된 운영 작업이며 `docs/DEPLOYMENT.md`, `docs/GOOGLE_OAUTH.md`에 분리돼 있다.

### FAILED APPROACHES
- 없음. 감사 범위이므로 애플리케이션 코드를 변경하지 않았다.

### LEARNINGS
- 최종 `pnpm verify` 성공: domain 3, web 32, worker 11 unit tests와 Playwright 1, lint/typecheck/build.
- final audit 근거는 `docs/COMPLETION_AUDIT.md`에 유지한다.

### NEXT TASK TIPS
- 실제 운영을 시작할 때만 사용자 승인을 받은 뒤 GitHub Secrets/Variables, Worker OAuth runtime binding, Cloudflare D1/R2 리소스와 redirect URI를 설정한다.
- 실제 배포, AWS/Cloudflare CLI, 커밋은 계속 금지다.


[2026-09-11 09:13] - 편집기 반응형 UI 컨벤션

### DISCOVERED ISSUES
- SVG 기본 preserveAspectRatio는 화면에 여백을 만들 수 있다. 기존 boundingClientRect의 x/y 독립 비율은 실제 SVG 렌더 좌표와 달라 실제 벽 클릭을 놓친다.

### DECISIONS
- FloorPlanEditor의 pointer 변환에서 getScreenCTM().inverse()를 적용한다. geometry.ts와 저장 좌표 체계는 보존하며, DOM SVG API가 없는 jsdom에서는 기존 helper로 fallback한다.
- styles.css의 semantic CSS variables를 모든 화면에서 공유한다. shell의 height는 100dvh이며 panel별 overflow-y:auto를 사용한다. Inspector overlay는 명시적 버튼으로 열어 Pointer Events drag를 가로채지 않는다.

### FAILED APPROACHES
- 선택한 방의 3px stroke를 기존 6px 벽 아래에 그리면 가려진다. 선택 배경에 accent-soft를 적용해 상태를 구분한다.

### LEARNINGS
- 1024px 이상은 3-pane, 768–1023px은 Inspector overlay, 767px 이하는 Checklist 기본 surface다. Modal open 상태에서 desktop breakpoint로 바뀌면 inert를 반드시 해제해야 한다.
- 같은 elementId에 여러 checklist 행이 연결될 수 있으므로 current row는 activeItemId와 element selection을 함께 해석해 하나만 선택한다.

### NEXT TASK TIPS
- E2E에서 실제 SVG 클릭 좌표는 createSVGPoint/DOMPoint와 getScreenCTM을 사용한다. bounding box 비율로 synthetic pointer를 만들면 letterbox 문제가 숨겨진다.
- SVG hit 영역은 투명 non-scaling 44px stroke로 확장하며, 표시되는 벽·창문 stroke는 별도로 유지한다.
