// The shell: navigation, the selected date, and the two things that must not be able to
// take the whole app down (a screen that throws, and a Pi that is offline).
//
// There is no router. Four views do not justify a dependency, but "no router" must not
// mean "reload loses your place and the back gesture leaves the app" - on a phone that is
// the difference between a tool and a toy. So the tab lives in `location.hash`, which
// gives us deep links (#/history), a working back button, and reload-stability for free.

import { Component, useCallback, useEffect, useState, lazy, Suspense } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { api, toDateString, USER } from "./api";
import { hydrateGoals } from "./goals";
import { resolveSession, useSession, logout } from "./session";
import Login from "./Login";
import type { DayLog } from "./types";
import LogScreen from "./LogScreen";
import TodayScreen from "./TodayScreen";
// History is the only screen that pulls in Recharts, which is ~90% of the JS bundle.
// Loading it on demand means opening the app to Log or Today - the everyday path -
// no longer waits on a charting library the user hasn't asked for yet.
const HistoryScreen = lazy(() => import("./HistoryScreen"));
import Settings from "./Settings";

const TABS = ["log", "today", "history", "settings"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  log: "Log",
  today: "Today",
  history: "History",
  settings: "Settings",
};

/** Read the tab out of the address bar, falling back to Today for junk or an empty hash. */
function tabFromHash(): Tab {
  const raw = window.location.hash.replace(/^#\/?/, "");
  return (TABS as readonly string[]).includes(raw) ? (raw as Tab) : "today";
}

export default function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [date, setDate] = useState<string>(() => toDateString());

  // Bumped whenever a write lands, so Today refetches instead of showing the copy it
  // fetched before the save. Cheaper and more predictable than lifting the day's log here.
  const [refreshKey, setRefreshKey] = useState(0);

  const [serverDown, setServerDown] = useState(false);
  const [healthDismissed, setHealthDismissed] = useState(false);
  const session = useSession();
  const [showLogin, setShowLogin] = useState(false);
  const [demoNoticeDismissed, setDemoNoticeDismissed] = useState(false);

  // Close the login form the moment the session flips to real. Login itself doesn't
  // navigate - it only updates the session - so this is what makes the form disappear.
  useEffect(() => {
    if (session.mode === "real") setShowLogin(false);
  }, [session.mode]);

  useEffect(() => {
    // Normalize whatever was in the bar ("", "#", "#/nope") to the tab we actually
    // rendered. replaceState rather than assigning to location.hash: this is a
    // correction, not navigation, and it should not become a back-button stop.
    window.history.replaceState(null, "", `#/${tabFromHash()}`);

    const onHashChange = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    // One health probe at startup. Without it, an offline Pi and an empty log day look
    // identical - both are "no food here" - and that ambiguity wasted real time before.
    let cancelled = false;
    // Work out whether we're signed in before anything tries to fetch. Goals only make
    // sense once we know - an unauthenticated hydrate would just 401.
    resolveSession().then(() => hydrateGoals());
    api.health().then(
      () => { if (!cancelled) setServerDown(false); },
      () => { if (!cancelled) setServerDown(true); },
    );
    return () => { cancelled = true; };
  }, []);

  const go = useCallback((next: Tab) => {
    setTab(next);
    // Assigning to location.hash pushes a history entry, which is what makes the phone's
    // back gesture return to the previous tab instead of leaving the app.
    window.location.hash = `#/${next}`;
  }, []);

  const handleSaved = useCallback((log: DayLog) => {
    // Trust the saved log's own date over the one the picker was showing. A save can land
    // on a different day than the tab had selected, and jumping to Today for the wrong
    // date reads as "the food I just logged vanished".
    setDate(log.date);
    setRefreshKey((k) => k + 1);
    go("today");
  }, [go]);

  const handlePickDate = useCallback((picked: string) => {
    setDate(picked);
    go("today");
  }, [go]);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">VoiceBite</span>
        <nav className="nav" aria-label="Views">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              className={t === tab ? "nav-btn is-active" : "nav-btn"}
              aria-current={t === tab ? "page" : undefined}
              onClick={() => go(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      </header>

      <main className="main">
        <div className="stack">
          {serverDown && !healthDismissed && (
            <div className="banner banner-warn" role="status">
              <span aria-hidden="true">⚠</span>
              <div className="stack-sm">
                <strong>Can't reach the server.</strong>
                <span className="small">
                  Nothing below is necessarily empty — it just could not be loaded. Check that
                  the Pi is online, then reload.
                </span>
              </div>
              <div className="spacer" />
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                onClick={() => setHealthDismissed(true)}
                aria-label="Dismiss server warning"
              >
                ✕
              </button>
            </div>
          )}

          {showLogin && session.mode !== "real" && (
            <Login onCancel={() => setShowLogin(false)} />
          )}

          {/* Keyed by tab so a crash on one screen is cleared by navigating away, and so
            * each screen remounts (and refetches, and re-reads saved goals) on return. */}
          {session.mode === "demo" && !showLogin && !demoNoticeDismissed && (
            <div className="banner banner-info" role="status">
              <span aria-hidden="true">◆</span>
              <div className="stack-sm">
                <strong>You're in the demo.</strong>
                <span className="small">
                  Three months of sample data, and the voice parsing is live — describe a meal
                  and Claude really does read it. Nothing here is saved past this tab.
                </span>
              </div>
              <div className="spacer" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDemoNoticeDismissed(true)}>
                Got it
              </button>
            </div>
          )}

          <ErrorBoundary key={`${tab}:${session.mode}`}>
            {session.mode !== "loading" && tab === "log" && <LogScreen date={date} onSaved={handleSaved} />}
            {session.mode !== "loading" && tab === "today" && (
              <TodayScreen date={date} onDateChange={setDate} refreshKey={refreshKey} />
            )}
            {session.mode !== "loading" && tab === "history" && (
              <Suspense
                fallback={
                  <div className="card">
                    <div className="card-body">
                      <div className="skeleton" style={{ height: 220 }} />
                    </div>
                  </div>
                }
              >
                <HistoryScreen onPickDate={handlePickDate} />
              </Suspense>
            )}
            {session.mode !== "loading" && tab === "settings" && <Settings />}
          </ErrorBoundary>
        </div>
      </main>

      <footer className="footer">
        {session.mode === "real" ? (
          <span>
            VoiceBite — logged as <span className="mono">{session.userId ?? USER}</span>
            {" · "}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { logout(); setShowLogin(false); }}>
              Sign out
            </button>
          </span>
        ) : (
          <span>
            VoiceBite — <span className="badge">demo</span>
            {!showLogin && (
              <>
                {" · "}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowLogin(true)}>
                  Sign in
                </button>
              </>
            )}
          </span>
        )}
      </footer>
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

/**
 * The one class component in the app - React still has no hook equivalent for
 * componentDidCatch. It exists so a rendering bug in one screen degrades to a card you
 * can navigate away from, instead of a white page with the data seemingly gone.
 */
class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Single-user app on a Pi - there is no error reporting service, the console is the
    // log. The component stack is the useful half, so keep it.
    console.error("VoiceBite screen crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="card">
        <div className="card-header">
          <span className="card-title">This screen hit an error</span>
        </div>
        <div className="card-body stack">
          <div className="banner banner-error">
            <span className="mono">{error.message || "Unknown error"}</span>
          </div>
          <p className="small muted">
            Nothing you logged was lost — this is a display bug, and the other tabs still
            work. If it repeats, the console has the component stack.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
