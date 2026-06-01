const DEFAULT_SETTINGS = {
  translationProvider: "native",
  translationService: "google",

  googleTranslateBaseUrl: "https://translate.googleapis.com",

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

const API_KEY_PLACEHOLDER = "sk-xxxx";
const SETTINGS_UI_INITIALIZED_KEY = "__settingsUiInitialized";

const els = {
  translationProvider: document.getElementById("translationProvider"),
  translationService: document.getElementById("translationService"),
  nativeSettingsGroup: document.getElementById("nativeSettingsGroup"),
  llmSettingsGroup: document.getElementById("llmSettingsGroup"),

  googleTranslateBaseUrl: document.getElementById("googleTranslateBaseUrl"),

  apiBaseUrl: document.getElementById("apiBaseUrl"),
  chatPath: document.getElementById("chatPath"),
  modelName: document.getElementById("modelName"),
  defaultTargetLanguage: document.getElementById("defaultTargetLanguage"),
  apiKey: document.getElementById("apiKey"),
  apiKeyHeader: document.getElementById("apiKeyHeader"),
  apiKeyPrefix: document.getElementById("apiKeyPrefix"),
  temperature: document.getElementById("temperature"),
  topK: document.getElementById("topK"),
  topP: document.getElementById("topP"),
  maxTokens: document.getElementById("maxTokens"),
  timeoutMs: document.getElementById("timeoutMs"),
  extraHeaders: document.getElementById("extraHeaders"),
  saveBtn: document.getElementById("saveBtn"),
  testBtn: document.getElementById("testBtn"),
  status: document.getElementById("status"),
};

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.className = isError ? "status error" : "status success";
}

function normalizeTextValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function bindDefaultFillBehavior(inputEl, defaultValue) {
  if (!inputEl) return;

  inputEl.placeholder = String(defaultValue);

  inputEl.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Tab") return;

      const currentValue = normalizeTextValue(inputEl.value);
      if (currentValue) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      inputEl.value = String(defaultValue);
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));

      const len = inputEl.value.length;
      try {
        inputEl.setSelectionRange(len, len);
      } catch {
        // 某些 input 类型不支持 setSelectionRange，忽略
      }
    },
    true
  );
}

function renderFieldValue(inputEl, savedValue, defaultValue, initialized) {
  if (!inputEl) return;

  inputEl.placeholder = String(defaultValue);

  const normalized = normalizeTextValue(savedValue);

  // 首次打开时，历史默认值显示成灰色占位；
  // 一旦用户点过保存，就按 storage 里的真实值显示。
  if (!initialized && normalized === String(defaultValue)) {
    inputEl.value = "";
    return;
  }

  inputEl.value = normalized;
}

function updateProviderUI() {
  const provider = els.translationProvider.value;

  if (provider === "native") {
    els.nativeSettingsGroup.style.display = "block";
    els.llmSettingsGroup.style.display = "none";
  } else {
    els.nativeSettingsGroup.style.display = "none";
    els.llmSettingsGroup.style.display = "block";
  }
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(null);
  const initialized = settings[SETTINGS_UI_INITIALIZED_KEY] === true;

  els.translationProvider.value =
    settings.translationProvider ?? DEFAULT_SETTINGS.translationProvider;

  els.translationService.value =
    settings.translationService ?? DEFAULT_SETTINGS.translationService;

  renderFieldValue(
    els.googleTranslateBaseUrl,
    settings.googleTranslateBaseUrl,
    DEFAULT_SETTINGS.googleTranslateBaseUrl,
    initialized
  );

  renderFieldValue(els.apiBaseUrl, settings.apiBaseUrl, DEFAULT_SETTINGS.apiBaseUrl, initialized);
  renderFieldValue(els.chatPath, settings.chatPath, DEFAULT_SETTINGS.chatPath, initialized);
  renderFieldValue(els.modelName, settings.modelName, DEFAULT_SETTINGS.modelName, initialized);
  renderFieldValue(
    els.apiKeyHeader,
    settings.apiKeyHeader,
    DEFAULT_SETTINGS.apiKeyHeader,
    initialized
  );
  renderFieldValue(
    els.apiKeyPrefix,
    settings.apiKeyPrefix,
    DEFAULT_SETTINGS.apiKeyPrefix,
    initialized
  );
  renderFieldValue(els.apiKey, settings.apiKey, API_KEY_PLACEHOLDER, initialized);
  renderFieldValue(
    els.extraHeaders,
    settings.extraHeaders,
    DEFAULT_SETTINGS.extraHeaders,
    initialized
  );
  renderFieldValue(els.timeoutMs, settings.timeoutMs, DEFAULT_SETTINGS.timeoutMs, initialized);

  els.defaultTargetLanguage.value =
    settings.defaultTargetLanguage ?? DEFAULT_SETTINGS.defaultTargetLanguage;

  renderFieldValue(
    els.temperature,
    settings.temperature,
    DEFAULT_SETTINGS.temperature,
    initialized
  );
  renderFieldValue(els.topK, settings.topK, DEFAULT_SETTINGS.topK, initialized);
  renderFieldValue(els.topP, settings.topP, DEFAULT_SETTINGS.topP, initialized);
  renderFieldValue(
    els.maxTokens,
    settings.maxTokens,
    DEFAULT_SETTINGS.maxTokens,
    initialized
  );

  bindDefaultFillBehavior(els.googleTranslateBaseUrl, DEFAULT_SETTINGS.googleTranslateBaseUrl);

  bindDefaultFillBehavior(els.apiBaseUrl, DEFAULT_SETTINGS.apiBaseUrl);
  bindDefaultFillBehavior(els.chatPath, DEFAULT_SETTINGS.chatPath);
  bindDefaultFillBehavior(els.modelName, DEFAULT_SETTINGS.modelName);
  bindDefaultFillBehavior(els.apiKeyHeader, DEFAULT_SETTINGS.apiKeyHeader);
  bindDefaultFillBehavior(els.apiKeyPrefix, DEFAULT_SETTINGS.apiKeyPrefix);
  bindDefaultFillBehavior(els.apiKey, API_KEY_PLACEHOLDER);
  bindDefaultFillBehavior(els.timeoutMs, DEFAULT_SETTINGS.timeoutMs);

  bindDefaultFillBehavior(els.temperature, DEFAULT_SETTINGS.temperature);
  bindDefaultFillBehavior(els.topK, DEFAULT_SETTINGS.topK);
  bindDefaultFillBehavior(els.topP, DEFAULT_SETTINGS.topP);
  bindDefaultFillBehavior(els.maxTokens, DEFAULT_SETTINGS.maxTokens);

  updateProviderUI();
}

