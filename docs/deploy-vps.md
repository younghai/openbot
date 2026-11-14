# VPS 배포 가이드 — 상시 대기 (Always-On)

OpenBot은 로컬 퍼스트가 기본이지만, $5/월 VPS에 배포하면 노트북이 잠들어도 봇이 24/7 작동합니다. Telegram·Discord·Slack 채널로 원격 접속하세요.

> ⚠️ **인증 없이 공개하지 마세요.** OpenBot은 터미널 실행·파일 쓰기·파이썬 실행 도구를 가진 봇 플릿입니다. 아래 2단계의 `OPENBOT_AUTH_TOKEN` 설정이 필수이며, 가능하면 HTTPS 리버스 프록시(Caddy·nginx)를 앞에 두세요.

## 1. VPS 준비 (Ubuntu 22.04+, 1GB RAM)

```bash
ssh root@your-vps
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
```

## 2. OpenBot 배포

```bash
git clone <your-repo> openbot && cd openbot

# 접근 토큰 생성 (필수 — 웹 UI·API·WS 전부 이 토큰으로 보호됩니다)
echo "OPENBOT_AUTH_TOKEN=$(openssl rand -hex 24)" >> .env

docker compose up -d
# → http://your-vps:8940 접속 → 로그인 화면에 토큰 붙여넣기
```

토큰을 설정하면 모든 `/api` 요청과 WebSocket이 `Authorization: Bearer <토큰>`(WS는 `?token=`)을 요구합니다. 토큰이 없는 로컬 실행(`127.0.0.1` 바인딩)은 계속 열려 있습니다.

데이터는 Docker 볼륨 `openbot-data`에 저장됩니다. 백업: `docker compose exec openbot curl -X POST http://localhost:8940/api/backup`.

## 3. 채널 연결

### Telegram
```bash
# @BotFather에서 토큰 발급 후
docker compose exec openbot curl -X PUT http://localhost:8940/api/settings/credentials \
  -H 'content-type: application/json' \
  -d '{"key":"TELEGRAM_BOT_TOKEN","value":"<토큰>"}'

# 사용자 허용목록 (선택: 자신의 Telegram ID)
docker compose exec openbot curl -X PUT http://localhost:8940/api/settings/credentials \
  -H 'content-type: application/json' \
  -d '{"key":"TELEGRAM_ALLOWED_USERS","value":"<내 ID>"}'
```

### Discord
```bash
# Discord Developer Portal → Bot → Token
docker compose exec openbot curl -X PUT http://localhost:8940/api/settings/credentials \
  -H 'content-type: application/json' \
  -d '{"key":"DISCORD_BOT_TOKEN","value":"<봇 토큰>"}'
```

### Slack
```bash
# Slack App → OAuth & Permissions → Bot Token (xoxb-...)
# Slack App → Socket Mode → App Token (xapp-...)
docker compose exec openbot curl -X PUT http://localhost:8940/api/settings/credentials \
  -H 'content-type: application/json' \
  -d '{"key":"SLACK_BOT_TOKEN","value":"xoxb-..."}'
docker compose exec openbot curl -X PUT http://localhost:8940/api/settings/credentials \
  -H 'content-type: application/json' \
  -d '{"key":"SLACK_APP_TOKEN","value":"xapp-..."}'
```

## 4. 모델 연결

### 클라우드 API (권장: VPS에는 로컬 모델이 무겁다)
```bash
# OpenAI 호환 (OpenAI/Groq/OpenRouter 등)
curl -X POST http://your-vps:8940/api/providers \
  -H 'content-type: application/json' \
  -d '{"name":"openai","kind":"openai-compatible","baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","model":"gpt-4o-mini","isDefault":true}'
```

### 로컬 모델 (VPS에 Ollama 설치)
```bash
# VPS에 Ollama 설치 후
ollama pull qwen3.5:4b
# OpenBot과 같은 네트워크에서 Ollama 실행
docker run -d --name ollama -p 11434:11434 ollama/ollama
# OpenBot에서 Ollama 연결
curl -X POST http://your-vps:8940/api/providers \
  -H 'content-type: application/json' \
  -d '{"name":"ollama","kind":"openai-compatible","baseUrl":"http://ollama:11434/v1","model":"qwen3.5:4b","isDefault":true}'
```

## 5. HTTPS (선택: Caddy 리버스 프록시)

```bash
# Caddyfile
# your-domain.com {
#   reverse_proxy localhost:8940
# }
```

## 6. 로컬 상시 대기 (macOS, VPS 없이)

```bash
# 방법 1: caffeinate (터미널 잠그지 않고 절전 방지)
caffeinate -d -i -s &

# 방법 2: launchd 서비스 (백그라운드 상시)
cat > ~/Library/LaunchAgents/com.openbot.server.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.openbot.server</string>
  <key>ProgramArguments</key><array>
    <string>/Users/YOU/Downloads/openbot/node_modules/.bin/tsx</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/Downloads/openbot/apps/server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.openbot.server.plist
```

## 보안 체크리스트

- [ ] `OPENBOT_HOST=0.0.0.0` 설정 시 방화벽(ufw)에서 8940 포트를 자신의 IP만 허용
- [ ] Telegram `TELEGRAM_ALLOWED_USERS` 설정 (미설정 시 누구나 봇 사용 가능)
- [ ] Discord/Slack 봇 초대 링크는 필요한 서버로만
- [ ] 정기적 백업: `POST /api/backup` → `data/backups/` 확인
