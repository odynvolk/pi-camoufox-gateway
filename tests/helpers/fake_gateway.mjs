/**
 * In-process fake of the camofox-browser gateway.
 *
 * It implements only the endpoints this extension uses, with the real API's observed behaviour:
 * http/https-only tabs, navigate that does not auto-create a tab, a macro path for Google, and
 * snapshot pagination that reports totalChars/hasMore/nextOffset.
 *
 * Tests get a `fetch` implementation to install, plus a call log for assertions.
 */

import { trackTabLeaks } from "./tab_leaks.mjs";

const MACROS = {
  "@google_search": (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

export function createFakeGateway(options = {}) {
  const state = {
    sessions: new Map(), // userId -> Map(tabId -> tab)
    calls: [],
    failures: new Map(), // "METHOD /path" -> number of times to fail before succeeding
    unreachable: false,
    unauthorized: false,
    status: 500,
    requireAuth: false,
    consentWallOn: null, // userId set that hits consent instead of a SERP
    snapshotLimit: 20000,
    pageContents: new Map(), // url -> snapshot text
    resolveFailures: new Set(), // goto urls that never resolve
    failSnapshot: false,
    failOpen: false,
    redirects: new Map(), // requested url -> final url the browser lands on
    openLatencyMs: 0,
    hangUrls: new Set(),
    hangForMs: 10_000,
    clockSkew: 0,
    ...options,
  };

  function tabsOf(userId, create = false) {
    let tabs = state.sessions.get(userId);
    if (!tabs && create) {
      tabs = new Map();
      state.sessions.set(userId, tabs);
    }
    return tabs ?? new Map();
  }

  function defaultSnapshotFor(url) {
    if (state.pageContents.has(url)) return state.pageContents.get(url);
    if (url.includes("google.com/search")) {
      return [
        `- heading "${"camoufox daijro - Sök på Google"}"`,
        '- searchbox "Search" [e1]: camoufox daijro',
        '- link "daijro/camoufox: 🦊 Anti-detect browser" [e2]:',
        '  - /url: https://www.google.com/goto?url=CAESXQHrOzAVgy0tl10PoxtH',
        "  - cite: https://github.com › daijro › ca...",
        "  - text: Camoufox is a Firefox fork engineered for web scraping.",
        '- link "Camoufox: Introduction" [e3]:',
        "  - /url: https://www.google.com/goto?url=CAESUAHrOzAVaokHhtLMZP_Y",
        "  - cite: https://camoufox.com",
        "  - text: An open source anti-detect browser built for AI agents.",
      ].join("\n");
    }
    if (url.includes("consent.google.com")) {
      return '- main:\n  - heading "Before you continue to Google" [level=1]';
    }
    return [
      `- heading "Page: ${url}" [level=1]`,
      '- link "Docs" [e1]:',
      "  - /url: https://camoufox.com/docs",
      "  - text: Documentation",
      "  - text: Some readable body content about the product.",
    ].join("\n");
  }

  /** Mirrors the real gateway: opening/navigating a Google goto wrapper reports the destination. */
  function resolveTarget(url) {
    if (state.redirects.has(url)) return state.redirects.get(url);
    if (!/google\.com\/(goto|url)\?/u.test(url)) return url;
    if (state.resolveFailures.has(url)) return url;
    return "https://github.com/daijro/camoufox";
  }

  function record(method, path, body, headers) {
    state.calls.push({ method, path, body, headers: Object.fromEntries(headers ?? []) });
  }

  function shouldFail(method, path) {
    const key = `${method} ${path}`;
    const remaining = state.failures.get(key);
    if (!remaining) return false;
    if (remaining <= 1) state.failures.delete(key);
    else state.failures.set(key, remaining - 1);
    return true;
  }

  async function route(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    let body;
    try {
      body = request.body ? JSON.parse(request.body) : undefined;
    } catch {
      body = undefined;
    }
    record(method, path + url.search, body, request.headers);

    if (state.unreachable) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    if (state.requireAuth && !request.headers.get("authorization")) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (shouldFail(method, path)) {
      return json({ error: "injected gateway failure" }, 500);
    }

    if (method === "GET" && path === "/") {
      return json({ ok: true, enabled: true, engine: "camoufox", browserRunning: true });
    }

    if (method === "POST" && path === "/tabs/open" && state.failOpen) {
      return json({ error: "injected gateway failure" }, 500);
    }
    if (method === "GET" && path === "/tabs") {
      const userId = url.searchParams.get("userId") ?? "";
      const tabs = [...tabsOf(userId, true).entries()].map(([tabId, tab]) => ({ tabId, targetId: tabId, url: tab.url, title: tab.title }));
      return json({ running: true, tabs });
    }

    if (method === "POST" && path === "/tabs/open") {
      if (!body?.url || !/^https?:\/\//.test(body.url)) {
        return json({ error: `Blocked URL scheme: ${body?.url ?? ""} (only http/https allowed)` }, 400);
      }
      if (/(^|\.)blocked\.test$/u.test(new URL(body.url).hostname)) {
        return json({ error: "Blocked URL: this host is refused by the gateway (only http/https allowed)" }, 400);
      }
      const tabId = crypto.randomUUID();
      const googleHost = /^https?:\/\/(www\.)?google\./u.test(body.url);
      const url =
        state.consentWallOn?.has(body.userId) && googleHost
          ? `https://consent.google.com/ml?continue=${encodeURIComponent(body.url)}`
          : resolveTarget(body.url);
      // The real gateway creates the tab before we can lose the response, so hanging must happen
      // after registration: that is what makes an ambiguous timeout a genuine leak candidate.
      tabsOf(body.userId, true).set(tabId, { url, title: `Title: ${url}` });
      if (state.hangUrls.has(body?.url)) {
        await sleep(state.hangForMs);
      } else if (state.openLatencyMs) {
        await sleep(state.openLatencyMs);
      }
      return json({ ok: true, tabId, targetId: tabId, url, title: `Title: ${url}` });
    }

    const tabMatch = path.match(/^\/tabs\/([^/]+)(\/.*)?$/);
    if (tabMatch) {
      const tabId = decodeURIComponent(tabMatch[1]);
      const sub = tabMatch[2];
      const userId = body?.userId ?? url.searchParams.get("userId") ?? undefined;
      const tab = tabsOf(userId).get(tabId);
      if (!tab) return json({ error: "Tab not found" }, 404);

      if (method === "DELETE" && !sub) {
        tabsOf(userId).delete(tabId);
        return json({ ok: true });
      }

      if (method === "POST" && sub === "/navigate") {
        if (state.consentWallOn?.has(body.userId) && body.macro) {
          tab.url = `https://consent.google.com/ml?continue=${encodeURIComponent(body.query ?? "")}`;
          return json({ ok: true, tabId, url: tab.url, refsAvailable: false });
        }
        if (body.macro) {
          const template = MACROS[body.macro];
          if (!template) return json({ error: `Unknown macro ${body.macro}` }, 400);
          if (state.consentWallOn?.has(body.userId)) {
            tab.url = `https://consent.google.com/ml?continue=${encodeURIComponent(template(body.query ?? ""))}`;
            return json({ ok: true, tabId, url: tab.url, refsAvailable: false });
          }
          tab.url = template(body.query ?? "");
          tab.title = tab.url;
          return json({ ok: true, tabId, url: tab.url, refsAvailable: false, googleSerp: true });
        }
        if (!body?.url || !/^https?:\/\//.test(body.url)) {
          return json({ error: "Blocked URL scheme (only http/https allowed)" }, 400);
        }
        tab.url = resolveTarget(body.url);
        return json({ ok: true, tabId, url: tab.url, refsAvailable: true });
      }

      if (method === "GET" && sub === "/snapshot") {
        if (state.failSnapshot) return json({ error: "snapshot exploded" }, 500);
        const text = defaultSnapshotFor(tab.url);
        const limit = state.snapshotLimit;
        const truncated = text.length > limit;
        return json({
          url: tab.url,
          snapshot: truncated ? text.slice(0, limit) : text,
          refsCount: (text.match(/\[e\d+\]/g) ?? []).length,
          truncated,
          totalChars: text.length,
          hasMore: truncated,
          nextOffset: truncated ? limit : text.length,
        });
      }

      if (method === "GET" && sub === "/links") {
        const text = defaultSnapshotFor(tab.url);
        const links = [...text.matchAll(/- link "([^"]+)"[^\n]*\n\s*- \/url: (\S+)/g)].map((m) => ({
          title: m[1],
          url: m[2],
        }));
        return json({ links, url: tab.url });
      }

      if (method === "POST" && sub === "/extract") {
        const text = defaultSnapshotFor(tab.url);
        const properties = body?.schema?.properties ?? {};
        const found = Object.fromEntries(
          Object.entries(properties)
            .filter(([, spec]) => spec?.["x-ref"] && text.includes(`[${spec["x-ref"]}]`))
            .map(([key]) => [key, `value-for-${key}`]),
        );
        return json({ ok: true, data: found, url: tab.url, extracted: Object.keys(found).length });
      }

      if (method === "POST" && (sub === "/click" || sub === "/scroll" || sub === "/press")) {
        return json({ ok: true, tabId });
      }

      if (method === "GET" && sub === "/stats") {
        return json({ tabId, url: tab.url, title: tab.title });
      }
    }

    const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch && method === "DELETE") {
      state.sessions.delete(decodeURIComponent(sessionMatch[1]));
      return json({ ok: true });
    }

    if (method === "GET" && path === "/tabs") {
      const tabs = [...tabsOf(body?.userId ?? url.searchParams.get("userId")).entries()].map(([tabId, tab]) => ({
        tabId,
        targetId: tabId,
        url: tab.url,
      }));
      return json({ running: true, tabs });
    }

    return json({ error: `Cannot ${method} ${path}` }, 404);
  }

  return {
    state,
    fetch: async (requestUrl, init = {}) => {
      const request = {
        url: String(requestUrl),
        method: init.method ?? "GET",
        headers: new Headers(init.headers ?? {}),
        body: init.body ?? undefined,
        signal: init.signal,
      };
      return route(request);
    },
    /** Snapshot of tabs currently open per session, for leak assertions. */
    liveTabs() {
      return [...state.sessions.entries()].flatMap(([userId, tabs]) =>
        [...tabs.entries()].map(([tabId, tab]) => ({ userId, tabId, url: tab.url })),
      );
    },
  };
}

/** Install the fake gateway on globalThis.fetch for the duration of a test. */
export function withFakeGateway(t, options = {}) {
  const { assertNoTabLeak = true, ...gatewayOptions } = options;
  const fake = createFakeGateway(gatewayOptions);
  // Always tracked: opting out of the per-test assert must not also disable the file-level backstop.
  trackTabLeaks(fake);
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  // Registered first, so it runs before any `t.after` the test adds: production paths must close
  // what they opened, and a test's own tidy-up hook is not an excuse for a tab the code left open.
  // Tests that open tabs *directly* through the client (to exercise the client itself) opt out.
  t.after(() => {
    globalThis.fetch = original;
    if (!assertNoTabLeak) return;
    const leaked = fake.liveTabs();
    if (leaked.length > 0) {
      throw new Error(`tab leak in "${t.name}": ${JSON.stringify(leaked)}`);
    }
  });
  return fake;
}
