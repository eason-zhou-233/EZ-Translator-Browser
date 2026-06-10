// ============================================================
// 文件：service_worker.js
// 功能：浏览器扩展的后台服务脚本（Service Worker）
// 说明：
//   - 管理翻译缓存（IndexedDB），支持 LRU 淘汰和 TTL 过期
//   - 创建右键菜单（翻译选区/恢复选区/翻译页面/恢复页面）
//   - 处理来自 content_script 和 popup 的翻译请求
//   - 支持两种翻译后端：Google Translate API / OpenAI 兼容 API
//   - 提供 API 连接测试功能
// ============================================================

// 默认设置
const DEFAULT_SETTINGS = {
  translationProvider: "native",       // 翻译引擎选择
  translationService: "google",        // 传统翻译服务商

  googleTranslateBaseUrl: "https://translate.googleapis.com",

  apiBaseUrl: "http://localhost:1234",          // 大模型 API 地址
  chatPath: "/v1/chat/completions",             // Chat 端点路径
  modelName: "hy-mt2-1.8b",                     // 模型名

  apiKey: "",
  apiKeyHeader: "Authorization",
  apiKeyPrefix: "Bearer",

  temperature: 0.7,
  topK: 20,
  topP: 0.6,
  maxTokens: 4096,
  timeoutMs: 120000,

  extraHeaders: "{}",

  defaultTargetLanguage: "Chinese",
};

// 缓存配置
const CACHE_MAX_ENTRIES = 2000;                           // 最大缓存条目数（超出后按 LRU 淘汰）
const CACHE_TTL_MS = 10 * 24 * 60 * 60 * 1000;           // 缓存有效期：10 天
const CACHE_MAINTENANCE_THROTTLE_MS = 10 * 60 * 1000;     // 缓存维护节流：10 分钟

// 右键菜单 ID 常量
const MENU_IDS = {
  translateSelection: "translate-selection",    // 翻译选中文本
  restoreSelection: "restore-selection",         // 恢复选中文本
  translatePage: "translate-page",               // 翻译整个页面
  restorePage: "restore-page",                   // 恢复整个页面
};

// 测试连接的哨兵值：发送 "Ping"，期望返回 "Ping"
const TEST_SENTINEL = "Ping";

// 上次缓存维护的时间戳，用于节流
let lastCacheMaintenanceAt = 0;

/**
 * IndexedDB 缓存模块
 * 使用 IndexedDB 持久化翻译结果缓存，Service Worker 生命周期内可跨请求复用
 * 缓存键格式：{引擎ID}|{目标语言}|{原文}
 * 每条记录包含：key, text, targetLanguage, translated, createdAt, accessedAt
 */

