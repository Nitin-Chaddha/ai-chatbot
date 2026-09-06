const API_URL = "/api/chat";
const EXTRACT_URL = "/api/extract-file";

const STORAGE_KEY = "aiAssistantConversationsV2";
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
const MAX_TEXT_CHARS = 60000;

// =====================================================
// DOM ELEMENTS
// =====================================================

const messagesContainer = document.getElementById("messages");
const input = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");

const clearButton = document.getElementById("clearButton");
const newChatButton = document.getElementById("newChatButton");
const chatHistory = document.getElementById("chatHistory");
const clearHistoryButton =
    document.getElementById("clearHistoryButton");

const fileInput = document.getElementById("fileInput");
const attachButton = document.getElementById("attachButton");
const attachmentPreview =
    document.getElementById("attachmentPreview");

const micButton = document.getElementById("micButton");
const voiceStatus = document.getElementById("voiceStatus");

const menuButton = document.getElementById("menuButton");
const sidebar = document.getElementById("sidebar");
const sidebarOverlay =
    document.getElementById("sidebarOverlay");

const chatSubtitle =
    document.getElementById("chatSubtitle");

// =====================================================
// STATE
// =====================================================

let conversations = loadConversations();
let currentConversation = null;

let pendingAttachment = null;

let recognition = null;
let isListening = false;
let isSending = false;

// =====================================================
// STORAGE
// =====================================================

function loadConversations() {
    try {
        const saved =
            localStorage.getItem(STORAGE_KEY);

        if (!saved) {
            return [];
        }

        const parsed = JSON.parse(saved);

        return Array.isArray(parsed)
            ? parsed
            : [];

    } catch (error) {

        console.error(
            "Could not load chat history:",
            error
        );

        return [];
    }
}

function saveConversations() {

    try {

        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(
                conversations.slice(0, 30)
            )
        );

    } catch (error) {

        console.warn(
            "Could not save complete chat history:",
            error
        );

        try {

            const reduced =
                conversations.map(chat => ({
                    ...chat,

                    lastImage: null,

                    messages:
                        chat.messages.map(
                            message => ({
                                ...message,

                                attachment:
                                    message
                                        .attachment
                                        ?.type ===
                                    "image"
                                        ? {
                                              type:
                                                  "image",

                                              name:
                                                  message
                                                      .attachment
                                                      .name
                                          }
                                        : message.attachment
                            })
                        )
                }));

            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(
                    reduced.slice(0, 30)
                )
            );

        } catch (secondError) {

            console.error(
                "Could not save chat history:",
                secondError
            );
        }
    }
}

// =====================================================
// HELPERS
// =====================================================

function makeId(prefix = "id") {

    return (
        prefix +
        "_" +
        Date.now() +
        "_" +
        Math.random()
            .toString(36)
            .slice(2, 9)
    );
}

