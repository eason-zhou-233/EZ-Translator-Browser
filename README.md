# EZ Translator

A lightweight browser translation extension that supports both traditional translation services and modern LLM-powered translation engines.

## Features

### Web Page Translation

* Translate the entire current webpage
* Translate selected text directly on the page
* Restore original content with one click
* Automatically skip content that should not be translated:

  * URLs
  * Email addresses
  * Numbers
  * Dates
  * Existing Chinese text

### Free Translation Window

Click the extension icon to open a standalone translation panel.

Features:

* Translate arbitrary text
* Automatic source language detection
* Manual source/target language selection
* One-click copy of translation results

### Multiple Translation Engines

#### Traditional Translation

* Google Translate

#### LLM Translation

Supports any OpenAI-compatible API provider, including:

* OpenAI
* DeepSeek
* OpenRouter
* SiliconFlow
* Volcano Engine Ark
* LM Studio
* Ollama
* Any OpenAI-compatible local or cloud deployment

### Translation Cache

* Automatic local caching
* Reduces API requests
* Improves translation speed
* LRU-based cache cleanup

## Supported Languages

* Chinese
* English
* French
* German
* Japanese
* Korean
* Russian

Source language can be automatically detected.

## Configuration

### Google Translate

Default endpoint:

https://translate.googleapis.com

The endpoint can be customized in settings.

### OpenAI-Compatible API

Required settings:

* API Base URL
* Chat Completions Path
* Model Name

Optional settings:

* API Key
* Custom Authorization Header
* Custom Prefix
* Temperature
* Top-K
* Top-P
* Max Tokens
* Request Timeout
* Additional Headers

## Privacy

EZ Translator does not collect, store, transmit, or sell user data.

Translation requests are sent directly from your browser to the translation service you configure.

See:

Privacy Policy

## Installation

1. Download or clone this repository.
2. Open Chrome and navigate to:

chrome://extensions

3. Enable Developer Mode.
4. Click "Load unpacked".
5. Select the extension directory.

## License

MIT License
