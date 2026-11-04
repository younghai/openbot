# OpenBot API contract (server on :8787)

Base URL `/api`. All responses JSON unless noted. Postgres-free: node:sqlite at repo `data/openbot.db`.

## REST

- `GET /api/health` → `{ok, version}`
- `GET /api/bootstrap` → `{ bots, conversations, channelMembers, computers, providers, toolSources, routines, jobs, skills, credentials, computerProviderKinds }`
  - bot: `{id, name, emoji, persona, provider_id, computer_id, tts_provider, status: 'active'|'paused', created_at}`
  - conversation: `{id, kind: 'dm'|'channel', title, bot_id, created_at}`
  - channelMembers: `[{conversation_id, bot_id}]`
  - computer: `{id, name, kind:'team'|'private', provider:'local'|'docker'|'e2b'|'daytona'|'createos'|'boat', config, created_at, status:{available, detail}}`
  - provider: `{id, name, kind:'openai-compatible'|'anthropic'|'mock', base_url, model, is_default, hasKey}`
  - toolSource: `{id, name, kind:'mcp'|'openapi'|'composio'|'pipedream'|'treg', config, enabled, status, status_detail, tools: string[]}`
  - routine: `{id, bot_id, name, cron, prompt, enabled, last_run_at, failure_count}`
  - job: `{id, bot_id, conversation_id, prompt, source:'user'|'routine', status:'pending'|'running'|'done'|'cancelled'|'error', created_at}`
  - skills: `[{name, description}]`, credentials: `[{key, present}]`
- `POST /api/bots` `{name, emoji?, persona?, providerId?, computerId?, ttsProvider?}` → 201 `{id, conversationId}`
- `PATCH /api/bots/:id` `{name?, emoji?, persona?, providerId?, computerId?, ttsProvider?, status?}` (status 'paused' holds its queue)
- `DELETE /api/bots/:id`
- `GET /api/bots/:id/memories` → `[{id, bot_id, content, created_at}]`; `DELETE /api/memories/:id`
- `POST /api/conversations` `{kind:'dm', botId}` | `{kind:'channel', title, botIds:[]}` → `{id,...}`
- `GET /api/conversations/:id/messages` → `[{id, conversation_id, bot_id, role:'user'|'assistant'|'tool'|'system', content, tool_name, tool_args(json str), tool_result(json str), meta(json str), created_at}]`
- `POST /api/conversations/:id/messages` `{content}` → 202 `{jobId}`
- `GET /api/queue`; `POST /api/queue/:id/cancel` → `{ok}`
- `GET /api/audit?limit=&botId=` → `[{id, bot_id, conversation_id, tool, args, decision:'allow'|'deny'|'error', detail, created_at}]`
- `POST /api/computers` `{name, kind, provider, image?, apiUrl?, apiKey?}` → 201; `DELETE /api/computers/:id`; `POST /api/computers/:id/test` → `{available, detail}` (503 when unavailable)
- `GET /api/computer-providers` → `{local:{available,detail}, docker:{...}, e2b, daytona, createos, boat}`
- `POST /api/providers` `{name, kind:'openai-compatible'|'anthropic'|'mock', baseUrl?, apiKey?, model, isDefault?}`; `PATCH /api/providers/:id`; `DELETE /api/providers/:id`; `POST /api/providers/:id/test` → `{ok, model, reply}` | 502 `{ok:false, error}`
- `POST /api/tool-sources` `{name, kind, url?|specUrl?|spec?|baseUrl?|apiKey?|authType?|headerName?}` → `{id, status, detail, tools}`; `POST /api/tool-sources/:id/refresh`; `DELETE /api/tool-sources/:id`
- `POST /api/routines` `{botId, cron, prompt, name?}`; `PATCH /api/routines/:id` `{enabled?, prompt?}`; `DELETE /api/routines/:id`
- `GET /api/skills`
- `GET /api/settings` → `{credentials:[{key,present}]}`; `PUT /api/settings/credentials` `{key, value}` (value empty string deletes)
- `POST /api/voice/tts` `{text, provider:'elevenlabs'|'openai'|'cartesia'|'fish'|'browser', voice?}` → audio bytes | 400 `{error, fallback:'browser'}`
- `POST /api/voice/stt` multipart `file` → `{text}` | 400 `{error, hint}`
- `GET /api/media/<file>` → screenshot png (path comes from desktop.screenshot tool results, meta.attachments)

