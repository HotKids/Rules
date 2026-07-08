import { useState } from "react";

type Seg = { text: string; cls: string };

const KEYWORDS = new Set(["bash", "curl", "install", "upgrade", "uninstall"]);

// Lightweight highlighter for the installer command. prism-react-renderer does
// not bundle a bash grammar, so we tokenize this known command shape ourselves:
// URLs, quoted strings, flags, shell punctuation, and keywords.
function tokenize(cmd: string): Seg[] {
  const re =
    /(https?:\/\/[^\s'")]+)|('[^']*'|"[^"]*")|(<\(|\))|(--?[A-Za-z][\w-]*)|(\s+)|([^\s<()]+)/g;
  const out: Seg[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    if (m[1]) out.push({ text: m[1], cls: "text-emerald-600 dark:text-emerald-400" });
    else if (m[2]) out.push({ text: m[2], cls: "text-amber-600 dark:text-amber-400" });
    else if (m[3]) out.push({ text: m[3], cls: "text-zinc-400" });
    else if (m[4]) out.push({ text: m[4], cls: "text-sky-600 dark:text-sky-400" });
    else if (m[5]) out.push({ text: m[5], cls: "" });
    else if (m[6])
      out.push({
        text: m[6],
        cls: KEYWORDS.has(m[6])
          ? "font-semibold text-purple-600 dark:text-purple-400"
          : "",
      });
  }
  return out;
}

/** One-line bash command, highlighted and soft-wrapped. Click to copy (stays one line). */
export function CommandBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code); // no newlines — copy is one line
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={copy}
        title="Click to copy"
        className="block w-full cursor-pointer rounded-xl bg-surface p-3 text-left ring-1 ring-black/10 transition hover:ring-2 hover:ring-accent dark:ring-white/10"
      >
        <code className="block font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-foreground">
          {tokenize(code).map((s, i) =>
            s.cls ? (
              <span key={i} className={s.cls}>
                {s.text}
              </span>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
        </code>
      </button>
      {copied && (
        <span className="absolute top-2 right-2 rounded bg-success px-2 py-0.5 text-xs text-success-foreground">
          Copied!
        </span>
      )}
    </div>
  );
}
