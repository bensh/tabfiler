// TabFiler — categorisation engine
// Pure, dependency-free. Shared by popup, options, onboarding, and background.

export const DEFAULT_RULES = {
  // Order in this array IS the priority order. Higher index = lower priority.
  // "Unknown" is implicit (the fallback) and never stored with keywords.
  categories: [
    { id: "android", name: "Android", keywords: ["android", "kotlin", "jetpack", "play store", "apk", "gradle", "dalvik", "material design", "android studio"] },
    { id: "ios", name: "iOS", keywords: ["ios", "iphone", "ipad", "swift", "swiftui", "xcode", "app store", "objective-c", "testflight", "cocoapods"] },
    { id: "k8s", name: "Kubernetes / Docker", keywords: ["kubernetes", "k8s", "docker", "container", "helm", "kubectl", "ingress", "pod", "dockerfile", "compose", "containerd"] },
    { id: "security", name: "Security", keywords: ["security", "vulnerability", "cve", "exploit", "encryption", "owasp", "pentest", "infosec", "authentication", "tls", "malware"] },
    { id: "mobile", name: "Mobile", keywords: ["mobile", "smartphone", "responsive", "app ux", "mobile-first", "touchscreen"] },
  ],
};

export const UNKNOWN = { id: "unknown", name: "Unknown", color: "#8B8680" };

// Compute a stable, readable colour for a category from its name. Same name
// always yields the same colour, there's no limit on the number of categories,
// and it needs no per-category CSS. Unknown keeps a fixed neutral grey.
//
// Approach:
//   - Hash the name (FNV-1a) to a stable integer index.
//   - Map that index through the GOLDEN ANGLE (137.5°) to a hue. The golden
//     angle guarantees that even consecutive indices land far apart on the
//     wheel, so similar names don't produce similar colours (no clustering).
//   - Vary lightness across a few bands (also from the hash) so categories are
//     distinguishable by brightness, not hue alone — much more robust for
//     colour-vision differences, where two hues can look identical.
// The category name always appears next to the dot, so colour is never the
// only way to tell categories apart.
const GOLDEN_ANGLE = 137.508;
const LIGHTNESS_BANDS = [38, 47, 56, 65]; // dark → light, spreads brightness

export function categoryColor(nameOrId) {
  const key = String(nameOrId || "").trim().toLowerCase();
  if (!key || key === "unknown") return UNKNOWN.color;

  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = h >>> 0;

  // Reduce to a bounded index first — multiplying a 32-bit int directly by the
  // golden angle overflows float precision and collapses distinct names to the
  // same hue. A bounded index keeps the golden-angle spread exact.
  const index = h % 997; // prime, plenty of distinct steps
  const hue = Math.round((index * GOLDEN_ANGLE) % 360);
  const lightness = LIGHTNESS_BANDS[h % LIGHTNESS_BANDS.length];
  const sat = lightness >= 56 ? 55 : 62;
  return hslToHex(hue, sat, lightness);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

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
    category: { id: winner.cat.id, name: winner.cat.name, color: categoryColor(winner.cat.name) },
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