function escapeHtml(text) {

    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatText(text) {

    if (!text) {
        return "";
    }

    let safe =
        escapeHtml(String(text));

    safe = safe.replace(
        /```([\s\S]*?)```/g,
        (_, code) =>
            `<pre><code>${code.trim()}</code></pre>`
    );

    safe = safe.replace(
        /`([^`]+)`/g,
        "<code>$1</code>"
    );

    safe = safe.replace(
        /\*\*([^*]+)\*\*/g,
        "<strong>$1</strong>"
    );

    safe = safe.replace(
        /\n/g,
        "<br>"
    );

    return safe;
}

// =====================================================
// CREATE CONVERSATION
// =====================================================

function createConversation() {

    return {

        id: makeId("chat"),

        title: "New Chat",

        sessionId: makeId("session"),

        messages: [],

        lastImage: null,

        createdAt: Date.now(),

        updatedAt: Date.now()
    };
}

function ensureConversation() {

    if (!currentConversation) {

        currentConversation =
            createConversation();

        conversations.unshift(
            currentConversation
        );

        saveConversations();
    }
}

// =====================================================
// START NEW CHAT
// =====================================================

function startNewChat() {

    currentConversation =
        createConversation();

    conversations.unshift(
        currentConversation
    );

    pendingAttachment = null;

    clearAttachmentPreview();

    renderConversation();

    renderChatHistory();

    saveConversations();

    closeMobileSidebar();

    if (input) {
        input.focus();
    }
}

// =====================================================
// SELECT CHAT
// =====================================================

function selectConversation(id) {

    const found =
        conversations.find(
            conversation =>
                conversation.id === id
        );

    if (!found) {
        return;
    }

    currentConversation = found;

    pendingAttachment = null;

    clearAttachmentPreview();

    renderConversation();

    closeMobileSidebar();

    if (input) {
        input.focus();
    }
}

// =====================================================
// UPDATE CHAT TITLE
// =====================================================

function updateTitleFromMessage(text) {

    if (!currentConversation) {
        return;
    }

    if (
        currentConversation.title !==
        "New Chat"
    ) {
        return;
    }

    const clean =
        text
            .replace(/\s+/g, " ")
            .trim();

    if (!clean) {
        return;
    }

    currentConversation.title =
        clean.length > 34
            ? clean.slice(0, 34) + "…"
            : clean;
}

// =====================================================
// DELETE ONE CONVERSATION
// NO ALERT / NO CONFIRM
// =====================================================

function deleteConversation(id) {

    const index =
        conversations.findIndex(
            conversation =>
                conversation.id === id
        );

    if (index === -1) {
        return;
    }

    const deletingCurrent =
        currentConversation &&
        currentConversation.id === id;

    conversations.splice(
        index,
        1
    );

    saveConversations();

    if (deletingCurrent) {

        if (conversations.length > 0) {

            conversations.sort(
                (a, b) =>
                    b.updatedAt -
                    a.updatedAt
            );

            currentConversation =
                conversations[0];

        } else {

            currentConversation =
                createConversation();

            conversations.push(
                currentConversation
            );
        }

        pendingAttachment = null;

        clearAttachmentPreview();

        renderConversation();

    } else {

        renderChatHistory();
    }

    if (input) {
        input.focus();
    }
}

// =====================================================
// RENDER CHAT HISTORY
// =====================================================

function renderChatHistory() {

    if (!chatHistory) {
        return;
    }

    chatHistory.innerHTML = "";

    if (!conversations.length) {

        chatHistory.innerHTML = `
            <div class="empty-history">
                No saved chats yet.
            </div>
        `;

        return;
    }

    [...conversations]
        .sort(
            (a, b) =>
                b.updatedAt -
                a.updatedAt
        )
        .forEach(chat => {

            const item =
                document.createElement(
                    "div"
                );

            item.className =
                "history-item" +
                (
                    currentConversation &&
                    currentConversation.id ===
                        chat.id
                        ? " active"
                        : ""
                );

            // -----------------------------------------
            // CHAT BUTTON
            // -----------------------------------------

            const chatButton =
                document.createElement(
                    "button"
                );

            chatButton.type =
                "button";

            chatButton.className =
                "history-chat-button";

            chatButton.title =
                chat.title ||
                "New Chat";

            chatButton.innerHTML = `
                <span class="history-icon">
                    💬
                </span>

                <span class="history-title">
                    ${escapeHtml(
                        chat.title ||
                            "New Chat"
                    )}
                </span>
            `;

            chatButton.addEventListener(
                "click",
                () => {
                    selectConversation(
                        chat.id
                    );
                }
            );

            // -----------------------------------------
            // DELETE BUTTON
            // -----------------------------------------

            const deleteButton =
                document.createElement(
                    "button"
                );

            deleteButton.type =
                "button";

            deleteButton.className =
                "history-delete-button";

            deleteButton.title =
                "Delete chat";

            deleteButton.setAttribute(
                "aria-label",
                "Delete chat"
            );

            deleteButton.innerHTML =
                "🗑";

            deleteButton.addEventListener(
                "click",
                event => {

                    event.preventDefault();

                    event.stopPropagation();

                    deleteConversation(
                        chat.id
                    );
                }
            );

            item.appendChild(
                chatButton
            );

            item.appendChild(
                deleteButton
            );

            chatHistory.appendChild(
                item
            );
        });
}

// =====================================================
// RENDER CURRENT CONVERSATION
// =====================================================

function renderConversation() {

    ensureConversation();

    if (!messagesContainer) {
        return;
    }

    messagesContainer.innerHTML =
        "";

    currentConversation.messages
        .forEach(message => {

            addMessage(
                message.role,
                message.content,
                false,
                message.attachment ||
                    null
            );
        });

    if (chatSubtitle) {

        chatSubtitle.textContent =
            currentConversation
                .messages.length
                ? currentConversation.title
                : "Ask me anything";
    }

    renderChatHistory();

    messagesContainer.scrollTop =
        messagesContainer.scrollHeight;
}

// =====================================================
// ADD MESSAGE TO UI
// =====================================================

function addMessage(
    role,
    text,
    save = true,
    attachment = null
) {

    if (!messagesContainer) {
        return;
    }

    const wrapper =
        document.createElement(
            "div"
        );

    wrapper.className =
        role === "user"
            ? "message user-message"
            : "message ai-message";

    const attachmentHtml =
        attachment?.type ===
            "image" &&
        attachment.data
            ? `
                <div class="attached-image">
                    <img
                        src="${attachment.data}"
                        alt="Uploaded image"
                    >
                </div>
              `
            : "";

    const speakHtml =
        role === "assistant"
            ? `
                <div class="message-actions">
                    <button
                        class="speak-button"
                        type="button"
                    >
                        🔊 Read aloud
                    </button>
                </div>
              `
            : "";

    wrapper.innerHTML = `

        <div class="message-label">
            ${
                role === "user"
                    ? "You"
                    : "AI Assistant"
            }
        </div>

        <div class="message-row">

            <div class="message-avatar">
                ${
                    role === "user"
                        ? "YOU"
                        : "AI"
                }
            </div>

            <div class="message-content-wrap">

                ${attachmentHtml}

                <div class="message-bubble">
                    ${formatText(text)}
                </div>

                ${speakHtml}

            </div>

        </div>
    `;

    if (role === "assistant") {

        const speakButton =
            wrapper.querySelector(
                ".speak-button"
            );

        if (speakButton) {

            speakButton.addEventListener(
                "click",
                () =>
                    speakText(
                        text,
                        speakButton
                    )
            );
        }
    }

    messagesContainer.appendChild(
        wrapper
    );

    messagesContainer.scrollTop =
        messagesContainer.scrollHeight;

    if (
        save &&
        currentConversation
    ) {

        currentConversation.messages.push(
            {
                role,
                content: text,
                attachment:
                    attachment || null
            }
        );

        currentConversation.updatedAt =
            Date.now();

        saveConversations();

        renderChatHistory();
    }
}

// =====================================================
// LOADING MESSAGE
// =====================================================

function addLoadingMessage() {

    if (!messagesContainer) {
        return;
    }

    removeLoadingMessage();

    const loading =
        document.createElement(
            "div"
        );

    loading.id =
        "loadingMessage";

    loading.className =
        "message ai-message";

    loading.innerHTML = `

        <div class="message-label">
            AI Assistant
        </div>

        <div class="message-row">

            <div class="message-avatar">
                AI
            </div>

            <div class="message-content-wrap">

                <div class="message-bubble">

                    <span class="typing">
                        Thinking...
                    </span>

                </div>

            </div>

        </div>
    `;

    messagesContainer.appendChild(
        loading
    );

    messagesContainer.scrollTop =
        messagesContainer.scrollHeight;
}

function removeLoadingMessage() {

    const loading =
        document.getElementById(
            "loadingMessage"
        );

    if (loading) {
        loading.remove();
    }
}

// =====================================================
// SEND MESSAGE
// =====================================================

async function sendMessage() {

    if (isSending) {
        return;
    }

    if (!input) {

        console.error(
            "messageInput element was not found."
        );

        return;
    }

    const text =
        input.value.trim();

    if (
        !text &&
        !pendingAttachment
    ) {
        return;
    }

    ensureConversation();

    const attachment =
        pendingAttachment;

    const displayText =
        text ||
        (
            attachment?.type ===
            "image"
                ? `Please analyze this image: ${attachment.name}`
                : `Please analyze the uploaded file: ${
                      attachment?.name ||
                      "file"
                  }`
        );

    const apiContent =
        attachment?.type ===
        "file"
            ? buildFilePrompt(
                  attachment,
                  text
              )
            : displayText;

    updateTitleFromMessage(
        displayText
    );

    const storedAttachment =
        attachment?.type ===
        "image"
            ? {
                  type: "image",
                  name: attachment.name,
                  mime: attachment.mime,
                  data: attachment.data
              }
            : attachment
            ? {
                  type: "file",
                  name: attachment.name,
                  mime: attachment.mime
              }
            : null;

    currentConversation.messages.push(
        {
            role: "user",
            content: apiContent,
            attachment:
                storedAttachment
        }
    );

    currentConversation.updatedAt =
        Date.now();

    if (
        attachment?.type ===
        "image"
    ) {

        currentConversation.lastImage =
            {
                type: "image",
                name: attachment.name,
                mime: attachment.mime,
                data: attachment.data
            };
    }

    saveConversations();

    addMessage(
        "user",
        displayText,
        false,
        attachment
    );

    input.value = "";

    input.style.height =
        "auto";

    pendingAttachment = null;

    clearAttachmentPreview();

    isSending = true;

    if (sendButton) {
        sendButton.disabled =
            true;
    }

    if (attachButton) {
        attachButton.disabled =
            true;
    }

    if (micButton) {
        micButton.disabled =
            true;
    }

    addLoadingMessage();

    try {

        const apiMessages =
            buildApiMessages();

        console.log(
            "Sending request to:",
            API_URL
        );

        const response =
            await fetch(
                API_URL,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify(
                        {
                            messages:
                                apiMessages,

                            session_id:
                                currentConversation
                                    .sessionId
                        }
                    )
                }
            );

        const rawResponse =
            await response.text();

        removeLoadingMessage();

        console.log(
            "Backend status:",
            response.status
        );

        console.log(
            "Backend response:",
            rawResponse
        );

        let data = null;

        try {

            data =
                rawResponse
                    ? JSON.parse(
                          rawResponse
                      )
                    : null;

        } catch {

            throw new Error(
                `Backend returned invalid JSON (HTTP ${response.status}). ` +
                `Make sure the backend is running at http://localhost:5000.`
            );
        }

        if (
            !response.ok ||
            !data?.success
        ) {

            throw new Error(
                data?.error ||
                `Server error (HTTP ${response.status}).`
            );
        }

        const reply =
            data.reply ||
            "I received your message.";

        currentConversation.messages.push(
            {
                role: "assistant",
                content: reply
            }
        );

        currentConversation.updatedAt =
            Date.now();

        saveConversations();

        addMessage(
            "assistant",
            reply,
            false
        );

        renderChatHistory();

        if (chatSubtitle) {

            chatSubtitle.textContent =
                currentConversation.title;
        }

    } catch (error) {

        console.error(
            "Chat request error:",
            error
        );

        removeLoadingMessage();

        const errorMessage =
            error?.message ||
            "Something went wrong.";

        addMessage(
            "assistant",
            `Sorry, I couldn't get a response.

Error: ${errorMessage}`,
            false
        );

    } finally {

        isSending = false;

        if (sendButton) {
            sendButton.disabled =
                false;
        }

        if (attachButton) {
            attachButton.disabled =
                false;
        }

        if (micButton) {
            micButton.disabled =
                false;
        }

        input.focus();
    }
}

