const inputText = document.getElementById("inputText");
const outputText = document.getElementById("outputText");
const translateBtn = document.getElementById("translateBtn");
const copyBtn = document.getElementById("copyBtn");
const sourceLang = document.getElementById("sourceLang");
const targetLang = document.getElementById("targetLang");
const metaInfo = document.getElementById("metaInfo");
const settingsIconBtn = document.getElementById("settingsIconBtn");

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

function langLabel(value) {
  const found = LANGS.find((l) => l.value === value);
  return found ? found.label : value;
}

function previewText(text) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 120);
}

function toNumberValue(value, fallback) {
  const raw = String(value ?? "").trim();
  if (raw === "") return fallback;

  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value, fallback) {
  const n = toNumberValue(value, fallback);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function populateLangSelects(defaultTarget) {
  sourceLang.innerHTML = "";
  targetLang.innerHTML = "";

  const autoOpt = document.createElement("option");
  autoOpt.value = "auto";
  autoOpt.textContent = "自动检测";
  sourceLang.appendChild(autoOpt);

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

async function loadSettings() {
  const raw = await chrome.storage.sync.get(null);
  return normalizeSettings(raw);
}

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

async function translateText(text, tgtLang) {
  const detectedLang = LangDetect.detect(text);
  const tgtLabel = langLabel(tgtLang);

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

async function init() {
  const settings = await loadSettings();
  populateLangSelects(settings.defaultTargetLanguage);
}

init();

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

copyBtn.addEventListener("click", async () => {
  const text = outputText.value || "";
  if (!text) return;
  await navigator.clipboard.writeText(text);
  copyBtn.textContent = "已复制";
  setTimeout(() => (copyBtn.textContent = "复制结果"), 1200);
});

settingsIconBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});