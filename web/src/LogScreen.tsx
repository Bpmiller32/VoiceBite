// LogScreen - capture what you ate, review what Claude made of it, save it.
// This is the only screen in the app that creates data.
//
// The rule everything here bends around: THE TEXTAREA IS THE SOURCE OF TRUTH.
// Speech recognition is an input method that types into the box; it is never a separate
// pipeline. Whatever is in the box at submit time is exactly what gets sent, which is why
// there is no "spellcheck pass" - seeing and fixing the transcript before you spend a
// 15-40 second paid model call IS the spellcheck feature.
//
// Second rule: the user's words survive every failure. Nothing clears the textarea except
// a successful save. A dictated paragraph lost to a 429 is the worst outcome this screen has.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, shiftDate, toDateString } from "./api";
import { fmt, NUTRIENT_META, NUTRIENT_KEYS } from "./types";
import type { DayLog, FoodEntry, LogPreviewResponse, LogCostSummary, Nutrients, NutrientKey, ParsedFood } from "./types";

/* ------------------------------------------------------------------ */
/* Web Speech API types                                                */
/* TypeScript's DOM lib doesn't ship these and we're not adding a      */
/* package for four interfaces. Only the members actually used.        */
/* ------------------------------------------------------------------ */

interface SpeechAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternative;
}
interface SpeechResultList {
  readonly length: number;
  readonly [index: number]: SpeechResult;
}
interface SpeechResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechResultList;
}
interface SpeechErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}
interface SpeechRecognizer extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognizerCtor = new () => SpeechRecognizer;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognizerCtor;
    webkitSpeechRecognition?: SpeechRecognizerCtor;
  }
}

// Resolved once at module load. Chrome and Safari expose it under different names;
// Chrome and Firefox *on iOS* are Safari webviews without it, so they land here as
// undefined rather than failing later with service-not-allowed.
const RecognizerImpl: SpeechRecognizerCtor | undefined =
  typeof window === "undefined" ? undefined : window.SpeechRecognition ?? window.webkitSpeechRecognition;

/* ------------------------------------------------------------------ */
/* Editing model                                                       */
/* ------------------------------------------------------------------ */

// `satisfies` keeps these honest against NUTRIENT_KEYS - a typo here would otherwise
// only surface as an undefined lookup in NUTRIENT_META at render time.
const MACRO_KEYS = ["calories", "protein_g", "fat_g", "carbs_g"] as const satisfies readonly NutrientKey[];

// Draft fields are strings, not numbers, because an in-progress edit ("1.", "") is not a
// number yet, and - more importantly - an empty field has to survive round-trips as null
// (unknown) rather than collapsing to 0 (contains none). Those are different facts.
interface Draft {
  food_name: string;
  serving_description: string;
  /**
   * Every nutrient, not just the four macros.
   *
   * The old version held only MACRO_KEYS, which meant correcting a calorie figure left
   * the other 25 values exactly as estimated - so fixing Texas toast from 320 to 150
   * kept its 530 mg of sodium and made the entry MORE internally inconsistent than
   * before the correction. Fourteen percent of the fields were editable; the rest were
   * along for the ride.
   */
  macros: Record<NutrientKey, string>;
}

function draftFromEntry(entry: FoodEntry): Draft {
  return {
    food_name: entry.food_name,
    serving_description: entry.serving_description,
    macros: macroStrings(entry.nutrients),
  };
}

function macroStrings(nutrients: Nutrients): Record<NutrientKey, string> {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((key) => [key, numToField(nutrients[key])]),
  ) as Record<NutrientKey, string>;
}

/**
 * The nutrients worth offering to edit beyond the four macros.
 *
 * Not all 29 - a phone form with 29 numeric inputs is not a correction affordance, it is a
 * data-entry chore nobody will use. These are the ones printed on a label, so they are the
 * ones you can actually check against the packet in your hand.
 */
const LABEL_KEYS = [
  "fiber_g", "sugar_g", "saturated_fat_g", "sodium_mg", "cholesterol_mg",
  "potassium_mg", "calcium_mg", "iron_mg", "vitamin_d_mcg", "caffeine_mg",
] as const satisfies readonly NutrientKey[];