## WebSocket `/ws`

Client → server:
- `{type:'ping'}`
- `{type:'chat.send', conversationId, content}`

Server → client:
- `{type:'hello', version}`
- `{type:'pong'}`
- `{type:'chat.accepted', jobId, conversationId}`
- `{type:'chat.message', conversationId, botId, role:'user'|'assistant', content}` (persisted messages incl. other conversations — filter by conversationId)
- `{type:'delta', botId, conversationId, text, jobId}` (streaming deltas)
- `{type:'tool_start', botId, conversationId, tool, args, jobId}` / `{type:'tool_end', ..., result}`
- `{type:'chat.error', jobId, conversationId, error}`
- `{type:'queue.update', job:{...}}`

## Voice UI contract

- Dictation: browser Web Speech API (`webkitSpeechRecognition`, lang ko-KR default) — no key needed. Server STT only when OPENAI_API_KEY stored.
- Speak replies: `POST /api/voice/tts` with the bot's `tts_provider`; on HTTP 400 body `{fallback:'browser'}` → use `speechSynthesis`. Play returned audio via `<audio>` blob URL.
- Call mode: continuous loop — dictate → send → on final assistant message for that jobId → speak → listen again. Stop button exits.

## Model presets

- `GET /api/presets` — 모델 프리셋 목록 (데이터 레지스트리 `apps/server/src/presets.ts`).
- `GET /api/presets/:id/models` — 프리셋의 설치된 모델 목록. 현재 Ollama(`/api/tags` 프록시, capabilities 포함)만 자동 발견 지원.

OpenAI 호환 provider는 SSE 스트리밍으로 응답하며(비스트리밍 응답도 수용), tool_calls 델타 조각을 서버에서 조립합니다.

## Tool approvals

- `GET /api/approvals?status=pending|approved|denied|expired` — 승인 요청 목록 (최신 200건).
- `POST /api/approvals/:id/approve` / `POST /api/approvals/:id/deny` — 대기 중 요청 결정. 이미 결정된 요청은 409.
- `GET /api/tool-policies` — 도구별 allow/ask 정책 (`tool_policies` 테이블. 행이 없는 도구는 기본 'ask').
- WS 이벤트: `approval.requested {approval}` · `approval.decided {id, status}`.
- 미결 요청은 10분 후, 서버 재시작 시 만료(=거부) 처리된다. 부작용 도구 목록과 흐름은 README "도구 승인 큐" 참고.

## Tool source catalog + stdio MCP

- `GET /api/tool-catalog` — 원클릭 등록용 카탈로그(Context7·DeepWiki HTTP 키불필요, filesystem·fetch·memory·sequential-thinking stdio).
- `POST /api/tool-sources` 확장: `transport:"stdio"` + `command`/`args`/`env` 로 npx 방식 MCP 공식 서버를 로컬 자식프로세스로 실행한다(라인 구분 JSON-RPC, rpc 60초 타임아웃, 서버 종료 시 자식 정리). 기본 transport는 http(`url` 사용).

## Daily-use additions (2026-10-31)

- `GET /api/tool-policies/presets` — 정책 프리셋 목록 + 현재 매칭 프리셋(derive). `POST /api/tool-policies/presets/:id/apply` — safe | workshop | lock​ed 적용.
- `POST /api/media/attachments` — multipart `file` (이미지 전용, 최대 10MB). `{path,url,name,contentType}` 반환.
- `POST /api/conversations/:id/messages` 확장 — `attachments: [{path,name,contentType}]` (최대 4). 이미지는 멀티모달(image_url)로 공급자에게 전달됨.
- 신규 도구: `search.web {query}` (키 불필요, 읽기 전용 정책).
- WS 이벤트 추가: `thinking {botId, conversationId, chars}` — reasoning 누적 글자수.

## Work management + platform (2026-10-31 2차)

