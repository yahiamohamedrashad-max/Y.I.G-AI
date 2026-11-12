import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, getDocs, getDoc,
  query, orderBy, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

// Paste your Firebase Web App config here (Firebase Console > Project settings).
const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_FIREBASE_APP_ID"
};

const configured = !Object.values(firebaseConfig).some(v => String(v).includes("YOUR_"));
let app, auth, db, currentUser = null, activeChatId = null;
if (configured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app); db = getFirestore(app);
} else {
  console.warn("Add your Firebase config in public/app.js before using Google sign-in.");
}
const $ = id => document.getElementById(id);
let files = [], messages = [], busy = false, chatCache = [];
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3000);
}
function setUser(user) {
  currentUser = user;
  $("cloudStatus").textContent = "● ذكاء اصطناعي محلي مجاني";
  $("cloudStatus").style.color = "#5be5a8";
  $("signIn").hidden = !!user; $("signOut").hidden = !user;
  $("userName").textContent = user?.displayName || "ضيف";
  $("userEmail").textContent = user?.email || "سجّل الدخول للبدء";
  $("settingsUser").textContent = user ? `${user.displayName || ""} — ${user.email || ""}` : "سجّل الدخول لإدارة حسابك.";
  $("userAvatar").innerHTML = user?.photoURL ? `<img src="${user.photoURL}" alt="">` : "Y";
}
async function doSignIn() {
  if (!configured) return toast("لازم تضيف Firebase Config الأول في public/app.js.");
  try { await signInWithPopup(auth, provider); }
  catch (err) {
    if (["auth/popup-blocked", "auth/popup-closed-by-user"].includes(err.code)) {
      await signInWithRedirect(auth, provider);
    } else toast(err.message || "تعذر تسجيل الدخول.");
  }
}
$("signIn").addEventListener("click", doSignIn);
$("signOut").addEventListener("click", async () => { if (auth) await signOut(auth); resetChat(); toast("تم تسجيل الخروج."); });
if (auth) {
  getRedirectResult(auth).catch(err => toast(err.message));
  onAuthStateChanged(auth, async user => {
    setUser(user);
    if (user) {
      const tokenInfo = await user.getIdTokenResult(true);
      const isAdmin = tokenInfo.claims.admin === true;
      $("adminNav").hidden = !isAdmin;
      await loadChats(); await loadFiles();
    }
    else {
      $("adminNav").hidden = true; $("historyList").innerHTML = '<span class="muted">سجّل دخولك لعرض محادثاتك</span>'; $("fileLibrary").textContent = "سجّل الدخول لعرض ملفاتك."; }
  });
} else setUser(null);

function addMessage(role, text, opts = {}) {
  $("welcome").classList.add("hidden");
  const row = document.createElement("div"); row.className = `message ${role}`;
  const avatar = document.createElement("div"); avatar.className = "msg-avatar"; avatar.textContent = role === "assistant" ? "Y" : "YOU";
  const bubble = document.createElement("div"); bubble.className = "bubble"; bubble.textContent = text;
  row.append(avatar, bubble); $("messages").append(row);
  if (role === "assistant" && !opts.pending) {
    const actions = document.createElement("div"); actions.className = "bubble-actions";
    const copy = document.createElement("button"); copy.textContent = "نسخ الرد";
    copy.onclick = () => navigator.clipboard.writeText(text).then(() => toast("تم نسخ الرد."));
    const speak = document.createElement("button"); speak.textContent = "🔊 استمع";
    speak.onclick = () => speakText(text);
    actions.append(copy, speak); bubble.append(actions);
  }
  $("chatScroll").scrollTop = $("chatScroll").scrollHeight;
  return bubble;
}
function resetChat() {
  activeChatId = null; messages = []; $("messages").replaceChildren(); $("welcome").classList.remove("hidden");
  files = []; renderFiles(); $("messageInput").value = "";
}
$("newChat").onclick = resetChat;
$("clearChat")?.addEventListener("click", resetChat);

function renderFiles() {
  $("attachments").replaceChildren();
  files.forEach((file, index) => {
    const chip = document.createElement("div"); chip.className = "file-chip";
    const name = document.createElement("span"); name.textContent = `📎 ${file.name}`;
    const remove = document.createElement("button"); remove.textContent = "×"; remove.onclick = () => { files.splice(index, 1); renderFiles(); };
    chip.append(name, remove); $("attachments").append(chip);
  });
}
$("fileInput").addEventListener("change", () => {
  for (const file of [...$("fileInput").files]) {
    if (files.length >= 6) break;
    if (file.size > 20 * 1024 * 1024) { toast(`${file.name}: الحد الأقصى 20MB`); continue; }
    files.push(file);
  }
  $("fileInput").value = ""; renderFiles();
});
$("messageInput").addEventListener("input", e => {
  e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 145) + "px";
});