// 初始化 IndexedDB 数据库
// 数据库名：TranslationCache，版本：1
// 对象存储：translations，主键为 key
function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("TranslationCache", 1);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains("translations")) {
        db.createObjectStore("translations", {
          keyPath: "key",
        });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 获取翻译引擎标识符（native 或 llm），用于区分不同引擎的缓存
function getTranslationEngineId(settings) {
  return String(settings?.translationProvider || DEFAULT_SETTINGS.translationProvider || "native")
    .trim() || "native";
}

// 生成缓存键：引擎ID + 目标语言 + 原文
// 不同引擎、不同目标语言的翻译结果互不干扰
function getCacheKey(text, targetLanguage, settings) {
  const engineId = getTranslationEngineId(settings);
  return `${engineId}|${targetLanguage}|${text}`;
}

// 将 IndexedDB 请求转为 Promise
function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 等待 IndexedDB 事务完成
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// 从缓存中读取单条记录
async function readCacheRecord(db, key) {
  const tx = db.transaction("translations", "readonly");
  const store = tx.objectStore("translations");

  const req = store.get(key);
  const result = await requestToPromise(req);

  await transactionDone(tx).catch(() => { });

  return result || null;
}

// 写入或更新缓存记录（使用 put，存在则覆盖）
async function putCacheRecord(db, record) {
  const tx = db.transaction("translations", "readwrite");
  const store = tx.objectStore("translations");

  const req = store.put(record);
  await requestToPromise(req);

  await transactionDone(tx);
}

// 批量删除缓存记录
async function deleteCacheKeys(db, keys) {
  if (!Array.isArray(keys) || !keys.length) return;

  const tx = db.transaction("translations", "readwrite");
  const store = tx.objectStore("translations");

  for (const key of keys) {
    store.delete(key);
  }

  await transactionDone(tx);
}

// 读取所有缓存记录（用于缓存维护）
async function readAllCacheRecords(db) {
  const tx = db.transaction("translations", "readonly");
  const store = tx.objectStore("translations");

  const req = store.getAll();
  const result = await requestToPromise(req);

  await transactionDone(tx).catch(() => { });

  return Array.isArray(result) ? result : [];
}

// 获取记录的最后使用时间（优先 accessedAt，回退到 createdAt）
function getRecordLastUsedAt(record) {
  return record?.accessedAt ?? record?.createdAt ?? 0;
}

// 判断缓存记录是否已过期（超过 CACHE_TTL_MS）
function isRecordExpired(record, now = Date.now()) {
  const lastUsedAt = getRecordLastUsedAt(record);
  if (!lastUsedAt) return true;
  return now - lastUsedAt > CACHE_TTL_MS;
}

// 更新记录的访问时间（LRU 排序依据）
async function touchCacheRecord(db, record) {
  if (!record?.key) return;

  await putCacheRecord(db, {
    ...record,
    accessedAt: Date.now(),
  });
}

// 缓存清理维护：删除过期记录 + LRU 淘汰超出上限的记录
// 除非 force=true，否则每 10 分钟最多执行一次（节流）
// 清理策略：
//   1. 删除所有超过 TTL 的过期记录
//   2. 如果剩余记录数超过 CACHE_MAX_ENTRIES，按 LRU 删除最旧的记录
async function pruneCacheIfNeeded(db, force = false) {
  const now = Date.now();

  // 节流控制：非强制模式下，距上次维护不足 10 分钟则跳过
  if (!force && now - lastCacheMaintenanceAt < CACHE_MAINTENANCE_THROTTLE_MS) {
    return;
  }

  lastCacheMaintenanceAt = now;

  const records = await readAllCacheRecords(db);
  if (!records.length) return;

  const expiredKeys = [];
  const validRecords = [];

  for (const record of records) {
    if (!record?.key) continue;

    if (isRecordExpired(record, now)) {
      expiredKeys.push(record.key);
      continue;
    }

    validRecords.push(record);
  }

  // 按最后使用时间升序排列（最旧的在前）
  validRecords.sort((a, b) => getRecordLastUsedAt(a) - getRecordLastUsedAt(b));

  // 计算超出上限的数量，取最旧的记录作为 LRU 淘汰目标
  const overflowCount = Math.max(0, validRecords.length - CACHE_MAX_ENTRIES);
  const lruKeys = validRecords.slice(0, overflowCount).map((r) => r.key);

  // 合并去重后批量删除
  const keysToDelete = [...new Set([...expiredKeys, ...lruKeys])];
  if (!keysToDelete.length) return;

  await deleteCacheKeys(db, keysToDelete);
}

// 从缓存获取翻译结果
// 流程：查缓存 → 检查过期 → 更新访问时间 → 返回结果
// 如果记录过期或不存在，返回 null
async function getCachedTranslation(text, targetLanguage, settings) {
  try {
    const key = getCacheKey(text, targetLanguage, settings);
    const db = await initDB();
    const record = await readCacheRecord(db, key);

    if (!record?.translated) {
      await pruneCacheIfNeeded(db).catch(() => { });
      return null;
    }

    const now = Date.now();
    if (isRecordExpired(record, now)) {
      // 过期记录：删除后返回 null
      await deleteCacheKeys(db, [key]).catch(() => { });
      await pruneCacheIfNeeded(db).catch(() => { });
      return null;
    }

    // 命中缓存：更新访问时间（用于 LRU 排序）
    await touchCacheRecord(db, record).catch(() => { });
    await pruneCacheIfNeeded(db).catch(() => { });

    return record.translated;
  } catch {
    return null;
  }
}

// 将翻译结果写入缓存
// 写入后强制执行一次缓存清理（force=true）
async function setCachedTranslation(text, targetLanguage, translated, settings) {
  try {
    const key = getCacheKey(text, targetLanguage, settings);
    const db = await initDB();
    const now = Date.now();

    await putCacheRecord(db, {
      key,
      text,
      targetLanguage,
      translated,
      createdAt: now,
      accessedAt: now,
    });

    await pruneCacheIfNeeded(db, true);  // 写入后强制清理
  } catch (err) {
    console.warn("Cache write error:", err);
  }
}

function normalizeSettings(raw = {}) {
  const textOrDefault = (value, fallback) => {
    const normalized = String(value ?? "").trim();
    return normalized === "" ? fallback : normalized;
  };

  const optionalText = (value) => String(value ?? "").trim();

  return {
    translationProvider: textOrDefault(
      raw.translationProvider,
      DEFAULT_SETTINGS.translationProvider
    ),

    translationService: textOrDefault(
      raw.translationService,
      DEFAULT_SETTINGS.translationService
    ),

    googleTranslateBaseUrl: textOrDefault(
      raw.googleTranslateBaseUrl,
      DEFAULT_SETTINGS.googleTranslateBaseUrl
    ),

    apiBaseUrl: textOrDefault(raw.apiBaseUrl, DEFAULT_SETTINGS.apiBaseUrl),
    chatPath: textOrDefault(raw.chatPath, DEFAULT_SETTINGS.chatPath),
    modelName: textOrDefault(raw.modelName, DEFAULT_SETTINGS.modelName),
    apiKey: optionalText(raw.apiKey),
    apiKeyHeader: textOrDefault(raw.apiKeyHeader, DEFAULT_SETTINGS.apiKeyHeader),
    apiKeyPrefix: textOrDefault(raw.apiKeyPrefix, DEFAULT_SETTINGS.apiKeyPrefix),
    temperature: coerceProbability(raw.temperature, DEFAULT_SETTINGS.temperature),
    topK: coerceNumber(raw.topK, DEFAULT_SETTINGS.topK),
    topP: coerceProbability(raw.topP, DEFAULT_SETTINGS.topP),
    maxTokens: Math.max(1, coerceNumber(raw.maxTokens, DEFAULT_SETTINGS.maxTokens)),
    timeoutMs: Math.max(1000, coerceNumber(raw.timeoutMs, DEFAULT_SETTINGS.timeoutMs)),
    extraHeaders: textOrDefault(raw.extraHeaders, DEFAULT_SETTINGS.extraHeaders),
    defaultTargetLanguage: textOrDefault(
      raw.defaultTargetLanguage,
      DEFAULT_SETTINGS.defaultTargetLanguage
    ),
  };
}

async function loadSettings() {
  const current = await chrome.storage.sync.get(null);
  return normalizeSettings(current);
}

async function ensureDefaultSettings() {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({
    ...current,
    ...DEFAULT_SETTINGS,
  });
}

/**
 * Context Menus
 */
async function createContextMenus() {
  await new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });

  chrome.contextMenus.create({
    id: MENU_IDS.translateSelection,
    title: "翻译选中的文本",
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: MENU_IDS.restoreSelection,
    title: "显示原文本",
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: MENU_IDS.translatePage,
    title: "翻译当前页面",
    contexts: ["page"],
  });

  chrome.contextMenus.create({
    id: MENU_IDS.restorePage,
    title: "显示原页面",
    contexts: ["page"],
  });
}

