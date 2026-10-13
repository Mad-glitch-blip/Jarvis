const $ = (id) => document.getElementById(id);

const coreButton = $("core-button");
const systemStatus = $("system-status");
const readyStatus = $("ready-status");
const instruction = $("instruction");

const chatPanel = $("chat-panel");
const closeChat = $("close-chat");
const chatForm = $("chat-form");
const userInput = $("user-input");
const sendButton = $("send-button");
const chatMessages = $("chat-messages");

const sidebar = $("history-sidebar");
const sidebarToggle = $("sidebar-toggle");
const sidebarBackdrop = $("sidebar-backdrop");
const closeSidebarButton = $("close-sidebar");
const newChatButton = $("new-chat-button");
const recentList = $("recent-list");

const ownerPanel = $("owner-panel");
const ownerModeButton = $("owner-mode-button");
const ownerClose = $("owner-close");
const ownerAuthButton = $("owner-auth-button");
const ownerLockButton = $("owner-lock-button");
const ownerSetupCode = $("owner-setup-code");
const ownerDescription = $("owner-description");
const ownerStatus = $("owner-status");

const appsPanel = $("apps-panel");
const appsResults = $("apps-results");
const appsScanStatus = $("apps-scan-status");
const appsSearchForm = $("apps-search-form");

const terminalPanel = $("terminal-panel");
const terminalOutput = $("terminal-output");
const terminalForm = $("terminal-form");
const terminalCommand = $("terminal-command");

let isActive = false;
let isThinking = false;
let currentConversationId = null;

let ownerToken = null;
let ownerIsConfigured = false;
let toastTimer = null;
let isScanning = false;

let recognition = null;
let isListening = false;
let wakeArmed = true;
let commandMode = false;
let restartTimer = null;
let subtitleTimer = null;
let speakingNow = false;

const WAKE_PHRASES = [
    "hey jarvis",
    "hey jervis",
    "hi jarvis",
    "ok jarvis",
    "okay jarvis",
    "jarvis"
];

async function apiRequest(url, options = {}) {
    const response = await fetch(url, options);
    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
            const data = contentType.includes("application/json")
                ? await response.json()
                : null;
            if (data?.error) message = data.error;
        } catch {}
        throw new Error(message);
    }

    if (contentType.includes("application/x-ndjson")) {
        return response;
    }

    return response.json();
}

function timeGreeting() {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
}

function toast(message) {
    const el = $("action-toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 3200);
}

function setSubtitle(text, mode = "idle") {
    const el = $("jarvis-subtitle");
    if (!el) return;

    el.classList.remove(
        "is-visible",
        "is-listening",
        "is-thinking",
        "is-speaking",
        "is-idle"
    );

    if (!text) {
        el.textContent = "";
        return;
    }

    el.textContent = text;
    el.classList.add("is-visible");

    if (mode === "listening") el.classList.add("is-listening");
    else if (mode === "thinking") el.classList.add("is-thinking");
    else if (mode === "speaking") el.classList.add("is-speaking");
    else el.classList.add("is-idle");

    clearTimeout(subtitleTimer);
    if (mode === "idle" || mode === "speaking") {
        subtitleTimer = setTimeout(() => {
            if (wakeArmed && !commandMode && !isThinking && !speakingNow) {
                setSubtitle("SAY  HEY JARVIS", "idle");
            }
        }, mode === "speaking" ? 9000 : 14000);
    }
}

function pickJarvisVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;

    const preferred = [
        /jenny/i,
        /aria/i,
        /sara/i,
        /guy/i,
        /neural/i,
        /natural/i,
        /google us english/i,
        /microsoft.*english/i
    ];

    for (const re of preferred) {
        const hit = voices.find((v) => re.test(v.name) && /en(-|_)?us/i.test(v.lang || "en"));
        if (hit) return hit;
    }

    return (
        voices.find((v) => /en(-|_)?us/i.test(v.lang) && !/david|zira|mark/i.test(v.name)) ||
        voices.find((v) => /en/i.test(v.lang)) ||
        voices[0]
    );
}

let currentAudio = null;

