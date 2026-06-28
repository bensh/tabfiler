// TabFiler — categorisation engine
// Pure, dependency-free. Shared by popup, options, onboarding, and background.

export const DEFAULT_RULES = {
  // Order in this array IS the priority order. Higher index = lower priority.
  // "Unknown" is implicit (the fallback) and never stored with keywords.
  categories: [
    { id: "android", name: "Android", color: "#3DDC84", keywords: ["android", "kotlin", "jetpack", "play store", "apk", "gradle", "dalvik", "material design", "android studio"] },
    { id: "ios", name: "iOS", color: "#0A84FF", keywords: ["ios", "iphone", "ipad", "swift", "swiftui", "xcode", "app store", "objective-c", "testflight", "cocoapods"] },
    { id: "k8s", name: "Kubernetes / Docker", color: "#326CE5", keywords: ["kubernetes", "k8s", "docker", "container", "helm", "kubectl", "ingress", "pod", "dockerfile", "compose", "containerd"] },
    { id: "security", name: "Security", color: "#E5484D", keywords: ["security", "vulnerability", "cve", "exploit", "encryption", "owasp", "pentest", "infosec", "authentication", "tls", "malware"] },
    { id: "mobile", name: "Mobile", color: "#A07CF0", keywords: ["mobile", "smartphone", "responsive", "app ux", "mobile-first", "touchscreen"] },
  ],
};

export const UNKNOWN = { id: "unknown", name: "Unknown", color: "#8B8680" };

// Escape a keyword for safe use inside a RegExp.
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns true if `keyword` appears in `title`.
// wholeWord: match on word boundaries to avoid "ios" inside "scenarios".
function matches(title, keyword, wholeWord) {
  const t = title.toLowerCase();
  const k = keyword.toLowerCase();
  if (!wholeWord) return t.includes(k);
  // \b is unreliable around non-word chars (e.g. "k8s", "objective-c"),
  // so anchor on non-alphanumerics / string edges instead.
  const re = new RegExp(`(^|[^a-z0-9])${esc(k)}([^a-z0-9]|$)`, "i");
  return re.test(title);
}

/**
 * Categorise a tab title.
 * @param {string} title
 * @param {object} rules  - shape of DEFAULT_RULES
 * @param {object} opts   - { wholeWord: boolean }
 * @returns {{
 *   category: {id,name,color},
 *   matchedKeyword: string|null,
 *   confidence: "high"|"medium"|"none",
 *   reason: string,
 *   superseded: Array<{name, keyword}>  // lower-priority cats that also matched
 * }}
 */
export function categorize(title, rules = DEFAULT_RULES, opts = {}) {
  const wholeWord = opts.wholeWord ?? false;
  const cats = rules.categories || [];

  if (!title || !title.trim()) {
    return {
      category: UNKNOWN,
      matchedKeyword: null,
      confidence: "none",
      reason: "Waiting for the page title.",
      superseded: [],
    };
  }

  const hits = []; // {cat, keyword, index}
  cats.forEach((cat, index) => {
    for (const kw of cat.keywords) {
      if (matches(title, kw, wholeWord)) {
        hits.push({ cat, keyword: kw, index });
        break; // first keyword per category is enough
      }
    }
  });

  if (hits.length === 0) {
    return {
      category: UNKNOWN,
      matchedKeyword: null,
      confidence: "none",
      reason: "No keywords matched.",
      superseded: [],
    };
  }

  // Lowest index wins (highest priority).
  hits.sort((a, b) => a.index - b.index);
  const winner = hits[0];
  const superseded = hits.slice(1).map((h) => ({ name: h.cat.name, keyword: h.keyword }));

  // Mobile is the only generic category in defaults -> medium confidence.
  const confidence = winner.cat.id === "mobile" ? "medium" : "high";

  let reason = `Matched “${winner.keyword}”.`;
  if (superseded.length) {
    const beaten = superseded.map((s) => s.name).join(", ");
    reason = `Matched “${winner.keyword}” — outranks ${beaten}.`;
  }

  return {
    category: { id: winner.cat.id, name: winner.cat.name, color: winner.cat.color },
    matchedKeyword: winner.keyword,
    confidence,
    reason,
    superseded,
  };
}

// Convenience: full ordered list including Unknown, for dropdowns.
export function allCategories(rules = DEFAULT_RULES) {
  return [...rules.categories, UNKNOWN];
}