function getSettingsFromUI() {
  return {
    translationProvider: els.translationProvider.value,
    translationService: els.translationService.value,

    googleTranslateBaseUrl: normalizeTextValue(els.googleTranslateBaseUrl.value),

    apiBaseUrl: normalizeTextValue(els.apiBaseUrl.value),
    chatPath: normalizeTextValue(els.chatPath.value),
    modelName: normalizeTextValue(els.modelName.value),
    defaultTargetLanguage: els.defaultTargetLanguage.value,
    apiKey: normalizeTextValue(els.apiKey.value),
    apiKeyHeader: normalizeTextValue(els.apiKeyHeader.value),
    apiKeyPrefix: normalizeTextValue(els.apiKeyPrefix.value),
    temperature: normalizeTextValue(els.temperature.value),
    topK: normalizeTextValue(els.topK.value),
    topP: normalizeTextValue(els.topP.value),
    maxTokens: normalizeTextValue(els.maxTokens.value),
    timeoutMs: normalizeTextValue(els.timeoutMs.value),
    extraHeaders: normalizeTextValue(els.extraHeaders.value),
  };
}

function validateSettings(settings) {
  // 空白代表“使用默认值”，所以允许直接保存。
  // 只有用户真的输入了内容，才校验格式和范围。
  if (settings.temperature !== "") {
    const n = Number(settings.temperature);
    if (Number.isNaN(n)) throw new Error("Temperature 必须是数字");
    if (n < 0 || n > 1) throw new Error("Temperature 必须在 0 到 1 之间");
  }

  if (settings.topK !== "") {
    const n = Number(settings.topK);
    if (Number.isNaN(n)) throw new Error("Top K 必须是数字");
    if (n < 0) throw new Error("Top K 不能小于 0");
  }

  if (settings.topP !== "") {
    const n = Number(settings.topP);
    if (Number.isNaN(n)) throw new Error("Top P 必须是数字");
    if (n < 0 || n > 1) throw new Error("Top P 必须在 0 到 1 之间");
  }

  if (settings.maxTokens !== "") {
    const n = Number(settings.maxTokens);
    if (Number.isNaN(n)) throw new Error("Max Tokens 必须是数字");
    if (n < 1) throw new Error("Max Tokens 不能小于 1");
  }

  if (settings.timeoutMs !== "") {
    const n = Number(settings.timeoutMs);
    if (Number.isNaN(n)) throw new Error("Request Timeout 必须是数字");
    if (n < 1000) throw new Error("Request Timeout 不能小于 1000");
  }

  if (settings.extraHeaders !== "") {
    try {
      JSON.parse(settings.extraHeaders);
    } catch {
      throw new Error("Additional Headers 必须是合法 JSON");
    }
  }
}

async function saveSettings() {
  try {
    const settings = getSettingsFromUI();
    validateSettings(settings);

    await chrome.storage.sync.set({
      ...settings,
      [SETTINGS_UI_INITIALIZED_KEY]: true,
    });

    setStatus("Settings saved");
    setTimeout(() => setStatus(""), 1200);
  } catch (err) {
    setStatus(err?.message || String(err), true);
  }
}

async function testConnection() {
  try {
    const settings = getSettingsFromUI();
    validateSettings(settings);

    setStatus("Testing connection...");

    const type =
      settings.translationProvider === "native"
        ? "TEST_GOOGLE_TRANSLATE"
        : "TEST_OPENAI_API";

    const resp = await chrome.runtime.sendMessage({
      type,
      settings,
    });

    if (!resp?.ok) {
      throw new Error(resp?.error || "Connection failed");
    }

    setStatus("Connection successful");
    setTimeout(() => setStatus(""), 1200);
  } catch (err) {
    setStatus(err?.message || String(err), true);
  }
}

els.saveBtn.addEventListener("click", saveSettings);
els.testBtn.addEventListener("click", testConnection);
els.translationProvider.addEventListener("change", updateProviderUI);

loadSettings();