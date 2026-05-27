import { useState, useCallback, useRef, useEffect } from "react";

type AppState = "landing" | "uploaded" | "loading" | "results";

interface RoastResult {
  score: number;
  problems: string[];
  fixes: string[];
  detailed: string;
}

interface HistoryEntry {
  id: string;
  date: string;
  score: number;
  filename: string;
  topProblem: string;
  topFix: string;
  result?: RoastResult;
  roastOpts?: { level: string; role: string; language: string };
}

const HISTORY_KEY = "rmr_history";
const MAX_HISTORY = 10;

function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveToHistory(entry: HistoryEntry) {
  const history = loadHistory();
  const updated = [entry, ...history].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

// ── Checklist types & helpers ───────────────────────────────
interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  source: "ai" | "general";
}

const GENERAL_CHECKLIST: Omit<ChecklistItem, "id">[] = [
  { text: "Quantify at least 3 achievements with specific numbers or percentages", done: false, source: "general" },
  { text: "Proofread every line for spelling and grammar errors", done: false, source: "general" },
  { text: "Tailor resume keywords to the job description you're applying to", done: false, source: "general" },
];

function makeChecklist(fixes: string[]): ChecklistItem[] {
  const aiItems: ChecklistItem[] = fixes.map((fix, i) => ({
    id: `ai-${i}`,
    text: fix,
    done: false,
    source: "ai",
  }));
  const generalItems: ChecklistItem[] = GENERAL_CHECKLIST.map((g, i) => ({
    ...g,
    id: `general-${i}`,
  }));
  return [...aiItems, ...generalItems];
}

function loadChecklist(roastId: string): ChecklistItem[] | null {
  try {
    const raw = localStorage.getItem(`rmr_checklist_${roastId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveChecklist(roastId: string, items: ChecklistItem[]) {
  localStorage.setItem(`rmr_checklist_${roastId}`, JSON.stringify(items));
}

function loadChecklistMeta(): { roastId: string; filename: string; score: number } | null {
  try {
    const raw = localStorage.getItem("rmr_checklist_meta");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveChecklistMeta(roastId: string, filename: string, score: number) {
  localStorage.setItem("rmr_checklist_meta", JSON.stringify({ roastId, filename, score }));
}

function encodeResult(result: RoastResult): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(result))));
}

function decodeResult(hash: string): RoastResult | null {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(hash))));
  } catch {
    return null;
  }
}

function parseRoastResponse(text: string): RoastResult {
  const scoreMatch = text.match(/SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : 5;

  // Flexible section headers — allow spacing/punctuation variations
  const problemsMatch = text.match(/TOP\s*3\s*PROBLEMS?:?\s*([\s\S]*?)(?=TOP\s*3\s*FIXES?|DETAILED\s*FEEDBACK|$)/i);
  const fixesMatch    = text.match(/TOP\s*3\s*FIXES?:?\s*([\s\S]*?)(?=DETAILED\s*FEEDBACK|$)/i);
  const detailedMatch = text.match(/DETAILED\s*FEEDBACK:?\s*([\s\S]*)$/i);

  const cleanLine = (l: string) =>
    l
      .replace(/^\*{1,2}\d+\.\*{1,2}\s*/, "") // **1.**
      .replace(/^\d+[.)]\s*/, "")              // "1." or "1)"
      .replace(/^[-–•*]\s*/, "")               // "- " "• " "* "
      .replace(/\*\*/g, "")                    // strip remaining **bold**
      .replace(/^[❌✅🔴🟢⚠️✗✓]+\s*/, "")    // strip leading emoji bullets
      .trim();

  const extractList = (block: string | undefined): string[] => {
    if (!block) return [];
    return block
      .split("\n")
      .map(cleanLine)
      .filter((l) => l.length > 4)  // skip blank lines and stray punctuation
      .slice(0, 3);
  };

  return {
    score,
    problems: extractList(problemsMatch?.[1]),
    fixes:    extractList(fixesMatch?.[1]),
    detailed: detailedMatch?.[1]?.trim() ?? "",
  };
}

async function extractTextFromPDF(file: File): Promise<string> {
  const pdfjsLib = (window as any).pdfjsLib;
  if (!pdfjsLib) throw new Error("PDF.js not loaded");
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((item: any) => item.str).join(" ") + "\n";
  }
  return fullText.trim();
}

// ── Roast options ───────────────────────────────────────────
type RoastLevel = "soft" | "hard" | "light" | "dark" | "vulgar";
type RoastRole =
  | "memer" | "interviewer" | "comedian" | "hr" | "friend"
  | "family" | "boss" | "teacher" | "enemy" | "girlfriend" | "boyfriend";
type RoastLanguage = "english" | "hindi" | "hinglish";

interface RoastOptions {
  level: RoastLevel;
  role: RoastRole;
  language: RoastLanguage;
}

const LEVEL_LABELS: Record<RoastLevel, string> = {
  soft: "🥺 Soft-hearted",
  hard: "💀 Hard-hearted",
  light: "😄 Light",
  dark: "🖤 Dark",
  vulgar: "🤬 Vulgar",
};

const ROLE_LABELS: Record<RoastRole, string> = {
  memer: "😂 Memer",
  interviewer: "👔 Job Interviewer",
  comedian: "🎤 Standup Comedian",
  hr: "📋 HR",
  friend: "🤝 Friend",
  family: "👨‍👩‍👧 Family Member",
  boss: "😤 Boss",
  teacher: "📚 Teacher",
  enemy: "😈 Enemy",
  girlfriend: "💁‍♀️ Girlfriend",
  boyfriend: "🧍 Boyfriend",
};

const LANGUAGE_LABELS: Record<RoastLanguage, string> = {
  english: "🇬🇧 English",
  hindi: "🇮🇳 Hindi",
  hinglish: "🔀 Hindi & English",
};

function buildSystemPrompt(opts: RoastOptions): string {
  const personas: Record<RoastRole, string> = {
    memer: "You are an internet meme lord who communicates entirely in memes, internet slang, and viral pop-culture references. Every roast is a meme.",
    interviewer: "You are a stone-cold formal job interviewer who evaluates resumes with clinical precision and corporate detachment.",
    comedian: "You are a standup comedian performing a roast set. Every piece of feedback is a punchline. Make it funny but painfully accurate.",
    hr: "You are a by-the-book HR professional drowning in corporate jargon, giving the most passive-aggressive feedback imaginable.",
    friend: "You are the candidate's brutally honest best friend who genuinely wants them to succeed but cannot sugarcoat anything.",
    family: "You are a nosy, well-meaning family member (think: the uncle at a wedding) who is devastatingly blunt while insisting they're helping.",
    boss: "You are a demanding, impatient boss who has seen a thousand terrible resumes and your patience ran out long ago.",
    teacher: "You are a strict teacher grading this resume like a school assignment — red pen in hand, deducting marks for every flaw.",
    enemy: "You are the candidate's bitter rival who is secretly thrilled to tear this resume apart. You're enjoying every second of this.",
    girlfriend: "You are the candidate's girlfriend — supportive on the outside, but absolutely devastated by what you're reading.",
    boyfriend: "You are the candidate's boyfriend — caring, but physically unable to hide your disappointment in this resume.",
  };

  const levels: Record<RoastLevel, string> = {
    soft: "Be gentle and encouraging while still being honest. Cushion every criticism with some warmth.",
    hard: "Be completely brutal and merciless. No kindness, no softening — pure unfiltered critique.",
    light: "Keep it light and playful, like friendly banter. Fun but still accurate.",
    dark: "Be dark and deeply sarcastic, like a villain narrating their evil plan.",
    vulgar: "Use crude, explicit language and profanity freely. Roast like a sailor with an MBA.",
  };

  const languages: Record<RoastLanguage, string> = {
    english: "Respond entirely in English.",
    hindi: "Respond entirely in Hindi (use Devanagari script). IMPORTANT: Keep the section headers (SCORE:, TOP 3 PROBLEMS:, TOP 3 FIXES:, DETAILED FEEDBACK:) in English — only the content within each section should be in Hindi.",
    hinglish: "Respond in Hinglish — the natural mix of Hindi and English that young Indians use in conversation. IMPORTANT: Keep the section headers (SCORE:, TOP 3 PROBLEMS:, TOP 3 FIXES:, DETAILED FEEDBACK:) in English — only the content within each section should be in Hinglish.",
  };

  return `${personas[opts.role]} ${levels[opts.level]} ${languages[opts.language]}`;
}

async function callGroqAPI(resumeText: string, opts: RoastOptions): Promise<string> {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: buildSystemPrompt(opts) },
        {
          role: "user",
          content: `Roast this resume. You MUST follow this exact output format with no deviations, no preamble, no markdown, no extra text before SCORE:

SCORE: X/10
TOP 3 PROBLEMS:
1. [one sentence problem]
2. [one sentence problem]
3. [one sentence problem]
TOP 3 FIXES:
1. [one sentence fix]
2. [one sentence fix]
3. [one sentence fix]
DETAILED FEEDBACK:
[section by section feedback]

IMPORTANT: The section headers (SCORE:, TOP 3 PROBLEMS:, TOP 3 FIXES:, DETAILED FEEDBACK:) must appear exactly as shown. Each problem/fix must be on its own numbered line. Do not use bullet points, markdown bold, or any other formatting for the numbered lists.

Resume text:
${resumeText}`,
        },
      ],
      temperature: 0.9,
      max_tokens: 1500,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error: ${response.status} - ${err}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ── Roast Options Selector UI ───────────────────────────────
function PillSelector<T extends string>({
  label,
  emoji,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  emoji: string;
  options: T[];
  labels: Record<T, string>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
        <span>{emoji}</span> {label}
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-all duration-150 whitespace-nowrap ${
              value === opt
                ? "bg-primary text-white border-primary shadow-sm shadow-orange-500/20"
                : "bg-background border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
            }`}
          >
            {labels[opt]}
          </button>
        ))}
      </div>
    </div>
  );
}