async function speakText(text) {
    const clean = String(text || "")
        .replace(/\[Executing[^\]]*\]/gi, "")
        .replace(/\[Tool[^\]]*\]/gi, "")
        .replace(/^JARVIS:\s*/i, "")
        .trim();

    if (!clean) return;

    try {
        if (recognition) recognition.stop();
    } catch {}

    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (currentAudio) {
        try {
            currentAudio.pause();
        } catch {}
        currentAudio = null;
    }

    speakingNow = true;
    const short = clean.length > 140 ? clean.slice(0, 137) + "…" : clean;
    setSubtitle(short, "speaking");

    try {
        const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: clean.slice(0, 1000) })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `TTS HTTP ${res.status}`);
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudio = audio;

        audio.onended = () => {
            speakingNow = false;
            URL.revokeObjectURL(url);
            currentAudio = null;
            if (!isThinking) setSubtitle("SAY  HEY JARVIS", "idle");
        };

        audio.onerror = () => {
            speakingNow = false;
            URL.revokeObjectURL(url);
            currentAudio = null;
            if (!isThinking) setSubtitle("SAY  HEY JARVIS", "idle");
        };

        await audio.play();
    } catch (error) {
        console.warn("Fish TTS failed, browser fallback:", error.message);
        // fallback: old browser voice so something still speaks
        if (!window.speechSynthesis) {
            speakingNow = false;
            setSubtitle("TTS UNAVAILABLE", "idle");
            return;
        }

        const u = new SpeechSynthesisUtterance(clean.slice(0, 600));
        u.rate = 1.08;
        u.pitch = 0.92;
        u.onend = () => {
            speakingNow = false;
            if (!isThinking) setSubtitle("SAY  HEY JARVIS", "idle");
        };
        u.onerror = () => {
            speakingNow = false;
            if (!isThinking) setSubtitle("SAY  HEY JARVIS", "idle");
        };
        window.speechSynthesis.speak(u);
    }
}

// Voices often load async
if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => {
        cachedVoice = pickJarvisVoice();
    };
}

function addMessage(text, sender, options = {}) {
    const message = document.createElement("p");
    message.className =
        sender === "user" ? "user-message" : "jarvis-message";

    if (options.streaming) message.classList.add("is-streaming");

    message.textContent =
        `${sender === "user" ? "ADMIN: " : "JARVIS: "}${text}`;

    chatMessages.appendChild(message);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return message;
}

function clearMessages() {
    chatMessages.replaceChildren();
}

function setChatOpen(open) {
    isActive = open;
    chatPanel.hidden = !open;

    systemStatus.textContent = open ? "CORE ACTIVATED" : "SYSTEM ONLINE";

    readyStatus.textContent = isThinking
        ? "THINKING"
        : open ? "ACTIVE" : "READY";

    instruction.textContent = open
        ? "JARVIS IS READY"
        : "CLICK THE CORE TO ACTIVATE";

    coreButton.setAttribute(
        "aria-label",
        open ? "Close JARVIS chat" : "Open JARVIS chat"
    );

    if (open) userInput.focus();
}

coreButton.addEventListener("click", () => {
    setChatOpen(chatPanel.hidden);
    startJarvisEar();
});

closeChat.addEventListener("click", () => {
    setChatOpen(false);
});

/* Sidebar */

function openSidebar() {
    sidebar.classList.add("open");
    document.body.classList.add("sidebar-open");
    sidebar.setAttribute("aria-hidden", "false");
    sidebarToggle.setAttribute("aria-expanded", "true");
    sidebarBackdrop.hidden = false;
    refreshRecentChats();
}

function closeSidebarPanel() {
    sidebar.classList.remove("open");
    document.body.classList.remove("sidebar-open");
    sidebar.setAttribute("aria-hidden", "true");
    sidebarToggle.setAttribute("aria-expanded", "false");
    sidebarBackdrop.hidden = true;
}

function toggleSidebar() {
    if (sidebar.classList.contains("open")) closeSidebarPanel();
    else openSidebar();
}

sidebarToggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleSidebar();
});

closeSidebarButton.addEventListener("click", closeSidebarPanel);
sidebarBackdrop.addEventListener("click", closeSidebarPanel);

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        closeSidebarPanel();
        for (const panel of [ownerPanel, appsPanel, terminalPanel]) {
            if (panel) panel.hidden = true;
        }
    }

    if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
    ) {
        event.preventDefault();
        toggleSidebar();
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setChatOpen(true);
    }
});

function formatDate(value) {
    if (!value) return "";
    const date = new Date(
        value.includes?.("T") ? value : value.replace(" ", "T") + "Z"
    );
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric"
    });
}

