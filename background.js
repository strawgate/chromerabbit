importScripts('utils/trpc-client.js');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PING') {
    sendResponse({ success: true });
    return false; // synchronous response
  }

  if (request.type === 'FORWARD_TO_TAB') {
    chrome.tabs.sendMessage(request.tabId, request.message);
    sendResponse({ success: true });
    return false;
  }

  if (request.type === 'REQUEST_REVIEW') {
    handleRequestReview(request.payload, sender.tab.id)
      .then(res => sendResponse({ success: true, data: res }))
      .catch(err => {
        console.error("Background caught error:", err);
        const errorMsg = err.message || (err.type ? `Event: ${err.type}` : null) || (typeof err === 'object' ? JSON.stringify(err) : String(err)) || "Unknown WS connection error";
        sendResponse({ success: false, error: errorMsg });
      });
    return true; // Keep message channel open for async response
  }
});

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

let creating; // global promise lock
async function setupOffscreenDocument(path) {
  const offscreenUrl = chrome.runtime.getURL(path);
  const matchedClients = await self.clients.matchAll(); // Use self.clients for SW globally scope

  for (const client of matchedClients) {
    if (client.url === offscreenUrl) {
      return;
    }
  }

  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: ['DOM_PARSER'],
      justification: 'Circumvent Chromium ServiceWorker declarativeNetRequest drop bug for WebSocket handshakes',
    });
    await creating;
    creating = null;
  }
}

async function handleRequestReview(payload, tabId) {
  const { owner, repo, prNumber } = payload;
  console.log(`Starting review for ${owner}/${repo}#${prNumber}`);

    // Fetch the token from storage
    const storageItem = await chrome.storage.local.get('coderabbitToken');
    let token = storageItem.coderabbitToken;

    if (!token) {
      throw new Error("No CodeRabbit token configured. Please set it in options.");
    }
    
    // CRITICAL: Strip any accidental whitespace/newlines pasted into the options page, since HTTP header parsers will crash on trailing newlines!
    token = token.trim();

    // CRITICAL: Chrome browser WebSockets cannot send custom HTTP headers natively. 
    // CodeRabbit's Cloud Armor requires the Token and Proprietary headers on the Handshake layer.
    // We dynamically intercept the browser's network request to force inject these headers just before the socket opens.
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [2],
      addRules: [
        {
          id: 2,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Authorization", operation: "set", value: token },
              { header: "X-CodeRabbit-Extension", operation: "set", value: "vscode" },
              { header: "X-CodeRabbit-Extension-Version", operation: "set", value: "1.0.6" },
              { header: "X-CodeRabbit-Extension-ClientId", operation: "set", value: "123e4567-e89b-12d3-a456-426614174000" },
              { header: "User-Agent", operation: "set", value: "vscode-extension/1.0" },
              { header: "Origin", operation: "remove" }
            ]
          },
          condition: {
            urlFilter: "ide.coderabbit.ai",
            resourceTypes: ["websocket"]
          }
        }
      ]
    });

    // Give the Chrome C++ network interceptor stack a moment to fully ingest the new dynamic rule
    await new Promise(resolve => setTimeout(resolve, 350));

    // 1. Fetch the diff string
    const diffUrl = `https://patch-diff.githubusercontent.com/raw/${owner}/${repo}/pull/${prNumber}.diff`;
    const diffResponse = await fetch(diffUrl);
    if (!diffResponse.ok) {
      throw new Error(`Failed to fetch PR diff: ${diffResponse.status}`);
    }
    const diffContent = await diffResponse.text();

    console.log(`Fetched diff, size: ${diffContent.length} bytes`);

    // 2. The SW bug prevents us from executing a socket here. Spin up the exact MV3 Offscreen bypass document.
    await setupOffscreenDocument('offscreen.html');

    const clientId = generateUUID();
    const reviewId = generateUUID();

    // Pass the active payload off to the real DOM window memory space to perform the upgrade!
    chrome.runtime.sendMessage({
      type: 'START_OFFSCREEN_REVIEW',
      payload: { owner, repo, prNumber, diffContent, token, tabId, clientId, reviewId }
    });

    return { initiated: true, reviewId, offscreenMode: true };
}
