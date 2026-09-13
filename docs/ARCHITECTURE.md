# HomeMeasure — Technical Architecture

## 1. Architecture Goal

목표:
- 사용자 수가 적은 MVP
- 월 운영비 거의 0원
- 별도 서버 운영 없음
- 배포 단위 최소화
- Cloudflare 중심
- iPad/Web
- Local-first
- 나중에 확장 가능한 정도의 최소 구조

---

## 2. Stack

### Frontend
- Vite
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Zustand
- TanStack Query
- SVG + Pointer Events
- IndexedDB (Dexie 권장)

### Backend
- Cloudflare Workers
- Hono
- Zod
- Drizzle ORM

### Storage
- Cloudflare D1: user / property / room / checklist / metadata
- Cloudflare R2: photos / attachments

### Deployment
- Cloudflare Workers Static Assets
- Wrangler
- GitHub Actions 또는 Cloudflare Git integration

---

## 3. High-level

```text
iPad / Desktop Browser
        │
        ▼
Cloudflare Worker
├── Static React App
├── /api/*
├── Auth
├── Validation
│
├── D1
└── R2
```

하나의 Worker deployment로 frontend와 API를 함께 제공하는 것을 우선한다.

---

## 4. Repository

```text
home-measure/
├ src/
│  ├ client/
│  │  ├ app/
│  │  ├ components/
│  │  ├ features/
│  │  │  ├ property/
│  │  │  ├ floor-plan/
│  │  │  ├ checklist/
│  │  │  ├ measurement/
│  │  │  └ photo/
│  │  ├ stores/
│  │  └ lib/
│  │
│  ├ server/
│  │  ├ routes/
│  │  ├ middleware/
│  │  ├ db/
│  │  └ services/
│  │
│  └ shared/
│     ├ schema/
│     └ types/
│
├ migrations/
├ public/
├ worker.ts
├ wrangler.jsonc
└ package.json
```

---

## 5. Data Strategy

### Structured metadata → D1

Tables:

```text
users
sessions
properties
rooms
checklist_items
measurements
photos
```

### Flexible floor-plan data

MVP에서는 지나친 정규화를 피한다.

rooms.layout_json에 room 단위 layout document를 저장한다.

예:

```json
{
  "version": 1,
  "size": {
    "width": 3120,
    "height": 2870
  },
  "doors": [],
  "windows": [],
  "utilities": []
}
```

장점:
- schema migration이 단순하다.
- canvas editor 개발 속도가 빠르다.
- collaborative editing 요구가 없으므로 충분하다.

---

## 6. Suggested Schema

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE properties (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE checklist_items (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  room_id TEXT,
  element_id TEXT,
  label TEXT NOT NULL,
  category TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  measurement_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE measurements (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  room_id TEXT,
  element_id TEXT,
  type TEXT NOT NULL,
  value REAL,
  unit TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  room_id TEXT,
  element_id TEXT,
  checklist_item_id TEXT,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL
);
```

---

## 7. Auth

MVP:
- 자체 아이디·비밀번호 계정 (PBKDF2 해시, D1 세션)
- 비밀번호 직접 관리하지 않음
- Worker callback
- D1 session
- HttpOnly / Secure / SameSite=Lax cookie

향후 필요 시 provider 추가.

---

## 8. API

```text
GET    /api/me

GET    /api/properties
POST   /api/properties
GET    /api/properties/:id
PATCH  /api/properties/:id
DELETE /api/properties/:id

POST   /api/properties/:id/rooms
PATCH  /api/rooms/:id
DELETE /api/rooms/:id

PUT    /api/rooms/:id/layout

GET    /api/properties/:id/checklist
POST   /api/checklist
PATCH  /api/checklist/:id

POST   /api/measurements
PATCH  /api/measurements/:id

POST   /api/photos
DELETE /api/photos/:id
```

---

## 9. Local-first

입력 흐름:

```text
User Action
→ Zustand state
→ IndexedDB immediately
→ UI success
→ Sync queue
→ Worker API
→ D1/R2
```

중요:
- 서버 응답을 기다린 뒤 UI를 갱신하지 않는다.
- 모든 수정 operation에 clientMutationId를 둔다.
- 중복 재전송이 가능하도록 API는 가능한 한 idempotent하게 설계한다.

---

## 10. Sync

MVP에서 복잡한 CRDT는 사용하지 않는다.

각 entity에:
- id
- updatedAt
- localDirty

정도만 둔다.

기본:
- local modification wins
- 서버 sync 성공 시 dirty 제거

여러 기기에서 동시에 수정하는 문제는 P1 이후 처리한다.

---

## 11. Photo Pipeline

초기:
```text
camera/file
→ browser resize
→ WebP/JPEG
→ Worker
→ R2
→ D1 metadata
```

브라우저에서 긴 변 기준 약 1920px로 resize 권장.

후속 최적화:
- Worker에서 upload URL 발급
- R2 direct upload

MVP 사용자 수가 적다면 Worker proxy upload로 먼저 시작해도 된다.

---

## 12. SVG Floor-plan

Canvas library를 MVP의 필수 dependency로 두지 않는다.

우선:
- SVG
- Pointer Events
- CSS transform
- geometry helper

객체:
- Room rect
- Door
- Window
- UtilityIcon

Door:
- hinge point
- width
- opening side
- opening direction
- swing arc

필요해질 때 Konva/Fabric 검토.

---

## 13. Cost-control Rules

사용하지 않는다:
- Kubernetes
- AWS
- RDS
- Redis
- Queue
- Kafka
- WebSocket
- 별도 CDN
- 별도 API server
- 별도 auth server
- realtime collaboration

모든 기능은 MVP 요구가 생길 때만 추가한다.

---

## 14. Environment

```text
local
preview
production
```

Cloudflare binding:
- DB
- PHOTO_BUCKET
- 세션 쿠키와 비밀번호 해시

secret은 wrangler secret으로 관리.

---

## 15. Deployment

```text
git push
→ CI
→ lint
→ typecheck
→ test
→ build
→ wrangler deploy
```

PR:
- preview deployment 가능하면 활성화

main:
- production deployment

---

## 16. Testing

필수:
- unit: geometry helpers
- unit: checklist completion
- unit: sync reducer
- integration: Worker API
- smoke: property 생성 → room → measurement → reload

E2E는 핵심 플로우 몇 개만 Playwright.

---

## 17. Non-functional

- iPad Safari에서 정상 동작
- touch / pointer 입력
- offline 입력 보존
- reload-safe
- 사진 업로드 실패 시 retry 가능
- 모든 destructive action confirm
- 서버 로그에 개인정보/사진 원문 노출 금지