function makeRecentItem(conversation) {
    const item = document.createElement("div");
    item.className = "recent-item";

    if (Number(conversation.id) === Number(currentConversationId)) {
        item.classList.add("active");
    }

    const select = document.createElement("button");
    select.type = "button";
    select.className = "recent-select";
    select.title = conversation.title || "New conversation";

    const title = document.createElement("span");
    title.className = "recent-title";
    title.textContent = conversation.title || "New conversation";

    const date = document.createElement("span");
    date.className = "recent-date";
    date.textContent = formatDate(conversation.created_at);

    select.append(title, date);

    select.addEventListener("click", async () => {
        try {
            await loadConversation(conversation.id);
            closeSidebarPanel();
            setChatOpen(true);
        } catch (error) {
            addMessage(`Couldn't open conversation: ${error.message}`, "assistant");
        }
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "recent-delete";
    remove.textContent = "×";
    remove.title = "Delete conversation";
    remove.setAttribute(
        "aria-label",
        `Delete ${conversation.title || "conversation"}`
    );

    remove.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!confirm(
            `Delete "${conversation.title || "New conversation"}"? This cannot be undone.`
        )) return;

        try {
            await apiRequest(`/api/conversations/${conversation.id}`, {
                method: "DELETE"
            });

            if (Number(currentConversationId) === Number(conversation.id)) {
                currentConversationId = null;
                clearMessages();
                addMessage(
                    "Conversation deleted. Start a new chat whenever you're ready.",
                    "assistant"
                );
            }

            await refreshRecentChats();
        } catch (error) {
            alert(`Couldn't delete conversation: ${error.message}`);
        }
    });

    item.append(select, remove);
    return item;
}

async function refreshRecentChats() {
    try {
        const conversations = await apiRequest("/api/conversations");
        recentList.replaceChildren();

        if (!Array.isArray(conversations) || conversations.length === 0) {
            const empty = document.createElement("p");
            empty.className = "history-empty";
            empty.textContent = "No conversations yet. Start a new chat.";
            recentList.appendChild(empty);
            return;
        }

        conversations.forEach((c) => recentList.appendChild(makeRecentItem(c)));
    } catch (error) {
        recentList.replaceChildren();
        const empty = document.createElement("p");
        empty.className = "history-empty";
        empty.textContent =
            "Couldn't load recent chats. Check that JARVIS is running.";
        recentList.appendChild(empty);
        console.error("Recent chats failed to load:", error);
    }
}

async function loadConversation(id) {
    const messages = await apiRequest(`/api/conversations/${id}/messages`);
    currentConversationId = Number(id);
    clearMessages();

    for (const message of messages) {
        addMessage(message.content, message.role);
    }

    if (messages.length === 0) {
        addMessage(
            `${timeGreeting()}. Conversation ready. How can I assist you?`,
            "assistant"
        );
    }

    await refreshRecentChats();
}

async function startNewConversation() {
    const created = await apiRequest("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
    });

    currentConversationId = created.id;
    clearMessages();
    addMessage(
        `${timeGreeting()}. New conversation initiated. How may I assist you?`,
        "assistant"
    );
    setChatOpen(true);
    closeSidebarPanel();
    await refreshRecentChats();
}

async function loadLatestConversation() {
    try {
        const conversations = await apiRequest("/api/conversations");
        if (conversations.length > 0) {
            await loadConversation(conversations[0].id);
        } else {
            clearMessages();
            addMessage(
                `${timeGreeting()}. Systems online. All protocols are nominal. How may I assist you?`,
                "assistant"
            );
        }
    } catch (error) {
        console.error("Could not restore conversation:", error);
        clearMessages();
        addMessage(
            "Chat history could not be loaded. Check the server and refresh.",
            "assistant"
        );
    }
}

newChatButton.addEventListener("click", async () => {
    if (isThinking) return;
    try {
        await startNewConversation();
    } catch (error) {
        addMessage(`Couldn't start a new chat: ${error.message}`, "assistant");
    }
});

/* Streaming chat */

