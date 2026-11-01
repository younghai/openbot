import React, { useEffect, useState } from "react";
import { api } from "../api";
import type { Bootstrap } from "../types";

const REMOTE_PROVIDERS = ["e2b", "daytona", "createos", "boat"];

export function Computers({ boot, refresh }: { boot: Bootstrap; refresh: () => void }): JSX.Element {
  const [registry, setRegistry] = useState<Record<string, { available: boolean; detail: string }>>({});
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"team" | "private">("team");
  const [provider, setProvider] = useState("local");
  const [image, setImage] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  useEffect(() => {
    api.computerProviders().then(setRegistry).catch(() => undefined);
  }, [boot.computers.length]);

  return (
    <div className="page">
      <h2>컴퓨터</h2>
      <p className="muted">
        봇이 작업하는 환경입니다. <b>team</b> 컴퓨터는 지정한 봇들이 공유하고, <b>private</b> 컴퓨터는 봇마다 격리된 작업 공간을 가집니다.
      </p>

      <h3>실행 환경 프로바이더</h3>
      <div className="provider-grid">
        {(Object.keys(registry).length ? Object.keys(registry) : boot.computerProviderKinds).map((kind) => {
          const st = registry[kind] ?? { available: false, detail: "확인 중" };
          return (
            <div key={kind} className={`card provider-card ${st.available ? "ok" : "off"}`}>
              <div>
                <strong>{kind}</strong> {st.available ? <span className="badge ok">사용 가능</span> : <span className="badge off">불가</span>}
              </div>
              <div className="muted small">{st.detail}</div>
            </div>
          );
        })}
      </div>

      <h3>새 컴퓨터</h3>
      <div className="card">
        <div className="form-grid">
          <label>이름</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 빌드박스" />
          <label>종류</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as "team" | "private")}>
            <option value="team">team (공유)</option>
            <option value="private">private (봇별 격리)</option>
          </select>
          <label>프로바이더</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {boot.computerProviderKinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {provider === "docker" && (
            <>
              <label>이미지</label>
              <input value={image} onChange={(e) => setImage(e.target.value)} placeholder="ubuntu:24.04" />
            </>
          )}
          {REMOTE_PROVIDERS.includes(provider) && (
            <>
              <label>API URL (선택)</label>
              <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="기본 엔드포인트 사용 시 비워둠" />
              <label>API 키</label>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="암호화 저장됨" />
            </>
          )}
        </div>
        <button
          className="btn primary"
          disabled={!name.trim()}
          onClick={async () => {
            await api.createComputer({ name, kind, provider, ...(image ? { image } : {}), ...(apiUrl ? { apiUrl } : {}), ...(apiKey ? { apiKey } : {}) });
            setName("");
            setApiKey("");
            refresh();
          }}
        >
          추가
        </button>
      </div>

      <h3>목록</h3>
      {boot.computers.length === 0 && <p className="muted">기본 Team Computer가 봇에 자동 할당됩니다.</p>}
      {boot.computers.map((c) => (
        <div key={c.id} className="card row">
          <div>
            <strong>{c.name}</strong>{" "}
            <span className={`badge ${c.kind === "team" ? "ok" : "info"}`}>{c.kind}</span>{" "}
            <span className="badge">{c.provider}</span>{" "}
            {c.status.available ? <span className="badge ok">사용 가능</span> : <span className="badge off">불가</span>}
            <div className="muted small">{c.status.detail}</div>
            {testResults[c.id] && <div className="small test-result">{testResults[c.id]}</div>}
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                const st = await api.testComputer(c.id).catch((e) => ({ available: false, detail: String(e.message ?? e) }));
                setTestResults((r) => ({ ...r, [c.id]: `${st.available ? "가능" : "불가"}: ${st.detail}` }));
              }}
            >
              테스트
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                await api.deleteComputer(c.id);
                refresh();
              }}
            >
              삭제
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