// =====================================================
// BUILD API MESSAGES
// =====================================================

function buildApiMessages() {

    if (!currentConversation) {
        return [];
    }

    return currentConversation.messages
        .map((message, index) => {

            const isLastUserMessage =
                message.role ===
                    "user" &&
                index ===
                    currentConversation
                        .messages.length -
                        1;

            if (
                isLastUserMessage &&
                currentConversation.lastImage
            ) {

                return {

                    role: "user",

                    content: [

                        {
                            type: "text",

                            text:
                                message.content
                        },

                        {
                            type:
                                "image_url",

                            image_url: {

                                url:
                                    currentConversation
                                        .lastImage
                                        .data
                            }
                        }

                    ]
                };
            }

            return {

                role:
                    message.role,

                content:
                    message.content
            };

        })
        .slice(-20);
}

// =====================================================
// FILE HANDLING
// =====================================================

async function handleFile(file) {

    if (!file) {
        return;
    }

    try {

        // ---------------------------------------------
        // IMAGE
        // ---------------------------------------------

        if (
            file.type &&
            file.type.startsWith(
                "image/"
            )
        ) {

            if (
                file.size >
                MAX_IMAGE_BYTES
            ) {

                throw new Error(
                    "Please choose an image smaller than 2.5 MB."
                );
            }

            const data =
                await readAsDataURL(
                    file
                );

            pendingAttachment = {

                type: "image",

                name: file.name,

                mime: file.type,

                data
            };

            showAttachmentPreview(
                pendingAttachment
            );

            return;
        }

        // ---------------------------------------------
        // TEXT FILE
        // ---------------------------------------------

        const textLike =
            /\.(txt|md|csv|json|js|html|css|xml|log)$/i.test(
                file.name
            );

        let text = "";

        if (textLike) {

            text =
                await readAsText(
                    file
                );

        }

        // ---------------------------------------------
        // PDF / DOCX
        // ---------------------------------------------

        else if (
            file.type ===
                "application/pdf" ||
            /\.pdf$/i.test(
                file.name
            ) ||
            /\.docx$/i.test(
                file.name
            )
        ) {

            const formData =
                new FormData();

            formData.append(
                "file",
                file
            );

            const response =
                await fetch(
                    EXTRACT_URL,
                    {
                        method: "POST",
                        body: formData
                    }
                );

            const rawResponse =
                await response.text();

            let data = null;

            try {

                data =
                    rawResponse
                        ? JSON.parse(
                              rawResponse
                          )
                        : null;

            } catch {

                throw new Error(
                    `File service returned invalid JSON (HTTP ${response.status}).`
                );
            }

            if (
                !response.ok ||
                !data?.success
            ) {

                throw new Error(
                    data?.error ||
                    "Could not read this file."
                );
            }

            text =
                data.text || "";
        }

        // ---------------------------------------------
        // UNSUPPORTED
        // ---------------------------------------------

        else {

            throw new Error(
                "Supported files: TXT, MD, CSV, JSON, JS, HTML, CSS, XML, PDF and DOCX."
            );
        }

        text =
            text.slice(
                0,
                MAX_TEXT_CHARS
            );

        pendingAttachment = {

            type: "file",

            name: file.name,

            mime:
                file.type ||
                "application/octet-stream",

            text
        };

        showAttachmentPreview(
            pendingAttachment
        );

    } catch (error) {

        console.error(
            "File error:",
            error
        );

        // No alert popup.
        // Show the error in the chat instead.
        addMessage(
            "assistant",
            `File error: ${
                error?.message ||
                "Could not process this file."
            }`,
            false
        );

        pendingAttachment = null;

        clearAttachmentPreview();

    } finally {

        if (fileInput) {
            fileInput.value = "";
        }
    }
}