async function streamChat(text, messageElement) {
    const headers = { "Content-Type": "application/json" };
    if (ownerToken) headers.Authorization = `Bearer ${ownerToken}`;

    const response = await apiRequest("/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({
            text,
            conversationId: currentConversationId
        })
    });

    if (!response.body) {
        throw new Error("Streaming isn't supported by this browser.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let receivedDone = false;
    let visibleAnswer = "";

    messageElement.textContent = "JARVIS: ";
    messageElement.classList.add("is-streaming");

    function processLine(line) {
        if (!line.trim()) return;
        const item = JSON.parse(line);

        if (item.error) throw new Error(item.error);

        if (item.token) {
            visibleAnswer += item.token;
            messageElement.textContent = "JARVIS: " + visibleAnswer;
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        if (item.done) {
            receivedDone = true;
            if (item.conversationId) {
                currentConversationId = item.conversationId;
            }
            if (Number.isFinite(item.responseTimeMs)) {
                readyStatus.textContent =
                    `ACTIVE · ${(item.responseTimeMs / 1000).toFixed(1)}s`;
            }
        }
    }

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) processLine(line);
        }

        buffer += decoder.decode();
        if (buffer.trim()) processLine(buffer);

        if (!receivedDone) {
            throw new Error("The response stream ended before JARVIS finished.");
        }
        if (!visibleAnswer.trim()) {
            throw new Error("JARVIS returned an empty answer.");
        }

        speakText(visibleAnswer);
    } finally {
        messageElement.classList.remove("is-streaming");
        reader.releaseLock();
    }

    await refreshRecentChats();
}

chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = userInput.value.trim();
    if (!text || isThinking) return;

    addMessage(text, "user");
    userInput.value = "";

    isThinking = true;
    userInput.disabled = true;
    sendButton.disabled = true;
    readyStatus.textContent = "THINKING";
    setSubtitle("THINKING…", "thinking");

    const responseMessage = addMessage("", "assistant", { streaming: true });

    try {
        if (currentConversationId === null) {
            const created = await apiRequest("/api/conversations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({})
            });
            currentConversationId = created.id;
        }
        await streamChat(text, responseMessage);
    } catch (error) {
        responseMessage.classList.remove("is-streaming");
        responseMessage.textContent = `JARVIS: ${error.message}`;
        setSubtitle("ERROR — CHECK OLLAMA / SERVER", "idle");
        console.error("JARVIS error:", error);
    } finally {
        isThinking = false;
        userInput.disabled = false;
        sendButton.disabled = false;
        if (readyStatus.textContent === "THINKING") {
            readyStatus.textContent = "ACTIVE";
        }
        userInput.focus();
        chatMessages.scrollTop = chatMessages.scrollHeight;
        refreshRecentChats();
    }
});

/* ========== HEY JARVIS — always-on ear ========== */

function normalizeHeard(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function containsWake(phrase) {
    const t = normalizeHeard(phrase);
    return WAKE_PHRASES.some(
        (w) =>
            t === w ||
            t.startsWith(w + " ") ||
            t.includes(" " + w + " ") ||
            t.endsWith(" " + w)
    );
}

function stripWake(phrase) {
    let t = normalizeHeard(phrase);
    for (const w of WAKE_PHRASES) {
        if (t === w) return "";
        if (t.startsWith(w + " ")) {
            return t.slice(w.length).trim();
        }
    }
    t = t.replace(/^(hey|hi|ok|okay)\s+/, "");
    if (t.startsWith("jarvis ")) t = t.slice(7).trim();
    else if (t === "jarvis") t = "";
    return t;
}

function runVoiceCommand(text) {
    const cmd = String(text || "").trim();
    if (!cmd) {
        setSubtitle("SAY  HEY JARVIS", "idle");
        return;
    }

    if (!isActive) setChatOpen(true);
    userInput.value = cmd;
    setSubtitle("THINKING…", "thinking");
    chatForm.requestSubmit();
}

function handleVoiceTranscript(raw) {
    if (speakingNow || isThinking) return;

    const heard = (raw || "").trim();
    if (!heard) return;

    const norm = normalizeHeard(heard);

    if (wakeArmed && !commandMode) {
        if (!containsWake(norm)) return;

        const after = stripWake(heard);
        if (after.length > 2) {
            runVoiceCommand(after);
            return;
        }

        commandMode = true;
        wakeArmed = false;
        setSubtitle("YES SIR?  LISTENING…", "listening");
        speakText("Yes sir?");
        return;
    }

    if (commandMode) {
        commandMode = false;
        wakeArmed = true;
        runVoiceCommand(heard);
    }
}

function startJarvisEar() {
    const VoiceRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!VoiceRec) {
        setSubtitle("VOICE NEEDS CHROME OR EDGE", "idle");
        return;
    }

    if (recognition) {
        try {
            recognition.onend = null;
            recognition.stop();
        } catch {}
    }

    recognition = new VoiceRec();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = true;

    recognition.onstart = () => {
        isListening = true;
        if (wakeArmed && !commandMode && !isThinking && !speakingNow) {
            setSubtitle("SAY  HEY JARVIS", "idle");
        }
    };

    recognition.onend = () => {
        isListening = false;
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
            if (document.visibilityState === "visible") startJarvisEar();
        }, 450);
    };

    recognition.onerror = (event) => {
        isListening = false;
        if (event.error === "not-allowed") {
            setSubtitle("ALLOW MICROPHONE FOR LOCALHOST", "idle");
            return;
        }
    };

    recognition.onresult = (event) => {
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
                finalText += event.results[i][0].transcript;
            }
        }
        if (finalText) handleVoiceTranscript(finalText);
    };

    try {
        recognition.start();
    } catch {
        /* already started */
    }
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") startJarvisEar();
});

