const API_BASE = "http://127.0.0.1:8000";

const conversationList = document.getElementById("conversationList");
const selectedConversationInfo = document.getElementById("selectedConversationInfo");
const adminMessages = document.getElementById("adminMessages");
const adminComposer = document.getElementById("adminComposer");
const adminMessageInput = document.getElementById("adminMessageInput");
const adminName = document.getElementById("adminName");
const closeCaseBtn = document.getElementById("closeCaseBtn");
const refreshBtn = document.getElementById("refreshBtn");

let selectedConversationId = null;
let conversations = [];
let ws = null;
let loadedMessageIds = new Set();
let pendingAdminMessages = new Set();

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function scrollAdminMessagesToBottom() {
  adminMessages.scrollTop = adminMessages.scrollHeight;
}

function getMessageFingerprint(message) {
  return [
    Number(message.conversation_id || 0),
    message.sender_type || "",
    message.sender_name || "",
    message.content || "",
  ].join("::");
}

function clearRenderedMessages() {
  adminMessages.innerHTML = "";
  loadedMessageIds.clear();
  pendingAdminMessages.clear();
}

function appendMessage(message) {
  if (message?.id && loadedMessageIds.has(String(message.id))) {
    return;
  }

  const fingerprint = getMessageFingerprint(message);

  // if real server message arrives for a pending optimistic admin message,
  // remove the pending marker so it won't duplicate
  if (message.sender_type === "admin" && pendingAdminMessages.has(fingerprint)) {
    pendingAdminMessages.delete(fingerprint);

    const optimisticRow = adminMessages.querySelector(
      `.bubble-row[data-fingerprint="${CSS.escape(fingerprint)}"][data-pending="true"]`
    );

    if (optimisticRow) {
      optimisticRow.dataset.pending = "false";
      if (message.id) {
        optimisticRow.dataset.messageId = String(message.id);
        loadedMessageIds.add(String(message.id));
      }
      return;
    }
  }

  const row = document.createElement("div");
  row.className = `bubble-row ${message.sender_type}`;
  row.dataset.messageId = message.id ? String(message.id) : "";
  row.dataset.fingerprint = fingerprint;
  row.dataset.pending = message.pending ? "true" : "false";

  row.innerHTML = `
    <div>
      <div class="bubble ${message.sender_type}">${escapeHtml(message.content)}</div>
      <div class="meta">${escapeHtml(message.sender_name)} • ${formatTime(message.created_at)}</div>
    </div>
  `;

  adminMessages.appendChild(row);

  if (message.id) {
    loadedMessageIds.add(String(message.id));
  }

  scrollAdminMessagesToBottom();
}

function updateSelectedConversationInfo(conversation) {
  if (!conversation) {
    selectedConversationInfo.innerHTML = `
      <h3 style="margin: 0">No conversation selected</h3>
      <p style="margin: 8px 0 0; color: var(--text-soft)">
        Choose a conversation from the left to view messages.
      </p>
    `;
    return;
  }

  selectedConversationInfo.innerHTML = `
    <h3 style="margin: 0">${escapeHtml(conversation.customer_name)}</h3>
    <p style="margin: 8px 0 0; color: var(--text-soft)">
      ${conversation.customer_email ? escapeHtml(conversation.customer_email) : "No email provided"}
      • Status: ${escapeHtml(conversation.status || "open")}
    </p>
  `;
}

function getConversationById(id) {
  return conversations.find((c) => Number(c.id) === Number(id)) || null;
}

function moveConversationToTop(conversationId) {
  const index = conversations.findIndex((c) => Number(c.id) === Number(conversationId));
  if (index <= 0) return;

  const item = conversations.splice(index, 1)[0];
  conversations.unshift(item);
}

function updateConversationWithMessage(message) {
  const conversationId = Number(message.conversation_id);
  const conversation = getConversationById(conversationId);

  if (!conversation) return;

  conversation.latest_message = message;
  conversation.updated_at = message.created_at || new Date().toISOString();
  moveConversationToTop(conversationId);
}

function upsertConversation(conversation, latestMessage = null) {
  const existingIndex = conversations.findIndex((c) => Number(c.id) === Number(conversation.id));

  const normalized = {
    ...conversation,
    latest_message: latestMessage || conversation.latest_message || null,
  };

  if (existingIndex === -1) {
    conversations.unshift(normalized);
  } else {
    conversations[existingIndex] = {
      ...conversations[existingIndex],
      ...normalized,
    };
    moveConversationToTop(conversation.id);
  }
}

function renderConversationList() {
  conversationList.innerHTML = "";

  if (!conversations.length) {
    conversationList.innerHTML = `<div class="empty-state">No conversations yet.</div>`;
    return;
  }

  conversations.forEach((conversation) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `conversation-item ${Number(conversation.id) === Number(selectedConversationId) ? "active" : ""}`;

    const latest = conversation.latest_message;

    btn.innerHTML = `
      <div class="conv-top">
        <div>
          <div style="font-weight: 800">${escapeHtml(conversation.customer_name)}</div>
          <div style="font-size: 12px; color: var(--text-soft); margin-top: 4px;">
            ${conversation.customer_email ? escapeHtml(conversation.customer_email) : "No email provided"}
          </div>
        </div>
        <span class="badge ${conversation.status === "closed" ? "closed" : "open"}">
          ${escapeHtml(conversation.status || "open")}
        </span>
      </div>

      <div style="font-size: 13px; color: var(--text-soft); margin-top: 12px; line-height: 1.55;">
        ${latest ? escapeHtml(latest.content).slice(0, 100) : "No messages yet"}
      </div>

      <div style="font-size: 11px; color: var(--text-soft); margin-top: 10px;">
        ${latest ? formatTime(latest.created_at) : ""}
      </div>
    `;

    btn.addEventListener("click", () => {
      if (Number(selectedConversationId) !== Number(conversation.id)) {
        selectConversation(conversation.id);
      }
    });

    conversationList.appendChild(btn);
  });
}

