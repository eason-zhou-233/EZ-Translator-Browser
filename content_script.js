const TRANSLATE_TARGET_LANGUAGE = "Chinese";
const MAX_CONCURRENT_TRANSLATIONS = 4;

let isTranslatingOperation = false;

/**
 * WeakMap<TextNode, History[]>
 * History:
 * {
 *   originalText,
 *   translatedText
 * }
 */
const translationHistoryMap = new WeakMap();

chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;

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

  if (message.type === "TRANSLATE_PAGE") {
    (async () => {
      try {
        const changedSegments = await translateCurrentPageInPlace();
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

  if (message.type === "RESTORE_PAGE") {
    (async () => {
      try {
        const restored = await restoreCurrentPage();
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

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

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

function shouldTranslateText(text) {
  return getSkipReason(text) === null;
}

function getSkipReason(text) {
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

function previewText(text) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 120);
}

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

function isPurePunctuationOrSymbols(text) {
  return /^[\p{P}\p{S}]+$/u.test(text);
}

function isLikelyEmail(text) {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(text);
}

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

function isLikelyDate(text) {
  const t = text.trim();

  const datePatterns = [
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/,
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[T\s]\d{1,2}:\d{2}(:\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?$/,
    /^\d{4}年\d{1,2}月(?:\d{1,2}[日号]?)?$/,
    /^\d{1,2}月(?:\d{1,2}[日号]?)?$/,
    /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/,
  ];

  return datePatterns.some((re) => re.test(t));
}

function isNumericLike(text) {
  const t = text.trim();
  if (!t) return false;

  return (
    /^[+\-−—]?(?:\p{N}|\d)[\p{N}\d,.\s:%/\\()（）￥$€£¥·+-]*$/u.test(t) &&
    !/[\p{L}\p{Script=Han}]/u.test(t)
  );
}

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

function getSelectionTextNodeSegments(range) {
  return collectTextNodeSegments(range.commonAncestorContainer, range);
}

function getPageTextNodeSegments(root) {
  return collectTextNodeSegments(root, null);
}

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

function isIgnoredElement(el) {
  if (!el?.tagName) return false;
  const tag = el.tagName.toUpperCase();
  return tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT";
}

function getPageTraversalRoot() {
  return document.body || document.documentElement;
}

function getAnchorHref(parentEl) {
  if (!parentEl) return null;
  const anchor = parentEl.closest("a");
  return anchor ? anchor.href : null;
}

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