/* Owner mode */

function openUtility(panel) {
    for (const other of [ownerPanel, appsPanel, terminalPanel]) {
        if (other) other.hidden = other !== panel;
    }
}

function base64urlToBytes(value) {
    const padded =
        value.replace(/-/g, "+").replace(/_/g, "/") +
        "===".slice((value.length + 3) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function bytesToBase64url(value) {
    const bytes = new Uint8Array(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function prepareCredentialOptions(options) {
    options.challenge = base64urlToBytes(options.challenge);
    if (options.user?.id) {
        options.user.id = base64urlToBytes(options.user.id);
    }
    if (options.allowCredentials) {
        options.allowCredentials = options.allowCredentials.map((item) => ({
            ...item,
            id: base64urlToBytes(item.id)
        }));
    }
    if (options.excludeCredentials) {
        options.excludeCredentials = options.excludeCredentials.map((item) => ({
            ...item,
            id: base64urlToBytes(item.id)
        }));
    }
    return options;
}

function serializeCredential(credential) {
    const result = {
        id: credential.id,
        rawId: bytesToBase64url(credential.rawId),
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {}
    };

    if (credential.response.attestationObject) {
        result.response.attestationObject = bytesToBase64url(
            credential.response.attestationObject
        );
        result.response.clientDataJSON = bytesToBase64url(
            credential.response.clientDataJSON
        );
        result.response.transports =
            credential.response.getTransports?.() || [];
    } else {
        result.response.authenticatorData = bytesToBase64url(
            credential.response.authenticatorData
        );
        result.response.clientDataJSON = bytesToBase64url(
            credential.response.clientDataJSON
        );
        result.response.signature = bytesToBase64url(
            credential.response.signature
        );
        if (credential.response.userHandle) {
            result.response.userHandle = bytesToBase64url(
                credential.response.userHandle
            );
        }
    }
    return result;
}

async function refreshOwnerStatus() {
    try {
        const status = await apiRequest("/api/owner/status");
        ownerIsConfigured = status.configured;

        ownerDescription.textContent = status.configured
            ? "Use Windows Hello (PIN, fingerprint, or face if configured on Windows) to unlock owner tools."
            : "First-time setup: enter the one-time code printed in the server terminal, then register Windows Hello.";

        ownerAuthButton.textContent = status.configured
            ? "UNLOCK WITH WINDOWS HELLO"
            : "SET UP WINDOWS HELLO";

        ownerSetupCode.hidden = status.configured;
        ownerLockButton.hidden = !ownerToken;

        ownerStatus.textContent = ownerToken
            ? "Owner mode is unlocked for this server session."
            : "Owner mode is locked.";
    } catch (error) {
        ownerStatus.textContent =
            `Couldn't check owner status: ${error.message}`;
    }
}

async function ownerRequest(url, options = {}) {
    if (!ownerToken) {
        throw new Error(
            "Owner mode is locked. Unlock it with Windows Hello first."
        );
    }
    const headers = {
        ...(options.headers || {}),
        Authorization: `Bearer ${ownerToken}`
    };
    return apiRequest(url, { ...options, headers });
}

ownerModeButton.addEventListener("click", async () => {
    openUtility(ownerPanel);
    await refreshOwnerStatus();
});

ownerClose.addEventListener("click", () => {
    ownerPanel.hidden = true;
});

ownerAuthButton.addEventListener("click", async () => {
    ownerAuthButton.disabled = true;
    ownerStatus.textContent = "Waiting for Windows Hello…";

    try {
        if (!window.PublicKeyCredential || !navigator.credentials) {
            throw new Error(
                "This browser does not support passkeys. Try Edge or Chrome."
            );
        }

        if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
            throw new Error(
                "Open JARVIS at http://localhost:3000 for Windows Hello."
            );
        }

        if (!ownerIsConfigured) {
            const options = await apiRequest("/api/owner/register/options", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    setupCode: ownerSetupCode.value.trim()
                })
            });

            const credential = await navigator.credentials.create({
                publicKey: prepareCredentialOptions(options)
            });

            const result = await apiRequest("/api/owner/register/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    credential: serializeCredential(credential)
                })
            });

            ownerToken = result.token;
            ownerStatus.textContent =
                "Windows Hello registered. Owner mode unlocked.";
            toast("Windows Hello configured.");
        } else {
            const options = await apiRequest("/api/owner/login/options", {
                method: "POST"
            });

            const credential = await navigator.credentials.get({
                publicKey: prepareCredentialOptions(options)
            });

            const result = await apiRequest("/api/owner/login/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    credential: serializeCredential(credential)
                })
            });

            ownerToken = result.token;
            ownerStatus.textContent =
                "Owner mode unlocked for 30 minutes of activity.";
            toast("Owner mode unlocked.");
        }

        ownerLockButton.hidden = false;
        await refreshOwnerStatus();
    } catch (error) {
        ownerStatus.textContent =
            error.message || "Windows Hello authentication failed.";
    } finally {
        ownerAuthButton.disabled = false;
    }
});