// 扩展安装/更新时初始化：写入默认设置、创建右键菜单、清理过期缓存
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await ensureDefaultSettings();
    await createContextMenus();

    const db = await initDB();
    await pruneCacheIfNeeded(db, true);
  } catch (err) {
    console.error("Initialization failed:", err);
  }
});

// 浏览器启动时初始化：Service Worker 可能被终止后重启，需要重建右键菜单
chrome.runtime.onStartup.addListener(async () => {
  try {
    await createContextMenus();

    const db = await initDB();
    await pruneCacheIfNeeded(db, true);
  } catch (err) {
    console.error("Startup initialization failed:", err);
  }
});

// 右键菜单点击事件处理：根据 menuItemId 向对应标签页发送翻译/恢复消息
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === MENU_IDS.translateSelection) {
    chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_SELECTION",
    });
    return;
  }

  if (info.menuItemId === MENU_IDS.restoreSelection) {
    chrome.tabs.sendMessage(tab.id, {
      type: "RESTORE_SELECTION",
    });
    return;
  }

  if (info.menuItemId === MENU_IDS.translatePage) {
    chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_PAGE",
    });
    return;
  }

  if (info.menuItemId === MENU_IDS.restorePage) {
    chrome.tabs.sendMessage(tab.id, {
      type: "RESTORE_PAGE",
    });
    return;
  }
});

