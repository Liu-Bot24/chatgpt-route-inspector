# Privacy Policy

Effective date: September 27, 2026

ChatGPT Route Inspector (the “Extension”) is a local model-route inspection tool for Chromium browsers. This policy explains how the Extension handles data.

## Data handled

The Extension processes only information needed for model-route inspection on `chatgpt.com` and `chat.openai.com`, including:

- model identifiers requested by the web client;
- route models reported by server responses and related model labels;
- capture mode, evidence sources, inspection status, timestamps, and duration;
- routing-related metadata such as reasoning effort, conversation mode, and tool-use status;
- PoW difficulty values;
- tab IDs, ChatGPT page URLs, and conversation, request, and network-request identifiers;
- user settings such as language, capture mode, overlay state, and record limit.

The Extension temporarily parses requests and responses already sent or received by the ChatGPT page to extract these allowlisted fields. Unfiltered requests and responses are not written to extension storage.

## Data not handled or stored

The Extension does not store or upload:

- prompt or answer text;
- cookies, Authorization headers, JWTs, passwords, or other login credentials;
- attachment contents or filenames;
- PoW seeds, proof tokens, or device fingerprints;
- complete network requests, responses, or HAR files.

The Extension contains no advertising, analytics SDK, or user-tracking code.

## How data is used

Data is handled only to:

- display the requested model and the response route reported by the server;
- identify changes in model routing;
- display PoW difficulty and diagnostic information;
- retain local inspection history and generate diagnostic reports requested by the user.

The Extension does not sell data, use data for advertising, or provide data to data brokers or other third parties.

## Local storage and retention

Settings and inspection records are stored in `chrome.storage.local` in the current browser profile and are not synchronized to the developer’s servers. The configured record limit controls retention; when the limit is reached, the oldest records are removed automatically.

Users can clear local records from the Settings & Privacy page. Chrome removes the Extension’s local storage when the Extension is uninstalled.

## Data transmission and exports

The Extension does not automatically transmit inspection data to the developer or any third-party server. If a user clicks an author, GitHub, or other external link, the browser opens that website through normal navigation.

When upgrading to version 1.0.9, the Extension opens the public version announcement at `https://rinotice.liu-qi.cn/` once. Users can also open this page from announcement links in the Extension. This is ordinary website navigation: the hosting server receives the browser's IP address and standard HTTP request headers, but the Extension does not attach inspection records, ChatGPT conversation identifiers, or conversation content. The announcement page contains no analytics or user-tracking code and cannot access the Extension's local records.

Copying a summary, exporting JSON, or exporting a report requires an explicit user action. Exports contain routing-diagnostic fields only. Request identifiers are redacted by default and are included in full only when the user explicitly enables that setting.

## Browser permissions

- `storage`: stores settings and inspection records in the current Chrome profile.
- `https://chatgpt.com/*` and `https://chat.openai.com/*`: reads allowlisted routing fields on supported ChatGPT pages and displays the page overlay.

The Extension does not request `debugger`, `cookies`, `webRequest`, `history`, or access to all websites.

## Chrome Web Store Limited Use

The Extension’s use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only to provide the user-facing features clearly described by the Extension.

## Changes to this policy

If the Extension’s data-handling practices change, this policy will be updated and the effective date above will be revised.

## Contact

For privacy questions, contact the project maintainer through [GitHub Issues](https://github.com/Liu-Bot24/chatgpt-route-inspector/issues).