async function ensureChat(title) {
  if (activeChatId || !currentUser) return activeChatId;
  const refDoc = await addDoc(collection(db, "users", currentUser.uid, "chats"), {
    title: (title || "محادثة جديدة").slice(0, 70), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  activeChatId = refDoc.id; await loadChats(); return activeChatId;
}
async function saveChatMessage(role, content) {
  if (!currentUser || !db || !activeChatId) return;
  await addDoc(collection(db, "users", currentUser.uid, "chats", activeChatId, "messages"), {
    role, content: String(content).slice(0, 20000), createdAt: serverTimestamp()
  });
  await setDoc(doc(db, "users", currentUser.uid, "chats", activeChatId), { updatedAt: serverTimestamp() }, { merge: true });
}
async function loadChats() {
  if (!currentUser || !db) return;
  try {
    const q = query(collection(db, "users", currentUser.uid, "chats"), orderBy("updatedAt", "desc"), limit(30));
    const snap = await getDocs(q); chatCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const list = $("historyList"); list.replaceChildren();
    if (!chatCache.length) { list.innerHTML = '<span class="muted">لا توجد محادثات بعد</span>'; return; }
    chatCache.forEach(chat => {
      const btn = document.createElement("button"); btn.className = "history-item"; btn.textContent = "◦　" + (chat.title || "محادثة");
      btn.onclick = () => openChat(chat.id); list.append(btn);
    });
  } catch (err) { console.error(err); }
}
async function openChat(id) {
  if (!currentUser) return;
  try {
    activeChatId = id; messages = []; $("messages").replaceChildren();
    const q = query(collection(db, "users", currentUser.uid, "chats", id, "messages"), orderBy("createdAt", "asc"), limit(100));
    const snap = await getDocs(q);
    snap.forEach(d => {
      const m = d.data(); messages.push({ role: m.role, content: m.content }); addMessage(m.role, m.content);
    });
    $("welcome").classList.toggle("hidden", messages.length > 0);
  } catch (err) { toast("تعذر فتح المحادثة."); }
}

let localEnginePromise = null;
async function getLocalEngine() {
  if (!navigator.gpu) throw new Error("المتصفح أو الجهاز لا يدعم WebGPU. جرّب Chrome أو Edge حديثاً على جهاز يدعم WebGPU.");
  if (!localEnginePromise) {
    localEnginePromise = import("https://esm.run/@mlc-ai/web-llm").then(async mod => {
      const engine = await mod.CreateMLCEngine("Qwen2.5-0.5B-Instruct-q4f16_1-MLC", {
        initProgressCallback: info => {
          const status = info.text || "جاري تجهيز النموذج المحلي...";
          $("cloudStatus").textContent = status.slice(0, 46);
        }
      });
      $("cloudStatus").textContent = "● الذكاء المحلي جاهز";
      return engine;
    }).catch(error => { localEnginePromise = null; throw error; });
  }
  return localEnginePromise;
}
async function readLocalFiles(selected) {
  const parts = [];
  for (const file of selected) {
    const name = file.name.toLowerCase();
    if (file.type.startsWith("text/") || /\.(txt|md|csv|json|html|css|js|py|xml|log)$/i.test(name)) {
      parts.push(`\n
محتوى الملف ${file.name}:\n${(await file.text()).slice(0, 16000)}`);
    } else {
      parts.push(`\nالملف ${file.name} مرفق، لكن النسخة المجانية المحلية الحالية لا تستخرج النص من PDF أو الصور أو ملفات Office.`);
    }
  }
  return parts.join("\n");
}
async function sendMessage(text) {
  if (busy || (!text.trim() && !files.length)) return;
  busy = true; $("sendButton").disabled = true;
  const selected = [...files];
  const label = text.trim() + (selected.length ? `\n📎 ${selected.map(f => f.name).join("، ")}` : "");
  addMessage("user", label); messages.push({ role: "user", content: text });
  files = []; renderFiles(); $("messageInput").value = ""; $("messageInput").style.height = "auto";
  const waiting = addMessage("assistant", "جاري تشغيل الذكاء الاصطناعي المجاني على جهازك...", { pending: true });
  try {
    if ($("webToggle").checked) toast("البحث المباشر على الإنترنت غير متاح في وضع التشغيل المجاني المحلي.");
    const engine = await getLocalEngine();
    const fileContext = await readLocalFiles(selected);
    const history = messages.slice(-12).map(m => ({ role: m.role, content: String(m.content || "").slice(0, 5000) }));
    if (fileContext) history[history.length - 1].content += fileContext;
    const result = await engine.chat.completions.create({
      messages: [
        { role: "system", content: "أنت Y.I.G AI، مساعد عربي مفيد. أجب بوضوح وباختصار مناسب، واستخدم لغة المستخدم. إذا لم تعرف معلومة فقل ذلك بصراحة. أنت تعمل محلياً وقدراتك محدودة مقارنة بالنماذج السحابية الكبيرة." },
        ...history
      ],
      temperature: 0.7,
      max_tokens: 900
    });
    const reply = result.choices?.[0]?.message?.content || "لم أتمكن من إنشاء رد. جرّب مرة أخرى.";
    waiting.textContent = reply; messages.push({ role: "assistant", content: reply });
    const actions = document.createElement("div"); actions.className = "bubble-actions";
    const copy = document.createElement("button"); copy.textContent = "نسخ الرد"; copy.onclick = () => navigator.clipboard.writeText(reply).then(() => toast("تم نسخ الرد."));
    const speak = document.createElement("button"); speak.textContent = "🔊 استمع"; speak.onclick = () => speakText(reply);
    actions.append(copy, speak); waiting.append(actions);
    if (currentUser) {
      const id = await ensureChat(text || selected[0]?.name || "محادثة جديدة");
      await saveChatMessage("user", label); await saveChatMessage("assistant", reply); await loadChats();
    }
  } catch (err) {
    waiting.textContent = `تعذر تشغيل النموذج المحلي: ${err.message}`;
    toast(err.message);
  } finally { busy = false; $("sendButton").disabled = false; $("messageInput").focus(); }
}
$("chatForm").addEventListener("submit", e => { e.preventDefault(); sendMessage($("messageInput").value); });
document.querySelectorAll(".quick").forEach(btn => btn.onclick = () => sendMessage(btn.dataset.prompt));

function speakText(text) {
  if (!window.speechSynthesis) return toast("قراءة الصوت غير مدعومة في المتصفح.");
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 5000));
  utterance.lang = "ar-EG"; window.speechSynthesis.speak(utterance);
}

