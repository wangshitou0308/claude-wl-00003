/* ============================================================
 * app.js —— 双机换卷推演台 前端逻辑（原生 JS + SVG）
 * ============================================================ */
(function () {
  "use strict";
  var E = window.Engine;

  /* ------------------------------------------------ 工具 */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function svgEl(tag, attrs) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* ------------------------------------------------ 全局状态 */
  var state = {
    plan: null,
    analysis: null,
    selectedReelId: null,
    view: { pxPerSec: 14 },
    sim: { playing: false, t: 0, raf: 0, lastWall: 0, active: false },
    drag: null,
    planCache: {},      // id -> 完整方案
  };

  /* 时间轴几何（像素） */
  var GEO = {
    rulerH: 24,
    screenY: 34, screenH: 20,
    laneA: 66, laneB: 138, laneH: 60,
    bottom: 214,
    labelW: 58,
    padSec: 15,
    axisX: 70,  // t=0 视觉起点（给泳道标签留位）
  };

  /* ------------------------------------------------ API */
  function api(path, opts) {
    return fetch(path, opts || {}).then(function (r) {
      if (r.status === 204) return null;
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function jsonOpts(method, body) {
    return {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  /* ------------------------------------------------ 示例方案 */
  function demoPlans() {
    function reel(i, proj, len, over) {
      var r = E.makeReel(i);
      r.title = "第 " + (i + 1) + " 卷";
      r.projector = proj;
      r.lengthValue = len;
      if (over) for (var k in over) r[k] = over[k];
      return r;
    }
    var now = Date.now();
    var a = {
      id: "demo_plan_a",
      name: "长空雁叫（1962）排练稿",
      note: "内置示例：含同机冲突、提前量不足与存疑提示，供检查定位。",
      settings: E.makeSettings({}),
      reels: [
        reel(0, "A", 900, { locked: true }),
        reel(1, "B", 930, { motorCue: 120 }),                 // 提前量仅 4 秒
        reel(2, "A", 860, { changeCue: 18, changeCueMax: 30, changeCueU: true }),
        reel(3, "A", 900),                                    // 误排甲机（应为乙机）
        reel(4, "B", 880),
      ],
      createdAt: now, updatedAt: now,
    };
    var b = {
      id: "demo_plan_b",
      name: "长空雁叫（1962）修正稿",
      note: "内置示例：严格双机交替、标准提示位置。",
      settings: E.makeSettings({}),
      reels: [
        reel(0, "A", 900, { locked: true }),
        reel(1, "B", 930),
        reel(2, "A", 860),
        reel(3, "B", 900),
        reel(4, "A", 880),
      ],
      createdAt: now + 1, updatedAt: now + 1,
    };
    return [a, b];
  }

  /* ------------------------------------------------ 启动 */
  function boot() {
    bindStaticUI();
    api("/api/plans").then(function (list) {
      if (!list.length) {
        var seed = demoPlans();
        Promise.all(seed.map(function (p) { return api("/api/plans", jsonOpts("POST", p)); }))
          .then(function () {
            localStorage.setItem("cod_lastPlan", seed[0].id);
            return openPlan(seed[0].id);
          });
      } else {
        var lastId = localStorage.getItem("cod_lastPlan");
        if (!list.some(function (p) { return p.id === lastId; })) lastId = list[0].id;
        return openPlan(lastId);
      }
    }).catch(function (err) {
      setSaveState("error", "后端未启动？" + err.message);
    });
  }

  function openPlan(id) {
    return api("/api/plans/" + id).then(function (plan) {
      state.plan = plan;
      state.planCache[id] = plan;
      localStorage.setItem("cod_lastPlan", id);
      state.selectedReelId = plan.reels && plan.reels[0] ? plan.reels[0].id : null;
      $("#planName").value = plan.name;
      recompute();
      fitZoom(true);
      resetSim(true);
      renderAll();
      setSaveState("saved", "已保存 " + new Date(plan.updatedAt).toLocaleTimeString());
    });
  }

  /* ------------------------------------------------ 保存 */
  var scheduleSave = debounce(function () {
    if (!state.plan) return;
    setSaveState("saving", "保存中…");
    state.plan.name = $("#planName").value || "未命名方案";
    api("/api/plans/" + state.plan.id, jsonOpts("PUT", state.plan))
      .then(function (saved) {
        setSaveState("saved", "已保存 " + new Date(saved.updatedAt).toLocaleTimeString());
      })
      .catch(function (err) { setSaveState("error", "保存失败：" + err.message); });
  }, 600);

  function touch() {
    if (state.plan) state.plan.updatedAt = Date.now();
    recompute();
    renderDynamic();
    scheduleSave();
  }

  function setSaveState(cls, text) {
    var el = $("#saveState");
    el.className = "save-state " + cls;
    el.textContent = text;
  }

  /* ------------------------------------------------ 推演 */
  function recompute() {
    if (!state.plan) { state.analysis = null; return; }
    state.analysis = E.analyzePlan(state.plan);
  }

  function renderAll() {
    renderReelList();
    renderTimeline();
    renderEditor();
    renderSettings();
    renderIssues();
    renderEventLog();
    renderSimCards();
  }
  // 编辑过程中不重建编辑器（避免输入丢焦）
  function renderDynamic() {
    renderReelList();
    renderTimeline();
    updateComputedBox();
    renderIssues();
    renderEventLog();
    renderSimCards();
  }

  function selectedReel() {
    if (!state.plan) return null;
    return state.plan.reels.filter(function (r) { return r.id === state.selectedReelId; })[0] || null;
  }
  function selectedComputed() {
    if (!state.analysis) return null;
    return state.analysis.computed.filter(function (c) { return c.reel.id === state.selectedReelId; })[0] || null;
  }
  function reelIssues(id) {
    return state.analysis ? state.analysis.issues.filter(function (i) {
      return i.reelId === id || i.otherReelId === id;
    }) : [];
  }

  /* ------------------------------------------------ 左：卷列表 */
  function renderReelList() {
    var ol = $("#reelList");
    if (!state.plan) { ol.innerHTML = ""; return; }
    ol.innerHTML = state.analysis.computed.map(function (c) {
      var iss = reelIssues(c.reel.id);
      var hasErr = iss.some(function (i) { return i.severity === "error"; });
      var hasWarn = !hasErr && iss.length > 0;
      return '<li class="reel-item ' +
        (c.reel.id === state.selectedReelId ? "active " : "") +
        (hasErr ? "has-issue" : hasWarn ? "has-warn" : "") +
        '" data-reel="' + esc(c.reel.id) + '">' +
        '<span class="reel-ord proj-' + c.reel.projector + '">' + (c.idx + 1) + '</span>' +
        '<span class="reel-name">' + esc(c.reel.title) +
          '<span class="reel-meta"> · ' + E.fmtDuration(c.picSec) + '</span></span>' +
        (c.reel.locked ? '<span class="lock-ico" title="已核对锁定">🔒</span>' : "") +
        '</li>';
    }).join("");
  }

  $("#reelList").addEventListener("click", function (ev) {
    var li = ev.target.closest("[data-reel]");
    if (li) { selectReel(li.getAttribute("data-reel")); }
  });

  function selectReel(id, focusCue) {
    state.selectedReelId = id;
    renderReelList();
    renderEditor();
    renderTimeline();
    if (focusCue) flashCueField(focusCue);
    var c = selectedComputed();
    if (c) scrollTimeTo(c.pictureStart + c.picSec * 0.3, 0.42);
  }

  /* ------------------------------------------------ 右：本卷编辑 */
  function cueRefLabel() {
    return state.analysis.settings.cueRef === "tail" ? "距画面末尾（格）" : "距物理片头（格）";
  }

  function renderEditor() {
    var box = $("#reelEditor");
    var reel = selectedReel();
    if (!reel) {
      box.innerHTML = '<div class="editor-empty">尚未选择胶片卷。<br>点左栏或时间轴上的胶卷块。</div>';
      return;
    }
    var s = state.analysis.settings;
    var dis = reel.locked ? "disabled" : "";
    box.innerHTML =
      '<div class="field"><label>卷次 / 题名</label>' +
        '<input type="text" data-f="title" value="' + esc(reel.title) + '" ' + dis + '></div>' +
      '<div class="field-row">' +
        '<div class="field"><label>机别</label>' +
          '<select data-f="projector" ' + dis + '>' +
            '<option value="A"' + (reel.projector === "A" ? " selected" : "") + '>甲机 A</option>' +
            '<option value="B"' + (reel.projector === "B" ? " selected" : "") + '>乙机 B</option>' +
          '</select></div>' +
        '<div class="field"><label>规格</label>' +
          '<select data-f="gauge" ' + dis + '>' +
            ['35mm', '16mm', '8mm', 'super8'].map(function (g) {
              return '<option value="' + g + '"' + (reel.gauge === g ? " selected" : "") + ">" +
                g + "（" + E.FRAMES_PER_FOOT[g] + ' 格/英尺）</option>';
            }).join("") +
          '</select></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>帧率（格/秒）</label>' +
          '<input type="number" step="0.01" min="1" data-f="fps" value="' + esc(reel.fps) + '" ' + dis + '></div>' +
        '<div class="field"><label>画面长度（不含护片）</label>' +
          '<div class="input-unit">' +
            '<input type="number" min="0" step="1" data-f="lengthValue" value="' + esc(reel.lengthValue) + '" ' + dis + '>' +
            '<select data-f="lengthUnit" ' + dis + '>' +
              [["ft", "英尺"], ["m", "米"], ["sec", "秒"], ["frames", "格"]].map(function (o) {
                return '<option value="' + o[0] + '"' + (reel.lengthUnit === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
              }).join("") +
            '</select></div></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>片头护片（英尺）</label>' +
          '<input type="number" min="0" step="0.5" data-f="headLeaderFt" value="' + esc(reel.headLeaderFt) + '" ' + dis + '></div>' +
        '<div class="field"><label>片尾护片（英尺）</label>' +
          '<input type="number" min="0" step="0.5" data-f="tailLeaderFt" value="' + esc(reel.tailLeaderFt) + '" ' + dis + '></div>' +
      '</div>' +

      cueFieldHtml("motor", "马达提示（启动信号）", "motorCue", reel, s, dis) +
      cueFieldHtml("change", "切换提示（换机信号）", "changeCue", reel, s, dis) +

      '<div class="field check-row">' +
        '<input type="checkbox" id="lockedCheck" data-f="locked"' + (reel.locked ? " checked" : "") + '>' +
        '<label for="lockedCheck">已核对，锁定本卷（参数、机别与卷序）</label></div>' +
      '<div class="field"><label>备注</label>' +
        '<textarea rows="2" data-f="note" ' + dis + '>' + esc(reel.note) + '</textarea></div>' +
      '<div class="field"><button class="btn btn-danger btn-sm" id="btnDeleteReel">删除本卷</button></div>' +
      '<div class="computed-box"><h3>自动换算</h3><div id="computedLines"></div></div>';

    updateComputedBox();
  }

  function cueFieldHtml(cue, title, base, reel, s, dis) {
    var vMin = reel[base] == null ? "" : reel[base];
    var vMax = reel[base + "Max"] == null ? "" : reel[base + "Max"];
    var u = !!reel[base + "U"];
    return '<div class="field" data-cuefield="' + cue + '">' +
      '<label>' + title + ' · <span class="hint-inline">' + cueRefLabel() + '</span>' +
        (u ? ' <span class="uncertain-tag">存疑</span>' : "") + '</label>' +
      '<div class="range-row">' +
        '<input type="number" step="1" data-f="' + base + '" value="' + esc(vMin) + '" ' + dis +
          ' placeholder="格数">' +
        '<span class="tilde">～</span>' +
        '<input type="number" step="1" data-f="' + base + 'Max" value="' + esc(vMax) + '" ' + dis +
          ' placeholder="范围上限">' +
      '</div>' +
      '<div class="check-row field" style="margin-top:5px">' +
        '<input type="checkbox" id="' + base + 'U" data-f="' + base + 'U"' + (u ? " checked" : "") + ">" +
        '<label for="' + base + 'U">看不准，标为存疑（可只填一个值）</label></div>' +
    "</div>";
  }

  function updateComputedBox() {
    var box = $("#computedLines");
    if (!box) return;
    var c = selectedComputed();
    if (!c) { box.innerHTML = ""; return; }
    var s = state.analysis.settings;
    var headSec = c.headFrames / c.fps;
    var lines = [
      ["画面时长", E.fmtDuration(c.picSec) + "（" + c.picFrames + " 格）"],
      ["含护片总长", E.fmtDuration(c.totalSec)],
      ["马达→切换间隔", E.fmtSigned(c.cueLeadMin, 1) + "～" + E.fmtSigned(c.cueLeadMax, 1) + " 秒"],
      ["片头护片长度", E.fmtSigned(headSec, 1) + " 秒"],
      ["马达启动", E.fmtClock(c.motorStart)],
      ["马达提示", E.fmtClock(c.motorCueT)],
      ["切换提示", E.fmtClock(c.changeCueT)],
      ["画面放完", E.fmtClock(c.picEnd)],
      ["停机", E.fmtClock(c.stopTime)],
      ["回卷就绪", E.fmtClock(c.threadedFor)],
    ];
    if (c.turnaround) {
      lines.push(["周转余量",
        '<span style="color:' + (c.turnaround.slack >= 0 ? "var(--teal)" : "var(--red)") + '">' +
        E.fmtSigned(c.turnaround.slack, 0) + " 秒</span>"]);
    }
    box.innerHTML = lines.map(function (l) {
      return '<div class="comp-line"><span>' + l[0] + '</span><b>' + l[1] + "</b></div>";
    }).join("");
  }

  function flashCueField(cue) {
    if (!cue) return;
    var node = $('[data-cuefield="' + cue + '"]');
    if (!node) return;
    node.scrollIntoView({ block: "nearest", behavior: "smooth" });
    node.style.transition = "background .3s";
    node.style.background = "rgba(232,163,61,.25)";
    setTimeout(function () { node.style.background = ""; }, 1200);
  }

  /* 编辑器输入 -> 模型 */
  $("#reelEditor").addEventListener("input", function (ev) {
    var reel = selectedReel();
    var f = ev.target.getAttribute("data-f");
    if (!reel || !f) return;
    if (reel.locked && f !== "locked") { ev.target.value = reel[f]; return; }
    if (ev.target.type === "checkbox") {
      reel[f] = ev.target.checked;
      touch();
      // 存疑勾选/锁定状态需要立即重绘标签与禁用态；焦点会回到 body，可接受
      if (f === "locked" || /U$/.test(f)) renderEditor();
      return;
    }
    if (ev.target.type === "number") {
      reel[f] = ev.target.value === "" ? "" : parseFloat(ev.target.value);
    } else reel[f] = ev.target.value;
    touch();
  });

  $("#reelEditor").addEventListener("change", function () { /* 占位（select 走 input） */ });

  $("#reelEditor").addEventListener("click", function (ev) {
    if (ev.target.id === "btnDeleteReel") {
      var reel = selectedReel();
      if (!reel) return;
      if (!confirm("删除《" + reel.title + "》？")) return;
      state.plan.reels = state.plan.reels.filter(function (r) { return r.id !== reel.id; });
      state.selectedReelId = state.plan.reels[0] ? state.plan.reels[0].id : null;
      recompute();
      renderAll();
      scheduleSave();
    }
  });

  /* ------------------------------------------------ 右：方案设置 */  function renderSettings() {
    var box = $("#settingsEditor");
    if (!state.plan) { box.innerHTML = ""; return; }
    var s = state.analysis.settings;
    function numField(key, label, hint, step) {
      return '<div class="field"><label>' + label + '</label>' +
        '<input type="number" step="' + (step || 1) + '" data-s="' + key + '" value="' + esc(s[key]) + '">' +
        (hint ? '<div class="hint">' + hint + "</div>" : "") + "</div>";
    }
    box.innerHTML =
      '<div class="settings-grid">' +
        numField("fps", "默认帧率（格/秒）", "卷上未单独填写时使用", 0.01) +
        '<div class="field"><label>默认规格</label><select data-s="gauge">' +
          ["35mm", "16mm", "8mm", "super8"].map(function (g) {
            return '<option value="' + g + '"' + (s.gauge === g ? " selected" : "") + ">" + g + "</option>";
          }).join("") + "</select></div>" +
      "</div>" +
      '<div class="field"><label>提示位置计量方式</label><select data-s="cueRef">' +
        '<option value="tail"' + (s.cueRef === "tail" ? " selected" : "") + '>距画面末尾（放映习惯：尾前 12 英尺 / 1.5 英尺）</option>' +
        '<option value="head"' + (s.cueRef === "head" ? " selected" : "") + ">距物理片头（护片之后累计）</option>" +
      "</select></div>" +
      '<div class="settings-grid">' +
        numField("motorLeadSec", "首卷马达提前（秒）", "开映前甲机马达启动时刻") +
        numField("accelSec", "马达加速稳速（秒）", "", 0.5) +
        numField("minMotorLeadSec", "最小马达提前量（秒）", "马达提示与切换提示间隔下限", 0.5) +
        numField("minHeadReserveSec", "最小片头储备（秒）", "切换瞬间动作片头之前的余量", 0.5) +
        numField("gapToleranceSec", "空档/重叠容差（秒）", "≤容差的重叠视为标准双机接片", 0.5) +
        numField("tailRunoffSec", "切换后跑片尾（秒）", "到停机之间的时长", 0.5) +
        numField("laceSec", "挂片时间（秒）", "回卷完成后挂好下一卷") +
        numField("rewindFactor", "回卷速度倍率", "回卷速度 = 放映速度 × 倍率", 0.5) +
        numField("turnaroundBufferSec", "周转安全余量（秒）", "就绪须早于下一马达启动") +
      "</div>" +
      '<div class="field"><label>回卷方式</label><select data-s="rewindMode">' +
        '<option value="serial"' + (s.rewindMode === "serial" ? " selected" : "") + '>停机后回卷（稳妥，常见于小厅）</option>' +
        '<option value="parallel"' + (s.rewindMode === "parallel" ? " selected" : "") + ">切换后立即回卷（紧凑）</option>" +
      "</select></div>" +
      '<div class="field"><label>方案备注</label>' +
        '<textarea rows="3" data-s="note">' + esc(state.plan.note || "") + "</textarea></div>";
  }

  $("#settingsEditor").addEventListener("change", function (ev) {
    var f = ev.target.getAttribute("data-s");
    if (!f || !state.plan) return;
    if (!state.plan.settings) state.plan.settings = {};
    if (ev.target.type === "number") state.plan.settings[f] = parseFloat(ev.target.value);
    else state.plan.settings[f] = ev.target.value;
    if (f === "note") state.plan.note = ev.target.value;
    recompute();
    renderAll();
    scheduleSave();
  });

  /* ------------------------------------------------ 右：问题列表 */
  function renderIssues() {
    var list = $("#issueList");
    var badge = $("#issueBadge");
    var a = state.analysis;
    if (!a) { list.innerHTML = ""; badge.hidden = true; return; }
    var n = a.issues.length;
    badge.hidden = n === 0;
    badge.textContent = n;
    var st = a.stats;
    $("#issueSummary").innerHTML =
      '<div class="stat-chip err"><div class="n">' + st.errorCount + '</div><div class="t">错误</div></div>' +
      '<div class="stat-chip warn"><div class="n">' + st.warningCount + '</div><div class="t">警告</div></div>' +
      '<div class="stat-chip doubt"><div class="n">' + st.doubtfulCount + '</div><div class="t">存疑</div></div>' +
      '<div class="stat-chip gap"><div class="n">' + E.fmtSigned(st.totalGap, 0) + '</div><div class="t">空档合计</div></div>' +
      '<div class="stat-chip gap"><div class="n">' + E.fmtSigned(st.totalOverlap, 0) + '</div><div class="t">重叠合计</div></div>' +
      '<div class="stat-chip gap"><div class="n">' + E.fmtSigned(st.turnaroundShort, 0) + '</div><div class="t">周转缺口</div></div>';
    if (!n) {
      list.innerHTML = '<li class="issue-empty">未发现排映冲突。<br>存疑提示仍建议在装片时现场复核。</li>';
      return;
    }
    list.innerHTML = a.issues.map(function (i) {
      var icon = i.severity === "error" ? "⛔" : "⚠️";
      return '<li class="issue-item ' + i.severity + '" data-issue="' + i.id + '">' +
        '<span class="iss-icon">' + icon + '</span>' +
        '<span style="flex:1 1 auto">' + esc(i.message) + '</span>' +
        '<span class="iss-kind">' + esc(i.label) + "</span>" +
        (i.doubtful ? '<span class="iss-doubt">存疑</span>' : "") +
        "</li>";
    }).join("");
  }

  $("#issueList").addEventListener("click", function (ev) {
    var li = ev.target.closest("[data-issue]");
    if (!li) return;
    var issue = state.analysis.issues.filter(function (i) { return i.id === li.getAttribute("data-issue"); })[0];
    if (!issue) return;
    selectReel(issue.reelId, issue.cue);
    if (issue.t != null) {
      pauseSim();
      state.sim.active = true;
      state.sim.t = issue.t;
      renderPlayhead();
      renderEventLog();
      scrollTimeTo(issue.t, 0.5);
    }
  });

  /* ============================================================
   * 时间轴 SVG
   * ============================================================ */
  var svg = $("#timeline"), scroll = $("#timelineScroll");

  function timeBounds() {
    var a = state.analysis;
    return { t0: a.tMin - GEO.padSec, t1: a.tMax + GEO.padSec };
  }
  function xOf(t) { return GEO.axisX + (t - timeBounds().t0) * state.view.pxPerSec; }
  function tAtX(x) { return (x - GEO.axisX) / state.view.pxPerSec + timeBounds().t0; }

  function fitZoom(initial) {
    if (!state.analysis) return;
    var b = timeBounds();
    var avail = Math.max(400, scroll.clientWidth - GEO.labelW - 20);
    state.view.pxPerSec = clamp(avail / (b.t1 - b.t0), 2, 200);
    updateZoomLabel();
    renderTimeline();
    if (initial) {
      requestAnimationFrame(function () {
        var s = state.analysis;
        var showT = s.computed.length ? s.computed[0].motorStart : 0;
        scroll.scrollLeft = Math.max(0, xOf(showT) - scroll.clientWidth * 0.25);
      });
    }
  }

  function niceTickStep(targetPx) {
    var secPerPxTarget = targetPx / state.view.pxPerSec; // 目标主刻度代表的秒数
    var steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= secPerPxTarget) return steps[i];
    return 3600;
  }

  function renderTimeline() {
    if (!state.analysis) { svg.innerHTML = ""; svg.setAttribute("width", 100); return; }
    var a = state.analysis, s = a.settings;
    var b = timeBounds();
    var contentW = (b.t1 - b.t0) * state.view.pxPerSec;
    var W = Math.max(scroll.clientWidth, GEO.axisX + contentW + GEO.labelW);
    var H = GEO.bottom;
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    var html = [];
    // ---- 泳道底
    html.push(rect(0, 0, W, H, { fill: "#14161a" }));
    html.push(rect(0, GEO.laneA - 6, W, GEO.laneH + 12, { fill: "rgba(91,155,213,.05)" }));
    html.push(rect(0, GEO.laneB - 6, W, GEO.laneH + 12, { fill: "rgba(216,140,91,.05)" }));

    // ---- 网格与时刻
    var step = niceTickStep(130);
    var kStart = Math.floor(b.t0 / step), kEnd = Math.ceil(b.t1 / step);
    for (var k = kStart; k <= kEnd; k++) {
      var t = k * step, x = xOf(t);
      html.push(line(x, GEO.rulerH, x, H, { stroke: "#24282f", "stroke-width": 1 }));
      html.push(text(x + 4, GEO.rulerH - 7, E.fmtClock(t, step >= 60), {
        fill: "#7b828c", "font-size": 10, "font-variant-numeric": "tabular-nums",
      }));
    }
    // 开映零线 t=0
    if (0 > b.t0 && 0 < b.t1) {
      html.push(line(xOf(0), GEO.rulerH, xOf(0), H, { stroke: "#4d5562", "stroke-width": 1, "stroke-dasharray": "4 3" }));
      html.push(text(xOf(0) + 3, H - 4, "开映", { fill: "#8b95a1", "font-size": 9 }));
    }

    // ---- 银幕画面轨
    // 每卷自动作片头(pictureStart)起上银幕，至本卷切换标记(picEnd)止；
    // 相邻两段在切换点交叠（标准约 1 秒）。
    html.push(rect(GEO.labelW + 4, GEO.screenY, W - GEO.labelW - 4, GEO.screenH, { fill: "#191c22", rx: 3 }));
    html.push(text(8, GEO.screenY + 14, "银幕", { fill: "#7d8590", "font-size": 9.5 }));
    a.computed.forEach(function (c) {
      var sx1 = xOf(c.pictureStart);
      var sx2 = xOf(c.picEnd);
      html.push(rect(sx1, GEO.screenY, Math.max(1, sx2 - sx1), GEO.screenH, {
        fill: "rgba(79,195,176,.22)", stroke: "#2e6b60", "stroke-width": 0.8,
      }));
      html.push(line(sx2, GEO.screenY - 2, sx2, GEO.screenY + GEO.screenH + 2,
        { stroke: "#4fc3b0", "stroke-width": 0.8, "stroke-dasharray": "2 2" }));
    });
    // 空档 / 重叠（本卷画面末尾 c.picEnd 相对 下卷动作片头 nx.pictureStart）
    a.computed.forEach(function (c, idx) {
      var nx = a.computed[idx + 1];
      if (!nx) return;
      var g = nx.pictureStart - c.picEnd; // 正=空档，负=重叠
      if (g > s.gapToleranceSec) {
        var xg1 = xOf(c.picEnd), xg2 = xOf(nx.pictureStart);
        html.push(rect(xg1, GEO.screenY, Math.max(2, xg2 - xg1), GEO.screenH, {
          fill: "url(#hatchGap)", stroke: "#6b7280", "stroke-width": 0.6,
        }));
        if (xg2 - xg1 > 34)
          html.push(text((xg1 + xg2) / 2, GEO.screenY + 14, "空档 " + E.fmtSigned(g, 1) + "s",
            { fill: "#c7cdd6", "font-size": 9.5, "text-anchor": "middle" }));
      } else if (g < -s.gapToleranceSec) {
        var xo1 = xOf(nx.pictureStart), xo2 = xOf(c.picEnd);
        html.push(rect(xo1, GEO.screenY, Math.max(2, xo2 - xo1), GEO.screenH, {
          fill: "rgba(224,93,93,.55)", stroke: "#a14646", "stroke-width": 0.6,
        }));
        if (xo2 - xo1 > 34)
          html.push(text((xo1 + xo2) / 2, GEO.screenY + 14, "重叠 " + E.fmtSigned(-g, 1) + "s",
            { fill: "#ffd9d9", "font-size": 9.5, "text-anchor": "middle" }));
      }
    });
    // ---- 胶卷块
    a.computed.forEach(function (c) { html.push(reelBlock(c, a)); });

    // ---- 周转连线
    a.computed.forEach(function (c) {
      if (!c.turnaround) return;
      var y = GEO[c.reel.projector === "A" ? "laneA" : "laneB"] + GEO.laneH + 6;
      var x1 = xOf(c.threadedFor), x2 = xOf(c.turnaround.deadlineT);
      var col = c.turnaround.slack >= 0 ? "#3f7d72" : "#c45050";
      html.push(line(x1, y, Math.max(x1 + 2, x2), y, { stroke: col, "stroke-width": 2.5 }));
      html.push(svgTriangle(x1, y, 4, col, "right"));
      html.push(svgTriangle(Math.max(x1 + 2, x2), y, 4, col, "left"));
      var label = (c.turnaround.slack >= 0 ? "周转余量 " : "缺 ") +
        E.fmtSigned(Math.abs(c.turnaround.slack), 0) + "s";
      if (Math.abs(x2 - x1) > 44)
        html.push(text((x1 + x2) / 2, y - 3, label, {
          fill: col, "font-size": 9, "text-anchor": "middle",
        }));
    });

    // ---- 泳道固定标签（随滚动同步）
    html.push('<g id="stickyLabels">' +
      rect(0, 0, GEO.labelW, H, { fill: "#14161a" }) +
      line(GEO.labelW - 1, 0, GEO.labelW - 1, H, { stroke: "#333842", "stroke-width": 1 }) +
      text(8, GEO.rulerH - 7, "时刻", { fill: "#9aa2ad", "font-size": 10.5 }) +
      rect(6, GEO.laneA + 6, GEO.labelW - 12, GEO.laneH - 12, { fill: "#5b9bd5", rx: 4 }) +
      text(GEO.labelW / 2, GEO.laneA + GEO.laneH / 2 + 1, "甲机", { fill: "#101317", "font-size": 12, "font-weight": 700, "text-anchor": "middle" }) +
      rect(6, GEO.laneB + 6, GEO.labelW - 12, GEO.laneH - 12, { fill: "#d88c5b", rx: 4 }) +
      text(GEO.labelW / 2, GEO.laneB + GEO.laneH / 2 + 1, "乙机", { fill: "#101317", "font-size": 12, "font-weight": 700, "text-anchor": "middle" }) +
      "</g>");

    // ---- 拖拽指示层 / 播放头
    html.push('<g id="dropLayer"></g>');
    html.push('<g id="playheadLayer"></g>');

    svg.innerHTML =
      '<defs>' +
      '<pattern id="hatchGap" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">' +
      '<rect width="6" height="6" fill="#262b33"/><line x1="0" y1="0" x2="0" y2="6" stroke="#454c59" stroke-width="2"/></pattern>' +
      '<pattern id="hatchU" width="5" height="5" patternUnits="userSpaceOnUse">' +
      '<rect width="5" height="5" fill="transparent"/><line x1="0" y1="0" x2="5" y2="5" stroke="#d8b44a" stroke-width="1.2"/></pattern>' +
      "</defs>" + html.join("");

    syncSticky();
    renderPlayhead();
    renderDropLayer();
  }

  function reelBlock(c, analysis) {
    var reel = c.reel;
    var laneY = GEO[reel.projector === "A" ? "laneA" : "laneB"];
    var col = reel.projector === "A" ? "#5b9bd5" : "#d88c5b";
    var headSec = c.headFrames / c.fps;
    var xHead = xOf(c.pictureStart - headSec);
    var xTailEnd = xOf(c.picEnd + c.tailFrames / c.fps);
    var xMotor = xOf(c.motorStart);
    var xPic = xOf(c.pictureStart);
    var xChg = xOf(c.changeCueT);
    var xStop = xOf(c.stopTime);
    var selected = reel.id === state.selectedReelId;
    var h = [];

    // 物理全卷（淡）
    h.push(rect(xHead, laneY + 8, Math.max(2, xTailEnd - xHead), GEO.laneH - 16, {
      fill: "none", stroke: "#3b414b", "stroke-width": 0.8, "stroke-dasharray": "3 3", rx: 3,
    }));
    // 运行段三段
    h.push(rect(xMotor, laneY + 8, Math.max(1, xPic - xMotor), GEO.laneH - 16, { fill: "#33382f", rx: 2 }));
    h.push(rect(xPic, laneY + 8, Math.max(1, xChg - xPic), GEO.laneH - 16, {
      fill: reel.projector === "A" ? "rgba(91,155,213,.42)" : "rgba(216,140,91,.42)",
    }));
    h.push(rect(xChg, laneY + 8, Math.max(1, xStop - xChg), GEO.laneH - 16, { fill: "#2a2e36", rx: 2 }));
    // 边框 + 命中区
    h.push(rect(xMotor, laneY + 8, Math.max(6, xStop - xMotor), GEO.laneH - 16, {
      fill: "transparent", stroke: selected ? "#e8a33d" : col,
      "stroke-width": selected ? 2 : 1.2, rx: 4,
      "data-reel-block": reel.id, style: "cursor:" + (reel.locked ? "pointer" : "grab"),
    }));
    // 序号徽标
    h.push(rect(xMotor + 3, laneY + 10, 16, 13, { fill: col, rx: 2 }));
    h.push(text(xMotor + 11, laneY + 20, String(c.idx + 1), {
      fill: "#101317", "font-size": 9.5, "font-weight": 700, "text-anchor": "middle",
    }));
    // 标题
    var titleX = xMotor + 23;
    h.push('<text x="' + titleX + '" y="' + (laneY + 21) + '" fill="#eef1f5" font-size="11" font-weight="600" ' +
      'pointer-events="none" clip-path="inset(0)">' + esc(reel.title) + "</text>");
    h.push(text(titleX, laneY + 36, "切换 " + E.fmtClock(c.changeCueT), {
      fill: "#b9c0ca", "font-size": 9.5, "font-variant-numeric": "tabular-nums",
    }));
    h.push(text(xStop - 4, laneY + 50, E.fmtDuration(c.picSec), {
      fill: "#7e8794", "font-size": 9, "text-anchor": "end",
    }));
    if (reel.locked)
      h.push(text(xStop - 4, laneY + 21, "🔒", { "font-size": 10, "text-anchor": "end" }));

    // 提示标志（含存疑范围括号）
    h.push(cueMarker(c, "motor", laneY));
    h.push(cueMarker(c, "change", laneY));

    // 就绪刻点
    if (c.idx < analysis.computed.length - 1) {
      var xR = xOf(c.threadedFor);
      h.push(line(xR, laneY + GEO.laneH - 10, xR, laneY + GEO.laneH - 2, { stroke: "#4fc3b0", "stroke-width": 2 }));
    }
    return h.join("");
  }

  function cueMarker(c, kind, laneY) {
    var isMotor = kind === "motor";
    var lo = isMotor ? c.motorCueMin : c.changeCueMin;
    var hi = isMotor ? c.motorCueMax : c.changeCueMax;
    var mid = isMotor ? c.motorCueT : c.changeCueT;
    var uncertain = isMotor ? c.motor.uncertain : c.change.uncertain;
    var col = isMotor ? "#e8a33d" : "#e05d5d";
    var x = xOf(mid), x1 = xOf(lo), x2 = xOf(hi);
    var top = laneY - 3, bot = laneY + GEO.laneH + 3;
    var out = [];
    if (uncertain && x2 - x1 > 1) {
      out.push(rect(x1, top + 2, Math.max(2, x2 - x1), bot - top - 4, {
        fill: "url(#hatchU)", stroke: "none", opacity: 0.85,
      }));
      out.push(line(x1, top + 3, x1, bot - 3, { stroke: col, "stroke-width": 1, "stroke-dasharray": "2 2" }));
      out.push(line(x2, top + 3, x2, bot - 3, { stroke: col, "stroke-width": 1, "stroke-dasharray": "2 2" }));
    }
    out.push(line(x, top, x, bot, {
      stroke: col, "stroke-width": 1.6, "data-cue-marker": kind, "data-reel": c.reel.id,
      style: "cursor:pointer",
    }));
    var cy = isMotor ? top : bot;
    out.push(svgCueTriangle(x, cy, 5.5, col, isMotor ? "up" : "down", c.reel.id, kind));
    return out.join("");
  }

  /* SVG 小工具 */
  function attrs(a) {
    return Object.keys(a || {}).map(function (k) {
      return k + '="' + String(a[k]).replace(/"/g, "&quot;") + '"';
    }).join(" ");
  }
  function rect(x, y, w, h, a) {
    a = a || {};
    a.x = x; a.y = y; a.width = Math.max(0, w); a.height = h;
    return "<rect " + attrs(a) + "/>";
  }
  function line(x1, y1, x2, y2, a) {
    a = a || {};
    a.x1 = x1; a.y1 = y1; a.x2 = x2; a.y2 = y2;
    return "<line " + attrs(a) + "/>";
  }
  function text(x, y, t, a) {
    return "<text " + attrs(Object.assign({ x: x, y: y }, a || {})) + ">" + esc(t) + "</text>";
  }
  function svgTriangle(cx, cy, r, color, dir) {
    var pts;
    if (dir === "right") pts = (cx - r) + "," + (cy - r) + " " + (cx + r) + "," + cy + " " + (cx - r) + "," + (cy + r);
    else pts = (cx - r) + "," + (cy + r) + " " + (cx + r) + "," + (cy + r) + " " + cx + "," + (cy - r);
    return '<polygon points="' + pts + '" fill="' + color + '"/>';
  }
  function svgCueTriangle(cx, cy, r, color, dir, reelId, kind) {
    var pts = dir === "up"
      ? cx + "," + (cy - r) + " " + (cx - r) + "," + (cy + r) + " " + (cx + r) + "," + (cy + r)
      : cx + "," + (cy + r) + " " + (cx - r) + "," + (cy - r) + " " + (cx + r) + "," + (cy - r);
    return '<polygon points="' + pts + '" fill="' + color + '" data-cue-marker="' + kind +
      '" data-reel="' + reelId + '" style="cursor:pointer"/>';
  }

  function syncSticky() {
    var g = $("#stickyLabels");
    if (g) g.setAttribute("transform", "translate(" + scroll.scrollLeft + ",0)");
  }
  scroll.addEventListener("scroll", syncSticky);

  /* 缩放 */
  function updateZoomLabel() {
    // 以 14 px/秒为 100%
    $("#zoomLabel").textContent = Math.round(state.view.pxPerSec / 14 * 100) + "%";
  }
  function zoomAt(factor, centerX) {
    var tCenter = tAtX(centerX + scroll.scrollLeft);
    state.view.pxPerSec = clamp(state.view.pxPerSec * factor, 2, 400);
    renderTimeline();
    scroll.scrollLeft = xOf(tCenter) - centerX;
    syncSticky();
    updateZoomLabel();
  }
  $("#zoomIn").addEventListener("click", function () { zoomAt(1.25, scroll.clientWidth / 2); });
  $("#zoomOut").addEventListener("click", function () { zoomAt(0.8, scroll.clientWidth / 2); });
  $("#zoomFit").addEventListener("click", function () { fitZoom(false); });
  scroll.addEventListener("wheel", function (ev) {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      var rectBox = scroll.getBoundingClientRect();
      zoomAt(ev.deltaY < 0 ? 1.12 : 0.89, ev.clientX - rectBox.left);
    } else if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
      ev.preventDefault();
      scroll.scrollLeft += ev.deltaY;
      syncSticky();
    }
  }, { passive: false });

  /* 拖拽：调序 / 换机 */
  svg.addEventListener("pointerdown", function (ev) {
    var marker = ev.target.closest ? ev.target.closest("[data-cue-marker]") : null;
    var blockEl = ev.target.closest ? ev.target.closest("[data-reel-block]") : null;
    if (marker && !blockEl) {
      state.selectedReelId = marker.getAttribute("data-reel");
      selectReel(state.selectedReelId, marker.getAttribute("data-cue-marker"));
      return;
    }
    if (!blockEl) return;
    var id = blockEl.getAttribute("data-reel-block");
    var reel = state.plan.reels.filter(function (r) { return r.id === id; })[0];
    if (reel.locked) { selectReel(id); return; }
    var rectBox = scroll.getBoundingClientRect();
    state.drag = {
      id: id,
      startX: ev.clientX,
      startY: ev.clientY,
      moved: false,
      lane: reel.projector,
      insertIdx: state.analysis.reels.indexOf(reel),
      boxLeft: rectBox.left,
      boxTop: rectBox.top,
      title: reel.title,
    };
    svg.classList.add("dragging-reel");
    svg.setPointerCapture(ev.pointerId);
  });

  svg.addEventListener("pointermove", function (ev) {
    var d = state.drag;
    if (!d) return;
    if (!d.moved && Math.abs(ev.clientX - d.startX) + Math.abs(ev.clientY - d.startY) < 6) return;
    d.moved = true;
    var localX = ev.clientX - d.boxLeft + scroll.scrollLeft;
    var localY = ev.clientY - d.boxTop;
    d.lane = localY < (GEO.laneA + GEO.laneH + GEO.laneB) / 2 ? "A" : "B";
    // 注意：判定轴在两条泳道之间，localY 为内容坐标
    var t = tAtX(localX);
    var others = state.analysis.computed.filter(function (c) { return c.reel.id !== d.id; });
    // 按画面开始位置决定插入序号
    var idx = others.length;
    for (var j = 0; j < others.length; j++) {
      if (t < others[j].pictureStart) { idx = j; break; }
    }
    d.insertIdx = idx;
    d.pointerX = localX; d.pointerY = localY;
    renderDropLayer();
  });

  svg.addEventListener("pointerup", function (ev) {
    var d = state.drag;
    if (!d) return;
    svg.classList.remove("dragging-reel");
    state.drag = null;
    renderDropLayer();
    if (!d.moved) { selectReel(d.id); return; }
    var reel = state.plan.reels.filter(function (r) { return r.id === d.id; })[0];
    var rest = state.plan.reels.filter(function (r) { return r.id !== d.id; });
    reel.projector = d.lane;
    rest.splice(Math.min(d.insertIdx, rest.length), 0, reel);
    state.plan.reels = rest;
    state.selectedReelId = reel.id;
    recompute();
    renderAll();
    scheduleSave();
  });

  function renderDropLayer() {
    var g = $("#dropLayer");
    if (!g) return;
    var d = state.drag;
    if (!d || !d.moved) { g.innerHTML = ""; return; }
    var laneY = GEO[d.lane === "A" ? "laneA" : "laneB"];
    var others = state.analysis.computed.filter(function (c) { return c.reel.id !== d.id; });
    var xLine, target = others[Math.min(d.insertIdx, others.length - 1)];
    if (!target) xLine = xOf(timeBounds().t0 + 5);
    else xLine = d.insertIdx === 0 ? xOf(others[0].headStart) : xOf(others[d.insertIdx - 1].stopTime);
    var h =
      rect(scroll.scrollLeft, laneY - 6, scroll.clientWidth, GEO.laneH + 12,
        { fill: d.lane === "A" ? "rgba(91,155,213,.10)" : "rgba(216,140,91,.10)" }) +
      line(xLine, GEO.screenY - 4, xLine, GEO.bottom - 6, { stroke: "#e8a33d", "stroke-width": 2, "stroke-dasharray": "5 4" }) +
      rect(d.pointerX - 70, laneY - 26, 140, 16, { fill: "#2c2818", stroke: "#8a6a2b", rx: 3 }) +
      text(d.pointerX, laneY - 14, "移至" + (d.lane === "A" ? "甲机" : "乙机") + " · 第 " + (d.insertIdx + 1) + " 位",
        { fill: "#f3d9a6", "font-size": 10, "text-anchor": "middle" });
    g.innerHTML = h;
  }

  function scrollTimeTo(t, ratio) {
    var target = xOf(t) - scroll.clientWidth * (ratio == null ? 0.5 : ratio);
    scroll.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }

  /* ------------------------------------------------ 播放头 */
  function renderPlayhead() {
    var g = $("#playheadLayer");
    if (!g) return;
    var sim = state.sim;
    if (!sim.active) { g.innerHTML = ""; $("#playheadTag").hidden = true; return; }
    var x = xOf(sim.t);
    g.innerHTML = line(x, GEO.screenY - 4, x, GEO.bottom - 4, {
      stroke: "#e8a33d", "stroke-width": 1.6,
    }) + '<polygon points="' + x + "," + (GEO.screenY - 12) + " " + (x - 5) + "," +
      (GEO.screenY - 4) + " " + (x + 5) + "," + (GEO.screenY - 4) + '" fill="#e8a33d"/>';
    var tag = $("#playheadTag");
    tag.hidden = false;
    tag.textContent = E.fmtClock(sim.t);
    tag.style.left = (GEO_LABEL_OFFSET(x)) + "px";
    tag.style.top = "2px";
  }
  function GEO_LABEL_OFFSET(x) {
    return x - scroll.scrollLeft; // 相对滚动容器
  }

  /* ------------------------------------------------ 逐步模拟 */
  var simPlay = $("#simPlay");
  function resetSim(silent) {
    pauseSim();
    if (!state.analysis || !state.analysis.computed.length) { state.sim.active = false; return; }
    state.sim.t = state.analysis.computed[0].motorStart - 1;
    state.sim.active = true;
    renderPlayhead();
    renderEventLog();
    renderSimCards();
    if (!silent) scrollTimeTo(state.sim.t, 0.3);
  }
  function pauseSim() {
    state.sim.playing = false;
    cancelAnimationFrame(state.sim.raf);
    simPlay.textContent = "▶ 逐步模拟";
  }
  function togglePlay() {
    if (!state.analysis) return;
    if (!state.sim.active) resetSim(true);
    state.sim.playing = !state.sim.playing;
    simPlay.textContent = state.sim.playing ? "⏸ 暂停" : "▶ 继续";
    if (state.sim.playing) {
      state.sim.lastWall = performance.now();
      state.sim.raf = requestAnimationFrame(simTick);
      var first = nextEvent();
      if (first) scrollTimeTo(first.t, 0.35);
    }
  }
  function simTick(now) {
    if (!state.sim.playing) return;
    var dt = (now - state.sim.lastWall) / 1000;
    state.sim.lastWall = now;
    var speed = parseFloat($("#simSpeed").value) || 1;
    state.sim.t += dt * speed;
    var last = state.analysis.events[state.analysis.events.length - 1];
    if (last && state.sim.t >= last.t + 2) {
      state.sim.t = last.t + 2;
      pauseSim();
    }
    // 自动跟随
    var nx = nextEvent();
    var px = xOf(state.sim.t) - scroll.scrollLeft;
    if (px > scroll.clientWidth * 0.75 && nx) scroll.scrollLeft = xOf(nx.t) - scroll.clientWidth * 0.35;
    renderPlayhead();
    renderSimCards();
    renderEventLog();
    if (state.sim.playing) state.sim.raf = requestAnimationFrame(simTick);
  }
  function nextEvent() {
    return state.analysis.events.filter(function (e) { return e.t > state.sim.t + 1e-6; })[0] || null;
  }
  function jumpEvent(dir) {
    var evs = state.analysis.events;
    pauseSim();
    state.sim.active = true;
    var idx;
    if (dir > 0) {
      idx = evs.findIndex(function (e) { return e.t > state.sim.t + 1e-6; });
      if (idx < 0) idx = evs.length - 1;
    } else {
      idx = -1;
      for (var i = 0; i < evs.length; i++) {
        if (evs[i].t < state.sim.t - 1e-6) idx = i; else break;
      }
      if (idx < 0) idx = 0;
    }
    var target = evs[idx];
    if (target) {
      state.sim.t = target.t;
      scrollTimeTo(target.t, 0.4);
    }
    renderPlayhead(); renderSimCards(); renderEventLog();
  }

  function screenReelAt(t) {
    var cur = null;
    state.analysis.computed.forEach(function (c) {
      if (c.pictureStart <= t + 1e-6) cur = c;
    });
    return cur;
  }

  function renderSimCards() {
    if (!state.analysis) return;
    $("#simClock").textContent = state.sim.active ? E.fmtClock(state.sim.t) : "--:--";
    var cur = state.sim.active ? screenReelAt(state.sim.t) : null;
    if (!cur) {
      $("#simCurrent").textContent = state.sim.active ? "（放映前准备）" : "—";
    } else {
      $("#simCurrent").textContent = (cur.reel.projector === "A" ? "甲机 · " : "乙机 · ") + cur.reel.title;
    }
    var nx = state.sim.active ? nextEvent() : null;
    if (!nx) { $("#simNextCue").textContent = "终场"; $("#simCountdown").textContent = ""; }
    else {
      $("#simNextCue").textContent = nx.label;
      $("#simCountdown").textContent = "剩余 " + E.fmtSigned(nx.t - state.sim.t, 1) + " 秒";
    }
  }

  /* 提示时刻表 */
  function renderEventLog() {
    var box = $("#eventLog");
    if (!state.analysis) { box.innerHTML = ""; return; }
    var nextId = state.sim.active && nextEvent() ? nextEvent().id : null;
    box.innerHTML = state.analysis.events.map(function (e) {
      return '<li class="event-row' + (e.id === nextId ? " active" : "") +
        (state.sim.active && e.t <= state.sim.t ? '" style="opacity:.5"' : '"') +
        ' data-event="' + esc(e.id) + '">' +
        '<span class="ev-t">' + E.fmtClock(e.t) + "</span>" +
        '<span class="ev-k ev-k-' + e.kind + '">' +
        ({ start: "启动", motor: "马达", change: "切换", stop: "停机", ready: "就绪" })[e.kind] + "</span>" +
        '<span class="ev-label">' + esc(e.label) + "</span></li>";
    }).join("");
  }
  $("#eventLog").addEventListener("click", function (ev) {
    var row = ev.target.closest("[data-event]");
    if (!row) return;
    var e = state.analysis.events.filter(function (x) { return x.id === row.getAttribute("data-event"); })[0];
    pauseSim();
    state.sim.active = true;
    state.sim.t = e.t - 0.01;
    renderPlayhead(); renderSimCards(); renderEventLog();
    scrollTimeTo(e.t, 0.4);
  });

  /* ============================================================
   * 顶栏按钮：方案库 / 新建 / 导入导出 / 打印
   * ============================================================ */
  function bindStaticUI() {
    $("#btnNew").addEventListener("click", createPlan);
    $("#btnOpen").addEventListener("click", openPlanModal);
    $("#btnCompare").addEventListener("click", openCompare);
    $("#btnExport").addEventListener("click", exportCurrent);
    $("#btnImport").addEventListener("click", function () { $("#fileInput").click(); });
    $("#fileInput").addEventListener("change", importFile);
    $("#btnPrint").addEventListener("click", printSheet);
    $("#btnAddReel").addEventListener("click", addReel);
    $("#btnAlternate").addEventListener("click", alternateReels);
    $("#simPlay").addEventListener("click", togglePlay);
    $("#simNext").addEventListener("click", function () { jumpEvent(1); });
    $("#simPrev").addEventListener("click", function () { jumpEvent(-1); });
    $("#simReset").addEventListener("click", function () { resetSim(false); });
    $("#planName").addEventListener("input", function () {
      if (state.plan) { state.plan.name = this.value; scheduleSave(); }
    });
    $$("[data-close]").forEach(function (b) {
      b.addEventListener("click", function () { $("#" + b.getAttribute("data-close")).hidden = true; });
    });
    $$(".modal").forEach(function (m) {
      m.addEventListener("pointerdown", function (ev) { if (ev.target === m) m.hidden = true; });
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.code === "Space" && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)) {
        ev.preventDefault(); togglePlay();
      }
    });
  }

  function addReel() {
    if (!state.plan) return;
    var r = E.makeReel(state.plan.reels.length);
    state.plan.reels.push(r);
    state.selectedReelId = r.id;
    recompute(); renderAll(); scheduleSave();
  }
  function alternateReels() {
    if (!state.plan) return;
    state.plan.reels.forEach(function (r, i) {
      if (!r.locked) r.projector = i % 2 === 0 ? "A" : "B";
    });
    touch();
  }

  function createPlan() {
    var plan = {
      id: E.uid("plan"),
      name: "新方案 " + new Date().toLocaleDateString(),
      note: "",
      settings: E.makeSettings({}),
      reels: [E.makeReel(0)],
    };
    api("/api/plans", jsonOpts("POST", plan)).then(function () {
      openPlan(plan.id);
    }).catch(function (e) { alert(e.message); });
  }

  /* 方案库 */
  function openPlanModal() {
    $("#planModalTitle").textContent = "方案库";
    api("/api/plans").then(function (list) {
      var html =
        '<div style="margin-bottom:10px"><button class="btn btn-sm btn-primary" id="modalNewPlan">＋ 新建空白方案</button></div>' +
        '<table class="plan-table"><thead><tr><th>方案</th><th>卷数</th><th>更新时间</th><th style="text-align:right">操作</th></tr></thead><tbody>' +
        list.map(function (p) {
          return '<tr><td class="plan-name-cell">' + esc(p.name) +
            '<span class="sub">' + esc(p.note || "") + "</span></td>" +
            '<td>' + p.reelCount + '</td><td>' + new Date(p.updatedAt).toLocaleString() + '</td>' +
            '<td><div class="row-actions">' +
            '<button class="btn btn-sm" data-open="' + esc(p.id) + '">打开</button>' +
            '<button class="btn btn-sm" data-dup="' + esc(p.id) + '">复制</button>' +
            '<button class="btn btn-sm btn-danger" data-del="' + esc(p.id) + '">删除</button>' +
            "</div></td></tr>";
        }).join("") + "</tbody></table>";
      $("#planModalBody").innerHTML = html;
      $("#planModal").hidden = false;
      $("#modalNewPlan").onclick = function () { $("#planModal").hidden = true; createPlan(); };
      $$("#planModalBody [data-open]").forEach(function (b) {
        b.onclick = function () { $("#planModal").hidden = true; openPlan(b.getAttribute("data-open")); };
      });
      $$("#planModalBody [data-dup]").forEach(function (b) {
        b.onclick = function () { duplicatePlan(b.getAttribute("data-dup")); };
      });
      $$("#planModalBody [data-del]").forEach(function (b) {
        b.onclick = function () { deletePlan(b.getAttribute("data-del")); };
      });
    });
  }

  function duplicatePlan(id) {
    api("/api/plans/" + id).then(function (p) {
      p.id = E.uid("plan");
      p.name = p.name + "（副本）";
      p.reels.forEach(function (r) { r.id = E.uid("reel"); });
      return api("/api/plans", jsonOpts("POST", p));
    }).then(function () { openPlanModal(); });
  }
  function deletePlan(id) {
    if (!confirm("确定删除该方案？此操作不可恢复。")) return;
    api("/api/plans/" + id, { method: "DELETE" }).then(function () {
      if (state.plan && state.plan.id === id) {
        api("/api/plans").then(function (list) {
          if (list.length) openPlan(list[0].id); else location.reload();
        });
      } else openPlanModal();
    });
  }

  /* 比较 */
  var compareIds = [];
  function openCompare() {
    api("/api/plans").then(function (list) {
      if (compareIds.length === 0 && state.plan) compareIds = [state.plan.id];
      $("#comparePick").innerHTML = list.map(function (p) {
        var on = compareIds.indexOf(p.id) >= 0;
        return '<label class="' + (on ? "on" : "") + '"><input type="checkbox" value="' +
          esc(p.id) + '"' + (on ? " checked" : "") + ">" + esc(p.name) + "</label>";
      }).join("");
      $$("#comparePick input").forEach(function (cb) {
        cb.onchange = function () {
          compareIds = $$("#comparePick input:checked").map(function (x) { return x.value; });
          cb.closest("label").classList.toggle("on", cb.checked);
          renderCompareTable();
        };
      });
      $("#compareModal").hidden = false;
      renderCompareTable();
    });
  }
  function fetchPlan(id) {
    if (state.planCache[id]) return Promise.resolve(state.planCache[id]);
    return api("/api/plans/" + id).then(function (p) { state.planCache[id] = p; return p; });
  }
  function renderCompareTable() {
    var wrap = $("#compareTableWrap");
    if (compareIds.length < 2) {
      wrap.innerHTML = '<p class="muted">再勾选至少一个方案即可对照。</p>';
      return;
    }
    Promise.all(compareIds.map(fetchPlan)).then(function (plans) {
      var results = plans.map(E.analyzePlan);
      function best(idx, lowerBetter) {
        var vals = results.map(function (r) { return r.stats[idx]; });
        var target = lowerBetter ? Math.min.apply(null, vals) : Math.max.apply(null, vals);
        return vals.map(function (v) { return v === target; });
      }
      var errBest = best("errorCount", true), warnBest = best("warningCount", true),
          gapBest = best("totalGap", true), overBest = best("totalOverlap", true),
          turnBest = best("turnaroundShort", true);
      var rows = [
        ["卷数", function (r) { return r.stats.reelCount; }, null],
        ["排映总时长", function (r) { return E.fmtDuration(r.stats.showDuration); }, null],
        ["错误冲突", function (r) { return r.stats.errorCount; }, errBest],
        ["警告", function (r) { return r.stats.warningCount; }, warnBest],
        ["存疑提示", function (r) { return r.stats.doubtfulCount; }, null],
        ["空档合计", function (r) { return E.fmtSigned(r.stats.totalGap, 0) + " s"; }, gapBest],
        ["重叠合计", function (r) { return E.fmtSigned(r.stats.totalOverlap, 0) + " s"; }, overBest],
        ["周转缺口", function (r) { return E.fmtSigned(r.stats.turnaroundShort, 0) + " s"; }, turnBest],
        ["机别排列", function (r) {
          return r.reels.map(function (x) { return x.projector === "A" ? "甲" : "乙"; }).join("");
        }, null],
      ];
      var html = '<table class="compare-table"><thead><tr><th>指标</th>' +
        results.map(function (r, i) { return "<th>" + esc(plans[i].name) + "</th>"; }).join("") +
        "</tr></thead><tbody>" + rows.map(function (row) {
          return "<tr><td>" + row[0] + "</td>" + results.map(function (r, i) {
            var v = row[1](r);
            var cls = "";
            if (row[2]) cls = row[2][i] ? "good" : "";
            if (typeof v === "number") {
              if (row[0] === "错误冲突" && v > 0) cls = "bad";
              if (row[0] === "警告" && v > 0 && !cls) cls = "warn";
            }
            if (row[0].indexOf("缺口") >= 0 && v !== "0 s") cls = "bad";
            if ((row[0] === "空档合计" || row[0] === "重叠合计") && v !== "0 s" && !cls) cls = "warn";
            return '<td class="' + cls + '">' + esc(v) + "</td>";
          }).join("") + "</tr>";
        }).join("") + "</tbody></table>";
      wrap.innerHTML = html;
    });
  }

  /* 导入 / 导出 */
  function exportCurrent() {
    if (!state.plan) return;
    var payload = {
      app: "changeover-desk",
      version: 1,
      exportedAt: new Date().toISOString(),
      plans: [state.plan],
    };
    downloadBlob(JSON.stringify(payload, null, 2),
      (state.plan.name || "changeover") + ".json", "application/json");
  }
  function downloadBlob(content, name, mime) {
    var blob = new Blob([content], { type: mime });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function importFile(ev) {
    var file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (e) { alert("JSON 解析失败：" + e.message); return; }
      var plans = Array.isArray(data) ? data : (data.plans || (data.reels ? [data] : null));
      if (!plans) { alert("文件格式无法识别（需要方案对象或 {plans:[...]}）。"); return; }
      plans.forEach(function (p) {
        p.id = E.uid("plan");
        (p.reels || []).forEach(function (r) { if (!r.id) r.id = E.uid("reel"); });
        if (!p.name) p.name = "导入方案 " + new Date().toLocaleString();
      });
      api("/api/plans/bulk", jsonOpts("POST", { plans: plans })).then(function (res) {
        alert("导入完成：" + res.saved.length + " 个方案，跳过 " + res.skipped + " 个。");
        if (res.saved.length) openPlan(res.saved[0]);
      }).catch(function (e) { alert("导入失败：" + e.message); });
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------ 打印换机提示单 */
  function printSheet() {
    if (!state.plan || !state.analysis) return;
    var a = state.analysis, s = a.settings;
    var rows = a.computed.map(function (c) {
      function cell(t) { return E.fmtClock(t) + "<br><span class='tc'>" + E.fmtTimecode(t, c.fps) + "</span>"; }
      var doubt = c.motor.uncertain || c.change.uncertain;
      return "<tr>" +
        "<td>" + (c.idx + 1) + "</td>" +
        '<td class="l">' + esc(c.reel.title) + (c.reel.locked ? " 🔒" : "") + "</td>" +
        "<td>" + (c.reel.projector === "A" ? "甲机" : "乙机") + "</td>" +
        "<td>" + cell(c.motorCueT) + (c.motor.uncertain ? " <b>?</b>" : "") + "</td>" +
        "<td>" + cell(c.changeCueT) + (c.change.uncertain ? " <b>?</b>" : "") + "</td>" +
        "<td>" + E.fmtSigned(c.cueLeadMin, 1) + "–" + E.fmtSigned(c.cueLeadMax, 1) + " s</td>" +
        "<td>" + cell(c.motorStart) + "</td>" +
        "<td>" + cell(c.stopTime) + "</td>" +
        "<td>" + (c.idx < a.computed.length - 1 ? cell(c.threadedFor) : "—") + "</td>" +
        '<td class="l">' + (doubt ? "<b>提示存疑，装片复核</b>" : esc(c.reel.note || "")) + "</td>" +
        "</tr>";
    }).join("");

    var errs = a.issues.filter(function (i) { return i.severity === "error"; });
    var warns = a.issues.filter(function (i) { return i.severity === "warning"; });
    $("#printSheet").innerHTML =
      "<h1>换机提示单 · " + esc(state.plan.name) + "</h1>" +
      '<div class="ps-meta">打印时间：' + new Date().toLocaleString() +
        "　默认帧率：" + s.fps + " fps　规格：" + s.gauge +
        "　回卷：" + (s.rewindMode === "serial" ? "停机后回卷" : "切换后回卷") +
        " ×" + s.rewindFactor +
        "　提示计量：" + (s.cueRef === "tail" ? "距画面末尾" : "距物理片头") + "</div>" +
      (errs.length ? '<div class="ps-warn"><b>开映前必须处理（' + errs.length + '）：</b><br>' +
        errs.map(function (i) { return "· " + esc(i.message); }).join("<br>") + "</div>" : "") +
      '<div class="ps-section-title">逐卷时刻表（上行 分:秒.十分秒 ／ 下行 时:分:秒:格）</div>' +
      "<table><thead><tr>" +
        "<th>序</th><th>卷次</th><th>机别</th><th>马达提示</th><th>切换提示</th>" +
        "<th>间隔</th><th>马达启动</th><th>停机</th><th>回卷就绪</th><th>备注</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>" +
      (warns.length ? '<div class="ps-section-title">现场留意（' + warns.length + '）</div>' +
        warns.map(function (i) { return "· " + esc(i.message) + (i.doubtful ? "（存疑）" : "") + "<br>"; }).join("") : "") +
      '<div class="ps-sign"><span>放映员</span><span>检片员</span><span>值班经理</span></div>' +
      "<style>.tc{font-size:8pt;color:#444}</style>";
    window.print();
  }

  boot();
})();
