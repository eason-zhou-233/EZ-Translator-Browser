// ============================================================
// 文件：popup.js
// 功能：弹出窗口的交互逻辑
// 说明：
//   - 管理源语言/目标语言选择下拉框
//   - 调用 LangDetect 自动检测输入文本语言
//   - 通过 chrome.runtime.sendMessage 发送翻译请求到 Service Worker
//   - 支持一键复制翻译结果
//   - 加载用户保存的默认目标语言设置
// ============================================================

// DOM 元素引用
const inputText = document.getElementById("inputText");
const outputText = document.getElementById("outputText");
const translateBtn = document.getElementById("translateBtn");
const copyBtn = document.getElementById("copyBtn");
const sourceLang = document.getElementById("sourceLang");
const targetLang = document.getElementById("targetLang");
const metaInfo = document.getElementById("metaInfo");
const settingsIconBtn = document.getElementById("settingsIconBtn");

// 默认设置（作为回退值）
const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://localhost:1234",
  chatPath: "/v1/chat/completions",
  modelName: "hy-mt2-1.8b",
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

// 支持的语言列表（auto 仅用于源语言）
const LANGS = [
  { value: "auto", label: "自动检测" },
  { value: "Chinese", label: "中文" },
  { value: "English", label: "English" },
  { value: "French", label: "Français" },
  { value: "German", label: "Deutsch" },
  { value: "Japanese", label: "日本語" },
  { value: "Korean", label: "한국어" },
  { value: "Russian", label: "Русский" },
];

// 根据语言代码获取显示标签
function langLabel(value) {
  const found = LANGS.find((l) => l.value === value);
  return found ? found.label : value;
}

// 文本预览：统一空白并截断，用于调试日志
function previewText(text) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 120);
}

