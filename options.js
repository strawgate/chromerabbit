document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const saveBtn = document.getElementById('saveBtn');
  const tokenInput = document.getElementById('token');
  const statusMessage = document.getElementById('statusMessage');
  const authCard = document.getElementById('authCard');
  const authStatus = document.getElementById('authStatus');
  const authUser = document.getElementById('authUser');
  const authProvider = document.getElementById('authProvider');

  // --- UI Helpers ---
  function showStatus(message, type = 'success') {
    statusMessage.textContent = message;
    statusMessage.className = 'status show ' + type;
    setTimeout(() => { statusMessage.className = 'status'; }, 4000);
  }

  function updateAuthUI(tokenData) {
    if (tokenData && tokenData.accessToken) {
      authCard.classList.add('logged-in');
      authStatus.textContent = '✅ Signed in';
      authUser.style.display = 'block';
      authUser.textContent = tokenData.provider ? `via ${tokenData.provider}` : 'Authenticated';
      loginBtn.style.display = 'none';
      logoutBtn.style.display = 'block';
      tokenInput.value = tokenData.accessToken;
    } else if (tokenData && tokenData.coderabbitToken) {
      authCard.classList.add('logged-in');
      authStatus.textContent = '✅ Token configured (manual)';
      loginBtn.style.display = 'block';
      logoutBtn.style.display = 'block';
      tokenInput.value = tokenData.coderabbitToken;
    } else {
      authCard.classList.remove('logged-in');
      authStatus.textContent = 'Not signed in';
      authUser.style.display = 'none';
      authProvider.style.display = 'none';
      loginBtn.style.display = 'block';
      logoutBtn.style.display = 'none';
      tokenInput.value = '';
    }
  }

  // --- Load existing auth state ---
  chrome.storage.local.get(['accessToken', 'refreshToken', 'provider', 'coderabbitToken'], (result) => {
    updateAuthUI(result);
  });

  // --- OAuth Login ---
  loginBtn.addEventListener('click', async () => {
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<span class="spinner"></span>Signing in...';

    try {
      // Generate a random state parameter for CSRF protection
      const state = crypto.randomUUID();

      // CodeRabbit's login URL — same as VS Code extension uses
      const loginUrl = `https://app.coderabbit.ai/login?client=vscode&state=${state}`;

      // Use chrome.identity to handle the OAuth redirect
      // The redirect URL will be https://<extension-id>.chromiumapp.org/
      const redirectUrl = chrome.identity.getRedirectURL();
      console.log("Redirect URL:", redirectUrl);

      // Open the login page — CodeRabbit will redirect back to us with the auth code
      // Note: CodeRabbit may not support our redirect URL directly, so we'll also
      // try opening in a new tab and having the user paste the callback URL
      const callbackUrl = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({
          url: loginUrl,
          interactive: true
        }, (responseUrl) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(responseUrl);
          }
        });
      });

      console.log("Callback URL received:", callbackUrl);

      // Parse the callback URL for the auth code
      // CodeRabbit redirects to: coderabbit-cli://auth-callback?code=XXX&provider=github&state=YYY
      // But chrome.identity intercepts any redirect to our chromiumapp.org URL
      // Let's check both formats
      const url = new URL(callbackUrl);
      const code = url.searchParams.get('code');
      const provider = url.searchParams.get('provider') || 'github';

      if (!code) {
        throw new Error('No authorization code received from CodeRabbit');
      }

      console.log("Got auth code, exchanging for tokens...");

      // Exchange the authorization code for access + refresh tokens
      // This mirrors the VS Code extension's call to accessToken.getAccessAndRefreshToken
      const exchangeRes = await fetch(
        'https://app.coderabbit.ai/trpc/accessToken.getAccessAndRefreshToken?' +
        'input=' + encodeURIComponent(JSON.stringify({
          code: code,
          provider: provider,
          redirectUri: ''
        }))
      );

      if (!exchangeRes.ok) {
        const errText = await exchangeRes.text();
        throw new Error(`Token exchange failed: ${exchangeRes.status} ${errText}`);
      }

      const exchangeData = await exchangeRes.json();
      console.log("Token exchange response:", exchangeData);

      if (exchangeData.error) {
        throw new Error(exchangeData.error.message || 'Token exchange failed');
      }

      const tokenData = exchangeData.result?.data?.data || exchangeData.result?.data || exchangeData.data;
      if (!tokenData || !tokenData.accessToken) {
        throw new Error('No access token in exchange response');
      }

      // Store the tokens
      await chrome.storage.local.set({
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken || '',
        expiresIn: tokenData.expiresIn || '',
        provider: provider,
        coderabbitToken: tokenData.accessToken // Also set as the primary token for background.js
      });

      updateAuthUI({ accessToken: tokenData.accessToken, provider });
      showStatus('Successfully signed in!', 'success');

    } catch (err) {
      console.error('OAuth login failed:', err);
      showStatus(err.message, 'error');
    } finally {
      loginBtn.disabled = false;
      loginBtn.innerHTML = 'Sign in with CodeRabbit';
    }
  });

  // --- Logout ---
  logoutBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['accessToken', 'refreshToken', 'expiresIn', 'provider', 'coderabbitToken']);
    updateAuthUI(null);
    showStatus('Signed out', 'success');
  });

  // --- Manual token save ---
  saveBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    if (!token) {
      showStatus('Please enter a token', 'error');
      return;
    }
    chrome.storage.local.set({ coderabbitToken: token, accessToken: token }, () => {
      showStatus('Token saved!', 'success');
    });
  });
});
