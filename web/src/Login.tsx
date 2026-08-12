// The password gate for the real log. Demo mode needs no login, so this is only ever
// reached deliberately - it is not a wall in front of the app.

import { useState } from "react";
import type { FormEvent } from "react";
import { login } from "./session";

export default function Login({ onCancel }: { onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
      // No navigation needed: App re-renders on the session change.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card-header">
        <div>
          <div className="card-title">Sign in</div>
          <div className="card-subtitle">Switches from the demo to the real log</div>
        </div>
      </div>
      <div className="card-body stack-sm">
        <label className="field">
          <span className="label">Password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            disabled={busy}
            onChange={(e) => { setPassword(e.target.value); setError(null); }}
          />
        </label>

        {error && <div className="banner banner-error" role="alert">{error}</div>}

        <div className="row-wrap">
          <button type="submit" className="btn btn-primary" disabled={busy || !password}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Back to the demo
          </button>
        </div>

        <p className="small muted">
          Repeated wrong guesses are rate-limited by the server, so this is slow to brute
          force on purpose.
        </p>
      </div>
    </form>
  );
}
