// ============================================================
// 语言检测模块 - 纯 JavaScript，零依赖
// 使用 Unicode 范围 + 常见词匹配，支持 7 种语言
// ============================================================

(function () {
  "use strict";

  const LANG_INFO = {
    Chinese:  { label: "中文",      native: "中文" },
    English:  { label: "English",  native: "English" },
    French:   { label: "Français", native: "Français" },
    German:   { label: "Deutsch",  native: "Deutsch" },
    Japanese: { label: "日本語",    native: "日本語" },
    Korean:   { label: "한국어",    native: "한국어" },
    Russian:  { label: "Русский",  native: "Русский" },
  };

  // ---- 拉丁语系常见词（用于区分 English / French / German） ----
  const MARKER_WORDS = {
    French: [
      // 冠词 / 代词 / 介词（高频基础词）
      "je", "tu", "il", "elle", "on", "ce", "ça", "de", "du", "un",
      "le", "la", "les", "des", "aux", "en", "y", "me", "te", "se",
      "ne", "lui", "leur", "eux", "moi", "toi", "soi", "dont",
      // 动词高频形式
      "est", "sont", "été", "être", "avoir", "fait", "faire", "peut",
      "dit", "dire", "voir", "sait", "aller", "vient", "veut", "doit",
      "suis", "es", "sommes", "êtes", "ai", "a", "as", "avons", "avez", "ont",
      "aime", "aimer", "parle", "parler", "mange", "manger", "prendre",
      "donne", "donner", "trouve", "trouver", "pense", "penser",
      // 连词 / 副词 / 介词
      "et", "ou", "mais", "donc", "car", "que", "qui", "quoi", "quand",
      "comment", "pourquoi", "où", "si", "non", "oui", "pas", "plus",
      "moins", "très", "trop", "bien", "mal", "peu", "rien", "jamais",
      "encore", "toujours", "souvent", "alors", "puis", "après", "avant",
      // 介词短语 / 常用词
      "dans", "sur", "sous", "avec", "sans", "pour", "chez", "entre",
      "depuis", "pendant", "vers", "selon", "malgré", "par", "comme",
      "aussi", "tout", "tous", "toute", "toutes", "autre", "même",
      "cette", "cet", "ces", "quel", "quelle", "chaque", "plusieurs",
      "bon", "bonne", "petit", "petite", "grand", "grande", "vieux",
      "beau", "belle", "nouveau", "nouvelle", "vraiment", "beaucoup",
    ],
    German: [
      "der", "die", "das", "und", "ist", "nicht", "ein", "eine", "von",
      "mit", "auf", "für", "auch", "sich", "wird", "werden", "dem",
      "den", "des", "als", "bei", "nach", "aus", "über", "vor", "zur",
      "zum", "zurück", "schon", "noch", "oder", "aber", "wenn", "dann",
      "sein", "ihr", "ihre", "dieser", "diese", "dieses", "kein", "keine",
      "ich", "du", "er", "sie", "es", "wir", "ihr", "mich", "dich",
      "uns", "euch", "mir", "dir", "ihm", "ihnen", "euch", "war", "hat",
      "haben", "kann", "muss", "soll", "wollen", "dürfen", "mögen",
      "doch", "nur", "auch", "mal", "denn", "wohl", "etwas", "nichts",
    ],
    English: [
      "the", "is", "are", "was", "were", "been", "being", "have", "has",
      "had", "do", "does", "did", "will", "would", "can", "could",
      "should", "may", "might", "shall", "must", "not", "but", "and",
      "or", "if", "then", "than", "that", "this", "these", "those",
      "it", "its", "they", "their", "to", "of", "in", "for", "on",
      "with", "at", "by", "from", "as", "into", "about", "so", "just",
      "now", "up", "out", "when", "how", "all", "also", "no", "yes",
      "me", "my", "we", "our", "us", "he", "she", "her", "him", "his",
      "your", "its", "there", "here", "very", "too", "some", "any",
      "more", "only", "like", "other", "new", "good", "well", "much",
    ],
  };

  // 预编译为 Set，加速查找
  const WORD_SETS = {};
  for (const [lang, words] of Object.entries(MARKER_WORDS)) {
    WORD_SETS[lang] = new Set(words);
  }

  // ---- 字符范围判断 ----
  function inRange(ch, start, end) {
    const cp = ch.codePointAt(0);
    return cp >= start && cp <= end;
  }

  const isCJK      = (ch) => inRange(ch, 0x4E00, 0x9FFF) || inRange(ch, 0x3400, 0x4DBF) || inRange(ch, 0xF900, 0xFAFF);
  const isHiragana = (ch) => inRange(ch, 0x3040, 0x309F);
  const isKatakana = (ch) => inRange(ch, 0x30A0, 0x30FF);
  const isHangul   = (ch) => inRange(ch, 0xAC00, 0xD7AF) || inRange(ch, 0x1100, 0x11FF) || inRange(ch, 0x3130, 0x318F);
  const isCyrillic = (ch) => inRange(ch, 0x0400, 0x04FF) || inRange(ch, 0x0500, 0x052F);
  const isLatin    = (ch) => inRange(ch, 0x0041, 0x005A) || inRange(ch, 0x0061, 0x007A);

  // ---- 脚本字符计数 ----
  function countScripts(text) {
    let cjk = 0, hiragana = 0, katakana = 0, hangul = 0, cyrillic = 0, latin = 0, total = 0;
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      total++;
      if (isCJK(ch))      cjk++;
      if (isHiragana(ch)) hiragana++;
      if (isKatakana(ch)) katakana++;
      if (isHangul(ch))   hangul++;
      if (isCyrillic(ch)) cyrillic++;
      if (isLatin(ch))    latin++;
    }
    return { cjk, hiragana, katakana, hangul, cyrillic, latin, total };
  }

  // ---- 拉丁语系细分 ----
  function detectLatinLanguage(text) {
    const words = text.toLowerCase().match(/[a-zà-ÿœæ]+/g) || [];
    if (words.length === 0) return "English";

    // 基础词匹配计分
    const scores = { English: 0, French: 0, German: 0 };
    for (const w of words) {
      for (const lang of ["French", "German", "English"]) {
        if (WORD_SETS[lang].has(w)) scores[lang]++;
      }
    }

    // 法语特殊字符加成：é, è, ê, ë, à, â, ç, î, ï, ô, û, ù, ü, œ, æ
    // 这些字符在英语中基本不存在，德语也只有 ä, ö, ü, ß
    const frenchAccents = (text.match(/[éèêëàâçîïôûùüœæÉÈÊËÀÂÇÎÏÔÛÙÜŒÆ]/g) || []).length;
    scores.French += frenchAccents;

    // 德语特殊字符：ß（德语独有）
    const germanEsZet = (text.match(/ß/g) || []).length;
    scores.German += germanEsZet;

    let best = "English";
    let bestScore = 0;
    for (const [lang, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        best = lang;
      }
    }
    return best;
  }

  // ---- 主入口：检测语言 ----
  function detectLanguage(text) {
    if (!text || !text.trim()) return null;

    const trimmed = text.trim();
    const counts = countScripts(trimmed);

    // 日文：有假名即可判定
    if (counts.hiragana > 0 || counts.katakana > 0) {
      return "Japanese";
    }

    // 韩文：谚文占比 > 10%
    if (counts.hangul > counts.total * 0.1) {
      return "Korean";
    }

    // 中文：CJK 占比 > 10%
    if (counts.cjk > counts.total * 0.1) {
      return "Chinese";
    }

    // 俄文：西里尔字母占比 > 10%
    if (counts.cyrillic > counts.total * 0.1) {
      return "Russian";
    }

    // 拉丁字母：用常见词细分
    if (counts.latin > counts.total * 0.3) {
      return detectLatinLanguage(trimmed);
    }

    return null;
  }

  // ---- 获取原生名称 ----
  function getNativeName(lang) {
    return LANG_INFO[lang]?.native || lang;
  }

  function getLabel(lang) {
    return LANG_INFO[lang]?.label || lang;
  }

  // ---- 导出 ----
  const module = { detect: detectLanguage, getNativeName, getLabel };

  if (typeof window !== "undefined") window.LangDetect = module;
  if (typeof self !== "undefined")   self.LangDetect = module;
})();
