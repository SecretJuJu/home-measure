import { useEffect, useRef, useState } from "react";

import { AuthClient, type AccountUser } from "../../local";

export interface AccountControlProps {
  /** Injectable so tests and the workspace can share one client. */
  client?: AuthClient;
  /** Called after a sign-in or sign-out so the owner can retry the pending sync queue. */
  onAccountChange?: (user: AccountUser | null) => void;
}

type Mode = "login" | "register";

const messages: Record<string, string> = {
  invalid: "아이디는 3~32자의 영문·숫자·. _ -, 비밀번호는 10자 이상이어야 합니다.",
  taken: "이미 쓰고 있는 아이디입니다.",
  rejected: "아이디 또는 비밀번호가 맞지 않습니다.",
  offline: "서버에 연결하지 못했습니다. 실측 기록은 기기에 그대로 남아 있습니다.",
};

/**
 * Account sign-in for the field editor. The plan keeps working without an account; signing in is
 * what lets the pending queue reach the server.
 */
export function AccountControl({ client: clientProp, onAccountChange }: AccountControlProps = {}) {
  const [ownedClient] = useState(() => new AuthClient());
  const client = clientProp ?? ownedClient;
  const [user, setUser] = useState<AccountUser | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("login");
  const [draft, setDraft] = useState({ username: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    void client.currentUser().then((account) => {
      if (!active) return;
      setUser(account);
      if (account) onAccountChange?.(account);
    });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const credentials = { username: draft.username.trim(), password: draft.password };
    const outcome = mode === "register" ? await client.register(credentials) : await client.signIn(credentials);
    setBusy(false);
    if (!outcome.ok) {
      setError(messages[outcome.reason] ?? messages.rejected!);
      return;
    }
    setUser(outcome.user);
    setDraft({ username: "", password: "" });
    setOpen(false);
    onAccountChange?.(outcome.user);
  }

  async function signOut() {
    await client.signOut();
    setUser(null);
    onAccountChange?.(null);
  }

  if (user) {
    return <div className="account-control">
      <span className="account-name" title={user.username}>{user.username}</span>
      <button type="button" onClick={() => void signOut()} aria-label="로그아웃">로그아웃</button>
    </div>;
  }

  return (
    <div className="account-control">
      <button ref={triggerRef} type="button" aria-expanded={open} onClick={() => { setOpen(!open); setError(null); }} aria-label="계정 로그인">로그인</button>
      {open && (
        <form className="account-form" onSubmit={(event) => void submit(event)} aria-label={mode === "register" ? "회원가입" : "로그인"}>
          <div className="choice-row">
            <button type="button" aria-pressed={mode === "login"} className={mode === "login" ? "selected" : ""} onClick={() => { setMode("login"); setError(null); }}>로그인</button>
            <button type="button" aria-pressed={mode === "register"} className={mode === "register" ? "selected" : ""} onClick={() => { setMode("register"); setError(null); }}>회원가입</button>
          </div>
          <label>아이디<input autoComplete="username" autoCapitalize="none" spellCheck={false} value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} aria-label="아이디" /></label>
          <label>비밀번호<input type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} aria-label="비밀번호" /></label>
          {mode === "register" && <p className="account-help">아이디 3~32자, 비밀번호 10자 이상.</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-action" type="submit" disabled={busy}>{busy ? "확인 중…" : mode === "register" ? "가입하고 시작" : "로그인하고 동기화"}</button>
        </form>
      )}
    </div>
  );
}
