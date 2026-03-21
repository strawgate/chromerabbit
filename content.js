console.log('CodeRabbit PR Review Extension loaded');

// CSS classes for styling
const BTN_CLASS = 'coderabbit-fab';
const BTN_LOADING_CLASS = 'coderabbit-loading';

function injectCodeRabbitButton() {
  if (document.querySelector(`.${BTN_CLASS}`)) {
    return; // Already injected
  }

  const btn = document.createElement('button');
  btn.className = BTN_CLASS;
  btn.innerHTML = `
    <span class="cr-icon">🐰</span> Review with CodeRabbit
  `;

  btn.addEventListener('click', handleReviewClick);

  // Append a floating button to the body directly so it's always visible regardless of DOM changes
  document.body.appendChild(btn);
}

async function handleReviewClick(e) {
  const btn = e.currentTarget;

  // Ping the background script to ensure it's awake and responsive
  try {
    const isAwake = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'PING' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (!isAwake) {
      btn.innerText = 'Extension asleep 😴 (Refresh page!)';
      btn.disabled = true;
      setTimeout(() => {
        btn.innerHTML = '<span class="cr-icon">🐰</span> Review with CodeRabbit';
        btn.disabled = false;
      }, 3000);
      return;
    }
  } catch (err) {
    console.error("Ping failed:", err);
  }

  btn.classList.add(BTN_LOADING_CLASS);
  btn.innerText = 'Rabbit is reviewing...';
  btn.disabled = true;

  try {
    // Determine the current PR details from the URL
    // e.g. https://github.com/owner/repo/pull/123
    const urlParts = window.location.pathname.split('/');
    const owner = urlParts[1];
    const repo = urlParts[2];
    const prNumber = urlParts[4];

    // Run the background script logic instead of fetching here to avoid CORS on patch-diff.githubusercontent.com
    chrome.runtime.sendMessage({
      type: 'REQUEST_REVIEW',
      payload: {
        owner,
        repo,
        prNumber,
        url: window.location.href
      }
    }, (response) => {
      btn.classList.remove(BTN_LOADING_CLASS);
      
      if (chrome.runtime.lastError || !response || !response.success) {
        btn.innerText = 'Review Failed ❌';
        const errObj = chrome.runtime.lastError || response?.error;
        let errorMsg = typeof errObj === 'object' ? errObj.message || JSON.stringify(errObj) : String(errObj);
        if (errorMsg === "undefined" || errorMsg === "[object Object]") errorMsg = "The background service worker dropped the connection or threw an unhandled exception.";
        
        showCrToast("CodeRabbit Review Failed", errorMsg, "error");
        
        setTimeout(() => {
          btn.innerHTML = '<span class="cr-icon">🐰</span> Review with CodeRabbit';
          btn.disabled = false;
        }, 3000);
      } else {
        btn.innerText = 'Review Requested! ✅';
        showCrToast("Review Initiated", "The CodeRabbit backend is now processing your PR. Results will appear momentarily.", "success");
      }
    });

  } catch (error) {
    console.error('CodeRabbit Chrome Ext Error:', error);
    btn.classList.remove(BTN_LOADING_CLASS);
    btn.innerText = 'Review Failed ❌';
    showCrToast("CodeRabbit Error", error.message, "error");
    setTimeout(() => {
      btn.innerHTML = '<span class="cr-icon">🐰</span> Review with CodeRabbit';
      btn.disabled = false;
    }, 3000);
  }
}

// PREMIUM UI COMPONENTS
function showCrToast(title, message, type = 'success') {
  let container = document.querySelector('.cr-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'cr-toast-container';
    document.body.appendChild(container);
  }
  
  const toast = document.createElement('div');
  toast.className = `cr-toast ${type}`;
  toast.innerHTML = `
    <div class="cr-toast-header">
      <span>${type === 'error' ? '❌' : '🐰'}</span> ${title}
    </div>
    <div class="cr-toast-body">${message}</div>
  `;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'cr-slide-out 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards';
    setTimeout(() => toast.remove(), 450);
  }, 6000);
}

function showCrReviewPanel(resultObj) {
  let sidebar = document.querySelector('.cr-sidebar');
  if (!sidebar) {
    sidebar = document.createElement('div');
    sidebar.className = 'cr-sidebar';
    sidebar.innerHTML = `
      <div class="cr-sidebar-header">
        <div class="cr-sidebar-title"><span class="cr-icon">🐰</span> CodeRabbit Report</div>
        <button class="cr-sidebar-close">✕</button>
      </div>
      <div class="cr-sidebar-body"></div>
    `;
    document.body.appendChild(sidebar);
    
    sidebar.querySelector('.cr-sidebar-close').addEventListener('click', () => {
      sidebar.classList.remove('open');
    });
  }
  
  const body = sidebar.querySelector('.cr-sidebar-body');
  let contentHtml = '';
  
  if (resultObj.status === 'success') {
    contentHtml = `
      <h2>Review Complete!</h2>
      <p>${resultObj.message || 'No direct message passed.'}</p>
      <p style="margin-top: 1em; padding-top: 1em; border-top: 1px solid rgba(255,255,255,0.1); color: #9ca3af;">
        <i>Note: Currently receiving raw status. We will map full chat/diff annotations into this panel when CodeRabbit WebSocket subscription stream stabilizes.</i>
      </p>
    `;
  } else {
    contentHtml = `<h2 style="color: #ef4444;">Review Processing Failed</h2><pre>${JSON.stringify(resultObj, null, 2)}</pre>`;
  }
  
  body.innerHTML = contentHtml;
  sidebar.classList.add('open');
}

// GitHub operates as a SPA, so we need to observe DOM changes
const observer = new MutationObserver(() => {
  if (window.location.href.includes('/pull/')) {
    injectCodeRabbitButton();
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial check
if (window.location.href.includes('/pull/')) {
  injectCodeRabbitButton();
}


// --- Listen for review results from Background script ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REVIEW_RESULT') {
    displayReviewResult(message.payload);
  }
  return true;
});

function displayReviewResult(result) {
  // Automatically reset the button purely for UX
  const btn = document.querySelector(`.${BTN_CLASS}`);
  if (btn) {
    btn.innerHTML = '<span class="cr-icon">🐰</span> Reviewing Done ✅';
    setTimeout(() => {
      btn.innerHTML = '<span class="cr-icon">🐰</span> Review with CodeRabbit';
      btn.disabled = false;
    }, 4000);
  }

  // Open the premium side panel to display the results!
  showCrReviewPanel(result);
}
