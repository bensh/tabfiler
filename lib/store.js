// TabFiler — storage + runtime helpers.
// Works inside a real WebExtension (browser.* / chrome.*) and degrades
// gracefully to in-memory demo data when opened as a plain web page,
// so the wireframe is viewable without installing.

import { DEFAULT_RULES } from "./categorize.js";

export const DEFAULT_SETTINGS = {
  autoOnLoad: false,
  autoOnClose: true,
  duplicates: "skip",      // "skip" | "update" | "allow"
  unknownMode: "bookmark", // "bookmark" | "ignore"
  askWhenNoFit: true,
  wholeWord: true,
  notifyOnAuto: true,
  rootFolderName: "TabFiler",
  autoCategories: [],
  onboarded: false,
};

const HAS_EXT = typeof browser !== "undefined" && browser.storage
  ? "browser"
  : (typeof chrome !== "undefined" && chrome.storage ? "chrome" : null);

const api = HAS_EXT === "browser" ? browser : (HAS_EXT === "chrome" ? chrome : null);

// ---- demo store (only used outside an extension) ----
const demoStore = {
  settings: { ...DEFAULT_SETTINGS, onboarded: true },
  rules: structuredClone(DEFAULT_RULES),
};

export const isDemo = !HAS_EXT;

export async function getSettings() {
  if (isDemo) return { ...demoStore.settings };
  const got = await api.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(got.settings || {}) };
}

export async function setSettings(patch) {
  if (isDemo) { Object.assign(demoStore.settings, patch); return { ...demoStore.settings }; }
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await api.storage.local.set({ settings: next });
  return next;
}

export async function getRules() {
  if (isDemo) return structuredClone(demoStore.rules);
  const got = await api.storage.local.get("rules");
  return got.rules || structuredClone(DEFAULT_RULES);
}

export async function setRules(rules) {
  if (isDemo) { demoStore.rules = structuredClone(rules); return; }
  await api.storage.local.set({ rules });
}

// Sample tabs for the all-tabs review when running in demo mode.
export const DEMO_TABS = [
  { id: 1, title: "Jetpack Compose state hoisting — Android Developers", url: "https://developer.android.com/jetpack/compose/state", favIconUrl: "" },
  { id: 2, title: "security workshop and guide book | android", url: "https://example.com/workshop", favIconUrl: "" },
  { id: 3, title: "SwiftUI navigation stack tutorial", url: "https://developer.apple.com/tutorials/swiftui", favIconUrl: "" },
  { id: 4, title: "Kubernetes ingress security best practices", url: "https://kubernetes.io/docs/concepts/services-networking/ingress/", favIconUrl: "" },
  { id: 5, title: "OWASP Top 10 — 2024", url: "https://owasp.org/Top10/", favIconUrl: "" },
  { id: 6, title: "Mobile-first responsive design checklist", url: "https://web.dev/responsive/", favIconUrl: "" },
  { id: 7, title: "How to make sourdough — a beginner guide", url: "https://example.com/sourdough", favIconUrl: "" },
  { id: 8, title: "Docker Compose networking explained", url: "https://docs.docker.com/compose/networking/", favIconUrl: "" },
];

export async function getOpenTabs() {
  if (isDemo) return structuredClone(DEMO_TABS);
  const tabs = await api.tabs.query({ currentWindow: true });
  return tabs.filter((t) => t.url && /^https?:/.test(t.url));
}

export async function getActiveTab() {
  if (isDemo) return structuredClone(DEMO_TABS[1]); // the android/security tie-break, fun default
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

export function runtimeApi() { return api; }

// ---- export / import ----

const BACKUP_FORMAT = "tabfiler-backup";
const BACKUP_VERSION = 1;

// Build the object written to the backup file.
export async function buildBackup() {
  const settings = await getSettings();
  const rules = await getRules();
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings,
    rules,
  };
}

// Coerce a single category from an untrusted object into a safe shape.
// Returns null if it can't be salvaged into something valid.
function sanitizeCategory(c) {
  if (!c || typeof c !== "object") return null;
  const name = typeof c.name === "string" ? c.name.trim().slice(0, 60) : "";
  if (!name) return null;
  // IDs are used in CSS class names elsewhere; keep them to a safe charset.
  let id = typeof c.id === "string" ? c.id.toLowerCase().replace(/[^a-z0-9_-]/g, "") : "";
  if (!id) id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `cat-${Math.random().toString(36).slice(2, 8)}`;
  const color = typeof c.color === "string" && /^#[0-9a-f]{3,8}$/i.test(c.color) ? c.color : "#8B8680";
  const keywords = Array.isArray(c.keywords)
    ? [...new Set(c.keywords.filter((k) => typeof k === "string").map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 200))]
    : [];
  return { id, name, color, keywords };
}

// Validate and normalise a parsed backup object.
// Throws an Error with a human-readable message if it's not usable.
export function validateBackup(obj) {
  if (!obj || typeof obj !== "object") throw new Error("That file isn't a valid TabFiler backup.");
  if (obj.format !== BACKUP_FORMAT) throw new Error("That file isn't a TabFiler backup.");
  if (typeof obj.version !== "number" || obj.version > BACKUP_VERSION) {
    throw new Error("That backup was made by a newer version of TabFiler.");
  }

  // Rules: must have a categories array we can sanitise.
  const rawCats = obj.rules && Array.isArray(obj.rules.categories) ? obj.rules.categories : null;
  if (!rawCats) throw new Error("That backup is missing its category rules.");
  const categories = [];
  const seenIds = new Set();
  for (const c of rawCats) {
    const sc = sanitizeCategory(c);
    if (!sc) continue;
    while (seenIds.has(sc.id)) sc.id = `${sc.id}-${Math.random().toString(36).slice(2, 5)}`;
    seenIds.add(sc.id);
    categories.push(sc);
  }
  if (categories.length === 0) throw new Error("That backup has no usable categories.");

  // Settings: keep only known keys, with the right types, falling back to defaults.
  const s = obj.settings && typeof obj.settings === "object" ? obj.settings : {};
  const settings = { ...DEFAULT_SETTINGS };
  const boolKeys = ["autoOnLoad", "autoOnClose", "notifyOnAuto", "askWhenNoFit", "wholeWord", "onboarded"];
  for (const k of boolKeys) if (typeof s[k] === "boolean") settings[k] = s[k];
  if (["skip", "update", "allow"].includes(s.duplicates)) settings.duplicates = s.duplicates;
  if (["bookmark", "ignore"].includes(s.unknownMode)) settings.unknownMode = s.unknownMode;
  if (typeof s.rootFolderName === "string" && s.rootFolderName.trim()) {
    settings.rootFolderName = s.rootFolderName.trim().slice(0, 60);
  }
  if (Array.isArray(s.autoCategories)) {
    const validIds = new Set(categories.map((c) => c.id));
    settings.autoCategories = s.autoCategories.filter((id) => typeof id === "string" && validIds.has(id));
  }

  return { rules: { categories }, settings };
}

// Apply a validated backup to storage.
export async function applyBackup({ rules, settings }) {
  await setRules(rules);
  await setSettings(settings);
}