/**
 * 运行时消息处理
 * 接收来自 content_script 和 popup 的消息
 * 支持的消息类型：
 *   TRANSLATE_TEXT        - 翻译文本
 *   TEST_OPENAI_API       - 测试大模型 API 连接
 *   TEST_GOOGLE_TRANSLATE - 测试 Google 翻译连接
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;

  if (message.type === "TRANSLATE_TEXT") {
    (async () => {
      try {
        const settings = await loadSettings();
        const result = await translateText({
          text: message.text,
          settings,
          targetLanguage: message.targetLanguage,
          translationMode: message.translationMode,
        });

        sendResponse({
          ok: true,
          ...result,
        });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  if (message.type === "TEST_OPENAI_API") {
    (async () => {
      try {
        await testOpenAICompatibleAPI(normalizeSettings(message.settings));
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  if (message.type === "TEST_GOOGLE_TRANSLATE") {
    (async () => {
      try {
        const settings = normalizeSettings(message.settings);
        await requestGoogleTranslate({
          settings,
          input: "hello",
          targetLanguage: "Chinese",
        });

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  return false;
});

/**
 * 核心翻译函数
 * 流程：检查空文本 → 确定目标语言（选区/页面翻译强制中文） → 查缓存 → 调用翻译API → 写缓存
 * 支持两种后端：native（Google Translate）和 llm（OpenAI 兼容 API）
 */
async function translateText({
  text,
  settings,
  targetLanguage: explicitTargetLanguage,
  translationMode,
}) {
  const input = typeof text === "string" ? text : String(text ?? "");

  if (!input.trim()) {
    throw new Error("待翻译文本为空");
  }

  // 选区和整页翻译模式强制目标语言为中文
  const forcedChineseMode =
    translationMode === "selection" || translationMode === "page";

  // 确定最终目标语言：强制中文模式 > 显式指定 > 默认设置 > Chinese
  const targetLanguage = forcedChineseMode
    ? "Chinese"
    : explicitTargetLanguage || settings.defaultTargetLanguage || "Chinese";

  console.log(
    "[Translate]",
    {
      provider: settings.translationProvider,
      targetLanguage,
      translationMode,
      textLength: input.length,
    }
  );

  if (forcedChineseMode && isPureChineseText(input)) {
    return {
      translated: input,
      targetLanguage,
      skipped: true,
      reason: "already_chinese",
    };
  }

  const cached = await getCachedTranslation(input, targetLanguage, settings);
  if (cached) {
    console.log(
      "[Translate] Cache Hit",
      {
        provider: settings.translationProvider,
        targetLanguage,
        textLength: input.length,
      }
    );
    return {
      translated: cached,
      targetLanguage,
      fromCache: true,
    };
  }

  console.log(
    "[Translate] Cache Miss"
  );

  let translated;

  if (settings.translationProvider === "native") {
    if (settings.translationService !== "google") {
      throw new Error(`不支持的传统翻译服务：${settings.translationService}`);
    }

    translated = await requestGoogleTranslate({
      settings,
      input,
      targetLanguage,
    });
  } else {
    translated = await requestOpenAICompatibleAPI({
      settings,
      input,
      targetLanguage,
      forcedChineseMode,
      purpose: "translate",
    });
  }

  await setCachedTranslation(input, targetLanguage, translated, settings);

  return {
    translated,
    targetLanguage,
  };
}

/**
 * Google Translate API 集成
 * 使用 translate.googleapis.com 的 translate_a/single 端点
 * 语言代码映射：将应用内部语言名映射为 Google 的语言代码
 */
const GOOGLE_TRANSLATE_LANG_MAP = {
  Chinese: "zh-CN",
  English: "en",
  French: "fr",
  German: "de",
  Japanese: "ja",
  Korean: "ko",
  Russian: "ru",
};