function RoastOptionsPanel({
  opts,
  onChange,
}: {
  opts: RoastOptions;
  onChange: (opts: RoastOptions) => void;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
      <p className="text-sm font-black flex items-center gap-2">
        <span>🎛️</span> Customize Your Roast
      </p>
      <PillSelector
        label="Roast Level"
        emoji="🌡️"
        options={["soft", "hard", "light", "dark", "vulgar"] as RoastLevel[]}
        labels={LEVEL_LABELS}
        value={opts.level}
        onChange={(v) => onChange({ ...opts, level: v })}
      />
      <PillSelector
        label="Role Type"
        emoji="🎭"
        options={["memer", "interviewer", "comedian", "hr", "friend", "family", "boss", "teacher", "enemy", "girlfriend", "boyfriend"] as RoastRole[]}
        labels={ROLE_LABELS}
        value={opts.role}
        onChange={(v) => onChange({ ...opts, role: v })}
      />
      <PillSelector
        label="Language"
        emoji="🌐"
        options={["english", "hindi", "hinglish"] as RoastLanguage[]}
        labels={LANGUAGE_LABELS}
        value={opts.language}
        onChange={(v) => onChange({ ...opts, language: v })}
      />
    </div>
  );
}

// ── Checklist Panel (results page) ─────────────────────────
function ChecklistPanel({
  items,
  onToggle,
}: {
  items: ChecklistItem[];
  onToggle: (id: string) => void;
}) {
  const done = items.filter((i) => i.done).length;
  const total = items.length;
  const pct = Math.round((done / total) * 100);
  const aiItems = items.filter((i) => i.source === "ai");
  const generalItems = items.filter((i) => i.source === "general");

  return (
    <div className="bg-card border border-border rounded-2xl p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center text-sm shrink-0">
            ✅
          </div>
          <div>
            <h3 className="font-black">Fix Checklist</h3>
            <p className="text-xs text-muted-foreground">Check items off as you improve your resume</p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-black">{done}/{total}</div>
          <div className="text-xs text-muted-foreground">completed</div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="w-full bg-border/60 rounded-full h-2 overflow-hidden">
          <div
            className="h-2 rounded-full transition-all duration-500"
            style={{
              width: `${pct}%`,
              background: pct === 100 ? "#22c55e" : pct >= 50 ? "#eab308" : "#ef4444",
            }}
          />
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{pct}% complete</span>
          {pct === 100 && (
            <span className="text-green-400 font-semibold">🎉 Ready to re-roast!</span>
          )}
        </div>
      </div>

      {/* AI fixes */}
      <div className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-widest text-primary">
          AI-Recommended Fixes
        </p>
        {aiItems.map((item) => (
          <label
            key={item.id}
            className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all duration-150 group ${
              item.done
                ? "bg-green-500/8 border-green-500/25 opacity-70"
                : "bg-background border-border hover:border-primary/30 hover:bg-primary/4"
            }`}
          >
            <div className="relative shrink-0 mt-0.5">
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => onToggle(item.id)}
                className="sr-only"
              />
              <div
                className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                  item.done
                    ? "bg-green-500 border-green-500"
                    : "border-border group-hover:border-primary"
                }`}
              >
                {item.done && (
                  <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            </div>
            <span className={`text-sm leading-relaxed ${item.done ? "line-through text-muted-foreground" : "text-foreground"}`}>
              {item.text}
            </span>
          </label>
        ))}
      </div>

      {/* General best practices */}
      <div className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Best Practices
        </p>
        {generalItems.map((item) => (
          <label
            key={item.id}
            className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all duration-150 group ${
              item.done
                ? "bg-green-500/8 border-green-500/25 opacity-70"
                : "bg-background border-border hover:border-primary/30 hover:bg-primary/4"
            }`}
          >
            <div className="relative shrink-0 mt-0.5">
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => onToggle(item.id)}
                className="sr-only"
              />
              <div
                className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                  item.done
                    ? "bg-green-500 border-green-500"
                    : "border-border group-hover:border-primary"
                }`}
              >
                {item.done && (
                  <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            </div>
            <span className={`text-sm leading-relaxed ${item.done ? "line-through text-muted-foreground" : "text-foreground"}`}>
              {item.text}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Checklist Banner (landing page) ────────────────────────
function ChecklistBanner({
  meta,
  items,
  onResume,
  onDismiss,
}: {
  meta: { roastId: string; filename: string; score: number };
  items: ChecklistItem[];
  onResume: () => void;
  onDismiss: () => void;
}) {
  const done = items.filter((i) => i.done).length;
  const total = items.length;
  const pct = Math.round((done / total) * 100);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8 pb-4">
      <div className="bg-card border border-primary/30 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center text-xl shrink-0">
          📋
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm">Resume fix in progress</p>
            <span className="text-xs bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full">
              {done}/{total} fixed
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate max-w-xs">{meta.filename} · Score: {meta.score}/10</p>
          <div className="w-full max-w-xs bg-border/60 rounded-full h-1.5 overflow-hidden">
            <div
              className="h-1.5 rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onResume}
            className="text-sm font-semibold bg-primary hover:bg-orange-600 text-white px-4 py-2 rounded-lg transition-colors"
          >
            Continue fixing →
          </button>
          <button
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground text-xl p-1 transition-colors"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Score ring ──────────────────────────────────────────────
function ScoreRing({ score, size = 144 }: { score: number; size?: number }) {
  const r = (size / 2) * 0.84;
  const circ = 2 * Math.PI * r;
  const dash = (score / 10) * circ;
  const color = score < 5 ? "#ef4444" : score <= 7 ? "#eab308" : "#22c55e";
  const label = score < 5 ? "Poor" : score <= 7 ? "Average" : "Great";
  const bg = score < 5 ? "rgba(239,68,68,0.1)" : score <= 7 ? "rgba(234,179,8,0.1)" : "rgba(34,197,94,0.1)";
  const cx = size / 2;
  const cy = size / 2;

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative rounded-full flex items-center justify-center" style={{ width: size, height: size, background: bg }}>
        <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox={`0 0 ${size} ${size}`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={size * 0.078} />
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={size * 0.078}
            strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round"
            style={{ transition: "stroke-dasharray 1.2s cubic-bezier(.4,0,.2,1)" }} />
        </svg>
        <div className="text-center z-10">
          <span className="font-black" style={{ color, fontSize: size * 0.28 }}>{score}</span>
          <span className="text-muted-foreground block" style={{ fontSize: size * 0.13 }}>/10</span>
        </div>
      </div>
      <span className="text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full border" style={{ color, borderColor: color, background: bg }}>
        {label}
      </span>
    </div>
  );
}

// ── Mini score badge for history ────────────────────────────
function ScorePip({ score }: { score: number }) {
  const color = score < 5 ? "text-red-400 bg-red-500/15 border-red-500/30"
    : score <= 7 ? "text-yellow-400 bg-yellow-500/15 border-yellow-500/30"
    : "text-green-400 bg-green-500/15 border-green-500/30";
  return (
    <span className={`inline-flex items-center justify-center w-10 h-10 rounded-xl border font-black text-sm shrink-0 ${color}`}>
      {score}
    </span>
  );
}

// ── Trend arrow ─────────────────────────────────────────────
function TrendBadge({ delta }: { delta: number }) {
  if (Math.abs(delta) < 0.5) return <span className="text-xs text-muted-foreground">→ Same</span>;
  const up = delta > 0;
  return (
    <span className={`text-xs font-bold flex items-center gap-0.5 ${up ? "text-green-400" : "text-red-400"}`}>
      {up ? "↑" : "↓"} {up ? "+" : ""}{delta.toFixed(1)} pts
    </span>
  );
}

// ── Compare Panel ────────────────────────────────────────────
function ComparePanel({ a, b, onClose }: { a: HistoryEntry; b: HistoryEntry; onClose: () => void }) {
  const [older, newer] = a.date <= b.date ? [a, b] : [b, a];
  const delta = newer.score - older.score;
  const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const scoreColor = (s: number) => s < 5 ? "text-red-400" : s <= 7 ? "text-yellow-400" : "text-green-400";

  return (
    <div className="bg-card border border-primary/25 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-primary mb-0.5">Comparison</p>
          <h3 className="text-base font-black">Side-by-Side Analysis</h3>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors text-xl leading-none px-1">×</button>
      </div>

      {/* Score row */}
      <div className="grid grid-cols-[1fr_56px_1fr] gap-2 px-5 py-5 border-b border-border">
        <div className="text-center space-y-1">
          <div className={`text-3xl font-black ${scoreColor(older.score)}`}>{older.score}/10</div>
          <div className="text-xs font-semibold text-muted-foreground">{fmtDate(older.date)}</div>
          <div className="text-xs text-muted-foreground/60 truncate px-2">{older.filename}</div>
          {older.roastOpts && <div className="text-xs text-muted-foreground/40 capitalize">{older.roastOpts.role} · {older.roastOpts.level}</div>}
        </div>
        <div className="flex flex-col items-center justify-center">
          <div className={`text-lg font-black leading-none ${delta > 0 ? "text-green-400" : delta < 0 ? "text-red-400" : "text-muted-foreground"}`}>
            {delta > 0 ? `+${delta.toFixed(1)}` : delta === 0 ? "=" : delta.toFixed(1)}
          </div>
          <div className="text-muted-foreground/30 text-lg mt-0.5">→</div>
        </div>
        <div className="text-center space-y-1">
          <div className={`text-3xl font-black ${scoreColor(newer.score)}`}>{newer.score}/10</div>
          <div className="text-xs font-semibold text-muted-foreground">{fmtDate(newer.date)}</div>
          <div className="text-xs text-muted-foreground/60 truncate px-2">{newer.filename}</div>
          {newer.roastOpts && <div className="text-xs text-muted-foreground/40 capitalize">{newer.roastOpts.role} · {newer.roastOpts.level}</div>}
        </div>
      </div>

      {/* Problems side-by-side */}
      {(older.result || newer.result) && (
        <div className="grid grid-cols-2 divide-x divide-border border-b border-border">
          <div className="p-4 space-y-2">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Problems — {fmtDate(older.date)}</p>
            {(older.result?.problems ?? []).map((p, i) => (
              <div key={i} className="text-xs bg-red-500/8 border border-red-500/15 rounded-xl px-3 py-2 leading-relaxed">
                <span className="font-bold text-red-400 mr-1">{i + 1}.</span>{p}
              </div>
            ))}
            {!older.result && <p className="text-xs text-muted-foreground italic">No detail saved for this roast</p>}
          </div>
          <div className="p-4 space-y-2">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Problems — {fmtDate(newer.date)}</p>
            {(newer.result?.problems ?? []).map((p, i) => (
              <div key={i} className="text-xs bg-red-500/8 border border-red-500/15 rounded-xl px-3 py-2 leading-relaxed">
                <span className="font-bold text-red-400 mr-1">{i + 1}.</span>{p}
              </div>
            ))}
            {!newer.result && <p className="text-xs text-muted-foreground italic">No detail saved for this roast</p>}
          </div>
        </div>
      )}

      {/* Fixes side-by-side */}
      {(older.result || newer.result) && (
        <div className="grid grid-cols-2 divide-x divide-border">
          <div className="p-4 space-y-2">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Fixes — {fmtDate(older.date)}</p>
            {(older.result?.fixes ?? []).map((f, i) => (
              <div key={i} className="text-xs bg-green-500/8 border border-green-500/15 rounded-xl px-3 py-2 leading-relaxed">
                <span className="font-bold text-green-400 mr-1">{i + 1}.</span>{f}
              </div>
            ))}
          </div>
          <div className="p-4 space-y-2">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Fixes — {fmtDate(newer.date)}</p>
            {(newer.result?.fixes ?? []).map((f, i) => (
              <div key={i} className="text-xs bg-green-500/8 border border-green-500/15 rounded-xl px-3 py-2 leading-relaxed">
                <span className="font-bold text-green-400 mr-1">{i + 1}.</span>{f}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── History Panel ───────────────────────────────────────────
function HistoryPanel({ history, onClear, onReplay }: { history: HistoryEntry[]; onClear: () => void; onReplay: (entry: HistoryEntry) => void }) {
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);

  if (history.length === 0) return null;

  const best = Math.max(...history.map((h) => h.score));
  const latest = history[0].score;
  const first = history[history.length - 1].score;
  const totalImprovement = latest - first;

  const toggleCompareMode = () => {
    setCompareMode((v) => !v);
    setCompareIds([]);
  };

  const toggleSelect = (id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  };

  const compareEntries =
    compareIds.length === 2
      ? [history.find((h) => h.id === compareIds[0])!, history.find((h) => h.id === compareIds[1])!]
      : null;

  return (
    <section className="max-w-6xl mx-auto px-4 sm:px-8 py-16">
      <div className="space-y-6">
        {/* Section header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-primary mb-1">Your progress</p>
            <h2 className="text-2xl sm:text-3xl font-black">Score History</h2>
          </div>
          <div className="flex items-center gap-2">
            {history.length >= 2 && (
              <button
                onClick={toggleCompareMode}
                className={`text-xs font-semibold transition-colors border px-3 py-1.5 rounded-lg ${
                  compareMode
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "text-muted-foreground hover:text-foreground border-border hover:border-primary/30"
                }`}
              >
                {compareMode ? "Cancel compare" : "⇄ Compare"}
              </button>
            )}
            <button
              onClick={onClear}
              className="text-xs text-muted-foreground hover:text-orange-400 transition-colors border border-border hover:border-orange-500/30 px-3 py-1.5 rounded-lg"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Compare hint */}
        {compareMode && (
          <div className="bg-primary/8 border border-primary/20 rounded-xl px-4 py-3 text-xs text-primary font-medium">
            {compareIds.length === 0 && "Select any two roasts to compare them side by side."}
            {compareIds.length === 1 && "Now select one more roast to compare."}
            {compareIds.length === 2 && "Comparing the two selected roasts ↓"}
          </div>
        )}

        {/* Compare panel */}
        {compareMode && compareEntries && (
          <ComparePanel
            a={compareEntries[0]}
            b={compareEntries[1]}
            onClose={() => setCompareIds([])}
          />
        )}

        {/* Summary stats */}
        {history.length >= 2 && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Best score", value: `${best}/10`, sub: "all time", color: "text-green-400" },
              { label: "Latest score", value: `${latest}/10`, sub: "most recent", color: "text-foreground" },
              {
                label: "Total change",
                value: `${totalImprovement >= 0 ? "+" : ""}${totalImprovement.toFixed(1)}`,
                sub: history.length > 1 ? `over ${history.length} roasts` : "first roast",
                color: totalImprovement >= 0 ? "text-green-400" : "text-red-400",
              },
            ].map((s) => (
              <div key={s.label} className="bg-card border border-border rounded-2xl p-4 text-center">
                <div className={`text-2xl font-black ${s.color}`}>{s.value}</div>
                <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
                <div className="text-xs text-muted-foreground/60">{s.sub}</div>
              </div>
            ))}
          </div>
        )}

        {/* Sparkline chart */}
        {history.length >= 2 && (
          <div className="bg-card border border-border rounded-2xl p-6">
            <p className="text-xs font-semibold text-muted-foreground mb-4 uppercase tracking-widest">Score over time</p>
            <div className="relative h-20">
              <svg className="w-full h-full" viewBox={`0 0 ${(history.length - 1) * 80 + 40} 80`} preserveAspectRatio="xMidYMid meet">
                {[2, 5, 8].map((v) => (
                  <line key={v} x1="0" y1={72 - (v / 10) * 64} x2={(history.length - 1) * 80 + 40} y2={72 - (v / 10) * 64}
                    stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
                ))}
                {history.length > 1 && (
                  <polyline
                    points={[...history].reverse().map((h, i) => `${i * 80 + 20},${72 - (h.score / 10) * 64}`).join(" ")}
                    fill="none" stroke="#ff6b35" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  />
                )}
                {[...history].reverse().map((h, i) => {
                  const cx = i * 80 + 20;
                  const cy = 72 - (h.score / 10) * 64;
                  const c = h.score < 5 ? "#ef4444" : h.score <= 7 ? "#eab308" : "#22c55e";
                  return (
                    <g key={h.id}>
                      <circle cx={cx} cy={cy} r="5" fill={c} />
                      <text x={cx} y={cy - 10} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize="9" fontWeight="bold">
                        {h.score}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        )}

        {/* History list */}
        <div className="space-y-2.5">
          {history.map((entry, idx) => {
            const delta = idx < history.length - 1 ? entry.score - history[idx + 1].score : null;
            const date = new Date(entry.date);
            const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
            const optsLabel = entry.roastOpts
              ? `${entry.roastOpts.role} · ${entry.roastOpts.level} · ${entry.roastOpts.language}`
              : null;
            const selIdx = compareIds.indexOf(entry.id);
            const isSelected = selIdx >= 0;
            return (
              <div
                key={entry.id}
                onClick={compareMode ? () => toggleSelect(entry.id) : undefined}
                className={`bg-card border rounded-2xl p-4 flex items-center gap-4 transition-colors ${
                  compareMode ? "cursor-pointer" : ""
                } ${
                  isSelected
                    ? "border-primary/60 bg-primary/5"
                    : idx === 0 && !compareMode
                    ? "border-primary/30"
                    : "border-border"
                } ${compareMode && !isSelected ? "hover:border-primary/30" : ""}`}
              >
                {/* Compare selection indicator */}
                {compareMode ? (
                  <div className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-xs font-black shrink-0 transition-colors ${
                    isSelected ? "bg-primary border-primary text-white" : "border-border text-muted-foreground"
                  }`}>
                    {isSelected ? selIdx + 1 : ""}
                  </div>
                ) : (
                  <ScorePip score={entry.score} />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold truncate max-w-[160px]">{entry.filename}</span>
                    {idx === 0 && !compareMode && (
                      <span className="text-xs bg-primary/15 text-primary border border-primary/20 px-2 py-0.5 rounded-full font-semibold">
                        Latest
                      </span>
                    )}
                    {!compareMode && delta !== null && <TrendBadge delta={delta} />}
                    {compareMode && <ScorePip score={entry.score} />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {optsLabel ?? `Top issue: ${entry.topProblem || "—"}`}
                  </p>
                </div>
                {!compareMode && (
                  <div className="flex items-center gap-3 shrink-0">
                    {entry.result && (
                      <button
                        onClick={() => onReplay(entry)}
                        className="text-xs font-semibold text-primary hover:text-orange-400 border border-primary/30 hover:border-orange-400/40 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                      >
                        View roast →
                      </button>
                    )}
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">{dateStr}</p>
                      <p className="text-xs text-muted-foreground/60">{timeStr}</p>
                    </div>
                  </div>
                )}
                {compareMode && (
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground">{dateStr}</p>
                    <p className="text-xs text-muted-foreground/60">{timeStr}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── Social share buttons ────────────────────────────────────
function TweetButton({ result }: { result: RoastResult }) {
  const scoreLabel = result.score < 5 ? "Poor" : result.score <= 7 ? "Average" : "Great";
  const topProblem = result.problems[0] ?? "needs work";
  const text = `My resume just got roasted by AI 🔥\n\nScore: ${result.score}/10 (${scoreLabel})\nTop problem: "${topProblem}"\n\nGet yours roasted 👇`;
  return (
    <a href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer"
      className="flex items-center gap-2 font-semibold py-2.5 px-4 rounded-xl transition-all bg-[#1DA1F2]/10 border border-[#1DA1F2]/30 hover:bg-[#1DA1F2]/20 text-[#1DA1F2] text-sm">
      <svg className="w-4 h-4 fill-current shrink-0" viewBox="0 0 24 24">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
      Post on X
    </a>
  );
}

function LinkedInButton({ result }: { result: RoastResult }) {
  const scoreLabel = result.score < 5 ? "Poor" : result.score <= 7 ? "Average" : "Great";
  const topFix = result.fixes[0] ?? "improve your resume";
  const summary = `I just got my resume roasted by AI and scored ${result.score}/10 (${scoreLabel}).\n\nTop fix: ${topFix}\n\nHonest AI feedback that actually helps you get hired.`;
  const url = `https://www.linkedin.com/shareArticle?mini=true&url=${encodeURIComponent(window.location.origin)}&title=${encodeURIComponent("My Resume Got Roasted by AI 🔥")}&summary=${encodeURIComponent(summary)}`;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="flex items-center gap-2 font-semibold py-2.5 px-4 rounded-xl transition-all bg-[#0A66C2]/10 border border-[#0A66C2]/30 hover:bg-[#0A66C2]/20 text-[#0A66C2] text-sm">
      <svg className="w-4 h-4 fill-current shrink-0" viewBox="0 0 24 24">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
      </svg>
      Share on LinkedIn
    </a>
  );
}

function ShareButton({ result }: { result: RoastResult }) {
  const [copied, setCopied] = useState(false);
  const handleShare = async () => {
    const encoded = encodeResult(result);
    const url = `${window.location.origin}${window.location.pathname}#roast=${encoded}`;
    try { await navigator.clipboard.writeText(url); }
    catch { prompt("Copy this link:", url); }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };
  return (
    <button onClick={handleShare}
      className={`flex items-center gap-2 font-semibold py-2.5 px-4 rounded-xl transition-all text-sm ${
        copied ? "bg-green-500/15 border border-green-500/40 text-green-400"
          : "bg-card border border-border hover:border-primary/50 hover:bg-primary/5 text-foreground"
      }`}>
      {copied ? <><span>✅</span>Copied!</> : <><span>🔗</span>Copy link</>}
    </button>
  );
}

// ── Constants ───────────────────────────────────────────────
const HOW_IT_WORKS = [
  { step: "01", icon: "📤", title: "Upload your resume", desc: "Drop your PDF into the upload area. Everything is processed in your browser — never uploaded to a server." },
  { step: "02", icon: "🤖", title: "AI tears it apart", desc: "Our Llama 3.3 model, acting as a brutally honest senior recruiter, analyzes every section of your resume." },
  { step: "03", icon: "🎯", title: "Get actionable results", desc: "Receive a score, your top 3 problems, top 3 fixes, and detailed feedback you can act on today." },
];

const TESTIMONIALS = [
  { name: "Sarah K.", role: "Software Engineer", avatar: "SK", text: "Got a 4/10 the first time. Fixed my resume based on the feedback, re-roasted it and got an 8. Landed 3 interviews the next week." },
  { name: "Marcus T.", role: "Product Manager", avatar: "MT", text: "Finally, honest feedback. Every recruiter I asked just said 'looks great!' — this AI actually told me what was wrong." },
  { name: "Priya M.", role: "Data Analyst", avatar: "PM", text: "The detailed section-by-section breakdown was incredible. Rewrote my experience bullets and started getting callbacks." },
];

const STATS = [
  { value: "900+", label: "Resumes roasted" },
  { value: "4.8★", label: "Average rating" },
  { value: "3×", label: "More interviews reported" },
  { value: "<15s", label: "Time to results" },
];

// ── New Section Data ─────────────────────────────────────────
const FEATURES = [
  { icon: "⚡", title: "Instant AI Analysis", desc: "Upload your resume and get comprehensive feedback in seconds, powered by advanced AI." },
  { icon: "👥", title: "AI-Powered Insights", desc: "Advanced AI trained on thousands of successful resumes and hiring patterns." },
  { icon: "🎯", title: "Actionable Insights", desc: "Get specific, implementable recommendations, not generic advice." },
  { icon: "🔒", title: "Privacy Protected", desc: "Your resume is processed locally in your browser and never stored on any server." },
  { icon: "🏭", title: "Industry Specific", desc: "Tailored feedback for tech, finance, healthcare, and 20+ other industries." },
  { icon: "🔄", title: "Unlimited Revisions", desc: "Keep improving with multiple rounds of feedback until it's perfect." },
];

const FAQ_ITEMS = [
  { q: "🔍 Is my resume cooked?", a: "Probably! But that's okay — that's why we're here. Most resumes have 3–5 critical issues holding them back. Our AI tells you exactly what's wrong and how to fix it." },
  { q: "🔒 How secure is my resume data?", a: "Very secure. Your PDF is processed entirely in your browser using PDF.js — it never leaves your device or gets uploaded to any server. We don't store, log, or see your resume." },
  { q: "📄 What file formats are supported?", a: "Currently PDF only. Make sure it's a text-based PDF, not a scanned image. If you hit extraction errors, try exporting fresh from Word or Google Docs as PDF." },
  { q: "🎯 How accurate is the AI analysis?", a: "Our AI (Llama 3.3 70B via Groq) is highly accurate at identifying structural, content, and formatting issues. Think of it as a rigorous senior recruiter who's reviewed thousands of resumes." },
  { q: "♻️ Can I get multiple reviews?", a: "Absolutely — unlimited roasts! Make the suggested fixes, re-upload, and watch your score climb. Use Score History to track your progress over time." },
  { q: "⚡ How long does the analysis take?", a: "Usually 10–20 seconds. We use Groq's ultra-fast inference — one of the fastest AI APIs available — so you get results much quicker than other tools." },
  { q: "🔥 What makes this different from other tools?", a: "Most resume tools sugarcoat feedback. We don't. Our AI gives you the same unfiltered honesty a top recruiter would — specific problems, specific fixes, and a score you can track over time." },
];

function FAQSection() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section id="faq" className="max-w-3xl mx-auto px-4 sm:px-8 py-20">
      <div className="text-center mb-12">
        <p className="text-xs font-bold uppercase tracking-widest text-primary mb-3">Got questions?</p>
        <h2 className="text-3xl sm:text-4xl font-black">Frequently Asked Questions</h2>
      </div>
      <div className="space-y-3">
        {FAQ_ITEMS.map((item, i) => (
          <div key={i} className={`border rounded-2xl overflow-hidden transition-colors ${open === i ? "border-primary/30 bg-card" : "border-border bg-card/50 hover:border-border/80"}`}>
            <button onClick={() => setOpen(open === i ? null : i)} className="w-full flex items-center justify-between px-5 py-4 text-left gap-4">
              <span className="font-semibold text-sm">{item.q}</span>
              <span className={`text-muted-foreground text-xl leading-none transition-transform duration-200 shrink-0 ${open === i ? "rotate-180" : ""}`}>⌄</span>
            </button>
            {open === i && (
              <div className="px-5 pb-5">
                <p className="text-sm text-muted-foreground leading-relaxed">{item.a}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function BeforeAfterSection() {
  const [tab, setTab] = useState<"before" | "after">("before");
  return (
    <section className="max-w-6xl mx-auto px-4 sm:px-8 py-20">
      <div className="grid lg:grid-cols-2 gap-12 items-start">
        <div className="space-y-4">
          <div className="flex rounded-xl border border-border overflow-hidden text-sm font-semibold">
            <button onClick={() => setTab("before")} className={`flex-1 py-3 transition-colors flex items-center justify-center gap-2 ${tab === "before" ? "bg-primary text-white" : "bg-card text-muted-foreground hover:text-foreground"}`}>🔥 Before Roast</button>
            <button onClick={() => setTab("after")} className={`flex-1 py-3 transition-colors flex items-center justify-center gap-2 ${tab === "after" ? "bg-primary text-white" : "bg-card text-muted-foreground hover:text-foreground"}`}>🚀 After Roast</button>
          </div>
          <div className="bg-card border border-border rounded-2xl p-5 font-mono text-xs space-y-4 min-h-[280px]">
            {tab === "before" ? (
              <>
                <div><p className="font-black text-muted-foreground uppercase text-[9px] tracking-widest mb-1">Objective</p><p className="text-muted-foreground line-through opacity-60">Seeking a challenging position where I can utilize my skills</p></div>
                <div><p className="font-black text-muted-foreground uppercase text-[9px] tracking-widest mb-1">Experience</p><p className="font-semibold">Software Developer</p><p className="text-muted-foreground line-through opacity-60 mt-0.5">Responsible for developing applications and working with team members to complete projects on time and help clients achieve their goals</p></div>
                <div><p className="font-black text-muted-foreground uppercase text-[9px] tracking-widest mb-1">Achievements</p><p className="text-muted-foreground line-through opacity-60">• Improved system performance{"\n"}• Led successful projects</p></div>
                <div><p className="font-black text-muted-foreground uppercase text-[9px] tracking-widest mb-1">Skills</p><p className="text-muted-foreground">JavaScript, Python, Java, HTML, CSS, React, Node.js, MongoDB, SQL, Git</p></div>
                <div className="pt-3 border-t border-border"><div className="h-1.5 bg-red-500/50 rounded-full w-1/3 mb-1" /><p className="text-red-400 font-bold text-[9px]">⚠ Second Look (Maybe Pile)</p></div>
              </>
            ) : (
              <>
                <div><p className="font-black text-green-400 uppercase text-[9px] tracking-widest mb-1">Professional Summary</p><p className="text-foreground">Full-stack engineer with 3+ yrs delivering scalable web apps. Reduced load times 40% and shipped 12 features last sprint cycle.</p></div>
                <div><p className="font-black text-green-400 uppercase text-[9px] tracking-widest mb-1">Experience</p><p className="font-semibold">Software Developer — Acme Corp</p><p className="text-muted-foreground mt-0.5">• Built REST API handling 50K+ req/day, cutting p95 latency 35%{"\n"}• Led team of 4, delivering $2M project 2 weeks ahead of schedule</p></div>
                <div><p className="font-black text-green-400 uppercase text-[9px] tracking-widest mb-1">Achievements</p><p className="text-muted-foreground">• Boosted system performance 40% via intelligent caching layer{"\n"}• Increased team revenue 18% through process optimization</p></div>
                <div className="pt-3 border-t border-border"><div className="h-1.5 bg-green-500/60 rounded-full w-5/6 mb-1" /><p className="text-green-400 font-bold text-[9px]">✓ Interview Shortlist</p></div>
              </>
            )}
          </div>
        </div>
        <div className="space-y-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-primary mb-3">What we catch</p>
            <h2 className="text-3xl sm:text-4xl font-black leading-tight">Every Issue We Find = More Interviews</h2>
            <p className="text-muted-foreground mt-3 text-sm leading-relaxed">Our AI catches the mistakes costing you interviews and shows you exactly how to fix them.</p>
          </div>
          <div className="space-y-5">
            {[
              { icon: "🔍", title: "ATS Optimization", desc: "We ensure your resume gets past the robots and into human hands with proper formatting and keywords." },
              { icon: "📈", title: "Impact Quantification", desc: "Transform vague descriptions into compelling achievements with specific numbers and results." },
              { icon: "🎯", title: "Strategic Positioning", desc: "Position yourself as the obvious choice with industry-specific language and targeted content." },
              { icon: "🔥", title: "Brutal Honesty", desc: "No sugar-coating. We tell you exactly what's wrong and how to fix it for maximum impact." },
            ].map((b) => (
              <div key={b.title} className="flex gap-4 items-start">
                <div className="w-10 h-10 bg-primary rounded-full flex items-center justify-center text-base shrink-0 shadow-lg shadow-orange-500/20">{b.icon}</div>
                <div>
                  <h3 className="font-bold text-sm">{b.title}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{b.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Mobile Navbar ────────────────────────────────────────────
interface NavbarProps {
  state: AppState;
  history: HistoryEntry[];
  onReset: () => void;
  onScrollToUpload: () => void;
}

function MobileNavbar({ state, history, onReset, onScrollToUpload }: NavbarProps) {
  const [open, setOpen] = useState(false);

  const scrollTo = (id: string) => {
    setOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  const navLinks = [
    { label: "How it works", id: "how-it-works" },
    { label: "Pricing", id: "pricing" },
    { label: "FAQ", id: "faq" },
    ...(history.length > 0 && state === "landing" ? [{ label: "My History", id: "history" }] : []),
  ];

  return (
    <nav className="border-b border-border/40 backdrop-blur-md sticky top-0 z-50 bg-background/75">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between">
        {/* Logo */}
        <button onClick={() => { setOpen(false); onReset(); }} className="flex items-center gap-2.5 group">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center text-base shadow-lg shadow-orange-500/30">🔥</div>
          <span className="text-lg font-black tracking-tight group-hover:text-primary transition-colors">RoastMyResume</span>
        </button>

        {/* Desktop links */}
        <div className="hidden sm:flex items-center gap-4">
          {navLinks.map((l) => (
            <a key={l.id} href={`#${l.id}`} className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={(e) => { e.preventDefault(); scrollTo(l.id); }}>
              {l.label}
            </a>
          ))}
          {state === "landing" && (
            <button onClick={onScrollToUpload}
              className="bg-primary hover:bg-orange-600 text-white text-sm font-bold py-2 px-4 rounded-lg transition-colors shadow-md shadow-orange-500/20">
              Get Roasted
            </button>
          )}
        </div>

        {/* Mobile right side */}
        <div className="flex sm:hidden items-center gap-3">
          {state === "landing" && (
            <button onClick={onScrollToUpload}
              className="bg-primary hover:bg-orange-600 text-white text-xs font-bold py-1.5 px-3 rounded-lg transition-colors">
              Get Roasted
            </button>
          )}
          <button onClick={() => setOpen((o) => !o)}
            className="w-9 h-9 flex flex-col items-center justify-center gap-1.5 text-foreground hover:text-primary transition-colors"
            aria-label="Toggle menu">
            <span className={`block h-0.5 w-5 bg-current rounded transition-all duration-200 ${open ? "rotate-45 translate-y-2" : ""}`} />
            <span className={`block h-0.5 w-5 bg-current rounded transition-all duration-200 ${open ? "opacity-0" : ""}`} />
            <span className={`block h-0.5 w-5 bg-current rounded transition-all duration-200 ${open ? "-rotate-45 -translate-y-2" : ""}`} />
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="sm:hidden border-t border-border/40 bg-background/95 backdrop-blur-md px-4 py-3 space-y-1">
          {navLinks.map((l) => (
            <button key={l.id} onClick={() => scrollTo(l.id)}
              className="w-full text-left px-3 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-card rounded-lg transition-colors">
              {l.label}
            </button>
          ))}
          {state === "landing" && (
            <button onClick={() => { setOpen(false); onScrollToUpload(); }}
              className="w-full mt-2 bg-primary hover:bg-orange-600 text-white font-bold py-2.5 rounded-lg transition-colors text-sm">
              Get Roasted 🔥
            </button>
          )}
        </div>
      )}
    </nav>
  );
}

// ── Main App ────────────────────────────────────────────────
export default function App() {
  const [state, setState] = useState<AppState>("landing");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<RoastResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isShared, setIsShared] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [currentRoastId, setCurrentRoastId] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [checklistMeta, setChecklistMeta] = useState(loadChecklistMeta);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [roastOpts, setRoastOpts] = useState<RoastOptions>({ level: "hard", role: "interviewer", language: "english" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/[#&]roast=([^&]*)/);
    if (match) {
      const decoded = decodeResult(match[1]);
      if (decoded) {
        setResult(decoded);
        setState("results");
        setIsShared(true);
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
  }, []);

  const handleFile = useCallback((f: File) => {
    if (f.type !== "application/pdf") { setError("Please upload a PDF file."); return; }
    setError(null);
    setFile(f);
    setState("uploaded");
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const handleRoast = async () => {
    if (!file) return;
    setState("loading");
    setError(null);
    try {
      const text = await extractTextFromPDF(file);
      if (!text || text.length < 50) throw new Error("Could not extract readable text from this PDF. Make sure it's not a scanned image.");
      const raw = await callGroqAPI(text, roastOpts);
      const parsed = parseRoastResponse(raw);
      setResult(parsed);
      setState("results");
      setIsShared(false);
      // Save to history
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        score: parsed.score,
        filename: file.name,
        topProblem: parsed.problems[0] ?? "",
        topFix: parsed.fixes[0] ?? "",
        result: parsed,
        roastOpts: { level: roastOpts.level, role: roastOpts.role, language: roastOpts.language },
      };
      saveToHistory(entry);
      setHistory(loadHistory());
      // Initialize checklist
      const newChecklist = makeChecklist(parsed.fixes);
      setCurrentRoastId(entry.id);
      setChecklist(newChecklist);
      saveChecklist(entry.id, newChecklist);
      saveChecklistMeta(entry.id, file.name, parsed.score);
      setChecklistMeta({ roastId: entry.id, filename: file.name, score: parsed.score });
      setBannerDismissed(false);
    } catch (err: any) {
      setError(err.message ?? "Something went wrong. Please try again.");
      setState("uploaded");
    }
  };

  const handleChecklistToggle = (itemId: string) => {
    setChecklist((prev) => {
      const updated = prev.map((item) =>
        item.id === itemId ? { ...item, done: !item.done } : item
      );
      if (currentRoastId) saveChecklist(currentRoastId, updated);
      return updated;
    });
  };

  const handleResumeBanner = () => {
    if (!checklistMeta) return;
    const saved = loadChecklist(checklistMeta.roastId);
    if (saved) {
      setCurrentRoastId(checklistMeta.roastId);
      setChecklist(saved);
      // Create a minimal result to show checklist-only view (no full result)
      setState("results");
      setResult({ score: checklistMeta.score, problems: [], fixes: [], detailed: "" });
      setIsShared(false);
    }
  };

  const handleReset = () => {
    setState("landing");
    setFile(null);
    setResult(null);
    setError(null);
    setIsShared(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleClearHistory = () => {
    clearHistory();
    setHistory([]);
  };

  const handleReplay = (entry: HistoryEntry) => {
    if (!entry.result) return;
    setResult(entry.result);
    setCurrentRoastId(entry.id);
    const saved = loadChecklist(entry.id);
    setChecklist(saved && saved.length ? saved : makeChecklist(entry.result.fixes));
    setState("results");
    setIsShared(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToUpload = () => {
    uploadRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => fileInputRef.current?.click(), 400);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Navbar */}
      <MobileNavbar
        state={state}
        history={history}
        onReset={handleReset}
        onScrollToUpload={scrollToUpload}
      />

      {/* ── LANDING ── */}
      {(state === "landing" || state === "uploaded") && (
        <>
          {/* Checklist resume banner */}
          {checklistMeta && !bannerDismissed && (() => {
            const saved = loadChecklist(checklistMeta.roastId);
            if (!saved) return null;
            const done = saved.filter((i) => i.done).length;
            if (done === saved.length) return null; // all done, no need for banner
            return (
              <ChecklistBanner
                meta={checklistMeta}
                items={saved}
                onResume={handleResumeBanner}
                onDismiss={() => setBannerDismissed(true)}
              />
            );
          })()}

          {/* Hero */}
          <section className="relative overflow-hidden">
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-orange-500/8 rounded-full blur-3xl" />
              <div className="absolute top-20 left-1/4 w-64 h-64 bg-orange-500/5 rounded-full blur-3xl" />
            </div>
            <div className="relative max-w-6xl mx-auto px-4 sm:px-8 pt-20 pb-16 flex flex-col items-center text-center gap-8">
              <div className="inline-flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 text-orange-400 text-xs font-bold uppercase tracking-widest px-4 py-2 rounded-full">
                <span className="w-1.5 h-1.5 bg-orange-400 rounded-full animate-pulse" />
                Powered by Groq + Llama 3.3 — Results in seconds
              </div>
              <h1 className="text-5xl sm:text-7xl font-black leading-[1.05] tracking-tight max-w-3xl">
                Get Your Resume{" "}
                <span className="relative inline-block">
                  <span className="relative z-10 text-primary">Brutally Roasted</span>
                  <span className="absolute -bottom-1 left-0 right-0 h-1 bg-primary/30 rounded-full" />
                </span>{" "}
                by AI
              </h1>
              <p className="text-lg sm:text-xl text-muted-foreground max-w-xl leading-relaxed">
                Stop getting ghosted. Get the honest, unfiltered feedback your resume needs — from an AI that doesn't sugarcoat.
              </p>
              <div className="flex flex-wrap justify-center gap-x-8 gap-y-3 w-full max-w-xl py-4 border-y border-border/50">
                {STATS.map((s) => (
                  <div key={s.label} className="text-center">
                    <div className="text-xl font-black text-foreground">{s.value}</div>
                    <div className="text-xs text-muted-foreground">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Upload */}
              <div ref={uploadRef} className="w-full max-w-lg">
                {state === "landing" ? (
                  <div onDrop={handleDrop}
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-2xl p-10 cursor-pointer transition-all duration-200 group ${
                      isDragging ? "border-primary bg-primary/8 scale-[1.01]" : "border-border hover:border-primary/50 hover:bg-primary/4"
                    }`}>
                    <div className="flex flex-col items-center gap-4">
                      <div className="w-16 h-16 bg-card border border-border rounded-2xl flex items-center justify-center text-3xl shadow-sm group-hover:scale-110 transition-transform duration-200">📄</div>
                      <div>
                        <p className="text-base font-semibold">Drop your resume here or <span className="text-primary underline underline-offset-2">browse</span></p>
                        <p className="text-sm text-muted-foreground mt-1">PDF files only · Max 10MB</p>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><span>🔒</span><span>Processed locally — never uploaded</span></div>
                    </div>
                    <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="bg-card border border-green-500/30 rounded-2xl p-5 flex items-center gap-4">
                      <div className="w-11 h-11 bg-green-500/15 rounded-xl flex items-center justify-center text-xl shrink-0">✅</div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-semibold text-green-400 text-sm">Resume uploaded successfully!</p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{file?.name}</p>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); setState("landing"); setFile(null); }}
                        className="text-muted-foreground hover:text-foreground transition-colors p-1 text-lg leading-none">×</button>
                    </div>
                    <RoastOptionsPanel opts={roastOpts} onChange={setRoastOpts} />
                    <button onClick={handleRoast}
                      className="w-full bg-primary hover:bg-orange-600 active:scale-[0.98] text-white font-black text-lg py-4 px-8 rounded-2xl transition-all shadow-xl shadow-orange-500/25 flex items-center justify-center gap-3">
                      🔥 Roast My Resume
                    </button>
                  </div>
                )}
                {error && (
                  <div className="mt-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl px-4 py-3 text-sm flex gap-2">
                    <span>⚠️</span> {error}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Trust bar */}
          <section className="border-y border-border/30 py-8">
            <div className="max-w-6xl mx-auto px-4 sm:px-8">
              <p className="text-center text-xs text-muted-foreground mb-6">Used by job seekers applying to top companies worldwide</p>
              <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-14">
                {["Amazon", "Google", "Apple", "Netflix", "Tesla", "Meta", "Microsoft"].map((c) => (
                  <span key={c} style={{ color: "#888888" }} className="font-black text-lg sm:text-xl tracking-tight hover:!text-white transition-colors duration-200 select-none cursor-default">{c}</span>
                ))}
              </div>
              <p className="text-center text-xs text-primary mt-5 font-semibold">Join job seekers getting honest AI resume feedback — free forever</p>
            </div>
          </section>

          {/* How it works */}
          <section id="how-it-works" className="max-w-6xl mx-auto px-4 sm:px-8 py-20">
            <div className="text-center mb-12">
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-3">Simple process</p>
              <h2 className="text-3xl sm:text-4xl font-black">How It Works</h2>
            </div>
            <div className="grid sm:grid-cols-3 gap-6">
              {HOW_IT_WORKS.map((step, i) => (
                <div key={i} className="relative bg-card border border-border rounded-2xl p-7 group hover:border-primary/30 transition-colors">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 bg-background border border-border rounded-xl flex items-center justify-center text-2xl shrink-0 group-hover:scale-110 transition-transform">{step.icon}</div>
                    <div>
                      <p className="text-xs font-black text-primary mb-1">{step.step}</p>
                      <h3 className="font-bold text-base mb-2">{step.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                    </div>
                  </div>
                  {i < HOW_IT_WORKS.length - 1 && (
                    <div className="hidden sm:block absolute top-1/2 -right-3 -translate-y-1/2 text-muted-foreground/30 text-xl z-10">→</div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Why choose us — features grid */}
          <section className="max-w-6xl mx-auto px-4 sm:px-8 py-20">
            <div className="text-center mb-12">
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-3">Why us</p>
              <h2 className="text-3xl sm:text-4xl font-black">Why Job Seekers Choose Our Free Resume Analysis</h2>
              <p className="text-muted-foreground mt-3 text-sm max-w-xl mx-auto">Professional AI resume feedback and critique that actually helps you land interviews</p>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {FEATURES.map((f) => (
                <div key={f.title} className="bg-card border border-border rounded-2xl p-6 hover:border-primary/30 transition-colors group">
                  <div className="w-12 h-12 bg-primary rounded-full flex items-center justify-center text-xl mb-4 shadow-lg shadow-orange-500/20 group-hover:scale-110 transition-transform">{f.icon}</div>
                  <h3 className="font-bold text-base mb-2">{f.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Before / After */}
          <BeforeAfterSection />

          {/* History */}
          <div id="history">
            <HistoryPanel history={history} onClear={handleClearHistory} onReplay={handleReplay} />
          </div>

          {/* Testimonials */}
          <section className="bg-card/50 border-y border-border/50 py-20">
            <div className="max-w-6xl mx-auto px-4 sm:px-8">
              <div className="text-center mb-12">
                <p className="text-xs font-bold uppercase tracking-widest text-primary mb-3">Social proof</p>
                <h2 className="text-3xl sm:text-4xl font-black">What People Are Saying</h2>
              </div>
              <div className="grid sm:grid-cols-3 gap-6">
                {TESTIMONIALS.map((t, i) => (
                  <div key={i} className="bg-background border border-border rounded-2xl p-6 space-y-4">
                    <div className="flex gap-1">{[1,2,3,4,5].map((s) => <span key={s} className="text-yellow-400 text-sm">★</span>)}</div>
                    <p className="text-sm text-muted-foreground leading-relaxed">"{t.text}"</p>
                    <div className="flex items-center gap-3 pt-1">
                      <div className="w-9 h-9 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-xs font-black text-primary">{t.avatar}</div>
                      <div>
                        <p className="text-sm font-semibold">{t.name}</p>
                        <p className="text-xs text-muted-foreground">{t.role}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Pricing */}
          <section id="pricing" className="max-w-6xl mx-auto px-4 sm:px-8 py-20">
            <div className="text-center mb-12">
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-3">Pricing</p>
              <h2 className="text-3xl sm:text-4xl font-black">Simple, Transparent Pricing</h2>
              <p className="text-muted-foreground mt-3 text-sm">Choose the level of feedback that fits your needs</p>
            </div>
            <div className="grid sm:grid-cols-3 gap-6 items-start">
              {/* Free */}
              <div className="relative bg-card border-2 border-primary rounded-2xl p-7 space-y-5">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="bg-primary text-white text-xs font-black px-4 py-1 rounded-full">Free Forever</span>
                </div>
                <div><h3 className="font-black text-base">AI Resume Roast</h3><p className="text-3xl font-black text-primary mt-1">FREE</p></div>
                <ul className="space-y-2.5">
                  {["Instant AI feedback", "Format & layout review", "ATS optimization tips", "Unlimited roasts"].map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm"><span className="text-green-400 font-bold">✓</span>{f}</li>
                  ))}
                </ul>
                <button onClick={scrollToUpload} className="w-full bg-primary hover:bg-orange-600 text-white font-black py-3 rounded-xl transition-colors shadow-lg shadow-orange-500/20">
                  Get Your Free Roast
                </button>
              </div>
              {/* Boost */}
              <div className="relative bg-card border border-border rounded-2xl p-7 space-y-5 opacity-70">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="bg-primary text-white text-xs font-black px-4 py-1 rounded-full">Coming Soon</span>
                </div>
                <div><h3 className="font-black text-base">AI Resume Boost</h3><p className="text-3xl font-black mt-1">$5</p></div>
                <ul className="space-y-2.5">
                  {["Everything in Free", "AI-powered rewrite", "Optimized bullet points", "Industry keywords", "Download ready resume"].map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-muted-foreground"><span className="text-muted-foreground">✓</span>{f}</li>
                  ))}
                </ul>
                <button disabled className="w-full bg-secondary text-muted-foreground font-bold py-3 rounded-xl cursor-not-allowed">Coming Soon</button>
              </div>
              {/* Expert */}
              <div className="relative bg-card border border-border rounded-2xl p-7 space-y-5 opacity-70">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="bg-primary text-white text-xs font-black px-4 py-1 rounded-full">Coming Soon</span>
                </div>
                <div><h3 className="font-black text-base">Expert Review</h3><p className="text-3xl font-black mt-1">$29</p></div>
                <ul className="space-y-2.5">
                  {["Everything in AI Boost", "30-min video call", "LinkedIn profile review", "Personal career strategy", "Interview prep tips"].map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-muted-foreground"><span className="text-muted-foreground">✓</span>{f}</li>
                  ))}
                </ul>
                <button disabled className="w-full bg-secondary text-muted-foreground font-bold py-3 rounded-xl cursor-not-allowed">Coming Soon</button>
              </div>
            </div>
          </section>

          {/* CTA */}
          <section className="max-w-6xl mx-auto px-4 sm:px-8 py-20">
            <div className="relative bg-card border border-border rounded-3xl p-10 sm:p-14 text-center overflow-hidden">
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-48 bg-primary/8 rounded-full blur-3xl" />
              </div>
              <div className="relative space-y-5">
                <span className="text-5xl">🔥</span>
                <h2 className="text-3xl sm:text-4xl font-black">Ready to face the truth?</h2>
                <p className="text-muted-foreground max-w-md mx-auto">Your resume might be the reason you're not getting callbacks. Find out in 15 seconds.</p>
                <button onClick={scrollToUpload}
                  className="inline-flex items-center gap-2 bg-primary hover:bg-orange-600 text-white font-black text-lg py-4 px-10 rounded-2xl transition-all shadow-xl shadow-orange-500/25 active:scale-95">
                  Upload My Resume →
                </button>
              </div>
            </div>
          </section>
          {/* FAQ */}
          <FAQSection />
        </>
      )}

      {/* ── LOADING ── */}
      {state === "loading" && (
        <div className="flex flex-col items-center justify-center min-h-[70vh] gap-8 px-4">
          <div className="relative">
            <div className="text-8xl animate-bounce drop-shadow-lg">🔥</div>
            <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-20 h-3 bg-primary/20 rounded-full blur-lg" />
          </div>
          <div className="text-center space-y-2">
            <h2 className="text-2xl sm:text-3xl font-black">Roasting your resume...</h2>
            <p className="text-muted-foreground">Our brutally honest AI recruiter is reading every word.</p>
          </div>
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: `${i * 0.12}s` }} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Usually takes 10–20 seconds</p>
        </div>
      )}

      {/* ── RESULTS ── */}
      {state === "results" && result && (
        <div id="print-results" className="max-w-3xl mx-auto px-4 sm:px-8 py-12 space-y-8">
          {isShared && (
            <div className="flex justify-center">
              <div className="inline-flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 text-orange-400 text-sm font-semibold px-5 py-2 rounded-full">
                👀 You're viewing a shared roast
              </div>
            </div>
          )}

          {/* Previous score comparison (if history exists and this isn't shared) */}
          {!isShared && history.length >= 2 && (
            <div className="bg-card border border-border rounded-2xl px-5 py-4 flex items-center justify-between">
              <div className="text-sm">
                <span className="text-muted-foreground">Previous best: </span>
                <span className="font-bold">{Math.max(...history.slice(1).map(h => h.score))}/10</span>
              </div>
              <TrendBadge delta={result.score - history[1]?.score} />
              <div className="text-sm">
                <span className="text-muted-foreground">This roast: </span>
                <span className="font-bold">{result.score}/10</span>
              </div>
            </div>
          )}

          <div className="text-center space-y-2">
            <h2 className="text-3xl sm:text-4xl font-black">The Verdict Is In 🔥</h2>
            <p className="text-muted-foreground text-sm">Here's what our AI recruiter really thinks</p>
          </div>

          {/* Score card */}
          <div className="bg-card border border-border rounded-3xl p-8 flex flex-col sm:flex-row items-center gap-8">
            <ScoreRing score={result.score} />
            <div className="flex-1 text-center sm:text-left space-y-3">
              <h3 className="text-xl font-black">Overall Score</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {result.score < 5
                  ? "This resume needs significant work before it's ready for recruiters. The good news? There's a clear path to improvement."
                  : result.score <= 7
                  ? "A decent foundation, but clear areas are holding you back from the shortlist. Small fixes can make a big difference."
                  : "You have a strong resume. A few targeted tweaks and you'll be in great shape for competitive roles."}
              </p>
              <div className="flex flex-wrap gap-2 justify-center sm:justify-start pt-1 share-buttons" data-print-hide="true">
                <TweetButton result={result} />
                <LinkedInButton result={result} />
                <ShareButton result={result} />
                <button
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold border border-border hover:border-primary/40 text-muted-foreground hover:text-foreground bg-card px-3 py-2 rounded-xl transition-colors"
                >
                  ⬇ Export PDF
                </button>
              </div>
            </div>
          </div>

          {/* Problems & Fixes */}
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="bg-card border border-red-500/25 rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-red-500/15 rounded-lg flex items-center justify-center text-sm">⚠️</div>
                <h3 className="font-black text-red-400">Top 3 Problems</h3>
              </div>
              <ol className="space-y-2.5">
                {result.problems.map((p, i) => (
                  <li key={i} className="flex gap-3 bg-red-500/8 border border-red-500/15 rounded-xl px-4 py-3 text-sm leading-relaxed">
                    <span className="shrink-0 mt-0.5">❌</span>
                    <span className="text-foreground/90">{p}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="bg-card border border-green-500/25 rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-green-500/15 rounded-lg flex items-center justify-center text-sm">✅</div>
                <h3 className="font-black text-green-400">Top 3 Fixes</h3>
              </div>
              <ol className="space-y-2.5">
                {result.fixes.map((f, i) => (
                  <li key={i} className="flex gap-3 bg-green-500/8 border border-green-500/15 rounded-xl px-4 py-3 text-sm leading-relaxed">
                    <span className="shrink-0 mt-0.5">✅</span>
                    <span className="text-foreground/90">{f}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          {/* Detailed */}
          {result.detailed && (
            <div className="bg-card border border-border rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center text-sm">📋</div>
                <h3 className="font-black">Detailed Feedback</h3>
              </div>
              <div className="space-y-2">
                {result.detailed.split("\n").map((line, i) =>
                  line.trim() ? <p key={i} className="text-muted-foreground text-sm leading-relaxed">{line}</p>
                    : <div key={i} className="h-2" />
                )}
              </div>
            </div>
          )}

          {/* Checklist */}
          {checklist.length > 0 && (
            <ChecklistPanel items={checklist} onToggle={handleChecklistToggle} />
          )}

          {/* CTA */}
          <div className="bg-card border border-border rounded-2xl p-6 text-center space-y-3">
            <p className="font-semibold">Fixed some things? Roast it again.</p>
            <p className="text-sm text-muted-foreground">Upload your improved resume and see how much your score went up.</p>
            <button onClick={handleReset}
              className="inline-flex items-center gap-2 bg-primary hover:bg-orange-600 text-white font-bold py-3 px-8 rounded-xl transition-colors shadow-lg shadow-orange-500/20">
              🔥 Roast Another Resume
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-border/50 mt-8 py-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-primary rounded-md flex items-center justify-center text-xs">🔥</div>
            <span className="font-bold text-sm">RoastMyResume</span>
          </div>
          <p className="text-xs text-muted-foreground text-center">Your PDF is processed locally in your browser and never uploaded to any server.</p>
          <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} RoastMyResume</p>
        </div>
      </footer>
    </div>
  );
}
