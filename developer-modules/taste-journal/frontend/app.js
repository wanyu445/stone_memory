(() => {
  "use strict";

  const host = window.StoneDeveloperModule;
  const core = window.TasteJournalCore;
  const memoryId = host && host.memoryId ? host.memoryId : "";
  const COMMAND = "/api/developer-modules/taste-journal/commands/";
  const RULE_NAME = "taste-journal.md";
  const UI_PREFS_KEY = "taste-journal-ui-prefs";

  /* 与 prompts/default.md 保持一致：点亮 AI 记录时写入线程规则。 */
  const RULE_TEXT = [
    "# 味觉档案 · 自动记录习惯",
    "",
    "当前版本使用稳定的 memoryId。MCP 已启用且会话已绑定时，优先使用 stmem_taste_journal_list / stats / add / update / digest，宿主绑定当前记忆体，不传其他记忆体 ID。MCP 的 options 使用 [{\"key\":\"糖度\",\"value\":\"微糖\"}] 键值列表。没有这些工具时才使用下方正式 CLI，--memory 指向当前记忆体；CLI 的 options 仍是键值对象。一次体验只走一种通道记录一次，不因换通道重复提交。删除、清空和合并前取得用户明确确认。",
    "",
    "本记忆体启用了「味觉档案」模块（taste-journal），专门记录奶茶、咖啡、甜品、外卖等吃喝体验。当用户提到喝了、点了、吃了、试了某款东西（包括回忆，比如“昨天那杯伯牙绝弦”）时：",
    "",
    "1. 提取一条品尝记录，字段如下：",
    "   - product.brand 品牌（必填，如“霸王茶姬”）",
    "   - product.name 品名（必填，如“伯牙绝弦”）",
    "   - product.category 品类：drink 饮品 / dessert 甜品 / takeout 外卖 / other 其他",
    "   - product.tags 口味标签数组，用用户说过的词（如“桂花”“乌龙”“生椰”），没有就不填",
    "   - entry.ratingId 评分：love 特别喜欢 / tried 尝鲜一次 / avoid 避雷",
    "   - entry.options 配置键值对：糖度、冰量、温度、茶底、小料、规格等，用户提到的才写；用户说“老样子/还是那样”就不写 options，模块会沿用上次",
    "   - entry.note 一句话短评，尽量用用户原话概括",
    "   - entry.price 数字，只在用户明确说了金额时记录",
    "2. 写入命令（模块会自动按品牌+品名归并到同一张档案卡，不需要先查旧记录）：",
    "   `stmem module taste-journal add --memory <当前记忆体ID> --batch-file <临时json文件>`",
    "   batch 文件示例：",
    "   `{\"product\":{\"brand\":\"霸王茶姬\",\"name\":\"伯牙绝弦\",\"category\":\"drink\",\"tags\":[\"茉莉\"]},\"entry\":{\"options\":{\"糖度\":\"微糖\",\"冰量\":\"去冰\"},\"ratingId\":\"love\",\"note\":\"茶感清冽\",\"price\":18}}`",
    "3. 记完只回一句话确认（品名+评分），不要展开点评，不要复述记录内容，用户没问就不要罗列历史。",
    "4. 拿不准品名或评分时，改发 `{\"raw\":\"用户原话片段\"}`，模块会存为待整理草稿，之后在模块页面补全。",
    "5. 用户问“我喝过什么 / 某口味哪家好喝 / 帮我整理口味 / 月度报告”时，先用 `stmem module taste-journal list --memory <id> --batch-file <查询json>`（如 `{\"query\":{\"tag\":\"桂花\"}}` 或 `{\"query\":{\"month\":\"2026-09\"}}`）和 `stmem module taste-journal stats --memory <id>` 读取，再回答。",
    "6. 用户要整理或月度报告时，把结论写回模块：",
    "   `stmem module taste-journal digest --memory <id> --batch-file <json>`",
    "   格式：`{\"scope\":\"month\",\"month\":\"YYYY-MM\",\"sections\":[{\"heading\":\"本月口味\",\"body\":\"...\"}],\"proposals\":[{\"kind\":\"ratingLabel\",\"label\":\"干杯不腻\",\"sentiment\":\"positive\"}]}`，proposals 可以提议新评分档位或给某张卡补充口味标签。",
    "7. 记录本身不进入对话上下文展开；除非用户主动问起，不要主动罗列记录。",
  ].join("\n");

  const model = { data: null, stats: null };
  const state = {
    tab: "calendar",
    month: "",
    filters: { tag: "", category: "", sort: "recent" },
    archiveMode: "cards",
    pendingDraftId: "",
  };

  const $ = selector => document.querySelector(selector);

  /* ---------- 小工具 ---------- */

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "{}"); } catch { return {}; }
  }
  function writePrefs(patch) {
    try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch })); } catch {}
  }

  async function getCommand(action) {
    return host.api(COMMAND + action + "?memoryId=" + encodeURIComponent(memoryId));
  }
  async function postCommand(action, payload) {
    return host.api(COMMAND + action + "?memoryId=" + encodeURIComponent(memoryId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  let toastTimer = "";
  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
  }

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage || "已复制");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      try { document.execCommand("copy"); toast(okMessage || "已复制"); }
      catch { toast("复制失败，请手动复制"); }
      area.remove();
    }
  }

  let confirmAction = null;
  function confirmBox(title, copy, label, action) {
    $("#confirm-title").textContent = title;
    $("#confirm-copy").textContent = copy;
    $("#confirm-action").textContent = label;
    confirmAction = action;
    $("#confirm-dialog").showModal();
  }

  function openSheet(html) {
    const dialog = $("#sheet-dialog");
    dialog.innerHTML = `<div class="sheet-inner"><div class="sheet-head"><div></div><button type="button" class="sheet-close" data-action="sheet-close" aria-label="关闭">✕</button></div>${html}</div>`;
    dialog.showModal();
  }
  function closeSheet() {
    const dialog = $("#sheet-dialog");
    if (dialog.open) dialog.close();
    state.pendingDraftId = "";
  }

  function productById(id) {
    return (model.data.products || []).find(product => product.id === id) || null;
  }
  function entryById(id) {
    return (model.data.entries || []).find(entry => entry.id === id) || null;
  }
  function ratingInfo(ratingId) {
    return core.ratingLabelOf(model.data.settings, ratingId);
  }
  function categoryInfo(categoryId) {
    return core.categoryOf(categoryId);
  }

  /* ---------- 数据 ---------- */

  async function hydrate() {
    const [list, stats] = await Promise.all([getCommand("list"), getCommand("stats")]);
    model.data = list;
    model.stats = stats.stats;
    if (!state.month) state.month = (list.today || core.todayStr()).slice(0, 7);
  }

  async function refresh() {
    await hydrate();
    render();
  }

  /* ---------- 渲染调度 ---------- */

  function render() {
    if (!model.data) return;
    $("#view-calendar").hidden = state.tab !== "calendar";
    $("#view-archive").hidden = state.tab !== "archive";
    $("#view-settings").hidden = state.tab !== "settings";
    document.querySelectorAll("#tab-bar button").forEach(button => {
      button.classList.toggle("active", button.dataset.tab === state.tab);
    });
    if (state.tab === "calendar") renderCalendar();
    if (state.tab === "archive") renderArchive();
    if (state.tab === "settings") renderSettings();
    $("#fab-add").hidden = false;
  }

  /* ---------- 月历 ---------- */

  function monthOf(offset) {
    const [year, month] = state.month.split("-").map(Number);
    const date = new Date(year, month - 1 + offset, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function entriesByDate() {
    const map = new Map();
    for (const entry of model.data.entries) {
      if (!map.has(entry.date)) map.set(entry.date, []);
      map.get(entry.date).push(entry);
    }
    return map;
  }

  function monthDigest(month) {
    return (model.data.digests || []).find(digest => digest.scope === "month" && digest.month === month) || null;
  }

  function renderReportCard(month) {
    const monthStats = (model.stats.months || []).find(row => row.month === month);
    const digest = monthDigest(month);
    const settings = model.data.settings;
    const parts = [];
    parts.push(`<div class="report-head"><div><p class="kicker">MONTHLY REPORT</p><h3>${esc(month)} 小结</h3></div></div>`);
    const pills = [];
    if (monthStats) {
      pills.push(`<span class="stat-pill">🍶 <b>${monthStats.count}</b> 笔</span>`);
      pills.push(`<span class="stat-pill">✨ 新尝 <b>${monthStats.newProducts}</b> 款</span>`);
      pills.push(`<span class="stat-pill">🔥 特别喜欢 <b>${monthStats.love}</b></span>`);
      pills.push(`<span class="stat-pill">⛔ 避雷 <b>${monthStats.avoid}</b></span>`);
      if (settings.showSpend && monthStats.spend) pills.push(`<span class="stat-pill">💰 花销 ¥<b>${monthStats.spend}</b></span>`);
    } else {
      pills.push(`<span class="stat-pill">这个月还没有记录，右下角的小杯子等你 ☕</span>`);
    }
    parts.push(`<div class="report-stats">${pills.join("")}</div>`);

    if (digest) {
      const sections = digest.sections.map(section =>
        `<div class="report-section">${section.heading ? `<h4>${esc(section.heading)}</h4>` : ""}<p>${esc(section.body)}</p></div>`
      ).join("");
      const proposals = (digest.proposals || []).map((proposal, index) => {
        const label = proposal.kind === "ratingLabel" ? `新评分档「${esc(proposal.label)}」` : `给档案加标签「${esc(proposal.label)}」`;
        return `<span class="proposal-chip">${label}<button type="button" data-action="adopt-proposal" data-index="${index}">采纳</button></span>`;
      }).join("");
      parts.push(`<div class="report-body">${sections}${proposals ? `<div class="proposal-row">${proposals}</div>` : ""}<p class="report-meta">由 ${digest.author ? esc(digest.author) : "AI"} 整理于 ${esc((digest.updatedAt || "").slice(0, 10))}</p></div>`);
    } else if (monthStats) {
      parts.push(`<div class="report-body"><div class="report-section"><p>统计已经就绪，叙事段落还空着。去聊天框说一句“帮我整理 ${esc(month)} 的味觉月报”，TA 读完后会写回这里。</p>
        <div class="row-actions"><button type="button" class="small-button" data-action="report-copy-ask">复制这句话去催 TA</button></div></div></div>`);
    }
    return `<section class="report-card flourish">${parts.join("")}</section>`;
  }

  function renderCalendar() {
    const month = state.month;
    const [year, monthIndex] = month.split("-").map(Number);
    const firstDay = new Date(year, monthIndex - 1, 1);
    const daysInMonth = new Date(year, monthIndex, 0).getDate();
    const lead = (firstDay.getDay() + 6) % 7;
    const today = model.data.today || core.todayStr();
    const byDate = entriesByDate();
    const cells = [];
    const week = ["一", "二", "三", "四", "五", "六", "日"];
    cells.push(week.map(name => `<div class="calendar-head">${name}</div>`).join(""));
    for (let i = 0; i < lead; i += 1) cells.push(`<div class="day-cell empty"></div>`);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${month}-${String(day).padStart(2, "0")}`;
      const dayEntries = byDate.get(date) || [];
      const emojis = dayEntries.slice(0, 4).map(entry => {
        const product = productById(entry.productId);
        return product ? categoryInfo(product.category).emoji : "🎁";
      });
      const more = dayEntries.length > 4 ? `<span class="day-more">+${dayEntries.length - 4}</span>` : "";
      const tint = dayEntries.length ? ` style="background:color-mix(in srgb,var(--stone-theme-accent) ${Math.min(8 + dayEntries.length * 5, 30)}%,var(--stone-theme-surface))"` : "";
      cells.push(`<button type="button" class="day-cell${date === today ? " today" : ""}${dayEntries.length ? " sweet" : ""}"${tint} data-action="open-day" data-date="${date}"><span class="day-num">${day}</span><span class="day-icons">${emojis.join("")}${more}</span></button>`);
    }
    $("#view-calendar").innerHTML = `
      <div class="month-nav">
        <h2>${year} 年 ${monthIndex} 月</h2>
        <div class="nav-buttons">
          <button type="button" class="nav-button" data-action="cal-prev" aria-label="上个月">‹</button>
          <button type="button" class="nav-button" data-action="cal-today">回到今天</button>
          <button type="button" class="nav-button" data-action="cal-next" aria-label="下个月">›</button>
        </div>
      </div>
      ${renderReportCard(month)}
      <div class="calendar-grid tablecloth">${cells.join("")}</div>`;
  }

  function openDaySheet(date) {
    const entries = (model.data.entries || []).filter(entry => entry.date === date);
    const rows = entries.map(entry => {
      const product = productById(entry.productId);
      const rating = ratingInfo(entry.ratingId);
      const options = Object.keys(entry.options || {}).length ? `<span class="entry-options">${esc(core.optionText(entry.options))}</span>` : "";
      return `<div class="day-entry">
        <div class="line1"><span class="who">${product ? `${categoryInfo(product.category).emoji} ${esc(product.brand)} · ${esc(product.name)}` : "未知档案"}</span><span class="rating-chip ${rating.sentiment}">${esc(rating.emoji)} ${esc(rating.label)}</span></div>
        ${options}
        ${entry.note ? `<p class="entry-note">${esc(entry.note)}</p>` : ""}
        <div class="row-actions">
          <button type="button" class="small-button" data-action="open-entry-edit" data-id="${entry.id}">改一下</button>
          <button type="button" class="small-button" data-action="delete-entry" data-id="${entry.id}">删掉</button>
        </div>
      </div>`;
    }).join("");
    openSheet(`
      <p class="kicker">DAY NOTES</p><h3>${esc(date)} 的吃喝</h3>
      <div class="sheet-stack" style="margin-top:12px">
        ${rows || `<div class="empty-state">这一天还空着～</div>`}
        <button type="button" class="primary-button" data-action="open-add" data-date="${date}">这天再记一笔</button>
      </div>`);
  }

  /* ---------- 档案 ---------- */

  function sortedProducts() {
    const products = (model.data.products || []).slice();
    const { sort, tag, category } = state.filters;
    const filtered = products.filter(product => {
      if (tag && !(product.tags || []).includes(tag)) return false;
      if (category && product.category !== category) return false;
      return true;
    });
    if (sort === "stamps") filtered.sort((a, b) => b.count - a.count);
    else if (sort === "love") filtered.sort((a, b) => b.loveCount - a.loveCount || b.count - a.count);
    else filtered.sort((a, b) => ((b.lastDate || "") || "").localeCompare((a.lastDate || "") || ""));
    return filtered;
  }

  function stampsHtml(product) {
    const shown = Math.min(product.stamps, 12);
    let row = "";
    for (let i = 0; i < shown; i += 1) {
      const level = product.tier ? Math.max(1, Math.min(4, Math.ceil(((i + 1) / product.stamps) * (model.data.settings.tiers.length)))) : 1;
      row += `<span class="stamp hit-${level}"></span>`;
    }
    if (product.stamps > 12) row += `<span class="stamp-more">×${product.stamps}</span>`;
    return `<span class="stamp-row">${row}</span>`;
  }

  function verdictChip(product) {
    const label = core.VERDICT_LABELS[product.verdict.level] || "观望";
    const note = product.verdict.note ? ` · ${esc(product.verdict.note)}` : "";
    return `<div class="verdict-row"><span class="verdict-chip ${esc(product.verdict.level)}">${label}${note}</span>${product.tier ? `<span class="tier-badge${product.tier.label === "本命" ? " seal" : ""}">${product.tier.label === "本命" ? "✦ " : ""}${esc(product.tier.label)}</span>` : ""}</div>`;
  }

  function divergeHtml(product) {
    if (!product.divergences || !product.divergences.length) return "";
    const blocks = product.divergences.map(diverge => {
      const rows = diverge.rows.map(row => {
        const dots = [];
        for (let i = 0; i < row.love; i += 1) dots.push(`<span class="mini-dot love"></span>`);
        for (let i = 0; i < row.avoid; i += 1) dots.push(`<span class="mini-dot avoid"></span>`);
        return `<span class="val">${esc(row.value)}</span><span class="mini-scale">${dots.join("")}</span>`;
      });
      return `<div class="diverge-row">${esc(diverge.key)}：${rows.join(" ／ ")}</div>`;
    }).join("");
    return `<div class="diverge-box"><span class="diverge-title">配置分歧</span>${blocks}</div>`;
  }

  function productCard(product) {
    return `<button type="button" class="product-card" data-action="open-product" data-id="${product.id}">
      <span class="product-top">
        <span><span class="product-brand">${esc(product.brand)}</span><span class="product-name">${esc(product.name)}</span></span>
        <span class="product-emoji">${categoryInfo(product.category).emoji}</span>
      </span>
      ${stampsHtml(product)}
      ${verdictChip(product)}
      ${product.bestNote ? `<p class="product-note">${esc(product.bestNote)}</p>` : (product.lastNote ? `<p class="product-note">${esc(product.lastNote)}</p>` : "")}
      ${product.orderHint ? `<p class="order-hint">${esc(product.orderHint)}</p>` : ""}
      ${divergeHtml(product)}
    </button>`;
  }

  function renderCompare(products) {
    const { tag } = state.filters;
    const rows = products.map(product => {
      const rate = product.count ? Math.round((product.loveCount / product.count) * 100) : 0;
      const options = Object.keys(product.bestOptions || {}).length ? core.optionText(product.bestOptions) : "默认配置";
      return `<tr>
        <td><div class="compare-name">${categoryInfo(product.category).emoji} ${esc(product.name)}</div><div class="compare-sub">${esc(product.brand)}</div></td>
        <td>${product.stamps} 枚${product.tier ? ` · ${esc(product.tier.label)}` : ""}</td>
        <td><div class="love-bar"><i style="width:${rate}%"></i></div><div class="compare-sub">${rate}% 特别喜欢（${product.loveCount}/${product.count}）</div></td>
        <td>${esc(options)}</td>
        <td>${esc(product.lastDate || "—")}</td>
        <td><span class="verdict-chip ${esc(product.verdict.level)}">${core.VERDICT_LABELS[product.verdict.level]}</span></td>
      </tr>`;
    }).join("");
    return `<div class="compare-wrap"><table class="compare-table">
      <thead><tr><th>${tag ? `「${esc(tag)}」` : ""}档案</th><th>集章</th><th>好评率</th><th>最优配置</th><th>最近</th><th>判定</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6">没有符合筛选的档案卡</td></tr>`}</tbody>
    </table></div>`;
  }

  function renderArchive() {
    const products = sortedProducts();
    const stats = model.stats;
    const tagChips = (stats.tags || []).slice(0, 14).map(tag =>
      `<button type="button" class="tag-chip${state.filters.tag === tag.tag ? " on" : ""}" data-action="filter-tag" data-tag="${esc(tag.tag)}">${esc(tag.tag)} <b>${tag.love}/${tag.count}</b></button>`
    ).join("");
    const categoryOptions = core.CATEGORIES.map(category =>
      `<option value="${category.id}"${state.filters.category === category.id ? " selected" : ""}>${category.emoji} ${category.label}</option>`
    ).join("");
    const cards = products.map(productCard).join("");
    const compare = state.archiveMode === "compare" ? renderCompare(products) : `<div class="card-grid">${cards || ""}</div>`;

    const podium = (stats.topFans || []).slice(0, 3).map((product, index) => `
      <button type="button" class="podium-card${index === 0 ? " top1" : ""}" data-action="open-product" data-id="${product.id}">
        <span class="medal">${["🥇", "🥈", "🥉"][index]}</span>
        <span class="rank-name">${esc(product.name)}</span>
        <span class="rank-sub">${esc(product.brand)} · ${product.stamps} 枚章${product.tier ? ` · ${esc(product.tier.label)}` : ""}</span>
      </button>`).join("");

    const wall = (stats.avoidWall || []).map(product => `
      <button type="button" class="wall-card" data-action="open-product" data-id="${product.id}">
        <div class="compare-name">⛔ ${esc(product.brand)} · ${esc(product.name)}</div>
        <p class="product-note">${esc(product.lastNote || product.bestNote || "踩过了，别再点")}</p>
      </button>`).join("");

    const empty = (model.data.products || []).length ? "" :
      `<div class="empty-state"><span class="big">🍰</span>小店刚开业，货架空空的。<br>去跟 TA 聊一杯奶茶，或者点右下角“记一笔”开出第一张档案卡。</div>`;

    const insight = (stats.optionInsights || []).find(row => row.key === "糖度");
    const insightNote = insight && insight.rows.length >= 2 ?
      `<p class="insight-note">甜度体检：${insight.rows.map(row => `${esc(row.value)} 好评 ${row.count ? Math.round((row.love / row.count) * 100) : 0}%（${row.count} 次）`).join("，")}</p>` : "";

    $("#view-archive").innerHTML = `
      <section class="profile-strip flourish">
        <p class="kicker">TASTE PROFILE</p><h3>口味画像</h3>
        <div class="profile-line">${tagChips || `<span class="tag-chip">还没有口味标签，多聊几次就有了</span>`}</div>
        ${insightNote}
      </section>
      <div class="archive-toolbar">
        <div class="mode-toggle">
          <button type="button" class="${state.archiveMode === "cards" ? "on" : ""}" data-action="mode-cards">卡墙</button>
          <button type="button" class="${state.archiveMode === "compare" ? "on" : ""}" data-action="mode-compare">对比</button>
        </div>
        <select class="select-pill" id="filter-category"><option value="">全部品类</option>${categoryOptions}</select>
        <select class="select-pill" id="sort-products">
          <option value="recent"${state.filters.sort === "recent" ? " selected" : ""}>最近在喝</option>
          <option value="stamps"${state.filters.sort === "stamps" ? " selected" : ""}>集章最多</option>
          <option value="love"${state.filters.sort === "love" ? " selected" : ""}>好评最多</option>
        </select>
        <span class="spacer"></span>
        <button type="button" class="small-button" data-action="roulette" data-pool="rebuy">🎰 今天喝什么</button>
      </div>
      ${empty || `${compare}`}
      ${(stats.topFans || []).length ? `<div class="section-block"><div class="section-head-row"><p class="kicker">HALL OF FAME</p><h3>本命榜</h3></div><div class="podium">${podium}</div></div>` : ""}
      ${(stats.avoidWall || []).length ? `<div class="section-block"><div class="section-head-row"><p class="kicker">DO NOT REORDER</p><h3>避雷墙</h3></div><div class="wall-grid">${wall}</div></div>` : ""}
      <div id="roulette-stage"></div>`;
  }

  function openProductSheet(productId) {
    const product = productById(productId);
    if (!product) return;
    const entries = (model.data.entries || []).filter(entry => entry.productId === productId)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const timeline = entries.map(entry => {
      const rating = ratingInfo(entry.ratingId);
      const options = Object.keys(entry.options || {}).length ? `<span class="entry-options">${esc(entry.date)} · ${esc(core.optionText(entry.options))}</span>` : `<span class="entry-options">${esc(entry.date)}</span>`;
      return `<div class="day-entry">
        <div class="line1"><span class="rating-chip ${rating.sentiment}">${esc(rating.emoji)} ${esc(rating.label)}</span>${options}</div>
        ${entry.note ? `<p class="entry-note">${esc(entry.note)}</p>` : ""}
        <div class="row-actions">
          <button type="button" class="small-button" data-action="open-entry-edit" data-id="${entry.id}">改</button>
          <button type="button" class="small-button" data-action="delete-entry" data-id="${entry.id}">删</button>
        </div>
      </div>`;
    }).join("");

    const tagChips = (product.tags || []).map(tag =>
      `<span class="tag-chip">${esc(tag)}<button type="button" class="x" data-action="remove-tag" data-id="${product.id}" data-tag="${esc(tag)}" aria-label="移除标签">✕</button></span>`
    ).join("");
    const otherProducts = model.data.products.filter(item => item.id !== product.id);
    const verdictValue = product.verdict.auto ? "auto" : product.verdict.level;
    openSheet(`
      <p class="kicker">${esc(product.brand)}</p>
      <div class="sheet-head" style="margin-bottom:4px"><h3 style="font-size:24px">${categoryInfo(product.category).emoji} ${esc(product.name)}</h3></div>
      ${stampsHtml(product)} ${verdictChip(product)}
      ${product.bestNote ? `<p class="product-note">“${esc(product.bestNote)}”</p>` : ""}
      ${product.orderHint ? `<p class="order-hint">${esc(product.orderHint)}</p>` : ""}
      ${divergeHtml(product)}
      <div class="sheet-row"><span class="sheet-row-title">口味标签</span><div class="profile-line">${tagChips || `<span class="muted" style="font-size:12px">还没有标签</span>`}</div>
        <div class="row-actions"><input id="new-tag-input" class="pill-input" style="min-height:36px" placeholder="加个标签，回车确认" maxlength="16"><button type="button" class="small-button" data-action="add-tag" data-id="${product.id}">添加</button></div>
      </div>
      <div class="sheet-row"><span class="sheet-row-title">回购判定</span>
        <div class="field-grid">
          <select class="select-pill" id="verdict-select">
            <option value="auto"${verdictValue === "auto" ? " selected" : ""}>听档案自动算</option>
            <option value="rebuy"${verdictValue === "rebuy" ? " selected" : ""}>手动：回购</option>
            <option value="maybe"${verdictValue === "maybe" ? " selected" : ""}>手动：观望</option>
            <option value="avoid"${verdictValue === "avoid" ? " selected" : ""}>手动：拉黑</option>
          </select>
          <button type="button" class="small-button" data-action="verdict-save" data-id="${product.id}">保存判定</button>
        </div>
      </div>
      <div class="sheet-row"><span class="sheet-row-title">尝试记录（${entries.length}）</span>${timeline || `<span class="muted" style="font-size:12px">还没有记录</span>`}</div>
      <div class="sheet-row row-actions">
        <button type="button" class="primary-button" data-action="open-add" data-product-id="${product.id}">再记一杯（带配置）</button>
        ${otherProducts.length ? `<button type="button" class="small-button" data-action="merge-ask" data-id="${product.id}">并入另一张卡</button>` : ""}
        <button type="button" class="small-button" data-action="delete-product" data-id="${product.id}">删除档案卡</button>
      </div>`);
  }

  /* ---------- 抽签 ---------- */

  function roulette(poolName) {
    const stats = model.stats;
    const poolIds = poolName === "fresh" ? stats.pools.fresh : stats.pools.rebuy;
    const products = poolIds.map(productById).filter(Boolean);
    const stage = $("#roulette-stage");
    if (!products.length) {
      stage.innerHTML = `<div class="roulette-stage"><p class="roulette-name">池子还空着～</p><p class="muted">${poolName === "fresh" ? "还没有只尝过一次的新朋友" : "还没有判定为回购的档案，先多喝几杯"}</p></div>`;
      stage.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      const pick = products[Math.floor(Math.random() * products.length)];
      stage.innerHTML = `<div class="roulette-stage"><span class="roulette-sparkle">✦ ✦ ✦</span><p class="roulette-name">${esc(pick.brand)} · ${esc(pick.name)}</p>${ticks > 8 ? "" : `<p class="muted" style="font-size:12px">正在摇…</p>`}</div>`;
      if (ticks > 10) {
        clearInterval(timer);
        const weighted = [];
        for (const product of products) for (let i = 0; i < Math.max(1, product.stamps); i += 1) weighted.push(product);
        const final = poolName === "fresh" ? products[Math.floor(Math.random() * products.length)] : weighted[Math.floor(Math.random() * weighted.length)];
        stage.innerHTML = `<div class="roulette-stage"><span class="roulette-sparkle">🎀 今天就它</span><p class="roulette-name settled">${esc(final.brand)} · ${esc(final.name)}</p>${final.orderHint ? `<p class="order-hint" style="display:inline-block">${esc(final.orderHint)}</p>` : ""}<div class="row-actions" style="justify-content:center;margin-top:10px"><button type="button" class="small-button" data-action="roulette" data-pool="${poolName}">再摇一次</button><button type="button" class="small-button" data-action="open-product" data-id="${final.id}">看它的档案</button></div></div>`;
        stage.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }, 120);
  }

  /* ---------- 记一笔 / 改记录 ---------- */

  function openAddSheet(prefill = {}) {
    const settings = model.data.settings;
    const product = prefill.productId ? productById(prefill.productId) : null;
    const known = !product && prefill.brand && prefill.name ? core.findProduct({ products: model.data.products }, prefill.brand, prefill.name) : null;
    const matched = product || (known && known.product);
    const lastMine = matched ? (model.data.entries || []).filter(entry => entry.productId === matched.id).sort((a, b) => (a.date < b.date ? 1 : -1))[0] : null;
    const inherit = prefill.options || (lastMine ? lastMine.options || {} : {});
    const sugar = inherit["糖度"] || "";
    const ice = inherit["冰量"] || "";
    const topping = inherit["小料"] || "";
    const ratingPicks = settings.ratingLabels.map(label =>
      `<button type="button" class="rating-pick${(prefill.ratingId || "tried") === label.id ? " on" : ""}" data-rating="${label.id}">${esc(label.emoji)} ${esc(label.label)}</button>`
    ).join("");
    const draftNote = state.pendingDraftId ? `<div class="draft-row"><span class="sheet-row-title">待整理草稿</span><blockquote>${esc((model.data.drafts || []).find(draft => draft.id === state.pendingDraftId)?.raw || "")}</blockquote></div>` : "";
    openSheet(`
      <p class="kicker">NEW NOTE</p><h3>${prefill.entryId ? "改这条记录" : "记一笔"}</h3>
      ${draftNote}
      <form id="add-form" class="sheet-stack" style="margin-top:12px" data-entry-id="${esc(prefill.entryId || "")}" data-product-id="${esc(matched ? matched.id : "")}" data-draft-id="${esc(state.pendingDraftId || "")}">
        <div class="form-grid">
          <label class="field">品牌 *<input id="f-brand" required maxlength="40" value="${esc(matched ? matched.brand : prefill.brand || "")}" ${prefill.entryId ? "readonly" : ""} placeholder="例如：霸王茶姬"></label>
          <label class="field">品名 *<input id="f-name" required maxlength="60" value="${esc(matched ? matched.name : prefill.name || "")}" ${prefill.entryId ? "readonly" : ""} placeholder="例如：伯牙绝弦"></label>
          <label class="field">品类
            <select id="f-category">${core.CATEGORIES.map(category => `<option value="${category.id}"${(matched ? matched.category : prefill.category) === category.id ? " selected" : ""}>${category.emoji} ${category.label}</option>`).join("")}</select>
          </label>
          <label class="field">日期<input id="f-date" type="date" required value="${esc(prefill.date || model.data.today)}"></label>
        </div>
        <div class="sheet-row"><span class="sheet-row-title">这次觉得怎么样</span><div class="rating-picker" id="rating-picker">${ratingPicks}</div></div>
        <div class="sheet-row"><span class="sheet-row-title">配置（这次点的是什么）</span>
          <div class="field-grid">
            <label class="field">糖度<input id="f-sugar" list="sugar-list" maxlength="12" value="${esc(sugar)}" placeholder="微糖"><datalist id="sugar-list"><option value="不另加糖"><option value="微糖"><option value="少糖"><option value="半糖"><option value="标准糖"></datalist></label>
            <label class="field">冰量<input id="f-ice" list="ice-list" maxlength="12" value="${esc(ice)}" placeholder="去冰"><datalist id="ice-list"><option value="热"><option value="去冰"><option value="少冰"><option value="正常冰"></datalist></label>
            <label class="field">小料<input id="f-topping" maxlength="24" value="${esc(topping)}" placeholder="脆啵啵 / 奶盖…"></label>
            <label class="field">价格 ¥<input id="f-price" type="number" min="0" max="9999" step="0.1" value="${esc(prefill.price ?? "")}" placeholder="可选"></label>
          </div>
          <p id="match-hint" class="insight-note" ${matched ? "" : "hidden"}></p>
        </div>
        <label class="field">一句话短评<input id="f-note" maxlength="140" value="${esc(prefill.note || "")}" placeholder="用你的原话就好"></label>
        <label class="field">口味标签（逗号隔开）<input id="f-tags" maxlength="120" value="${esc((matched ? matched.tags : prefill.tags || []).join("，"))}" placeholder="桂花，乌龙"></label>
        <div class="row-actions">
          <button type="submit" class="primary-button">${prefill.entryId ? "保存修改" : "盖章记录"}</button>
          ${Object.keys(inherit).length && !prefill.entryId ? `<button type="button" class="small-button" data-action="clear-options">这次换了配置，清空</button>` : ""}
        </div>
      </form>`);
    const picker = $("#rating-picker");
    picker.addEventListener("click", event => {
      const button = event.target.closest("[data-rating]");
      if (!button) return;
      picker.querySelectorAll(".rating-pick").forEach(item => item.classList.remove("on"));
      button.classList.add("on");
    });
    $("#add-form").addEventListener("submit", submitAddForm);

    const hintNode = $("#match-hint");
    function refreshMatchHint() {
      const brand = $("#f-brand").value.trim();
      const name = $("#f-name").value.trim();
      if (!brand || !name) {
        hintNode.hidden = true;
        return;
      }
      const found = core.findProduct({ products: model.data.products }, brand, name);
      const hit = found.product || found.similar[0] || null;
      if (!hit) {
        hintNode.hidden = true;
        return;
      }
      const latest = (model.data.entries || []).filter(entry => entry.productId === hit.id)
        .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      if (!$("#f-sugar").value && latest && latest.options && latest.options["糖度"]) $("#f-sugar").value = latest.options["糖度"];
      if (!$("#f-ice").value && latest && latest.options && latest.options["冰量"]) $("#f-ice").value = latest.options["冰量"];
      if (!$("#f-topping").value && latest && latest.options && latest.options["小料"]) $("#f-topping").value = latest.options["小料"];
      hintNode.textContent = found.product
        ? `已经有一张档案卡「${hit.brand} · ${hit.name}」（第 ${hit.stamps + 1} 杯），配置带出了上次的选择。`
        : `发现相似档案卡「${hit.brand} · ${hit.name}」，如果想记的是它，把品名改一致就会并进同一张卡。`;
      hintNode.hidden = false;
    }
    ["f-brand", "f-name"].forEach(id => {
      document.getElementById(id).addEventListener("input", refreshMatchHint);
    });
    if (matched) {
      hintNode.textContent = `已经有一张档案卡「${matched.brand} · ${matched.name}」（第 ${matched.count + 1} 杯），配置带出了上次的选择。`;
    }
  }

  async function submitAddForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const ratingId = form.querySelector(".rating-pick.on")?.dataset.rating || "tried";
    const options = {};
    const sugar = $("#f-sugar").value.trim();
    const ice = $("#f-ice").value.trim();
    const topping = $("#f-topping").value.trim();
    if (sugar) options["糖度"] = sugar;
    if (ice) options["冰量"] = ice;
    if (topping) options["小料"] = topping;
    const priceRaw = $("#f-price").value.trim();
    const payload = {
      product: {
        brand: $("#f-brand").value.trim(),
        name: $("#f-name").value.trim(),
        category: $("#f-category").value,
        tags: $("#f-tags").value.split(/[，,、\s]+/).filter(Boolean),
      },
      entry: {
        date: $("#f-date").value,
        ratingId,
        options,
        note: $("#f-note").value.trim(),
        price: priceRaw === "" ? null : Number(priceRaw),
      },
    };
    try {
      if (form.dataset.entryId) {
        await postCommand("update", { op: "entry", entryId: form.dataset.entryId, patch: payload.entry });
        toast("改好了");
      } else {
        const result = await postCommand("add", { ...payload, source: "manual" });
        if (result.similar && result.similar.length) {
          toast(`记好了。发现相似的档案卡「${result.similar[0].brand} ${result.similar[0].name}」，需要的话在卡片里并入`);
        } else {
          toast("记好了，已盖章 🎉");
        }
        if (form.dataset.draftId) await postCommand("update", { op: "deleteDraft", draftId: form.dataset.draftId });
      }
      closeSheet();
      await refresh();
    } catch (error) {
      toast(error && error.message ? error.message : "没记上，再试一次");
    }
  }

  function openEntryEditSheet(entryId) {
    const entry = entryById(entryId);
    if (!entry) return;
    const product = productById(entry.productId);
    openAddSheet({
      entryId,
      productId: entry.productId,
      brand: product ? product.brand : "",
      name: product ? product.name : "",
      date: entry.date,
      ratingId: entry.ratingId,
      options: entry.options || {},
      note: entry.note,
      price: entry.price ?? "",
      tags: product ? product.tags : [],
    });
  }

  /* ---------- 小店（设置） ---------- */

  async function ruleRow() {
    try {
      const listed = await host.api("/api/libraries/" + encodeURIComponent(memoryId) + "/rules");
      return (listed.rows || []).find(row => row.name === RULE_NAME) || null;
    } catch {
      return null;
    }
  }

  async function renderSettings() {
    const settings = model.data.settings;
    const rule = await ruleRow();
    const drafts = model.data.drafts || [];
    const labelRows = settings.ratingLabels.map(label => {
      const inUse = (model.data.entries || []).filter(entry => entry.ratingId === label.id).length;
      return `<span class="rate-chip">${esc(label.emoji)} ${esc(label.label)} <span class="sentiment">${label.sentiment === "positive" ? "正面" : label.sentiment === "negative" ? "负面" : "中性"}${inUse ? ` · ${inUse} 条` : ""}</span>${settings.ratingLabels.length > 1 ? `<button type="button" data-action="label-remove" data-id="${esc(label.id)}" aria-label="删除档位">✕</button>` : ""}</span>`;
    }).join("");
    const tierInputs = settings.tiers.map((tier, index) =>
      `<label class="field">${index + 1} 档 · ${esc(tier.label)}<input type="number" min="1" max="99" data-tier-count="${esc(tier.label)}" value="${tier.count}"></label>`
    ).join("");
    const draftRows = drafts.map(draft =>
      `<div class="draft-row"><span class="sheet-row-title">${esc((draft.receivedAt || "").slice(0, 16).replace("T", " "))}</span><blockquote>${esc(draft.raw)}</blockquote>
        <div class="row-actions"><button type="button" class="small-button" data-action="draft-resolve" data-id="${esc(draft.id)}">补全它</button><button type="button" class="small-button" data-action="draft-delete" data-id="${esc(draft.id)}">不要了</button></div></div>`
    ).join("");

    $("#view-settings").innerHTML = `
      <section class="settings-card flourish">
        <p class="kicker">RATING LABELS</p><h3>评分档位</h3>
        <p class="muted" style="font-size:12px">千人千味，档位随你定。删掉在用的档位时，那些记录会改成“尝鲜一次”。</p>
        <div class="settings-grid"><div class="label-row">${labelRows}</div>
          <div class="field-grid">
            <label class="field">新档位名字<input id="new-label-name" maxlength="12" placeholder="例如：干杯不腻"></label>
            <label class="field">极性
              <select id="new-label-sentiment"><option value="positive">正面</option><option value="neutral">中性</option><option value="negative">负面</option></select>
            </label>
          </div>
          <div class="row-actions"><button type="button" class="small-button" data-action="label-add">添加档位</button></div>
        </div>
      </section>

      <section class="settings-card">
        <p class="kicker">STAMPS</p><h3>集章档位</h3>
        <div class="settings-grid"><div class="field-grid">${tierInputs}</div>
        <div class="row-actions"><button type="button" class="small-button" data-action="tiers-save">保存档位</button></div></div>
      </section>

      <section class="settings-card">
        <p class="kicker">AUTO CAPTURE</p><h3>点亮 AI 记录</h3>
        <div class="settings-grid">
          <div class="switch-row">
            <span class="rule-status"><span class="status-dot ${rule ? (rule.injected === false ? "off" : "on") : "off"}"></span>${rule ? (rule.injected === false ? "规则已写入但暂停注入" : "已点亮：聊天里提到吃喝会自动入档") : "还没点亮"}</span>
            <div class="row-actions">
              ${rule ? `<button type="button" class="small-button" data-action="rule-disable">暂停注入</button><button type="button" class="small-button" data-action="rule-delete">删除规则</button>` : `<button type="button" class="primary-button" data-action="rule-enable">点亮</button>`}
            </div>
          </div>
          <p class="muted" style="font-size:12px">点亮会往当前记忆体写入一条规则，教 TA 在你提到奶茶甜品外卖时用 stmem 静静记一笔，不打断聊天。</p>
        </div>
      </section>

      <section class="settings-card">
        <p class="kicker">INBOX</p><h3>待整理草稿（${drafts.length}）</h3>
        <div class="settings-grid">${draftRows || `<p class="muted" style="font-size:13px">没有待整理的草稿，很干净 ✨</p>`}</div>
      </section>

      <section class="settings-card">
        <p class="kicker">MISC</p><h3>杂项</h3>
        <div class="settings-grid">
          <div class="switch-row"><span>在月报里显示花销小计（有点扎心，慎开）</span><button type="button" class="switch ${settings.showSpend ? "on" : ""}" data-action="spend-toggle" aria-label="切换花销显示"><i></i></button></div>
          <div class="row-actions">
            <button type="button" class="small-button" data-action="export-data">导出数据（JSON）</button>
            <button type="button" class="danger-button" data-action="clear-all">清空这个记忆体的档案</button>
          </div>
        </div>
      </section>`;
  }

  /* ---------- 规则写入（走 Stone 正式 rules API） ---------- */

  async function writeRule() {
    const path = "/api/libraries/" + encodeURIComponent(memoryId) + "/rules";
    const listed = await host.api(path);
    const existing = (listed.rows || []).find(row => row.name === RULE_NAME);
    await host.api(path, {
      method: existing ? "PUT" : "POST",
      headers: { "content-type": "text/plain;charset=utf-8", "x-file-name": encodeURIComponent(RULE_NAME) },
      body: RULE_TEXT,
    });
    await host.api(path + "/" + encodeURIComponent(RULE_NAME) + "/enable", { method: "POST" });
  }

  /* ---------- 事件 ---------- */

  document.addEventListener("click", async event => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    try {
      switch (action) {
        case "tab": {
          state.tab = target.dataset.tab;
          writePrefs({ tab: state.tab });
          render();
          break;
        }
        case "sheet-close": closeSheet(); break;
        case "cal-prev": state.month = monthOf(-1); renderCalendar(); break;
        case "cal-next": state.month = monthOf(1); renderCalendar(); break;
        case "cal-today": state.month = (model.data.today || core.todayStr()).slice(0, 7); renderCalendar(); break;
        case "open-day": openDaySheet(target.dataset.date); break;
        case "report-copy-ask":
          await copyText(`帮我整理一下 ${state.month} 的味觉月报吧：读一下味觉档案这个月的记录，总结口味趋势和下月建议，写回模块里。`);
          break;
        case "adopt-proposal": {
          const digest = monthDigest(state.month);
          const proposal = digest && digest.proposals ? digest.proposals[Number(target.dataset.index)] : null;
          if (!proposal) break;
          if (proposal.kind === "ratingLabel") {
            await postCommand("update", { op: "settings", patch: { addRatingLabel: { label: proposal.label, sentiment: proposal.sentiment || "neutral" } } });
            toast(`已添加评分档「${proposal.label}」`);
          } else if (proposal.productId && productById(proposal.productId)) {
            const product = productById(proposal.productId);
            await postCommand("update", { op: "product", productId: product.id, patch: { tags: [...(product.tags || []), proposal.label] } });
            toast(`已给「${product.name}」加上「${proposal.label}」`);
          } else {
            toast("这个提议缺了目标档案，先放着");
            break;
          }
          await refresh();
          break;
        }
        case "open-add":
          state.pendingDraftId = "";
          closeSheet();
          openAddSheet({ date: target.dataset.date, productId: target.dataset.productId });
          break;
        case "open-product": closeSheet(); openProductSheet(target.dataset.id); break;
        case "open-entry-edit": closeSheet(); openEntryEditSheet(target.dataset.id); break;
        case "delete-entry":
          confirmBox("删掉这条记录？", "这一枚章会从档案卡上取下来。", "删掉", async () => {
            await postCommand("update", { op: "deleteEntry", entryId: target.dataset.id });
            closeSheet();
            toast("已删除");
            await refresh();
          });
          break;
        case "mode-cards": state.archiveMode = "cards"; renderArchive(); break;
        case "mode-compare": state.archiveMode = "compare"; renderArchive(); break;
        case "filter-tag": {
          state.filters.tag = state.filters.tag === target.dataset.tag ? "" : target.dataset.tag;
          renderArchive();
          break;
        }
        case "roulette": roulette(target.dataset.pool); break;
        case "clear-options": {
          $("#f-sugar").value = ""; $("#f-ice").value = ""; $("#f-topping").value = "";
          break;
        }
        case "remove-tag": {
          const product = productById(target.dataset.id);
          if (!product) break;
          await postCommand("update", { op: "product", productId: product.id, patch: { tags: (product.tags || []).filter(tag => tag !== target.dataset.tag) } });
          await refresh();
          openProductSheet(product.id);
          break;
        }
        case "add-tag": {
          const input = $("#new-tag-input");
          const tag = (input.value || "").trim();
          if (!tag) break;
          const product = productById(target.dataset.id);
          await postCommand("update", { op: "product", productId: product.id, patch: { tags: [...(product.tags || []), tag] } });
          await refresh();
          openProductSheet(product.id);
          break;
        }
        case "verdict-save": {
          const value = $("#verdict-select").value;
          await postCommand("update", { op: "product", productId: target.dataset.id, patch: { verdictOverride: value === "auto" ? null : { level: value, note: "" } } });
          toast("判定已保存");
          await refresh();
          openProductSheet(target.dataset.id);
          break;
        }
        case "merge-ask": {
          const from = productById(target.dataset.id);
          const others = model.data.products.filter(item => item.id !== from.id);
          openSheet(`
            <p class="kicker">MERGE</p><h3>把「${esc(from.name)}」并进哪张卡？</h3>
            <p class="muted" style="font-size:12px">它的 ${from.stamps} 枚章和全部记录会挪过去，标签取并集。</p>
            <div class="sheet-stack" style="margin-top:12px">
              ${others.map(item => `<button type="button" class="day-entry" data-action="merge-into" data-from="${from.id}" data-into="${item.id}" style="text-align:left"><span class="who">${categoryInfo(item.category).emoji} ${esc(item.brand)} · ${esc(item.name)}</span><span class="entry-options">${item.stamps} 枚章</span></button>`).join("")}
            </div>`);
          break;
        }
        case "merge-into":
          confirmBox("确认合并？", "合并后原来的卡片会消失，记录全部保留在目标卡里，不可自动拆回。", "合并", async () => {
            await postCommand("update", { op: "merge", fromProductId: target.dataset.from, intoProductId: target.dataset.into });
            closeSheet();
            toast("已合并");
            await refresh();
          });
          break;
        case "delete-product":
          confirmBox("删除整张档案卡？", "卡上所有盖章记录都会一起删除，这个操作不能撤销。", "删除档案卡", async () => {
            await postCommand("update", { op: "deleteProduct", productId: target.dataset.id });
            closeSheet();
            toast("档案卡已删除");
            await refresh();
          });
          break;
        case "rule-enable":
          target.disabled = true;
          try {
            await writeRule();
            toast("已点亮，下次 rebuild 后 TA 就知道怎么记了");
            await renderSettings();
          } catch (error) {
            toast("规则写入失败：" + (error && error.message ? error.message : "未知错误"));
            target.disabled = false;
          }
          break;
        case "rule-disable":
          try {
            await host.api("/api/libraries/" + encodeURIComponent(memoryId) + "/rules/" + encodeURIComponent(RULE_NAME) + "/disable", { method: "POST" });
            toast("已暂停注入，数据都还在");
            await renderSettings();
          } catch (error) {
            toast("操作失败：" + (error && error.message ? error.message : "未知错误"));
          }
          break;
        case "rule-delete":
          confirmBox("删除这条规则？", "只是不再自动记录，档案数据不受影响。", "删除规则", async () => {
            await host.api("/api/libraries/" + encodeURIComponent(memoryId) + "/rules/" + encodeURIComponent(RULE_NAME), { method: "DELETE" });
            toast("规则已删除");
            await renderSettings();
          });
          break;
        case "label-add": {
          const name = $("#new-label-name").value.trim();
          if (!name) break;
          await postCommand("update", { op: "settings", patch: { addRatingLabel: { label: name, sentiment: $("#new-label-sentiment").value } } });
          toast("档位已添加");
          await refresh();
          break;
        }
        case "label-remove":
          confirmBox("删掉这个评分档？", "如果有记录正在用，它们会被改成“尝鲜一次”。", "删除", async () => {
            try {
              await postCommand("update", { op: "settings", patch: { removeRatingLabel: target.dataset.id } });
            } catch (error) {
              if (String(error && error.message).includes("条记录在用")) {
                await postCommand("update", { op: "settings", patch: { removeRatingLabel: target.dataset.id }, force: true });
              } else throw error;
            }
            toast("已删除");
            await refresh();
          });
          break;
        case "tiers-save": {
          const tiers = {};
          document.querySelectorAll("[data-tier-count]").forEach(input => {
            tiers[input.dataset.tierCount] = { label: input.dataset.tierCount, count: Number(input.value) };
          });
          await postCommand("update", { op: "settings", patch: { tiers: Object.values(tiers) } });
          toast("集章档位已更新");
          await refresh();
          break;
        }
        case "spend-toggle":
          await postCommand("update", { op: "settings", patch: { showSpend: !model.data.settings.showSpend } });
          await refresh();
          break;
        case "draft-delete":
          await postCommand("update", { op: "deleteDraft", draftId: target.dataset.id });
          toast("草稿已丢弃");
          await refresh();
          break;
        case "draft-resolve":
          state.pendingDraftId = target.dataset.id;
          closeSheet();
          openAddSheet({});
          break;
        case "export-data":
          await copyText(JSON.stringify({ journal: model.data, stats: model.stats }, null, 2), "数据已复制到剪贴板");
          break;
        case "clear-all":
          confirmBox("清空整个味觉档案？", "这个记忆体的全部记录、草稿和月报都会删除，不可恢复。建议先导出数据。", "确认清空", async () => {
            await postCommand("update", { op: "clearAll", confirm: true });
            toast("已清空，小店重新开业");
            await refresh();
          });
          break;
        default:
          break;
      }
    } catch (error) {
      toast(error && error.message ? error.message : "操作失败，再试一次");
    }
  });

  document.addEventListener("change", event => {
    if (event.target.id === "filter-category") {
      state.filters.category = event.target.value;
      renderArchive();
    }
    if (event.target.id === "sort-products") {
      state.filters.sort = event.target.value;
      renderArchive();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.target && event.target.id === "new-tag-input" && event.key === "Enter") {
      event.preventDefault();
      const button = document.querySelector('[data-action="add-tag"]');
      if (button) button.click();
    }
  });

  $("#confirm-cancel").addEventListener("click", () => $("#confirm-dialog").close());
  $("#confirm-action").addEventListener("click", () => {
    const action = confirmAction;
    confirmAction = null;
    $("#confirm-dialog").close();
    if (action) action();
  });
  $("#confirm-dialog").addEventListener("cancel", event => {
    event.preventDefault();
    $("#confirm-dialog").close();
    confirmAction = null;
  });
  $("#sheet-dialog").addEventListener("click", event => {
    if (event.target === $("#sheet-dialog")) closeSheet();
  });
  $("#fab-add").addEventListener("click", () => {
    state.pendingDraftId = "";
    openAddSheet({});
  });

  /* ---------- 启动 ---------- */

  async function boot() {
    $("#missing-thread").hidden = Boolean(memoryId);
    if (!memoryId || !host) return;
    try {
      const prefs = readPrefs();
      if (prefs.tab) state.tab = prefs.tab;
      await hydrate();
      $("#app").hidden = false;
      render();
    } catch (error) {
      $("#load-error").hidden = false;
      $("#load-error-text").textContent = (error && error.message ? error.message : "未知错误") + "，刷新页面试试。";
    }
  }

  boot();
})();
