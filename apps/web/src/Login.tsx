import { useState } from "react";

export interface LoginProps {
  onLogin: (token: string) => Promise<void>;
  error: string | null;
}

export function Login(props: LoginProps): React.JSX.Element {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? props.error;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setLocalError("请输入令牌");
      return;
    }
    setLocalError(null);
    setBusy(true);
    try {
      await props.onLogin(trimmed);
    } catch {
      // The error message is rendered via props.error; swallow the rethrow.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <h1>PI-Web</h1>
        <p className="login-hint">
          在公司 Mac 上运行 pi-host（Web 模式）后，从其终端输出中复制令牌。
          一次性配对令牌以 <code>ppt1.</code> 开头（启动时加 <code>--pair</code> 打印）；设备令牌以 <code>pdt1.</code> 开头。
        </p>
        <input
          className="login-input"
          type="password"
          value={token}
          placeholder="pdt1.… 或 ppt1.…"
          autoComplete="off"
          autoFocus
          spellCheck={false}
          onChange={(event) => setToken(event.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || token.trim().length === 0}>
          {busy ? "登录中…" : "登录"}
        </button>
        {error ? <p className="login-error" role="alert">{error}</p> : null}
      </form>
    </div>
  );
}
