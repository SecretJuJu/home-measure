# HomeMeasure 완료 감사

감사 일시: 2026-09-10 17:04 KST  
범위: `PRD.md`, `UXDR.md`, `ARCHITECTURE.md`, 현재 소스·테스트·CI 설정. 실제 배포, AWS/Cloudflare CLI 실행, 커밋은 수행하지 않았다.

## 결론

Task 9는 **완료**다. 모든 P0·아키텍처·CI 요구사항에 현재 코드와 테스트 근거가 있다. 실제 Cloudflare 계정/Secret 설정 및 배포는 사용자 지시대로 실행·검증하지 않았다.

## 요구사항별 근거

| 요구사항 | 상태 | 현재 근거 |
| --- | --- | --- |
| 집 생성·수정·삭제, 이름·주소·메모 | 충족 | `FloorPlanEditor.tsx`의 optimistic create/update/delete, `local-first-store.ts`의 durable DELETE tombstone, `FloorPlanEditor.test.tsx`의 수정·확인 삭제 검증 |
| 공간 생성·이름 변경·유형·삭제 | 충족 | `FloorPlanEditor.tsx`, shared `roomTypeSchema`, Worker room routes, `FloorPlanEditor.test.tsx` |
| 직사각형 평면도·공간 이동·문·창문·8종 설비 배치 | 충족 | `roomLayoutSchema`, `geometry.ts`, `FloorPlanEditor.tsx`; pointer movement/clamp 및 geometry test |
| 문 폭·경첩·안/밖 열림과 시각적 swing arc | 충족 | `DoorElement`, `doorGeometry`, door Inspector; `geometry.test.ts`, `FloorPlanEditor.test.tsx` |
| 창문 폭·높이·sill·개폐 방식 | 충족 | `WindowElement`, window Inspector, `FloorPlanEditor.test.tsx` |
| 공간 유형별 기본 checklist, 필수/권장, 직접 추가, 객체 연결 | 충족 | `definitions.ts`, `ChecklistPanel.tsx`, `HomeMeasureWorkspace.test.tsx` |
| 실측 모드: mm·메모·다음 항목·나중에 | 충족 | `MeasurementMode.tsx`; 저장 후 checklist 완료와 reload 보존을 `HomeMeasureWorkspace.test.tsx`가 검증 |
| 완료율·필수/권장 누락·미측정 필터 | 충족 | `completion.ts`, `ChecklistPanel.tsx`, checklist unit/integration tests |
| Summary: 방 치수·문 폭·가전 공간·최소 통과 폭·주요 설비 위치·사진 | 충족 | `PropertySummary.tsx`는 방별 `layout.doors`의 벽/폭과 `layout.utilities`의 type/room-local 좌표를 표시하고, `PhotoReferenceBrowser.tsx`가 context-bound 사진 열람을 제공한다. `PropertySummary.test.tsx`가 populated/empty room의 문·설비 표시를 확인한다. |
| 사진의 context·메모·압축·로컬 Blob 보존·재시도·R2 metadata·Summary 열람 | 충족 | `PhotoCaptureControl.tsx`의 4,000자 note 입력, `photo-upload-queue.ts`의 envelope 검증, `PhotoReferenceBrowser.tsx`의 local-preview/detail overlay, Worker upload route, photo tests |
| 새로고침 및 오프라인에서도 입력 보존 | 충족 | Dexie `HomeMeasureDatabase`, `LocalFirstRepository`, local-first tests, `e2e/local-first-core.spec.ts` |
| idempotent sync와 API 입력 검증 | 충족 | stable mutation schema, queue retry, `idempotent_mutations`, Worker Zod validation, domain/Worker tests |
| 소유자 authorization·production session 생성 | 충족 | `/api/*` session/development middleware와 ownership query, `GET /api/auth/google` PKCE/state transaction, callback JWKS RS256 claim verification·D1 session 생성, secure cookie/logout. Worker OAuth tests가 state replay·invalid issuer/signature·session invalidation을 확인한다. |
| D1/R2 binding·마이그레이션 | 충족(설정 준비) | `wrangler.jsonc`, `0001_initial.sql`, `0002_photo_upload_state.sql`, Worker `DB`/`PHOTO_BUCKET` bindings. 실제 리소스 ID·bucket 존재 여부는 배포 금지 조건상 검증하지 않았다. |
| PR 검증만, master push만 deploy | 충족 | `.github/workflows/ci.yml`: `pull_request`는 verify만, `deploy`는 `push` 및 `refs/heads/master` 조건과 `needs: verify`를 사용 |
| 배포 인증값의 안전한 참조 | 충족(워크플로 정적 검사) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`는 GitHub Secrets, D1 ID는 GitHub Variable로 참조한다. 설정값 미제공 시 deploy 전 가드가 실패한다. 실제 Secret 설정·배포 실행은 하지 않았다. |

## 확인된 미충족 항목

없음. 외부 계정/Secret 설정과 실제 배포는 코드 미충족이 아니라 사용자 지시상 보류된 운영 작업이며, `docs/DEPLOYMENT.md`와 `docs/GOOGLE_OAUTH.md`에 분리되어 있다.

## 검증 실행

`pnpm verify`를 2026-09-10 17:04 KST에 성공적으로 재실행했다.

- lint: domain, web, worker 통과
- typecheck: domain, web, worker 통과
- unit: domain 3, web 32, worker 11 통과
- E2E: Playwright Chromium 1 통과 — API가 503이어도 집·공간·문·실측값이 reload 후 유지됨
- build: Vite web build 및 Worker TypeScript build 통과

Task 10 이후 OAuth test는 실제 Web Crypto RSA key로 서명한 JWT와 fake Google JWKS/token endpoint를 사용한다. Task 11 tests는 photo note의 context-bound queue 저장과 local Blob Summary preview/detail을 확인한다. Task 12 Summary test는 여러 문 폭과 설비의 room-local 좌표, 빈 방의 명시적 미기록 상태를 확인한다.
