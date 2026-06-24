// ============================================================
// 文件：content_script.js
// 功能：浏览器内容脚本，负责在网页中执行翻译和恢复操作
// 说明：
//   - 监听来自 service_worker 的消息，执行选区翻译/恢复、整页翻译/恢复
//   - 使用 TreeWalker 遍历页面文本节点，避免破坏 DOM 结构
//   - 通过 WeakMap 记录每个文本节点的翻译历史，支持撤销恢复
//   - 并发控制：最多同时发起 MAX_CONCURRENT_TRANSLATIONS 个翻译请求
//   - 智能跳过：自动跳过纯中文、纯标点、邮箱、URL、日期、纯数字等文本
//   - 子页面翻译：支持检测父页面的子页面标签，批量翻译并持久化
// ============================================================

// 翻译目标语言（固定为中文，用于网页内翻译）
const TRANSLATE_TARGET_LANGUAGE = "Chinese";
// 最大并发翻译请求数，避免同时发送过多请求
const MAX_CONCURRENT_TRANSLATIONS = 4;

// 翻译操作进行中标志，防止重复触发翻译
let isTranslatingOperation = false;

// 翻译持久化存储键前缀
const TRANSLATION_STORAGE_PREFIX = "ez_trans_persist_";

// 当前页面是否已被翻译过的标记
let isCurrentPageTranslated = false;

// 当前页面所属的父页面 URL（用于子页面识别）
let parentPageUrl = null;

/**
 * 翻译历史记录映射表
 * WeakMap<TextNode, History[]>
 * 使用 WeakMap 确保文本节点被移除时相关历史记录能被垃圾回收
 * History 结构:
 * {
 *   originalText: string,    // 原始文本
 *   translatedText: string   // 翻译后的文本
 * }
 */
const translationHistoryMap = new WeakMap();

// ----------------------------------------------------------
// 获取当前页面的标准化 URL（去除 hash 和 trailing slash）
// ----------------------------------------------------------
function getNormalizedPageUrl() {
  const url = new URL(window.location.href);
  url.hash = "";
  let pathname = url.pathname.replace(/\/$/, "");
  url.pathname = pathname;
  return url.href;
}

// ----------------------------------------------------------
// 获取翻译持久化的存储键
// ----------------------------------------------------------
function getTranslationStorageKey(url) {
  return `${TRANSLATION_STORAGE_PREFIX}${url}`;
}

// ----------------------------------------------------------
// 保存翻译状态到 chrome.storage.local
// 存储内容：{ translated: boolean, timestamp, url, parentUrl }
// translated=true 表示页面已翻译，translated=false 表示尚未翻译但属于已翻译父页面的子页面
// ----------------------------------------------------------
async function saveTranslationState(url, parentUrl, translated = true) {
  const key = getTranslationStorageKey(url);
  await chrome.storage.local.set({
    [key]: {
      translated: translated,
      timestamp: Date.now(),
      url: url,
      parentUrl: parentUrl || null,
    },
  });
}

// ----------------------------------------------------------
// 检查某个 URL 是否已被翻译
// ----------------------------------------------------------
async function isUrlTranslated(url) {
  const key = getTranslationStorageKey(url);
  const result = await chrome.storage.local.get(key);
  return !!(result[key]?.translated);
}

// ----------------------------------------------------------
// 从存储中删除翻译状态
// ----------------------------------------------------------
async function removeTranslationState(url) {
  const key = getTranslationStorageKey(url);
  await chrome.storage.local.remove(key);
}