// =====================================================
// READ TEXT FILE
// =====================================================

function readAsText(file) {

    return new Promise(
        (resolve, reject) => {

            const reader =
                new FileReader();

            reader.onload = () => {

                resolve(
                    String(
                        reader.result ||
                            ""
                    )
                );
            };

            reader.onerror = () => {

                reject(
                    new Error(
                        "Could not read the file."
                    )
                );
            };

            reader.readAsText(file);
        }
    );
}

// =====================================================
// READ IMAGE
// =====================================================

function readAsDataURL(file) {

    return new Promise(
        (resolve, reject) => {

            const reader =
                new FileReader();

            reader.onload = () => {

                resolve(
                    String(
                        reader.result ||
                            ""
                    )
                );
            };

            reader.onerror = () => {

                reject(
                    new Error(
                        "Could not read the image."
                    )
                );
            };

            reader.readAsDataURL(file);
        }
    );
}

// =====================================================
// FILE PROMPT
// =====================================================

function buildFilePrompt(
    attachment,
    question
) {

    return `${question || "Please analyze this file."}

--- Uploaded file: ${attachment.name} ---

${attachment.text}

--- End uploaded file ---`;
}

// =====================================================
// ATTACHMENT PREVIEW
// =====================================================

function showAttachmentPreview(
    attachment
) {

    if (!attachmentPreview) {
        return;
    }

    attachmentPreview.classList.remove(
        "hidden"
    );

    attachmentPreview.innerHTML = `

        <div class="attachment-card">

            ${
                attachment.type ===
                "image"

                    ? `
                        <img
                            src="${attachment.data}"
                            alt="Preview"
                        >
                      `

                    : `
                        <span class="file-icon">
                            📄
                        </span>
                      `
            }

            <div class="attachment-info">

                <strong>
                    ${escapeHtml(
                        attachment.name
                    )}
                </strong>

                <span>
                    ${
                        attachment.type ===
                        "image"
                            ? "Image ready for analysis"
                            : "File ready to analyze"
                    }
                </span>

            </div>

            <button
                id="removeAttachment"
                type="button"
                class="remove-attachment"
                title="Remove attachment"
            >
                ×
            </button>

        </div>
    `;

    const removeButton =
        document.getElementById(
            "removeAttachment"
        );

    if (removeButton) {

        removeButton.addEventListener(
            "click",
            () => {

                pendingAttachment =
                    null;

                clearAttachmentPreview();
            }
        );
    }
}

