// A tiny, dependency-free tokenizer good enough to make code blocks shine.
// Not a real parser — a single ordered regex over a handful of token classes.

export interface Token {
  text: string
  cls: string | null
}

const KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|import|export|from|default|async|await|new|class|extends|interface|type|enum|public|private|readonly|void|null|undefined|true|false|this|typeof|in|of|as|try|catch|finally|throw|switch|case|break|continue|yield|do)\b/

// Order matters: comments & strings first so their contents aren't re-tokenized.
const RULES: { cls: string | null; re: RegExp }[] = [
  { cls: "tok-com", re: /^\/\/[^\n]*/ },
  { cls: "tok-com", re: /^\/\*[\s\S]*?\*\// },
  { cls: "tok-str", re: /^`(?:\\.|[^`\\])*`/ },
  { cls: "tok-str", re: /^"(?:\\.|[^"\\])*"/ },
  { cls: "tok-str", re: /^'(?:\\.|[^'\\])*'/ },
  { cls: "tok-num", re: /^\b\d[\d_]*(?:\.\d+)?\b/ },
  { cls: "tok-key", re: new RegExp("^" + KEYWORDS.source) },
  { cls: "tok-fn", re: /^[A-Za-z_$][\w$]*(?=\s*\()/ },
  { cls: "tok-punc", re: /^[{}()[\].,;:=><+\-*/%!&|?]+/ },
  { cls: null, re: /^\s+/ },
  { cls: null, re: /^[A-Za-z_$][\w$]*/ },
  { cls: null, re: /^./ },
]

export function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  let guard = 0
  while (i < src.length && guard++ < 100_000) {
    const slice = src.slice(i)
    let matched = false
    for (const rule of RULES) {
      const m = rule.re.exec(slice)
      if (m && m[0].length > 0) {
        out.push({ text: m[0], cls: rule.cls })
        i += m[0].length
        matched = true
        break
      }
    }
    if (!matched) {
      out.push({ text: slice[0] ?? "", cls: null })
      i += 1
    }
  }
  return out
}
