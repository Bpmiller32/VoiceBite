// One small hook instead of a data-fetching library.
//
// Six endpoints and a range query don't justify TanStack Query here, but three screens
// hand-rolling the same loading/error/stale-response dance would be worse. This is the
// middle: it tracks status, surfaces the server's error message, and - the part that's
// easy to get wrong - ignores responses from a request that's already been superseded,
// so flipping quickly between dates can't leave you looking at the wrong day's data.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export type AsyncState<T> =
  | { status: "idle"; data: null; error: null }
  | { status: "loading"; data: T | null; error: null }
  | { status: "success"; data: T; error: null }
  | { status: "error"; data: null; error: string };

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "idle", data: null, error: null });
  const [nonce, setNonce] = useState(0);

  // Monotonically increasing id - only the newest request is allowed to set state.
  const requestId = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // A request that outlives the screen it was started from must not try to set state.
  // Harmless in React 18, but it also means a 40-second call can't resurrect a tab the
  // user already navigated away from when a screen is remounted by the tab key.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const id = ++requestId.current;
    setState((prev) => ({ status: "loading", data: prev.data, error: null }));

    fnRef.current().then(
      (data) => {
        if (id !== requestId.current || !mounted.current) return;
        setState({ status: "success", data, error: null });
      },
      (err: unknown) => {
        if (id !== requestId.current || !mounted.current) return;
        const message =
          err instanceof ApiError ? err.message :
          err instanceof Error ? err.message :
          "Something went wrong";
        setState({ status: "error", data: null, error: message });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
