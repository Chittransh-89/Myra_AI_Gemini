/**
 * Myra AI — secret detection and redaction.
 *
 * Source context leaves this process (to Gemini), so credentials are removed
 * BEFORE any analysis. This is best-effort defence in depth, not a substitute
 * for never sending secret files: the scanner already refuses .env files,
 * credential filenames, keys and similar paths (see filter.ts).
 */

export interface RedactionResult {
  text: string;
  redactions: number;
  kinds: string[];
}

interface Rule {
  kind: string;
  pattern: RegExp;
  replacement: string;
}

// Values that look like configuration pointers, not literals. Redacting these
// would destroy useful code understanding without removing any secret.
const NON_SECRET_VALUES = [
  /^process\.env/i,
  /^import\.meta/i,
  /^env\./i,
  /^os\.environ/i,
  /^os\.getenv/i,
  /^getenv\(/i,
  /^\$\{/,
  /^\$[A-Z0-9_]+$/,
  /^(?:null|undefined|true|false|string|number|boolean|any|unknown|never|void)$/i,
  /^\[REDACTED/i,
  /^["'`]{0,2}$/,
];

function looksLikeReference(value: string): boolean {
  return NON_SECRET_VALUES.some((rx) => rx.test(value));
}

const RULES: Rule[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    kind: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  {
    kind: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    kind: "github_token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    kind: "google_api_key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: "[REDACTED_GOOGLE_KEY]",
  },
  {
    kind: "api_key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    kind: "slack_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    kind: "bearer_token",
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replacement: "$1 [REDACTED]",
  },
  {
    kind: "connection_string",
    pattern: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s"'`@/]+:[^\s"'`@/]+@/gi,
    replacement: "$1://[REDACTED]@",
  },
  {
    kind: "credential_assignment",
    // name: "value" | name = 'value' | NAME=value — a value filter below
    // rejects env lookups, type annotations and similar non-secrets.
    pattern:
      /\b([A-Za-z_][A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|private[_-]?key|credential)[A-Za-z0-9_.-]*\s*[:=]\s*)(["'`]?)([^\s"'`\n,;]{8,})\2/gi,
    replacement: "$1$2[REDACTED]$2",
  },
  {
    kind: "env_assignment",
    pattern: /^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)=)([^\s#]{8,})$/gm,
    replacement: "$1[REDACTED]",
  },
];

/** Redact credentials from one file's text. Idempotent. */
export function redactSecrets(input: string): RedactionResult {
  let text = String(input ?? "");
  let redactions = 0;
  const kinds: string[] = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.kind === "credential_assignment") {
      text = text.replace(rule.pattern, (match, prefix: string, quote: string, value: string) => {
        if (looksLikeReference(value)) return match;
        redactions += 1;
        if (!kinds.includes(rule.kind)) kinds.push(rule.kind);
        return `${prefix}${quote}[REDACTED]${quote}`;
      });
      continue;
    }
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const hasGroups = args.length > 2 && typeof args[1] === "string" && typeof args[2] === "string";
      const groups = hasGroups ? args.slice(1, -2) : [];
      redactions += 1;
      if (!kinds.includes(rule.kind)) kinds.push(rule.kind);
      return groups.length > 0
        ? rule.replacement.replace(/\$(\d)/g, (_m, index) => String(groups[Number(index) - 1] ?? ""))
        : rule.replacement;
    });
  }

  return { text, redactions, kinds };
}

/** True when the text still looks like it carries a credential. */
export function containsLikelySecret(text: string): boolean {
  return redactSecrets(text).redactions > 0;
}
