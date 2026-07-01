// TabFiler — shared bookmark operations.
// One implementation of folder creation + duplicate resolution + filing,
// used by the popup, the all-tabs review, and the background auto-filer,
// so manual and automatic bookmarking behave identically.
//
// Pass in the WebExtension API object (browser/chrome). In demo mode the
// callers skip this module entirely and simulate results.

// Generic titles that collide across unrelated sites — never used for
// title-only matching.
export const GENERIC_TITLES = new Set([
  "new tab", "untitled", "untitled document", "about:blank",
  "problem loading page", "this page isn't working",
  "home", "homepage", "welcome", "index", "main page", "start", "start page",
  "login", "log in", "sign in", "signin", "sign up", "signup", "register",
  "logout", "log out", "sign out",
  "dashboard", "overview", "settings", "account", "my account", "profile",
  "admin", "console", "panel", "control panel",
  "error", "404", "404 not found", "not found", "page not found",
  "access denied", "forbidden", "403", "500", "loading", "redirecting",
  "just a moment", "one moment",
  "cart", "shopping cart", "checkout", "basket", "search", "search results",
  "results",
  "blog", "news", "help", "support", "faq", "contact", "contact us",
  "about", "about us", "terms", "terms of service", "privacy",
  "privacy policy", "documentation", "docs",
]);

export const MAX_TITLE = 500;

export function clampTitle(s) {
  s = String(s || "");
  return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE) + "…" : s;
}

