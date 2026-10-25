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
    WARMUP_ENABLED: true, // Pre-create engines at startup so first sort is fast
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

  const BROOM_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 28 28" class="broom-icon">
                                    <g>
                                        <path d="M19.9132 21.3765C19.8875 21.0162 19.6455 20.7069 19.3007 20.5993L7.21755 16.8291C6.87269 16.7215 6.49768 16.8384 6.27165 17.1202C5.73893 17.7845 4.72031 19.025 3.78544 19.9965C2.4425 21.392 3.01177 22.4772 4.66526 22.9931C4.82548 23.0431 5.78822 21.7398 6.20045 21.7398C6.51906 21.8392 6.8758 23.6828 7.26122 23.8031C7.87402 23.9943 8.55929 24.2081 9.27891 24.4326C9.59033 24.5298 10.2101 23.0557 10.5313 23.1559C10.7774 23.2327 10.7236 24.8834 10.9723 24.961C11.8322 25.2293 12.699 25.4997 13.5152 25.7544C13.868 25.8645 14.8344 24.3299 15.1637 24.4326C15.496 24.5363 15.191 26.2773 15.4898 26.3705C16.7587 26.7664 17.6824 27.0546 17.895 27.1209C19.5487 27.6369 20.6333 27.068 20.3226 25.1563C20.1063 23.8255 19.9737 22.2258 19.9132 21.3765Z" stroke="none"/>
                                        <path d="M16.719 1.7134C17.4929-0.767192 20.7999 0.264626 20.026 2.74523C19.2521 5.22583 18.1514 8.75696 17.9629 9.36C17.7045 10.1867 16.1569 15.1482 15.899 15.9749L19.2063 17.0068C20.8597 17.5227 20.205 19.974 18.4514 19.4268L8.52918 16.331C6.87208 15.8139 7.62682 13.3938 9.28426 13.911L12.5916 14.9429C12.8495 14.1163 14.3976 9.15491 14.6555 8.32807C14.9135 7.50122 15.9451 4.19399 16.719 1.7134Z" stroke="none"/>
                                    </g>
                                </svg>`;

  // --- Globals & State ---
  let isSorting = false;
  let sortButtonListenerAdded = false;
  let isPlayingFailureAnimation = false;
  let sortAnimationId = null;
  let eventListenersAdded = false;
  let minTabsPrefObserver = null;

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

  const askAIForMultipleTopics = async (tabs) => {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];

    const validTabs = tabs.filter((tab) => tab?.isConnected);
    if (!validTabs.length) return [];

    const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
    const result = [];
    const ungroupedTabs = [];
    // Reuse first-pass vectors for the clustering pass below — no re-inference.
    const ungroupedEmbeddingsReuse = [];

    // Get existing groups in current workspace
    const existingWorkspaceGroups = new Map();
    if (currentWorkspaceId) {
      const groupSelector = `tab-group:has(tab[zen-workspace-id="${currentWorkspaceId}"])`;
      document.querySelectorAll(groupSelector).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          // Get tabs in this group to calculate group embedding
          const groupTabs = Array.from(groupEl.querySelectorAll('tab')).filter(tab => 
            tab.getAttribute("zen-workspace-id") === currentWorkspaceId
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

    // Batched inference with cache (single shared engine, no re-creation).
    const tabTitles = validTabs.map((tab) => getTabTitle(tab));
    const embeddings = await getEmbeddingsForTitles(tabTitles);

    // Calculate embeddings for existing workspace groups (cache-hit when
    // titles overlap with open tabs).
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
            groupData: { groupName }, 
            similarity,
            isExistingGroup: true
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
                groupData: { groupName }, 
                similarity: adjustedSimilarity,
                isExistingGroup: true,
                matchType: 'title'
              };
              bestSimilarity = adjustedSimilarity;
            }
          }
        }
      }

      if (bestMatch) {
        // Add tab to existing group
        result.push({ tab, topic: bestMatch.groupData.groupName });
        console.log(`[TabSort] Matched "${tabTitle}" to existing group "${bestMatch.groupData.groupName}" (similarity: ${bestMatch.similarity.toFixed(3)}, type: ${bestMatch.matchType || 'embedding'})`);
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
        showTidyToast("Nothing to tidy!", "info");
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

      // --- Reorder tabs: groups first, then ungrouped tabs ---
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
          
          // Only reorder if we have both groups AND ungrouped tabs
          if (groups.length > 0 && ungroupedTabs.length > 0) {
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

  // --- Cleanup Function ---
  const cleanup = () => {
    try {
      removeMinTabsPrefObserver();
      cancelWarmup();
      // Stop any running animations
      cleanupAnimation();
      clearTidyToasts();

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