ownerLockButton.addEventListener("click", async () => {
    try {
        if (ownerToken) {
            await fetch("/api/owner/logout", {
                method: "POST",
                headers: { Authorization: `Bearer ${ownerToken}` }
            });
        }
    } catch {}

    ownerToken = null;
    ownerStatus.textContent = "Owner mode locked.";
    ownerLockButton.hidden = true;
    toast("Owner mode locked.");
});

/* App scanner */

async function scanLaunchers() {
    if (isScanning) return;

    if (!ownerToken) {
        openUtility(ownerPanel);
        await refreshOwnerStatus();
        toast("Unlock Owner Mode before scanning apps.");
        return;
    }

    isScanning = true;
    const mainScanButton = $("app-scan-button");
    const scanAgainButton = $("scan-again-button");

    if (mainScanButton) mainScanButton.disabled = true;
    if (scanAgainButton) {
        scanAgainButton.disabled = true;
        scanAgainButton.textContent = "SCANNING…";
    }

    appsScanStatus.textContent =
        "Discovering Windows apps and desktop shortcuts…";
    appsResults.replaceChildren();

    const progress = document.createElement("p");
    progress.className = "utility-copy";
    progress.textContent =
        "Searching Windows app registrations, Start Menu, and Desktop shortcuts.";
    appsResults.appendChild(progress);

    try {
        const result = await ownerRequest("/api/apps/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: ($("apps-search-input")?.value || "").trim()
            })
        });

        appsResults.replaceChildren();

        if (!Array.isArray(result.apps) || result.apps.length === 0) {
            appsScanStatus.textContent =
                `Scan complete. Checked ${result.registeredAppsFound ?? 0} registered apps and ${result.scannedShortcuts ?? 0} shortcuts. No matches found.`;
            const empty = document.createElement("p");
            empty.className = "utility-copy";
            empty.textContent =
                "Try another search, or clear the search box to show all discovered apps.";
            appsResults.appendChild(empty);
            return;
        }

        appsScanStatus.textContent =
            `Found ${result.apps.length} match(es). Windows apps: ${result.registeredAppsFound ?? 0}; shortcuts checked: ${result.scannedShortcuts ?? 0}.`;

        for (const app of result.apps) {
            const row = document.createElement("div");
            row.className = "app-result";

            const info = document.createElement("div");
            info.className = "app-result-info";

            const name = document.createElement("strong");
            name.textContent = app.name;

            const source = document.createElement("small");
            source.textContent = app.source || "Windows app";

            info.append(name, source);

            const launch = document.createElement("button");
            launch.type = "button";
            launch.textContent = "LAUNCH";
            launch.disabled = app.canLaunch !== true;

            launch.addEventListener("click", async () => {
                if (!ownerToken) {
                    toast("Owner Mode is locked.");
                    return;
                }
                if (app.canLaunch !== true) {
                    toast("This app is not available to launch.");
                    return;
                }
                if (!confirm(`Launch ${app.name}?`)) return;

                launch.disabled = true;
                launch.textContent = "LAUNCHING…";

                try {
                    const launched = await ownerRequest("/api/apps/launch", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: app.id })
                    });
                    toast(`${launched.name || app.name}: launch request sent.`);
                } catch (error) {
                    alert(`Couldn't launch ${app.name}: ${error.message}`);
                } finally {
                    launch.disabled = app.canLaunch !== true;
                    launch.textContent = "LAUNCH";
                }
            });

            row.append(info, launch);
            appsResults.appendChild(row);
        }
    } catch (error) {
        appsResults.replaceChildren();
        appsScanStatus.textContent = `Scan failed: ${error.message}`;
        console.error("App scan failed:", error);
    } finally {
        isScanning = false;
        if (mainScanButton) mainScanButton.disabled = false;
        if (scanAgainButton) {
            scanAgainButton.disabled = false;
            scanAgainButton.textContent = "SCAN";
        }
    }
}

