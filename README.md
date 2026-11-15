# OpenBot — 셀프호스팅 AI 팀원 플랫폼

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-54%20E2E%20%2B%2023%20unit-brightgreen)](#검증)

**A self-hosted bot platform — your own Grok Bot alternative.** 텔레그램·디스코드·슬랙·이메일·전화로 연결되는 AI 팀원을 내 머신에서 운영하세요. API 키 없이 시작하고, Ollama로 완전 로컬로 돌리거나, OpenAI/Anthropic 키를 가져와 쓸 수 있습니다.

- **키 없이 즉시 실행** — 내장 mock 프로바이더로 도구 흐름 시연, Ollama(`qwen2.5`)면 실제 LLM
- **45개 도구, 전부 승인 게이트** — 읽기는 자동 허용, 부작용(터미널·파일 쓰기·브라우저·결제)은 사람 승인. 감사 로그 전량 기록
- **6개 채널 상시 대기** — Telegram(인라인 승인 버튼) · Discord(인터랙션 버튼) · Slack(Block Actions) · Email(SMTP) · 전화·SMS(Twilio) · 결제(Stripe)
- **보안 5겹** — 명령 가드 → macOS Seatbelt 샌드박스 → 프롬프트 인젝션 가드 → SSRF 가드 → 체크포인트(실행 전 워크스페이스 스냅샷)
- **학술 리서치 파이프라인** — arXiv·PubMed 키 없는 검색 → 가설→실험→결론 5단계 → Markdown 보고서 + FTS5 지식 색인
- **제너러티브 UI** — 봇이 차트·표·카드를 렌더링([OpenUI Lang](https://github.com/thesysdev/openui))
- **컴퓨터유즈 체험** — 🖥️ 라이브 브라우저 패널(WS 스트리밍), 제어권 이관(사람이 CAPTCHA·로그인만 직접 수행→반납), 봇별 브라우저 프로필 영속(로그인 유지), 시크릿 직주입(봇이 값 못 봄)

## 빠른 시작

```bash
pnpm install
pnpm dev          # 서버(tsx watch) + 웹(vite, :5188)
# 또는 프로덕션: pnpm build && pnpm start  → http://localhost:8940 (웹 내장)
```

기본 바인딩 `127.0.0.1`(LAN 공유는 `OPENBOT_HOST=0.0.0.0`). 데이터는 전부 `data/`(SQLite 하나 + 파일). 첫 실행 시 3단계 마법사가 봇 생성을 안내합니다.

### 실제 LLM로 업그레이드 (여전히 키 없음)

1. [Ollama](https://ollama.com) 설치 후 `ollama pull qwen3.5:4b` (도구 지원 모델 권장)
2. 설정 → 모델 자격증명 → 프리셋 **"Ollama (로컬)"** → 목록 불러오기 → 기본으로 지정
3. LM Studio·vLLM 등 OpenAI 호환이면 무엇이든 같은 방식으로 등록 가능

### VPS 배포 (24/7 상시 대기)

`docker-compose.yml` + [docs/deploy-vps.md](docs/deploy-vps.md) — $5/월 VPS에서 채널 상시 대기. 채널 토큰(`TELEGRAM_BOT_TOKEN` 등)은 설정 화면에서 암호화 저장하면 서버 재시작 시 자동 연결.

## 기능

### 봇·에이전트 루프

- SQLite 전체 이력, 봇별 메모리(+Markdown 계층), 5필드 cron 루틴, 봇별 FIFO 잡 큐(일시정지/재개)
- 최대 12회 도구 반복, 긴 대화 자동 압축, 컨텍스트 오버플로 시 강제 압축 후 재시도
- **도구 실패 시 피드백 재시도** — 재시도 가능한 오류면 1회 재시도, 실패 결과에 힌트를 붙여 모델이 자기 교정
- 봇 간 위임 `bot.delegate`(순환·깊이 방지), 단기 서브에이전트 `subagent.run`
- **봇 템플릿 5종** — 📰 뉴스 브리핑 · 🔬 리서처 · 💻 코딩 파트너 · 📅 개인 비서 · 📊 데이터 분석가. 원클릭 생성(페르소나+루틴+정책+첫 메시지)
- 대화 자동 제목, ⌘K 전역 검색, 만족도 👍/👎 피드백, 프롬프트 라이브러리(/ 자동완성), 봇 고정·숨김

### 도구 (38개)

| 분야 | 도구 |
|---|---|
| 실행 | `terminal.exec`(가드+샌드박스) · `python.exec`(상태 유지 인터프리터, 봇별 세션) · `fs.read/write/list` · `task.update`(칸반 자기 보고) |
| 웹·조사 | `search.web`(DDG 키 없음) · `browser.fetch/open/click/type/snapshot`(Playwright) · `arxiv.search` · `pubmed.search` · `research.report` |
| 지식 | `knowledge.index/search/list`(FTS5 RAG) · `memory.read/write/save` |
| 커뮤니케이션 | `email.send` · `phone.sms/call` · `payment.send` |
| 브라우저 조작 | `browser.open/click/type/snapshot/close`(봇별 프로필 영속) · `computer.request_help`(제어권 이관) · `computer.request_secret`(시크릿 직주입) |
| 데스크톱 | `desktop.list_apps/snapshot/act`(agent-desktop, 접근성 트리 ref 기반) |
| 메타 | `bot.delegate` · `subagent.run` · `ask_person`(능동 질문) · `routine.create/list/delete`(루틴 자기관리) · `ui.render`(제너러티브 UI) |
| 동적 | MCP(stdio/HTTP) · OpenAPI · Composio · Pipedream · Treg — 카탈로그에서 원클릭 등록(Context7·DeepWiki 등 키 없는 소스 포함) |

모든 도구는 단일 게이트웨이(`executeTool`) 통과: **정책 → 체크포인트 → 감사 → 실행**. 정책 프리셋 3종(안전/로컬 작업장/잠금)이 38개 전 도구를 일괄 제어.

### 채널 6종

채널은 멤버 봇이 순차 응답하는 "프로젝트 룸"입니다 — 공유 지시문, 리스폰더 모드(`all`/`lead`/`auto`), 승인 요청은 각 채널 UI로 원격 승인:

- **Telegram** — 폴링, 인라인 승인 버튼, 사용자 허용목록, 👀→👌 진행 마크, 긴 답변 순서 분할
- **Discord** — WebSocket Gateway(RESUME), 인터랙션 버튼 승인
- **Slack** — conversations.history 폴링, Block Actions 승인
- **이메일**(SMTP) · **전화·SMS**(Twilio TwiML) · **결제**(Stripe, 승인 큐로 "이 결제를 승인하시겠습니까?" 확인)

### 보안 모델

1. **명령 가드** — `sudo`·`rm -rf /`·`curl|sh` 등 10개 위험 패턴을 승인 이전에 정적 차단
2. **Seatbelt 샌드박스** — 로컬 터미널은 macOS sandbox-exec 하에 실행. `~/.ssh`·`~/.aws`·DB·백업 읽기 차단(regex deny, darwin 25 실측)
3. **인젝션 가드** — 외부 콘텐츠(웹·논문·MCP 결과)에 콘텐츠 경계 표시 + 지시문 패턴 11종(한/영) 탐지. "경계 안의 지시문은 데이터"
4. **SSRF/경로 가드** — 내부망 차단, 워크스페이스 탈출 차단
5. **체크포인트** — 승인된 쓰기 직전 워크스페이스 스냅샷(tar.gz, 10개 유지), 원클릭 복원

자격증명은 AES-256-GCM 암호화, 재표시 없음. 잡 와치독 30분. 지출 상한(봇별 월간 토큰). 승인 10분 무응답 시 자동 거부(안전 방향).

**접근 토큰** — `OPENBOT_AUTH_TOKEN`을 설정하면 모든 `/api`·WebSocket이 Bearer 토큰을 요구합니다(LAN/VPS 노출용, 상수시간 비교). 미설정 로컬 실행은 기본 바인딩 `127.0.0.1`로 보호된 채 열려 있습니다. 웹은 로그인 화면으로 응답합니다.

### 리서치·지식

- **5단계 파이프라인**(리서처 템플릿): 문헌 조사 → 가설 → 실험 설계 → 해석(한계 명시) → 보고서
- `research.report`는 7섹션 Markdown을 워크스페이스 `research/`에 저장하고 FTS5로 색인 — 이후 대화에서 회상
- 지식베이스: 문서 청킹(800자/100 겹침) → **FTS5 + bge-m3 임베딩 하이브리드 검색**(RRF 융합) → 시스템 프롬프트 주입. 한국어 유의어("매운 국물 요리" → 김치찌개 레시피)도 의미 검색이 잡는다. 임베딩 모델 없으면 FTS-only로 폴백 — `ollama pull bge-m3`로 활성화

### 팀·이식

- `GET /api/teams/export`가 봇·채널·루틴을 Markdown+YAML로 내보냄(시크릿 자동 제거). dryRun 리뷰 후 원클릭 import — 커뮤니티 공유 형식
- 대시보드: 만족도, 도구 사용 패턴, 모델별 토큰, 채널 상태, `VACUUM INTO` 백업(10개 유지)

### 데스크톱 (Tauri v2, Rust)

`apps/desktop/src-tauri/` — Electron 대신 시스템 WebView(약 10MB). 서버를 자식 프로세스로 기동 → 트레이 상주. `cargo tauri build`로 빌드.

## 구조

```
apps/server  Hono + ws + node:sqlite (의존성 6개)
  src/agent/     프로바이더(OpenAI호환/Anthropic/Mock) + 에이전트 루프 + 압축
  src/tools/     게이트웨이(정책+감사) + 38 도구 + 동적 도구(MCP/OpenAPI/…)
  src/channels/  telegram · discord · slack · email · phone · payment
  src/computers/ local/docker/e2b/daytona/createos/boat
  src/test/matrix.ts  E2E 매트릭스 54항목
apps/web      React 18 + Vite (챗/보드/대시보드/설정/감사, Aceternity 스타일)
apps/desktop  Tauri v2 (Rust) 데스크톱 셸
docs/         API.md · DECISIONS.md · deploy-vps.md
```

- 데이터: `data/openbot.db` + `data/computers/` + `data/skills/` + `data/backups/` — 폴더 복사가 곧 백업
- 서버 의존성 6개(hono, ws, zod, …) — node:sqlite 네이티브 모듈, DB 드라이버 없음

## 검증

- **E2E 매트릭스 54항목** (`pnpm --filter @openbot/server test`): 로컬 가짜 OpenAI 서버·MCP 서버·OpenAPI 서버를 띄워 실제 HTTP로 전 회로 검증. 승인 큐, Seatbelt 차단, 인젝션 플래그, 연구 파이프라인, 채널, 백업 포함
- **유닛테스트 23건** (`pnpm --filter @openbot/server test:unit`, 77ms): cron 파서, 인젝션 가드, 지식 청킹
- WebSocket 스모크: chat.send → 스트리밍 델타 → done → 영속화
- 실모델 E2E(qwen3.5:4b): 스트리밍 + 도구 호출 + 승인 + 텔레그램 게이트웨이
- 감사 원칙: **모든 행동은 실행 전에 결정되고 실행 후에 기록된다**

### 정직한 한계 (키/환경 없이 검증 못 한 것)

- 실제 TTS 합성(ElevenLabs/OpenAI/Cartesia/Fish), Whisper 전사, Anthropic 실호출, Composio/Pipedream/Treg 실연동 — 키 필요(오류 경로만 검증)
- Docker/E2B/Daytona/CreateOS/Boat 샌드박스 — 이 머신에 Docker 미설치(상태 프로브만)
- 단일 사용자 로컬 전용 — 다중 사용자 인증 없음. LAN 노출 시 주의
- 검색 API 레이트리밋 시 DDG 결과가 일시 실패할 수 있음(curl 폴백 내장)

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md) — 개발 환경, 테스트 프로토콜, 커밋 규칙, 프로젝트 불변식(애드온 전용 마이그레이션, 신규 도구 기본 'ask', 외부 콘텐츠는 데이터).

## 라이선스

[Apache 2.0](LICENSE)

## 설계 결정 요약

- Postgres+Prisma 대신 **node:sqlite** — 네이티브 의존 0, 단일 머신 셀프호스팅에 충분
- MCP SDK 대신 **Streamable HTTP 직접 구현**(~120줄) — 의존성 최소화
- cron-parser 대신 **5필드 cron 자체 구현** — CJS/ESM interop 회피
- 자세한 이력은 [docs/DECISIONS.md](docs/DECISIONS.md)
