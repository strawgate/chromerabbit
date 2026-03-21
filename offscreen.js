chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'START_OFFSCREEN_REVIEW') {
    handleOffscreenReview(request.payload);
    sendResponse({ success: true });
    return false; // synchronous
  }
});

async function handleOffscreenReview(payload) {
  const { owner, repo, prNumber, diffContent, token, tabId, clientId, reviewId } = payload;
  
  try {
    // We are now inside a physical Chrome window DOM. 
    // The Chromium bug (Issue 1285664) dragging WebSockets to death in Service Workers no longer applies!
    console.log(`Offscreen doc initiating WS handshake for ${owner}/${repo}#${prNumber}...`);
    const client = new CodeRabbitClient(token);
    await client.connect();

    const requestPayload = {
      extensionEvent: {
        userId: clientId,
        userName: "ChromeExtensionUser",
        clientId: clientId,
        eventType: "REVIEW",
        reviewId: reviewId,
        files: [{
          rawPath: "pr.diff", 
          fileLanguage: "diff",
          baseStr: "",
          headStr: diffContent
        }],
        hostUrl: "https://github.com",
        provider: "github",
        remoteUrl: `https://github.com/${owner}/${repo}.git`,
        host: "vscode", 
        version: "1.0.0"
      }
    };

    console.log("Offscreen request Payload", requestPayload);
    const response = await client.requestFullReview(requestPayload);
    console.log("Offscreen review officially triggered bypass:", response);

    // Relay the 200 OK success signal back to the GitHub PR Tab 
    // (since offscreen scripts cannot query active tabs natively without host permissions)
    chrome.runtime.sendMessage({
      type: 'FORWARD_TO_TAB',
      tabId: tabId,
      message: {
        type: 'REVIEW_RESULT',
        payload: { 
          status: 'success', 
          message: 'CodeRabbit accepted the WebSocket handshake via the Offscreen DOM! The engine is now reviewing your diff.'
        }
      }
    });

  } catch (err) {
    console.error("Offscreen Connection Failed:", err);
    chrome.runtime.sendMessage({
      type: 'FORWARD_TO_TAB',
      tabId: tabId,
      message: {
        type: 'REVIEW_RESULT',
        payload: { 
          status: 'error', 
          message: err.message || JSON.stringify(err) || String(err)
        }
      }
    });
  }
}