$("app-scan-button")?.addEventListener("click", async () => {
    if (!ownerToken) {
        openUtility(ownerPanel);
        await refreshOwnerStatus();
        toast("Unlock Owner Mode before scanning apps.");
        return;
    }
    openUtility(appsPanel);
    await scanLaunchers();
});

appsSearchForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isScanning) return;
    if (!ownerToken) {
        openUtility(ownerPanel);
        await refreshOwnerStatus();
        toast("Unlock Owner Mode before scanning apps.");
        return;
    }
    await scanLaunchers();
});

$("apps-close")?.addEventListener("click", () => {
    appsPanel.hidden = true;
});

/* Websites */

$("website-button")?.addEventListener("click", async () => {
    if (!ownerToken) {
        openUtility(ownerPanel);
        await refreshOwnerStatus();
        toast("Unlock Owner Mode to open approved websites.");
        return;
    }

    const choice = prompt(
        "Approved site?\nYouTube, Instagram, Google, GitHub, Gmail, Twitter, X",
        "YouTube"
    );
    if (!choice) return;

    const site = choice.trim().toLowerCase();
    const allowed = [
        "youtube",
        "instagram",
        "google",
        "github",
        "gmail",
        "twitter",
        "x"
    ];
    if (!allowed.includes(site)) {
        toast("Approved: " + allowed.join(", "));
        return;
    }
    if (!confirm(`Open ${site} in your browser?`)) return;

    try {
        const result = await ownerRequest("/api/websites/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ site })
        });
        toast(`${result.site || site} opened.`);
    } catch (error) {
        alert(error.message);
    }
});

/* Terminal */

$("terminal-button")?.addEventListener("click", async () => {
    if (!ownerToken) {
        openUtility(ownerPanel);
        await refreshOwnerStatus();
        toast("Unlock Owner Mode to use the console.");
        return;
    }
    openUtility(terminalPanel);
    terminalCommand.focus();
});

$("terminal-close")?.addEventListener("click", () => {
    terminalPanel.hidden = true;
});

terminalForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const command = terminalCommand.value.trim();
    if (!command) return;

    terminalOutput.textContent += `\n\nPS JARVIS> ${command}\n`;
    terminalCommand.value = "";

    try {
        const result = await ownerRequest("/api/owner/terminal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command })
        });
        terminalOutput.textContent += result.output;
    } catch (error) {
        terminalOutput.textContent += `ERROR: ${error.message}`;
    }

    terminalOutput.scrollTop = terminalOutput.scrollHeight;
});

/* Initialize */

sidebar.setAttribute("aria-hidden", "true");
sidebarToggle.setAttribute("aria-expanded", "false");
sidebarBackdrop.hidden = true;

loadLatestConversation();

setSubtitle("SAY  HEY JARVIS", "idle");
setTimeout(() => startJarvisEar(), 900);