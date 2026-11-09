# 결정 기록

| 결정 | 이유 | 기각한 대안 |
|---|---|---|
| node:sqlite 사용 | Docker 없는 머신에서 Postgres 불가, better-sqlite3는 네이티브 빌드 리스크 | Postgres+Prisma(rakazo 스택), better-sqlite3 |
| 포트 기본 8940 | 8787/8788이 로컬 다른 서비스와 충돌(실측) | 8787 |
| MCP 클라이언트 직접 구현 | SDK 의존성 제거, Streamable HTTP는 JSON-RPC+SSE로 충분 | @modelcontextprotocol/sdk |
| cron 자체 구현 | cron-parser CJS→ESM 네임드 임포트 런타임 실패(실측) | cron-parser 유지 + createRequire |
| mock 프로바이더 내장 | 키 없이도 전체 도구 회로를 실행·검증할 수 있어 "작동 증명"이 가능 | 키 없으면 앱 비동작 |
| 도구 게이트웨이 단일 진입(정책+감사) | CopilotKit OpenBot 패턴: allow/deny/error 전부 audit 행으로 | 도구별 개별 처리 |
| 자식 서버는 프로세스 그룹 kill | npx 래퍼만 죽이면 tsx 자식이 살아 좀비가 되어 다음 테스트를 오염시킴(실측 사고) | npx spawn + 단일 kill |
| UI를 서브에이전트 위임하지 않고 직접 구현 | 이 세션에서 Agent 도구 디스패치 실패(structured-dispatch-required) | 병렬 서브에이전트 |
| 델타 스트리밍은 WS 단방향 브로드캐스트 | 채널/위임/루틴 이벤트도 같은 파이프로 전달되어 UI 단순 | SSE per-request |
| 원격 샌드박스(e2b 등)는 공용 exec 프로토콜 추상화 | 실제 API 명세가 제각각이라 execPath/apiUrl 주입형으로 확장점만 제공 | 벤더별 전용 SDK |
| 승인 대기는 executeTool 안에서 promise 블록 | gateway가 단일 choke point라 정적·동적·위임 도구가 같은 게이트를 지님; 해당 봇의 FIFO 잡만 대기 | 잡 상태 머신에 승인 단계 추가, 도구별 사전 체크 분산 |
| OpenAI 호환 SSE 직접 파싱(tool_calls 조각 조립) | 로컬 모델은 느려서 델타 스트리밍이 UX 필수; 비스트리밍 응답은 폴백으로 수용 | SDK 의존 추가, 비스트리밍 유지 |
| 미결 승인은 만료(=거부)가 안전 방향 | 재시작 후 대기 없는 승인은 무인 실행 허용과 같음 | 재시작 후 재대기, 자동 승인 |
| 샌드박스 deny는 regex+realpath로만 | 실측: darwin 25에서 subpath file-read* deny 무시, /var firmlink로 /var/... regex 미매치 | subpath deny, symlink 경로 그대로 |
| 외부 콘텐츠는 경계+플래그 | 도구 게이트는 실행 전이고 인젝션은 컨텍스트 오염이라 별도 게이트 필요(deepseek-bot injection.ts) | 외부 콘텐츠 차단, 모델에게만 맡김 |
| 데스크톱 셸은 Tauri v2(Rust) | Electron 대비 10% 크기(10MB vs 200MB), 시스템 WebView 사용, Rust 방향성과 일치 | Electron(JS 200MB), egui(웹 UI 재사용 불가) |
| 학술 검색은 arXiv Atom + PubMed E-utilities 직접 파싱 | 키 불필요·XML 파싱은 의존 없이 regex로 충분 | Semantic Scholar API(키 필요), Crossref(무겁다) |
| 논문 초록은 인젝션 가드 대상 | 외부 텍스트에 지시문이 숨을 수 있음(실측: fixture ReMe 논문에 "Ignore instructions" 포함) | 초록 그대로 전달 |
