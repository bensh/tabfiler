// TabFiler — background service.
// Handles automatic filing on page load / tab close and the open-on-install onboarding.
// Uses classic (non-module) script per manifest; imports inline via dynamic import.

const DEFAULT_SETTINGS = {
  autoOnLoad: false, autoOnClose: true, duplicates: "skip",
  unknownMode: "bookmark", askWhenNoFit: true, wholeWord: true,
  notifyOnAuto: true, rootFolderName: "TabFiler", onboarded: false,
  autoCategories: [], grace: true, graceMode: "undo", graceSeconds: 10,
};

let categorize, DEFAULT_RULES, fileBookmark;
(async () => {
  const cat = await import(browser.runtime.getURL("lib/categorize.js"));
  categorize = cat.categorize; DEFAULT_RULES = cat.DEFAULT_RULES;
  const bm = await import(browser.runtime.getURL("lib/bookmarks.js"));
  fileBookmark = bm.fileBookmark;
})();

async function getState() {
  const { settings, rules } = await browser.storage.local.get(["settings", "rules"]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
    rules: rules || DEFAULT_RULES,
  };
}

// throttle a flood of events (session restore, bulk close)
const recently = new Map();
const THROTTLE_MS = 1500;
const MAX_MAP = 5000; // hard cap so a long session can't grow these without bound
function throttled(key) {
  const now = Date.now();
  const last = recently.get(key) || 0;
  if (now - last < THROTTLE_MS) return true;
  recently.set(key, now);
  if (recently.size > MAX_MAP) {
    // drop the oldest half
    const cutoff = now - THROTTLE_MS;
    for (const [k, t] of recently) { if (t < cutoff) recently.delete(k); }
    while (recently.size > MAX_MAP) recently.delete(recently.keys().next().value);
  }
  return false;
}

// Maps a notification id -> the bookmark id it created, for one-click undo.
const lastFiled = new Map();


async function fileTab(tab, trigger) {
  if (!tab || !tab.url || !/^https?:/.test(tab.url) || !tab.title) return;
  if (!categorize || !fileBookmark) return;
  const { settings, rules } = await getState();
  // Throttle per trigger+URL so a load-file and a close-file of the same page
  // don't cancel each other, while still absorbing event floods (session
  // restore, bulk close) for the same trigger.
  if (throttled(`${trigger}:${tab.url}`)) return;

  const r = categorize(tab.title, rules, { wholeWord: settings.wholeWord });
  if (r.category.id === "unknown" && settings.unknownMode === "ignore") return;

  // Decide whether this trigger should auto-file.
  // A page files if EITHER the global switch for this trigger is on,
  // OR the user opted this specific category in via the popup toggle.
  const globalOn =
    (trigger === "load" && settings.autoOnLoad) ||
    (trigger === "close" && settings.autoOnClose);
  const perCategoryOn = (settings.autoCategories || []).includes(r.category.id);
  if (!globalOn && !perCategoryOn) return;

  // Grace period only applies to closing a tab (not on-load), and only when
  // enabled. It gives the user a chance to cancel a save they didn't intend.
  const useGrace = trigger === "close" && settings.grace;
  const seconds = Math.max(3, Math.min(60, settings.graceSeconds || 10));

  if (useGrace && settings.graceMode === "delay") {
    // DELAY MODE: don't save yet. Offer a "skip" notification; save only if the
    // window elapses without the user cancelling.
    schedulePendingSave({ tab, category: r.category, settings, seconds });
    return;
  }

  // Normal save (also the path for on-load, and for UNDO grace mode).
  const result = await fileBookmark(browser, {
    tab,
    categoryName: r.category.name,
    rootFolderName: settings.rootFolderName,
    duplicates: settings.duplicates,
  });
  if (result.action === "skipped") return;

  if (useGrace && settings.graceMode === "undo") {
    // UNDO MODE: it's saved; notify with a time-boxed chance to remove it.
    notifyUndo(settings, result.folderName, clampTitleLocal(tab.title), result, seconds);
  } else {
    notifyFiled(settings, result.folderName, clampTitleLocal(tab.title), result.bookmarkId, result.action);
  }
}

// ---- grace: DELAY mode ----
// Pending saves keyed by a synthetic id; a click on the notification cancels.
const pending = new Map();

