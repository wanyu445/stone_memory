(() => {
  "use strict";

  const stoneModule = window.StoneDeveloperModule;
  const logic = window.StoneAssistantLogic;
  const knowledge = window.StoneAssistantKnowledge || [];
  const $ = selector => document.querySelector(selector);
  const state = {
    ready: false,
    contextLoaded: false,
    phase: "idle",
    phaseVersion: 0,
    temporaryPhaseTimer: 0,
    overview: null,
    mining: null,
    pollTimer: 0,
    pollGeneration: 0,
    automaticJobId: null,
    writeInFlight: false,
    confirmationSequence: 0,
    pendingConfirmation: null,
    progressMessage: null,
    manifest: null,
    spriteImage: null,
    animation: "idle",
    frame: 0,
    lastTick: 0,
    animationRequest: 0,
    bubbleTimer: 0,
    panelTab: "chat",
    interactionTimer: 0,
    interactionIndex: 0,
    interactionActive: false,
    mobileMode: false,
    mobileTapArmedUntil: 0,
    mobileTapTimer: 0,
    pageScrollY: 0,
    pageLocked: false,
    nickname: "",
    guideStep: 0,
    sessionLogs: [],
    logsDirty: true,
    logSignature: "",
    openLogIds: new Set()
  };

  const canvas = $("#assistant-canvas");
  const context = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const PHASES = {
    idle: { label: "待命", animation: "idle" },
    loading: { label: "检查中", animation: "review" },
    awaiting_confirmation: { label: "等待确认", animation: "waiting" },
    running: { label: "执行中", animation: "running" },
    completed: { label: "已完成", animation: "jumping" },
    failed: { label: "遇到问题", animation: "failed" }
  };
  const PHASE_PRIORITY = Object.freeze({ idle: 0, completed: 1, loading: 2, awaiting_confirmation: 3, running: 4, failed: 5 });
  const INTERACTION_BUBBLES = Object.freeze([
    "(｡･ω･｡) 我在呢",
    "今天也要好好整理记忆呀～",
    "让我看看有什么待处理",
    "来和我说说要做什么吧",
    "今天的能量补充完毕！"
  ]);
  const MANUAL_TASKS = Object.freeze({
    trim: { title: "原文裁剪", reason: "需要你亲自判断哪些对话或工具链应当保留，避免小助理误删重要上下文。", path: "维护 → 重建上下文 → 原文 → 裁剪对话 / 工具链" },
    import: { title: "对话导入", reason: "导入前需要你核对来源和目标记忆体，小助理不会替你选择私人文件。", path: "维护 → 对话导入" },
    remine: { title: "精准补挖", reason: "已挖掘日期重新处理前应先审查现有结果和候选内容。", path: "维护 → 记忆挖掘 → 选择日期 → 精准补挖" },
    summary: { title: "摘要管理", reason: "摘要内容需要由你判断是否准确、重要或需要后续处理。", path: "记忆档案 → 摘要" }
  });
  const GUIDE_STEPS = Object.freeze([
    { title: () => `你好，我是“${state.nickname || "小助理"}”`, copy: () => "我是你的 Stone Memory 小助理。接下来我会用几个简短步骤，带你认识当前记忆体和常用维护功能。" },
    { title: () => "Stone Memory 能帮你做什么？", copy: () => "它可以保存和整理长期对话，让你查看原文、摘要和特征，并在需要时维护当前线程。" },
    { title: () => "这是我正在照看的记忆体", copy: () => `当前绑定的是“${state.overview?.libraryName || "当前记忆体"}”。我的检查和操作只会作用于它，不会自动切换到其他记忆体。` },
    { title: () => "先检查有什么待处理", copy: () => "“检查待办”会告诉你是否有正在运行、失败或尚未挖掘的日期。检查状态不会修改任何记忆。" },
    { title: () => "也可以整理指定日期", copy: () => "输入“挖掘 2026-08-14”或“整理昨天”，我会先说明日期和影响，等你确认后才开始。" },
    { title: () => "一键维护处理连续待办", copy: () => "一键维护会整理昨天及更早的普通待挖掘日期；完成后我会提示你到正式工作台查看重建预览。" },
    { title: () => "有些任务需要你亲自检查", copy: () => "原文裁剪、对话导入、精准补挖和摘要管理需要查看具体内容。我会说明入口，但不会跳过人工确认。" },
    { title: () => "最后，记得查看工作日志", copy: () => "工作日志会汇总可验证的系统状态和本次小助理操作，帮助你知道记忆系统最近做了什么。" }
  ]);
  const ATLAS_ANIMATIONS = Object.freeze({
    idle: { row: 0, frameCount: 6, frameDurationsMs: [280, 110, 110, 140, 140, 320] },
    "running-right": { row: 1, frameCount: 8, frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
    "running-left": { row: 2, frameCount: 8, frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
    waving: { row: 3, frameCount: 4, frameDurationsMs: [140, 140, 140, 280] },
    jumping: { row: 4, frameCount: 5, frameDurationsMs: [140, 140, 140, 140, 280] },
    failed: { row: 5, frameCount: 8, frameDurationsMs: [140, 140, 140, 140, 140, 140, 140, 240] },
    waiting: { row: 6, frameCount: 6, frameDurationsMs: [150, 150, 150, 150, 150, 260] },
    running: { row: 7, frameCount: 6, frameDurationsMs: [120, 120, 120, 120, 120, 220] },
    review: { row: 8, frameCount: 6, frameDurationsMs: [150, 150, 150, 150, 150, 280] }
  });

  function setStatus(message, type = "") {
    const target = $("#assistant-status");
    target.textContent = message;
    target.dataset.state = type;
  }

  function setPhase(phase) {
    const next = PHASES[phase] || PHASES.idle;
    clearTimeout(state.temporaryPhaseTimer);
    state.temporaryPhaseTimer = 0;
    state.phaseVersion += 1;
    state.phase = phase in PHASES ? phase : "idle";
    state.interactionActive = false;
    clearTimeout(state.interactionTimer);
    $("#assistant-phase").textContent = next.label;
    switchAnimation(next.animation);
  }

  function operationalPhase() {
    if (state.writeInFlight) return "running";
    if (state.pendingConfirmation) return "awaiting_confirmation";
    if (logic.isMiningActive(state.mining?.job)) return "running";
    return "idle";
  }

  function setTemporaryPhase(phase, duration = 1200) {
    setPhase(phase);
    const version = state.phaseVersion;
    state.temporaryPhaseTimer = window.setTimeout(() => {
      state.temporaryPhaseTimer = 0;
      if (state.phaseVersion === version) setPhase(operationalPhase());
    }, duration);
  }

  function api(path, options = {}) {
    return stoneModule.api(path, options);
  }

  function threadPath(path) {
    return path.replace(":threadId", encodeURIComponent(stoneModule.threadId));
  }

  function showUnavailable(message) {
    $("#assistant-unavailable-message").textContent = message;
    $("#assistant-unavailable").hidden = false;
    $("#assistant-dashboard").hidden = true;
    $("#assistant-guide").hidden = true;
    $("#assistant-widget").hidden = true;
    setStatus("当前模块未执行任何管理操作。", "error");
  }

  function enableControls() {
    state.ready = true;
    $("#assistant-launcher").disabled = false;
    $("#assistant-input").disabled = false;
    $("#assistant-form button").disabled = false;
    $("#dashboard-refresh").disabled = false;
    $("#assistant-log-refresh").disabled = false;
    $("#assistant-revisit-guide").disabled = false;
  }

  function showBubble(text) {
    const bubble = $("#assistant-bubble");
    if (!$("#assistant-panel").hidden) {
      hideBubble();
      return;
    }
    bubble.textContent = text;
    bubble.hidden = false;
    clearTimeout(state.bubbleTimer);
    state.bubbleTimer = window.setTimeout(() => { bubble.hidden = true; }, 7000);
  }

  function hideBubble() {
    clearTimeout(state.bubbleTimer);
    $("#assistant-bubble").hidden = true;
  }

  function setAssistantIdentity(nickname) {
    state.nickname = nickname;
    $("#assistant-nickname").textContent = nickname;
    $("#assistant-launcher-label").textContent = nickname;
    $("#assistant-launcher").setAttribute("aria-label", `打开 Stone Memory 小助理 ${nickname}`);
  }

  function canPlayInteraction() {
    return state.ready && PHASE_PRIORITY[state.phase] === PHASE_PRIORITY.idle;
  }

  function restoreInteraction({ hide = false } = {}) {
    if (!state.interactionActive) return;
    state.interactionActive = false;
    clearTimeout(state.interactionTimer);
    switchAnimation(PHASES[state.phase]?.animation || "idle");
    if (hide) hideBubble();
  }

  function playInteraction(bubbleText = "") {
    if (!canPlayInteraction()) return;
    const index = state.interactionIndex;
    state.interactionIndex = (index + 1) % INTERACTION_BUBBLES.length;
    state.interactionActive = true;
    clearTimeout(state.interactionTimer);
    switchAnimation(index % 2 === 0 ? "waving" : "jumping");
    showBubble(bubbleText || INTERACTION_BUBBLES[index]);
    state.interactionTimer = window.setTimeout(() => restoreInteraction(), 1200);
  }

  function detectMobileMode() {
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches || Number(navigator.maxTouchPoints || 0) > 0;
    return logic.isMobileAssistantEnvironment({ coarsePointer, width: window.innerWidth, height: window.innerHeight });
  }

  function clearMobileTap({ hideHint = false } = {}) {
    clearTimeout(state.mobileTapTimer);
    state.mobileTapTimer = 0;
    state.mobileTapArmedUntil = 0;
    if (hideHint) hideBubble();
  }

  function lockMobilePage() {
    if (state.pageLocked || !state.mobileMode) return;
    state.pageLocked = true;
    state.pageScrollY = window.scrollY;
    document.body.style.setProperty("--assistant-page-scroll-y", `${-state.pageScrollY}px`);
    document.body.classList.add("assistant-mobile-panel-open");
  }

  function updateVisualViewportMetrics() {
    const viewport = window.visualViewport;
    const width = Math.max(1, Number(viewport?.width || window.innerWidth || document.documentElement.clientWidth));
    const height = Math.max(1, Number(viewport?.height || window.innerHeight || document.documentElement.clientHeight));
    const left = Math.max(0, Number(viewport?.offsetLeft || 0));
    const top = Math.max(0, Number(viewport?.offsetTop || 0));
    const root = document.documentElement.style;
    root.setProperty("--assistant-visual-width", `${width}px`);
    root.setProperty("--assistant-visual-height", `${height}px`);
    root.setProperty("--assistant-visual-left", `${left}px`);
    root.setProperty("--assistant-visual-top", `${top}px`);
  }

  function setBackgroundInert(inert) {
    for (const selector of ["#assistant-dashboard", "#assistant-guide", "#assistant-unavailable", ".assistant-intro"]) {
      const node = $(selector);
      if (node) node.inert = inert;
    }
  }

  function unlockMobilePage({ restoreScroll = true } = {}) {
    if (!state.pageLocked) return;
    const scrollY = state.pageScrollY;
    state.pageLocked = false;
    document.body.classList.remove("assistant-mobile-panel-open");
    document.body.style.removeProperty("--assistant-page-scroll-y");
    if (restoreScroll) window.scrollTo(0, scrollY);
  }

  function syncMobilePanelState(open = !$("#assistant-panel").hidden) {
    const mobileOpen = Boolean(open && state.mobileMode);
    const widget = $("#assistant-widget");
    const backdrop = $("#assistant-backdrop");
    const panel = $("#assistant-panel");
    const launcher = $("#assistant-launcher");
    widget.classList.toggle("mobile-panel-open", mobileOpen);
    backdrop.hidden = !mobileOpen;
    if (mobileOpen) {
      updateVisualViewportMetrics();
      panel.setAttribute("aria-modal", "true");
      launcher.setAttribute("aria-hidden", "true");
      launcher.tabIndex = -1;
      setBackgroundInert(true);
      lockMobilePage();
    } else {
      panel.removeAttribute("aria-modal");
      launcher.removeAttribute("aria-hidden");
      launcher.tabIndex = 0;
      setBackgroundInert(false);
      unlockMobilePage();
    }
  }

  function syncMobileMode() {
    const next = detectMobileMode();
    if (next !== state.mobileMode) clearMobileTap({ hideHint: true });
    state.mobileMode = next;
    document.body.classList.toggle("assistant-mobile", next);
    updateVisualViewportMetrics();
    syncMobilePanelState();
  }

  function trapMobilePanelFocus(event) {
    if (event.key !== "Tab" || !state.mobileMode || $("#assistant-panel").hidden) return;
    const panel = $("#assistant-panel");
    const focusable = [...panel.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")]
      .filter(node => !node.hidden && node.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleLauncherClick() {
    const panelOpen = !$("#assistant-panel").hidden;
    const action = logic.mobileLauncherAction({
      mobile: state.mobileMode,
      panelOpen,
      phase: state.phase,
      armedUntil: state.mobileTapArmedUntil,
      now: Date.now()
    });
    if (action === "interact") {
      state.mobileTapArmedUntil = Date.now() + logic.MOBILE_TAP_WINDOW_MS;
      clearTimeout(state.mobileTapTimer);
      state.mobileTapTimer = window.setTimeout(() => clearMobileTap({ hideHint: true }), logic.MOBILE_TAP_WINDOW_MS);
      playInteraction(`${INTERACTION_BUBBLES[state.interactionIndex]}\n再点一下和我说话～`);
      return;
    }
    clearMobileTap({ hideHint: true });
    setPanel(action === "open");
  }

  function renderGuideStep() {
    const index = Math.max(0, Math.min(GUIDE_STEPS.length - 1, state.guideStep));
    const step = GUIDE_STEPS[index];
    state.guideStep = index;
    $("#assistant-guide-progress").textContent = `第 ${index + 1} 步，共 ${GUIDE_STEPS.length} 步`;
    $("#assistant-guide-step-title").textContent = step.title();
    $("#assistant-guide-step-copy").textContent = step.copy();
    $("#assistant-guide-prev").disabled = index === 0;
    $("#assistant-guide-next").textContent = index === GUIDE_STEPS.length - 1 ? "完成介绍" : "下一步";
  }

  function finishGuide() {
    switchPanelTab("chat", { focus: !state.mobileMode });
    showBubble("介绍收好啦～随时可以再来看。");
  }

  function openGuide({ restart = false } = {}) {
    if (restart) state.guideStep = 0;
    renderGuideStep();
    setPanel(true, { loadContext: false, tab: "guide" });
  }

  function scrollMessages() {
    const messages = $("#assistant-messages");
    messages.scrollTop = messages.scrollHeight;
  }

  function addMessage(text, kind = "assistant", actions = []) {
    const item = document.createElement("div");
    item.className = `assistant-message ${kind}`;
    const copy = document.createElement("span");
    copy.textContent = text;
    item.append(copy);
    if (actions.length) {
      const bar = document.createElement("div");
      bar.className = "message-actions";
      for (const action of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        button.addEventListener("click", action.run);
        bar.append(button);
      }
      item.append(bar);
    }
    $("#assistant-messages").append(item);
    scrollMessages();
    return item;
  }

  function invalidatePendingConfirmation({ restorePhase = false } = {}) {
    const pending = state.pendingConfirmation;
    if (!pending) return;
    pending.active = false;
    pending.card.remove();
    state.pendingConfirmation = null;
    if (restorePhase) setPhase(operationalPhase());
  }

  function addConfirmation({ title, detail, acknowledgement, confirmLabel = "确认执行", selection = null, onConfirm, onCancel }) {
    invalidatePendingConfirmation();
    const token = ++state.confirmationSequence;
    const card = document.createElement("article");
    card.className = "confirmation-card";
    card.dataset.confirmationToken = String(token);
    const pending = { token, card, active: true };
    state.pendingConfirmation = pending;
    setPhase("awaiting_confirmation");
    const heading = document.createElement("strong");
    heading.textContent = title;
    const description = document.createElement("span");
    description.textContent = detail;
    const checkLabel = document.createElement("label");
    checkLabel.className = "confirmation-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const checkText = document.createElement("span");
    checkText.textContent = acknowledgement;
    checkLabel.append(checkbox, checkText);
    let select = null;
    let selectLabel = null;
    if (selection) {
      selectLabel = document.createElement("label");
      selectLabel.className = "confirmation-selection";
      const selectText = document.createElement("span");
      selectText.textContent = selection.label;
      select = document.createElement("select");
      select.id = selection.id;
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = selection.placeholder;
      select.append(placeholder);
      for (const option of selection.options) {
        const item = document.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        select.append(item);
      }
      selectLabel.append(selectText, select);
    }
    const actions = document.createElement("div");
    actions.className = "confirmation-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "confirm";
    confirm.textContent = confirmLabel;
    confirm.disabled = true;
    const updateConfirm = () => { confirm.disabled = !checkbox.checked || (select ? !select.value : false); };
    checkbox.addEventListener("change", updateConfirm);
    select?.addEventListener("change", updateConfirm);
    cancel.addEventListener("click", () => {
      if (!pending.active || state.pendingConfirmation?.token !== token) return;
      invalidatePendingConfirmation({ restorePhase: true });
      if (typeof onCancel === "function") onCancel();
    });
    confirm.addEventListener("click", async () => {
      if (!pending.active || state.pendingConfirmation?.token !== token) return;
      confirm.disabled = true;
      cancel.disabled = true;
      checkbox.disabled = true;
      if (select) select.disabled = true;
      pending.active = false;
      state.pendingConfirmation = null;
      try {
        await onConfirm(select?.value || null);
        card.remove();
        if (state.phase === "awaiting_confirmation") setPhase(operationalPhase());
      } catch (error) {
        card.remove();
        setPhase("failed");
        addMessage(`操作没有完成：${safeError(error)}`, "error");
      }
    });
    actions.append(cancel, confirm);
    card.append(heading, description);
    if (selectLabel) card.append(selectLabel);
    card.append(checkLabel, actions);
    $("#assistant-messages").append(card);
    scrollMessages();
  }

  function safeError(error) {
    return logic.friendlyErrorMessage(error);
  }

  async function runExclusiveWrite(operation) {
    if (state.writeInFlight) throw new Error("已有一项写入操作正在提交，请稍后再试");
    state.writeInFlight = true;
    setPhase("running");
    try {
      return await operation();
    } finally {
      state.writeInFlight = false;
      if (state.phase === "running") setPhase(operationalPhase());
    }
  }

  function rejectWhileWriting() {
    if (!state.writeInFlight) return false;
    addMessage("已有一项写入操作正在提交，请等它完成后再试。", "assistant");
    return true;
  }

  function switchPanelTab(tab, { focus = false } = {}) {
    const available = new Set(["chat", "log", "guide"]);
    const next = available.has(tab) ? tab : "chat";
    state.panelTab = next;
    document.querySelectorAll("[data-assistant-tab]").forEach(button => {
      const selected = button.dataset.assistantTab === next;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll("[data-assistant-view]").forEach(view => {
      view.hidden = view.dataset.assistantView !== next;
    });
    if (next === "log") renderLogs();
    if (focus && next === "chat") $("#assistant-input").focus();
  }

  function setPanel(open, { loadContext = true, restoreFocus = false, tab = "chat" } = {}) {
    const panel = $("#assistant-panel");
    clearMobileTap({ hideHint: open });
    if (!open && state.mobileMode) $("#assistant-input").blur();
    panel.hidden = !open;
    $("#assistant-launcher").setAttribute("aria-expanded", String(open));
    syncMobilePanelState(open);
    if (!open) {
      if (restoreFocus) $("#assistant-launcher").focus();
      return;
    }
    restoreInteraction({ hide: true });
    hideBubble();
    switchPanelTab(tab, { focus: tab === "chat" && !state.mobileMode });
    if (state.mobileMode) panel.focus({ preventScroll: true });
    if (loadContext && !state.contextLoaded) refreshContext({ announce: true }).then(showTodoSummary).catch(handleContextError);
  }

  function fallbackColors() {
    const styles = getComputedStyle(document.documentElement);
    return {
      accent: styles.getPropertyValue("--stone-theme-accent").trim() || "#397052",
      surface: styles.getPropertyValue("--stone-theme-surface").trim() || "#fffef9",
      font: styles.getPropertyValue("--stone-theme-font-body").trim() || "sans-serif"
    };
  }

  function drawFallback() {
    const colors = fallbackColors();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = colors.accent;
    context.beginPath();
    context.arc(96, 91, 54, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = colors.surface;
    context.font = `700 56px ${colors.font}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("S", 96, 95);
  }

  function switchAnimation(id) {
    if (!state.manifest?.animations?.[id]) return;
    state.animation = id;
    state.frame = 0;
    state.lastTick = 0;
    if (reduceMotion) drawFrame();
  }

  function frameDuration(animation, frame) {
    return animation.frameDurationsMs?.[frame] || animation.frameDurationMs || 140;
  }

  function drawFrame() {
    const animation = state.manifest?.animations?.[state.animation];
    const image = state.spriteImage;
    if (!animation || !image?.complete || !image.naturalWidth) return drawFallback();
    const width = animation.frameWidth || state.manifest.cellWidth || 192;
    const height = animation.frameHeight || state.manifest.cellHeight || 208;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, state.frame * width, animation.row * height, width, height, 0, 0, canvas.width, canvas.height);
  }

  function tick(time) {
    const animation = state.manifest?.animations?.[state.animation];
    if (!animation) return;
    if (!state.lastTick || time - state.lastTick >= frameDuration(animation, state.frame)) {
      drawFrame();
      state.lastTick = time;
      const next = state.frame + 1;
      state.frame = next >= animation.frameCount ? (animation.loop === false ? animation.frameCount - 1 : animation.loopStart || 0) : next;
    }
    state.animationRequest = requestAnimationFrame(tick);
  }

  async function loadSpriteAssets() {
    try {
      const response = await fetch("./assets/mochabuding/pet.json", { cache: "no-store" });
      if (!response.ok) throw new Error("小助理资源清单不可用");
      const pet = await response.json();
      if (pet.id !== "mochabuding" || !/^[a-z0-9._-]+\.webp$/.test(String(pet.spritesheetPath || ""))) throw new Error("小助理资源清单无效");
      state.manifest = {
        character: { id: pet.id, displayName: pet.displayName },
        cellWidth: 192,
        cellHeight: 208,
        animations: ATLAS_ANIMATIONS
      };
      state.spriteImage = await new Promise(resolve => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = `./assets/mochabuding/${pet.spritesheetPath}`;
      });
      if (!state.spriteImage) throw new Error("小助理动画图集不可用");
      state.animation = PHASES[state.phase]?.animation || "idle";
      if (reduceMotion) drawFrame();
      else state.animationRequest = requestAnimationFrame(tick);
    } catch {
      drawFallback();
    }
  }

  async function refreshContext({ announce = false } = {}) {
    setPhase("loading");
    if (announce) showBubble("我正在检查当前记忆体…");
    const [overview, mining] = await Promise.all([
      api(threadPath("/api/libraries/:threadId/overview"), { method: "GET" }),
      api(threadPath("/api/libraries/:threadId/mining/status"), { method: "GET" })
    ]);
    state.overview = overview;
    state.mining = mining;
    state.contextLoaded = true;
    document.querySelectorAll("[data-stone-library]").forEach(node => { node.textContent = overview.libraryName || "当前记忆体"; });
    renderTodos();
    markLogsDirty();
    setStatus(`已连接“${overview.libraryName || "当前记忆体"}”；写操作只会通过正式 Stone Memory 接口执行。`);
    setPhase(operationalPhase());
    if (logic.isMiningActive(mining.job) && !state.pollTimer) startPolling();
    return { overview, mining };
  }

  function handleContextError(error) {
    setPhase("failed");
    addMessage(`无法检查当前记忆体：${safeError(error)}`, "error");
  }

  function renderTodos() {
    const target = $("#todo-list");
    target.replaceChildren();
    const todos = logic.buildTodos({ overview: state.overview, mining: state.mining });
    for (const todo of todos) {
      const card = document.createElement("article");
      card.className = `todo-card ${todo.kind}`;
      const body = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = todo.title;
      const detail = document.createElement("span");
      detail.textContent = todo.detail;
      body.append(title, detail);
      card.append(body);
      target.append(card);
    }
  }

  function showTodoSummary() {
    const todos = logic.buildTodos({ overview: state.overview, mining: state.mining });
    const lines = todos.map(item => `• ${item.title}：${item.detail}`);
    recordAssistantLog("检查待办", "检查完成", `发现 ${todos.filter(item => item.id !== "ready").length} 项需要关注的状态。`, "completed");
    addMessage(`当前待办：\n${lines.join("\n")}`, "assistant", [
      { label: "一键维护", run: () => execute("一键维护", { echo: false }) },
      { label: "刷新", run: () => refreshContext().then(showTodoSummary).catch(handleContextError) }
    ]);
  }

  function recordAssistantLog(action, result, detail, status = "completed") {
    state.sessionLogs.unshift({
      id: `assistant-${Date.now()}-${state.sessionLogs.length}`,
      source: "小助理",
      action,
      result,
      detail,
      timestamp: new Date().toISOString(),
      status
    });
    state.sessionLogs = state.sessionLogs.slice(0, 30);
    markLogsDirty();
  }

  function formatLogDate(timestamp) {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date(timestamp));
  }

  function formatLogTime(timestamp) {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
  }

  function markLogsDirty() {
    state.logsDirty = true;
    if (state.panelTab === "log" && !$("#assistant-panel").hidden) renderLogs();
  }

  function renderLogs() {
    const target = $("#assistant-log-list");
    if (!target || !state.logsDirty) return;
    const systemLogs = logic.buildSystemLogs({ overview: state.overview || {}, mining: state.mining || {} });
    const logs = logic.mergeLogs(systemLogs, state.sessionLogs, 30);
    const signature = JSON.stringify(logs);
    state.logsDirty = false;
    if (signature === state.logSignature) return;
    state.logSignature = signature;
    const scrollContainer = target.closest(".assistant-view-scroll");
    const previousScrollTop = scrollContainer?.scrollTop || 0;
    target.querySelectorAll(".assistant-log-entry[open]").forEach(entry => state.openLogIds.add(entry.dataset.logId));
    const visibleIds = new Set(logs.map(log => log.id));
    state.openLogIds = new Set([...state.openLogIds].filter(id => visibleIds.has(id)));
    target.replaceChildren();
    if (!logs.length) {
      const empty = document.createElement("div");
      empty.className = "assistant-panel-placeholder";
      const title = document.createElement("strong");
      title.textContent = "暂时没有工作记录";
      const copy = document.createElement("p");
      copy.textContent = "完成一次状态检查或维护操作后，记录会出现在这里。";
      empty.append(title, copy);
      target.append(empty);
      if (scrollContainer) scrollContainer.scrollTop = 0;
      return;
    }
    let currentDate = "";
    let group = null;
    for (const log of logs) {
      const date = formatLogDate(log.timestamp);
      if (date !== currentDate) {
        currentDate = date;
        group = document.createElement("section");
        group.className = "assistant-log-group";
        const heading = document.createElement("h3");
        heading.className = "assistant-log-date";
        heading.textContent = date;
        group.append(heading);
        target.append(group);
      }
      const entry = document.createElement("details");
      entry.className = `assistant-log-entry ${log.status}`;
      entry.dataset.logId = log.id;
      entry.open = state.openLogIds.has(log.id);
      entry.addEventListener("toggle", () => {
        if (entry.open) state.openLogIds.add(log.id);
        else state.openLogIds.delete(log.id);
      });
      const summary = document.createElement("summary");
      const source = document.createElement("span");
      source.className = "assistant-log-source";
      source.textContent = log.source;
      const copy = document.createElement("span");
      copy.className = "assistant-log-copy";
      const action = document.createElement("strong");
      action.textContent = log.action;
      const result = document.createElement("span");
      result.textContent = `${formatLogTime(log.timestamp)} · ${log.result}`;
      copy.append(action, result);
      summary.append(source, copy);
      const detail = document.createElement("p");
      detail.className = "assistant-log-detail";
      detail.textContent = log.detail;
      entry.append(summary, detail);
      group.append(entry);
    }
    if (scrollContainer) scrollContainer.scrollTop = Math.min(previousScrollTop, Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight));
  }

  function showManualTask(id) {
    const task = MANUAL_TASKS[id];
    if (!task) return;
    switchPanelTab("chat", { focus: false });
    addMessage(`${task.title}\n${task.reason}\n\n真实操作路径：${task.path}\n\n当前开发者模块还不能精确打开内部子页面。我可以带你返回同一个记忆体的工作台，再按上面的路径进入。`, "assistant", [
      { label: "返回当前记忆体工作台", run: () => stoneModule.returnToDeveloperMode() }
    ]);
  }

  function showKnowledgeEntry(entry) {
    addMessage(`${entry.title}\n${entry.answer}\n\n${entry.detail}`, "assistant", (entry.related || []).slice(0, 3).map(prompt => ({
      label: prompt,
      run: () => execute(prompt, { echo: false })
    })));
  }

  function answerQuestion(question) {
    if (logic.isInternalQuestion(question)) {
      addMessage("这个问题藏得有点深啦～我主要负责介绍 Stone Memory 的功能和使用方法。你可以问我它什么时候用、该怎么操作，我会尽量帮你。", "assistant", [
        { label: "项目介绍", run: () => execute("介绍一下 Stone Memory", { echo: false }) },
        { label: "如何挖掘", run: () => execute("什么是记忆挖掘", { echo: false }) },
        { label: "一键维护", run: () => execute("一键维护会做什么", { echo: false }) }
      ]);
      return;
    }
    const matches = logic.matchKnowledge(question, knowledge);
    if (!matches.length || matches[0].score < 8) {
      addMessage("这个问题我暂时还没有学会呢～我更擅长帮你整理和维护 Stone Memory。要不要试试问我“怎么挖掘今天的记忆”？", "assistant", [
        { label: "项目介绍", run: () => execute("介绍一下 Stone Memory", { echo: false }) },
        { label: "如何挖掘", run: () => execute("什么是记忆挖掘", { echo: false }) },
        { label: "一键维护", run: () => execute("一键维护", { echo: false }) }
      ]);
      return;
    }
    showKnowledgeEntry(matches[0].entry);
    if (matches.length > 1 && matches[1].score >= matches[0].score * 0.55) {
      addMessage("你可能还想了解：", "assistant", matches.slice(1).map(match => ({ label: match.entry.title, run: () => showKnowledgeEntry(match.entry) })));
    }
  }

  async function prepareAutoMaintenance() {
    if (rejectWhileWriting()) return;
    await refreshContext({ announce: true });
    if (logic.isMiningActive(state.mining.job)) {
      addMessage("当前已经有挖掘任务在运行，我会继续显示它的进度，不会重复启动。", "assistant");
      recordAssistantLog("一键维护", "未重复启动", "检测到当前记忆体已有挖掘任务，继续跟踪正式任务状态。", "running");
      startPolling();
      return;
    }
    const dates = logic.pendingMiningDates(state.mining.dates);
    if (dates.length) {
      prepareMiningConfirmation(dates, true);
      return;
    }
    if (logic.needsRebuild(state.overview)) {
      showRebuildGuidance("没有待挖掘日期，但记忆更新后尚未重建。");
      return;
    }
    addMessage("当前没有需要自动处理的挖掘或重建待办。你可以继续查询摘要，或问我项目问题。", "assistant");
    recordAssistantLog("一键维护", "无需处理", "没有发现昨天及更早的待挖掘日期，也没有待应用的重建更新。", "completed");
    setTemporaryPhase("completed");
  }

  async function prepareMiningDate(date) {
    if (rejectWhileWriting()) return;
    await refreshContext();
    const row = (state.mining.dates || []).find(item => item.date === date);
    if (!row) {
      addMessage(`${date} 没有可供挖掘的对话记录。`, "assistant");
      return;
    }
    if (["completed", "completed_empty"].includes(row.status)) {
      addMessage(`${date} 已经完成挖掘。首期小助理不会代替你执行强制覆盖，请到正式挖掘工作台审查。`, "assistant");
      return;
    }
    if (logic.isMiningActive(state.mining.job)) {
      addMessage("当前已有挖掘任务运行，不能重复启动。", "assistant");
      return;
    }
    prepareMiningConfirmation([date], false);
  }

  function prepareMiningConfirmation(dates, automatic) {
    invalidatePendingConfirmation();
    const today = logic.beijingDateKey();
    const includesToday = dates.includes(today);
    const rows = dates.map(date => (state.mining.dates || []).find(item => item.date === date)).filter(Boolean);
    const messageCount = rows.reduce((sum, row) => sum + (Number(row.messageCount) || 0), 0);
    const dateDetail = dates.length <= 6 ? dates.join("、") : `${dates[0]} 至 ${dates.at(-1)}（共 ${dates.length} 天）`;
    const basePlan = logic.createMiningPlan({ dates, mining: state.mining, automatic });
    recordAssistantLog(automatic ? "一键维护" : "指定日期挖掘", "等待确认", `${dateDetail}，共 ${messageCount} 条对话。`, "waiting");
    addConfirmation({
      title: automatic ? "确认一键维护的挖掘计划" : "确认挖掘日期",
      detail: `记忆体：${state.overview.libraryName || "当前记忆体"}\n日期：${dateDetail}\n对话：${messageCount} 条\n挖掘通道：请在下方明确选择\n影响：将通过正式流程生成或更新这些日期的摘要与特征。${includesToday ? "\n注意：今天尚未结束，本次是你明确指定的单日操作。" : ""}`,
      acknowledgement: "我确认这些日期和挖掘通道正确，并同意通过正式 stmem mine 流程写入摘要与特征。",
      confirmLabel: automatic ? "开始一键维护" : "开始挖掘",
      selection: {
        id: `mining-mode-${Date.now()}`,
        label: "挖掘通道",
        placeholder: "请选择通道",
        options: [
          { value: "subagent", label: "Subagent" },
          { value: "api", label: "API" }
        ]
      },
      onConfirm: mode => startMining({ ...basePlan, mode }),
      onCancel: () => recordAssistantLog(automatic ? "一键维护" : "指定日期挖掘", "已取消", "用户在写入前取消了本次计划。", "completed")
    });
  }

  async function startMining(plan) {
    return runExclusiveWrite(async () => {
      const latest = await api(threadPath("/api/libraries/:threadId/mining/status"), { method: "GET" });
      const validation = logic.validateMiningPlan(plan, latest);
      if (!validation.ok) throw new Error(validation.message);
      state.mining = latest;
      showBubble("正在启动记忆挖掘…");
      const data = await api(threadPath("/api/libraries/:threadId/mining/start"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dates: plan.dates, forceDates: [], mode: plan.mode })
      });
      state.mining = { ...(state.mining || {}), job: data.job };
      state.automaticJobId = plan.automatic ? data.job?.id || null : null;
      state.progressMessage = addMessage(`挖掘任务已启动，共 ${plan.dates.length} 个日期。`, "assistant");
      recordAssistantLog(plan.automatic ? "一键维护" : "指定日期挖掘", "挖掘已启动", `正式任务包含 ${plan.dates.length} 个日期。`, "running");
      renderTodos();
      startPolling({ restart: true });
    });
  }

  function cancelPolling() {
    clearTimeout(state.pollTimer);
    state.pollTimer = 0;
    state.pollGeneration += 1;
  }

  function startPolling({ restart = false } = {}) {
    if (restart) cancelPolling();
    if (state.pollTimer) return;
    const generation = state.pollGeneration;
    state.pollTimer = window.setTimeout(() => {
      state.pollTimer = 0;
      pollMining(generation);
    }, 1200);
  }

  async function pollMining(generation = state.pollGeneration) {
    try {
      const mining = await api(threadPath("/api/libraries/:threadId/mining/status"), { method: "GET" });
      if (generation !== state.pollGeneration) return;
      state.mining = mining;
      renderTodos();
      const job = mining.job;
      if (!job) {
        state.automaticJobId = null;
        setPhase("idle");
        return;
      }
      const progress = `挖掘进度：${job.completed || 0}/${job.dates?.length || 0}${job.currentDate ? `，正在处理 ${job.currentDate}` : ""}`;
      if (state.progressMessage) state.progressMessage.querySelector("span").textContent = progress;
      else state.progressMessage = addMessage(progress, "assistant");
      if (!logic.TERMINAL_MINING.has(job.status)) {
        setPhase("running");
        startPolling();
        return;
      }
      const automatic = Boolean(state.automaticJobId && state.automaticJobId === job.id);
      state.automaticJobId = null;
      state.progressMessage = null;
      const failed = (job.results || []).filter(row => row.status === "failed");
      if (job.status === "completed" && !failed.length) {
        setPhase("completed");
        addMessage(`记忆挖掘已完成，成功处理 ${job.results?.length || job.dates?.length || 0} 个日期。`, "assistant");
        recordAssistantLog(automatic ? "一键维护" : "指定日期挖掘", "挖掘已完成", `成功处理 ${job.results?.length || job.dates?.length || 0} 个日期。`, "completed");
        await refreshContext();
        if (automatic) {
          showRebuildGuidance("一键维护的挖掘阶段已经完成。");
        }
      } else {
        setPhase("failed");
        const detail = failed.length ? failed.map(row => row.date).join("、") : job.status;
        addMessage(`挖掘没有全部成功：${detail}。我不会自动进入重建；请检查失败原因后重试。`, "error", failed.length ? [{ label: "重试失败日期", run: () => prepareMiningConfirmation(failed.map(row => row.date), false) }] : []);
        recordAssistantLog(automatic ? "一键维护" : "指定日期挖掘", "挖掘未全部成功", failed.length ? `${failed.length} 个日期需要在正式工作台检查。` : "任务已停止，未进入重建上下文。", "failed");
      }
    } catch (error) {
      if (generation !== state.pollGeneration) return;
      setPhase("failed");
      addMessage(`读取挖掘进度失败：${safeError(error)}`, "error", [{ label: "重试读取", run: () => startPolling() }]);
      recordAssistantLog("挖掘状态检查", "读取失败", "没有记录完整错误内容，请检查本地服务后重试。", "failed");
    }
  }

  async function prepareStopMining() {
    if (rejectWhileWriting()) return;
    await refreshContext();
    if (!logic.isMiningActive(state.mining.job)) {
      addMessage("当前没有正在运行的挖掘任务。", "assistant");
      return;
    }
    const expectedJobId = state.mining.job.id;
    addConfirmation({
      title: "确认停止当前挖掘",
      detail: state.mining.job.currentDate ? `当前正在处理 ${state.mining.job.currentDate}。` : "任务正在排队或准备停止。",
      acknowledgement: "我确认要停止当前记忆体的挖掘任务。已成功发布的既有记忆不会被删除。",
      confirmLabel: "停止挖掘",
      onCancel: () => recordAssistantLog("停止挖掘", "已取消", "任务继续按原计划运行。", "completed"),
      onConfirm: () => stopMining(expectedJobId)
    });
  }

  async function stopMining(expectedJobId) {
    return runExclusiveWrite(async () => {
      const latest = await api(threadPath("/api/libraries/:threadId/mining/status"), { method: "GET" });
      if (!logic.canStopJob(latest, expectedJobId)) throw new Error("原来的挖掘任务已经结束或发生变化，没有发送停止请求");
      state.mining = latest;
      const result = await api(threadPath("/api/libraries/:threadId/mining/stop"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (result.job) state.mining = { ...latest, job: result.job };
      addMessage(result.stopped === false ? "停止请求已处理，但当前任务可能已经结束。" : "已发送停止请求，正在等待任务结束。", "assistant");
      recordAssistantLog("停止挖掘", "已发送停止请求", "正在等待正式挖掘任务结束。", "running");
      startPolling({ restart: true });
    });
  }

  function showRebuildGuidance(prefix = "当前记忆体需要重建上下文。") {
    setPhase(operationalPhase());
    addMessage(`${prefix}\n\n为了避免把密钥、本机路径等设置读取到浏览器，小助理暂不直接生成或应用重建。请返回当前记忆体工作台，进入“维护 → 重建上下文”，在那里查看正式预览并确认执行。`, "assistant", [
      { label: "返回当前记忆体工作台", run: () => stoneModule.returnToDeveloperMode() }
    ]);
    recordAssistantLog("重建上下文", "需要人工确认", "请在正式工作台读取安全配置、查看预览并确认执行。", "waiting");
  }

  async function showRecent(days) {
    setPhase("loading");
    const data = await api(threadPath("/api/libraries/:threadId/feelings?page=1&sort=desc"), { method: "GET" });
    const cutoff = logic.shiftDate(logic.beijingDateKey(), -(days - 1));
    const rows = (data.rows?.rows || []).filter(row => String(row.source_date || row.sourceDate || "") >= cutoff);
    if (!rows.length) {
      setPhase("idle");
      addMessage(`最近 ${days} 天还没有可展示的摘要。可以先检查待办或运行一键维护。`, "assistant");
      return;
    }
    const lines = rows.slice(0, 5).map(row => {
      const content = String(row.coarse_summary || row.content || "").replace(/\s+/g, " ").trim();
      return `• ${row.source_date || row.sourceDate || "未标注日期"}：${content.slice(0, 88)}${content.length > 88 ? "…" : ""}`;
    });
    setTemporaryPhase("completed");
    addMessage(`最近 ${days} 天的摘要：\n${lines.join("\n")}`, "assistant");
  }

  function handleOperationError(error) {
    setPhase("failed");
    addMessage(`这次操作没有完成：${safeError(error)}`, "error");
    recordAssistantLog("小助理操作", "未完成", "没有记录敏感错误详情，请按页面提示检查正式服务。", "failed");
    showBubble("操作暂时失败了，请查看说明。\n");
  }

  async function execute(raw, { echo = true } = {}) {
    const input = String(raw || "").trim();
    if (!input || !state.ready) return;
    if (echo) addMessage(input, "user");
    const command = logic.parseCommand(input);
    try {
      if (command.type === "intro") return showKnowledgeEntry(knowledge.find(entry => entry.id === "intro"));
      if (command.type === "todos") { await refreshContext({ announce: true }); return showTodoSummary(); }
      if (command.type === "auto_maintenance") return await prepareAutoMaintenance();
      if (command.type === "mine_yesterday") return await prepareMiningDate(logic.shiftDate(logic.beijingDateKey(), -1));
      if (command.type === "mine_today") return await prepareMiningDate(logic.beijingDateKey());
      if (command.type === "mine_date") return await prepareMiningDate(command.date);
      if (command.type === "stop_mining") return await prepareStopMining();
      if (command.type === "preview_rebuild" || command.type === "apply_rebuild") return showRebuildGuidance();
      if (command.type === "recent") return await showRecent(command.days);
      if (command.type === "question") return answerQuestion(command.text);
    } catch (error) {
      handleOperationError(error);
    }
  }

  function bindEvents() {
    const launcher = $("#assistant-launcher");
    launcher.addEventListener("mouseenter", () => { if (!state.mobileMode) playInteraction(); });
    launcher.addEventListener("mouseleave", () => { if (!state.mobileMode) restoreInteraction({ hide: true }); });
    launcher.addEventListener("click", handleLauncherClick);
    $("#assistant-close").addEventListener("click", () => setPanel(false, { restoreFocus: true }));
    $("#assistant-return").addEventListener("click", () => stoneModule.returnToDeveloperMode());
    $("#dashboard-refresh").addEventListener("click", () => refreshContext({ announce: true }).then(showTodoSummary).catch(handleContextError));
    $("#assistant-log-refresh").addEventListener("click", () => refreshContext().catch(handleContextError));
    $("#assistant-form").addEventListener("submit", event => {
      event.preventDefault();
      const input = $("#assistant-input");
      const command = input.value;
      input.value = "";
      execute(command);
    });
    $("#assistant-revisit-guide").addEventListener("click", () => openGuide({ restart: true }));
    $("#assistant-guide-restart").addEventListener("click", () => {
      state.guideStep = 0;
      renderGuideStep();
    });
    $("#assistant-guide-prev").addEventListener("click", () => {
      state.guideStep = Math.max(0, state.guideStep - 1);
      renderGuideStep();
    });
    $("#assistant-guide-next").addEventListener("click", () => {
      if (state.guideStep >= GUIDE_STEPS.length - 1) return finishGuide();
      state.guideStep += 1;
      renderGuideStep();
    });
    $("#assistant-guide-skip").addEventListener("click", finishGuide);
    const tabs = [...document.querySelectorAll("[data-assistant-tab]")];
    tabs.forEach((button, index) => {
      button.addEventListener("click", () => switchPanelTab(button.dataset.assistantTab));
      button.addEventListener("keydown", event => {
        let target = null;
        if (event.key === "ArrowRight") target = tabs[(index + 1) % tabs.length];
        if (event.key === "ArrowLeft") target = tabs[(index - 1 + tabs.length) % tabs.length];
        if (event.key === "Home") target = tabs[0];
        if (event.key === "End") target = tabs.at(-1);
        if (!target) return;
        event.preventDefault();
        switchPanelTab(target.dataset.assistantTab);
        target.focus();
      });
    });
    document.addEventListener("keydown", event => {
      trapMobilePanelFocus(event);
      if (event.key === "Escape" && !$("#assistant-panel").hidden) setPanel(false, { restoreFocus: true });
    });
    window.addEventListener("resize", syncMobileMode);
    window.visualViewport?.addEventListener("resize", updateVisualViewportMetrics);
    window.visualViewport?.addEventListener("scroll", updateVisualViewportMetrics);
    window.addEventListener("orientationchange", () => {
      clearMobileTap({ hideHint: true });
      syncMobileMode();
    });
    document.querySelectorAll("[data-command]").forEach(button => button.addEventListener("click", () => {
      if ($("#assistant-panel").hidden) setPanel(true, { loadContext: false });
      else switchPanelTab("chat");
      execute(button.dataset.command);
    }));
    document.querySelectorAll("[data-manual-task]").forEach(button => button.addEventListener("click", () => showManualTask(button.dataset.manualTask)));
  }

  async function init() {
    syncMobileMode();
    bindEvents();
    drawFallback();
    if (!stoneModule?.threadId) {
      showUnavailable("此地址没有携带真实 threadId。请从某个记忆体的插件工坊打开 Stone Memory 小助理。");
      return;
    }
    try {
      const overview = await api(threadPath("/api/libraries/:threadId/overview"), { method: "GET" });
      state.overview = overview;
      const nickname = logic.nicknameForThread(stoneModule.threadId);
      setAssistantIdentity(nickname);
      document.querySelectorAll("[data-stone-library]").forEach(node => { node.textContent = overview.libraryName || "当前记忆体"; });
      setStatus("已验证当前记忆体，正在读取待办和运行状态。\n");
      enableControls();
      addMessage(`你好，我是“${nickname}”。我可以介绍项目、回答使用问题，也可以在你确认后帮“${overview.libraryName || "当前记忆体"}”执行记忆挖掘，并引导你安全完成重建上下文。`, "assistant");
      showBubble("你好，点击我查看待办或问问题。\n");
      loadSpriteAssets();
      renderGuideStep();
      await refreshContext();
    } catch (error) {
      showUnavailable(`无法验证这个记忆体：${safeError(error)}`);
    }
  }

  window.addEventListener("beforeunload", () => {
    cancelPolling();
    clearTimeout(state.temporaryPhaseTimer);
    clearTimeout(state.bubbleTimer);
    clearTimeout(state.interactionTimer);
    clearTimeout(state.mobileTapTimer);
    unlockMobilePage({ restoreScroll: false });
    window.visualViewport?.removeEventListener("resize", updateVisualViewportMetrics);
    window.visualViewport?.removeEventListener("scroll", updateVisualViewportMetrics);
    cancelAnimationFrame(state.animationRequest);
  }, { once: true });

  init();
})();
