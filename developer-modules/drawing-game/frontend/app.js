(() => {
  "use strict";
  const runtime = window.StoneDeveloperModule;
  const threadId = runtime?.threadId || "";
  const $ = selector => document.querySelector(selector);
  let state = { room: null, round: null, events: [], words: [], gallery: [] };
  let composeMode = "guess";
  let pollTimer = null;
  let brushColor = "#18230f";
  let strokes = [];
  let activeStroke = null;
  let renderedAgentDrawing = "";
  let animating = false;
  const galleryUrls = new Map();
  const canvas = $("#canvas");
  const ctx = canvas.getContext("2d", { alpha: false });

  async function command(action, payload = {}) {
    return await runtime.api(`/api/developer-modules/drawing-game/commands/${encodeURIComponent(action)}?thread=${encodeURIComponent(threadId)}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.remove("hidden");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.add("hidden"), 3200);
  }

  function showView(name) {
    document.querySelectorAll(".view-tabs button").forEach(button => button.classList.toggle("active", button.dataset.view === name));
    document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === `${name}-view`));
  }

  function clearCanvas(resetStrokes = true) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (resetStrokes) strokes = [];
  }

  function redraw() {
    clearCanvas(false);
    for (const stroke of strokes) drawStroke(stroke);
  }

  function drawStroke(stroke, pointLimit = null) {
    const points = pointLimit == null ? stroke.points : stroke.points.slice(0, pointLimit);
    if (points.length < 2) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    ctx.moveTo(points[0][0] / 1000 * canvas.width, points[0][1] / 1000 * canvas.height);
    for (const point of points.slice(1)) ctx.lineTo(point[0] / 1000 * canvas.width, point[1] / 1000 * canvas.height);
    ctx.stroke();
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1000, (event.clientX - rect.left) / rect.width * 1000)),
      Math.max(0, Math.min(1000, (event.clientY - rect.top) / rect.height * 1000)),
    ];
  }

  function beginStroke(event) {
    if (!canHumanDraw()) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    activeStroke = { color: brushColor, width: Number($("#brush-width").value), points: [canvasPoint(event)] };
    strokes.push(activeStroke);
  }

  function continueStroke(event) {
    if (!activeStroke) return;
    event.preventDefault();
    const point = canvasPoint(event);
    const previous = activeStroke.points.at(-1);
    activeStroke.points.push(point);
    ctx.strokeStyle = activeStroke.color;
    ctx.lineWidth = activeStroke.width;
    ctx.beginPath();
    ctx.moveTo(previous[0] / 1000 * canvas.width, previous[1] / 1000 * canvas.height);
    ctx.lineTo(point[0] / 1000 * canvas.width, point[1] / 1000 * canvas.height);
    ctx.stroke();
  }

  function endStroke() { activeStroke = null; }

  function canHumanDraw() {
    return state.room?.status === "active" && state.room.phase === "drawing" && state.room.drawer === "human" && !animating;
  }

  async function animateAgentDrawing(drawing) {
    if (!Array.isArray(drawing) || !drawing.length || animating) return;
    const signature = JSON.stringify(drawing);
    if (signature === renderedAgentDrawing) return;
    renderedAgentDrawing = signature;
    animating = true;
    strokes = [];
    clearCanvas();
    for (const source of drawing) {
      const stroke = { color: source.color, width: source.width, points: [] };
      strokes.push(stroke);
      for (const point of source.points) {
        stroke.points.push(point);
        redraw();
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    }
    animating = false;
    try {
      state = await command("drawing-submit", { roomCode: state.room.code, actor: "agent", imageDataUrl: canvas.toDataURL("image/png") });
      render();
    } catch (error) { toast(error.message); }
  }

  function render() {
    const room = state.room;
    const hasLiveRoom = Boolean(room && room.status !== "ended");
    $("#empty-room").classList.toggle("hidden", hasLiveRoom);
    $("#room").classList.toggle("hidden", !hasLiveRoom);
    renderWords();
    renderGallery();
    if (!hasLiveRoom) return;
    $("#room-code").textContent = room.code;
    const humanName = state.settings?.humanName || "你";
    const agentName = state.settings?.agentName || "AI";
    $("#human-label").textContent = humanName;
    $("#agent-label").textContent = agentName;
    $("#human-score").textContent = room.scores?.human || 0;
    $("#ai-score").textContent = room.scores?.agent || 0;
    $("#lobby-controls").classList.toggle("hidden", room.status !== "lobby");
    $("#play-area").classList.toggle("hidden", room.status !== "active");
    if (room.status === "lobby") {
      $("#turn-title").textContent = "房间准备好了";
      const joined = Boolean(room.agentJoined);
      $("#agent-status").textContent = room.agentOnline
        ? `${agentName}已经进入并在等待，可以开始了。`
        : joined
          ? `${agentName}仍在房间里，当前没有等待心跳；可以继续游戏，也可以提醒他再次等待。`
          : `先把邀请语发给${agentName}，等他通过 MCP 进入房间。`;
      $("#invite-text").textContent = `来玩你画我猜。请调用 Stone Memory MCP：先执行 stmem_drawing_game_agent_join，参数为 {\"memoryId\":\"${threadId}\",\"roomCode\":\"${room.code}\"}；再用返回的 room.eventCursor 作为 afterSeq 调用 stmem_drawing_game_agent_wait 留在房间里。`;
      $("#start-game").disabled = !joined;
      $("#start-game").textContent = joined ? "开始游戏" : `等待${agentName}进入……`;
      schedulePoll();
      return;
    }
    const round = state.round;
    $("#turn-title").textContent = room.drawer === "agent" ? `${agentName}正在画` : `轮到${humanName}画`;
    $("#round-label").textContent = `第${room.roundNo}/${room.maxRounds}轮`;
    $("#phase-label").textContent = phaseText(room.phase);
    $("#secret-word").textContent = round?.word || (round ? `${round.wordLength}个字` : "等待题目");
    const humanDrawing = canHumanDraw();
    $("#drawing-tools").classList.toggle("hidden", !humanDrawing);
    const waitingForAgentDrawing = room.phase === "drawing" && room.drawer === "agent" && !round?.drawing;
    $("#canvas-blocker").classList.toggle("hidden", !waitingForAgentDrawing);
    $("#canvas-message").textContent = room.phase === "drawing" ? `等待${agentName}作画……` : room.phase === "guessing" ? "作品已完成" : "这一轮结束啦";
    $("#next-round").classList.toggle("hidden", room.phase !== "round-complete");
    $("#reveal-round").classList.toggle("hidden", !new Set(["drawing", "guessing"]).has(room.phase));
    renderEvents();
    updateComposer();
    schedulePoll();
    if (room.drawer === "agent" && room.phase === "drawing" && round?.drawing) animateAgentDrawing(round.drawing);
  }

  function phaseText(phase) {
    return ({ drawing: "作画中", guessing: "猜词中", "round-complete": "本轮结束", ended: "已结束" })[phase] || "等待中";
  }

  function renderEvents() {
    const host = $("#event-list");
    host.replaceChildren();
    for (const event of state.events || []) {
      const row = document.createElement("div");
      row.className = `event ${event.kind} ${event.meta?.correct ? "correct" : ""}`;
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = event.actor === "human" ? (state.settings?.humanName || "你") : event.actor === "agent" ? (state.settings?.agentName || "AI") : event.kind === "guess" ? "猜" : "游戏";
      const text = document.createElement("span");
      text.textContent = event.text;
      row.append(badge, text);
      host.append(row);
    }
    host.scrollTop = host.scrollHeight;
  }

  function updateComposer() {
    const canGuess = state.room?.phase === "guessing" && state.room.drawer === "agent";
    if (!canGuess && composeMode === "guess") setComposeMode("chat");
    document.querySelector('[data-compose="guess"]').disabled = !canGuess;
    $("#message").placeholder = composeMode === "guess" ? "输入你的答案" : `和${state.settings?.agentName || "AI"}说句话`;
  }

  function setComposeMode(mode) {
    composeMode = mode;
    document.querySelectorAll("[data-compose]").forEach(button => button.classList.toggle("active", button.dataset.compose === mode));
    updateComposer();
  }

  function renderWords() {
    const words = state.words || [];
    $("#word-count").textContent = `${words.length}个`;
    const host = $("#word-list");
    host.replaceChildren();
    for (const word of words) {
      const chip = document.createElement("div");
      chip.className = "word-chip";
      const label = document.createElement("span");
      label.textContent = word.word;
      const meta = document.createElement("small");
      meta.textContent = `${word.category} · ${word.difficulty}`;
      chip.append(label, meta);
      if (word.source === "custom") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "删除";
        remove.addEventListener("click", () => removeWord(word));
        chip.append(remove);
      }
      host.append(chip);
    }
  }

  function renderGallery() {
    const items = state.gallery || [];
    $("#gallery-count").textContent = `${items.length}张`;
    const host = $("#gallery");
    host.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "第一张画还没有出现。";
      host.append(empty);
      return;
    }
    for (const item of items) {
      const card = document.createElement("article");
      card.className = "gallery-card";
      const image = document.createElement("img");
      image.alt = `${playerName(item.drawer)}画的${item.word}`;
      const caption = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = `${playerName(item.drawer)} · ${item.word}`;
      const download = document.createElement("a");
      download.href = "#";
      download.download = `${item.word}-${item.drawer}.png`;
      download.textContent = "下载";
      caption.append(label, download);
      card.append(image, caption);
      host.append(card);
      loadGalleryImage(item, image, download);
    }
  }

  function playerName(actor) {
    return actor === "agent" ? (state.settings?.agentName || "AI") : (state.settings?.humanName || "你");
  }

  async function loadGalleryImage(item, image, download) {
    try {
      let url = galleryUrls.get(item.id);
      if (!url) {
        const result = await command("image-read", { roundId: item.id });
        const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: result.mime || "image/png" }));
        galleryUrls.set(item.id, url);
      }
      image.src = url;
      download.href = url;
    } catch (error) {
      image.alt = `画作读取失败：${error.message}`;
      download.remove();
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (state.room?.status !== "active") return;
    pollTimer = setTimeout(refresh, 1800);
  }

  async function refresh() {
    try {
      state = await command("state", state.room ? { roomCode: state.room.code } : {});
      render();
    } catch (error) {
      toast(error.message);
      pollTimer = setTimeout(refresh, 4000);
    }
  }

  async function removeWord(word) {
    if (!confirm(`从自定义词库删除“${word.word}”？`)) return;
    try { state = await command("word-delete", { wordId: word.id, roomCode: state.room?.code }); render(); }
    catch (error) { toast(error.message); }
  }

  document.querySelectorAll(".view-tabs button").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll("[data-compose]").forEach(button => button.addEventListener("click", () => setComposeMode(button.dataset.compose)));
  document.querySelectorAll(".color").forEach(button => button.addEventListener("click", () => {
    brushColor = button.dataset.color;
    document.querySelectorAll(".color").forEach(item => item.classList.toggle("selected", item === button));
  }));
  canvas.addEventListener("pointerdown", beginStroke);
  canvas.addEventListener("pointermove", continueStroke);
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  $("#undo").addEventListener("click", () => { strokes.pop(); redraw(); });
  $("#clear").addEventListener("click", () => clearCanvas());
  $("#create-room").addEventListener("click", async () => {
    try {
      await command("settings-save", { humanName: $("#human-name").value, agentName: $("#agent-name").value });
      state = await command("room-create", { maxRounds: Number($("#max-rounds").value) });
      render();
    }
    catch (error) { toast(error.message); }
  });
  $("#start-game").addEventListener("click", async () => {
    try {
      clearCanvas();
      state = await command("game-start", { roomCode: state.room.code, maxRounds: Number($("#max-rounds").value), firstDrawer: $("#first-drawer").value });
      render();
    } catch (error) { toast(error.message); }
  });
  $("#copy-invite").addEventListener("click", async () => {
    const text = $("#invite-text").textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast("邀请语已复制");
    } catch {
      toast("复制失败，请长按邀请语复制");
    }
  });
  $("#submit-drawing").addEventListener("click", async () => {
    if (!strokes.length) return toast("先画一点东西吧");
    try { state = await command("drawing-submit", { roomCode: state.room.code, actor: "human", imageDataUrl: canvas.toDataURL("image/png") }); render(); }
    catch (error) { toast(error.message); }
  });
  $("#next-round").addEventListener("click", async () => {
    try { clearCanvas(); renderedAgentDrawing = ""; state = await command("round-next", { roomCode: state.room.code }); render(); }
    catch (error) { toast(error.message); }
  });
  $("#reveal-round").addEventListener("click", async () => {
    if (!confirm("这一轮就到这里，并揭晓答案吗？")) return;
    try { state = await command("round-reveal", { roomCode: state.room.code, actor: "human" }); render(); }
    catch (error) { toast(error.message); }
  });
  $("#end-game").addEventListener("click", async () => {
    if (!confirm("结束这局游戏？完成图片会留在图库，房间聊天不会另存一份。")) return;
    try { state = await command("game-end", { roomCode: state.room.code }); render(); toast("游戏结束，AI 回到普通聊天模式。") }
    catch (error) { toast(error.message); }
  });
  $("#composer").addEventListener("submit", async event => {
    event.preventDefault();
    const text = $("#message").value.trim();
    if (!text) return;
    try {
      state = await command(composeMode === "guess" ? "guess" : "chat", composeMode === "guess"
        ? { roomCode: state.room.code, actor: "human", answer: text }
        : { roomCode: state.room.code, actor: "human", text });
      $("#message").value = "";
      render();
    } catch (error) { toast(error.message); }
  });
  $("#word-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      state = await command("word-add", { roomCode: state.room?.code, word: $("#word").value, aliases: $("#aliases").value, category: $("#category").value, difficulty: $("#difficulty").value });
      $("#word").value = "";
      $("#aliases").value = "";
      render();
      toast("已经加入你的词库");
    } catch (error) { toast(error.message); }
  });

  clearCanvas();
  refresh().then(() => {
    $("#human-name").value = state.settings?.humanName || "你";
    $("#agent-name").value = state.settings?.agentName || "AI";
  });
})();
