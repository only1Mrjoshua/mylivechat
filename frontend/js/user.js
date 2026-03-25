const API_BASE = "http://127.0.0.1:8000";

const chatLauncher = document.getElementById("chatLauncher");
const chatPanel = document.getElementById("chatPanel");
const chatClose = document.getElementById("chatClose");
const userOnboarding = document.getElementById("userOnboarding");
const chatBody = document.getElementById("chatBody");
const startChatBtn = document.getElementById("startChatBtn");
const userName = document.getElementById("userName");
const userEmail = document.getElementById("userEmail");
const firstMessage = document.getElementById("firstMessage");
const userMessages = document.getElementById("userMessages");
const userComposer = document.getElementById("userComposer");
const userMessageInput = document.getElementById("userMessageInput");

let conversationId = localStorage.getItem("chat_conversation_id") || null;
let customerName = localStorage.getItem("chat_customer_name") || "";
let ws = null;
let manuallyClosed = false;

function openChat() {
  chatPanel.classList.remove("hidden");
  manuallyClosed = false;
}

function closeChat() {
  chatPanel.classList.add("hidden");
  manuallyClosed = true;
}

chatLauncher.addEventListener("click", openChat);
chatClose.addEventListener("click", closeChat);

function formatTime(iso) {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function scrollMessagesToBottom() {
  userMessages.scrollTop = userMessages.scrollHeight;
}

function appendMessage(message) {
  const row = document.createElement("div");
  row.className = `bubble-row ${message.sender_type}`;
  row.innerHTML = `
    <div>
      <div class="bubble ${message.sender_type}">${escapeHtml(message.content)}</div>
      <div class="meta">${escapeHtml(message.sender_name)} • ${formatTime(message.created_at)}</div>
    </div>
  `;
  userMessages.appendChild(row);
  scrollMessagesToBottom();
}

async function loadExistingConversation() {
  if (!conversationId) return;

  try {
    const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/messages`);
    if (!res.ok) {
      localStorage.removeItem("chat_conversation_id");
      localStorage.removeItem("chat_customer_name");
      conversationId = null;
      customerName = "";
      return;
    }

    const data = await res.json();
    userOnboarding.classList.add("hidden");
    chatBody.classList.remove("hidden");
    userMessages.innerHTML = "";
    data.messages.forEach(appendMessage);
    connectUserWebSocket();

    // reopen existing chat session automatically
    if (!manuallyClosed) {
      openChat();
    }
  } catch (error) {
    console.error("Failed to load existing conversation:", error);
  }
}

startChatBtn.addEventListener("click", async () => {
  const payload = {
    customer_name: userName.value.trim(),
    customer_email: userEmail.value.trim(),
    first_message: firstMessage.value.trim(),
  };

  if (!payload.customer_name || !payload.first_message) {
    alert("Please enter your name and your message.");
    return;
  }

  startChatBtn.disabled = true;
  startChatBtn.textContent = "Starting...";

  try {
    const res = await fetch(`${API_BASE}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      alert("Unable to start chat right now.");
      return;
    }

    const data = await res.json();
    conversationId = data.conversation.id;
    customerName = data.conversation.customer_name;

    localStorage.setItem("chat_conversation_id", String(conversationId));
    localStorage.setItem("chat_customer_name", customerName);

    userOnboarding.classList.add("hidden");
    chatBody.classList.remove("hidden");
    userMessages.innerHTML = "";
    data.messages.forEach(appendMessage);

    openChat();
    connectUserWebSocket();

    firstMessage.value = "";
  } catch (error) {
    console.error("Failed to start chat:", error);
    alert("Unable to start chat right now.");
  } finally {
    startChatBtn.disabled = false;
    startChatBtn.textContent = "Start Secure Chat";
  }
});

userComposer.addEventListener("submit", async (e) => {
  e.preventDefault();

  const content = userMessageInput.value.trim();
  if (!content || !conversationId) return;

  const messageToSend = content;
  userMessageInput.value = "";

  // keep chat open no matter what
  openChat();

  try {
    const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/messages/user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender_name: customerName || "Customer",
        content: messageToSend,
      }),
    });

    if (!res.ok) {
      alert("Message failed to send.");
      userMessageInput.value = messageToSend;
      return;
    }
  } catch (error) {
    console.error("Message send failed:", error);
    alert("Message failed to send.");
    userMessageInput.value = messageToSend;
  }
});

function connectUserWebSocket() {
  if (!conversationId) return;

  if (ws) {
    ws.close();
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://127.0.0.1:8000/ws/user/${conversationId}`);

  ws.onopen = () => {
    console.log("User socket connected");
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "new_message") {
      appendMessage(data.message);

      // do NOT collapse modal when a message arrives
      if (!manuallyClosed) {
        openChat();
      }
    }
  };

  ws.onclose = () => {
    console.log("User socket closed");
  };

  ws.onerror = (error) => {
    console.error("User socket error:", error);
  };
}

loadExistingConversation();