// 安全转换为数值，空值返回回退值
function toNumberValue(value, fallback) {
  const raw = String(value ?? "").trim();
  if (raw === "") return fallback;

  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// 将值限制在 [0, 1] 范围内
function clamp01(value, fallback) {
  const n = toNumberValue(value, fallback);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// 填充语言选择下拉框
// 源语言包含 "自动检测" 选项，目标语言不包含
// defaultTarget: 从设置中读取的默认目标语言
function populateLangSelects(defaultTarget) {
  sourceLang.innerHTML = "";
  targetLang.innerHTML = "";

  // 源语言：添加自动检测选项
  const autoOpt = document.createElement("option");
  autoOpt.value = "auto";
  autoOpt.textContent = "自动检测";
  sourceLang.appendChild(autoOpt);

  // 目标语言：不包含 auto 选项
  for (const l of LANGS) {
    if (l.value !== "auto") {
      const opt = document.createElement("option");
      opt.value = l.value;
      opt.textContent = l.label;
      targetLang.appendChild(opt);
    }
  }

  sourceLang.value = "auto";
  targetLang.value = defaultTarget || "Chinese";
}

// 规范化设置对象：空值使用默认值填充，确保所有字段都有有效值
function normalizeSettings(raw = {}) {
  const textOrDefault = (value, fallback) => {
    const normalized = String(value ?? "").trim();
    return normalized === "" ? fallback : normalized;
  };

  return {
    apiBaseUrl: textOrDefault(raw.apiBaseUrl, DEFAULT_SETTINGS.apiBaseUrl),
    chatPath: textOrDefault(raw.chatPath, DEFAULT_SETTINGS.chatPath),
    modelName: textOrDefault(raw.modelName, DEFAULT_SETTINGS.modelName),
    apiKey: String(raw.apiKey ?? "").trim(),
    apiKeyHeader: textOrDefault(raw.apiKeyHeader, DEFAULT_SETTINGS.apiKeyHeader),
    apiKeyPrefix: textOrDefault(raw.apiKeyPrefix, DEFAULT_SETTINGS.apiKeyPrefix),
    temperature: textOrDefault(raw.temperature, DEFAULT_SETTINGS.temperature),
    topK: textOrDefault(raw.topK, DEFAULT_SETTINGS.topK),
    topP: textOrDefault(raw.topP, DEFAULT_SETTINGS.topP),
    maxTokens: textOrDefault(raw.maxTokens, DEFAULT_SETTINGS.maxTokens),
    timeoutMs: textOrDefault(raw.timeoutMs, DEFAULT_SETTINGS.timeoutMs),
    extraHeaders: textOrDefault(raw.extraHeaders, DEFAULT_SETTINGS.extraHeaders),
    defaultTargetLanguage: textOrDefault(
      raw.defaultTargetLanguage,
      DEFAULT_SETTINGS.defaultTargetLanguage
    ),
  };
}

// 从 chrome.storage.sync 加载设置并规范化
async function loadSettings() {
  const raw = await chrome.storage.sync.get(null);
  return normalizeSettings(raw);
}

// 封装 chrome.runtime.sendMessage 为 Promise
// 处理 chrome.runtime.lastError 异常情况
function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// 翻译文本的核心函数
// 1. 先用 LangDetect 检测源语言
// 2. 如果源语言与目标语言相同，直接返回原文
// 3. 否则通过 Service Worker 发送翻译请求
// 返回 { detectedLang, translatedText, sameLanguage }
async function translateText(text, tgtLang) {
  const detectedLang = LangDetect.detect(text);
  const tgtLabel = langLabel(tgtLang);

  // 源语言与目标语言相同时，无需翻译
  if (detectedLang && detectedLang === tgtLang) {
    return {
      detectedLang: LangDetect.getNativeName(detectedLang),
      translatedText: text,
      sameLanguage: true,
    };
  }

  const resp = await sendRuntimeMessage({
    type: "TRANSLATE_TEXT",
    text,
    targetLanguage: tgtLang,
    translationMode: "popup",
  });

  if (!resp?.ok) {
    throw new Error(resp?.error || "翻译失败");
  }

  return {
    detectedLang: detectedLang ? LangDetect.getNativeName(detectedLang) : "",
    translatedText: resp.translated || text,
    sameLanguage: false,
  };
}

// 初始化：加载设置并填充语言选择框
async function init() {
  const settings = await loadSettings();
  populateLangSelects(settings.defaultTargetLanguage);
}

init();

// 翻译按钮点击事件
// 流程：检测语言 → 判断是否需要翻译 → 调用 API → 显示结果
translateBtn.addEventListener("click", async () => {
  const text = inputText.value.trim();
  if (!text) {
    outputText.value = "";
    metaInfo.textContent = "自动识别待翻译文本语言类型";
    return;
  }

  translateBtn.disabled = true;
  translateBtn.textContent = "翻译中...";

  try {
    const tgt = targetLang.value;
    const tgtLabel = langLabel(tgt);
    const { detectedLang, translatedText: result, sameLanguage } = await translateText(text, tgt);

    if (sameLanguage) {
      outputText.value = text;
      metaInfo.textContent = `原文本已是${detectedLang || tgtLabel}，无需翻译`;
    } else {
      outputText.value = result;
      const srcLabel = detectedLang || "未知";
      metaInfo.textContent = `已从${srcLabel}翻译为${tgtLabel}`;
    }
  } catch (err) {
    outputText.value = `错误：${err.message}`;
    metaInfo.textContent = "翻译失败";
  } finally {
    translateBtn.disabled = false;
    translateBtn.textContent = "翻译";
  }
});

// 复制按钮点击事件：将翻译结果写入剪贴板
// 复制成功后按钮文字变为"已复制"，1.2 秒后恢复
copyBtn.addEventListener("click", async () => {
  const text = outputText.value || "";
  if (!text) return;
  await navigator.clipboard.writeText(text);
  copyBtn.textContent = "已复制";
  setTimeout(() => (copyBtn.textContent = "复制结果"), 1200);
});

// 设置按钮点击事件：打开扩展的设置页面
settingsIconBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});