function clearAttachmentPreview() {

    if (!attachmentPreview) {
        return;
    }

    attachmentPreview.classList.add(
        "hidden"
    );

    attachmentPreview.innerHTML =
        "";
}

// =====================================================
// TEXT TO SPEECH
// =====================================================

function speakText(
    text,
    button
) {

    if (
        !("speechSynthesis" in window)
    ) {

        addMessage(
            "assistant",
            "Text-to-speech is not supported in this browser.",
            false
        );

        return;
    }

    window.speechSynthesis.cancel();

    const cleanText =
        String(text)
            .replace(
                /```[\s\S]*?```/g,
                ""
            )
            .replace(
                /[*_#]/g,
                ""
            );

    const utterance =
        new SpeechSynthesisUtterance(
            cleanText
        );

    utterance.rate = 1;
    utterance.pitch = 1;

    if (button) {
        button.textContent =
            "⏳ Reading...";
    }

    utterance.onend = () => {

        if (button) {
            button.textContent =
                "🔊 Read aloud";
        }
    };

    utterance.onerror = () => {

        if (button) {
            button.textContent =
                "🔊 Read aloud";
        }
    };

    window.speechSynthesis.speak(
        utterance
    );
}

// =====================================================
// VOICE INPUT
// =====================================================

function setupVoiceInput() {

    const SpeechRecognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;

    if (!SpeechRecognition) {

        if (micButton) {

            micButton.title =
                "Voice input is not supported in this browser";
        }

        return;
    }

    recognition =
        new SpeechRecognition();

    recognition.lang =
        "en-IN";

    recognition.interimResults =
        true;

    recognition.continuous =
        false;

    recognition.onstart = () => {

        isListening =
            true;

        if (micButton) {

            micButton.classList.add(
                "listening"
            );
        }

        if (voiceStatus) {

            voiceStatus.classList.remove(
                "hidden"
            );
        }
    };

    recognition.onresult =
        event => {

            let transcript =
                "";

            for (
                let i =
                    event.resultIndex;

                i <
                event.results.length;

                i++
            ) {

                transcript +=
                    event.results[i][0]
                        .transcript;
            }

            if (input) {

                input.value =
                    transcript;
            }
        };

    recognition.onerror =
        event => {

            console.warn(
                "Voice input error:",
                event.error
            );
        };

    recognition.onend = () => {

        isListening =
            false;

        if (micButton) {

            micButton.classList.remove(
                "listening"
            );
        }

        if (voiceStatus) {

            voiceStatus.classList.add(
                "hidden"
            );
        }
    };
}

function toggleVoiceInput() {

    if (!recognition) {

        addMessage(
            "assistant",
            "Voice input is not supported in this browser. Try Google Chrome or Microsoft Edge.",
            false
        );

        return;
    }

    if (isListening) {

        recognition.stop();

    } else {

        try {

            recognition.start();

        } catch (error) {

            console.warn(
                "Could not start speech recognition:",
                error
            );
        }
    }
}

// =====================================================
// CLEAR CURRENT CHAT
// =====================================================

function clearChat() {

    if (!currentConversation) {
        return;
    }

    currentConversation.messages =
        [];

    currentConversation.title =
        "New Chat";

    currentConversation.lastImage =
        null;

    currentConversation.updatedAt =
        Date.now();

    pendingAttachment =
        null;

    clearAttachmentPreview();

    renderConversation();

    saveConversations();

    if (input) {
        input.focus();
    }
}

// =====================================================
// DELETE ALL HISTORY
// NO ALERT / NO CONFIRM
// =====================================================

function deleteAllHistory() {

    localStorage.removeItem(
        STORAGE_KEY
    );

    conversations = [];

    currentConversation =
        null;

    pendingAttachment =
        null;

    clearAttachmentPreview();

    currentConversation =
        createConversation();

    conversations.push(
        currentConversation
    );

    saveConversations();

    renderConversation();

    renderChatHistory();

    if (input) {
        input.focus();
    }
}

// =====================================================
// MOBILE SIDEBAR
// =====================================================

function openMobileSidebar() {

    if (sidebar) {

        sidebar.classList.add(
            "open"
        );
    }

    if (sidebarOverlay) {

        sidebarOverlay.classList.add(
            "visible"
        );
    }
}

function closeMobileSidebar() {

    if (sidebar) {

        sidebar.classList.remove(
            "open"
        );
    }

    if (sidebarOverlay) {

        sidebarOverlay.classList.remove(
            "visible"
        );
    }
}

// =====================================================
// EVENT LISTENERS
// =====================================================

// SEND BUTTON
if (sendButton) {

    sendButton.addEventListener(
        "click",
        event => {

            event.preventDefault();

            sendMessage();
        }
    );
}

// ENTER TO SEND
if (input) {

    input.addEventListener(
        "keydown",
        event => {

            if (
                event.key ===
                    "Enter" &&
                !event.shiftKey
            ) {

                event.preventDefault();

                sendMessage();
            }
        }
    );

    input.addEventListener(
        "input",
        () => {

            input.style.height =
                "auto";

            input.style.height =
                `${Math.min(
                    input.scrollHeight,
                    140
                )}px`;
        }
    );
}

// NEW CHAT
if (newChatButton) {

    newChatButton.addEventListener(
        "click",
        event => {

            event.preventDefault();

            startNewChat();
        }
    );
}

// CLEAR CURRENT CHAT
if (clearButton) {

    clearButton.addEventListener(
        "click",
        event => {

            event.preventDefault();

            clearChat();
        }
    );
}

// CLEAR ALL HISTORY
if (clearHistoryButton) {

    clearHistoryButton.addEventListener(
        "click",
        event => {

            event.preventDefault();

            deleteAllHistory();
        }
    );
}

// ATTACH FILE
if (
    attachButton &&
    fileInput
) {

    attachButton.addEventListener(
        "click",
        event => {

            event.preventDefault();

            fileInput.click();
        }
    );

    fileInput.addEventListener(
        "change",
        () => {

            handleFile(
                fileInput.files?.[0]
            );
        }
    );
}

// MICROPHONE
if (micButton) {

    micButton.addEventListener(
        "click",
        event => {

            event.preventDefault();

            toggleVoiceInput();
        }
    );
}

// MOBILE MENU
if (menuButton) {

    menuButton.addEventListener(
        "click",
        event => {

            event.preventDefault();

            openMobileSidebar();
        }
    );
}

// SIDEBAR OVERLAY
if (sidebarOverlay) {

    sidebarOverlay.addEventListener(
        "click",
        closeMobileSidebar
    );
}

// =====================================================
// INITIALIZATION
// =====================================================

setupVoiceInput();

if (conversations.length) {

    conversations.sort(
        (a, b) =>
            b.updatedAt -
            a.updatedAt
    );

    currentConversation =
        conversations[0];

} else {

    currentConversation =
        createConversation();

    conversations.push(
        currentConversation
    );

    saveConversations();
}

renderConversation();