// 构建 Google Translate API 请求 URL
// 参数：client=gtx（非官方客户端标识）, sl=auto（自动检测源语言）, dt=t（返回翻译文本）
function buildGoogleTranslateUrl(settings, targetLanguage, input) {
  const targetCode = GOOGLE_TRANSLATE_LANG_MAP[targetLanguage] || "zh-CN";
  const base = String(settings.googleTranslateBaseUrl || DEFAULT_SETTINGS.googleTranslateBaseUrl)
    .trim()
    .replace(/\/$/, "");

  const normalizedBase = base.endsWith("/translate_a/single")
    ? base
    : `${base}/translate_a/single`;

  const query = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: targetCode,
    dt: "t",
    q: input,
  });

  return `${normalizedBase}?${query.toString()}`;
}

// 发送 Google Translate 请求
// 使用 AbortController 实现超时控制
// 返回解析后的翻译文本字符串
async function requestGoogleTranslate({
  settings,
  input,
  targetLanguage,
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, settings.timeoutMs || 120000);

  try {
    const url = buildGoogleTranslateUrl(settings, targetLanguage, input);
    console.log(
      "[Google Translate] Request:",
      {
        targetLanguage,
        inputLength: input.length,
        inputPreview: input.slice(0, 100),
        url,
      }
    );

    const startTime = performance.now();
    const resp = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    const elapsed = Math.round(performance.now() - startTime);
    console.log(
      "[Google Translate] Response:",
      {
        status: resp.status,
        statusText: resp.statusText,
        elapsedMs: elapsed,
      }
    );

    if (!resp.ok) {
      const errorText = await resp.text();

      console.error(
        "[Google Translate] Error:",
        errorText
      );

      throw new Error(
        `Google 翻译请求失败：${errorText}`
      );
    }

    const data = await resp.json();
    console.log(
      "[Google Translate] Raw Result:",
      data
    );

    const translated =
      Array.isArray(data) && Array.isArray(data[0])
        ? data[0].map((seg) => seg?.[0] || "").join("")
        : "";
    console.log(
      "[Google Translate] Translation:",
      translated
    );

    if (typeof translated !== "string" || !translated.trim()) {
      throw new Error("Google 翻译返回为空或格式不正确");
    }

    return translated.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 工具函数
 */

// 安全转换为数值：空字符串返回回退值，非数字返回回退值
function coerceNumber(value, fallback) {
  const raw = String(value ?? "").trim();
  if (raw === "") return fallback;

  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// 安全转换为概率值：限制在 [0, 1] 范围内
function coerceProbability(value, fallback) {
  const n = coerceNumber(value, fallback);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// 文本预览：用于日志输出
function previewText(text) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 120);
}

// 构建 HTTP 请求头
// 包含 Content-Type、Authorization（如果有 API Key）和额外的自定义头
function buildRequestHeaders(settings) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (settings.apiKey) {
    headers[settings.apiKeyHeader || "Authorization"] = settings.apiKeyPrefix
      ? `${settings.apiKeyPrefix} ${settings.apiKey}`
      : settings.apiKey;
  }

  let extraHeaders = {};
  try {
    extraHeaders = JSON.parse(settings.extraHeaders || "{}");
  } catch {
    extraHeaders = {};
  }

  Object.assign(headers, extraHeaders);
  return headers;
}

// 构建 OpenAI 兼容 API 的请求体
// 根据 purpose 区分：test 模式发送简单 ping，translate 模式发送翻译指令
// 网页翻译模式（forcedChineseMode）使用中文系统提示，确保输出为中文
function buildChatBody({
  settings,
  input,
  targetLanguage,
  forcedChineseMode,
  purpose,
}) {
  const isTestMode = purpose === "test";

  // 系统提示词：测试模式要求原样返回哨兵值，翻译模式指示翻译行为
  const systemPrompt = isTestMode
    ? [
      "You are a connection test for an OpenAI-compatible chat API.",
      `Reply with exactly ${TEST_SENTINEL}.`,
      "Do not add any extra characters, punctuation, or whitespace.",
    ].join(" ")
    : forcedChineseMode
      ? [
        "你是一个网页翻译引擎。",
        "目标语言固定为中文。",
        "如果输入已经是中文则原样输出。",
        "请忠实自然地翻译。",
        "只输出翻译结果。",
      ].join(" ")
      : [
        "You are a professional translation engine.",
        `Translate the following text into ${targetLanguage}.`,
        "Output ONLY the translated text.",
      ].join(" ");

  const temperature = isTestMode
    ? 0
    : coerceProbability(settings.temperature, DEFAULT_SETTINGS.temperature);

  const topK = isTestMode ? 1 : coerceNumber(settings.topK, DEFAULT_SETTINGS.topK);

  const topP = isTestMode ? 0 : coerceProbability(settings.topP, DEFAULT_SETTINGS.topP);

  const maxTokens = isTestMode
    ? 8
    : Math.max(1, coerceNumber(settings.maxTokens, DEFAULT_SETTINGS.maxTokens));

  return {
    model: settings.modelName,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: isTestMode ? "Ping" : input,
      },
    ],
    temperature,
    top_k: topK,
    top_p: topP,
    max_tokens: maxTokens,
    stream: false,
    reasoning: {
      enabled: false,
    },
    thinking: {
      type: "disabled",
    },
    enable_thinking: false,
  };
}