function schedulePendingSave({ tab, category, settings, seconds }) {
  const pid = `tabfiler-pending:${tab.url}:${Date.now()}`;
  const timer = setTimeout(async () => {
    pending.delete(pid);
    browser.notifications.clear(pid);
    const result = await fileBookmark(browser, {
      tab,
      categoryName: category.name,
      rootFolderName: settings.rootFolderName,
      duplicates: settings.duplicates,
    });
    if (result.action !== "skipped" && settings.notifyOnAuto) {
      notifyFiled(settings, result.folderName, clampTitleLocal(tab.title), result.bookmarkId, result.action);
    }
  }, seconds * 1000);

  pending.set(pid, timer);
  if (pending.size > 200) {
    const oldest = pending.keys().next().value;
    clearTimeout(pending.get(oldest)); pending.delete(oldest);
  }

  browser.notifications.create(pid, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-48.png"),
    title: `Filing to ${category.name} in ${seconds}s`,
    message: `${clampTitleLocal(tab.title)}\nClick to skip saving this page.`,
  });
}

// ---- grace: UNDO mode ----
function notifyUndo(settings, catName, title, result, seconds) {
  if (!settings.notifyOnAuto) {
    // Even with notifications off, still allow undo-map cleanup timing.
    scheduleUndoExpiry(result, seconds);
    return;
  }
  const nid = `tabfiler:${result.bookmarkId}`;
  browser.notifications.create(nid, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-48.png"),
    title: `Filed to ${catName}`,
    message: `${title}\nClick to undo (within ${seconds}s).`,
  });
  lastFiled.set(nid, result.bookmarkId);
  if (lastFiled.size > 200) lastFiled.delete(lastFiled.keys().next().value);
  scheduleUndoExpiry(result, seconds, nid);
}

function scheduleUndoExpiry(result, seconds, nid) {
  setTimeout(() => {
    if (nid) { lastFiled.delete(nid); browser.notifications.clear(nid); }
  }, seconds * 1000);
}

// Lightweight local clamp for the notification message (display only).
function clampTitleLocal(s) {
  s = String(s || "");
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

// Build the right notification for how the bookmark was filed.
function notifyFiled(settings, catName, title, bookmarkId, mode) {
  if (!settings.notifyOnAuto) return;
  const nid = `tabfiler:${bookmarkId}`;
  let heading = `Filed to ${catName}`;
  if (mode === "updated") heading = `Updated in ${catName}`;
  if (mode === "flagged") heading = `Filed to ${catName} — similar title already saved`;
  browser.notifications.create(nid, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-48.png"),
    title: heading,
    message: title,
  });
  lastFiled.set(nid, bookmarkId);
  if (lastFiled.size > 200) lastFiled.delete(lastFiled.keys().next().value);
}

// Notification clicks:
//  - a pending (delay-mode) notification -> cancel the scheduled save
//  - a filed (undo-mode) notification    -> remove the bookmark just saved
browser.notifications.onClicked.addListener(async (nid) => {
  if (pending.has(nid)) {
    clearTimeout(pending.get(nid));
    pending.delete(nid);
    browser.notifications.clear(nid);
    return;
  }
  const bid = lastFiled.get(nid);
  if (bid) { try { await browser.bookmarks.remove(bid); } catch (e) {} lastFiled.delete(nid); }
  browser.notifications.clear(nid);
});

// on page load complete
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") fileTab(tab, "load");
});

// on tab close — we must already hold the tab's title/url, because onRemoved
// fires after the tab is gone and can't be queried. We keep a live snapshot,
// refreshed at every reliable moment:
//   - onUpdated: merges partial data as it streams in during load
//   - onUpdated status:"complete": the authoritative full-title snapshot
//   - onActivated: when you click back into a tab (incl. a discarded tab that
//     reloads), capture its settled title — this is the case where a sleeping
//     tab wakes up and the cache would otherwise hold stale/empty data.
const cache = new Map();

function remember(tabId, tab) {
  if (!tab) return;
  const prev = cache.get(tabId) || {};
  const next = {
    id: tabId,
    url: tab.url || prev.url,
    title: tab.title || prev.title,
    favIconUrl: tab.favIconUrl || prev.favIconUrl,
  };
  if (next.url) {
    cache.set(tabId, next);
    if (cache.size > MAX_MAP) cache.delete(cache.keys().next().value);
  }
}

browser.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  remember(tabId, tab);
});

// When you switch to a tab — including a discarded tab that reloads on click —
// read its live state and snapshot the real title. A just-woken discarded tab
// may not have its title ready at the instant of activation, so we also take a
// second snapshot shortly after, once the reload has settled.
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const snap = async () => {
    try { remember(tabId, await browser.tabs.get(tabId)); } catch (e) {}
  };
  await snap();
  setTimeout(snap, 1200);
});

browser.tabs.onRemoved.addListener((tabId) => {
  const tab = cache.get(tabId);
  if (tab && tab.url && tab.title) fileTab(tab, "close");
  cache.delete(tabId);
});

// first run
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const { settings } = await getState();
    if (!settings.onboarded) {
      browser.tabs.create({ url: browser.runtime.getURL("onboarding/onboarding.html") });
    }
  }
});