// Normalise a title for comparison: lowercase, strip a leading "(3)" unread
// counter, drop a trailing ellipsis, collapse whitespace, trim.
export function normTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/^\s*\(\d+\)\s*/, "")
    .replace(/[\u2026.]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isGeneric(title) {
  return GENERIC_TITLES.has(normTitle(title));
}

export function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

// Ensure /rootFolderName/catName exists under the Bookmarks Menu. Returns the
// category folder node.
export async function ensureFolder(api, root, catName) {
  const tree = await api.bookmarks.getTree();
  const menu =
    tree[0].children.find((c) => c.id === "menu________") ||
    tree[0].children.find((c) => c.title === "Bookmarks Menu") ||
    tree[0].children[0];
  let rootNode = (await api.bookmarks.getChildren(menu.id)).find((c) => c.title === root && !c.url);
  if (!rootNode) rootNode = await api.bookmarks.create({ parentId: menu.id, title: root });
  let catNode = (await api.bookmarks.getChildren(rootNode.id)).find((c) => c.title === catName && !c.url);
  if (!catNode) catNode = await api.bookmarks.create({ parentId: rootNode.id, title: catName });
  return catNode;
}

// Find TabFiler's own root folder node (without creating it). Returns null
// if it doesn't exist yet.
async function findRootNode(api, root) {
  const tree = await api.bookmarks.getTree();
  const menu =
    tree[0].children.find((c) => c.id === "menu________") ||
    tree[0].children.find((c) => c.title === "Bookmarks Menu") ||
    tree[0].children[0];
  return (await api.bookmarks.getChildren(menu.id)).find((c) => c.title === root && !c.url) || null;
}

// Collect the IDs of every bookmark living anywhere under TabFiler's root
// folder, so duplicate detection only considers bookmarks TabFiler manages.
// Bookmarks made by you or other tools (e.g. an "all_tabs" folder) are ignored.
async function ownBookmarkIds(api, rootNode) {
  const ids = new Set();
  if (!rootNode) return ids;
  const [sub] = await api.bookmarks.getSubTree(rootNode.id);
  const walk = (node) => {
    if (node.url) ids.add(node.id);
    (node.children || []).forEach(walk);
  };
  walk(sub);
  return ids;
}

// Read TabFiler's own folders and their bookmarks, for the "Filed" overview.
// Returns [{ name, count, items:[{id,title,url}] }], one per category folder
// under the root. Read-only — never modifies anything.
export async function getFiled(api, rootFolderName) {
  const rootNode = await findRootNode(api, rootFolderName);
  if (!rootNode) return [];
  const [sub] = await api.bookmarks.getSubTree(rootNode.id);
  const cats = [];
  for (const child of sub.children || []) {
    if (child.url) continue; // stray bookmark directly under root — skip
    const items = [];
    const walk = (node) => {
      if (node.url) items.push({ id: node.id, title: node.title || node.url, url: node.url });
      (node.children || []).forEach(walk);
    };
    (child.children || []).forEach(walk);
    cats.push({ name: child.title, count: items.length, items });
  }
  return cats;
}

// Find the best existing bookmark match for a tab, and classify it:
//   "exact"        same URL (titles may differ) -> real duplicate
//   "same-domain"  different URL, same title, same host -> real duplicate
//   "cross-domain" different URL, same title, different host -> flag, don't merge
//   null           no match -> brand new
// Only bookmarks under TabFiler's own root folder are considered, so copies
// living in other folders (other tools, manual saves) never block filing.
export async function resolveDuplicate(api, url, title, rootFolderName) {
  const rootNode = await findRootNode(api, rootFolderName);
  if (!rootNode) return null; // no TabFiler folder yet -> nothing of ours to match
  const own = await ownBookmarkIds(api, rootNode);
  if (own.size === 0) return null;

  const byUrl = await api.bookmarks.search({ url });
  const urlHit = byUrl.find((h) => h.url === url && own.has(h.id));
  if (urlHit) return { node: urlHit, kind: "exact" };

  const norm = normTitle(title);
  if (!norm || isGeneric(title)) return null;

  const byTitle = await api.bookmarks.search({ query: norm });
  const titleHits = byTitle.filter((h) => h.url && own.has(h.id) && normTitle(h.title) === norm);
  if (titleHits.length === 0) return null;

  const host = hostOf(url);
  const sameDomain = titleHits.find((h) => hostOf(h.url) === host);
  if (sameDomain) return { node: sameDomain, kind: "same-domain" };

  return { node: titleHits[0], kind: "cross-domain" };
}

/**
 * File a tab into its category folder, applying the duplicate matrix.
 * @returns {{ action, bookmarkId, folderName, undo }}
 *   action: "created" | "updated" | "skipped" | "flagged"
 *   undo: async function that reverses the operation (or null when nothing to undo)
 */
export async function fileBookmark(api, { tab, categoryName, rootFolderName, duplicates }) {
  const folder = await ensureFolder(api, rootFolderName, categoryName);
  const safeTitle = clampTitle(tab.title);
  const match = await resolveDuplicate(api, tab.url, tab.title, rootFolderName);

  // Real duplicate: same URL, or same title on the same domain.
  if (match && (match.kind === "exact" || match.kind === "same-domain")) {
    if (duplicates === "skip") {
      return { action: "skipped", bookmarkId: match.node.id, folderName: categoryName, undo: null };
    }
    if (duplicates === "update") {
      // Snapshot for undo.
      const prev = { title: match.node.title, url: match.node.url, parentId: match.node.parentId };
      const changes = {};
      if (match.node.url !== tab.url) changes.url = tab.url;
      if (clampTitle(match.node.title) !== safeTitle) changes.title = safeTitle;
      if (Object.keys(changes).length) await api.bookmarks.update(match.node.id, changes);
      if (match.node.parentId !== folder.id) await api.bookmarks.move(match.node.id, { parentId: folder.id });
      return {
        action: "updated",
        bookmarkId: match.node.id,
        folderName: categoryName,
        undo: async () => {
          await api.bookmarks.update(match.node.id, { title: prev.title, url: prev.url });
          await api.bookmarks.move(match.node.id, { parentId: prev.parentId });
        },
      };
    }
    // "allow" falls through to create a second copy.
  }

  // Cross-domain title match: never merge — create new, flagged.
  const flagged = !!(match && match.kind === "cross-domain");
  const title = flagged ? `${safeTitle} (possible duplicate)` : safeTitle;
  const node = await api.bookmarks.create({ parentId: folder.id, title, url: tab.url });
  return {
    action: flagged ? "flagged" : "created",
    bookmarkId: node.id,
    folderName: categoryName,
    undo: async () => { try { await api.bookmarks.remove(node.id); } catch (e) {} },
  };
}
