// ==UserScript==
// @ignorecache
// @name          Ai tab sort and tab clearer
// @description    sorts tab and arrange them into tab groups
// ==/UserScript==

(() => {
  const CONFIG = {
    SIMILARITY_THRESHOLD: 0.45,
    GROUP_SIMILARITY_THRESHOLD: 0.65, // Lowered from 0.75 to be more inclusive for existing groups
    MIN_TABS_FOR_SORT: 6, // Default fallback for the amount of tabs for the button to show, not the amount of tabs you need in a group. Overridden by the "zen.tidy-tabs.min-tabs-for-sort" pref.
    DEBOUNCE_DELAY: 250,
    ANIMATION_DURATION: 800,
    MAX_INIT_CHECKS: 50,
    INIT_CHECK_INTERVAL: 100,
    CONSOLIDATION_DISTANCE_THRESHOLD: 2,
    EMBEDDING_BATCH_SIZE: 5,
    EXISTING_GROUP_BOOST: 0.1, // Boost similarity score for existing groups to prefer them
    AUTO_ICON_DELAY_MS: 800, // Wait after sort finishes before assigning icons (lets UI settle)
    AUTO_ICON_SIMILARITY_THRESHOLD: 0.3, // Min embedding similarity to accept an icon match
    AUTO_ICON_MAX_CANDIDATES: 24, // Max Tabler candidates to embedding-rerank per group
    ICON_EMBEDDING_CACHE_LIMIT: 300,
    WARMUP_DELAY_MS: 20000, // Idle delay after init before pre-loading ML engines (lets startup fully settle)
    WARMUP_ENABLED: true, // Pre-create engines at startup so first sort is fast,
    // --- Workspace suggestions prototype (sidebar notification, not toast) ---
    WORKSPACE_SUGGEST_ENABLED: true, // Suggest better workspaces after sort finishes
    WORKSPACE_SUGGEST_THRESHOLD: 0.55, // Lowered sensitivity: min similarity to a foreign workspace
    WORKSPACE_SUGGEST_MARGIN: 0.12, // Must beat current-workspace similarity by this much
    WORKSPACE_SUGGEST_MAX: 3, // Max suggestion rows per notification (avoids clutter)
    WORKSPACE_PROFILE_CACHE_LIMIT: 20,
    // --- Auto-sort new tabs (opt-in) ---
    AUTO_SORT_DEBOUNCE_MS: 1500, // Tabs that finish loading within this window share one embedding run
    AUTO_SORT_PENDING_TTL_MS: 60000, // Forget a new tab that hasn't loaded a real page by then
    AUTO_SORT_RETRY_MS: 2000, // Re-check interval while the broom sort is running
    AUTO_SORT_MAX_BUSY_RETRIES: 10, // Then drop that batch instead of waiting forever
    AUTO_SORT_BROOM_WAIT_MS: 15000, // Max time a broom click waits for an in-flight batch
    AUTO_SORT_ARM_FALLBACK_MS: 10000, // Arm delay when SessionStore's restore promise is unavailable
    // A single new tab rarely clears GROUP_SIMILARITY_THRESHOLD against a mixed
    // group, so auto-sort also accepts a clear winner: best score at least
    // MIN_SIMILARITY and ahead of the runner-up group by MIN_MARGIN. The floor
    // is what keeps generic pages (sign-in, mail, maps, chat) out: on real
    // groups they scored up to ~0.36, while genuine members scored ~0.5+.
    // A space with a single group has no runner-up, so the floor alone decides.
    AUTO_SORT_MIN_SIMILARITY: 0.45,
    AUTO_SORT_MIN_MARGIN: 0.1,
    // --- Local LLM (Ollama, opt-in) ---
    LLM_TIMEOUT_MS: 20000, // Per call; the first call also loads the model
    LLM_MAX_TIMEOUT_MS: 60000, // Cap of the per-call timeout, which scales with tab count
    LLM_DOWN_RETRY_MS: 30000, // After a failure, skip the LLM (no network) for this long
  };

  // --- Ensure Firefox's local ML engine is enabled ---
  // The AI sorting relies on Firefox's local inference runtime, which refuses to
  // start unless "browser.ml.enable" is true. For Sine installs this is handled by
  // preferences.json, but manual installs need it set here too. Without it, every
  // embedding call throws and the sort button only plays its (failure) animation.
  try {
    if (!Services.prefs.getBoolPref("browser.ml.enable", false)) {
      Services.prefs.setBoolPref("browser.ml.enable", true);
    }
  } catch (e) {
    console.error("[TidyTabs] Could not enable browser.ml.enable:", e);
  }

  const MIN_TABS_PREF = "zen.tidy-tabs.min-tabs-for-sort";
  const AUTO_ICONS_PREF = "zen.tidy-tabs.auto-icons";
  const AUTO_ICON_KEYWORDS_PREF = "zen.tidy-tabs.auto-icons-keywords";
  const WORKSPACE_SUGGEST_PREF = "zen.tidy-tabs.workspace-suggest";
  const WORKSPACE_NAME_ONLY_PREF = "zen.tidy-tabs.workspace-name-only";
  const AUTO_SORT_PREF = "zen.tidy-tabs.auto-sort-new-tabs";
  const AUTO_SORT_CREATE_GROUPS_PREF = "zen.tidy-tabs.auto-sort-create-groups";
  const UNGROUPED_ON_TOP_PREF = "zen.tidy-tabs.ungrouped-on-top";
  const CLOSE_DUPLICATES_PREF = "zen.tidy-tabs.close-duplicates";
  const LLM_ENABLED_PREF = "zen.tidy-tabs.llm.enabled";
  const LLM_ENDPOINT_PREF = "zen.tidy-tabs.llm.endpoint";
  const LLM_MODEL_PREF = "zen.tidy-tabs.llm.model";
  const RULES_PREF = "zen.tidy-tabs.rules";
  const LLM_DEFAULT_ENDPOINT = "http://localhost:11434";
  const LLM_DEFAULT_MODEL = "qwen3:4b";

  // User-configurable minimum tab count for the sort button to appear.
  // The user can type any amount (including less than 6) in the mod settings.
  const getMinTabsForSort = () => {
    const fallback = CONFIG.MIN_TABS_FOR_SORT;
    try {
      if (typeof Services === "undefined" || !Services.prefs) return fallback;
      // Sine stores number inputs either as int or string prefs, so try both.
      try {
        const intVal = Services.prefs.getIntPref(MIN_TABS_PREF, fallback);
        if (Number.isFinite(intVal)) {
          return Math.min(100, Math.max(1, intVal));
        }
      } catch (_e) {
        /* fall through to string parsing */
      }
      try {
        const strVal = Services.prefs.getStringPref(MIN_TABS_PREF, "");
        const parsed = parseInt(String(strVal).trim(), 10);
        if (Number.isFinite(parsed)) {
          return Math.min(100, Math.max(1, parsed));
        }
      } catch (_e) {
        /* ignore */
      }
    } catch (e) {
      console.error("[TabSort] Error reading min-tabs pref, using fallback:", e);
    }
    return fallback;
  };

  // Auto-icons toggle. Defaults to true so existing installs get icons
  // without opening settings; unlisted pref reads throw, hence try/catch.
  const getAutoIconsEnabled = () => {
    try {
      if (typeof Services === "undefined" || !Services.prefs) return true;
      try {
        return Services.prefs.getBoolPref(AUTO_ICONS_PREF, true);
      } catch (_e) {
        return true;
      }
    } catch (e) {
      console.error("[TabSort] Error reading auto-icons pref:", e);
      return true;
    }
  };

  // Keyword fast-path toggle. When false, only the local AI embedding
  // match runs over the Tabler set. Defaults to false: AI is the default.
  const getAutoIconKeywordsEnabled = () => {
    try {
      if (typeof Services === "undefined" || !Services.prefs) return false;
      try {
        return Services.prefs.getBoolPref(AUTO_ICON_KEYWORDS_PREF, false);
      } catch (_e) {
        return false;
      }
    } catch (e) {
      console.error("[TabSort] Error reading auto-icon keywords pref:", e);
      return false;
    }
  };

  const getWorkspaceSuggestEnabled = () => {
    try {
      if (typeof Services === "undefined" || !Services.prefs)
        return CONFIG.WORKSPACE_SUGGEST_ENABLED;
      try {
        return Services.prefs.getBoolPref(
          WORKSPACE_SUGGEST_PREF,
          CONFIG.WORKSPACE_SUGGEST_ENABLED
        );
      } catch (_e) {
        return CONFIG.WORKSPACE_SUGGEST_ENABLED;
      }
    } catch (e) {
      console.error("[TabSort] Error reading workspace-suggest pref:", e);
      return CONFIG.WORKSPACE_SUGGEST_ENABLED;
    }
  };

  // When true, workspace profiles embed only the workspace name,
  // ignoring pinned tabs (stricter, less noisy).
  const getWorkspaceNameOnly = () => {
    try {
      if (typeof Services === "undefined" || !Services.prefs) return false;
      try {
        return Services.prefs.getBoolPref(WORKSPACE_NAME_ONLY_PREF, false);
      } catch (_e) {
        return false;
      }
    } catch (e) {
      console.error("[TabSort] Error reading workspace-name-only pref:", e);
      return false;
    }
  };

  // Auto-sort toggles. Both opt-in (default false); read on every step so
  // switching them off takes effect immediately.
  const getAutoSortEnabled = () => {
    try {
      if (typeof Services === "undefined" || !Services.prefs) return false;
      try {
        return Services.prefs.getBoolPref(AUTO_SORT_PREF, false);
      } catch (_e) {
        return false;
      }
    } catch (e) {
      console.error("[TabSort] Error reading auto-sort pref:", e);
      return false;
    }
  };

  // Where loose tabs end up after a sort: below the groups (default, original
  // behaviour) or above them.
  const getUngroupedOnTopEnabled = () => {
    try {
      return Services.prefs.getBoolPref(UNGROUPED_ON_TOP_PREF, false);
    } catch (_e) {
      return false;
    }
  };

  // Off by default: closing tabs is destructive, so the user opts in.
  const getCloseDuplicatesEnabled = () => {
    try {
      return Services.prefs.getBoolPref(CLOSE_DUPLICATES_PREF, false);
    } catch (_e) {
      return false;
    }
  };

  const getAutoSortCreateGroupsEnabled = () => {
    try {
      if (typeof Services === "undefined" || !Services.prefs) return false;
      try {
        return Services.prefs.getBoolPref(AUTO_SORT_CREATE_GROUPS_PREF, false);
      } catch (_e) {
        return false;
      }
    } catch (e) {
      console.error("[TabSort] Error reading auto-sort create-groups pref:", e);
      return false;
    }
  };

  // --- Local LLM (Ollama) + site rules: all opt-in ---
  const getLlmEnabled = () => {
    try {
      return Services.prefs.getBoolPref(LLM_ENABLED_PREF, false);
    } catch (_e) {
      return false;
    }
  };

  const getLlmEndpoint = () => {
    try {
      let v = Services.prefs
        .getStringPref(LLM_ENDPOINT_PREF, LLM_DEFAULT_ENDPOINT)
        .trim()
        .replace(/\/+$/, "");
      if (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `http://${v}`;
      return v || LLM_DEFAULT_ENDPOINT;
    } catch (_e) {
      return LLM_DEFAULT_ENDPOINT;
    }
  };

  const getLlmModel = () => {
    try {
      return (
        Services.prefs.getStringPref(LLM_MODEL_PREF, LLM_DEFAULT_MODEL).trim() ||
        LLM_DEFAULT_MODEL
      );
    } catch (_e) {
      return LLM_DEFAULT_MODEL;
    }
  };

  const getRulesText = () => {
    try {
      return Services.prefs.getStringPref(RULES_PREF, "");
    } catch (_e) {
      return "";
    }
  };

  // Title (max 120 chars) + host/path of a tab. No query string or hash is
  // ever sent to the model; non-http(s) tabs get an empty url.
  const tabTextForLlm = (tab) => {
    let title = "";
    let url = "";
    try {
      title = String(getTabTitle(tab) || "").trim().slice(0, 120);
    } catch (_e) {
      /* ignore */
    }
    try {
      const spec = tab?.linkedBrowser?.currentURI?.spec || "";
      if (/^https?:/i.test(spec)) {
        const u = new URL(spec);
        url = u.host + u.pathname;
      }
    } catch (_e) {
      /* ignore */
    }
    return { title, url };
  };

  let llmDownUntil = 0;
  const isLlmDownNow = () => Date.now() < llmDownUntil;
  const isLlmActive = () => getLlmEnabled() && !isLlmDownNow();

  // One Ollama chat call with a JSON-schema constrained reply. Returns the
  // parsed object or null on ANY failure (never throws). A failure marks the
  // LLM down for LLM_DOWN_RETRY_MS: calls return null instantly, no network.
  // Per-call timeout grows with the number of tabs in the prompt.
  const llmTimeoutMs = (tabCount) =>
    Math.min(CONFIG.LLM_MAX_TIMEOUT_MS, 10000 + 400 * tabCount);

  let llmRemoteWarned = false;
  const warnIfRemoteEndpoint = (endpoint) => {
    if (llmRemoteWarned) return;
    try {
      const host = new URL(endpoint).hostname;
      if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
        llmRemoteWarned = true;
        console.warn(
          `[TabSort][LLM] endpoint host "${host}" is not local: tab titles and addresses are sent there`
        );
      }
    } catch (_e) {
      /* ignore */
    }
  };

  // Names no group should get: such tabs stay loose instead.
  const GENERIC_GROUP_NAME_RE =
    /^(misc|other|general|various|tabs|uncategorized|miscellaneous|browsing)$/i;

  const llmChat = async (
    messages,
    schema,
    { timeoutMs = CONFIG.LLM_TIMEOUT_MS } = {}
  ) => {
    if (!getLlmEnabled()) return null;
    if (isLlmDownNow()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const endpoint = getLlmEndpoint();
      warnIfRemoteEndpoint(endpoint);
      const res = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: getLlmModel(),
          messages,
          stream: false,
          think: false,
          format: schema,
          keep_alive: "30m",
          options: { temperature: 0, num_ctx: 8192 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({})))?.error;
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      const data = await res.json();
      const parsed = JSON.parse(data?.message?.content);
      if (parsed === null || typeof parsed !== "object") {
        throw new Error("reply is not a JSON object");
      }
      llmDownUntil = 0;
      return parsed;
    } catch (e) {
      const wasUp = !isLlmDownNow();
      llmDownUntil = Date.now() + CONFIG.LLM_DOWN_RETRY_MS;
      if (wasUp) {
        console.warn(
          `[TabSort][LLM] call failed, using built-in AI for ${
            CONFIG.LLM_DOWN_RETRY_MS / 1000
          }s: ${e?.name === "AbortError" ? "timeout" : e?.message || e}`
        );
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // "pattern => Group name" rules, one per line or ';'-separated.
  let rulesCache = { text: null, rules: [] };
  const parseRules = (text) => {
    const src = String(text ?? "");
    if (rulesCache.text === src) return rulesCache.rules;
    const rules = [];
    for (const part of src.split(/[\n;]/)) {
      const idx = part.indexOf("=>");
      if (idx < 0) continue;
      const pattern = part
        .slice(0, idx)
        .trim()
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "");
      const group = part.slice(idx + 2).trim();
      if (pattern && group) rules.push({ pattern, group });
    }
    rulesCache = { text: src, rules };
    return rules;
  };

  // Group name of the first rule whose pattern is a substring of the tab's
  // lowercased host + pathname, else null.
  const matchRule = (tab) => {
    try {
      const rules = parseRules(getRulesText());
      if (!rules.length) return null;
      const { url } = tabTextForLlm(tab);
      if (!url) return null;
      const hay = url.toLowerCase();
      for (const r of rules) if (hay.includes(r.pattern)) return r.group;
    } catch (_e) {
      /* ignore */
    }
    return null;
  };

  // Prompt building blocks shared by llmAssignTabs and llmClusterTabs.
  // `groups` is a Map label -> { element?, tabTitles? }.
  const llmGroupLines = (groups) =>
    Array.from(groups.keys()).map((label) => {
      const info = groups.get(label) || {};
      let titles = info.tabTitles;
      if (!titles && info.element?.isConnected) {
        titles = Array.from(info.element.querySelectorAll("tab")).map((t) =>
          getTabTitle(t)
        );
      }
      titles = (titles || [])
        .filter(Boolean)
        .slice(0, 5)
        .map((t) => String(t).slice(0, 80));
      return titles.length
        ? `- "${label}": ${titles.join(" | ")}`
        : `- "${label}"`;
    });
  const llmTabLines = (tabs) =>
    tabs.map((tab, i) => {
      const { title, url } = tabTextForLlm(tab);
      return `${i}. ${title || "(untitled)"}${url ? ` -- ${url}` : ""}`;
    });

  const LLM_NEW_GROUP_MAX = 24;
  // Tabs per llmAssignTabs call (broom and auto-sort). One tab per call: 20-tab chunks
  // dumped generic pages into groups (16 wrong of 60); single calls gave 2 wrong. The
  // system prompt and groups block precede the tab text and are identical across
  // calls, so Ollama reuses its prefix (KV) cache.
  const LLM_ASSIGN_CHUNK = 1;
  const LLM_NEWGROUP_CHUNK = 20; // auto-sort pass 2: loose tabs per call when proposing new groups
  // One LLM call that files tabs into groups. `groups` is a Map label ->
  // { element?, tabTitles? }: real groups (element present) and, for the
  // broom sort, proposed names that have no element and no member tabs yet.
  // Returns an array parallel to `tabs` of { group, newGroup } (group is the
  // real label from `groups`, newGroup a trimmed new name, either may be
  // null), or null when the LLM is unusable or its reply is invalid.
  const llmAssignTabs = async (tabs, groups, { allowNew = false } = {}) => {
    if (!tabs.length || !isLlmActive()) return null;
    try {
      const labels = Array.from(groups.keys());
      const byLower = new Map(labels.map((l) => [l.toLowerCase(), l]));
      const groupLines = llmGroupLines(groups);
      const tabLines = llmTabLines(tabs);
      // With new groups allowed, the plain "when unsure use null" line made qwen3:4b answer
      // null for every same-subject pair, so the hedge there is narrower (existing-group match and generic pages only).
      const system =
        "You file browser tabs into tab groups. A tab left ungrouped is fine; a tab in the wrong group is not.\n" +
        "Rules:\n" +
        '- Set "group" to an existing group name when the tab is the same kind of content or topic as that group\'s tabs (for example another recipe for a recipes group, another pull request for a pull request group). Copy the name exactly. If the match is only vague or partial, use null.\n' +
        "- Generic utility pages always get null for both fields: search engines, sign-in or account pages, email inboxes, maps, calendars, new tab pages, social media feeds, video homepages.\n" +
        (allowNew
          ? '- If two or more tabs fit no existing group but are about the same specific subject, they must all get new_group: one short 1-3 word Title Case name, identical for all tabs of that topic. Example: tabs "Rust ownership explained" and "Rust async book" both get group null and new_group "Rust Docs". A tab with no partner, or a generic utility page, gets null. Never set both group and new_group.\n'
          : '- Always set "new_group" to null.\n') +
        (allowNew
          ? "- When unsure whether a tab belongs to an existing group, use null for group; generic pages always get null for both. "
          : "- When unsure about a tab, use null for both. ") +
        'Answer with JSON only: one assignment per tab, using the tab number as "i".';
      const user =
        `Existing groups:\n${groupLines.length ? groupLines.join("\n") : "(none)"}\n\n` +
        `Tabs:\n${tabLines.join("\n")}`;
      const schema = {
        type: "object",
        properties: {
          assignments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                i: { type: "integer" },
                group: { type: ["string", "null"] },
                new_group: { type: ["string", "null"] },
              },
              required: ["i", "group", "new_group"],
            },
          },
        },
        required: ["assignments"],
      };
      const reply = await llmChat(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        schema,
        { timeoutMs: llmTimeoutMs(tabs.length) }
      );
      if (!reply) return null;
      const list = reply.assignments;
      if (!Array.isArray(list)) {
        console.warn("[TabSort][LLM] reply has no assignments array, using built-in AI");
        return null;
      }
      const out = tabs.map(() => ({ group: null, newGroup: null }));
      const nameOf = (v) => {
        const t = typeof v === "string" ? v.trim() : "";
        return /^(null|none|n\/a|-)?$/i.test(t) ? "" : t;
      };
      let valid = 0;
      for (const a of list) {
        if (!a || typeof a !== "object") continue;
        if (!Number.isInteger(a.i) || a.i < 0 || a.i >= tabs.length) continue;
        valid++;
        const g = nameOf(a.group).toLowerCase();
        let group = g ? byLower.get(g) || null : null;
        let newGroup = null;
        if (!group && allowNew) {
          const n = nameOf(a.new_group).slice(0, LLM_NEW_GROUP_MAX).trim();
          if (n && !GENERIC_GROUP_NAME_RE.test(n)) {
            const existing = byLower.get(n.toLowerCase());
            if (existing) group = existing;
            else newGroup = n;
          }
        }
        out[a.i] = { group, newGroup };
      }
      if (valid === 0) {
        console.warn("[TabSort][LLM] reply had no usable assignments, using built-in AI");
        return null;
      }
      return out;
    } catch (e) {
      console.warn("[TabSort][LLM] assign failed, using built-in AI:", e?.message || e);
      return null;
    }
  };
  // Broom sort, step 2: group loose tabs that share a clear topic into NEW
  // named groups (existing groups were already tried via llmAssignTabs).
  // `existingLabels` is a list of real group labels; a proposed name equal to
  // one (case-insensitive) is mapped to it. Chunks of 40; later chunks are
  // told the names proposed so far. Returns [{ name, tabs }] (tabs are the
  // given tab objects, >= 2 each) or null when the LLM is unusable/invalid.
  const LLM_CLUSTER_CHUNK = 40;
  const llmClusterTabs = async (tabs, existingLabels = []) => {
    if (!tabs.length || !isLlmActive()) return null;
    try {
      const byLower = new Map(existingLabels.map((l) => [l.toLowerCase(), l]));
      const schema = {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                tabs: { type: "array", items: { type: "integer" } },
              },
              required: ["name", "tabs"],
            },
          },
        },
        required: ["groups"],
      };
      const merged = new Map(); // lowercase name -> { name, tabs }
      for (let start = 0; start < tabs.length; start += LLM_CLUSTER_CHUNK) {
        const chunk = tabs.slice(start, start + LLM_CLUSTER_CHUNK);
        const proposed = Array.from(merged.values()).map((g) => g.name);
        const system =
          "You organize browser tabs into topic groups. Find every set of tabs about the same specific subject, project or activity, and put each set in its own group. A tab left out is fine; a tab in the wrong group is not.\n" +
          "Rules:\n" +
          "- A group needs 2 or more tabs about the same subject (same programming language, same trip or destination, same recipe collection, same product, same project). Pages about places or travel inside the same country or city belong together. Tabs do not have to be next to each other in the list, so read every tab and compare it with all the others. Name each group after its own tabs' subject.\n" +
          "- Group name: 1-3 words, Title Case, max 24 characters, taken from the subject the tabs share.\n" +
          "- Leave OUT of every group: generic utility pages (email inboxes, maps, search engines, calendars, sign-in or account pages, social media feeds, video homepages) and any tab with no partner on the same subject, such as a lone news article.\n" +
          "- A tab goes in at most one group. When unsure, leave the tab out.\n" +
          (proposed.length
            ? `- Group names already used for earlier tabs: ${proposed
                .map((n) => `"${n}"`)
                .join(", ")}. Reuse the exact name when these tabs share that subject.\n`
            : "") +
          'Answer with JSON only: {"groups":[{"name":"...","tabs":[tab numbers]}]}. Use exactly the number in [brackets] at the start of each tab line, and re-check that every number you list belongs to that group.';
        const user = `Tabs:\n${llmTabLines(chunk).map((l) => l.replace(/^(\d+)\. /, "[$1] ")).join("\n")}`;
        const reply = await llmChat(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          schema,
          { timeoutMs: llmTimeoutMs(chunk.length) }
        );
        if (!reply) return null;
        if (!Array.isArray(reply.groups)) {
          console.warn("[TabSort][LLM] cluster reply has no groups array, using built-in AI");
          return null;
        }
        const used = new Set();
        for (const g of reply.groups) {
          if (!g || typeof g !== "object" || !Array.isArray(g.tabs)) continue;
          let name = typeof g.name === "string" ? g.name.trim() : "";
          name = name.replace(/^['"`]+|['"`]+$/g, "").slice(0, LLM_NEW_GROUP_MAX).trim();
          if (!name || /^(null|none|n\/a|group|untitled|-)$/i.test(name)) continue;
          if (GENERIC_GROUP_NAME_RE.test(name)) continue; // tabs stay loose
          const idxs = [];
          for (const i of g.tabs) {
            if (!Number.isInteger(i) || i < 0 || i >= chunk.length) continue;
            if (used.has(i) || idxs.includes(i)) continue;
            idxs.push(i);
          }
          if (idxs.length < 2) continue; // first-wins applies only to groups kept
          idxs.forEach((i) => used.add(i));
          const key = name.toLowerCase();
          const label = byLower.get(key) || name;
          const mkey = label.toLowerCase();
          if (!merged.has(mkey)) merged.set(mkey, { name: label, tabs: [] });
          for (const i of idxs) merged.get(mkey).tabs.push(chunk[i]);
        }
      }
      return Array.from(merged.values());
    } catch (e) {
      console.warn("[TabSort][LLM] cluster failed, using built-in AI:", e?.message || e);
      return null;
    }
  };

  const getTabIconURL = (tab) => {
    try {
      if (!tab?.isConnected) return "";
      // Firefox tab favicon: image attribute is the most reliable.
      const attrImg = tab.getAttribute?.("image") || "";
      if (attrImg && !attrImg.includes("chrome://")) return attrImg;
      const imgEl =
        tab.querySelector?.(".tab-icon-image, image.tab-icon-image");
      const src = imgEl?.src || imgEl?.getAttribute?.("src") || "";
      if (src && !src.includes("chrome://")) return src;
      return attrImg || "";
    } catch (_e) {
      return "";
    }
  };

  const BROOM_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 28 28" class="broom-icon">
                                    <g>
                                        <path d="M19.9132 21.3765C19.8875 21.0162 19.6455 20.7069 19.3007 20.5993L7.21755 16.8291C6.87269 16.7215 6.49768 16.8384 6.27165 17.1202C5.73893 17.7845 4.72031 19.025 3.78544 19.9965C2.4425 21.392 3.01177 22.4772 4.66526 22.9931C4.82548 23.0431 5.78822 21.7398 6.20045 21.7398C6.51906 21.8392 6.8758 23.6828 7.26122 23.8031C7.87402 23.9943 8.55929 24.2081 9.27891 24.4326C9.59033 24.5298 10.2101 23.0557 10.5313 23.1559C10.7774 23.2327 10.7236 24.8834 10.9723 24.961C11.8322 25.2293 12.699 25.4997 13.5152 25.7544C13.868 25.8645 14.8344 24.3299 15.1637 24.4326C15.496 24.5363 15.191 26.2773 15.4898 26.3705C16.7587 26.7664 17.6824 27.0546 17.895 27.1209C19.5487 27.6369 20.6333 27.068 20.3226 25.1563C20.1063 23.8255 19.9737 22.2258 19.9132 21.3765Z" stroke="none"/>
                                        <path d="M16.719 1.7134C17.4929-0.767192 20.7999 0.264626 20.026 2.74523C19.2521 5.22583 18.1514 8.75696 17.9629 9.36C17.7045 10.1867 16.1569 15.1482 15.899 15.9749L19.2063 17.0068C20.8597 17.5227 20.205 19.974 18.4514 19.4268L8.52918 16.331C6.87208 15.8139 7.62682 13.3938 9.28426 13.911L12.5916 14.9429C12.8495 14.1163 14.3976 9.15491 14.6555 8.32807C14.9135 7.50122 15.9451 4.19399 16.719 1.7134Z" stroke="none"/>
                                    </g>
                                </svg>`;

  // --- Globals & State ---
  let isSorting = false;
  let broomWaiting = false; // broom click waiting for an in-flight auto-sort batch: tells it to stop
  let sortButtonListenerAdded = false;
  let isPlayingFailureAnimation = false;
  let sortAnimationId = null;
  let eventListenersAdded = false;
  let minTabsPrefObserver = null;
  // In-flight auto-sort batch; the broom sort awaits it so clicks are never dropped.
  let autoSortPromise = null;

  // DOM Cache for performance
  const domCache = {
    separators: null,
    commandSet: null,

    getSeparators() {
      if (!this.separators || !this.separators.length) {
        // The Library Spaces section deep-clones real strips into
        // .zen-library-spaces cards (renaming ids to *-copy). Those clones
        // must never be treated as real separators.
        this.separators = Array.from(
          document.querySelectorAll(".pinned-tabs-container-separator")
        ).filter(
          (sep) => !sep.closest(".zen-library-spaces, zen-library")
        );
      }
      return this.separators;
    },

    getCommandSet() {
      if (!this.commandSet) {
        this.commandSet = document.querySelector("commandset#zenCommandSet");
      }
      return this.commandSet;
    },

    invalidate() {
      this.separators = null;
      this.commandSet = null;
    },
  };

  // --- Helper Functions ---

  // Zen's gBrowser.tabs can expose only the selected space. Use the same
  // workspace containers that Library uses to render every card.
  const getWorkspaceTabs = (workspaceId) => {
    const workspace = window.gZenWorkspaces?.workspaceElement(workspaceId);
    const tabs = new Set();
    for (const container of [workspace?.pinnedTabsContainer, workspace?.tabsContainer]) {
      container?.querySelectorAll("tab").forEach(tab => {
        if (tab.isConnected && !tab.hasAttribute("cloned") &&
            tab.getAttribute("zen-workspace-id") === workspaceId) tabs.add(tab);
      });
    }
    return Array.from(tabs);
  };

  // Optimized tab filtering function
  const getFilteredTabs = (workspaceId, options = {}) => {
    if (!workspaceId || typeof gBrowser === "undefined" || !gBrowser.tabs) {
      return [];
    }

    const {
      includeGrouped = false,
      includeSelected = true,
      includePinned = false,
      includeEmpty = false,
      includeGlance = false,
    } = options;

    return getWorkspaceTabs(workspaceId).filter((tab) => {
      if (!tab?.isConnected) return false;

      const isInCorrectWorkspace =
        tab.getAttribute("zen-workspace-id") === workspaceId;
      if (!isInCorrectWorkspace) return false;

      const groupParent = tab.closest("tab-group");
      const isInGroup = !!groupParent;

      return (
        (includePinned || !tab.pinned) &&
        (includeGrouped || !isInGroup) &&
        (includeSelected || !tab.selected) &&
        (includeEmpty || !tab.hasAttribute("zen-empty-tab")) &&
        (includeGlance || !tab.hasAttribute("zen-glance-tab"))
      );
    });
  };

  const getTabTitle = (tab) => {
    if (!tab?.isConnected) {
      return "Invalid Tab";
    }
    try {
      const originalTitle =
        tab.getAttribute("label") ||
        tab.querySelector(".tab-label, .tab-text")?.textContent ||
        "";

      if (
        !originalTitle ||
        originalTitle === "New Tab" ||
        originalTitle === "about:blank" ||
        originalTitle === "Loading..." ||
        originalTitle.startsWith("http:") ||
        originalTitle.startsWith("https:")
      ) {
        const browser =
          tab.linkedBrowser ||
          tab._linkedBrowser ||
          gBrowser?.getBrowserForTab?.(tab);

        if (
          browser?.currentURI?.spec &&
          !browser.currentURI.spec.startsWith("about:")
        ) {
          try {
            const currentURL = new URL(browser.currentURI.spec);
            const hostname = currentURL.hostname.replace(/^www\./, "");
            if (
              hostname &&
              hostname !== "localhost" &&
              hostname !== "127.0.0.1"
            ) {
              return hostname;
            }
            const pathSegment = currentURL.pathname.split("/")[1];
            if (pathSegment) return pathSegment;
          } catch {
            /* ignore */
          }
        }
        return "Untitled Page";
      }
      return originalTitle.trim() || "Untitled Page";
    } catch (e) {
      console.error("Error getting tab title for tab:", tab, e);
      return "Error Processing Tab";
    }
  };

  const toTitleCase = (str) => {
    if (!str || typeof str !== "string") return "";
    return str
      .toLowerCase()
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  const levenshteinDistance = (a, b) => {
    if (!a || !b || typeof a !== "string" || typeof b !== "string") {
      return Math.max(a?.length ?? 0, b?.length ?? 0);
    }
    a = a.toLowerCase();
    b = b.toLowerCase();
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1, // Deletion
          matrix[i][j - 1] + 1, // Insertion
          matrix[i - 1][j - 1] + cost // Substitution
        );
      }
    }
    return matrix[b.length][a.length];
  };

  const findGroupElement = (topicName, workspaceId) => {
    if (!topicName || typeof topicName !== "string" || !workspaceId)
      return null;

    const sanitizedTopicName = topicName.trim();
    if (!sanitizedTopicName) return null;

    const safeSelectorTopicName = sanitizedTopicName
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

    try {
      return document.querySelector(
        `tab-group[label="${safeSelectorTopicName}"][zen-workspace-id="${workspaceId}"]`
      );
    } catch (e) {
      console.error(
        `Error finding group selector for "${sanitizedTopicName}":`,
        e
      );
      return null;
    }
  };

  // --- AI Interaction ---

  // Helper function to average embeddings
  function averageEmbedding(arrays) {
    if (!Array.isArray(arrays) || arrays.length === 0) return [];
    // If already a flat array, just return it
    if (typeof arrays[0] === "number") return arrays;
    // Otherwise, average across all arrays
    const len = arrays[0].length;
    const avg = new Array(len).fill(0);
    for (const arr of arrays) {
      for (let i = 0; i < len; i++) {
        avg[i] += arr[i];
      }
    }
    for (let i = 0; i < len; i++) {
      avg[i] /= arrays.length;
    }
    return avg;
  }

  // Cosine similarity function
  function cosineSimilarity(a, b) {
    // Guard: ensure both a and b are defined, arrays, and contain numbers
    if (
      !Array.isArray(a) ||
      !Array.isArray(b) ||
      a.length !== b.length ||
      a.length === 0
    )
      return 0;
    if (typeof a[0] !== "number" || typeof b[0] !== "number") return 0;
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Improved greedy clustering with input validation
  function clusterEmbeddings(vectors, threshold = CONFIG.SIMILARITY_THRESHOLD) {
    if (
      !Array.isArray(vectors) ||
      vectors.length === 0 ||
      typeof threshold !== "number"
    ) {
      return [];
    }

    const groups = [];
    const used = new Array(vectors.length).fill(false);

    for (let i = 0; i < vectors.length; i++) {
      if (used[i]) continue;
      const group = [i];
      used[i] = true;

      for (let j = 0; j < vectors.length; j++) {
        if (
          i !== j &&
          !used[j] &&
          cosineSimilarity(vectors[i], vectors[j]) > threshold
        ) {
          group.push(j);
          used[j] = true;
        }
      }
      groups.push(group);
    }
    return groups;
  }

  // Batch DOM operations for better performance
  const batchDOMUpdates = (operations) => {
    if (!Array.isArray(operations) || operations.length === 0) return;

    // Use document fragment for batching when possible
    const fragment = document.createDocumentFragment();

    try {
      operations.forEach((operation) => {
        if (typeof operation === "function") {
          operation(fragment);
        }
      });
    } catch (error) {
      console.error("Error in batch DOM operations:", error);
    }
  };

  // --- ML engine singletons + embedding cache (perf) ---
  // createEngine() spins up the inference runtime; doing it per-tab made
  // sorting 15+ tabs painfully slow. Reuse one engine per model instead.
  let embeddingEnginePromise = null;
  let namerEnginePromise = null;
  const embeddingCache = new Map();
  const EMBEDDING_CACHE_LIMIT = 500;

  // --- ML run serialization + port-death helpers ---
  // "Port does not exist" (MLEngineParent.sys.mjs) means the inference
  // process / actor died. It happens when two engine.run() calls overlap
  // (warmup vs sort, sort vs auto-icons) or the idle process is reaped.
  // Serialize every run through a per-engine queue so only one inference
  // is ever in flight, and retry dead ports after a short backoff so the
  // process can restart instead of hammering a dead actor.
  let embeddingRunQueue = Promise.resolve();
  let namerRunQueue = Promise.resolve();
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const isDeadPortError = (e) => {
    const msg = String(e?.message ?? e ?? "");
    return /port does not exist|port closed|message port|actor.*destroy|ns_error|aborted/i.test(
      msg
    );
  };
  const enqueueEmbeddingRun = (fn) => {
    const run = embeddingRunQueue.then(fn, fn);
    // Keep the queue alive even if this run rejects.
    embeddingRunQueue = run.catch(() => {});
    return run;
  };
  const enqueueNamerRun = (fn) => {
    const run = namerRunQueue.then(fn, fn);
    namerRunQueue = run.catch(() => {});
    return run;
  };
  // Only drop the singleton if it is still the failed instance — otherwise
  // we'd discard a fresh engine another retry just created (extra
  // re-download + another port race).
  const invalidateEmbeddingEngine = (known = null) => {
    try {
      if (!known || embeddingEnginePromise === known) {
        embeddingEnginePromise = null;
      }
    } catch (_e) {
      embeddingEnginePromise = null;
    }
  };
  const invalidateNamerEngine = (known = null) => {
    try {
      if (!known || namerEnginePromise === known) {
        namerEnginePromise = null;
      }
    } catch (_e) {
      namerEnginePromise = null;
    }
  };

  const getEmbeddingEngine = () => {
    if (!embeddingEnginePromise) {
      embeddingEnginePromise = (async () => {
        const { createEngine } = ChromeUtils.importESModule(
          "chrome://global/content/ml/EngineProcess.sys.mjs"
        );
        return createEngine({
          taskName: "feature-extraction",
          modelId: "Mozilla/smart-tab-embedding",
          modelHub: "huggingface",
          engineId: "embedding-engine",
        });
      })();
      // Allow retry on next call if creation failed.
      embeddingEnginePromise.catch(() => {
        embeddingEnginePromise = null;
      });
    }
    return embeddingEnginePromise;
  };

  const getNamerEngine = () => {
    if (!namerEnginePromise) {
      namerEnginePromise = (async () => {
        const { createEngine } = ChromeUtils.importESModule(
          "chrome://global/content/ml/EngineProcess.sys.mjs"
        );
        return createEngine({
          taskName: "text2text-generation",
          modelId: "Mozilla/smart-tab-topic",
          modelHub: "huggingface",
          engineId: "group-namer",
        });
      })();
      namerEnginePromise.catch(() => {
        namerEnginePromise = null;
      });
    }
    return namerEnginePromise;
  };

  // --- Startup warmup: pre-load ML engines idle so first sort is fast ---
  // createEngine() + first engine.run() pays model download + ONNX init
  // (~seconds on first sort). Do it once in the background after startup,
  // never blocking sort and never showing toasts.
  let warmupStarted = false;
  let warmupTimer = null;
  let warmupCancelled = false;

  const cancelWarmup = () => {
    warmupCancelled = true;
    if (warmupTimer != null) {
      try {
        if (typeof window.cancelIdleCallback === "function") {
          try {
            window.cancelIdleCallback(warmupTimer);
          } catch (_e) {}
        }
        clearTimeout(warmupTimer);
      } catch (_e) {}
      warmupTimer = null;
    }
  };

  const warmupMLEngines = () => {
    if (!CONFIG.WARMUP_ENABLED || warmupStarted) return;
    warmupStarted = true;
    warmupCancelled = false;

    const kick = () => {
      warmupTimer = null;
      if (warmupCancelled || document.hidden) {
        // Retry shortly when hidden — headless preload still helps,
        // but don't fight tab-restore for CPU.
        if (!warmupCancelled) {
          try {
            warmupTimer = setTimeout(kick, CONFIG.WARMUP_DELAY_MS);
          } catch (_e) {}
        }
        return;
      }
      // Never race a live sort: concurrent engine.run() calls on the same
      // engine are the top cause of "Port does not exist". Defer warmup.
      try {
        if (typeof isSorting !== "undefined" && isSorting) {
          if (!warmupCancelled) {
            try {
              warmupTimer = setTimeout(kick, 5000);
            } catch (_e) {}
          }
          return;
        }
      } catch (_e) {}
      (async () => {
        try {
          await getEmbeddingEngine();
          if (warmupCancelled) return;
          // Tiny inference forces model download + session init now,
          // so the first real sort only pays embedding time.
          try {
            await embedTexts(["warmup"]);
          } catch (_e) {
            /* engine promise reset already handled; sort will retry */
          }
          if (warmupCancelled) return;
          // Pre-create topic engine too (no generation run — saves CPU
          // until a new group actually needs naming).
          try {
            await getNamerEngine();
          } catch (_e) {}
        } catch (e) {
          console.warn(
            "[TidyTabs] ML warmup failed (will retry on first sort):",
            e
          );
        }
      })();
    };

    try {
      if (typeof window.requestIdleCallback === "function") {
        warmupTimer = window.requestIdleCallback(kick, {
          timeout: CONFIG.WARMUP_DELAY_MS + 5000,
        });
      } else {
        warmupTimer = setTimeout(kick, CONFIG.WARMUP_DELAY_MS);
      }
    } catch (_e) {
      try {
        warmupTimer = setTimeout(kick, CONFIG.WARMUP_DELAY_MS);
      } catch (_e2) {}
    }
  };

  const normalizeEmbedding = (vec) => {
    if (!Array.isArray(vec) || vec.length === 0) return null;
    if (typeof vec[0] !== "number") return null;
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (!Number.isFinite(norm) || norm === 0) return vec;
    // Engine already normalizes; re-normalizing is idempotent and cheap.
    if (Math.abs(norm - 1) < 1e-6) return vec;
    return vec.map((v) => v / norm);
  };

  const parseSingleEmbedding = (item) => {
    if (!item) return null;
    if (item?.embedding && Array.isArray(item.embedding)) {
      return item.embedding;
    }
    if (Array.isArray(item) && typeof item[0] === "number") {
      return item;
    }
    if (Array.isArray(item) && Array.isArray(item[0])) {
      return item[0];
    }
    if (item?.data) {
      try {
        return Array.from(item.data);
      } catch {
        return null;
      }
    }
    return null;
  };

  const parseEmbeddingBatch = (result, count) => {
    if (!result) return new Array(count).fill(null);
    // Batched result: one entry per input text.
    if (Array.isArray(result) && result.length === count) {
      return result.map((item) =>
        normalizeEmbedding(averageEmbedding(parseSingleEmbedding(item)))
      );
    }
    // Tensor with dims, e.g. { data: Float32Array, dims: [n, dim] }.
    if (result?.data && Array.isArray(result?.dims)) {
      try {
        const flat = Array.from(result.data);
        const [n, dim] = result.dims;
        if (result.dims.length === 2 && n === count && dim > 0) {
          return Array.from({ length: n }, (_, i) =>
            normalizeEmbedding(flat.slice(i * dim, (i + 1) * dim))
          );
        }
        if (result.dims.length === 1 && count === 1) {
          return [normalizeEmbedding(flat)];
        }
      } catch {
        /* fall through */
      }
    }
    // Single-result shapes (back-compat with old per-title path).
    if (count === 1) {
      const single = Array.isArray(result)
        ? parseSingleEmbedding(result[0] ?? result)
        : parseSingleEmbedding(result);
      return [normalizeEmbedding(averageEmbedding(single))];
    }
    return new Array(count).fill(null);
  };

  // Run true batched inference: one engine.run() for N titles.
  // A dead inference port ("Port does not exist") must drop the singleton
  // so the next call recreates the engine instead of reusing a dead one.
  // All runs are serialized via embeddingRunQueue; dead-port retries wait
  // ~800ms so the inference process can restart before the fresh engine
  // is created. If a batch parses to all-null (engine ignored batching or
  // returned an unknown shape), fall back to per-title runs so one odd
  // response can't null out a whole batch.
  const embedTextsSingleAttempt = async (titles) => {
    const known = embeddingEnginePromise;
    const engine = await getEmbeddingEngine();
    try {
      return await enqueueEmbeddingRun(() =>
        engine.run({
          args: [titles],
          options: { pooling: "mean", normalize: true },
        })
      );
    } catch (e) {
      invalidateEmbeddingEngine(known ?? embeddingEnginePromise);
      throw e;
    }
  };
  const embedOneTitleWithRetry = async (title, engineHint = null) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const known = embeddingEnginePromise;
      try {
        const engine = engineHint ?? (await getEmbeddingEngine());
        const r = await enqueueEmbeddingRun(() =>
          engine.run({
            args: [[title]],
            options: { pooling: "mean", normalize: true },
          })
        );
        const vec = parseEmbeddingBatch(r, 1)[0] ?? null;
        if (vec) return vec;
        // Parsed null without throwing (unknown shape): retry once with a
        // fresh engine unless this was the last attempt.
        if (attempt < 2) {
          invalidateEmbeddingEngine(known);
          engineHint = null;
          await sleepMs(400 * (attempt + 1));
          continue;
        }
        return null;
      } catch (e) {
        invalidateEmbeddingEngine(known);
        engineHint = null;
        if (isDeadPortError(e) && attempt < 2) {
          await sleepMs(800 * (attempt + 1));
          continue;
        }
        return null;
      }
    }
    return null;
  };
  const embedTexts = async (titles, _retried = 0) => {
    if (!Array.isArray(titles) || titles.length === 0) return [];
    const known = embeddingEnginePromise;
    try {
      const result = await embedTextsSingleAttempt(titles);
      const parsed = parseEmbeddingBatch(result, titles.length);
      // If the engine ignored batching and returned a single vector or an
      // unknown shape (all null), fall back to per-title runs on a fresh
      // read of the engine. This recovers batches that would otherwise
      // poison clustering into singletons.
      if (titles.length > 1 && parsed.every((v) => v === null)) {
        console.warn(
          "[TabSort][AI] Batch returned no usable vectors, falling back to per-title runs for",
          titles.length,
          "titles"
        );
        const out = [];
        for (const t of titles) {
          out.push(await embedOneTitleWithRetry(t));
        }
        return out;
      }
      return parsed;
    } catch (e) {
      console.error("[TabSort][AI] Error in batched embedding:", e);
      // Dead port / crashed inference process: drop the singleton so the
      // next call creates a fresh engine. Retry with backoff for transient kills.
      invalidateEmbeddingEngine(known);
      if (isDeadPortError(e) && _retried < 2) {
        console.log(
          `[TabSort][AI] Retrying embedding with a fresh engine (attempt ${_retried + 2}/3)...`
        );
        await sleepMs(800 * (_retried + 1));
        try {
          return await embedTexts(titles, _retried + 1);
        } catch (retryErr) {
          console.error("[TabSort][AI] Embedding retry failed:", retryErr);
        }
      }
      return new Array(titles.length).fill(null);
    }
  };

  const cacheKeyForTitle = (title) =>
    typeof title === "string" ? title.trim().slice(0, 256) : "";

  const getEmbeddingsForTitles = async (
    titles,
    batchSize = CONFIG.EMBEDDING_BATCH_SIZE
  ) => {
    if (!Array.isArray(titles) || titles.length === 0) return [];
    const out = new Array(titles.length).fill(null);
    const uncachedIndices = [];
    const uncachedTitles = [];
    for (let i = 0; i < titles.length; i++) {
      const key = cacheKeyForTitle(titles[i]);
      if (key && embeddingCache.has(key)) {
        const cached = embeddingCache.get(key);
        // Self-heal: entries cached as null during a crashed-engine sort
        // must be treated as misses so the next sort retries inference.
        if (Array.isArray(cached) && cached.length > 0) {
          out[i] = cached;
        } else {
          embeddingCache.delete(key);
          uncachedIndices.push(i);
          uncachedTitles.push(titles[i]);
        }
      } else {
        uncachedIndices.push(i);
        uncachedTitles.push(titles[i]);
      }
    }
    for (let i = 0; i < uncachedTitles.length; i += batchSize) {
      const batchTitles = uncachedTitles.slice(i, i + batchSize);
      const batchIdx = uncachedIndices.slice(i, i + batchSize);
      const batchResults = await embedTexts(batchTitles);
      batchResults.forEach((vec, j) => {
        const globalIdx = batchIdx[j];
        out[globalIdx] = vec;
        // Never cache failures — a null vector would poison every future
        // sort until restart (this is what made 3 sorts in a row fail).
        if (!vec) return;
        const key = cacheKeyForTitle(titles[globalIdx]);
        if (key) {
          if (embeddingCache.size >= EMBEDDING_CACHE_LIMIT) {
            const oldest = embeddingCache.keys().next().value;
            embeddingCache.delete(oldest);
          }
          embeddingCache.set(key, vec);
        }
      });
    }
    try {
      const nullCount = out.filter((v) => !v).length;
      if (nullCount > 0) {
        console.warn(
          `[TabSort][AI] Embeddings: ${out.length - nullCount}/${out.length} usable (${nullCount} null — engine crash or parse miss, will cluster on usable subset)`
        );
      }
    } catch (_e) {}
    return out;
  };

  // Process embeddings in batches for better performance.
  // Thin wrapper over the cached batched path (kept for back-compat).
  const processTabsInBatches = async (
    tabs,
    batchSize = CONFIG.EMBEDDING_BATCH_SIZE
  ) => {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];
    const titles = tabs.map((tab) => getTabTitle(tab));
    return getEmbeddingsForTitles(titles, batchSize);
  };

  const generateEmbedding = async (title) => {
    if (!title || typeof title !== "string") return null;
    try {
      const [vec] = await getEmbeddingsForTitles([title], 1);
      return vec ?? null;
    } catch (e) {
      console.error("[TabSort][AI] Error generating embedding:", e);
      return null;
    }
  };

  // --- Existing-group matching (shared by the broom sort and auto-sort) ---
  // Both paths must use exactly the same strictness, so the logic lives here.

  // Existing groups that hold tabs of a workspace, keyed by label:
  // { element, tabs, tabTitles }.
  const collectWorkspaceGroups = (workspaceId) => {
    const existingWorkspaceGroups = new Map();
    if (workspaceId) {
      const groupSelector = `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`;
      document.querySelectorAll(groupSelector).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          // Get tabs in this group to calculate group embedding
          const groupTabs = Array.from(groupEl.querySelectorAll('tab')).filter(tab => 
            tab.getAttribute("zen-workspace-id") === workspaceId
          );
          if (groupTabs.length > 0) {
            existingWorkspaceGroups.set(label, {
              element: groupEl,
              tabs: groupTabs,
              tabTitles: groupTabs.map(tab => getTabTitle(tab))
            });
          }
        }
      });
    }
    return existingWorkspaceGroups;
  };

  // Average title embedding per group (cache-hit when titles overlap with
  // open tabs). Returns Map<label, vector>.
  const embedWorkspaceGroups = async (existingWorkspaceGroups) => {
    const existingGroupEmbeddings = new Map();
    for (const [groupName, groupInfo] of existingWorkspaceGroups) {
      try {
        const groupTabEmbeddings = await getEmbeddingsForTitles(
          groupInfo.tabTitles
        );
        const validGroupEmbeddings = groupTabEmbeddings.filter(emb => 
          Array.isArray(emb) && emb.length > 0
        );
        if (validGroupEmbeddings.length > 0) {
          const avgEmbedding = averageEmbedding(validGroupEmbeddings);
          existingGroupEmbeddings.set(groupName, avgEmbedding);
        }
      } catch (e) {
        console.error(`[TabSort] Error calculating embedding for existing group "${groupName}":`, e);
      }
    }
    return existingGroupEmbeddings;
  };

  // Best existing group for one tab, or null. Embedding cosine + boost
  // first, then a levenshtein title fallback. Tabs without an embedding
  // never match (same as the original broom sort).
  const findBestExistingGroup = (
    tabTitle,
    tabEmbedding,
    existingWorkspaceGroups,
    existingGroupEmbeddings
  ) => {
    if (!tabEmbedding) return null;

    let bestMatch = null;
    let bestSimilarity = 0;

    // Check against current workspace groups
    for (const [groupName, groupInfo] of existingWorkspaceGroups) {
      const groupEmbedding = existingGroupEmbeddings.get(groupName);
      if (!groupEmbedding) continue;

      let similarity = cosineSimilarity(tabEmbedding, groupEmbedding);
      similarity += CONFIG.EXISTING_GROUP_BOOST; // Always boost existing groups

      if (similarity > CONFIG.GROUP_SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
        bestMatch = { 
          groupName, 
          similarity,
          matchType: 'embedding'
        };
        bestSimilarity = similarity;
      }
    }

    // Additional semantic matching for existing groups using title similarity
    if (!bestMatch || bestMatch.similarity < 0.8) {
      for (const [groupName, groupInfo] of existingWorkspaceGroups) {
        // Check if tab title has semantic similarity to group tabs
        const titleSimilarities = groupInfo.tabTitles.map(groupTabTitle => {
          const distance = levenshteinDistance(tabTitle.toLowerCase(), groupTabTitle.toLowerCase());
          const maxLen = Math.max(tabTitle.length, groupTabTitle.length);
          return maxLen > 0 ? 1 - (distance / maxLen) : 0;
        });

        const maxTitleSimilarity = Math.max(...titleSimilarities);
        
        // If we find strong title similarity, consider it a match
        if (maxTitleSimilarity > 0.7) {
          const adjustedSimilarity = maxTitleSimilarity * 0.8 + CONFIG.EXISTING_GROUP_BOOST;
          if (adjustedSimilarity > CONFIG.GROUP_SIMILARITY_THRESHOLD && adjustedSimilarity > bestSimilarity) {
            bestMatch = { 
              groupName, 
              similarity: adjustedSimilarity,
              matchType: 'title'
            };
            bestSimilarity = adjustedSimilarity;
          }
        }
      }
    }

    return bestMatch;
  };

  // Auto-sort only: the broom match first, then a looser "clear winner" rule
  // on the same average group vectors (closest-tab scoring was tried and let
  // unrelated tabs in through one loosely similar title).
  const findAutoSortGroup = (
    tabTitle,
    tabEmbedding,
    existingWorkspaceGroups,
    existingGroupEmbeddings
  ) => {
    const strict = findBestExistingGroup(
      tabTitle,
      tabEmbedding,
      existingWorkspaceGroups,
      existingGroupEmbeddings
    );
    if (strict || !tabEmbedding) return strict;

    const scores = [];
    for (const groupName of existingWorkspaceGroups.keys()) {
      const avg = existingGroupEmbeddings.get(groupName);
      if (avg) scores.push({ groupName, score: cosineSimilarity(tabEmbedding, avg) });
    }
    scores.sort((a, b) => b.score - a.score);
    const [best, second] = scores;
    if (!best) return null;
    const margin = best.score - (second ? Math.max(second.score, 0) : 0);
    console.log(
      `[TabSort][Auto] "${tabTitle}" best "${best.groupName}" ${best.score.toFixed(3)}, margin ${margin.toFixed(3)}`
    );
    if (
      best.score >= CONFIG.AUTO_SORT_MIN_SIMILARITY &&
      margin >= CONFIG.AUTO_SORT_MIN_MARGIN
    ) {
      return { groupName: best.groupName, similarity: best.score, matchType: "auto" };
    }
    return null;
  };

  // Moves the loose tabs that sit below a space's first group up above it,
  // keeping their order. Zen's empty and Glance tabs stay where they are.
  const moveLooseTabsAboveGroups = (tabsContainer) => {
    const children = Array.from(tabsContainer?.children || []);
    const firstGroupIndex = children.findIndex(
      (el) => el.tagName?.toLowerCase() === "tab-group"
    );
    if (firstGroupIndex === -1) return;
    const looseTabs = children
      .slice(firstGroupIndex + 1)
      .filter(
        (el) =>
          el.tagName?.toLowerCase() === "tab" &&
          !el.pinned &&
          !el.hasAttribute("zen-empty-tab") &&
          !el.hasAttribute("zen-glance-tab")
      );
    if (looseTabs.length === 0) return;
    gBrowser.moveTabsBefore(looseTabs, children[firstGroupIndex]);
    console.log(`[TabSort] Moved ${looseTabs.length} ungrouped tab(s) above the groups`);
  };

  // Same, for every space's tabs container in this window.
  const moveLooseTabsAboveGroupsEverywhere = () => {
    if (!getUngroupedOnTopEnabled()) return;
    const containers = new Set();
    document.querySelectorAll("tab-group").forEach((group) => {
      if (group.parentNode) containers.add(group.parentNode);
    });
    for (const container of containers) {
      try {
        moveLooseTabsAboveGroups(container);
      } catch (e) {
        console.error("[TabSort] Error moving ungrouped tabs above groups:", e);
      }
    }
  };

  // Closes tabs open more than once (same exact URL) in a space, keeping one
  // per URL. Closed tabs stay in recently-closed, so Cmd+Shift+T restores them.
  const closeDuplicateTabs = (workspaceId) => {
    try {
      const byUrl = new Map();
      for (const tab of gBrowser.tabs) {
        if (
          tab.getAttribute("zen-workspace-id") !== workspaceId ||
          tab.pinned ||
          tab.hasAttribute("zen-essential") ||
          tab.hasAttribute("zen-empty-tab") ||
          tab.hasAttribute("zen-glance-tab")
        ) {
          continue;
        }
        const url = tab.linkedBrowser?.currentURI?.spec;
        if (!url || url === "about:blank") continue;
        if (!byUrl.has(url)) byUrl.set(url, []);
        byUrl.get(url).push(tab);
      }

      const toClose = [];
      for (const tabs of byUrl.values()) {
        if (tabs.length < 2) continue;
        const keep =
          tabs.find((t) => t === gBrowser.selectedTab) ||
          tabs.find((t) => t.hasAttribute("soundplaying")) ||
          tabs.find((t) => t.closest("tab-group")) ||
          tabs[0];
        for (const tab of tabs) {
          if (tab !== keep && !tab.hasAttribute("soundplaying")) {
            toClose.push(tab);
          }
        }
      }
      if (toClose.length === 0) return 0;

      gBrowser.removeTabs(toClose, { animate: false });
      console.log(`[TabSort] Closed ${toClose.length} duplicate tabs`);
      return toClose.length;
    } catch (e) {
      console.error("[TabSort] Error closing duplicate tabs:", e);
      return 0;
    }
  };

  // Group naming function (shared singleton engine).
  // "Group" results come from three places, all handled below:
  // 1) dead inference port -> engine.run throws -> retry with backoff
  //    + fresh engine (previously every later group stayed "Group");
  // 2) model returns empty/generic ("Group") -> title fallback;
  // 3) title fallback itself empty -> "Group" (last resort only).
  async function nameGroupWithSmartTabTopic(titles, _retried = 0) {
    // Plain titles only: this matches the input shape Mozilla's
    // smart-tab-topic was trained on (Firefox passes concatenated
    // titles). The old "Topic from keywords:" prefix confused the
    // small model into generic outputs.
    const input = (titles || []).join("\n").slice(0, 1000);

    const titleFallback = () => {
      const fb = String(titles?.[0] || "")
        .split("–")[0]
        .trim()
        .slice(0, 24)
        .replace(/^['"`]+|['"`]+$/g, "")
        .replace(/[.?!,:;]+$/, "");
      return fb || "Group";
    };

    // Local LLM first (opt-in); any failure/invalid name falls through to
    // the smart-tab-topic path below, unchanged.
    if (isLlmActive()) {
      try {
        const lines = (titles || [])
          .filter(Boolean)
          .slice(0, 12)
          .map((t) => `- ${String(t).slice(0, 100)}`)
          .join("\n");
        const reply = await llmChat(
          [
            {
              role: "system",
              content:
                "You name browser tab groups. Given the titles of the tabs in one group, answer with a short group name: 1-3 words, Title Case, naming the subject the tabs share. Example: titles about baking bread and pizza dough -> {\"name\":\"Baking\"}. Use a concrete subject, not a generic word like Group or Tabs. Always give a name. Answer with JSON only.",
            },
            { role: "user", content: `Tab titles:\n${lines}` },
          ],
          {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          }
        );
        const llmName = String(typeof reply?.name === "string" ? reply.name : "")
          .trim()
          .replace(/^['"`]+|['"`]+$/g, "")
          .replace(/[.?!,:;]+$/, "")
          .slice(0, 24)
          .trim();
        if (
          llmName &&
          !/^(group|untitled|new tab)$/i.test(llmName) &&
          !GENERIC_GROUP_NAME_RE.test(llmName)
        ) {
          return llmName;
        }
        if (reply) {
          console.warn("[TabSort][LLM] unusable group name, using built-in AI:", JSON.stringify(reply.name));
        }
      } catch (e) {
        console.warn("[TabSort][LLM] naming failed, using built-in AI:", e?.message || e);
      }
    }

    try {
      const knownNamer = namerEnginePromise;
      const engine = await getNamerEngine();

      let aiResult;
      try {
        aiResult = await enqueueNamerRun(() =>
          engine.run({
            args: [input],
            options: { max_new_tokens: 8, temperature: 0.7 },
          })
        );
      } catch (runErr) {
        invalidateNamerEngine(knownNamer);
        throw runErr;
      }

      const raw = aiResult?.[0]?.generated_text;
      let name = String(raw || "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l);

      console.log(
        `[TabSort][AI] Topic model raw output for [${(titles || []).slice(0, 3).join(" | ")}]:`,
        JSON.stringify(raw ?? null)
      );

      name = toTitleCase(name);
      if (!name || /^(group|untitled|new tab)?$|none|adult content/i.test(name)) {
        console.log(
          `[TabSort][AI] Topic model gave unusable name (${JSON.stringify(name)}), using title fallback`
        );
        return titleFallback();
      }

      name = name
        .replace(/^['"`]+|['"`]+$/g, "")
        .replace(/[.?!,:;]+$/, "")
        .slice(0, 24);
      return name || titleFallback();
    } catch (e) {
      console.error("[TabSort][AI] Error naming group:", e);
      // Dead port / crashed inference process: drop the singleton
      // and retry with backoff, mirroring embedTexts.
      invalidateNamerEngine();
      if (isDeadPortError(e) && _retried < 2) {
        console.log(
          `[TabSort][AI] Retrying group naming with a fresh engine (attempt ${_retried + 2}/3)...`
        );
        await sleepMs(800 * (_retried + 1));
        try {
          return await nameGroupWithSmartTabTopic(titles, _retried + 1);
        } catch (retryErr) {
          console.error("[TabSort][AI] Naming retry failed:", retryErr);
        }
      }
      return titleFallback();
    }
  }

  // Broom sort entry point: site rules first, then the local LLM (when
  // enabled and reachable), else the built-in embedding code below.
  // Returns [{ tab, topic }] like the built-in path.
  const askAIForMultipleTopics = async (tabs) => {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];
    const hasRules = parseRules(getRulesText()).length > 0;
    if (!hasRules && !isLlmActive()) return askAIForMultipleTopicsBuiltin(tabs);

    const validTabs = tabs.filter((tab) => tab?.isConnected);
    if (!validTabs.length) return [];
    const wsId = window.gZenWorkspaces?.activeWorkspace;
    const groups = collectWorkspaceGroups(wsId);
    const labelByLower = new Map(
      Array.from(groups.keys()).map((l) => [l.toLowerCase(), l])
    );
    const result = [];

    // 1. Site rules (exempt from the >= 2 tabs rule). Existing group of the
    // same name wins; otherwise the rule's name, created by the caller.
    const rest = [];
    const ruleLabels = [];
    for (const tab of validTabs) {
      const rule = hasRules ? matchRule(tab) : null;
      if (!rule) {
        rest.push(tab);
        continue;
      }
      const topic = labelByLower.get(rule.toLowerCase()) || rule;
      if (!labelByLower.has(topic.toLowerCase())) {
        labelByLower.set(topic.toLowerCase(), topic);
        ruleLabels.push(topic);
      }
      result.push({ tab, topic });
    }
    if (result.length) {
      console.log(`[TabSort] ${result.length} tab(s) filed by site rules`);
    }
    if (!rest.length) return result;

    // 2. Local LLM: existing groups first, then new groups for the leftovers.
    if (isLlmActive()) {
      try {
        const llmResult = [];
        let leftover = rest;
        let ok = true;
        let failedAt = -1;
        if (groups.size > 0) {
          leftover = [];
          for (let s = 0; s < rest.length && ok; s += LLM_ASSIGN_CHUNK) {
            const chunk = rest.slice(s, s + LLM_ASSIGN_CHUNK);
            const assigned = await llmAssignTabs(chunk, groups, {
              allowNew: false,
            });
            if (!assigned) {
              // Keep tabs already assigned; the failed chunk and every
              // later tab go to the built-in path with the leftovers.
              failedAt = s;
              ok = false;
              break;
            }
            chunk.forEach((tab, i) => {
              const g = assigned[i]?.group;
              if (g) llmResult.push({ tab, topic: g });
              else leftover.push(tab);
            });
          }
        }
        if (failedAt >= 0) {
          console.log(
            `[TabSort][LLM] broom sort: LLM failed at tab ${failedAt}, built-in AI for the rest`
          );
          const unassigned = leftover.concat(rest.slice(failedAt));
          return result
            .concat(llmResult)
            .concat(await askAIForMultipleTopicsBuiltin(unassigned));
        }
        if (ok && leftover.length >= 2) {
          const clusters = await llmClusterTabs(leftover, [
            ...groups.keys(),
            ...ruleLabels,
          ]);
          if (!clusters) ok = false;
          else {
            for (const { name, tabs: ts } of clusters) {
              for (const tab of ts) llmResult.push({ tab, topic: name });
            }
          }
        }
        if (ok) {
          console.log(
            `[TabSort][LLM] broom sort: ${llmResult.length} of ${rest.length} tab(s) grouped`
          );
          return result.concat(llmResult);
        }
      } catch (e) {
        console.warn("[TabSort][LLM] broom sort failed, using built-in AI:", e?.message || e);
      }
    }

    // LLM off or failed: built-in embedding path for the non-rule tabs.
    return result.concat(await askAIForMultipleTopicsBuiltin(rest));
  };

  const askAIForMultipleTopicsBuiltin = async (tabs) => {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];

    const validTabs = tabs.filter((tab) => tab?.isConnected);
    if (!validTabs.length) return [];

    const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
    const result = [];
    const ungroupedTabs = [];
    // Reuse first-pass vectors for the clustering pass below — no re-inference.
    const ungroupedEmbeddingsReuse = [];

    // Get existing groups in current workspace
    const existingWorkspaceGroups = collectWorkspaceGroups(currentWorkspaceId);

    // Batched inference with cache (single shared engine, no re-creation).
    const tabTitles = validTabs.map((tab) => getTabTitle(tab));
    const embeddings = await getEmbeddingsForTitles(tabTitles);

    // Calculate embeddings for existing workspace groups (cache-hit when
    // titles overlap with open tabs).
    const existingGroupEmbeddings = await embedWorkspaceGroups(
      existingWorkspaceGroups
    );

    // Enhanced matching: try to match tabs to existing groups
    for (let i = 0; i < validTabs.length; i++) {
      const tab = validTabs[i];
      const tabEmbedding = embeddings[i];
      const tabTitle = tabTitles[i];

      if (!tabEmbedding) {
        ungroupedTabs.push(tab);
        ungroupedEmbeddingsReuse.push(null);
        continue;
      }

      const bestMatch = findBestExistingGroup(
        tabTitle,
        tabEmbedding,
        existingWorkspaceGroups,
        existingGroupEmbeddings
      );

      if (bestMatch) {
        // Add tab to existing group
        result.push({ tab, topic: bestMatch.groupName });
        console.log(`[TabSort] Matched "${tabTitle}" to existing group "${bestMatch.groupName}" (similarity: ${bestMatch.similarity.toFixed(3)}, type: ${bestMatch.matchType || 'embedding'})`);
      } else {
        ungroupedTabs.push(tab);
        ungroupedEmbeddingsReuse.push(tabEmbedding);
      }
    }

    console.log(`[TabSort] Matched ${result.length} tabs to existing groups, ${ungroupedTabs.length} tabs remain ungrouped`);

    // Second pass: cluster remaining ungrouped tabs (only if we have enough)
    // Reuses first-pass vectors — no second inference run.
    if (ungroupedTabs.length > 1) {
      const ungroupedEmbeddings = ungroupedEmbeddingsReuse;

      // Filter out empty embeddings
      const validEmbeddings = ungroupedEmbeddings.filter(
        (emb) => Array.isArray(emb) && emb.length > 0
      );
      const validIndices = ungroupedEmbeddings
        .map((emb, idx) => (Array.isArray(emb) && emb.length > 0 ? idx : -1))
        .filter((idx) => idx !== -1);

      if (validEmbeddings.length > 1) {
        // Cluster the ungrouped tabs
        const allGroups = clusterEmbeddings(
          validEmbeddings,
          CONFIG.SIMILARITY_THRESHOLD
        );
        const groups = allGroups.filter(
          (group) => Array.isArray(group) && group.length > 1
        );

        if (groups.length > 0) {
          // Extract keywords function
          function extractKeywords(titles) {
            const allWords = titles
              .join(" ")
              .toLowerCase()
              .replace(/[^\w\s]/g, " ")
              .split(/\s+/)
              .filter((word) => word.length > 2);

            const wordCount = {};
            allWords.forEach((word) => {
              wordCount[word] = (wordCount[word] || 0) + 1;
            });

            const stopWords = new Set([
              "the",
              "and",
              "for",
              "are",
              "but",
              "not",
              "you",
              "all",
              "can",
              "had",
              "her",
              "was",
              "one",
              "our",
              "out",
              "day",
              "get",
              "has",
              "him",
              "his",
              "how",
              "man",
              "new",
              "now",
              "old",
              "see",
              "two",
              "way",
              "who",
              "boy",
              "did",
              "its",
              "let",
              "put",
              "say",
              "she",
              "too",
              "use",
            ]);

            const keywords = Object.entries(wordCount)
              .filter(([word]) => !stopWords.has(word))
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([word]) => word);

            return keywords;
          }

          // Process each new group
          for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
            const group = groups[groupIdx];
            const groupTabs = group.map(
              (idx) => ungroupedTabs[validIndices[idx]]
            );
            const groupTitles = groupTabs.map((tab) => getTabTitle(tab));

            // Check if this new group would be similar to an existing group
            let shouldCreateNewGroup = true;
            let targetExistingGroup = null;

            if (groupTabs.length >= 2) {
              const groupEmbeddings = group.map((idx) => validEmbeddings[idx]);
              const avgEmbedding = averageEmbedding(groupEmbeddings);

              // Check similarity to existing groups one more time with the averaged embedding
              for (const [groupName, groupInfo] of existingWorkspaceGroups) {
                const existingEmbedding = existingGroupEmbeddings.get(groupName);
                if (existingEmbedding) {
                  const similarity = cosineSimilarity(avgEmbedding, existingEmbedding) + CONFIG.EXISTING_GROUP_BOOST;
                  if (similarity > CONFIG.GROUP_SIMILARITY_THRESHOLD * 0.9) { // Slightly lower threshold for group-to-group matching
                    shouldCreateNewGroup = false;
                    targetExistingGroup = groupName;
                    console.log(`[TabSort] Merging new group into existing group "${groupName}" (similarity: ${similarity.toFixed(3)})`);
                    break;
                  }
                }
              }
            }

            if (!shouldCreateNewGroup && targetExistingGroup) {
              // Add all tabs to the existing group
              groupTabs.forEach((tab) => {
                result.push({ tab, topic: targetExistingGroup });
              });
            } else {
              // Create new group
              const groupName = await nameGroupWithSmartTabTopic(groupTitles);

              // Add to result
              groupTabs.forEach((tab) => {
                result.push({ tab, topic: groupName });
              });

              console.log(`[TabSort] Created new group "${groupName}" with ${groupTabs.length} tabs`);
            }
          }
        }
      }
    }

    return result;
  };

  // --- Auto group icons (background pass, never blocks sort) ---
  // Reuses the already-warmed Mozilla/smart-tab-embedding engine + ATG's
  // own icon inventory (Tabler via globalThis.advancedTabGroups) and its
  // persistGroupIcon renderer, so icons look exactly like manual picks.
  // Scheduled with setTimeout AFTER sort finishes; fire-and-forget.
  const iconEmbeddingCache = new Map();

  // Curated keyword -> Tabler icon name map. Instant path, no ML needed.
  // Names must exist in ATG's icons/tabler-names.js (Tabler 3.48).
  // NOTE: keep keywords specific — bare "auto" matched "automation" and
  // sent "Ai Automation" to the car icon, so it was removed.
  const ICON_KEYWORD_MAP = [
    [["automation", "automate", "workflow", "n8n", "zapier", "ifttt", "make.com"], "automation"],
    [["artificial intelligence", "llm", "chatgpt", "Muse", "gemini", "openai", "midjourney", "copilot"], "sparkles"],
    [["github", "gitlab", "code", "coding", "programming", "developer", "stackoverflow"], "brand-github"],
    [["python", "javascript", "typescript", "rust", "java "], "code"],
    [["shopping", "amazon", "ebay", "store", "buy", "cart", "deal"], "shopping-cart"],
    [["news", "article", "blog", "medium", "press"], "news"],
    [["mail", "gmail", "outlook", "email", "inbox"], "mail"],
    [["doc", "docs", "notion", "wiki", "confluence", "drive", "pdf"], "file-text"],
    [["video", "stream", "twitch", "netflix", "movie", "film"], "video"],
    [["youtube"], "brand-youtube"],
    [["music", "spotify", "soundcloud", "bandcamp", "audio"], "music"],
    [["social", "twitter", "x.com", "reddit", "facebook", "instagram", "tiktok", "discord"], "message"],
    [["work", "job", "career", "linkedin", "meeting", "slack", "teams", "jira"], "briefcase"],
    [["book", "read", "novel", "kindle", "library"], "book"],
    [["school", "learn", "course", "tutorial", "udemy", "coursera", "study", "university"], "school"],
    [["science", "research", "paper", "arxiv", "lab"], "flask"],
    [["health", "fitness", "medical", "doctor", "gym"], "heart"],
    [["sport", "football", "soccer", "basketball", "espn"], "trophy"],
    [["game", "gaming", "steam", "xbox", "playstation", "nintendo"], "device-gamepad-2"],
    [["travel", "flight", "hotel", "airbnb", "map", "trip"], "map"],
    [["photo", "camera", "unsplash", "pinterest", "design", "figma", "dribbble"], "palette"],
    [["finance", "bank", "money", "stock", "crypto", "invest"], "wallet"],
    [["weather"], "cloud"],
    [["food", "recipe", "cook", "restaurant"], "tools-kitchen-2"],
    [["home", "house", "real estate", "zillow"], "home"],
    [["car", "vehicle", "dealership", "motors"], "car"],
  ];

  // Synonym expansion for the AI path's text search. "ai" alone matches
  // hundreds of icons as a substring (air, brain, said...), so expand it to
  // concepts that actually retrieve the right candidates.
  const ICON_SYNONYMS = {
    ai: ["robot", "automation", "sparkles", "brain"],
    llm: ["robot", "sparkles", "brain"],
    automation: ["robot", "workflow", "cpu", "automation"],
    automate: ["robot", "automation"],
    n8n: ["automation", "workflow"],
    zapier: ["automation", "workflow"],
  };

  const getAtg = () => {
    try {
      return globalThis.advancedTabGroups ?? null;
    } catch (_e) {
      return null;
    }
  };

  const groupHasIcon = (group, atg) => {
    try {
      if (!group?.isConnected) return true; // treat dead nodes as "skip"
      if (group.querySelector(".tab-group-icon image, .tab-group-icon label")) return true;
      try {
        if (atg?.savedIcons?.[group.id]) return true;
      } catch (_e) {}
      return false;
    } catch (_e) {
      return true;
    }
  };

  // Filled-first URL: use the filled variant when the icon has one,
  // otherwise fall back to outline (most icons, e.g. automation/robot, are
  // outline-only). Accepts either an icon object or a bare name + lookup.
  const pickTablerIconUrl = (iconOrName, lookup) => {
    let icon = null;
    if (iconOrName && typeof iconOrName === "object" && iconOrName.name) {
      icon = iconOrName;
    } else {
      const name = String(iconOrName || "").trim();
      if (!name) return null;
      try {
        icon = lookup?.get(name) ?? null;
      } catch (_e) {
        icon = null;
      }
      if (!icon) {
        // Unknown to the index (shouldn't happen): assume outline exists.
        return `resource://atg-tabler/outline/${name.replace(/[^a-z0-9-]/gi, "")}.svg`;
      }
    }
    const safe = String(icon.name || "").trim().replace(/[^a-z0-9-]/gi, "");
    if (!safe) return null;
    const dir = icon.filled ? "filled" : "outline";
    return {
      url: `resource://atg-tabler/${dir}/${safe}.svg`,
      name: icon.name,
      variant: dir,
    };
  };

  // Group-name-only matching: tab titles are deliberately ignored so a
  // generic name like "Sports" isn't dragged toward a specific tab topic.
  const findIconByKeywords = (topic) => {
    const haystack = String(topic || "").toLowerCase();
    if (!haystack.trim()) return null;
    for (const [keywords, iconName] of ICON_KEYWORD_MAP) {
      for (const kw of keywords) {
        if (kw && haystack.includes(kw)) return iconName;
      }
    }
    return null;
  };

  const cacheIconEmbedding = (key, vec) => {
    if (!key) return;
    if (iconEmbeddingCache.size >= CONFIG.ICON_EMBEDDING_CACHE_LIMIT) {
      const oldest = iconEmbeddingCache.keys().next().value;
      iconEmbeddingCache.delete(oldest);
    }
    iconEmbeddingCache.set(key, vec);
  };

  // Inline icon pass (awaited by the sort): assign ATG icons to groups
  // that don't have one yet. Never throws outward; each group is independent.
  const assignGroupIconsBackground = async (groupsMeta) => {
    if (!Array.isArray(groupsMeta) || groupsMeta.length === 0) {
      console.log("[TabSort] Auto-icons: nothing to do (no groups).");
      return;
    }
    if (!getAutoIconsEnabled()) {
      console.log("[TabSort] Auto-icons: disabled by pref, skipping.");
      return;
    }
    const atg = getAtg();
    if (!atg || typeof atg.persistGroupIcon !== "function") {
      console.log("[TabSort] Auto-icons: Advanced Tab Groups not found, skipping.");
      return;
    }
    console.log(
      `[TabSort] Auto-icons: icon pass started for ${groupsMeta.length} group(s) (keywords ${getAutoIconKeywordsEnabled() ? "ON" : "OFF"})`
    );

    try {
      // Ensure the Tabler resource:// pack is mounted (no-op if ready).
      try {
        await atg.setupAtgTablerPack?.();
      } catch (_e) {}
    } catch (_e) {}

    // Filled variants are preferred at render time per-icon (see
    // pickTablerIconUrl) — no style filtering here, since most icons
    // (automation, robot, pool...) are outline-only.
    for (const meta of groupsMeta) {
      try {
        const group = meta?.element;
        if (!group || !group.isConnected) {
          console.log("[TabSort] Auto-icons: skipping a group (element gone)");
          continue;
        }
        if (groupHasIcon(group, atg)) {
          console.log(
            `[TabSort] Auto-icons: "${meta?.topic || group.getAttribute("label")}" already has an icon, skipping`
          );
          continue;
        }

        const topic = String(meta.topic || group.getAttribute("label") || "").trim();
        const titles = Array.isArray(meta.titles) ? meta.titles : [];
        if (!topic && titles.length === 0) continue;

        // Full Tabler index (both variants — filled preferred at render).
        let allIcons = [];
        try {
          allIcons =
            typeof atg.atgTablerIcons === "function" ? atg.atgTablerIcons() : [];
        } catch (_e) {
          allIcons = [];
        }
        const byName = new Map((allIcons || []).map((ic) => [ic.name, ic]));

        // Tier 1: instant keyword match on the group name only, zero ML cost.
        // Skipped entirely when the keywords toggle is off (AI-only mode,
        // now the default).
        let picked = null;
        let pickedVia = "";
        if (getAutoIconKeywordsEnabled()) {
          const kwName = findIconByKeywords(topic);
          if (kwName && byName.get(kwName)) {
            picked = byName.get(kwName);
            pickedVia = "keyword";
          }
        }

        // Exact shortcut: topic word equals an icon name ("automation" in
        // "Ai Automation"). AND-search excludes the exact icon here, so
        // check directly before any fuzzy logic.
        if (!picked) {
          try {
            const topicWords = String(topic || "")
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .filter((w) => w.length > 2);
            for (const w of topicWords) {
              const hit = byName.get(w);
              if (hit && (hit.filled || hit.outline)) {
                picked = hit;
                pickedVia = "exact";
                console.log(`[TabSort] Auto-icons: "${topic}" -> ${hit.name} (exact topic word)`);
                break;
              }
            }
          } catch (_e) {}
        }

        // Tier 2: local AI embedding re-rank over text-search candidates.
        // NOTE: atgTablerSearch uses AND logic, so multi-word queries miss.
        // Use per-word OR merge with synonym expansion instead.
        if (!picked) {
          console.log(`[TabSort] Auto-icons: AI match for "${topic}" (no keyword hit)`);
          try {
            const styled = (allIcons || []).filter((ic) => ic.filled || ic.outline);
            let candidates = [];
            if (typeof atg.atgTablerSearch === "function" && styled.length > 0) {
              // Group name only — titles intentionally excluded.
              const baseWords = String(topic || "")
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter((w) => w.length > 2)
                .slice(0, 8);
              // Expand "ai" -> robot/automation/etc. so the right icons
              // enter the candidate pool even when the literal word misses.
              const expanded = [];
              const seenW = new Set();
              for (const w of baseWords) {
                if (!seenW.has(w)) {
                  seenW.add(w);
                  expanded.push(w);
                }
                for (const syn of ICON_SYNONYMS[w] || []) {
                  if (!seenW.has(syn)) {
                    seenW.add(syn);
                    expanded.push(syn);
                  }
                  if (expanded.length >= 14) break;
                }
                if (expanded.length >= 14) break;
              }
              const seen = new Set();
              for (const w of expanded) {
                try {
                  for (const hit of atg.atgTablerSearch(styled, w).slice(0, 6)) {
                    if (!seen.has(hit.name)) {
                      seen.add(hit.name);
                      candidates.push(hit);
                    }
                    if (candidates.length >= CONFIG.AUTO_ICON_MAX_CANDIDATES) break;
                  }
                } catch (_e) {}
                if (candidates.length >= CONFIG.AUTO_ICON_MAX_CANDIDATES) break;
              }
            }
            if (candidates.length === 0 && styled.length > 0) {
              // Final safety net: the diverse curated set, not the first N
              // alphabetically (which would be a-b, abacus, ... every time).
              const wanted = new Set(ICON_KEYWORD_MAP.map(([, name]) => name));
              candidates = styled.filter((ic) => wanted.has(ic.name));
              if (candidates.length === 0) {
                candidates = styled.slice(0, CONFIG.AUTO_ICON_MAX_CANDIDATES);
              }
              console.log(
                `[TabSort] Auto-icons: text search found nothing for "${topic}", embedding ${candidates.length} curated icons instead`
              );
            } else {
              console.log(
                `[TabSort] Auto-icons: ${candidates.length} text candidate(s) for "${topic}"`
              );
            }
            if (candidates.length > 0) {
              // Embed the group name only — no tab titles.
              const groupText = String(topic || "").slice(0, 256);
              const [groupVec] = await getEmbeddingsForTitles([groupText], 1);
              if (groupVec) {
                const descs = candidates.map((c) =>
                  `${c.name.replace(/-/g, " ")} ${c.words || ""}`.slice(0, 256)
                );
                const uncachedIdx = [];
                const uncachedDescs = [];
                const iconVecs = new Array(descs.length).fill(null);
                descs.forEach((d, i) => {
                  const key = `icon:${candidates[i].name}`;
                  if (iconEmbeddingCache.has(key)) iconVecs[i] = iconEmbeddingCache.get(key);
                  else {
                    uncachedIdx.push(i);
                    uncachedDescs.push(d);
                  }
                });
                if (uncachedDescs.length > 0) {
                  const fresh = await getEmbeddingsForTitles(
                    uncachedDescs,
                    CONFIG.EMBEDDING_BATCH_SIZE
                  );
                  fresh.forEach((v, j) => {
                    iconVecs[uncachedIdx[j]] = v;
                    if (v) cacheIconEmbedding(`icon:${candidates[uncachedIdx[j]].name}`, v);
                  });
                }
                let best = null;
                let bestScore = 0;
                iconVecs.forEach((v, i) => {
                  if (!v) return;
                  const s = cosineSimilarity(groupVec, v);
                  if (s > bestScore) {
                    bestScore = s;
                    best = candidates[i];
                  }
                });
                if (best && bestScore >= CONFIG.AUTO_ICON_SIMILARITY_THRESHOLD) {
                  picked = best;
                  pickedVia = `ai ${bestScore.toFixed(3)}`;
                  console.log(
                    `[TabSort] Auto-icons: "${topic}" -> ${best.name} (${bestScore.toFixed(3)})`
                  );
                } else if (best) {
                  console.log(
                    `[TabSort] Auto-icons: no confident icon for "${topic}" (best ${best.name} ${bestScore.toFixed(3)} < ${CONFIG.AUTO_ICON_SIMILARITY_THRESHOLD}), leaving as-is`
                  );
                } else {
                  console.log(`[TabSort] Auto-icons: no icon vectors for "${topic}", leaving as-is`);
                }
              } else {
                console.log(`[TabSort] Auto-icons: no group embedding for "${topic}", leaving as-is`);
              }
            } else {
              console.log(`[TabSort] Auto-icons: no candidates for "${topic}", leaving as-is`);
            }
          } catch (e) {
            console.error("[TabSort] Icon embedding match failed, skipping:", e);
          }
        } else if (picked) {
          console.log(`[TabSort] Auto-icons: "${topic}" -> ${picked.name} (${pickedVia})`);
        }

        if (!picked) continue;
        const chosen = pickTablerIconUrl(picked, byName);
        if (!chosen) continue;
        // Re-check: user may have picked an icon while we were inferring.
        if (groupHasIcon(group, atg)) {
          console.log(`[TabSort] Auto-icons: "${topic}" got an icon meanwhile, skipping`);
          continue;
        }
        atg.persistGroupIcon(group, chosen.url);
          console.log(`[TabSort] Auto-icons: applied ${chosen.name} (${chosen.variant}) to "${topic}"`);
      } catch (e) {
        console.error("[TabSort] Failed to assign icon to group:", e);
      }
    }
  };

  // --- Workspace suggestions prototype (sidebar notification, not toast) ---
  // Goal: suggest a *better workspace* for tabs, based on:
  //   workspace name + its pinned tabs (averaged embedding)
  // vs. each tab title embedding. Persistent UI modeled on
  // ZenSidebarNotification (inserted after #zen-media-controls-toolbar,
  // animated via gZenUIManager.motion, close button, no auto-hide),
  // but with raw text so uc.js doesn't need fluent strings.
  // Deliberately NOT anchored per-tab (would clutter) and NOT a toast
  // (temporary). One notification, up to WORKSPACE_SUGGEST_MAX rows.
  const workspaceProfileCache = new Map();

  const getAllWorkspaceInfos = () => {
    try {
      const ws = window.gZenWorkspaces;
      if (!ws || typeof ws.getWorkspaces !== "function") return [];
      const list = ws.getWorkspaces() || [];
      return list
        .filter((w) => w && (w.uuid || w.id) && w.name)
        .map((w) => ({
          uuid: w.uuid || w.id,
          name: String(w.name || "").trim(),
          icon: w.icon || "",
        }))
        .filter((w) => w.uuid && w.name);
    } catch (e) {
      console.error("[TabSort][Workspaces] Failed to list workspaces:", e);
      return [];
    }
  };

  const getWorkspacePinnedTitles = (workspaceUuid, max = 8) => {
    try {
      const el = window.gZenWorkspaces?.workspaceElement?.(workspaceUuid);
      const container = el?.pinnedTabsContainer;
      if (!container) return [];
      const tabs = Array.from(container.querySelectorAll("tab")).filter(
        (t) => t?.isConnected && !t.hasAttribute("zen-empty-tab")
      );
      return tabs
        .map((t) => {
          try {
            return getTabTitle(t);
          } catch (_e) {
            return "";
          }
        })
        .filter((s) => s && s !== "Untitled Page" && s !== "New Tab")
        .slice(0, max);
    } catch (e) {
      console.error("[TabSort][Workspaces] Failed to read pinned tabs:", e);
      return [];
    }
  };

  const getWorkspaceProfileTexts = (workspaceUuid, workspaceName) => {
    const name = String(workspaceName || "").trim().slice(0, 256);
    // Name-only mode: strict, workspace title decides alone.
    if (getWorkspaceNameOnly()) {
      return name ? [name] : [];
    }
    const pinned = getWorkspacePinnedTitles(workspaceUuid);
    // Name first (acts as topic anchor), then pinned tabs as context.
    const texts = [name, ...pinned]
      .filter(Boolean)
      .map((s) => String(s).slice(0, 256))
      .slice(0, 10);
    return texts;
  };

  const getWorkspaceProfileEmbedding = async (workspaceUuid, workspaceName) => {
    const texts = getWorkspaceProfileTexts(workspaceUuid, workspaceName);
    if (texts.length === 0) return null;
    const cacheKey = `${workspaceUuid}::${texts.join("|").slice(0, 512)}`;
    try {
      if (workspaceProfileCache.has(workspaceUuid)) {
        const cached = workspaceProfileCache.get(workspaceUuid);
        if (cached && cached.key === cacheKey && Array.isArray(cached.vec)) {
          return cached.vec;
        }
      }
    } catch (_e) {}
    try {
      const vecs = await getEmbeddingsForTitles(texts, CONFIG.EMBEDDING_BATCH_SIZE);
      const valid = (vecs || []).filter((v) => Array.isArray(v) && v.length > 0);
      if (valid.length === 0) return null;
      const avg = averageEmbedding(valid);
      if (!Array.isArray(avg) || avg.length === 0) return null;
      try {
        if (workspaceProfileCache.size >= CONFIG.WORKSPACE_PROFILE_CACHE_LIMIT) {
          const oldest = workspaceProfileCache.keys().next().value;
          workspaceProfileCache.delete(oldest);
        }
        workspaceProfileCache.set(workspaceUuid, { key: cacheKey, vec: avg });
      } catch (_e) {}
      return avg;
    } catch (e) {
      console.error(`[TabSort][Workspaces] Embedding failed for "${workspaceName}":`, e);
      return null;
    }
  };

  const suggestBetterWorkspacesForTabs = async (tabs, currentWorkspaceId) => {
    if (!getWorkspaceSuggestEnabled()) return [];
    if (!Array.isArray(tabs) || tabs.length === 0) return [];
    if (!currentWorkspaceId) return [];
    try {
      const infos = getAllWorkspaceInfos();
      if (infos.length < 2) {
        console.log("[TabSort][Workspaces] Need 2+ named workspaces to suggest, found:", infos.length);
        return [];
      }
      // Profile embeddings for every workspace (cached per uuid+texts).
      const profileVecs = new Map();
      for (const info of infos) {
        const vec = await getWorkspaceProfileEmbedding(info.uuid, info.name);
        if (vec) profileVecs.set(info.uuid, { info, vec });
      }
      if (!profileVecs.has(currentWorkspaceId)) {
        console.log("[TabSort][Workspaces] No profile for current workspace, skipping");
        return [];
      }
      if (profileVecs.size < 2) {
        console.log("[TabSort][Workspaces] Fewer than 2 workspace profiles with embeddings");
        return [];
      }
      const currentVec = profileVecs.get(currentWorkspaceId).vec;
      const validTabs = tabs.filter((t) => t?.isConnected);
      if (validTabs.length === 0) return [];
      const tabTitles = validTabs.map((t) => getTabTitle(t));
      const tabVecs = await getEmbeddingsForTitles(tabTitles, CONFIG.EMBEDDING_BATCH_SIZE);
      const out = [];
      for (let i = 0; i < validTabs.length; i++) {
        const tabVec = tabVecs[i];
        if (!Array.isArray(tabVec) || tabVec.length === 0) continue;
        const currentSim = cosineSimilarity(tabVec, currentVec);
        let best = null;
        for (const [uuid, { info, vec }] of profileVecs) {
          if (uuid === currentWorkspaceId) continue;
          const sim = cosineSimilarity(tabVec, vec);
          if (!best || sim > best.sim) best = { uuid, info, sim };
        }
        if (!best) continue;
        const margin = best.sim - (Number.isFinite(currentSim) ? currentSim : 0);
        if (
          best.sim >= CONFIG.WORKSPACE_SUGGEST_THRESHOLD &&
          margin >= CONFIG.WORKSPACE_SUGGEST_MARGIN
        ) {
          out.push({
            tab: validTabs[i],
            tabTitle: tabTitles[i],
            tabIcon: getTabIconURL(validTabs[i]),
            fromWorkspaceId: currentWorkspaceId,
            toWorkspaceId: best.uuid,
            toWorkspaceName: best.info.name,
            toWorkspaceIcon: best.info.icon,
            similarity: best.sim,
            currentSimilarity: currentSim,
          });
        }
      }
      out.sort((a, b) => b.similarity - a.similarity);
      const sliced = out.slice(0, CONFIG.WORKSPACE_SUGGEST_MAX);
      console.log(
        `[TabSort][Workspaces] ${out.length} candidate(s), showing ${sliced.length}:`,
        sliced.map((s) => `"${s.tabTitle}" -> "${s.toWorkspaceName}" (${s.similarity.toFixed(3)} vs current ${Number(s.currentSimilarity).toFixed(3)})`)
      );
      return sliced;
    } catch (e) {
      console.error("[TabSort][Workspaces] Suggestion pass failed:", e);
      return [];
    }
  };

  const clearWorkspaceSuggestions = (animate = false) => {
    try {
      const existing = document.querySelectorAll(".tidy-workspace-suggestion");
      existing.forEach((el) => {
        try {
          if (!el?.isConnected) {
            el.remove();
            return;
          }
          if (animate && window.gZenUIManager?.motion) {
            try {
              const out = window.gZenUIManager.motion.animate(
                el,
                { opacity: [1, 0], y: [0, 10] },
                {}
              );
              Promise.resolve(out).then(
                () => el.remove(),
                () => el.remove()
              );
              setTimeout(() => {
                try {
                  if (el.isConnected) el.remove();
                } catch (_e) {}
              }, 500);
            } catch (_e) {
              el.remove();
            }
          } else {
            el.remove();
          }
        } catch (_e) {}
      });
    } catch (_e) {}
  };

  // Sidebar-notification-style, persistent (no auto-hide). Inserted after
  // #zen-media-controls-toolbar like ZenSidebarNotification. Raw text
  // (no fluent) so uc.js can show dynamic tab/workspace names.
  const showWorkspaceSuggestionsNotification = (suggestions) => {
    if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
    try {
      clearWorkspaceSuggestions(false);
      const sibling = document.getElementById("zen-media-controls-toolbar");
      if (!sibling) {
        console.warn("[TabSort][Workspaces] No #zen-media-controls-toolbar, falling back to toast");
        showTidyToast(`${suggestions.length} tab(s) may belong in another workspace`, "info");
        return null;
      }
      try {
        if (window.gZenVerticalTabsManager && window.gZenVerticalTabsManager._prefsSidebarExpanded === false) {
          console.log("[TabSort][Workspaces] Sidebar collapsed — showing notification anyway (prototype differs from upstream which returns null)");
        }
      } catch (_e) {}

      const wrapper = document.createXULElement("vbox");
      wrapper.classList.add("zen-sidebar-notification", "tidy-workspace-suggestion");
      wrapper.setAttribute("role", "status");
      wrapper.setAttribute("aria-live", "polite");

      const header = document.createElement("div");
      header.className = "zen-sidebar-notification-header tidy-workspace-suggestion-header";

      const heading = document.createElement("label");
      heading.className = "zen-sidebar-notification-heading tidy-workspace-suggestion-heading";
      heading.setAttribute("flex", "1");
      heading.textContent =
        suggestions.length === 1
          ? "Tab may belong in another workspace"
          : `${suggestions.length} tabs may belong elsewhere`;
      header.appendChild(heading);

      const closeBtn = document.createElement("div");
      closeBtn.className = "zen-sidebar-notification-close-button";
      closeBtn.setAttribute("role", "button");
      closeBtn.setAttribute("tabindex", "0");
      closeBtn.setAttribute("title", "Dismiss");
      closeBtn.setAttribute("aria-label", "Dismiss workspace suggestions");
      // Text fallback stays visible if the close.svg fails to load.
      const closeFallback = document.createElement("span");
      closeFallback.textContent = "✕";
      closeFallback.setAttribute("aria-hidden", "true");
      const closeImg = document.createElement("img");
      closeImg.src = "chrome://browser/skin/zen-icons/close.svg";
      closeImg.alt = "";
      closeImg.addEventListener("error", () => {
        try {
          closeImg.remove();
        } catch (_e) {}
      });
      closeImg.addEventListener("load", () => {
        try {
          closeFallback.remove();
        } catch (_e) {}
      });
      closeBtn.appendChild(closeFallback);
      closeBtn.appendChild(closeImg);
      const dismissNotification = () => {
        try {
          if (window.gZenUIManager?.motion) {
            const out = window.gZenUIManager.motion.animate(
              wrapper,
              { opacity: [1, 0], y: [0, 10] },
              {}
            );
            Promise.resolve(out).then(
              () => wrapper.remove(),
              () => wrapper.remove()
            );
            setTimeout(() => {
              try {
                if (wrapper.isConnected) wrapper.remove();
              } catch (_e) {}
            }, 500);
          } else {
            wrapper.remove();
          }
        } catch (_e) {
          try {
            wrapper.remove();
          } catch (_e2) {}
        }
      };
      closeBtn.addEventListener("click", dismissNotification);
      closeBtn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " " || ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          dismissNotification();
        }
      });
      header.appendChild(closeBtn);
      wrapper.appendChild(header);

      const body = document.createElement("div");
      body.className = "zen-sidebar-notification-body tidy-workspace-suggestion-body";

      const removeRowIfEmpty = () => {
        try {
          const rows = body.querySelectorAll(":scope > .tidy-workspace-row");
          if (rows.length === 0 && wrapper.isConnected) {
            wrapper.remove();
          }
        } catch (_e) {}
      };

      const moveTabForSuggestion = (s, row) => {
        try {
          const ws = window.gZenWorkspaces;
          let moved = false;
          try {
            if (
              ws &&
              typeof ws.moveTabsToWorkspace === "function" &&
              s.tab?.isConnected
            ) {
              moved = !!ws.moveTabsToWorkspace([s.tab], s.toWorkspaceId);
            } else if (
              ws &&
              typeof ws.moveTabToWorkspace === "function" &&
              s.tab?.isConnected
            ) {
              moved = !!ws.moveTabToWorkspace(s.tab, s.toWorkspaceId);
            }
          } catch (moveErr) {
            console.error("[TabSort][Workspaces] Move failed:", moveErr);
          }
          if (moved) {
            showTidyToast(
              `Moved "${String(s.tabTitle).slice(0, 40)}" → ${s.toWorkspaceName}`,
              "success"
            );
          } else {
            showTidyToast(
              `Could not move "${String(s.tabTitle).slice(0, 40)}"`,
              "error"
            );
          }
        } catch (e) {
          console.error("[TabSort][Workspaces] Move handler failed:", e);
        }
        try {
          row.remove();
        } catch (_e) {}
        removeRowIfEmpty();
      };

      for (const s of suggestions) {
        const row = document.createElement("div");
        row.className =
          "zen-sidebar-notification-link-container tidy-workspace-row";
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
        row.title = `Move to ${s.toWorkspaceName}`;

        // Tab favicon (not the ⇄ placeholder). Fall back to workspace
        // emoji/icon letter only when the tab has no favicon.
        const iconWrap = document.createElement("span");
        iconWrap.className = "tidy-workspace-row-icon";
        if (s.tabIcon) {
          const fav = document.createElement("img");
          fav.className = "tidy-workspace-row-favicon";
          fav.src = s.tabIcon;
          fav.alt = "";
          fav.decoding = "async";
          // If the favicon 404s after the tab navigated, drop it rather
          // than showing a broken image.
          fav.addEventListener("error", () => {
            try {
              fav.remove();
              const fallback = document.createElement("span");
              fallback.textContent =
                s.toWorkspaceIcon && s.toWorkspaceIcon.length <= 4
                  ? s.toWorkspaceIcon
                  : "⇄";
              iconWrap.appendChild(fallback);
            } catch (_e) {}
          });
          iconWrap.appendChild(fav);
        } else {
          iconWrap.textContent =
            s.toWorkspaceIcon && s.toWorkspaceIcon.length <= 4
              ? s.toWorkspaceIcon
              : "⇄";
        }
        row.appendChild(iconWrap);

        const textWrap = document.createElement("div");
        textWrap.className = "tidy-workspace-row-texts";
        const tabLabel = document.createElement("label");
        tabLabel.className =
          "zen-sidebar-notification-link-text tidy-workspace-row-tab";
        tabLabel.textContent = String(s.tabTitle || "Untitled").slice(0, 80);
        tabLabel.title = String(s.tabTitle || "");
        // Line 2 stays the same on hover — CSS only shifts its color.
        const destLabel = document.createElement("label");
        destLabel.className = "tidy-workspace-row-dest";
        destLabel.textContent = `→ ${s.toWorkspaceName}`;
        destLabel.title = `Similarity ${s.similarity.toFixed(3)} vs current ${Number(s.currentSimilarity).toFixed(3)}`;
        textWrap.appendChild(tabLabel);
        textWrap.appendChild(destLabel);
        row.appendChild(textWrap);

        const dismissBtn = document.createElement("div");
        dismissBtn.className = "tidy-workspace-row-dismiss";
        dismissBtn.setAttribute("role", "button");
        dismissBtn.setAttribute("title", "Dismiss this suggestion");
        dismissBtn.setAttribute("tabindex", "0");
        dismissBtn.textContent = "✕";
        dismissBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          try {
            row.remove();
          } catch (_e) {}
          removeRowIfEmpty();
        });
        dismissBtn.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            ev.stopPropagation();
            try {
              row.remove();
            } catch (_e) {}
            removeRowIfEmpty();
          }
        });
        row.appendChild(dismissBtn);

        // Whole row moves (no separate Move button).
        row.addEventListener("click", () => moveTabForSuggestion(s, row));
        row.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            moveTabForSuggestion(s, row);
          }
        });

        body.appendChild(row);
      }

      wrapper.appendChild(body);
      sibling.insertAdjacentElement("afterend", wrapper);

      // Animate in like ZenSidebarNotification.#animateIn
      try {
        wrapper.style.opacity = "0";
        if (window.gZenUIManager?.motion) {
          const entrance = window.gZenUIManager.motion.animate(
            wrapper,
            { opacity: [0, 1], y: [50, 0] },
            { delay: 1 }
          );
          Promise.resolve(entrance).catch(() => {
            wrapper.style.opacity = "1";
          });
        } else {
          wrapper.style.opacity = "1";
        }
      } catch (_e) {
        try {
          wrapper.style.opacity = "1";
        } catch (_e2) {}
      }
      console.log(`[TabSort][Workspaces] Sidebar notification shown (${suggestions.length} suggestion(s))`);
      return wrapper;
    } catch (e) {
      console.error("[TabSort][Workspaces] Failed to show sidebar notification:", e);
      return null;
    }
  };

  // Fire-and-forget wrapper called after sort. Never throws, never blocks.
  const runWorkspaceSuggestionsAfterSort = async (tabs, currentWorkspaceId) => {
    if (!getWorkspaceSuggestEnabled()) return;
    try {
      clearWorkspaceSuggestions(false);
      if (!Array.isArray(tabs) || tabs.length === 0) return;
      const liveTabs = tabs.filter((t) => t?.isConnected);
      if (liveTabs.length === 0) return;
      const suggestions = await suggestBetterWorkspacesForTabs(liveTabs, currentWorkspaceId);
      if (suggestions.length > 0) {
        showWorkspaceSuggestionsNotification(suggestions);
      } else {
        console.log("[TabSort][Workspaces] No better-workspace suggestions");
      }
    } catch (e) {
      console.error("[TabSort][Workspaces] After-sort pass failed (sort still succeeds):", e);
    }
  };

  // Animation cleanup utility
  const cleanupAnimation = () => {
    // Don't cleanup if failure animation is playing
    if (isPlayingFailureAnimation) {
      return;
    }

    if (sortAnimationId !== null) {
      cancelAnimationFrame(sortAnimationId);
      sortAnimationId = null;

      try {
        const activeWorkspace = gZenWorkspaces?.activeWorkspaceElement;
        const activeSeparator = activeWorkspace?.querySelector(
          ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
        );
        const pathElement = activeSeparator?.querySelector(".separator-path-segment");
        if (pathElement) {
          pathElement.setAttribute("d", "M 0 1 L 100 1");
        }
      } catch (resetError) {
        console.error("Error resetting animation:", resetError);
      }
    }
  };

  // Spiky failure animation utility
  const startFailureAnimation = () => {
    if (sortAnimationId !== null) {
      cancelAnimationFrame(sortAnimationId);
    }

    isPlayingFailureAnimation = true;

    try {
      // Find the separator in the ACTIVE workspace, not the first one in DOM
      const activeWorkspace = gZenWorkspaces?.activeWorkspaceElement;
      const activeSeparator = activeWorkspace?.querySelector(
        ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
      );
      const pathElement = activeSeparator?.querySelector(".separator-path-segment");

      if (pathElement) {
        const maxAmplitude = 8; // Much higher amplitude for spiky effect
        const frequency = 20; // Higher frequency for more spikes
        const segments = 100; // More segments for sharper spikes
        const pulseDuration = 400; // Duration of each pulse
        const totalPulses = 3; // Number of pulses
        let currentPulse = 0;
        let t = 0;
        let startTime = performance.now();
        let pulseStartTime = startTime;

        function animateFailureLoop(timestamp) {
          if (sortAnimationId === null) return;

          const elapsedSincePulseStart = timestamp - pulseStartTime;
          const pulseProgress = elapsedSincePulseStart / pulseDuration;

          if (pulseProgress >= 1) {
            currentPulse++;
            if (currentPulse >= totalPulses) {
              // Animation complete, reset to straight line
              pathElement.setAttribute("d", "M 0 1 L 100 1");
              sortAnimationId = null;
              isPlayingFailureAnimation = false;
              return;
            }
            // Start next pulse
            pulseStartTime = timestamp;
          }

          // Create spiky wave with sharp peaks and valleys
          const currentProgress = Math.min(pulseProgress, 1);
          const intensity = Math.sin(currentProgress * Math.PI); // Pulse intensity (0 to 1 to 0)
          const currentAmplitude = maxAmplitude * intensity;

          t += 1.2; // Faster animation speed

          const points = [];
          for (let i = 0; i <= segments; i++) {
            const x = (i / segments) * 100;
            // Create sharp spikes using a combination of sine waves
            const baseWave = Math.sin(
              (x / (100 / frequency)) * 2 * Math.PI + t * 0.15
            );
            const sharpWave =
              Math.sign(baseWave) * Math.pow(Math.abs(baseWave), 0.3); // Sharp peaks
            const y = 1 + currentAmplitude * sharpWave;
            points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
          }

          if (pathElement?.isConnected) {
            const pathData = "M" + points.join(" L");
            pathElement.setAttribute("d", pathData);
            sortAnimationId = requestAnimationFrame(animateFailureLoop);
          } else {
            sortAnimationId = null;
            isPlayingFailureAnimation = false;
          }
        }

        sortAnimationId = requestAnimationFrame(animateFailureLoop);
      }
    } catch (error) {
      console.error("Error in failure animation:", error);
      isPlayingFailureAnimation = false;
    }
  };

  // --- Toast notifications (zen-toast-container) ---
  // Pattern mirrors zen-tidy-downloads `showSimpleToast` and
  // workspace-notifications `NotificationPopups`: render into
  // #zen-toast-container, queue while another toast (ours or another
  // mod's) owns the container, spring in via gZenUIManager.motion,
  // pause on hover/focus, Escape to dismiss, role=status for a11y.
  let tidyToastQueue = [];
  let tidyToastActive = null;
  let tidyToastRetry = null;

  const TIDY_TOAST_TIMEOUT = {
    success: 4000,
    error: 5500,
    info: 3500,
  };

  function pumpTidyToastQueue() {
    if (tidyToastActive || tidyToastRetry != null) return;
    if (tidyToastQueue.length === 0) return;
    const container = document.getElementById("zen-toast-container");
    if (!container) {
      tidyToastQueue = [];
      return;
    }
    // Own only our slot: if Zen or another mod is showing a toast,
    // retry shortly instead of stacking on top of it.
    if (container.children.length > 0) {
      tidyToastRetry = setTimeout(() => {
        tidyToastRetry = null;
        pumpTidyToastQueue();
      }, 300);
      return;
    }
    const payload = tidyToastQueue.shift();
    const wrapper = document.createXULElement("hbox");
    wrapper.classList.add(
      "zen-toast",
      "tidy-tabs-toast",
      `tidy-tabs-toast--${payload.type}`
    );
    wrapper.setAttribute("role", "status");
    wrapper.setAttribute("aria-live", "polite");

    const content = document.createElement("div");
    content.className = "tidy-tabs-toast-content";
    const titleEl = document.createElement("div");
    titleEl.className = "tidy-tabs-toast-title";
    titleEl.textContent = String(payload.title || "").slice(0, 120);
    content.appendChild(titleEl);
    wrapper.appendChild(content);

    container.removeAttribute("hidden");
    container.appendChild(wrapper);

    let timer = null;
    let dismissed = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        wrapper.remove();
      } catch (_e) {}
      if (container.children.length === 0) {
        container.setAttribute("hidden", "true");
      }
      tidyToastActive = null;
      pumpTidyToastQueue();
    };
    const prefersReducedMotion = () => {
      try {
        return window.matchMedia?.(
          "(prefers-reduced-motion: reduce)"
        )?.matches;
      } catch (_e) {
        return false;
      }
    };
    const animate = (frames, options) => {
      try {
        if (!prefersReducedMotion() && window.gZenUIManager?.motion) {
          return window.gZenUIManager.motion.animate(
            wrapper,
            frames,
            options
          );
        }
      } catch (_e) {}
      return null;
    };
    const dismiss = (immediate = false) => {
      if (dismissed) {
        if (immediate) finish();
        return;
      }
      dismissed = true;
      if (timer) clearTimeout(timer);
      if (immediate) {
        finish();
        return;
      }
      const out = animate(
        { opacity: [1, 0], scale: [1, 0.5] },
        { duration: 0.2, bounce: 0 }
      );
      if (out) {
        Promise.resolve(out).then(finish, finish);
        setTimeout(finish, 500); // safety in case motion promise hangs
      } else {
        finish();
      }
    };
    const pause = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const resume = () => {
      pause();
      if (!dismissed) {
        timer = setTimeout(() => dismiss(), payload.duration);
      }
    };

    wrapper.addEventListener("mouseenter", pause);
    wrapper.addEventListener("mouseleave", resume);
    wrapper.addEventListener("focusin", pause);
    wrapper.addEventListener("focusout", resume);
    wrapper.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
      }
    });
    wrapper.tabIndex = 0;

    tidyToastActive = { wrapper, dismiss };
    const entrance = animate(
      { scale: [0.8, 1], opacity: [0, 1] },
      { type: "spring", bounce: 0.2, duration: 0.5 }
    );
    if (entrance) {
      Promise.resolve(entrance).catch(() => {
        wrapper.style.transform = "scale(1)";
        wrapper.style.opacity = "1";
      });
    } else {
      wrapper.style.transform = "scale(1)";
    }
    resume();
  }

  function showTidyToast(title, type = "success") {
    try {
      if (!title) return false;
      if (!["success", "error", "info"].includes(type)) type = "success";
      tidyToastQueue.push({
        title,
        type,
        duration: TIDY_TOAST_TIMEOUT[type] ?? 4000,
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      if (tidyToastQueue.length > 5) tidyToastQueue.shift();
      pumpTidyToastQueue();
      return true;
    } catch (e) {
      console.error("[TabSort] Failed to show toast:", e);
      return false;
    }
  }

  function clearTidyToasts() {
    try {
      tidyToastQueue = [];
      if (tidyToastRetry) {
        clearTimeout(tidyToastRetry);
        tidyToastRetry = null;
      }
      if (tidyToastActive) {
        try {
          tidyToastActive.dismiss(true);
        } catch (_e) {}
        tidyToastActive = null;
      }
    } catch (_e) {}
  }

  // --- Main Sorting Function ---
  const sortTabsByTopic = async () => {
    // Let an in-flight auto-sort batch finish first, so a click is never
    // silently ignored and both never move the same tabs at once.
    // Bounded, so a hung batch can't block the broom forever.
    if (autoSortPromise) {
      broomWaiting = true;
      try {
        await Promise.race([
          autoSortPromise,
          sleepMs(
            getLlmEnabled()
              ? Math.max(
                  CONFIG.AUTO_SORT_BROOM_WAIT_MS,
                  CONFIG.LLM_MAX_TIMEOUT_MS + 2000
                )
              : CONFIG.AUTO_SORT_BROOM_WAIT_MS
          ),
        ]);
      } catch (_e) {}
      broomWaiting = false;
    }
    if (isSorting) return;
    isSorting = true;
    // Stop idle warmup inference so it can't run concurrently with the
    // sort on the same ML engine (dead-port crashes).
    try {
      cancelWarmup();
    } catch (_e) {}

    let separatorsToSort = [];
    try {
      separatorsToSort = domCache.getSeparators();
      // Apply visual indicator
      if (separatorsToSort.length > 0) {
        batchDOMUpdates([
          () =>
            separatorsToSort.forEach((sep) => {
              if (sep?.isConnected) {
                sep.classList.add("separator-is-sorting");
              }
            }),
        ]);
      }

      const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
      if (!currentWorkspaceId) {
        console.error("Cannot get current workspace ID.");
        showTidyToast("Nothing to tidy!", "error");
        return; // Exit early
      }

      let closedDuplicates = 0;
      if (getCloseDuplicatesEnabled()) {
        closedDuplicates = closeDuplicateTabs(currentWorkspaceId);
        if (closedDuplicates > 0) {
          showTidyToast(
            `Closed ${closedDuplicates} duplicate tab${closedDuplicates === 1 ? "" : "s"}`,
            "info"
          );
        }
      }

      // --- Step 1: Get ALL Existing Group Names for Context ---
      const allExistingGroupNames = new Set();
      const groupSelector = `tab-group:has(tab[zen-workspace-id="${currentWorkspaceId}"])`;

      document.querySelectorAll(groupSelector).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          allExistingGroupNames.add(label);
        }
      });

      // --- Filter initial tabs using optimized function ---
      const initialTabsToSort = getFilteredTabs(currentWorkspaceId, {
        includeGrouped: false,
        includeSelected: true,
        includePinned: false,
        includeEmpty: false,
        includeGlance: false,
      }).filter((tab) => {
        const groupParent = tab.closest("tab-group");
        const isInGroupInCorrectWorkspace = groupParent
          ? groupParent.matches(groupSelector)
          : false;
        return !isInGroupInCorrectWorkspace;
      });

      console.log(
        "[TabSort] Debug - Initial tabs to sort count:",
        initialTabsToSort.length
      );
      if (initialTabsToSort.length === 0) {
        console.log("[TabSort] Debug - No tabs to sort, returning early");
        // The duplicates toast already told the user what happened.
        if (closedDuplicates === 0) showTidyToast("Nothing to tidy!", "info");
        return;
      }

      // --- AI Grouping ---
      console.log(
        "[TabSort] Debug - Starting AI grouping for",
        initialTabsToSort.length,
        "tabs"
      );
      const aiTabTopics = await askAIForMultipleTopics(initialTabsToSort);
      console.log(
        "[TabSort] Debug - AI returned",
        aiTabTopics.length,
        "tab-topic pairs"
      );
      // --- End AI Grouping ---

      // --- Create Final Groups ---
      const finalGroups = {};
      aiTabTopics.forEach(({ tab, topic }) => {
        if (!topic || topic === "Uncategorized" || !tab || !tab.isConnected) {
          return;
        }
        if (!finalGroups[topic]) {
          finalGroups[topic] = [];
        }
        finalGroups[topic].push(tab);
      });

      // Single-tab groups are already filtered out at the clustering level
      // --- End Create Final Groups ---

      // --- Consolidate Similar Category Names ---
      const originalKeys = Object.keys(finalGroups);
      const mergedKeys = new Set();
      const consolidationMap = {};

      for (let i = 0; i < originalKeys.length; i++) {
        let keyA = originalKeys[i];
        if (mergedKeys.has(keyA)) continue;
        while (consolidationMap[keyA]) {
          keyA = consolidationMap[keyA];
        }
        if (mergedKeys.has(keyA)) continue;

        for (let j = i + 1; j < originalKeys.length; j++) {
          let keyB = originalKeys[j];
          if (mergedKeys.has(keyB)) continue;
          while (consolidationMap[keyB]) {
            keyB = consolidationMap[keyB];
          }
          if (mergedKeys.has(keyB) || keyA === keyB) continue;

          const distance = levenshteinDistance(keyA, keyB);
          const threshold = CONFIG.CONSOLIDATION_DISTANCE_THRESHOLD;

          if (distance <= threshold && distance > 0) {
            let canonicalKey = keyA;
            let mergedKey = keyB;
            const keyAIsActuallyExisting = allExistingGroupNames.has(keyA);
            const keyBIsActuallyExisting = allExistingGroupNames.has(keyB);

            if (keyBIsActuallyExisting && !keyAIsActuallyExisting) {
              [canonicalKey, mergedKey] = [keyB, keyA];
            } else if (keyAIsActuallyExisting && keyBIsActuallyExisting) {
              if (keyA.length > keyB.length)
                [canonicalKey, mergedKey] = [keyB, keyA];
            } else if (!keyAIsActuallyExisting && !keyBIsActuallyExisting) {
              if (keyA.length > keyB.length)
                [canonicalKey, mergedKey] = [keyB, keyA];
            }

            if (finalGroups[mergedKey]) {
              if (!finalGroups[canonicalKey]) finalGroups[canonicalKey] = [];
              const uniqueTabsToAdd = finalGroups[mergedKey].filter(
                (tab) =>
                  tab &&
                  tab.isConnected &&
                  !finalGroups[canonicalKey].some(
                    (existingTab) => existingTab === tab
                  )
              );
              finalGroups[canonicalKey].push(...uniqueTabsToAdd);
            }
            mergedKeys.add(mergedKey);
            consolidationMap[mergedKey] = canonicalKey;
            delete finalGroups[mergedKey];
            if (mergedKey === keyA) {
              keyA = canonicalKey;
              break;
            }
          }
        }
      }

      // --- End Consolidation ---

      // Check if sorting failed (no meaningful grouping occurred)
      // Success criteria:
      // 1. Created groups with multiple tabs, OR
      // 2. Successfully matched tabs to existing groups (even single tabs)
      const multiTabGroups = Object.values(finalGroups).filter(
        (tabs) => tabs.length > 1
      );
      
      // Count tabs that were successfully matched to existing groups
      const tabsMatchedToExistingGroups = aiTabTopics.length;
      
      // Sorting is successful if:
      // - We created new multi-tab groups, OR
      // - We matched tabs to existing groups, OR  
      // - We only had 1 tab to sort (no failure for single tabs)
      const sortingFailed = 
        multiTabGroups.length === 0 && 
        tabsMatchedToExistingGroups === 0 && 
        initialTabsToSort.length > 1;

      console.log(
        "[TabSort] Debug - Initial tabs to sort:",
        initialTabsToSort.length
      );
      console.log("[TabSort] Debug - Final groups:", Object.keys(finalGroups));
      console.log("[TabSort] Debug - Multi-tab groups:", multiTabGroups.length);
      console.log("[TabSort] Debug - Tabs matched to existing groups:", tabsMatchedToExistingGroups);
      console.log(
        "[TabSort] Debug - multiTabGroups.length === 0:",
        multiTabGroups.length === 0
      );
      console.log(
        "[TabSort] Debug - tabsMatchedToExistingGroups === 0:",
        tabsMatchedToExistingGroups === 0
      );
      console.log(
        "[TabSort] Debug - initialTabsToSort.length > 1:",
        initialTabsToSort.length > 1
      );
      console.log("[TabSort] Debug - Sorting failed:", sortingFailed);

      if (sortingFailed) {
        console.log("[TabSort] Triggering failure animation");
        // Trigger failure animation + failure toast (like Tidy Downloads).
        showTidyToast("Nothing to tidy!", "error");
        startFailureAnimation();
        return;
      }

      if (Object.keys(finalGroups).length === 0) {
        console.log(
          "[TabSort] Debug - No final groups, returning early (this should not happen after failure detection)"
        );
        showTidyToast("Nothing to tidy!", "error");
        startFailureAnimation();
        return;
      }

      // --- Get existing group ELEMENTS ---
      const existingGroupElementsMap = new Map();
      document.querySelectorAll(groupSelector).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          existingGroupElementsMap.set(label, groupEl);
        }
      });

      // --- Process each final, consolidated group ---
      for (const topic in finalGroups) {
        const tabsForThisTopic = finalGroups[topic].filter((t) => {
          const groupParent = t.closest("tab-group");
          const isInGroupInCorrectWorkspace = groupParent
            ? groupParent.matches(groupSelector)
            : false;
          return t && t.isConnected && !isInGroupInCorrectWorkspace;
        });

        if (tabsForThisTopic.length === 0) {
          continue;
        }

        const existingGroupElement = existingGroupElementsMap.get(topic);

        if (existingGroupElement && existingGroupElement.isConnected) {
          try {
            if (existingGroupElement.getAttribute("collapsed") === "true") {
              existingGroupElement.setAttribute("collapsed", "false");
              const groupLabelElement =
                existingGroupElement.querySelector(".tab-group-label");
              if (groupLabelElement) {
                groupLabelElement.setAttribute("aria-expanded", "true");
              }
            }
            for (const tab of tabsForThisTopic) {
              const groupParent = tab.closest("tab-group");
              const isInGroupInCorrectWorkspace = groupParent
                ? groupParent.matches(groupSelector)
                : false;
              if (tab && tab.isConnected && !isInGroupInCorrectWorkspace) {
                gBrowser.moveTabToExistingGroup(tab, existingGroupElement);
              } else {
                console.warn(
                  ` -> Tab "${
                    getTabTitle(tab) || "Unknown"
                  }" skipped moving to "${topic}" (already grouped or invalid).`
                );
              }
            }
          } catch (e) {
            console.error(
              `Error moving tabs to existing group "${topic}":`,
              e,
              existingGroupElement
            );
          }
        } else {
          if (existingGroupElement && !existingGroupElement.isConnected) {
            console.warn(
              ` -> Existing group element for "${topic}" was found in map but is no longer connected to DOM. Will create a new group.`
            );
          }

          // Create group for any topic with tabs
          if (tabsForThisTopic.length > 0) {
            const firstValidTabForGroup = tabsForThisTopic[0];
            const groupOptions = {
              label: topic,
              insertBefore: firstValidTabForGroup,
            };
            try {
              const newGroup = gBrowser.addTabGroup(
                tabsForThisTopic,
                groupOptions
              );
              if (newGroup && newGroup.isConnected) {
                existingGroupElementsMap.set(topic, newGroup);

                // Try to set group color to average favicon if advanced-tab-groups is available
                try {
                  if (typeof newGroup._useFaviconColor === "function") {
                    setTimeout(() => newGroup._useFaviconColor(), 500);
                  }
                } catch (e) {
                  // Silently ignore if advanced-tab-groups is not installed
                }
              } else {
                console.warn(
                  ` -> addTabGroup didn't return a connected element for "${topic}". Attempting fallback find.`
                );
                // Use the CORRECT findGroupElement helper from clear script (needs to be added/updated)
                const newGroupElFallback = findGroupElement(
                  topic,
                  currentWorkspaceId
                );
                if (newGroupElFallback && newGroupElFallback.isConnected) {
                  existingGroupElementsMap.set(topic, newGroupElFallback);

                  // Try to set group color to average favicon if advanced-tab-groups is available
                  try {
                    if (
                      typeof newGroupElFallback._useFaviconColor === "function"
                    ) {
                      setTimeout(
                        () => newGroupElFallback._useFaviconColor(),
                        500
                      );
                    }
                  } catch (e) {
                    // Silently ignore if advanced-tab-groups is not installed
                  }
                } else {
                  console.error(
                    ` -> Failed to find the newly created group element for "${topic}" even with fallback.`
                  );
                }
              }
            } catch (e) {
              console.error(
                `Error calling gBrowser.addTabGroup for topic "${topic}":`,
                e
              );
              const groupAfterError = findGroupElement(
                topic,
                currentWorkspaceId
              );
              if (groupAfterError && groupAfterError.isConnected) {
                console.warn(
                  ` -> Group "${topic}" might exist despite error. Found via findGroupElement.`
                );
                existingGroupElementsMap.set(topic, groupAfterError);

                // Try to set group color to average favicon if advanced-tab-groups is available
                try {
                  if (typeof groupAfterError._useFaviconColor === "function") {
                    setTimeout(() => groupAfterError._useFaviconColor(), 500);
                  }
                } catch (e) {
                  // Silently ignore if advanced-tab-groups is not installed
                }
              } else {
                console.error(
                  ` -> Failed to find group "${topic}" after creation error.`
                );
              }
            }
          } else {
          }
        }
      } // End loop through final groups

      // --- Reorder tabs: ungrouped tabs below the groups, or above them (pref) ---
      try {
        const workspaceElement = gZenWorkspaces?.activeWorkspaceElement;
        
        if (workspaceElement?.tabsContainer) {
          const tabsContainer = workspaceElement.tabsContainer;
          const allChildren = Array.from(tabsContainer.children);
          
          // Separate groups and ungrouped tabs
          // Since we're in the workspace's tabsContainer, all direct children belong to this workspace
          const groups = [];
          const ungroupedTabs = [];
          const otherElements = []; // For any other elements (like periphery hbox)
          
          for (const child of allChildren) {
            const tagName = child.tagName?.toLowerCase();
            if (tagName === "tab-group") {
              // All tab-groups in this container belong to the workspace
              groups.push(child);
            } else if (tagName === "tab") {
              // Check if tab is valid (not empty, not glance)
              if (
                !child.hasAttribute("zen-empty-tab") &&
                !child.hasAttribute("zen-glance-tab")
              ) {
                ungroupedTabs.push(child);
              } else {
                otherElements.push(child);
              }
            } else {
              // Other elements (like hbox periphery)
              otherElements.push(child);
            }
          }
          
          console.log("[TabSort] Reorder - groups:", groups.length, "ungrouped:", ungroupedTabs.length);
          
          if (getUngroupedOnTopEnabled()) {
            moveLooseTabsAboveGroups(tabsContainer);
          } else if (groups.length > 0 && ungroupedTabs.length > 0) {
            // Only reorder if we have both groups AND ungrouped tabs
            console.log("[TabSort] Reorder - Moving ungrouped tabs below groups...");
            
            // Move each ungrouped tab to after the last group
            const lastGroup = groups[groups.length - 1];
            let insertAfterElement = lastGroup;
            
            ungroupedTabs.forEach((tab) => {
              if (tab.isConnected && insertAfterElement?.isConnected) {
                // Insert tab after the reference element
                const nextSibling = insertAfterElement.nextSibling;
                if (nextSibling) {
                  tabsContainer.insertBefore(tab, nextSibling);
                } else {
                  tabsContainer.appendChild(tab);
                }
                insertAfterElement = tab;
              }
            });
            
            console.log("[TabSort] Reorder - Complete!");
          }
        }
      } catch (reorderError) {
        console.error("Error reordering tabs (groups first):", reorderError);
        // Don't fail the whole sort if reordering fails
      }

      // --- Success toast (mirrors Tidy Downloads simple toast) ---
      try {
        const doneGroupNames = Object.keys(finalGroups).filter(
          (k) => Array.isArray(finalGroups[k]) && finalGroups[k].length > 0
        );
        const doneTabCount = doneGroupNames.reduce(
          (n, k) => n + finalGroups[k].length,
          0
        );
        if (doneGroupNames.length > 0 && doneTabCount > 0) {
          showTidyToast("Tabs have been tidied!", "success");
        }
      } catch (toastError) {
        console.error("[TabSort] Failed to build success toast:", toastError);
      }

      // --- Auto-icons: inline pass, awaited as part of the sort ---
      // The sort doesn't finish until each group has its icon (fast in
      // practice). Skips groups that already have an icon, so manual
      // picks are safe. Failures here never fail the sort itself.
      try {
        if (getAutoIconsEnabled()) {
          const groupsForIcons = Object.entries(finalGroups)
            .map(([topic, tabs]) => {
              const el = existingGroupElementsMap.get(topic);
              if (!el || !el.isConnected) return null;
              let titles = [];
              try {
                titles = (tabs || [])
                  .filter((t) => t?.isConnected)
                  .map((t) => getTabTitle(t))
                  .filter(Boolean)
                  .slice(0, 8);
              } catch (_e) {}
              return { element: el, topic, titles };
            })
            .filter(Boolean);
          if (groupsForIcons.length > 0) {
            await assignGroupIconsBackground(groupsForIcons);
          } else {
            console.log("[TabSort] Auto-icons: no groups to icon (all missing from DOM).");
          }
        }
      } catch (iconError) {
        console.error("[TabSort] Icon pass failed (sort still succeeds):", iconError);
      }

      // --- Workspace suggestions: persistent sidebar notification (prototype) ---
      // Runs after sort+icons, fire-and-forget. Uses the same tabs we tried
      // to sort; tabs that fit nowhere locally are the best cross-workspace
      // candidates. Never fails the sort.
      try {
        if (getWorkspaceSuggestEnabled()) {
          // initialTabsToSort is in scope here; fall back to live ungrouped set.
          let suggestTabs = [];
          try {
            suggestTabs = Array.isArray(initialTabsToSort)
              ? initialTabsToSort.filter((t) => t?.isConnected)
              : [];
          } catch (_e) {}
          if (suggestTabs.length === 0) {
            try {
              suggestTabs = getFilteredTabs(currentWorkspaceId, {
                includeGrouped: false,
                includeSelected: true,
                includePinned: false,
                includeEmpty: false,
                includeGlance: false,
              });
            } catch (_e) {}
          }
          if (suggestTabs.length > 0) {
            await runWorkspaceSuggestionsAfterSort(suggestTabs, currentWorkspaceId);
          }
        }
      } catch (wsError) {
        console.error("[TabSort][Workspaces] Suggestion hook failed (sort still succeeds):", wsError);
      }
    } catch (error) {
      console.error("Error during overall sorting process:", error);
      showTidyToast("Nothing to tidy!", "error");
    } finally {
      // If failure animation is playing, delay the cleanup
      if (isPlayingFailureAnimation) {
        // Wait for failure animation to complete (3 pulses * 400ms each + buffer)
        setTimeout(() => {
          isSorting = false;
          cleanupAnimation();

          // Remove separator pulse indicator
          if (separatorsToSort.length > 0) {
            batchDOMUpdates([
              () =>
                separatorsToSort.forEach((sep) => {
                  if (sep?.isConnected) {
                    sep.classList.remove("separator-is-sorting");
                  }
                }),
            ]);
          }

          // Remove tab loading indicators and update button visibility
          setTimeout(() => {
            batchDOMUpdates([
              () => {
                if (typeof gBrowser !== "undefined" && gBrowser.tabs) {
                  Array.from(gBrowser.tabs).forEach((tab) => {
                    if (tab?.isConnected) {
                      tab.classList.remove("tab-is-sorting");
                    }
                  });
                }
              },
            ]);
            updateButtonsVisibilityState();
          }, 500);
        }, 1500); // 3 pulses * 400ms + 300ms buffer
      } else {
        isSorting = false;

        // Cleanup animation
        cleanupAnimation();

        // Remove separator pulse indicator
        if (separatorsToSort.length > 0) {
          batchDOMUpdates([
            () =>
              separatorsToSort.forEach((sep) => {
                if (sep?.isConnected) {
                  sep.classList.remove("separator-is-sorting");
                }
              }),
          ]);
        }

        // Remove tab loading indicators and update button visibility
        setTimeout(() => {
          batchDOMUpdates([
            () => {
              if (typeof gBrowser !== "undefined" && gBrowser.tabs) {
                Array.from(gBrowser.tabs).forEach((tab) => {
                  if (tab?.isConnected) {
                    tab.classList.remove("tab-is-sorting");
                  }
                });
              }
            },
          ]);
          updateButtonsVisibilityState();
        }, 500);
      }
    }
  };

  // --- Button Initialization & Workspace Handling ---
  function ensureSortButtonExists(separator) {
    if (!separator) {
      return;
    }
    // Never inject into Library Spaces clones — those are read-only copies
    // of the real strips (ids renamed to *-copy) and would render unstyled.
    try {
      if (separator.closest?.(".zen-library-spaces, zen-library")) {
        return;
      }
    } catch (_e) {}
    try {
      const isPinnedSeparator = separator.classList?.contains(
        "pinned-tabs-container-separator"
      );

      // Use the native divider element instead of a custom in-flow SVG, so the
      // line stays continuous. This mirrors the native clear button technique
      // (toolbarseparator + toolbarbutton that paints its own line segment
      // via CSS background). Only ensured, never duplicated.
      if (
        isPinnedSeparator &&
        !separator.querySelector("toolbarseparator")
      ) {
        const nativeSeparator = document.createXULElement("toolbarseparator");
        nativeSeparator.setAttribute("flex", "1");
        separator.insertBefore(nativeSeparator, separator.firstChild);
      }

      // Animated wave overlay. Absolutely positioned with pointer-events:none,
      // so the brush/failure animations play without participating in flex
      // layout or breaking the divider line.
      if (
        isPinnedSeparator &&
        !separator.querySelector("svg.separator-line-svg")
      ) {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("class", "separator-line-svg");
        svg.setAttribute("viewBox", "0 0 100 2");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("aria-hidden", "true");

        // Create ONE path
        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("class", "separator-path-segment"); // Keep common class
        path.setAttribute("d", "M 0 1 L 100 1"); // Initial straight line
        path.style.fill = "none";
        path.style.opacity = "1"; // Ensure it's visible
        path.setAttribute("stroke-width", "1"); // Added: Set initial stroke width
        path.setAttribute("stroke-linecap", "round"); // Added: Make path ends round
        svg.appendChild(path);

        separator.appendChild(svg);
      }
      // --- End SVG overlay ---

      // --- Create Sort Button as a bare toolbarbutton with the broom SVG as a
      // --- direct child (no wrappers), mirroring the native clear button's
      // --- wrapper-free DOM. Inline SVG uses the proven currentColor path.
      // --- Positioned before the native clear button. ---
      // NOTE: BROOM_ICON_SVG keeps the icon markup in one shared constant.
      // Heal stale buttons from other revisions (childless data-URI revision
      // or old hbox-wrapped revision) by rebuilding them with the current
      // markup.
      const staleButton = separator.querySelector("#sort-button");
      if (
        staleButton &&
        (!staleButton.querySelector(":scope > svg.broom-icon") ||
          staleButton.querySelector(":scope > hbox"))
      ) {
        staleButton.remove();
      }
      if (!separator.querySelector("#sort-button")) {
        // Find the native clear button to position sort button before it
        const nativeClearButton = separator.querySelector(".zen-workspace-close-unpinned-tabs-button");
        const buttonFragment = window.MozXULElement.parseXULToFragment(
          `<toolbarbutton id="sort-button" class="sort-button-with-icon" command="cmd_zenSortTabs" tooltiptext="Sort Tabs into Groups by Topic (AI)">${BROOM_ICON_SVG}</toolbarbutton>`
        );
        const buttonNode = buttonFragment.firstChild.cloneNode(true);

        // Insert before native clear button if it exists, otherwise append
        if (nativeClearButton) {
          separator.insertBefore(buttonNode, nativeClearButton);
        } else {
          separator.appendChild(buttonNode);
        }
      } else {
      }
      // --- End Sort Button ---
    } catch (e) {}
  }

  function addSortButtonToAllSeparators() {
    const separators = domCache.getSeparators();
    if (separators.length > 0) {
      separators.forEach(ensureSortButtonExists);
      updateButtonsVisibilityState();
    } else {
      const periphery = document.querySelector(
        "#tabbrowser-arrowscrollbox-periphery"
      );
      if (periphery && !periphery.querySelector("#sort-button")) {
        ensureSortButtonExists(periphery);
      }
    }
    updateButtonsVisibilityState();
  }

  function setupSortCommandAndListener() {
    const zenCommands = domCache.getCommandSet();
    if (!zenCommands) return;

    // Add Sort command
    if (!zenCommands.querySelector("#cmd_zenSortTabs")) {
      try {
        const command = window.MozXULElement.parseXULToFragment(
          `<command id="cmd_zenSortTabs"/>`
        ).firstChild;
        zenCommands.appendChild(command);
      } catch (e) {}
    }

    // Add Sort button listener
    if (!sortButtonListenerAdded) {
      try {
        zenCommands.addEventListener("command", (event) => {
          if (event.target.id === "cmd_zenSortTabs") {
            // Find the separator in the ACTIVE workspace
            const activeWorkspace = gZenWorkspaces?.activeWorkspaceElement;
            const separator = activeWorkspace?.querySelector(
              ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
            );

            // Add brushing animation class to the sort button in the active workspace
            const sortButton = separator?.querySelector("#sort-button");
            if (sortButton) {
              sortButton.classList.add("brushing");
              // Remove class after animation completes
              setTimeout(() => {
                if (sortButton?.isConnected) {
                  sortButton.classList.remove("brushing");
                }
              }, CONFIG.ANIMATION_DURATION);
            }

            // Prevent starting animation if already running
            if (sortAnimationId !== null) return;

            if (!separator) {
              sortTabsByTopic(); // Still run sort even if animation fails
              return;
            }

            // --- Start Animation logic ---
            const pathElement = separator.querySelector(".separator-path-segment");
            if (pathElement) {
              const maxAmplitude = 3;
              const frequency = 8;
              const segments = 50;
              const growthDuration = 500;
              let t = 0;
              let startTime = performance.now();

              function animateWaveLoop(timestamp) {
                // Check if animation should continue
                if (sortAnimationId === null) return;

                const elapsedTime = timestamp - startTime;
                const growthProgress = Math.min(
                  elapsedTime / growthDuration,
                  1
                );
                const currentAmplitude = maxAmplitude * growthProgress;

                t += 0.5;

                const points = [];
                for (let i = 0; i <= segments; i++) {
                  const x = (i / segments) * 100;
                  const y =
                    1 +
                    currentAmplitude *
                      Math.sin((x / (100 / frequency)) * 2 * Math.PI + t * 0.1);
                  points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
                }

                if (pathElement?.isConnected) {
                  const pathData = "M" + points.join(" L");
                  pathElement.setAttribute("d", pathData);
                  sortAnimationId = requestAnimationFrame(animateWaveLoop);
                } else {
                  sortAnimationId = null;
                }
              }

              sortAnimationId = requestAnimationFrame(animateWaveLoop);
            }
            // --- End Animation Logic ---

            // Call the actual sorting logic AFTER starting animation
            sortTabsByTopic();
          }
        });
        sortButtonListenerAdded = true;
      } catch (e) {}
    }
  }

  // --- gZenWorkspaces Hooks ---
  function setupgZenWorkspacesHooks() {
    if (typeof window.gZenWorkspaces === "undefined") {
      return;
    }

    const originalOnTabBrowserInserted =
      window.gZenWorkspaces.onTabBrowserInserted;
    const originalUpdateTabsContainers =
      window.gZenWorkspaces.updateTabsContainers;

    window.gZenWorkspaces.onTabBrowserInserted = function (event) {
      if (typeof originalOnTabBrowserInserted === "function") {
        try {
          originalOnTabBrowserInserted.call(window.gZenWorkspaces, event);
        } catch (e) {
          console.error(
            "SORT BTN HOOK: Error in original onTabBrowserInserted:",
            e
          );
        }
      }
      addSortButtonToAllSeparators();
      updateButtonsVisibilityState();
    };

    window.gZenWorkspaces.updateTabsContainers = function (...args) {
      if (typeof originalUpdateTabsContainers === "function") {
        try {
          originalUpdateTabsContainers.apply(window.gZenWorkspaces, args);
        } catch (e) {
          console.error(
            "SORT BTN HOOK: Error in original updateTabsContainers:",
            e
          );
        }
      }
      addSortButtonToAllSeparators();
      updateButtonsVisibilityState();
    };
  }

  // --- Patch Clear Button to Preserve Tab-Groups ---
  function patchClearButtonToPreserveGroups() {
    if (typeof window.gZenWorkspaces === "undefined") {
      console.warn("[TidyTabs] gZenWorkspaces not available, cannot patch clear button");
      return;
    }

    // Store the original method
    const originalCloseAllUnpinnedTabs = window.gZenWorkspaces.closeAllUnpinnedTabs;
    
    if (typeof originalCloseAllUnpinnedTabs !== "function") {
      console.warn("[TidyTabs] closeAllUnpinnedTabs method not found");
      return;
    }

    // Override the method
    window.gZenWorkspaces.closeAllUnpinnedTabs = function() {
      console.log("[TidyTabs] Clear button clicked - filtering to preserve tab-groups");
      
      try {
        // Get the ACTIVE workspace ID - this is critical!
        const currentWorkspaceId = this.activeWorkspace;
        if (!currentWorkspaceId) {
          console.warn("[TidyTabs] No active workspace found");
          return;
        }
        
        // Get all tabs and filter to ONLY the active workspace.
        // getWorkspaceTabs reads the workspace containers directly because
        // gBrowser.tabs can expose only the selected space.
        const allTabs = getWorkspaceTabs(currentWorkspaceId);
        
        // Filter tabs to close: exclude pinned, grouped, essential, empty, and selected tabs
        const tabsToClose = allTabs.filter(tab => {
          // Safety check
          if (!tab || !tab.isConnected) return false;
          
          // Don't close the selected tab
          if (tab.selected) {
            return false;
          }
          
          // Don't close pinned tabs
          if (tab.pinned) {
            return false;
          }
          
          // Don't close tabs that are in a group/folder
          if (tab.group) {
            // Check if it's a zen-folder
            if (tab.group.isZenFolder || tab.group.tagName === "zen-folder") {
              return false;
            }
            // Check if it's a regular tab-group (not split-view)
            if (tab.group.tagName === "tab-group" && !tab.group.hasAttribute("split-view-group")) {
              return false;
            }
          }
          
          // Don't close essential tabs
          if (tab.hasAttribute("zen-essential")) {
            return false;
          }
          
          // Don't close empty tabs
          if (tab.hasAttribute("zen-empty-tab")) {
            return false;
          }
          
          // Don't close glance tabs
          if (tab.hasAttribute("zen-glance-tab")) {
            return false;
          }
          
          // This tab can be closed
          return true;
        });
        
        console.log(`[TidyTabs] Closing ${tabsToClose.length} tabs, preserving ${allTabs.length - tabsToClose.length} tabs`);
        
        // Close the filtered tabs
        if (tabsToClose.length > 0) {
          gBrowser.removeTabs(tabsToClose);
          
          // Show a toast notification
          if (typeof gZenUIManager !== "undefined" && gZenUIManager.showToast) {
            gZenUIManager.showToast("zen-workspaces-close-all-unpinned-tabs-toast", {
              shortcut: "Ctrl+Shift+T"
            });
          }
        } else {
          console.log("[TidyTabs] No tabs to close");
        }
      } catch (error) {
        console.error("[TidyTabs] Error in patched closeAllUnpinnedTabs:", error);
        // Fallback to original method if there's an error
        if (typeof originalCloseAllUnpinnedTabs === "function") {
          originalCloseAllUnpinnedTabs.call(this);
        }
      }
    };
    
    console.log("[TidyTabs] Successfully patched closeAllUnpinnedTabs to preserve tab-groups");
  }

  // --- Optimized Helper: Count Tabs for Button Visibility ---
  const countTabsForButtonVisibility = () => {
    const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;

    if (
      !currentWorkspaceId ||
      typeof gBrowser === "undefined" ||
      !gBrowser.tabs
    ) {
      return {
        ungroupedTotal: 0,
        ungroupedNonSelected: 0,
        hasGroupedTabs: false,
      };
    }

    let ungroupedTotal = 0;
    let ungroupedNonSelected = 0;
    let hasGroupedTabs = false;

    // Use optimized filtering
    const allTabs = getFilteredTabs(currentWorkspaceId, {
      includeGrouped: true,
      includeSelected: true,
      includePinned: false,
      includeEmpty: false,
      includeGlance: false,
    });

    for (const tab of allTabs) {
      const groupParent = tab.closest("tab-group");
      const isInGroup = !!groupParent;
      const isSelected = tab.selected;

      if (isInGroup) {
        hasGroupedTabs = true;
      } else {
        ungroupedTotal++;
        if (!isSelected) {
          ungroupedNonSelected++;
        }
      }
    }

    return {
      ungroupedTotal,
      ungroupedNonSelected,
      hasGroupedTabs,
    };
  };

  // --- Updated Helper: Update Button Visibility State ---
  const updateButtonsVisibilityState = () => {
    const { ungroupedTotal, ungroupedNonSelected, hasGroupedTabs } =
      countTabsForButtonVisibility();
    const separators = domCache.getSeparators();

    batchDOMUpdates([
      () => {
        separators.forEach((separator) => {
          if (!separator?.isConnected) return;

          // Handle Tidy button visibility
          const tidyButton = separator.querySelector("#sort-button");
          if (tidyButton) {
            // Show button if:
            // 1. We have existing groups and any ungrouped tabs (even just 1)
            // 2. OR we have enough ungrouped tabs to potentially create new groups
            const shouldShowTidyButton = hasGroupedTabs
              ? ungroupedTotal > 0  // Show if any ungrouped tabs exist when groups are present
              : ungroupedTotal >= getMinTabsForSort(); // Threshold is user-configurable via the min-tabs pref, default 6

            if (shouldShowTidyButton) {
              tidyButton.classList.remove("hidden-button");
              // Update tooltip based on context
              if (hasGroupedTabs && ungroupedTotal > 0) {
                tidyButton.setAttribute("tooltiptext", 
                  ungroupedTotal === 1 
                    ? "Sort Tab into Existing Groups by Topic (AI)"
                    : "Sort Tabs into Groups by Topic (AI)"
                );
              } else {
                tidyButton.setAttribute("tooltiptext", "Sort Tabs into Groups by Topic (AI)");
              }
            } else {
              tidyButton.classList.add("hidden-button");
            }
          }

          // Always keep the separator visible
          separator.classList.remove("has-no-sortable-tabs");
        });
      },
    ]);
  };

  // --- Auto-sort new tabs (opt-in, zen.tidy-tabs.auto-sort-new-tabs) ---
  // Each tab opened after session restore is sorted once, when its first
  // real page has loaded. Ready tabs are batched into one embedding run
  // and matched with the same helpers (and strictness) as the broom sort.
  // tab -> time it started loading a real URL (null while still about:*).
  // WeakMap so closed tabs never leak.
  let autoSortPending = new WeakMap();
  const autoSortReady = new Set(); // loaded tabs waiting for the next batch
  const autoSortHandled = new WeakSet(); // once only: dragged-out tabs stay put
  const autoSortRetried = new WeakSet(); // transient failures get one retry
  let autoSortListeners = []; // [target, eventName, handler]
  let autoSortTimer = null;
  let autoSortArmTimer = null;
  let autoSortBusyRetries = 0;
  let autoSortGeneration = 0; // bumped on teardown: late arms / in-flight batches bail
  // Sine re-runs the script on rebuild; the previous copy's teardown lives
  // here so its listeners don't double-sort.
  const AUTO_SORT_TEARDOWN_KEY = Symbol.for("zen-tidy-tabs.auto-sort.teardown");

  const UNREADY_TITLES = new Set([
    "Untitled Page",
    "Invalid Tab",
    "Error Processing Tab",
  ]);

  const getTabURLSpec = (tab) => {
    try {
      return tab?.linkedBrowser?.currentURI?.spec || "";
    } catch (_e) {
      return "";
    }
  };

  // Loaded = not busy, real title, real (non-about:) URL.
  const isTabReadyForAutoSort = (tab) => {
    try {
      if (!tab?.isConnected || tab.hasAttribute("busy")) return false;
      const spec = getTabURLSpec(tab);
      if (!spec || spec.startsWith("about:")) return false;
      return !UNREADY_TITLES.has(getTabTitle(tab));
    } catch (_e) {
      return false;
    }
  };

  // "skip": never auto-sort (incl. already grouped: the drag-out guarantee).
  // "wait": transient state, worth one retry. "ok": sortable now.
  const getAutoSortTabState = (tab) => {
    if (
      !tab?.isConnected ||
      tab.closing ||
      tab.pinned ||
      tab.hasAttribute("zen-essential") ||
      tab.closest("tab-group") // e.g. opened from a grouped tab: Firefox grouped it
    ) {
      return "skip";
    }
    if (
      tab.hasAttribute("zen-glance-tab") ||
      tab.hasAttribute("zen-empty-tab") ||
      !tab.getAttribute("zen-workspace-id")
    ) {
      return "wait";
    }
    return "ok";
  };
  const isAutoSortCandidate = (tab) => getAutoSortTabState(tab) === "ok";

  const scheduleAutoSortBatch = (delay = CONFIG.AUTO_SORT_DEBOUNCE_MS) => {
    if (autoSortTimer != null) clearTimeout(autoSortTimer);
    autoSortTimer = setTimeout(runAutoSortBatch, delay);
  };

  const onAutoSortTabOpen = (event) => {
    try {
      if (!getAutoSortEnabled()) return;
      const tab = event.target;
      if (!tab || autoSortHandled.has(tab)) return;
      autoSortPending.set(tab, null);
    } catch (e) {
      console.error("[TabSort][Auto] TabOpen handler failed:", e);
    }
  };

  const onAutoSortTabAttrModified = (event) => {
    try {
      const tab = event.target;
      if (!autoSortPending.has(tab)) return;
      if (!getAutoSortEnabled()) {
        autoSortPending.delete(tab);
        return;
      }
      // Blank/newtab placeholder waiting for the user to type: no TTL yet.
      const spec = getTabURLSpec(tab);
      if (!spec || spec.startsWith("about:")) return;
      let loadStartedAt = autoSortPending.get(tab);
      if (loadStartedAt == null) {
        loadStartedAt = Date.now();
        autoSortPending.set(tab, loadStartedAt);
      }
      if (Date.now() - loadStartedAt > CONFIG.AUTO_SORT_PENDING_TTL_MS) {
        autoSortPending.delete(tab);
        return;
      }
      if (!isTabReadyForAutoSort(tab)) return;
      autoSortPending.delete(tab);
      autoSortReady.add(tab);
      scheduleAutoSortBatch();
    } catch (e) {
      console.error("[TabSort][Auto] TabAttrModified handler failed:", e);
    }
  };

  // Undo-close / session restore: not a new tab, never auto-sort it.
  const onAutoSortTabRestoring = (event) => {
    autoSortPending.delete(event.target);
    autoSortReady.delete(event.target);
  };

  const onAutoSortTabClose = (event) => {
    autoSortPending.delete(event.target);
    autoSortReady.delete(event.target);
  };

  const showAutoSortToast = (moved, created) => {
    const createdTabs = created.reduce((n, g) => n + g.count, 0);
    if (moved.length === 0 && created.length === 0) return;
    if (created.length === 0 && moved.length === 1) {
      showTidyToast(`Moved to “${moved[0]}”`, "info");
    } else if (moved.length === 0 && created.length === 1) {
      showTidyToast(`New group “${created[0].label}”`, "info");
    } else {
      showTidyToast(`Sorted ${moved.length + createdTabs} new tabs`, "info");
    }
  };

  // Sorts one batch of ready tabs. Never expands collapsed groups.
  const autoSortTabs = async (tabs) => {
    const generation = autoSortGeneration;
    // Teardown (Sine re-run / unload), pref off, or broom sort running.
    const shouldStop = () =>
      generation !== autoSortGeneration ||
      !getAutoSortEnabled() ||
      isSorting ||
      broomWaiting;
    const retryTabs = []; // transient failures (no embedding, state not settled)
    const moved = []; // group label per moved tab
    const created = []; // { label, count }

    const moveToGroup = (tab, groupEl, label, detail = "") => {
      try {
        const wasCollapsed = groupEl.collapsed;
        gBrowser.moveTabToExistingGroup(tab, groupEl);
        // Adding a tab expands the group; put it back as the user left it.
        if (wasCollapsed && !groupEl.collapsed) groupEl.collapsed = true;
        moved.push(label);
        console.log(`[TabSort][Auto] Moved "${getTabTitle(tab)}" to "${label}"${detail}`);
      } catch (e) {
        console.error(`[TabSort][Auto] Failed to move tab to "${label}":`, e);
      }
    };

    // Live (case-insensitive) lookup, so groups made earlier in this batch count.
    const findGroupByLabel = (wsId, label) => {
      const want = String(label).toLowerCase();
      for (const [l, info] of collectWorkspaceGroups(wsId)) {
        if (l.toLowerCase() === want && info.element?.isConnected) {
          return { label: l, element: info.element };
        }
      }
      return null;
    };

    // New group for these tabs, or join the same-named one if it exists.
    const createGroup = (wsId, label, groupTabs) => {
      if (groupTabs.length === 0) return;
      // Name already taken in this space (incl. groups made earlier in
      // this batch): join that group instead of creating a duplicate.
      const same = findGroupByLabel(wsId, label);
      if (same) {
        groupTabs.forEach((tab) =>
          moveToGroup(tab, same.element, same.label, " (same name as new group)")
        );
        return;
      }
      try {
        const newGroup = gBrowser.addTabGroup(groupTabs, {
          label,
          insertBefore: groupTabs[0],
        });
        if (!newGroup?.isConnected) {
          console.warn(`[TabSort][Auto] addTabGroup returned no group for "${label}"`);
          return;
        }
        created.push({ label, count: groupTabs.length });
        console.log(
          `[TabSort][Auto] Created group "${label}" with ${groupTabs.length} tab(s)`
        );
        // Same favicon-color touch as the broom sort (Advanced Tab Groups).
        try {
          if (typeof newGroup._useFaviconColor === "function") {
            setTimeout(() => newGroup._useFaviconColor(), 500);
          }
        } catch (_e) {}
        if (getAutoIconsEnabled()) {
          // Fire-and-forget: icons must never delay the sort.
          assignGroupIconsBackground([
            {
              element: newGroup,
              topic: label,
              titles: groupTabs
                .map((t) => getTabTitle(t))
                .filter(Boolean)
                .slice(0, 8),
            },
          ]).catch((e) => console.error("[TabSort][Auto] Icon pass failed:", e));
        }
      } catch (e) {
        console.error(`[TabSort][Auto] Error creating group "${label}":`, e);
      }
    };

    try {
      const byWorkspace = new Map();
      for (const tab of tabs) {
        if (autoSortHandled.has(tab)) continue;
        const state = getAutoSortTabState(tab);
        if (state === "skip") {
          autoSortHandled.add(tab);
          continue;
        }
        if (state === "wait") {
          retryTabs.push(tab);
          continue;
        }
        const wsId = tab.getAttribute("zen-workspace-id");
        if (!byWorkspace.has(wsId)) byWorkspace.set(wsId, []);
        byWorkspace.get(wsId).push(tab);
      }

      for (const [wsId, wsTabs] of byWorkspace) {
        if (shouldStop()) break;
        const existingGroups = collectWorkspaceGroups(wsId);
        // Nothing to match against and not allowed to create: skip inference.
        if (existingGroups.size === 0 && !getAutoSortCreateGroupsEnabled()) {
          wsTabs.forEach((tab) => autoSortHandled.add(tab));
          console.log(
            `[TabSort][Auto] No groups in workspace ${wsId}, leaving ${wsTabs.length} tab(s) ungrouped`
          );
          continue;
        }

        // 1. Site rules: decided without any AI, so these tabs skip it.
        let remaining = wsTabs;
        if (parseRules(getRulesText()).length > 0) {
          remaining = [];
          for (const tab of wsTabs) {
            const ruleLabel = isAutoSortCandidate(tab) ? matchRule(tab) : null;
            if (!ruleLabel) {
              remaining.push(tab);
              continue;
            }
            autoSortHandled.add(tab);
            const existing = findGroupByLabel(wsId, ruleLabel);
            if (existing) {
              moveToGroup(tab, existing.element, existing.label, " (rule)");
            } else if (getAutoSortCreateGroupsEnabled()) {
              createGroup(wsId, ruleLabel, [tab]);
            }
          }
        }

        // 2. Local LLM: chunked calls for the rest of this workspace.
        if (remaining.length > 0 && isLlmActive()) {
          const allowNew = getAutoSortCreateGroupsEnabled();
          const llmTabs = remaining.filter(isAutoSortCandidate);
          const newByName = new Map(); // lowercase name -> { name, tabs }
          let llmFailed = false;
          const loose = []; // tabs no existing group took
          // Pass 1: one tab per call against the existing groups only.
          for (let s = 0; s < llmTabs.length; s += LLM_ASSIGN_CHUNK) {
            if (shouldStop()) break;
            const chunk = llmTabs.slice(s, s + LLM_ASSIGN_CHUNK);
            const assignments = await llmAssignTabs(chunk, existingGroups, {
              allowNew: false,
            });
            if (shouldStop()) break;
            if (!assignments) {
              llmFailed = true;
              break;
            }
            chunk.forEach((tab, i) => {
              autoSortHandled.add(tab);
              // State may have changed during inference.
              if (!isAutoSortCandidate(tab)) return;
              const group = assignments[i]?.group;
              const groupEl = group ? existingGroups.get(group)?.element : null;
              if (groupEl?.isConnected) moveToGroup(tab, groupEl, group, " (llm)");
              else loose.push(tab);
            });
          }
          // Pass 2: a new group needs 2+ tabs on one subject, which a
          // single-tab call can't see, so the loose tabs go in batches.
          if (allowNew && !llmFailed && !shouldStop() && loose.length >= 2) {
            for (let s = 0; s < loose.length; s += LLM_NEWGROUP_CHUNK) {
              if (shouldStop()) break;
              const chunk = loose.slice(s, s + LLM_NEWGROUP_CHUNK);
              if (chunk.length < 2) break;
              const assignments = await llmAssignTabs(chunk, existingGroups, {
                allowNew: true,
              });
              if (shouldStop()) break;
              if (!assignments) break; // tabs stay loose; they were handled in pass 1
              chunk.forEach((tab, i) => {
                if (!isAutoSortCandidate(tab)) return;
                const newGroup = assignments[i]?.newGroup;
                if (!newGroup) return;
                const key = newGroup.toLowerCase();
                if (!newByName.has(key)) newByName.set(key, { name: newGroup, tabs: [] });
                newByName.get(key).tabs.push(tab);
              });
            }
          }
          if (shouldStop()) break;
          for (const { name, tabs: groupTabs } of newByName.values()) {
            if (shouldStop() || !getAutoSortCreateGroupsEnabled()) break;
            createGroup(wsId, name, groupTabs.filter(isAutoSortCandidate));
          }
          if (!llmFailed) {
            // Every tab of this batch had its one shot (incl. non-candidates).
            remaining.forEach((tab) => autoSortHandled.add(tab));
            continue;
          }
          // LLM failed part-way: tabs it did not cover go to the built-in
          // embedding path below, unchanged.
          remaining = remaining.filter((tab) => !autoSortHandled.has(tab));
        }
        if (remaining.length === 0) continue;

        const titles = remaining.map((tab) => getTabTitle(tab));
        const embeddings = await getEmbeddingsForTitles(titles);
        if (generation !== autoSortGeneration) return;
        // Once a tab has an embedding it has had its one shot.
        remaining.forEach((tab, i) => {
          if (embeddings[i]) autoSortHandled.add(tab);
          else retryTabs.push(tab);
        });
        const groupEmbeddings = await embedWorkspaceGroups(existingGroups);
        if (shouldStop()) break;

        const unmatchedTabs = [];
        const unmatchedEmbeddings = [];
        for (let i = 0; i < remaining.length; i++) {
          const tab = remaining[i];
          if (!embeddings[i]) continue;
          // State may have changed during inference (closed, grouped, pinned...).
          if (!isAutoSortCandidate(tab)) continue;
          const match = findAutoSortGroup(
            titles[i],
            embeddings[i],
            existingGroups,
            groupEmbeddings
          );
          const groupEl = match ? existingGroups.get(match.groupName)?.element : null;
          if (groupEl?.isConnected) {
            moveToGroup(
              tab,
              groupEl,
              match.groupName,
              ` (similarity: ${match.similarity.toFixed(3)}, type: ${match.matchType})`
            );
            continue;
          }
          unmatchedTabs.push(tab);
          unmatchedEmbeddings.push(embeddings[i]);
        }

        if (unmatchedTabs.length === 0) continue;
        if (!getAutoSortCreateGroupsEnabled()) {
          console.log(
            `[TabSort][Auto] ${unmatchedTabs.length} tab(s) match no group, leaving them ungrouped`
          );
          continue;
        }

        // Unlike the broom sort, single-tab clusters also get a group here.
        const clusters = clusterEmbeddings(
          unmatchedEmbeddings,
          CONFIG.SIMILARITY_THRESHOLD
        );
        for (const cluster of clusters) {
          if (shouldStop() || !getAutoSortCreateGroupsEnabled()) break;
          const clusterTabs = cluster
            .map((idx) => unmatchedTabs[idx])
            .filter(isAutoSortCandidate);
          if (clusterTabs.length === 0) continue;
          const clusterTitles = clusterTabs.map((tab) => getTabTitle(tab));
          const label = await nameGroupWithSmartTabTopic(clusterTitles);
          // Naming is async: re-validate before touching the DOM.
          if (shouldStop()) break;
          createGroup(wsId, label, clusterTabs.filter(isAutoSortCandidate));
        }
      }

      if (generation !== autoSortGeneration) return;
      moveLooseTabsAboveGroupsEverywhere();
      showAutoSortToast(moved, created);
    } finally {
      // One retry on the next batch, then give up on the tab for good.
      if (generation === autoSortGeneration) {
        let requeued = 0;
        for (const tab of retryTabs) {
          if (autoSortHandled.has(tab) || !tab.isConnected) continue;
          if (autoSortRetried.has(tab)) {
            autoSortHandled.add(tab);
            continue;
          }
          autoSortRetried.add(tab);
          autoSortReady.add(tab);
          requeued++;
        }
        if (requeued > 0) {
          console.log(`[TabSort][Auto] Retrying ${requeued} tab(s) in the next batch`);
          scheduleAutoSortBatch();
        }
      }
    }
  };

  const runAutoSortBatch = () => {
    autoSortTimer = null;
    try {
      if (!getAutoSortEnabled()) {
        autoSortReady.clear();
        return;
      }
      if (autoSortReady.size === 0) return;
      // Broom sort (or a previous batch) owns the tabs right now: retry
      // shortly, but not forever.
      if (isSorting || autoSortPromise) {
        // A broom sort (possibly a slow LLM one) does not use up the budget.
        if (!isSorting && ++autoSortBusyRetries > CONFIG.AUTO_SORT_MAX_BUSY_RETRIES) {
          console.warn(
            `[TabSort][Auto] Still busy after ${CONFIG.AUTO_SORT_MAX_BUSY_RETRIES} retries, dropping ${autoSortReady.size} tab(s)`
          );
          autoSortReady.clear();
          autoSortBusyRetries = 0;
          return;
        }
        scheduleAutoSortBatch(CONFIG.AUTO_SORT_RETRY_MS);
        return;
      }
      autoSortBusyRetries = 0;
      const tabs = Array.from(autoSortReady);
      autoSortReady.clear();
      console.log(`[TabSort][Auto] Processing ${tabs.length} new tab(s)`);
      const run = autoSortTabs(tabs).catch((e) =>
        console.error("[TabSort][Auto] Batch failed:", e)
      );
      autoSortPromise = run;
      run.finally(() => {
        if (autoSortPromise === run) autoSortPromise = null;
      });
    } catch (e) {
      console.error("[TabSort][Auto] Failed to start batch:", e);
    }
  };

  const teardownAutoSort = () => {
    autoSortGeneration++;
    for (const [target, name, handler] of autoSortListeners) {
      try {
        target.removeEventListener(name, handler);
      } catch (_e) {}
    }
    autoSortListeners = [];
    if (autoSortTimer != null) {
      clearTimeout(autoSortTimer);
      autoSortTimer = null;
    }
    if (autoSortArmTimer != null) {
      clearTimeout(autoSortArmTimer);
      autoSortArmTimer = null;
    }
    autoSortPending = new WeakMap();
    autoSortReady.clear();
    autoSortBusyRetries = 0;
    try {
      if (window[AUTO_SORT_TEARDOWN_KEY] === teardownAutoSort) {
        delete window[AUTO_SORT_TEARDOWN_KEY];
      }
    } catch (_e) {}
  };

  // Listeners are always attached (cheap); the pref is checked per event.
  // Armed only after session restore so restored tabs are never sorted.
  const setupAutoSort = () => {
    if (
      autoSortListeners.length > 0 ||
      autoSortArmTimer != null ||
      typeof gBrowser === "undefined" ||
      !gBrowser.tabContainer
    ) {
      return;
    }
    try {
      const previous = window[AUTO_SORT_TEARDOWN_KEY];
      if (typeof previous === "function" && previous !== teardownAutoSort) {
        previous();
      }
      window[AUTO_SORT_TEARDOWN_KEY] = teardownAutoSort;
    } catch (_e) {}

    const generation = autoSortGeneration;
    const arm = () => {
      autoSortArmTimer = null;
      if (generation !== autoSortGeneration || autoSortListeners.length > 0) return;
      const container = gBrowser?.tabContainer;
      if (!container) return;
      const listen = (name, handler) => {
        container.addEventListener(name, handler);
        autoSortListeners.push([container, name, handler]);
      };
      listen("TabOpen", onAutoSortTabOpen);
      listen("TabAttrModified", onAutoSortTabAttrModified);
      listen("SSTabRestoring", onAutoSortTabRestoring);
      listen("TabClose", onAutoSortTabClose);
      console.log("[TabSort][Auto] Listening for new tabs");
    };

    let restored = null;
    try {
      restored =
        typeof SessionStore !== "undefined"
          ? SessionStore.promiseAllWindowsRestored
          : null;
    } catch (_e) {}
    if (restored && typeof restored.then === "function") {
      restored.then(arm, arm);
    } else {
      // Fail closed: without the restore signal, give restore time to
      // finish rather than risk sorting restored tabs.
      autoSortArmTimer = setTimeout(arm, CONFIG.AUTO_SORT_ARM_FALLBACK_MS);
    }
  };

  // --- Add Tab Event Listeners for Visibility Updates ---
  function addTabEventListeners() {
    if (
      eventListenersAdded ||
      typeof gBrowser === "undefined" ||
      !gBrowser.tabContainer
    ) {
      return;
    }

    const updateVisibilityDebounced = debounce(
      updateButtonsVisibilityState,
      CONFIG.DEBOUNCE_DELAY
    );

    const events = [
      "TabOpen",
      "TabClose",
      "TabSelect",
      "TabPinned",
      "TabUnpinned",
      "TabGroupAdd",
      "TabGroupRemove",
      "TabGrouped",
      "TabUngrouped",
      "TabAttrModified",
    ];

    events.forEach((eventName) => {
      gBrowser.tabContainer.addEventListener(
        eventName,
        updateVisibilityDebounced
      );
    });

    // Listen to workspace changes
    if (typeof window.gZenWorkspaces !== "undefined") {
      window.addEventListener(
        "zen-workspace-switched",
        updateVisibilityDebounced
      );
      // Prototype: stale cross-workspace suggestions must not linger
      // after the user switches spaces.
      window.addEventListener("zen-workspace-switched", () => {
        try {
          clearWorkspaceSuggestions(false);
        } catch (_e) {}
      });
    }

    eventListenersAdded = true;
  }

  // --- Debounce Utility (to prevent rapid firing) ---
  function debounce(func, wait) {
    if (typeof func !== "function" || typeof wait !== "number") {
      return () => {};
    }

    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // --- Min-tabs pref observer: refresh button visibility live when the user types a new amount ---
  function setupMinTabsPrefObserver() {
    if (minTabsPrefObserver) return;
    try {
      if (typeof Services === "undefined" || !Services.prefs?.addObserver) return;
      minTabsPrefObserver = {
        observe(_subject, topic, data) {
          if (topic === "nsPref:changed" && data === MIN_TABS_PREF) {
            updateButtonsVisibilityState();
          }
        },
      };
      Services.prefs.addObserver(MIN_TABS_PREF, minTabsPrefObserver);
    } catch (e) {
      console.error("[TabSort] Failed to observe min-tabs pref:", e);
      minTabsPrefObserver = null;
    }
  }

  function removeMinTabsPrefObserver() {
    try {
      if (minTabsPrefObserver && typeof Services !== "undefined" && Services.prefs?.removeObserver) {
        Services.prefs.removeObserver(MIN_TABS_PREF, minTabsPrefObserver);
      }
    } catch (_e) {
      /* ignore */
    }
    minTabsPrefObserver = null;
  }

  // --- "Keep ungrouped tabs above groups" is a standing rule, not only a
  // post-sort step: applied in every space once the session is restored, and
  // again whenever the switch is turned on. Later manual drags are left alone. ---
  let ungroupedOnTopObserver = null;

  function setupUngroupedOnTop() {
    if (ungroupedOnTopObserver) return;
    try {
      if (typeof Services === "undefined" || !Services.prefs?.addObserver) return;
      ungroupedOnTopObserver = {
        observe(_subject, topic, data) {
          if (topic === "nsPref:changed" && data === UNGROUPED_ON_TOP_PREF) {
            moveLooseTabsAboveGroupsEverywhere();
          }
        },
      };
      Services.prefs.addObserver(UNGROUPED_ON_TOP_PREF, ungroupedOnTopObserver);
    } catch (e) {
      console.error("[TabSort] Failed to observe ungrouped-on-top pref:", e);
      ungroupedOnTopObserver = null;
    }
    let restored = null;
    try {
      restored =
        typeof SessionStore !== "undefined"
          ? SessionStore.promiseAllWindowsRestored
          : null;
    } catch (_e) {}
    if (restored && typeof restored.then === "function") {
      restored.then(moveLooseTabsAboveGroupsEverywhere, () => {});
    } else {
      moveLooseTabsAboveGroupsEverywhere();
    }
  }

  function removeUngroupedOnTopObserver() {
    try {
      if (ungroupedOnTopObserver && typeof Services !== "undefined" && Services.prefs?.removeObserver) {
        Services.prefs.removeObserver(UNGROUPED_ON_TOP_PREF, ungroupedOnTopObserver);
      }
    } catch (_e) {
      /* ignore */
    }
    ungroupedOnTopObserver = null;
  }

  // --- Cleanup Function ---
  const cleanup = () => {
    try {
      removeMinTabsPrefObserver();
      removeUngroupedOnTopObserver();
      cancelWarmup();
      try {
        teardownAutoSort();
      } catch (_e) {}
      // Stop any running animations
      cleanupAnimation();
      clearTidyToasts();
      try {
        clearWorkspaceSuggestions(false);
      } catch (_e) {}
      try {
        workspaceProfileCache.clear();
      } catch (_e) {}

      // Clear DOM cache
      domCache.invalidate();

      // Drop cached vectors + engine promises so a reloaded script
      // doesn't hold stale ML runtimes.
      embeddingCache.clear();
      try {
        iconEmbeddingCache.clear();
      } catch (_e) {}
      embeddingEnginePromise = null;
      namerEnginePromise = null;
      warmupStarted = false;

      // Reset state
      isSorting = false;
      eventListenersAdded = false;

      console.log("Tab sort script cleanup completed");
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  };

  // --- Initial Setup Trigger ---
  function initializeScript() {
    const tryInitialize = () => {
      try {
        const separatorExists = domCache.getSeparators().length > 0;
        const commandSetExists = !!domCache.getCommandSet();
        const gBrowserReady =
          typeof gBrowser !== "undefined" && gBrowser?.tabContainer;
        const gZenWorkspacesReady =
          typeof window.gZenWorkspaces !== "undefined";

        const ready =
          gBrowserReady &&
          commandSetExists &&
          separatorExists &&
          gZenWorkspacesReady;

        if (ready) {
          setupSortCommandAndListener();
          addSortButtonToAllSeparators();
          setupgZenWorkspacesHooks();
          patchClearButtonToPreserveGroups(); // Patch the clear button
          setupMinTabsPrefObserver();
          updateButtonsVisibilityState();
          addTabEventListeners();
          setupAutoSort();
          setupUngroupedOnTop();
          // Pre-load ML engines idle so the first sort skips
          // createEngine + model-download latency.
          try {
            warmupMLEngines();
          } catch (_e) {}

          return true;
        }
      } catch (e) {
        console.error("Error during initialization:", e);
      }
      return false;
    };

    // Try immediate initialization
    if (tryInitialize()) return;

    // Fallback to polling
    let checkCount = 0;
    const initCheckInterval = setInterval(() => {
      checkCount++;

      if (tryInitialize()) {
        clearInterval(initCheckInterval);
      } else if (checkCount > CONFIG.MAX_INIT_CHECKS) {
        clearInterval(initCheckInterval);
        console.warn(
          `Tab sort initialization timed out after ${
            CONFIG.MAX_INIT_CHECKS * CONFIG.INIT_CHECK_INTERVAL
          }ms`
        );
      }
    }, CONFIG.INIT_CHECK_INTERVAL);
  }

  // --- Start Initialization ---
  if (document.readyState === "complete") {
    initializeScript();
  } else {
    window.addEventListener("load", initializeScript, { once: true });
  }

  // --- Add Cleanup Listeners ---
  window.addEventListener("unload", cleanup, { once: true });
  window.addEventListener("beforeunload", cleanup, { once: true });
})(); // End script