let speechRecognition = null;
$("voiceInput").onclick = () => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return toast("الإملاء الصوتي غير مدعوم في المتصفح ده. جرّب Chrome.");
  if (speechRecognition) { speechRecognition.stop(); speechRecognition = null; return; }
  speechRecognition = new SpeechRecognition(); speechRecognition.lang = "ar-EG"; speechRecognition.interimResults = true;
  speechRecognition.onresult = event => { let transcript = ""; for (let i = event.resultIndex; i < event.results.length; i++) transcript += event.results[i][0].transcript; $("messageInput").value = transcript; };
  speechRecognition.onerror = () => toast("تعذر التعرف على الصوت.");
  speechRecognition.onend = () => { speechRecognition = null; $("voiceInput").classList.remove("recording"); $("voiceInput").textContent = "🎙"; };
  speechRecognition.start(); $("voiceInput").classList.add("recording"); $("voiceInput").textContent = "■";
};

function generateImage() {
  $("imageResult").textContent = "إنشاء الصور يحتاج نموذجاً متخصصاً وموارد معالجة غير متاحة مجاناً بشكل مضمون في هذه النسخة. يمكنك استخدام أدوات مجانية مستقلة، لكن قد تفرض حدوداً أو شروطاً.";
}

$("generateImage").onclick = generateImage;

async function loadFiles() {
  const library = $("fileLibrary");
  if (library) library.textContent = "الملفات تُقرأ محلياً أثناء المحادثة ولا تُرفع إلى خادم أو مساحة تخزين مدفوعة.";
}

// Safe local code playground: the preview is isolated in a sandboxed iframe.
function buildPreviewDocument() {
  const html = $("htmlCode").value;
  const css = $("cssCode").value.replace(/<\/style/gi, "<\\/style");
  const js = $("jsCode").value.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}<script>${js}\n<\/script></body></html>`;
}
$("runCode").onclick = () => { $("codePreview").srcdoc = buildPreviewDocument(); toast("تم تشغيل المعاينة محلياً."); };
$("downloadCode").onclick = () => {
  const blob = new Blob([buildPreviewDocument()], { type: "text/html" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = "yig-ai-project.html"; a.click(); URL.revokeObjectURL(url);
};
$("runCode").click();

$("loadAdmin").onclick = () => { $("adminStats").textContent = "لا توجد لوحة إدارة أو خطط مدفوعة في النسخة المجانية."; };

function switchView(view) {
  document.querySelectorAll(".view").forEach(el => el.classList.remove("active"));
  $(`${view}View`).classList.add("active");
  document.querySelectorAll(".nav-item").forEach(el => el.classList.toggle("selected", el.dataset.view === view));
  $("sidebar").classList.remove("open");
}
document.querySelectorAll(".nav-item").forEach(btn => btn.onclick = () => switchView(btn.dataset.view));
$("mobileMenu").onclick = () => $("sidebar").classList.toggle("open");
$("settingsBtn").onclick = () => $("settingsModal").classList.add("open");
$("closeSettings").onclick = () => $("settingsModal").classList.remove("open");
$("settingsModal").onclick = e => { if (e.target === $("settingsModal")) $("settingsModal").classList.remove("open"); };