- Tasks: `POST /api/tasks` {title, detail?, assigneeBotId?, dueAt?} · `GET /api/tasks` · `PATCH /api/tasks/:id` {status? backlog|doing|review|done, assigneeBotId?, title?, detail?, dueAt?} · `DELETE /api/tasks/:id` · `POST /api/tasks/:id/run` — 담당 봇 큐로 작업 전달(봇은 `task.update` 도구로 상태 보고).
- `GET /api/search?q=` — 대화 메시지·봇·메모리·작업 통합 검색(LIKE).
- `GET /api/stats` — 봇별 메시지/도구호출/토큰/루틴/24h 잡 + 전체 요약.
- `POST /api/backup` — SQLite `VACUUM INTO` 백업(data/backups/, 최근 10개 유지).
- Notifications: `GET /api/notifications?unread=1` · `POST /api/notifications/read-all`. WS 이벤트 `task.updated`, `notification.new`. 모든 WS 이벤트에 `v:1` 스키마 버전.
- `GET /api/conversations/:id/messages?before=<created_at>&limit=` — 커서 페이지네이션(기본 최신 60건).
- 라우트는 `apps/server/src/routes/` 도메인별 7파일로 분할, mutation 입력은 zod 검증, 서버 onError가 예외를 로깅 후 500 반환.

## QwenPaw-inspired additions (2026-10-31 3차)

- Files: `GET /api/files?scope=memory|workspace&computerId=&path=` · `GET /api/files/content?...` (텍스트 JSON 또는 이미지 바이너리) · `PUT /api/files/content` — 워크스페이스/메모리 브라우저·편집(경로 이탈 400).
- Checkpoints: `GET /api/checkpoints` · `POST /api/checkpoints/:id/restore` (파괴적: 스냅샷 시점으로 교체) · `DELETE /api/checkpoints/:id`. 승인된 terminal.exec/fs.write 직전 자동 생성.
- `GET /api/search` 응답에 `memoryFiles: [{path, snippet}]` 추가 (data/memory 파일 색인).
- 신규 도구: `memory.read {path?}` · `memory.write {path, content}` (봇 전용 메모리 디렉터리 스코프). 정책 allow.
- 명령 가드: terminal.exec가 위험 패턴(sudo, rm -rf /, mkfs, dd of=/dev/, curl|sh, 포크폭탄, shutdown 등)을 ToolDenial로 차단 — 감사 decision=deny.
- Telegram: `TELEGRAM_BOT_TOKEN` 자격증명 저장 시 게이트웨이 자동 기동(getUpdates 롱폴, /start 바인딩, 승인 인라인 버튼 `tg:ap:<id>`/`tg:dn:<id>`).

## Native desktop computer-use (2026-11-01)

- 신규 도구: `desktop.list_apps {}` · `desktop.snapshot {app, windowId?, root?, skeleton?, waitFor?}` · `desktop.act {action, ref|combo|app, text?, waitFor?}` — agent-desktop(accessibility tree) 래핑. 정책: 관찰 allow / 조작 ask.
- 에러 계약: 도구 실패 메시지에 `[CODE · 재시도 안전/위험 — 제안]` 힌트(retryHint). STALE_REF/AMBIGUOUS_TARGET은 재스냅샷 안내 포함.
- 부팅 시 고아 running 잡 → `error(interrupted by server restart)` 복구.

## Security hardening (2026-11-04, deepseek-bot patterns)

- 인젝션 게이트: 외부 도구 결과에 `_contentBoundary` 상시, 지시문 패턴 시 `_injectionFlagged`·`_injectionWhy[]` 추가(모양 보존).
- `POST /api/conversations/:id/messages` 응답 확장: 스티어링 단어 처리 시 `{jobId: null, steered: "steered_stop"|"steered_usage"|"steered_mute"|"steered_unmute"}`. WS 이벤트 `chat.steered`.
- 로컬 터미널은 sandbox-exec denylist 하에 실행(해제 `OPENBOT_DISABLE_SANDBOX=1`). 텔레그램 `TELEGRAM_ALLOWED_USERS` 자격증명으로 사용자 제한.
