<div align="center">

# ChatGPT Route Inspector

![Stars](https://img.shields.io/github/stars/Liu-Bot24/chatgpt-route-inspector?style=flat&label=Stars&cache=20260811) ![Forks](https://img.shields.io/github/forks/Liu-Bot24/chatgpt-route-inspector?style=flat&label=Forks&cache=20260811) ![Views 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/chatgpt-route-inspector/views14d.svg?v=4) ![Clones 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/chatgpt-route-inspector/clones14d.svg?v=4) ![Downloads](https://img.shields.io/github/downloads/Liu-Bot24/chatgpt-route-inspector/total?style=flat&label=Downloads&cache=20260811) ![Release](https://img.shields.io/github/v/release/Liu-Bot24/chatgpt-route-inspector?style=flat&label=Release&cache=20260811)

![ChatGPT Route Inspector preview](assets/promotional/chatgpt-route-inspector-1200x510-en.png)

Languages: [简体中文](README.md) · [English](README-en.md)

</div>

## Overview

ChatGPT Route Inspector is a model-route inspection extension for Chromium browsers. It shows both the model requested by the ChatGPT web client and the route model reported by the server response, helping users verify whether a Pro request remained on Pro or was routed to another model.

The extension reads available model information directly from requests and responses. It does not infer results from response speed, writing style, subjective quality, or model self-identification.

This is an independent, unofficial project. It is not affiliated with, authorized by, or endorsed by OpenAI.

## Interface preview

The following example shows a request for `GPT 5.6 Pro` with a response route of `GPT 5.5 mini`.

### Popup

<p align="center">
  <img src="docs/images/popup-en.png" width="640" alt="ChatGPT Route Inspector English Popup">
</p>

### Page overlay

<p align="center">
  <img src="docs/images/overlay-en.png" width="420" alt="ChatGPT Route Inspector English page overlay">
</p>

### Route diagnostics

<p align="center">
  <img src="docs/images/dashboard-en.png" width="100%" alt="ChatGPT Route Inspector English route diagnostics">
</p>

## Features

- **Live request inspection**: shows the requested model and response route for a newly sent message.
- **Auto reasoning indicator**: separately labels response routes `gpt-5-6-auto-thinking` and `gpt-5-5-auto-thinking` as “Auto reasoning”, while preserving the original model fields.
- **Conversation reload inspection**: reloads an existing conversation and reads available response-route information from completed answers.
- **Page overlay**: displays results inside ChatGPT with full, compact, mini, edge-stowed, and hidden states.
- **Route diagnostics**: reviews locally stored records and evidence, with Markdown and JSON export.
- **Quota snapshots**: shows captured deep research and image generation balances and reset times (UTC+08:00) in diagnostics. Reads existing page responses without additional quota requests; missing values are not inferred, and new balances do not overwrite older records.
- **PoW difficulty display**: shows the original hexadecimal value and its decimal conversion.
- **Chinese and English UI**: supports both languages across the Popup, overlay, diagnostics, settings, and reports.
- **Local-first storage**: keeps inspection records in the current browser and does not upload them to third-party servers.

## Installation

### Install from the Chrome Web Store

[Install ChatGPT Model Route Inspector from the Chrome Web Store](https://chromewebstore.google.com/detail/fbbnebcnkekjjmenncangmdhojamjcli)

### Install a release package manually

1. Download and extract `chatgpt-route-inspector-VERSION.zip` from the [latest release](https://github.com/Liu-Bot24/chatgpt-route-inspector/releases/latest).
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted extension directory.
6. Reload any ChatGPT pages that were already open.

### Build from source

Node.js 20 or newer is required.

```powershell
npm ci
npm run build
```

The unpacked extension is written to `dist/extension`. Open `chrome://extensions/`, choose **Load unpacked**, and select that directory.

## Usage

### Inspect a new answer

1. Open ChatGPT and enter the target conversation.
2. Click the extension icon and select **Live request**.
3. Choose a model in ChatGPT and send a message.
4. Read **Requested → Response route** in the Popup or page overlay.

### Review an existing answer

1. Select **Reload session** in the Popup.
2. Reload the current ChatGPT conversation.
3. Review the response-route information available for that conversation.

### Manage the page overlay

- Select **Compact mode** in the upper-right corner to show the requested model, response route, and PoW difficulty.
- Select **Mini mode** to dock the overlay to the right edge with only the response route value and decimal PoW value.
- Click the compact overlay to restore the full view.
- In the mini overlay, click the narrow left edge to stow it at the right side of the window; click the remaining content area to restore the full view.
- Click the narrow edge left behind after stowing to restore the mini overlay.
- Select **Hide overlay** to remove it from the page completely.
- To restore a hidden overlay, select **Show overlay** in the extension Popup.

## Reading the result

| Display | Meaning |
|---|---|
| Requested model | The model sent by the ChatGPT web client for the current message |
| Response route | The route model reported by the server response |
| Model label | A supplementary model label attached to the answer record |
| PoW difficulty | The original hexadecimal value and its decimal conversion |

If an item displays `—`, the corresponding information was not available for that turn. The extension does not guess missing results.

For a Chrome DevTools cross-check procedure, see the [Chrome manual verification guide](docs/chrome-manual-verification.md). The guide is written in Chinese.

## Privacy and permissions

See the [Privacy Policy](PRIVACY.md) for the complete data-handling disclosure.

The extension stores only the data needed for route inspection, including model information, PoW difficulty, timestamps, duration, record sources, and extension settings.

It does not store or upload:

- prompt or answer text;
- cookies, login credentials, or other authentication data;
- attachment contents or filenames;
- unfiltered network requests, responses, or HAR files.

### Browser permissions

| Permission | Purpose |
|---|---|
| `storage` | Stores settings and inspection records locally |
| `chatgpt.com` / `chat.openai.com` | Reads model-route information on supported ChatGPT pages |

The extension does not request the `debugger` permission and does not monitor unrelated websites or general browser traffic.

## Compatibility and limitations

- Supports Chrome 111 or newer and other Chromium browsers compatible with Manifest V3.
- The extension observes and displays information only. It does not modify ChatGPT requests, responses, model selection, account entitlements, or usage limits.
- Available information depends on what the ChatGPT web response provides. Website changes may temporarily affect recognition.
- PoW difficulty is displayed as a raw value only and is not an official OpenAI account-status or risk assessment.

## Development

```powershell
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run package
```

Release archives and SHA-256 checksum files are written to `release/`.

## Disclaimer

This project is not affiliated with or endorsed by OpenAI. ChatGPT, OpenAI, and related marks are trademarks of their respective owners. The extension displays information available in ChatGPT web requests and responses; it is not an official attestation of OpenAI infrastructure, billing systems, or account status.