/** null (unknown) becomes an empty field. 0 stays "0" - it means "contains none". */
function numToField(value: number | null): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Empty or unparseable field means unknown. Deliberately never returns 0 for "". */
function fieldToNum(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Merge the string drafts back onto the session entries the server will accept. */
function mergeDrafts(entries: FoodEntry[], drafts: Record<string, Draft>): FoodEntry[] {
  return entries.map((entry) => {
    const draft = drafts[entry.id];
    if (!draft) return entry;
    const nutrients: Nutrients = { ...entry.nutrients };
    for (const key of NUTRIENT_KEYS) nutrients[key] = fieldToNum(draft.macros[key]);
    return {
      ...entry,
      food_name: draft.food_name.trim() || entry.food_name,
      serving_description: draft.serving_description.trim() || entry.serving_description,
      nutrients,
    };
  });
}

/**
 * What to send to /estimate for a row. `entry.parsed` is the structured form Claude
 * pulled out of the sentence and is always the better seed; falling back to splitting
 * "1.5 cups" out of the serving text is for rows that predate it or were hand-edited.
 */
function estimateSeed(entry: FoodEntry, draft: Draft): ParsedFood {
  const name = draft.food_name.trim() || entry.food_name;
  const serving = draft.serving_description.trim();
  const match = /^\s*(\d+(?:\.\d+)?)\s*(.*)$/.exec(serving);
  const fallbackQty = match ? Number(match[1]) : entry.parsed?.quantity ?? 1;
  const fallbackUnit = match && match[2].trim() ? match[2].trim() : entry.parsed?.unit ?? "serving";

  // If the user edited the serving, honor the edit over the original parse.
  const servingEdited = serving !== entry.serving_description;
  if (entry.parsed && !servingEdited) {
    return { name, quantity: entry.parsed.quantity, unit: entry.parsed.unit };
  }
  return { name, quantity: fallbackQty > 0 ? fallbackQty : 1, unit: fallbackUnit };
}

/** Append a final speech chunk to whatever is already in the box, spacing it sanely. */
function appendSpoken(existing: string, chunk: string): string {
  const piece = chunk.trim();
  if (!piece) return existing;
  if (!existing) return piece;
  return /\s$/.test(existing) ? existing + piece : `${existing} ${piece}`;
}

function prettyDate(date: string): string {
  // Noon avoids the UTC-parse-shifts-a-day trap that bit the old date picker.
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  const long = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  // Naming the day matters more here than anywhere else in the app: this is the one screen
  // that writes data, and "Sunday, August 3" alone does not tell you it isn't today.
  const today = toDateString();
  if (date === today) return `Today · ${long}`;
  if (date === shiftDate(today, 1)) return `Tomorrow · ${long}`;
  if (date === shiftDate(today, -1)) return `Yesterday · ${long}`;
  return long;
}

/** Human copy for a speech error. `fatal` means we stop rather than silently retry. */
function speechErrorMessage(code: string): { message: string; fatal: boolean } {
  switch (code) {
    case "not-allowed":
      return {
        message:
          "Microphone access is blocked. Allow it for this site in your browser settings (tap the address bar's site icon), then try again.",
        fatal: true,
      };
    case "service-not-allowed":
      return {
        message:
          "This browser won't run speech recognition. On iPhone, Safari is the one that supports the mic — or just type it below.",
        fatal: true,
      };
    case "audio-capture":
      return { message: "No microphone found. Plug one in or type what you ate below.", fatal: true };
    case "network":
      return {
        message: "Speech recognition couldn't reach its network service. Typing still works.",
        fatal: true,
      };
    case "no-speech":
      return { message: "I didn't hear anything yet — still listening.", fatal: false };
    case "aborted":
      return { message: "Recording was interrupted. Tap the mic to pick it back up.", fatal: true };
    default:
      return { message: `Speech recognition stopped (${code}). You can type instead.`, fatal: true };
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

const MAX_TEXT = 8000; // mirrors the server's cap; checked here to avoid a doomed round trip
/**
 * The stages of a log, and when to claim each one.
 *
 * These thresholds come from the real request timeline, not from taste. Measured across
 * 38 logs: the wait is BIMODAL. Either the model reads the sentence and we are done in
 * 4-15s, or a published-label lookup fires and it takes 76-80s. Nothing has ever landed
 * between 15.1s and 76.5s, because the branch is a server-side decision the client cannot
 * see - the same sentence took 80.0s and then 8.8s two minutes later.
 *
 * The old bar was paced to a single 32-second constant that describes none of that. On a
 * fast log it promised 32s and finished in 8; on a slow one it hit 95% at 30s and then sat
 * motionless for another 45. A bar that stops moving is what makes a working app feel
 * broken, so the stages below never claim to be nearly done - they say what is happening.
 *
 * `until` is the elapsed second at which we stop claiming this stage. The last has none.
 */
const STAGES: Array<{ until?: number; label: string; detail?: string }> = [
  { until: 3, label: "Sending to the Pi" },
  { until: 16, label: "Reading what you said", detail: "working out the foods and portions" },
  // Past ~16s the fast path would have returned, so a lookup is running. This is an
  // inference, not a server signal - the copy is hedged accordingly.
  { until: 80, label: "Looking up the published label", detail: "checking the real nutrition facts" },
  { label: "Still going", detail: "this one is taking longer than usual" },
];

/** The server's own hard ceiling (VOICEBITE_BUDGET_MS), so the bar can be truthful. */
const SERVER_BUDGET_S = 80;
const MAX_SILENT_RESTARTS = 8; // ~a minute of silence before the mic gives up on its own

// The unsaved textarea, kept outside React so it survives this component's lifetime.
// "Nothing clears the textarea except a successful save" was not actually true: the tab
// bar unmounts this screen, so glancing at Today mid-sentence dropped everything typed,
// and iOS Safari discarding a backgrounded tab did the same to a dictated paragraph.
const DRAFT_KEY = "voicebite.draft.v1";

/**
 * The un-confirmed review, kept outside React so it survives this screen unmounting.
 *
 * App.tsx renders LogScreen only while the Log tab is active, so tapping Today or History
 * destroys every useState in here. During capture that costs nothing - the text box
 * already persists separately. After a parse it costs a completed, paid model call plus
 * every hand edit made since, and the server session it refers to becomes unreachable:
 * nothing lists pending sessions, so those results are simply abandoned.
 *
 * sessionStorage rather than localStorage: a pending review is meaningful for this browser
 * session only. The server expires the session after 30 minutes anyway, and confirm()
 * already handles that with "That session expired - please re-submit".
 */
const REVIEW_KEY = "voicebite.review.v1";

interface StoredReview {
  preview: LogPreviewResponse;
  /**
   * The working set, which is NOT the same as preview.entries once rows have been removed.
   * Restoring from preview.entries would resurrect rows you had already deleted.
   */
  entries: FoodEntry[];
  drafts: Record<string, Draft>;
  date: string;
}

function loadReview(date: string): StoredReview | null {
  try {
    const raw = sessionStorage.getItem(REVIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredReview;
    // A review belongs to the day it was parsed for. Restoring Tuesday's pending items
    // onto Wednesday would silently file food against the wrong date.
    if (!parsed?.preview?.sessionId || parsed.date !== date) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveReview(review: StoredReview | null): void {
  try {
    if (review) sessionStorage.setItem(REVIEW_KEY, JSON.stringify(review));
    else sessionStorage.removeItem(REVIEW_KEY);
  } catch {
    /* quota or private browsing - in-memory state is still authoritative */
  }
}

function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return ""; // private browsing - the session still works, it just can't be resumed
  }
}

export default function LogScreen({ date, onSaved }: { date: string; onSaved: (log: DayLog) => void }) {
  const [text, setText] = useState(loadDraft);
  const [interim, setInterim] = useState("");
  const [recording, setRecording] = useState(false);
  const [speechNote, setSpeechNote] = useState<string | null>(null);

  const [parsing, setParsing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);

  // Seeded from sessionStorage so a pending review survives a trip to Today or History.
  // Without this, leaving the Log tab mid-review threw away a completed paid call.
  const restored = useRef(loadReview(date)).current;
  const [preview, setPreview] = useState<LogPreviewResponse | null>(restored?.preview ?? null);
  const [entries, setEntries] = useState<FoodEntry[]>(restored?.entries ?? []);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(restored?.drafts ?? {});
  const [removed, setRemoved] = useState<{ entry: FoodEntry; draft: Draft; index: number }[]>([]);
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ code: string; message: string } | null>(null);

  const inFlight = useRef(false); // guards double-submit: there's no idempotency key, a
  const textRef = useRef(text); //  double tap is a second paid call
  textRef.current = text;

  // Exactly the characters that went to the parser. A save clears only this prefix rather
  // than the whole box, because the box does not stop accepting input at submit time: the
  // capture view stays live for the 15-40 seconds a parse takes, and stop() still delivers
  // one last final speech result after the mic is closed. Both used to be wiped by the
  // blanket setText(""), which is the one thing this screen must never do to your words.
  const submittedRef = useRef("");

  /** Write the draft through to storage now, rather than waiting for the effect below. */
  const persistDraft = useCallback((value: string) => {
    try {
      if (value) localStorage.setItem(DRAFT_KEY, value);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* quota or private browsing - the in-memory value is still authoritative */
    }
  }, []);

  /** Empty the box completely - state, interim dictation, and the persisted copy. */
  const clearText = useCallback(() => {
    setText("");
    setInterim("");
    submittedRef.current = "";
    persistDraft("");
  }, [persistDraft]);

  // Mirror every keystroke and every dictated chunk to storage. Cheap at this size, and
  // the alternative is losing words - which is the one failure this screen cannot have.
  useEffect(() => {
    try {
      if (text) localStorage.setItem(DRAFT_KEY, text);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* quota or private browsing - the in-memory value is still authoritative */
    }
  }, [text]);

  /* ---------------- speech recognition ---------------- */

  const recognizerRef = useRef<SpeechRecognizer | null>(null);
  const wantRecordingRef = useRef(false);
  const startedAtRef = useRef(0);
  const rapidRestartsRef = useRef(0);
  // Consecutive recognition sessions that ended without producing a single word. The
  // auto-restart in onend is what lets you pause mid-sentence, but with nobody talking it
  // is an unbounded loop: the phone holds the mic open, and the recording indicator burns
  // battery, until the tab is closed. Eight silent sessions is roughly a minute of nothing.
  const silentRestartsRef = useRef(0);

  const stopRecording = useCallback(() => {
    wantRecordingRef.current = false;
    setRecording(false);
    setInterim("");
    try {
      recognizerRef.current?.stop();
    } catch {
      /* already stopped - nothing to unwind */
    }
  }, []);

  const startRecording = useCallback(() => {
    if (!RecognizerImpl) return;

    // Reuse one instance; Chrome leaks audio pipelines if you construct one per tap.
    let rec = recognizerRef.current;
    if (!rec) {
      rec = new RecognizerImpl();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = navigator.language || "en-US";
      rec.maxAlternatives = 1;

      rec.onresult = (event) => {
        let finalChunk = "";
        let interimChunk = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const alternative = result[0];
          if (!alternative) continue;
          if (result.isFinal) finalChunk += alternative.transcript;
          else interimChunk += alternative.transcript;
        }
        // A result means the session is healthy - reset both give-up counters.
        rapidRestartsRef.current = 0;
        silentRestartsRef.current = 0;
        if (finalChunk) {
          // Functional update: the recognizer's handlers outlive several renders and
          // would otherwise append onto a stale copy of the textarea, dropping edits.
          setText((prev) => appendSpoken(prev, finalChunk));
          setSpeechNote(null);
        }
        setInterim(interimChunk);
      };

      rec.onerror = (event) => {
        const { message, fatal } = speechErrorMessage(event.error);
        // Our own stop() raises `aborted`; that's not worth a scary message.
        if (event.error === "aborted" && !wantRecordingRef.current) return;
        setSpeechNote(message);
        if (fatal) {
          wantRecordingRef.current = false;
          setRecording(false);
          setInterim("");
        }
      };

      rec.onend = () => {
        setInterim("");
        if (!wantRecordingRef.current) {
          setRecording(false);
          return;
        }
        // Recognition ends on its own after a pause. Restarting is what keeps
        // "for breakfast I had... uh... then for lunch" from being cut in half.
        // If it ends instantly over and over, something is wrong - stop rather than spin.
        if (Date.now() - startedAtRef.current < 400) rapidRestartsRef.current += 1;
        else rapidRestartsRef.current = 0;

        if (rapidRestartsRef.current >= 4) {
          wantRecordingRef.current = false;
          setRecording(false);
          setSpeechNote("The mic keeps dropping out. Your text is safe — try typing the rest.");
          return;
        }

        // Nothing heard for several sessions running: the user walked away or finished
        // without tapping stop. Restarting forever would leave the mic live indefinitely.
        silentRestartsRef.current += 1;
        if (silentRestartsRef.current >= MAX_SILENT_RESTARTS) {
          wantRecordingRef.current = false;
          setRecording(false);
          setSpeechNote("Mic turned off after a while with nothing to hear. Tap it to pick back up.");
          return;
        }

        try {
          startedAtRef.current = Date.now();
          rec!.start();
        } catch {
          wantRecordingRef.current = false;
          setRecording(false);
        }
      };

      recognizerRef.current = rec;
    }

    wantRecordingRef.current = true;
    rapidRestartsRef.current = 0;
    silentRestartsRef.current = 0;
    setSpeechNote(null);
    try {
      startedAtRef.current = Date.now();
      rec.start();
      setRecording(true);
    } catch {
      // start() on an already-running recognizer throws; we're recording either way.
      setRecording(true);
    }
  }, []);

  // Always release the mic on unmount, including a navigate-away mid-sentence.
  useEffect(() => {
    return () => {
      wantRecordingRef.current = false;
      const rec = recognizerRef.current;
      recognizerRef.current = null;
      if (!rec) return;
      // Detach before aborting. abort() synchronously fires onend, and that handler both
      // sets state on a component that no longer exists and - in StrictMode's mount /
      // unmount / remount - could restart a recognizer the next mount has already replaced,
      // leaving two live sessions fighting over one microphone.
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.onstart = null;
      try {
        rec.abort();
      } catch {
        /* nothing to abort */
      }
    };
  }, []);

  /* ---------------- parse ---------------- */

  useEffect(() => {
    if (!parsing) return;
    setElapsed(0);
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(id);
  }, [parsing]);

  const submit = useCallback(async () => {
    const raw = textRef.current;
    const value = raw.trim();
    if (!value || inFlight.current) return;
    if (value.length > MAX_TEXT) {
      setCaptureError("That's more text than one submission takes. Split it into two.");
      return;
    }

    submittedRef.current = raw;
    inFlight.current = true;
    setParsing(true);
    setCaptureError(null);
    setSaveError(null);
    stopRecording();

    try {
      const result = await api.log(value, date);
      setPreview(result);
      setEntries(result.entries);
      setDrafts(Object.fromEntries(result.entries.map((e) => [e.id, draftFromEntry(e)])));
      setRemoved([]);
      setRowError(null);
      // Default to append: the day usually already holds breakfast when lunch is logged,
      // and silently replacing it would destroy data the user can't get back.
      setMode("append");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unknown";
      const serverMessage = err instanceof Error ? err.message : "Something went wrong";
      setCaptureError(
        code === "no_food_found"
          ? "I couldn't pick out any food from that. Your words are still below — try naming the foods more directly."
          : serverMessage,
      );
    } finally {
      setParsing(false);
      inFlight.current = false;
    }
  }, [date, stopRecording]);

  // A preview is bound to the date its session was created for. If the user changes days
  // mid-review, throwing the preview away is the only safe move - confirming it would
  // write lunch onto the wrong date. The text stays, so re-submitting costs one tap.
  //
  // The mount guard is load-bearing: a useEffect ALWAYS fires once on mount, and on mount
  // the preview was just seeded from sessionStorage (see `restored` above). Without the
  // guard this effect cleared that restored review on every remount, and the storage-mirror
  // effect below then erased it from sessionStorage - so the whole "your parse survives a
  // trip to Today/History" feature never actually worked. Only a genuine day change should
  // discard. loadReview already refuses a stored review whose date != the current one, so a
  // stale-date preview is never restored in the first place.
  const prevDate = useRef(date);
  useEffect(() => {
    if (prevDate.current === date) return;
    prevDate.current = date;
    setPreview(null);
    setEntries([]);
    setDrafts({});
    setRemoved([]);
    setSaveError(null);
  }, [date]);

  /* ---------------- review editing ---------------- */

  const patchDraft = useCallback((id: string, patch: Partial<Omit<Draft, "macros">>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const patchMacro = useCallback((id: string, key: NutrientKey, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...prev[id], macros: { ...prev[id].macros, [key]: value } },
    }));
  }, []);

  const removeEntry = useCallback(
    (id: string) => {
      const index = entries.findIndex((e) => e.id === id);
      if (index < 0) return;
      const entry = entries[index];
      const draft = drafts[id];
      // Keep the removed row around. Re-parsing to get it back would be another paid
      // 30-second call, so an undo is worth the few lines it costs.
      setRemoved((prev) => [...prev, { entry, draft, index }]);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    },
    [entries, drafts],
  );

  const undoRemove = useCallback(() => {
    setRemoved((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setEntries((current) => {
        const next = current.slice();
        next.splice(Math.min(last.index, next.length), 0, last.entry);
        return next;
      });
      setDrafts((current) => ({ ...current, [last.entry.id]: last.draft }));
      return prev.slice(0, -1);
    });
  }, []);

  const reestimate = useCallback(
    async (id: string) => {
      const entry = entries.find((e) => e.id === id);
      const draft = drafts[id];
      if (!entry || !draft || busyRow) return;

      setBusyRow(id);
      setRowError(null);
      try {
        const result = await api.estimate(estimateSeed(entry, draft));
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, nutrients: result.nutrients, parsed: result.parsed } : e)),
        );
        setDrafts((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            serving_description: `${result.parsed.quantity} ${result.parsed.unit}`,
            macros: macroStrings(result.nutrients),
          },
        }));
      } catch (err) {
        setRowError(err instanceof Error ? err.message : "Couldn't re-estimate that item");
      } finally {
        setBusyRow(null);
      }
    },
    [entries, drafts, busyRow],
  );

  /* ---------------- save ---------------- */

  const save = useCallback(async () => {
    if (!preview || saving || entries.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.confirm(preview.sessionId, {
        entries: mergeDrafts(entries, drafts),
        overwrite: mode === "replace",
      });
      // Only a successful write clears the box, and only the part of it that was actually
      // saved. Anything typed or dictated after the parse started is not in this log yet,
      // so it stays put; if the submitted text was edited underneath us we keep all of it
      // rather than guess, since a duplicate the user can see beats words they cannot.
      const saved = submittedRef.current;
      const remainder = text.startsWith(saved) ? text.slice(saved.length).replace(/^\s+/, "") : text;
      setText(remainder);
      // Persist synchronously. onSaved() below navigates away and unmounts this screen in
      // the same batch, so the storage-mirroring effect never runs for this value - which
      // is exactly how successfully-logged text used to reappear in the box later.
      persistDraft(remainder);
      submittedRef.current = "";
      setInterim("");
      setPreview(null);
      setEntries([]);
      setDrafts({});
      setRemoved([]);
      onSaved(result.log);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unknown";
      setSaveError({ code, message: err instanceof Error ? err.message : "Couldn't save that" });
    } finally {
      setSaving(false);
    }
  }, [preview, saving, entries, drafts, mode, onSaved]);

  // Session died (server restart). We still have the text, so re-parsing is one tap -
  // and it's the only path back, since the session ids are gone with it.
  const resubmit = useCallback(() => {
    setPreview(null);
    setEntries([]);
    setDrafts({});
    setRemoved([]);
    setSaveError(null);
    void submit();
  }, [submit]);

  const discard = useCallback(() => {
    setPreview(null);
    setEntries([]);
    setDrafts({});
    setRemoved([]);
    setSaveError(null);
    setRowError(null);
  }, []);

  // Mirror the pending review out to storage on every change, so an unmount at any moment
  // - a stray tap on Today, iOS discarding the tab - loses nothing that was already paid for.
  useEffect(() => {
    if (preview) saveReview({ preview, entries, drafts, date });
    else saveReview(null);
  }, [preview, entries, drafts, date]);

  /* ---------------- derived ---------------- */

  // Totals of the *edited* values, counting only what's known. Showing "1,240 kcal" when
  // three of nine rows have no calorie estimate is the exact lie this app exists to avoid.
  const totals = useMemo(
    () =>
      MACRO_KEYS.map((key) => {
        let sum = 0;
        let known = 0;
        for (const entry of entries) {
          const value = fieldToNum(drafts[entry.id]?.macros[key] ?? "");
          if (value !== null) {
            sum += value;
            known += 1;
          }
        }
        return { key, sum, known };
      }),
    [entries, drafts],
  );

  const trimmed = text.trim();
  const overLimit = text.length > MAX_TEXT;
  const canSubmit = trimmed.length > 0 && !parsing && !overLimit;
  // Determinate against the server's REAL ceiling, which is a genuine 80s deadline
  // (enricher.ts VOICEBITE_BUDGET_MS), not a guess. Past that the request is being
  // aborted server-side anyway, so the bar stops pretending and the copy takes over.
  const stage = STAGES.find((s) => s.until === undefined || elapsed < s.until) ?? STAGES[STAGES.length - 1];
  const progress = Math.min(97, Math.round((elapsed / SERVER_BUDGET_S) * 100));
  const overdue = elapsed >= SERVER_BUDGET_S;

  /* ---------------- capture view ---------------- */

  if (!preview) {
    return (
      <div className="stack">
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">What did you eat?</h2>
              <p className="card-subtitle">{prettyDate(date)}</p>
            </div>
          </div>

          <div className="card-body stack">
            {captureError && (
              <div className="banner banner-error" role="status">
                {captureError}
              </div>
            )}

            <div className="row row-wrap">
              {RecognizerImpl ? (
                <>
                  <button
                    type="button"
                    className={`mic ${recording ? "mic-recording" : "mic-idle"}`}
                    onClick={recording ? stopRecording : startRecording}
                    disabled={parsing}
                    aria-pressed={recording}
                    aria-label={recording ? "Stop recording" : "Start recording"}
                  >
                    {recording && <span className="mic-pulse" aria-hidden="true" />}
                    <MicGlyph stop={recording} />
                  </button>
                  <div className="stack-sm">
                    <span className="small">
                      {recording ? "Listening — tap to stop" : "Tap to dictate, or just type"}
                    </span>
                    {speechNote && <span className="small muted">{speechNote}</span>}
                  </div>
                </>
              ) : (
                <p className="small muted">
                  Dictation isn't available in this browser — type below instead. On iPhone, Safari is
                  the browser that supports the mic (or use the keyboard's own dictation key).
                </p>
              )}
            </div>

            <div className="field">
              <label className="label" htmlFor="log-text">
                Your words
              </label>
              <textarea
                id="log-text"
                className="textarea"
                rows={6}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="for breakfast I had a banana and black coffee, for lunch a chipotle chicken bowl with guac"
                spellCheck
                autoCapitalize="sentences"
                aria-describedby="log-text-help"
              />
              {interim && (
                <p className="transcript muted" aria-live="polite">
                  {interim}
                </p>
              )}
            </div>

            <div className="row row-between row-wrap">
              <span className="small muted" id="log-text-help">
                {overLimit
                  ? `${text.length.toLocaleString()} characters — over the ${MAX_TEXT.toLocaleString()} limit`
                  : "Fix any mis-heard words now — you'll still get to check the result before it saves."}
              </span>
              <div className="row row-wrap">
                {text.length > 0 && !parsing && (
                  <button type="button" className="btn btn-ghost" onClick={clearText}>
                    Clear
                  </button>
                )}
                <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!canSubmit}>
                  {parsing ? "Estimating…" : "Estimate nutrition"}
                </button>
              </div>
            </div>

            {parsing && (
              <div className="stack-sm" role="status" aria-live="polite">
                <div className="row">
                  <span className="spinner" aria-hidden="true" />
                  <span className="small">
                    {stage.label}
                    {stage.detail && <span className="muted"> — {stage.detail}</span>}{" "}
                    <span className="num">{elapsed}s</span>
                  </span>
                </div>
                {/* Determinate against the server's real 80s deadline. Once past it the
                  * bar goes indeterminate rather than sitting full and motionless, which
                  * is the state that reads as "hung". */}
                <div className="bar">
                  <div
                    className={overdue ? "bar-fill bar-fill-indeterminate" : "bar-fill"}
                    style={overdue ? undefined : { width: `${progress}%` }}
                  />
                </div>
                <span className="small muted">
                  {overdue
                    ? "Still working. It gives up at 80 seconds and falls back to an estimate, so this will finish either way."
                    : "A new food takes about a minute to look up. One you have logged before is a few seconds."}
                </span>
                {/* The real constraint, stated accurately. Leaving Safari or switching
                  * Safari tabs is fine - nothing in this app observes either. Switching to
                  * Today/History/Settings unmounts this screen and loses the result. */}
                <span className="small muted">
                  Don't switch to Today or History until it finishes — this screen loses the
                  result if you do. Leaving Safari is fine.
                </span>
              </div>
            )}
          </div>
        </section>
      </div>
    );
  }

  /* ---------------- review view ---------------- */

  const lastRemoved = removed.length > 0 ? removed[removed.length - 1] : null;

  return (
    <div className="stack">
      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Review before saving</h2>
            <p className="card-subtitle">
              {entries.length} {entries.length === 1 ? "item" : "items"} · {prettyDate(preview.date)}
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={discard} disabled={saving}>
            Discard
          </button>
        </div>

        <div className="card-body stack">
          <div className="transcript stack-sm">
            <span className="small muted">You said</span>
            <p>{preview.transcript}</p>
          </div>

          <CostNote cost={preview.cost} />

          {preview.existingEntries > 0 && (
            <div className="banner banner-warn stack-sm">
              <span>
                {/* Named, not ISO: "2026-08-03 already has 4 items" is a log line, and this
                    is the one warning in the app that stands between you and a destructive
                    overwrite. It has to read like a sentence. */}
                {preview.date === toDateString() ? "Today" : prettyDate(preview.date)} already has{" "}
                {preview.existingEntries} {preview.existingEntries === 1 ? "item" : "items"} (
                {fmt(preview.existingCalories)} kcal).
              </span>
              <div className="row row-wrap">
                <button
                  type="button"
                  className={`chip ${mode === "append" ? "is-on" : ""}`}
                  onClick={() => setMode("append")}
                  aria-pressed={mode === "append"}
                >
                  Add to the day
                </button>
                <button
                  type="button"
                  className={`chip ${mode === "replace" ? "is-on" : ""}`}
                  onClick={() => setMode("replace")}
                  aria-pressed={mode === "replace"}
                >
                  Replace everything
                </button>
              </div>
              {mode === "replace" && (
                <span className="small">
                  The {preview.existingEntries} existing{" "}
                  {preview.existingEntries === 1 ? "item" : "items"} will be deleted.
                </span>
              )}
            </div>
          )}

          <div className="grid-auto">
            {totals.map(({ key, sum, known }) => (
              // Label above value, matching Today and History - a tile that reads
              // value-first here and label-first two screens over costs a beat every time.
              <div className="stat" key={key}>
                <div className="stat-label">{NUTRIENT_META[key].label}</div>
                <div className="stat-value num">
                  {known === 0 ? fmt(null) : fmt(sum, key)}
                  <span className="small muted"> {NUTRIENT_META[key].unit}</span>
                </div>
                {/* Coverage, not decoration: a total is only as complete as its inputs. */}
                {known < entries.length && (
                  <div className="stat-sub">
                    from {known} of {entries.length} items
                  </div>
                )}
              </div>
            ))}
          </div>

          {rowError && (
            <div className="banner banner-error" role="status">
              {rowError}
            </div>
          )}

          {lastRemoved && (
            <div className="banner banner-info row row-between">
              <span className="truncate">Removed “{lastRemoved.draft.food_name}”.</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={undoRemove}>
                Undo
              </button>
            </div>
          )}

          {entries.length === 0 ? (
            <div className="empty">
              <p>Every item is removed. Undo one, or discard and start over.</p>
            </div>
          ) : (
            <div className="stack-sm">
              {entries.map((entry) => (
                <EntryEditor
                  key={entry.id}
                  entry={entry}
                  draft={drafts[entry.id]}
                  busy={busyRow === entry.id}
                  disabled={saving || (busyRow !== null && busyRow !== entry.id)}
                  onPatch={patchDraft}
                  onPatchMacro={patchMacro}
                  onRemove={removeEntry}
                  onReestimate={reestimate}
                />
              ))}
            </div>
          )}

          {saveError && (
            <div className="banner banner-error stack-sm" role="status">
              <span>{saveError.message}</span>
              {saveError.code === "session_not_found" && (
                <div className="row">
                  <button type="button" className="btn btn-sm" onClick={resubmit}>
                    Re-submit what I said
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="row row-between row-wrap">
            <span className="small muted">
              {mode === "replace" ? "Replaces the whole day" : "Adds to the day"}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={saving || entries.length === 0 || busyRow !== null}
            >
              {saving ? "Saving…" : `Save ${entries.length} ${entries.length === 1 ? "item" : "items"}`}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One editable row                                                    */
/* ------------------------------------------------------------------ */

/**
 * Where this row's numbers came from, and what had to be assumed to get them.
 *
 * This is the whole point of the review screen. Without it a grounded value read off a
 * third-party database and a figure the model reasoned out look identical, so there is no
 * way to know which rows deserve a second look. With it, the two cases that matter are
 * visible at a glance: a value copied from an aggregator, and an assumption that might be
 * wrong ("treated 2.5 bowls as 4 cups").
 */
function Provenance({ entry }: { entry: FoodEntry }) {
  const meta = entry.estimate;
  const badge =
    entry.source === "grounded" ? { text: "From the label", tone: "ok" as const }
    : entry.source === "pantry" ? { text: "Saved value", tone: "ok" as const }
    : entry.source === "manual" ? { text: "You typed this", tone: "ok" as const }
    : { text: "Estimated", tone: "muted" as const };

  // An aggregator is a third party retyping a label. Usually right, occasionally not -
  // and it is the one source worth naming explicitly so it can be spot-checked.
  const fromAggregator = meta?.basis === "reference_database";
  const lowConfidence = meta?.confidence === "low";

  if (!meta && entry.source === "claude_estimate") return null;

  return (
    <div className="provenance small">
      <span className={`badge ${badge.tone === "ok" ? "badge-ok" : ""}`}>{badge.text}</span>
      {meta?.grams ? <span className="muted">{meta.grams} g</span> : null}
      {lowConfidence && <span className="badge badge-warn">rough estimate</span>}
      {fromAggregator && <span className="badge badge-warn">third-party data</span>}

      {meta?.source_url && (
        <a href={meta.source_url} target="_blank" rel="noreferrer" className="muted">
          {meta.source_title ? meta.source_title.slice(0, 52) : "source"}
        </a>
      )}

      {meta?.assumptions && (
        <div className="provenance-note muted">{meta.assumptions}</div>
      )}
      {meta?.violations?.map((v) => (
        <div className="provenance-note warn" key={v}>{v}</div>
      ))}
    </div>
  );
}

/**
 * What this log cost, in dollars.
 *
 * Shown because the range is wide and the reason is invisible from the outside: a food
 * already in your library is one parse call at a few cents, while a new branded item adds
 * a published-label lookup that can cost twenty times as much. Attaching the figure to the
 * log that caused it is what makes that difference legible - and budgetable.
 *
 * Four decimals, not two: rounding to cents renders the common case as "$0.03" and the
 * cheapest as "$0.00", which reads as free.
 */
function CostNote({ cost }: { cost: LogCostSummary | undefined }) {
  const [open, setOpen] = useState(false);
  if (!cost) return null;

  const label = (method: string) =>
    method === "parseAndEnrich" ? "reading your words"
    : method === "resolveOne" ? "label lookup"
    : method === "enrichMicronutrients" ? "vitamins & minerals"
    : method;

  return (
    <div className="cost-note small muted">
      <button type="button" className="btn-link" onClick={() => setOpen((v) => !v)}>
        This log cost <span className="num">${cost.usd.toFixed(4)}</span>
        {cost.calls.length > 1 && <span> · {cost.calls.length} calls</span>}
        <span aria-hidden="true">{open ? " ▾" : " ▸"}</span>
      </button>
      {open && (
        <div className="cost-breakdown">
          {cost.calls.map((c, i) => (
            <div key={i} className="row cost-row">
              <span>{label(c.method)}</span>
              <span className="num">${c.usd.toFixed(4)}</span>
            </div>
          ))}
          <div className="row cost-row cost-total">
            <span>{cost.inputTokens.toLocaleString()} in / {cost.outputTokens.toLocaleString()} out
              {cost.webSearches > 0 && `, ${cost.webSearches} web searches`}</span>
            <span className="num">${cost.usd.toFixed(4)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function EntryEditor({
  entry,
  draft,
  busy,
  disabled,
  onPatch,
  onPatchMacro,
  onRemove,
  onReestimate,
}: {
  entry: FoodEntry;
  draft: Draft | undefined;
  busy: boolean;
  disabled: boolean;
  onPatch: (id: string, patch: Partial<Omit<Draft, "macros">>) => void;
  onPatchMacro: (id: string, key: NutrientKey, value: string) => void;
  onRemove: (id: string) => void;
  onReestimate: (id: string) => void;
}) {
  if (!draft) return null;

  const unknownMacros = MACRO_KEYS.filter((key) => fieldToNum(draft.macros[key]) === null);

  return (
    <div className="entry">
      <div className="entry-main stack-sm">
        <input
          className="input"
          value={draft.food_name}
          onChange={(e) => onPatch(entry.id, { food_name: e.target.value })}
          aria-label="Food name"
          disabled={disabled || busy}
        />
        <input
          className="input entry-serving"
          value={draft.serving_description}
          onChange={(e) => onPatch(entry.id, { serving_description: e.target.value })}
          aria-label="Serving"
          placeholder="1 cup"
          disabled={disabled || busy}
        />

        <div className="entry-macros row-wrap">
          {MACRO_KEYS.map((key) => (
            <label className="field" key={key}>
              <span className="label small">
                {NUTRIENT_META[key].label} <span className="muted">({NUTRIENT_META[key].unit})</span>
              </span>
              <input
                className="input num"
                type="text"
                inputMode="decimal"
                value={draft.macros[key]}
                onChange={(e) => onPatchMacro(entry.id, key, e.target.value)}
                // Empty means unknown, not zero - the placeholder says so rather than
                // showing a 0 the user would read as "this food has none".
                placeholder="—"
                disabled={disabled || busy}
              />
            </label>
          ))}
        </div>

        {unknownMacros.length > 0 && (
          <span className="badge">
            {unknownMacros.map((key) => NUTRIENT_META[key].label.toLowerCase()).join(", ")} unknown
          </span>
        )}

        <Provenance entry={entry} />

        <details className="more-nutrients">
          <summary className="small muted">Everything else on the label</summary>
          <div className="entry-macros row-wrap">
            {LABEL_KEYS.map((key) => (
              <label className="field" key={key}>
                <span className="label small">
                  {NUTRIENT_META[key].label} <span className="muted">({NUTRIENT_META[key].unit})</span>
                </span>
                <input
                  className="input num"
                  type="text"
                  inputMode="decimal"
                  value={draft.macros[key]}
                  onChange={(e) => onPatchMacro(entry.id, key, e.target.value)}
                  placeholder="—"
                  disabled={disabled || busy}
                />
              </label>
            ))}
          </div>
        </details>
      </div>

      <div className="entry-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onReestimate(entry.id)}
          disabled={disabled || busy}
        >
          {busy ? "Re-estimating…" : "Re-estimate"}
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm btn-icon"
          onClick={() => onRemove(entry.id)}
          disabled={disabled || busy}
          aria-label={`Remove ${draft.food_name}`}
          title="Remove"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function MicGlyph({ stop }: { stop: boolean }) {
  // Inline SVG rather than an icon package - the stack rules allow exactly three deps.
  if (stop) {
    return (
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"
        fill="currentColor"
      />
      <path
        d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
