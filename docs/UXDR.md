# HomeMeasure — UXDR

## 1. UX Goal

현장에서 iPad를 들고 집을 돌아다니며 빠르게 실측할 수 있어야 한다.

사용자는 CAD 지식이 없다고 가정한다.

UX의 우선순위:

1. 빠른 입력
2. 누락 방지
3. 위치 기반 이해
4. 최소한의 화면 전환
5. 터치 친화적인 조작

---

## 2. Primary Layout

iPad landscape 기준 3-pane 구조.

```text
┌──────────────┬────────────────────────────┬──────────────────┐
│ 공간         │                            │ Inspector        │
│              │                            │                  │
│ ✓ 현관       │       Floor Plan           │ Door 1           │
│ ● 거실       │                            │ 폭 820mm         │
│ ○ 침실       │                            │ 안쪽 열림        │
│ ○ 주방       │                            │ 왼쪽 경첩        │
│ ○ 욕실       │                            │ + 사진           │
│ ○ 베란다     │                            │                  │
├──────────────┴────────────────────────────┴──────────────────┤
│ + 공간   + 문   + 창문   + 콘센트            실측 모드 ▶    │
└──────────────────────────────────────────────────────────────┘
```

### Left Pane
- 공간 목록
- 공간별 완료 상태
- 현재 공간 강조

### Center
- SVG 기반 평면도
- pan / zoom
- room / wall / door / window / utility element 선택
- drag 가능한 요소

### Right Inspector
선택한 객체만 편집한다.

예:
- 폭
- 높이
- 방향
- 메모
- 사진
- checklist linkage

### Bottom Toolbar
빠른 객체 추가:
- 공간
- 문
- 창문
- 콘센트
- LAN
- 수도
- 배수구
- 가스

---

## 3. Responsive

### >= 1024px
3-pane

### 768–1023px
2-pane
- Left + Canvas
- Inspector는 slide-over

### < 768px
Single-pane
- 조회/측정 위주
- Floor plan editing은 제한적으로 허용

---

## 4. Floor Plan Interaction

### Room Creation

기본:
- 직사각형 공간 추가
- 가로/세로 입력
- Canvas 위에 생성
- drag하여 위치 이동

초기 버전에서 자유 polygon drawing은 하지 않는다.

### Wall
벽 탭 → Inspector 활성화.

입력:
- 길이
- 메모
- 사진

### Door

벽 선택 → “+ 문”

Canvas에 문 생성.

Door Inspector:

```text
문 폭
[ 820 ] mm

경첩
[ 왼쪽 ] [ 오른쪽 ]

열림
[ 안쪽 ] [ 바깥쪽 ]

시각적 방향
↘  ↙  ↗  ↖

[ 사진 추가 ]
```

중요:
- 사용자가 좌/우 경첩 용어를 몰라도 그림으로 이해할 수 있어야 한다.
- Canvas에서 door swing arc를 보여준다.

### Window

입력:
- 폭
- 높이
- 바닥으로부터 높이
- 개폐 방식
- 사진

### Utility Elements

Canvas에 아이콘 형태로 배치.

- Outlet
- LAN
- Water
- Drain
- Gas
- Boiler
- AC
- Interphone

---

## 5. Checklist UX

Checklist와 Floor Plan은 같은 데이터의 서로 다른 뷰다.

예:

```text
□ 베란다 출입문 폭
```

탭하면:
- 연결된 Door 선택
- Canvas에서 해당 Door highlight
- Inspector에서 width input focus

값 저장 시:
- checklist 자동 완료

---

## 6. Measurement Mode

현장에서는 편집 UI를 최소화한다.

```text
거실                                7 / 12

┌──────────────────────────────────────┐
│                                      │
│             창문 폭                  │
│                                      │
│            [      ] mm               │
│                                      │
│             📷 사진                  │
│                                      │
└──────────────────────────────────────┘

[ 나중에 ]                       [ 저장 → ]
```

### Rules
- tap target 최소 44px 이상
- 주요 액션은 하단
- mm 기본
- 저장하면 자동으로 다음 미완료 항목
- 키보드가 떠도 다음/저장 버튼이 가려지지 않아야 한다.

---

## 7. Photo UX

사진은 독립 갤러리가 아니라 context를 가진다.

```text
베란다
└ 세탁기 공간
   ├ 전체
   ├ 수도꼭지
   └ 배수구
```

촬영 순간 현재:
- property
- room
- element
- checklist item

중 가능한 범위까지 자동 연결한다.

---

## 8. Completion UX

```text
실측 완료도
82%

총 46개
✓ 38 완료
⚠ 4 필수 미측정
○ 4 권장 미측정
```

필수 누락은 먼저 보여준다.

CTA:
- 미측정만 보기
- 실측 완료

---

## 9. Summary UX

실측 종료 후 기본 화면은 편집 화면이 아니라 Summary가 된다.

예:

```text
우리집

실측 94%

침실
3120 × 2870 mm

세탁기 공간
620 × 700 × 1100 mm

냉장고 공간
780 × 720 × 1850 mm

현관 최소 통과 폭
810 mm
```

쇼핑 중 이 화면만 보고 주요 치수를 확인할 수 있어야 한다.

---

## 10. Offline UX

모든 사용자 액션은 local-first.

상태 표시:

- ✓ 저장됨
- ↑ 동기화 중
- ○ 오프라인
- ! 동기화 실패

오프라인이라고 입력 자체를 막지 않는다.

---

## 11. Visual Direction

- iPad productivity app
- Figma / Linear 계열의 밀도
- 과도한 카드 UI 금지
- canvas 중심
- neutral background
- object selection이 명확해야 함
- visual hierarchy는 typography + spacing 중심
- touch target은 충분히 크게
- inspector는 compact하게

### Avoid
- 모바일 앱처럼 모든 기능을 full-screen page로 전환
- 큰 hero card
- 과한 gradient
- glassmorphism 남용
- 장식적 illustration
- rounded card가 겹겹이 중첩되는 구성

---

## 12. Interaction Principle

좋지 않은 흐름:

```text
공간 선택
→ 문 목록
→ 문 추가
→ 상세
→ 수정
→ 저장
→ 뒤로
```

목표 흐름:

```text
벽 탭
→ + 문
→ 위치 조정
→ 폭 입력
→ 방향 선택
```

Canvas는 유지되고 Inspector만 바뀌는 구조를 기본으로 한다.