// ----------------------------------------------------------
// 清除属于某个父页面的所有子页面翻译状态
// ----------------------------------------------------------
async function clearChildTranslationStates(parentUrl) {
  const allItems = await chrome.storage.local.get(null);
  const keysToRemove = [];

  for (const [key, value] of Object.entries(allItems)) {
    if (key.startsWith(TRANSLATION_STORAGE_PREFIX)) {
      if (value?.parentUrl === parentUrl || value?.url === parentUrl) {
        keysToRemove.push(key);
      }
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

// ----------------------------------------------------------
// 检测当前页面中所有子页面标签链接
// 子页面定义：<a> 标签的 href 以当前页面 URL 为前缀
// 即 href 是 currentUrl + 额外路径后缀
// 返回去重后的子页面 URL 数组
// ----------------------------------------------------------
function detectSubPageUrls() {
  const currentUrl = getNormalizedPageUrl();
  const currentUrlObj = new URL(currentUrl);
  const baseOrigin = currentUrlObj.origin;
  const basePath = currentUrlObj.pathname;

  const subPageUrls = new Set();
  const allAnchors = document.querySelectorAll("a[href]");

  for (const anchor of allAnchors) {
    try {
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
      if (href.startsWith("mailto:") || href.startsWith("tel:")) continue;

      // 解析为绝对 URL
      const absoluteUrl = new URL(href, window.location.href);
      absoluteUrl.hash = "";

      // 必须是同源的
      if (absoluteUrl.origin !== baseOrigin) continue;

      const absolutePath = absoluteUrl.pathname;
      const fullUrl = absoluteUrl.href;

      // 跳过当前页面自身
      if (fullUrl === currentUrl) continue;

      // 判断是否为子页面：路径以当前页面路径为前缀
      // 例如：当前页 /docs/guide，子页 /docs/guide/install
      // 注意：/docs/guide 不是 /docs 的子页面（没有共同前缀关系需要更多判断）
      const normalizedBasePath = basePath.replace(/\/$/, "");
      const normalizedAbsPath = absolutePath.replace(/\/$/, "");

      // 子页面判断：绝对路径以当前路径 + "/" 开头
      if (
        normalizedAbsPath !== normalizedBasePath &&
        normalizedAbsPath.startsWith(normalizedBasePath + "/")
      ) {
        subPageUrls.add(fullUrl);
      }
    } catch {
      // URL 解析失败，跳过
    }
  }

  return [...subPageUrls];
}

// ----------------------------------------------------------
// 页面加载时自动恢复翻译
// 检查当前 URL 是否在翻译状态存储中，如在则自动触发翻译
// 三种触发条件（满足任一即翻译）：
//   1. 当前 URL 被精确记录（translated=true 表示已翻译过，translated=false 表示预记录的子页面）
//   2. 当前 URL 的各级父路径中有在 24 小时内已翻译的页面
// ----------------------------------------------------------
async function autoRestoreTranslationIfNeeded() {
  // 防止在翻译操作进行中重复触发
  if (isTranslatingOperation) {
    console.log("[EZ Translator] 跳过自动恢复：翻译操作进行中");
    return;
  }

  const currentUrl = getNormalizedPageUrl();
  console.log("[EZ Translator] 检查是否需要自动翻译:", currentUrl);

  const allItems = await chrome.storage.local.get(null);
  let shouldRestore = false;
  let foundParentUrl = null;

  // 方法1：精确匹配当前 URL
  const currentKey = getTranslationStorageKey(currentUrl);
  const currentState = allItems[currentKey];

  if (currentState) {
    console.log("[EZ Translator] 找到精确匹配记录:", {
      translated: currentState.translated,
      timestamp: currentState.timestamp,
      parentUrl: currentState.parentUrl,
    });

    // 无论 translated 是 true 还是 false，都触发翻译
    // translated=true：页面曾被翻译过，DOM 已重置，需要重新翻译
    // translated=false：预记录的子页面，首次访问需要翻译
    shouldRestore = true;
    foundParentUrl = currentState.parentUrl || null;

    // 额外检查：如果 translated=true 且是最近 10 秒内翻译的（同一次页面加载），跳过
    // 避免翻译完成后立即再次触发
    if (currentState.translated === true && isCurrentPageTranslated) {
      const secondsSinceTranslation = (Date.now() - currentState.timestamp) / 1000;
      if (secondsSinceTranslation < 10) {
        console.log("[EZ Translator] 跳过自动恢复：近期已翻译过（同一页面加载）");
        return;
      }
    }
  }

  // 方法2：通过父路径查找（适用于未被精确记录的子页面）
  if (!shouldRestore) {
    const urlObj = new URL(currentUrl);
    const pathParts = urlObj.pathname.replace(/\/$/, "").split("/").filter(Boolean);

    console.log("[EZ Translator] 未精确匹配，尝试父路径查找，pathParts:", pathParts);

    for (let i = pathParts.length - 1; i >= 0; i--) {
      const parentPath = i === 0 ? "/" : "/" + pathParts.slice(0, i).join("/");
      const parentUrl = urlObj.origin + parentPath;
      const parentKey = getTranslationStorageKey(parentUrl);
      const parentState = allItems[parentKey];

      if (parentState?.translated === true) {
        const hoursSinceTranslation = (Date.now() - parentState.timestamp) / (1000 * 60 * 60);
        console.log("[EZ Translator] 找到已翻译父页面:", parentUrl, "距今:", hoursSinceTranslation.toFixed(1), "小时");
        if (hoursSinceTranslation < 24) {
          shouldRestore = true;
          foundParentUrl = parentUrl;
          break;
        }
      }
    }
  }

  if (!shouldRestore) {
    console.log("[EZ Translator] 无需自动翻译:", currentUrl);
    return;
  }

  console.log("[EZ Translator] 开始自动翻译:", currentUrl, "父页面:", foundParentUrl);
  parentPageUrl = foundParentUrl;

  try {
    await translateCurrentPageInPlace();
    // 翻译完成后更新状态为已翻译
    await saveTranslationState(currentUrl, foundParentUrl, true);
    isCurrentPageTranslated = true;
    console.log("[EZ Translator] 自动翻译完成:", currentUrl);
  } catch (err) {
    console.warn("[EZ Translator] 自动翻译失败:", err);
  }
}

// ----------------------------------------------------------
// 消息监听器：接收来自 service_worker 的翻译/恢复指令
// 使用可选链操作符 (?.) 确保在非扩展环境下不会报错
// 返回 true 表示异步响应，sendResponse 会在异步操作完成后调用
// ----------------------------------------------------------
chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;

  // 处理选区翻译请求
  if (message.type === "TRANSLATE_SELECTION") {
    (async () => {
      try {
        const changedSegments = await translateCurrentSelectionInPlace();
        sendResponse({
          ok: true,
          changedSegments,
        });
      } catch (err) {
        console.error("翻译选区失败:", err);
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();
    return true;
  }

  // 处理选区恢复请求：将翻译后的文本还原为原始文本
  if (message.type === "RESTORE_SELECTION") {
    (async () => {
      try {
        const restored = await restoreCurrentSelection();
        sendResponse({
          ok: true,
          restored,
        });
      } catch (err) {
        console.error("恢复原文本失败:", err);
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();
    return true;
  }

  // 处理整页翻译请求：翻译页面中所有可见文本，并保存翻译状态以便子页面自动恢复
  if (message.type === "TRANSLATE_PAGE") {
    (async () => {
      try {
        const currentUrl = getNormalizedPageUrl();
        const changedSegments = await translateCurrentPageInPlace();

        // 翻译完成后，保存当前页面翻译状态
        await saveTranslationState(currentUrl, null, true);
        // 检测子页面并预记录它们的 URL（标记为已翻译父页面的子页面，但尚未翻译）
        const subUrls = detectSubPageUrls();
        for (const subUrl of subUrls) {
          await saveTranslationState(subUrl, currentUrl, false);
        }
        console.log("[EZ Translator] 翻译完成，已记录", subUrls.length, "个待翻译子页面");

        sendResponse({
          ok: true,
          changedSegments,
        });
      } catch (err) {
        console.error("整页翻译失败:", err);
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();
    return true;
  }

  // 处理整页恢复请求：将页面所有翻译后的文本还原，并清除关联的翻译状态
  if (message.type === "RESTORE_PAGE") {
    (async () => {
      try {
        const currentUrl = getNormalizedPageUrl();
        const restored = await restoreCurrentPage();
        // 清除当前页面及所有子页面的翻译状态
        await clearChildTranslationStates(currentUrl);
        isCurrentPageTranslated = false;
        parentPageUrl = null;
        console.log("[EZ Translator] 恢复完成，已清除翻译状态");
        sendResponse({
          ok: true,
          restored,
        });
      } catch (err) {
        console.error("整页恢复失败:", err);
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

// ----------------------------------------------------------
// 恢复当前选区：将用户选中的翻译后文本还原为原始语言
// 遍历选区内的文本节点，调用 restoreTextNodeFromHistory 逐个恢复
// 返回恢复结果数组
// ----------------------------------------------------------
async function restoreCurrentSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return [];
  }

  const range = sel.getRangeAt(0);
  const segments = getSelectionTextNodeSegments(range);

  const restoredResults = [];
  const visited = new Set();

  for (const segment of segments) {
    const textNode = segment.textNode;
    if (!textNode || visited.has(textNode)) continue;
    visited.add(textNode);

    const restored = restoreTextNodeFromHistory(textNode, "selection");
    if (restored.length) {
      restoredResults.push(...restored);
    }
  }

  console.log("已恢复原文本:", restoredResults);
  return restoredResults;
}

// ----------------------------------------------------------
// 恢复整个页面：将页面中所有翻译后的文本还原为原始语言
// 遍历整个页面 body 中的文本节点，调用 restoreTextNodeFromHistory 逐个恢复
// ----------------------------------------------------------
async function restoreCurrentPage() {
  const root = getPageTraversalRoot();
  const segments = getPageTextNodeSegments(root);

  const restoredResults = [];
  const visited = new Set();

  for (const segment of segments) {
    const textNode = segment.textNode;
    if (!textNode || visited.has(textNode)) continue;
    visited.add(textNode);

    const restored = restoreTextNodeFromHistory(textNode, "page");
    if (restored.length) {
      restoredResults.push(...restored);
    }
  }

  console.log("已恢复整页原文本:", restoredResults);
  return restoredResults;
}

// ----------------------------------------------------------
// 从翻译历史中恢复单个文本节点
// 采用从后往前遍历历史记录的方式（后进先出），逐层还原文本
// 这样即使同一文本节点被多次翻译，也能正确恢复到最初状态
// scopeLabel: "selection" 或 "page"，用于日志标记
// ----------------------------------------------------------
function restoreTextNodeFromHistory(textNode, scopeLabel) {
  const histories = translationHistoryMap.get(textNode);
  if (!histories?.length) return [];

  let currentText = textNode.nodeValue || "";
  let changed = false;
  const restoredResults = [];

  for (let i = histories.length - 1; i >= 0; i--) {
    const history = histories[i];

    if (
      typeof history?.translatedText !== "string" ||
      typeof history?.originalText !== "string"
    ) {
      continue;
    }

    if (!currentText.includes(history.translatedText)) {
      continue;
    }

    currentText = currentText.replace(
      history.translatedText,
      history.originalText
    );

    changed = true;
    restoredResults.push({
      scope: scopeLabel,
      restoredText: history.originalText,
      translatedText: history.translatedText,
    });
  }

  if (changed) {
    textNode.nodeValue = currentText;
  }

  return restoredResults;
}

// ----------------------------------------------------------
// 原地翻译当前选区：将用户选中的文本翻译后直接替换到页面 DOM 中
// 核心流程：
//   1. 获取选区和其中的文本节点片段
//   2. 过滤掉不需要翻译的文本（纯中文、标点、邮箱等）
//   3. 将相同文本去重后分组，同一原文只翻译一次
//   4. 并发调用后台翻译，替换 DOM 文本节点内容
//   5. 记录翻译历史到 WeakMap，供后续恢复使用
// ----------------------------------------------------------
async function translateCurrentSelectionInPlace() {
  if (isTranslatingOperation) return null;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return null;
  }

  const range = sel.getRangeAt(0);
  const selectedText = sel.toString();

  if (!selectedText || !selectedText.trim()) {
    return null;
  }

  const segments = getSelectionTextNodeSegments(range);
  if (!segments.length) return null;

  isTranslatingOperation = true;

  try {
    const changedSegments = [];
    const textGroups = new Map();

    for (const segment of segments) {
      const skipReason = getSkipReason(segment.selectedPart);

      if (skipReason) {
        console.info("[Translator] skipped segment", {
          scope: "selection",
          reason: skipReason,
          text: previewText(segment.selectedPart),
          tag: segment.parentEl ? segment.parentEl.tagName.toLowerCase() : null,
          path: segment.parentEl ? buildDomPath(segment.parentEl) : null,
        });
        continue;
      }

      const text = segment.selectedPart;
      if (!textGroups.has(text)) {
        textGroups.set(text, []);
      }
      textGroups.get(text).push(segment);
    }

    const translationCache = new Map();
    const uniqueTexts = [...textGroups.keys()];

    const tasks = uniqueTexts.map((text) => async () => {
      const translated = await getTranslationWithCache(text, translationCache, "selection");
      if (typeof translated !== "string" || !translated.length) return;

      const relatedSegments = textGroups.get(text) || [];

      for (const segment of relatedSegments) {
        const { textNode, start, end, selectedPart, parentEl } = segment;
        const originalText = textNode.nodeValue || "";

        if (!originalText || start < 0 || end > originalText.length || end <= start) {
          continue;
        }

        textNode.nodeValue =
          originalText.slice(0, start) +
          translated +
          originalText.slice(end);

        const historyList = translationHistoryMap.get(textNode) || [];
        historyList.push({
          originalText: selectedPart,
          translatedText: translated,
        });
        translationHistoryMap.set(textNode, historyList);

        changedSegments.push({
          originalText: selectedPart,
          translatedText: translated,
          skipped: false,
          tag: parentEl ? parentEl.tagName.toLowerCase() : null,
          href: getAnchorHref(parentEl),
          path: parentEl ? buildDomPath(parentEl) : null,
        });
      }

      await nextFrame();
    });

    await runWithConcurrencyLimit(tasks, MAX_CONCURRENT_TRANSLATIONS);

    for (const segment of segments) {
      const skipReason = getSkipReason(segment.selectedPart);
      if (!skipReason) continue;

      changedSegments.push({
        originalText: segment.selectedPart,
        translatedText: segment.selectedPart,
        skipped: true,
        reason: skipReason,
        tag: segment.parentEl ? segment.parentEl.tagName.toLowerCase() : null,
        href: getAnchorHref(segment.parentEl),
        path: segment.parentEl ? buildDomPath(segment.parentEl) : null,
      });
    }

    sel.removeAllRanges();

    console.log("已翻译并替换选区:", changedSegments);
    return changedSegments;
  } finally {
    isTranslatingOperation = false;
  }
}

// ----------------------------------------------------------
// 原地翻译整个页面：遍历页面中所有可见文本节点并翻译替换
// 与 translateCurrentSelectionInPlace 流程类似，但作用范围为整个页面 body
// 同样支持文本去重、并发翻译和历史记录
// ----------------------------------------------------------
async function translateCurrentPageInPlace() {
  if (isTranslatingOperation) return null;

  const root = getPageTraversalRoot();
  const segments = getPageTextNodeSegments(root);

  if (!segments.length) return null;

  isTranslatingOperation = true;

  try {
    const changedSegments = [];
    const textGroups = new Map();

    for (const segment of segments) {
      const skipReason = getSkipReason(segment.selectedPart);

      if (skipReason) {
        console.info("[Translator] skipped segment", {
          scope: "page",
          reason: skipReason,
          text: previewText(segment.selectedPart),
          tag: segment.parentEl ? segment.parentEl.tagName.toLowerCase() : null,
          path: segment.parentEl ? buildDomPath(segment.parentEl) : null,
        });
        continue;
      }

      const text = segment.selectedPart;
      if (!textGroups.has(text)) {
        textGroups.set(text, []);
      }
      textGroups.get(text).push(segment);
    }

    const translationCache = new Map();
    const uniqueTexts = [...textGroups.keys()];

    const tasks = uniqueTexts.map((text) => async () => {
      const translated = await getTranslationWithCache(text, translationCache, "page");
      if (typeof translated !== "string" || !translated.length) return;

      const relatedSegments = textGroups.get(text) || [];

      for (const segment of relatedSegments) {
        const { textNode, start, end, selectedPart, parentEl } = segment;
        const originalText = textNode.nodeValue || "";

        if (!originalText || start < 0 || end > originalText.length || end <= start) {
          continue;
        }

        textNode.nodeValue =
          originalText.slice(0, start) +
          translated +
          originalText.slice(end);

        const historyList = translationHistoryMap.get(textNode) || [];
        historyList.push({
          originalText: selectedPart,
          translatedText: translated,
        });
        translationHistoryMap.set(textNode, historyList);

        changedSegments.push({
          originalText: selectedPart,
          translatedText: translated,
          skipped: false,
          tag: parentEl ? parentEl.tagName.toLowerCase() : null,
          href: getAnchorHref(parentEl),
          path: parentEl ? buildDomPath(parentEl) : null,
        });
      }

      await nextFrame();
    });

    await runWithConcurrencyLimit(tasks, MAX_CONCURRENT_TRANSLATIONS);

    for (const segment of segments) {
      const skipReason = getSkipReason(segment.selectedPart);
      if (!skipReason) continue;

      changedSegments.push({
        originalText: segment.selectedPart,
        translatedText: segment.selectedPart,
        skipped: true,
        reason: skipReason,
        tag: segment.parentEl ? segment.parentEl.tagName.toLowerCase() : null,
        href: getAnchorHref(segment.parentEl),
        path: segment.parentEl ? buildDomPath(segment.parentEl) : null,
      });
    }

    console.log("已翻译整页并替换:", changedSegments);
    return changedSegments;
  } finally {
    isTranslatingOperation = false;
  }
}

// ----------------------------------------------------------
// 带缓存的翻译获取：先查内存缓存 Map，未命中则调用后台翻译
// 支持去重防抖：如果同一个文本正在翻译中，返回同一个 Promise
// 避免对相同文本发起重复请求
// ----------------------------------------------------------
async function getTranslationWithCache(text, cacheMap, translationMode) {
  const cached = cacheMap.get(text);

  if (typeof cached === "string") {
    return cached;
  }

  if (cached && typeof cached.then === "function") {
    return cached;
  }

  const pendingPromise = translateTextViaBackground(text, translationMode)
    .then((translated) => {
      cacheMap.set(text, translated);
      return translated;
    })
    .catch((err) => {
      cacheMap.delete(text);
      throw err;
    });

  cacheMap.set(text, pendingPromise);
  return pendingPromise;
}

// ----------------------------------------------------------
// 等待下一帧：使用 requestAnimationFrame 返回 Promise
// 用于在批量 DOM 更新之间让浏览器有时间渲染，避免页面卡顿
// ----------------------------------------------------------
function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

// ----------------------------------------------------------
// 并发控制执行器：限制同时执行的任务数量
// 创建 limit 个 worker，每个 worker 循环取下一个任务执行
// 适用于控制翻译 API 的并发请求数，避免触发速率限制
// ----------------------------------------------------------
async function runWithConcurrencyLimit(tasks, limit) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;

  const workerCount = Math.max(1, Math.min(limit || 1, tasks.length));
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= tasks.length) break;

      const task = tasks[currentIndex];
      try {
        await task();
      } catch (err) {
        console.warn("翻译任务失败:", err);
      }
    }
  });

  await Promise.all(workers);
}

// ----------------------------------------------------------
// 判断文本是否需要翻译：当 getSkipReason 返回 null 时需要翻译
// ----------------------------------------------------------
function shouldTranslateText(text) {
  return getSkipReason(text) === null;
}

// ----------------------------------------------------------
// 获取跳过翻译的原因
// 按优先级依次检查：空文本 > 纯中文 > 纯标点符号 > 邮箱 > URL > 日期 > 纯数字
// 返回 null 表示该文本需要翻译，否则返回跳过原因字符串
// ----------------------------------------------------------
function getSkipReason(text) {
  // 去除空白后的紧凑文本
  const compact = typeof text === "string" ? text.trim().replace(/\s+/g, "") : "";

  if (!compact) return "empty";
  if (isPureChineseText(compact)) return "pure_chinese";
  if (isPurePunctuationOrSymbols(compact)) return "pure_punctuation_or_symbols";
  if (isLikelyEmail(compact)) return "email";
  if (isLikelyUrl(compact)) return "url";
  if (isLikelyDate(compact)) return "date";
  if (isNumericLike(compact)) return "numeric";

  return null;
}

// ----------------------------------------------------------
// 文本预览：将换行等空白统一为空格，截取前 120 个字符
// 用于日志输出，避免打印过长的文本内容
// ----------------------------------------------------------
function previewText(text) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 120);
}

// ----------------------------------------------------------
// 判断是否为纯中文文本
// 检查逻辑：不含英文字母 + 包含汉字 + LangDetect 确认为中文
// ----------------------------------------------------------
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

// ----------------------------------------------------------
// 判断是否为纯标点或符号文本（使用 Unicode 属性转义）
// \p{P} 匹配所有标点，\p{S} 匹配所有符号
// ----------------------------------------------------------
function isPurePunctuationOrSymbols(text) {
  return /^[\p{P}\p{S}]+$/u.test(text);
}

// ----------------------------------------------------------
// 判断是否可能为邮箱地址
// 匹配标准邮箱格式：name@domain.tld
// ----------------------------------------------------------
function isLikelyEmail(text) {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(text);
}

// ----------------------------------------------------------
// 判断是否可能为 URL
// 检测逻辑：
//   1. 匹配标准协议 URL（http/https/ftp/file）
//   2. 匹配 www 开头的 URL
//   3. 使用 URL 构造函数试探解析，验证域名格式和点号数量
// 注意：会先去除文本首尾的引号、括号等包裹字符
// ----------------------------------------------------------
function isLikelyUrl(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;

  const cleaned = t.replace(/^[('"“<\[]+|[)'”>\].,;:!?]+$/g, "");
  if (!cleaned) return false;

  if (/^(https?|ftp|file):\/\/[^\s/$.?#].[^\s]*$/i.test(cleaned)) {
    return true;
  }

  if (/^www\.[^\s/$.?#].[^\s]*$/i.test(cleaned)) {
    return true;
  }

  try {
    const normalized = `https://${cleaned}`;
    const url = new URL(normalized);
    const host = url.hostname;
    if (!host || !host.includes(".")) return false;
    if (!/^[a-z0-9.-]+$/i.test(host)) return false;

    const hasPathOrQueryOrHash =
      (url.pathname && url.pathname !== "/") || url.search || url.hash;

    const dotCount = (host.match(/\./g) || []).length;
    if (dotCount === 1 && !hasPathOrQueryOrHash) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------
// 判断是否可能为日期字符串
// 支持多种日期格式：ISO 8601、中文日期、数字日期
// ----------------------------------------------------------
function isLikelyDate(text) {
  const t = text.trim();

  // 日期匹配模式数组：ISO格式、ISO日期时间、中文年月日、中文月日、数字日期
  const datePatterns = [
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/,
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[T\s]\d{1,2}:\d{2}(:\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?$/,
    /^\d{4}年\d{1,2}月(?:\d{1,2}[日号]?)?$/,
    /^\d{1,2}月(?:\d{1,2}[日号]?)?$/,
    /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/,
  ];

  return datePatterns.some((re) => re.test(t));
}

// ----------------------------------------------------------
// 判断是否看起来像数字/数值类文本
// 匹配包含数字、货币符号、百分比、数学符号等但不含字母或汉字的文本
// ----------------------------------------------------------
function isNumericLike(text) {
  const t = text.trim();
  if (!t) return false;

  return (
    /^[+\-−—]?(?:\p{N}|\d)[\p{N}\d,.\s:%/\\()（）￥$€£¥·+-]*$/u.test(t) &&
    !/[\p{L}\p{Script=Han}]/u.test(t)
  );
}

// ----------------------------------------------------------
// 通过后台 Service Worker 翻译文本
// 使用 chrome.runtime.sendMessage 发送翻译请求到 service_worker
// 这是 content_script 与后台通信的唯一翻译通道
// ----------------------------------------------------------
function translateTextViaBackground(text, translationMode) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "TRANSLATE_TEXT",
        text,
        targetLanguage: TRANSLATE_TARGET_LANGUAGE,
        translationMode,
      },
      (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }

        if (!response?.ok) {
          reject(new Error(response?.error || "翻译失败"));
          return;
        }

        resolve(response.translated);
      }
    );
  });
}

// ----------------------------------------------------------
// 获取选区内所有文本节点片段
// 以 range.commonAncestorContainer 为遍历起点
// ----------------------------------------------------------
function getSelectionTextNodeSegments(range) {
  return collectTextNodeSegments(range.commonAncestorContainer, range);
}

// ----------------------------------------------------------
// 获取页面内所有文本节点片段（不限选区范围）
// ----------------------------------------------------------
function getPageTextNodeSegments(root) {
  return collectTextNodeSegments(root, null);
}

// ----------------------------------------------------------
// 使用 TreeWalker 收集文本节点片段
// 这是避免破坏 DOM 结构的关键：只遍历文本节点，不触碰元素节点
// range 参数为 null 时收集所有文本节点，否则仅收集与选区相交的节点
// ----------------------------------------------------------
function collectTextNodeSegments(startNode, range) {
  const root =
    startNode && startNode.nodeType === Node.DOCUMENT_NODE
      ? startNode.documentElement
      : startNode?.nodeType === Node.ELEMENT_NODE
        ? startNode
        : document.body || document.documentElement;

  if (!root) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue || "";
      if (!text.trim()) return NodeFilter.FILTER_REJECT;

      const parentEl = node.parentElement;
      if (!parentEl) return NodeFilter.FILTER_REJECT;

      if (isIgnoredElement(parentEl)) return NodeFilter.FILTER_REJECT;

      if (range) {
        try {
          return range.intersectsNode(node)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        } catch {
          return NodeFilter.FILTER_REJECT;
        }
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const segments = [];
  const seen = new Set();

  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const parentEl = textNode.parentElement;
    if (!parentEl) continue;

    const fullText = textNode.nodeValue || "";
    let start = 0;
    let end = fullText.length;

    if (range) {
      const bounds = getSelectedBoundsInTextNode(textNode, range);
      if (!bounds) continue;
      start = bounds.start;
      end = bounds.end;
    }

    const selectedPart = fullText.slice(start, end);
    if (!selectedPart.trim()) continue;

    const key = `${buildDomPath(parentEl)}::${start}-${end}::${selectedPart}`;
    if (seen.has(key)) continue;
    seen.add(key);

    segments.push({
      textNode,
      parentEl,
      start,
      end,
      selectedPart,
    });
  }

  return segments;
}

// ----------------------------------------------------------
// 获取选区在指定文本节点中的起止偏移量
// 返回 { start, end } 或 null（当文本节点不在选区内时）
// ----------------------------------------------------------
function getSelectedBoundsInTextNode(textNode, range) {
  const fullText = textNode.nodeValue || "";
  if (!fullText) return null;

  try {
    if (!range.intersectsNode(textNode)) {
      return null;
    }
  } catch {
    return null;
  }

  let start = 0;
  let end = fullText.length;

  if (textNode === range.startContainer && textNode.nodeType === Node.TEXT_NODE) {
    start = range.startOffset;
  }

  if (textNode === range.endContainer && textNode.nodeType === Node.TEXT_NODE) {
    end = range.endOffset;
  }

  if (start < 0) start = 0;
  if (end > fullText.length) end = fullText.length;
  if (end <= start) return null;

  return { start, end };
}

// ----------------------------------------------------------
// 判断元素是否应被忽略（不遍历其内部的文本节点）
// SCRIPT、STYLE、NOSCRIPT 标签内的文本不是用户可见内容
// ----------------------------------------------------------
function isIgnoredElement(el) {
  if (!el?.tagName) return false;
  const tag = el.tagName.toUpperCase();
  return tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT";
}

// ----------------------------------------------------------
// 获取页面遍历的根节点：优先使用 document.body
// ----------------------------------------------------------
function getPageTraversalRoot() {
  return document.body || document.documentElement;
}

// ----------------------------------------------------------
// 获取父元素最近的 <a> 链接的 href 属性
// 用于日志中记录翻译文本所属的超链接
// ----------------------------------------------------------
function getAnchorHref(parentEl) {
  if (!parentEl) return null;
  const anchor = parentEl.closest("a");
  return anchor ? anchor.href : null;
}

// ----------------------------------------------------------
// 构建元素的 DOM 路径字符串
// 格式示例：body > div.content > p:nth-of-type(2) > span#title
// 包含 id、class（最多2个）、nth-of-type 索引，用于定位和日志
// ----------------------------------------------------------
function buildDomPath(el) {
  const parts = [];
  let current = el;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let part = current.tagName.toLowerCase();

    if (current.id) {
      part += `#${current.id}`;
      parts.unshift(part);
      break;
    }

    if (current.classList && current.classList.length > 0) {
      part += "." + Array.from(current.classList).slice(0, 2).join(".");
    }

    const parent = current.parentElement;
    if (parent) {
      const sameTagSiblings = Array.from(parent.children).filter(
        (child) => child.tagName === current.tagName
      );
      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(part);
    current = current.parentElement;
  }

  return parts.join(" > ");
}

// ----------------------------------------------------------
// SPA 路由变化检测
// 许多现代网站使用 History API 或 hash 实现客户端路由
// 当 URL 变化但页面不刷新时，需要重新检查是否需要翻译
// 使用多重策略确保捕获所有导航方式：
//   1. popstate / hashchange 事件
//   2. 拦截 history.pushState / replaceState
//   3. 定时轮询 URL 变化（兜底方案，捕获 location 直接赋值等）
// ----------------------------------------------------------
let lastCheckedUrl = getNormalizedPageUrl();

// 防抖：避免短时间内多次触发翻译检查
let spaRouteCheckTimer = null;
const SPA_ROUTE_CHECK_DELAY = 800;

// URL 轮询间隔（兜底方案）
const URL_POLL_INTERVAL = 1000;
let urlPollIntervalId = null;

/**
 * SPA 路由变化时的处理：检查 URL 是否变化，若是则尝试恢复翻译
 */
function handleSpaRouteChange() {
  const currentUrl = getNormalizedPageUrl();
  if (currentUrl === lastCheckedUrl) return;

  console.log("[EZ Translator] URL 变化检测:", lastCheckedUrl, "→", currentUrl);

  // URL 已变化，重置状态
  lastCheckedUrl = currentUrl;
  isCurrentPageTranslated = false;
  parentPageUrl = null;

  // 清除之前的定时器，实现防抖
  if (spaRouteCheckTimer) clearTimeout(spaRouteCheckTimer);

  spaRouteCheckTimer = setTimeout(() => {
    console.log("[EZ Translator] SPA 路由变化，触发自动翻译:", currentUrl);
    autoRestoreTranslationIfNeeded().catch((err) => {
      console.warn("[EZ Translator] SPA 路由自动翻译失败:", err);
    });
  }, SPA_ROUTE_CHECK_DELAY);
}

// ----------------------------------------------------------
// 页面加载完成后自动检测并恢复翻译状态
// 同时设置 SPA 路由变化监听
// ----------------------------------------------------------
(function initAutoRestore() {
  // 监听 popstate 事件（浏览器前进/后退按钮）
  window.addEventListener("popstate", () => {
    console.log("[EZ Translator] popstate 事件触发");
    handleSpaRouteChange();
  });

  // 监听 hashchange 事件（hash 路由变化）
  window.addEventListener("hashchange", () => {
    console.log("[EZ Translator] hashchange 事件触发");
    handleSpaRouteChange();
  });

  // 拦截 history.pushState 和 history.replaceState（JS 触发的路由变化）
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    console.log("[EZ Translator] history.pushState 拦截:", args);
    handleSpaRouteChange();
    return result;
  };

  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    console.log("[EZ Translator] history.replaceState 拦截:", args);
    handleSpaRouteChange();
    return result;
  };

  // 定时轮询 URL 变化（兜底：捕获 location.href 直接赋值等绕过 History API 的导航）
  urlPollIntervalId = setInterval(() => {
    handleSpaRouteChange();
  }, URL_POLL_INTERVAL);

  // 初始加载时执行一次自动恢复
  function doInitialCheck() {
    lastCheckedUrl = getNormalizedPageUrl();
    console.log("[EZ Translator] 初始加载检查:", lastCheckedUrl);
    autoRestoreTranslationIfNeeded().catch((err) => {
      console.warn("[EZ Translator] 自动恢复初始化失败:", err);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(doInitialCheck, 800);
    });
  } else {
    setTimeout(doInitialCheck, 800);
  }
})();