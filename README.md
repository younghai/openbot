# OpenBot — 그록봇(Grok Bot) 대체재

자체호스팅 AI 팀원 플랫폼. [rakazo](https://github.com/elie222/rakazo)를 기준으로 하고,
[CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot)(정책 게이트·감사·루틴)과
[nightly-labs/openbot](https://github.com/nightly-labs/openbot)(채널·잡 큐·스킬·컨텍스트 압축)의 패턴을 통합했습니다.

## 필수 기능 ↔ 구현 ↔ 검증

| 요구 기능 | 구현 | 검증 |
|---|---|---|
| 대화·메모리·루틴·히스토리를 가진 영속 봇 | SQLite(node:sqlite) 전체 이력, 봇별 메모리, cron 루틴 | 매트릭스 25/25 (재시작 후 데이터 유지, 1분 cron 자동 발화) |
| 음성 모드: 응답 읽기·받아쓰기·통화 (ElevenLabs/OpenAI/Cartesia/Fish BYO) | 서버 TTS 프록시 4종 + 브라우저 폴백(speechSynthesis), Web Speech 받아쓰기, 통화 루프 UI | 키 없음 경로 400+fallback 명세 검증. 실제 음성 합성은 키 필요(미검증) |
| 공유 Team Computer / 격리 Private Computer | 컴퓨터 = kind(team/private) × provider(local/docker/e2b/daytona/createos/boat), 작업 공간 분리 | team/private 작업 디렉터리 격리 실측 |
| 브라우저·터미널·파일·그래픽 데스크톱 접근 | browser.fetch(SSRF 가드) + 대화형 browser.open/click/type/snapshot(Playwright), terminal.exec, fs.read/write/list, desktop.screenshot(macOS) | 전 도구 실측 — browser.open이 실제 크로뮴으로 example.com을 열어 스크린샷·제목 반환, 채팅에 이미지 인라인 표시 |
| peer 봇 위임 + 단기 서브에이전트 | bot.delegate(순환·깊이 방지), subagent.run | A→B 위임 실측 (B 대화에 `[delegated by …]` 기록) |
| BYO 모델 자격증명 | OpenAI 호환 + Anthropic + mock, AES-256-GCM 암호화 저장 | 로컬 가짜 OpenAI 서버로 실제 HTTP 호출·인증 헤더·응답 반영 실측 |
| Composio / Pipedream Connect / Treg / 원격 MCP / OpenAPI 툴 소스 | 5종 소스 등록 → 네임스페이스 도구(`mcp.x.y`)를 모든 봇에 노출 | 원격 MCP·OpenAPI는 로컬 테스트 서버로 도구 호출 실측; Composio/Pipedream/Treg는 키 없음 오류 명세만 검증 |
| Docker / E2B / Daytona / CreateOS / Boat / 신뢰 로컬 | 프로바이더 추상화 + 상태 프로브. local은 즉시 동작 | local 실측, docker "CLI 미설치" 안내 실측, 나머지는 키 필요 오류 안내 실측 |

추가(CopilotKit OpenBot 계열): 모든 도구 호출의 정책 게이트 + 감사 로그(SSRF 차단 실측).
추가(nightly openbot 계열): 공유 채널(멤버 봇 순차 응답 + 사후 멤버 편집), 봇별 FIFO 잡 큐(일시정지/재개), SKILL.md 스킬 라이브러리, 긴 대화 자동 요약 압축(임계값 초과 시).

## 실행

```bash
pnpm install
pnpm dev          # 서버(tsx watch) + 웹(vite, :5188)
# 또는 프로덕션: pnpm build && pnpm start  → http://localhost:8940 (웹 내장)
```

- 기본 포트 8940, 기본 바인딩 127.0.0.1 (LAN 공유는 `OPENBOT_HOST=0.0.0.0`, `OPENBOT_PORT`/`OPENBOT_DATA_DIR`으로 변경)
- UI에서 봇 편집(✏️: 이름/페르소나/모델/컴퓨터/음성), 일시정지(⏸)/재개(▶), 삭제, 잡 취소 지원
- 데이터: `data/openbot.db`, `data/computers/`, `data/skills/`, `data/media/`
- 모델 키 없이 즉시 사용 가능(내장 mock 프로바이저가 도구 흐름 시연). 설정 → 모델 자격증명에서 OpenAI 호환/Anthropic 키 추가.

### 로컬 모델 (Ollama) — 키 없이 실제 LLM으로 업그레이드

1. [Ollama](https://ollama.com) 설치 후 도구 지원 모델 pull: `ollama pull qwen3.5:4b` (capabilities에 `tools` 포함된 모델 권장)
2. 설정 → 모델 자격증명 → 프리셋 **"Ollama (로컬)"** 선택 → "모델 목록 불러오기" → 모델 선택 → "기본으로 사용" 체크 후 추가
3. 기본으로 지정하면 provider 없던 기존 봇 전체가 즉시 로컬 모델로 응답합니다 (봇별 다른 모델은 provider를 따로 만들어 봇 편집에서 지정)
- LM Studio도 같은 방식(프리셋, `http://localhost:1234/v1`). OpenAI 호환이면 무엇이든 "직접 입력"으로 등록 가능
- 실측(2026-10-30, qwen3.5:4b): 스트리밍 응답 + terminal 도구 호출 E2E 통과

### 도구 승인 큐 (ask/deny)

- 부작용 도구(터미널 실행, 파일 쓰기, 브라우저 조작, 스크린샷, 동적 MCP/API 도구)는 실행 전 사람 승인 대기. 읽기 전용 도구는 정책으로 자동 허용.
- 결정 방법: 사이드바 **승인** Inbox 또는 채팅 상단 배너에서 승인/거부. 10분 무응답·서버 재시작 시 자동 거부(안전 방향).
- 정책은 데이터(`tool_policies` 테이블, 행 없는 도구는 기본 'ask') 
- **정책 프리셋** (승인 Inbox 상단): 기본(안전) / **로컬 작업장**(터미널·파일 쓰기 자동 허용) / 잠금(최대 보수). 감사 로그는 프리셋과 무관하게 전량 기록.

### MCP 도구 카탈로그

- 툴 소스 화면 상단 "카탈로그에서 추가"에서 원클릭 등록:
  - **Context7**(HTTP, 키 불필요) — 최신 라이브러리 공식 문서 검색
  - **DeepWiki**(HTTP, 키 불필요) — GitHub 저장소 위키 질의
  - **filesystem / fetch / memory / sequential-thinking**(stdio) — MCP 공식 reference 서버를 `npx`로 로컬 실행
- stdio 트랜스포트 지원: `transport:"stdio"` + `command/args`(라인 구분 JSON-RPC, 자식프로세스 수명·재시작 관리, 서버 종료 시 정리)
- filesystem 공식 서버는 `data/computers/` 로 스코프(모든 컴퓨터 디렉터리; 봇별 스코프는 2차). memory는 `data/mcp-memory.json`에 영속.
- 카탈로그도 데이터(`tool-catalog.ts`) — 2차에 커뮤니티 카탈로그(원격 JSON)로 확장.
### 네이티브 데스크톱 컴퓨터유즈 (2026-11-01, agent-desktop)

- **`desktop.list_apps` / `desktop.snapshot`** (자동 허용 — 관찰) — OS 접근성 트리로 앱 UI 구조를 안정 ref(`@snapshotId:eN`)와 함께 읽는다. 픽셀 추측 없음, 헤드리스(포인터 안 움직임).
- **`desktop.act`** (승인 필요 — 조작) — ref로 click/type/press/launch 등. "보는 건 자유, 만지는 건 승인" 정책. STALE_REF·AMBIGUOUS_TARGET 시 재스냅샷이 계약.
- **에러 계약(P2)** — 도구 실패에 재시도 안전성 힌트(TIMEOUT·STALE_REF 등)를 붙여 모델의 무지성 재시기를 방지. terminal·MCP에도 적용.
- 스킬 `desktop-use` 자동 시드(스냅샷→ref→행동→검증 루프). 설치: `npm i -g agent-desktop` + macOS 접근성 권한(`agent-desktop permissions --guide`).
- 서버 재시작 시 고아 'running' 잡을 error로 복구(큐 영구 봉쇄 방지).
- 실측: Finder 스냅샷(refs 690)·앱 149개 목록·TextEdit launch 승인 실행·잘못된 ref 차단+가이드까지 실모델 E2E. TextEdit 신규 실행 직후의 창 인벤토리 불안정은 agent-desktop 특성(재시도 safe 표기).

### QwenPaw에서 도입한 것들 (2026-10-31 3차)

- **에이전트 특화 로컬 모델 가이드 (QwenPaw-Flash)** — 공식 GGUF가 HF에 공개됨(실측): `ollama pull hf.co/agentscope-ai/QwenPaw-Flash-9B-Q4_K_M` 후 설정 → 프리셋 "Ollama (로컬)" 모델 목록에서 선택. 도구호출 특화 학습 모델(2B/4B/9B/27B/35B-A3B). 이 머신(36GB)은 9B까지 여유.
- **명령 가드** — `terminal.exec` 실행 전 정적 위험 패턴(sudo·rm -rf /·mkfs·curl|sh·포크폭탄 등)을 승인 이전에 차단, 감사에 남김. 정책 프리셋과 무관한 안전 하한선.
- **체크포인트** — 승인된 터미널/파일 쓰기 직전 워크스페이스를 자동 스냅샷(tar.gz, 워크스페이스당 10개 유지). 파일 화면에서 원클릭 복원.
- **Markdown 메모리 계층 (ReMe 패턴)** — `memory.save`가 `data/memory/<봇>/​*.md`로 동시 기록, 봇은 `memory.read`/`memory.write`로 직접 읽고 쓰고, ⌘K 검색이 파일을 색인. 파일 화면에서 열람·편집.
- **파일 워크스페이스 뷰** — 메모리·컴퓨터 워크스페이스 브라우저/미리보기/편집(경로 가드 공유).
- **Telegram 게이트웨이** — 설정에 `TELEGRAM_BOT_TOKEN` 저장 시 자동 시작: 메시지→봇, 봇 답변→텔레그램, **승인 요청→인라인 승인/거부 버튼**(원격 승인). 저장 즉시 연결.

- 실측(2026-10-30): Context7 등록 1.4초/도구 2개, filesystem(npx) 등록 2.3초/도구 14개, 승인→stdio 호출 E2E 통과.

### 작업 보드·대시보드·검색·알림 (2026-10-31 2차)

- **작업 보드** — 봇이 담당자인 칸반(backlog→doing→review→done). "실행"을 누르면 담당 봇의 큐로 작업이 들어가고, 봇이 `task.update` 도구로 **스스로 상태를 보고**한다(실측: 로컬 모델이 터미널 실행→승인→완료 보고까지 자동). PM 툴의 '담당자'가 실제로 일하는 유일한 보드.
- **온보딩 마법사** — 봇 0개 첫 실행 시 3단계(이름 → Ollama 자동감지 → 첫 질문 자동 발사).
- **전역 검색 (⌘K)** — 대화·메모리·작업·봇 통합 검색.
- **플릿 대시보드** — 봇별 메시지·도구호출·토큰·루틴·승인 대기 + `VACUUM INTO` 원클릭 백업(최근 10개 유지).
- **알림 센터** — 승인 대기·작업 완료·루틴 결과가 종 아이콘에 쌓이고 읽음 처리.
- **리팩토링** — routes 도메인 분할(routes/ 7파일), zod 입력 계약, onError 로깅, 웹 ErrorBoundary, 메시지 페이지네이션(60건+이전불러오기), WS 이벤트 v 필드.
- **알고리즘** — 메모리 회상 관련도 스코어링(키워드 중복+시간 감쇠), 컨텍스트 압축이 도구 결과를 요약에 보존, 검색 결과 도메인 dedupe, 루틴 동시발화 지터 분산(0–30s).

### 일상 기능 (2026-10-31 추가)

- **웹 검색** `search.web` — 키 없는 DuckDuckGo 검색 도구. node fetch가 차단당하면(실측) 시스템 curl로 폴백.
- **이미지 첨부 → 비전** — 채팅 📎 버튼 또는 이미지 붙여넣기(최대 4장/10MB). 비전 capability 모델(qwen3.5 등)이 이미지를 보고 답함. 첨부는 대화 히스토리에 남아 후속 질의에서도 참조.
- **생각 중 표시** — thinking 모델의 reasoning 진행(누적 글자수)을 실시간 표시. 내용은 노출하지 않는다.

## 구조

```
apps/server  Hono + ws + node:sqlite
  src/agent/     프로바이더(openai호환/anthropic/mock) + 에이전트 루프 + 압축
  src/tools/     게이트웨이(정책+감사) + terminal/fs/browser/desktop/memory/skills/delegate
  src/tools/dynamic.ts  MCP/OpenAPI/Composio/Pipedream/Treg 어댑터
  src/computers/ local/docker/e2b/daytona/createos/boat
  src/voice.ts   TTS 4종 프록시 + Whisper STT
  src/queue.ts, routines.ts, cron.ts  잡 큐 + 스케줄러
  src/test/matrix.ts  검증 매트릭스(아래)
apps/web     React 18 + Vite (챗/음성/컴퓨터/루틴/툴소스/설정/감사)
docs/API.md  REST + WebSocket 계약
```

## 검증 기록 (2026-10-30, 승인 큐 포함)

- `pnpm --filter @openbot/server test` = `src/test/matrix.ts`: **44/44 통과** (승인 큐·stdio MCP·카탈로그·정책 프리셋·웹검색·이미지 첨부·작업 보드·검색·백업·통계/알림 체크 포함)
  (가짜 OpenAI 호환 서버·petstore OpenAPI·MCP 서버를 로컬에 띄워 실제 HTTP로 전 회로 검증.
  3차: Playwright 설치 후 browser.open이 실제 크로뮴으로 example.com 접속 — 스크린샷+제목 반환 확인.
  봇 이름변경·삭제 연쇄 정리, 채널 멤버 사후 편집 포함)
- WebSocket 스모크: chat.send → chat.accepted → 스트리밍 델타 55개 → done → 응답 영속화 통과
- 브라우저 실구동(자동화): 봇 생성 → 대화 → 도구 카드(terminal.exec/memory.save) → 컴퓨터/설정/감사 페이지 렌더링 확인,
  2차: 편집 모달 저장 반영(DB), 일시정지/재개 배지 전환, 스크린샷 도구 결과 이미지 인라인 로드,
  3차: 브라우저 도구 스크린샷 채팅 인라인, 채널 멤버 편집(WS봇 제외 저장 → 멤버 [알파]) 확인

### 정직한 한계 (키/환경 없이 검증 못 한 것)

- ElevenLabs/OpenAI/Cartesia/Fish 실제 음성 합성, Whisper 실제 전사 — 키 필요(코드 경로·오류 응답만 검증)
- Anthropic 프로바이더 실제 호출, Composio/Pipedream/Treg 실제 연동 — 키 필요(동일)
- docker/E2B/Daytona/CreateOS/Boat 실제 샌드박스 — 이 머신에 Docker 미설치(상태 프로브·오류 안내만 검증)
- 통화 모드의 마이크 입력은 자동 브라우저에서 오디오 입력 권한 제약으로 실측하지 못함(받아쓰기 API 경로는 코드 검증)

### 다음 단계 후보 (요청 시 진행)

1. 음성 키 넣고 실제 TTS/Whisper 실측 (설정 → 음성 & 키)
2. 다중 사용자 인증(현재 로컬 단일 사용자 전용 — LAN 노출 시 주의)
3. Electron/모바일 클라이언트(rakazo처럼 같은 API 재사용)

## 설계 결정 요약

- Postgres+Prisma 대신 **node:sqlite**: 이 머신 Docker 없음, 네이티브 의존 0, 단일 바이너리 배포에 충분
- MCP SDK 대신 **Streamable HTTP 프로토콜 직접 구현**(~120줄): 의존성 최소화
- cron-parser 대신 **5필드 cron 자체 구현**: CJS/ESM interop 문제 회피
- 감사는 CopilotKit OpenBot 원칙 채택: "모든 행동은 실행 전에 결정되고 실행 후에 기록된다"
- 목록은 `docs/DECISIONS.md` 참고
