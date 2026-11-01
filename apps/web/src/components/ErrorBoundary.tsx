import React from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[openbot-ui] render error:", error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="app error-screen">
          <h2>화면을 그리다 문제가 생겼습니다</h2>
          <p className="muted">{this.state.error.message}</p>
          <p className="muted small">채팅 내용은 서버에 안전히 저장되어 있습니다.</p>
          <button className="btn primary" onClick={() => { this.setState({ error: null }); location.reload(); }}>
            다시 불러오기
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