async function loadConversations() {
  try {
    const res = await fetch(`${API_BASE}/api/conversations`);
    if (!res.ok) {
      throw new Error(`Failed to load conversations: ${res.status}`);
    }

    const data = await res.json();
    conversations = Array.isArray(data) ? data : [];
    renderConversationList();

    if (selectedConversationId) {
      const selectedConversation = getConversationById(selectedConversationId);
      if (selectedConversation) {
        updateSelectedConversationInfo(selectedConversation);
      }
    }
  } catch (error) {
    console.error("Failed to load conversations:", error);
  }
}

async function selectConversation(id) {
  selectedConversationId = Number(id);
  renderConversationList();

  const localConversation = getConversationById(selectedConversationId);
  if (localConversation) {
    updateSelectedConversationInfo(localConversation);
  }

  clearRenderedMessages();

  try {
    const res = await fetch(`${API_BASE}/api/conversations/${selectedConversationId}/messages`);
    if (!res.ok) {
      throw new Error(`Failed to load messages: ${res.status}`);
    }

    const data = await res.json();

    upsertConversation(data.conversation, data.messages?.[data.messages.length - 1] || null);
    updateSelectedConversationInfo(data.conversation);
    renderConversationList();

    data.messages.forEach((message) => appendMessage(message));
    scrollAdminMessagesToBottom();
    adminMessageInput.focus();
  } catch (error) {
    console.error("Failed to select conversation:", error);
  }
}

async function sendAdminMessage(content, senderName) {
  const res = await fetch(`${API_BASE}/api/conversations/${selectedConversationId}/messages/admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender_name: senderName,
      content,
    }),
  });

  if (!res.ok) {
    throw new Error(`Reply failed: ${res.status}`);
  }
}

adminComposer.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!selectedConversationId) {
    alert("Select a conversation first.");
    return;
  }

  const content = adminMessageInput.value.trim();
  if (!content) return;

  const senderName = adminName.value.trim() || "Support Agent";

  adminMessageInput.value = "";

  const optimisticMessage = {
    conversation_id: selectedConversationId,
    sender_type: "admin",
    sender_name: senderName,
    content,
    created_at: new Date().toISOString(),
    pending: true,
  };

  const fingerprint = getMessageFingerprint(optimisticMessage);
  pendingAdminMessages.add(fingerprint);

  appendMessage(optimisticMessage);
  updateConversationWithMessage(optimisticMessage);
  renderConversationList();

  try {
    await sendAdminMessage(content, senderName);
  } catch (error) {
    console.error(error);
    pendingAdminMessages.delete(fingerprint);

    const pendingRow = adminMessages.querySelector(
      `.bubble-row[data-fingerprint="${CSS.escape(fingerprint)}"][data-pending="true"]`
    );

    if (pendingRow) {
      pendingRow.remove();
    }

    alert("Reply failed to send.");
    adminMessageInput.value = content;
  }
});

adminMessageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    adminComposer.requestSubmit();
  }
});

closeCaseBtn.addEventListener("click", async () => {
  if (!selectedConversationId) {
    alert("Select a conversation first.");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/conversations/${selectedConversationId}/close`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    if (!res.ok) {
      throw new Error(`Close failed: ${res.status}`);
    }

    const updatedConversation = await res.json();
    upsertConversation(updatedConversation, getConversationById(selectedConversationId)?.latest_message || null);
    updateSelectedConversationInfo(updatedConversation);
    renderConversationList();
  } catch (error) {
    console.error(error);
    alert("Could not close case.");
  }
});

refreshBtn.addEventListener("click", async () => {
  await loadConversations();

  if (selectedConversationId) {
    await selectConversation(selectedConversationId);
  }
});

function handleIncomingNewMessage(message) {
  updateConversationWithMessage(message);
  renderConversationList();

  if (Number(selectedConversationId) === Number(message.conversation_id)) {
    appendMessage(message);
  }
}

function connectAdminWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";

  if (ws) {
    ws.close();
  }

  ws = new WebSocket(`${protocol}://127.0.0.1:8000/ws/admin`);

  ws.onopen = () => {
    console.log("Admin WebSocket connected");
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "conversation_created") {
      upsertConversation(data.conversation, data.latest_message || null);
      renderConversationList();

      if (!selectedConversationId && data.conversation?.id) {
        selectConversation(data.conversation.id);
      }

      return;
    }

    if (data.type === "new_message" && data.message) {
      handleIncomingNewMessage(data.message);
      return;
    }
  };

  ws.onclose = () => {
    console.log("Admin WebSocket closed");
    setTimeout(connectAdminWebSocket, 1500);
  };

  ws.onerror = (error) => {
    console.error("Admin WebSocket error:", error);
  };
}

loadConversations();
connectAdminWebSocket();