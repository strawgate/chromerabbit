importScripts('utils/trpc-client.js');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PING') {
    sendResponse({ success: true });
    return false;
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
        const errorMsg = err.message || (typeof err === 'object' ? JSON.stringify(err) : String(err)) || "Unknown error";
        sendResponse({ success: false, error: errorMsg });
      });
    return true;
  }
});

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

let creating;
async function setupOffscreenDocument(path) {
  const offscreenUrl = chrome.runtime.getURL(path);
  const matchedClients = await self.clients.matchAll();
  for (const client of matchedClients) {
    if (client.url === offscreenUrl) return;
  }
  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: ['DOM_PARSER'],
      justification: 'WebSocket connection to CodeRabbit API (Chromium Service Worker WS header bug workaround)',
    });
    await creating;
    creating = null;
  }
}

async function handleRequestReview(payload, tabId) {
  const { owner, repo, prNumber } = payload;
  console.log(`Starting review for ${owner}/${repo}#${prNumber}`);

  // Get the real access token (from OAuth or manual entry)
  const storageItem = await chrome.storage.local.get(['accessToken', 'coderabbitToken']);
  const token = (storageItem.accessToken || storageItem.coderabbitToken || '').trim();

  if (!token) {
    throw new Error("Not signed in. Please sign in via the extension options page.");
  }

  // Set up declarativeNetRequest to inject auth headers on the WebSocket upgrade.
  // This is needed because browsers cannot set custom headers on WebSocket handshakes.
  // Cloud Armor requires the Authorization header to be present on the HTTP upgrade request.
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [2],
    addRules: [{
      id: 2,
      priority: 2,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Authorization", operation: "set", value: token },
          { header: "X-CodeRabbit-Extension", operation: "set", value: "vscode" },
          { header: "X-CodeRabbit-Extension-Version", operation: "set", value: "1.0.6" },
          { header: "X-CodeRabbit-Extension-ClientId", operation: "set", value: generateUUID() }
        ]
      },
      condition: {
        urlFilter: "ide.coderabbit.ai",
        resourceTypes: ["websocket"]
      }
    }]
  });

  // Fetch the PR diff
  const diffUrl = `https://patch-diff.githubusercontent.com/raw/${owner}/${repo}/pull/${prNumber}.diff`;
  const diffResponse = await fetch(diffUrl);
  if (!diffResponse.ok) {
    throw new Error(`Failed to fetch PR diff: ${diffResponse.status}`);
  }
  const diffContent = await diffResponse.text();
  console.log(`Fetched diff, size: ${diffContent.length} bytes`);

  // Spin up the offscreen document to handle the WebSocket
  // (Service Workers have a Chromium bug where declarativeNetRequest headers are dropped on WS)
  await setupOffscreenDocument('offscreen.html');

  const clientId = generateUUID();
  const reviewId = generateUUID();

  // Hand off to the offscreen document
  chrome.runtime.sendMessage({
    type: 'START_OFFSCREEN_REVIEW',
    payload: { owner, repo, prNumber, diffContent, token, tabId, clientId, reviewId }
  });

  return { initiated: true, reviewId };
}