/**
 * OpenAI 兼容 API 请求
 * 发送 POST 请求到 Chat Completions 端点，解析 choices[0].message.content
 * 支持超时控制、详细日志记录
 */
async function requestOpenAICompatibleAPI({
  settings,
  input,
  targetLanguage,
  forcedChineseMode,
  purpose = "translate",
}) {
  const effectiveSettings = normalizeSettings(settings);
  const headers = buildRequestHeaders(effectiveSettings);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, settings.timeoutMs || 120000);

  try {
    const base = settings.apiBaseUrl.replace(/\/$/, "");
    const path = settings.chatPath.startsWith("/")
      ? settings.chatPath
      : `/${settings.chatPath}`;

    const body = buildChatBody({
      settings,
      input,
      targetLanguage,
      forcedChineseMode,
      purpose,
    });
    const requestUrl = `${base}${path}`;
    console.log(
      "[LLM Translate] Request:",
      {
        url: requestUrl,
        model: settings.modelName,
        purpose,
        targetLanguage,
        forcedChineseMode,

        temperature: body.temperature,
        topK: body.top_k,
        topP: body.top_p,
        maxTokens: body.max_tokens,

        inputLength: input.length,
        inputPreview: input.slice(0, 100),

        headers: Object.keys(headers),
      }
    );

    const startTime = performance.now();
    const resp = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const elapsed = Math.round(performance.now() - startTime);
    console.log(
      "[LLM Translate] Response:",
      {
        status: resp.status,
        statusText: resp.statusText,
        elapsedMs: elapsed,
      }
    );

    if (!resp.ok) {
      const errorDetail = await resp.text();
      console.error(
        "[LLM Translate] Error:",
        errorDetail
      );

      if (purpose === "test") {
        throw new Error(`连接测试失败：${errorDetail}`);
      }
      throw new Error(`异常：${errorDetail}`);
    }

    const data = await resp.json();
    console.log(
      "[LLM Translate] Raw Result:",
      data
    );
    const content = data?.choices?.[0]?.message?.content;

    if (typeof content !== "string" || !content.trim()) {
      throw new Error(`连接测试失败：模型接口返回为空或格式不正确 ${content}`);
    }

    const normalized = content.trim();
    console.log(
      "[LLM Translate] Translation:",
      {
        outputLength: normalized.length,
        outputPreview: normalized.slice(0, 200),
      }
    );

    if (purpose === "test") {
      if (normalized !== TEST_SENTINEL) {
        throw new Error(
          `连接测试失败：模型接口返回了意外内容 "${previewText(normalized)}"`
        );
      }
      return normalized;
    }

    return normalized;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * API 连接测试
 * 发送 TEST_SENTINEL（"Ping"），验证返回结果是否完全匹配
 */
async function testOpenAICompatibleAPI(settings) {
  const result = await requestOpenAICompatibleAPI({
    settings,
    input: TEST_SENTINEL,
    targetLanguage: "English",
    forcedChineseMode: false,
    purpose: "test",
  });

  if (result !== TEST_SENTINEL) {
    throw new Error(
      `连接测试失败：模型接口返回结果不符合预期 "${previewText(result)}"`
    );
  }

  return result;
}

/**
 * 通用工具
 */

// 判断是否为纯中文文本（与 content_script.js 中的实现保持一致）
function isPureChineseText(text) {
  if (typeof text !== "string") return false;

  const compact = text.trim();
  if (!compact) return false;

  if (/[A-Za-z]/.test(compact)) return false;
  if (!/\p{Script=Han}/u.test(compact)) return false;

  try {
    return LangDetect.detect(compact) === "Chinese";
  } catch {
    return false;
  }
}