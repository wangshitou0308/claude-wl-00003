/* ============================================================
 * rehearsal.js —— 实地排练记录
 *
 * 状态机：ready → running ⇄ paused → completed（终态不可改写，由后端强制）。
 * 新建排练时从「已保存」方案冻结卷序与目标时刻（frozen），之后方案再改
 * 不影响本次排练。放映员用可配置热键依次记录：启动下一台 / 切换画面 /
 * 停机 / 回卷就绪；漏记、重复、乱序只标出问题，不自行补录。
 * 存疑提示按时间窗口判断：落在窗口内不计超前或延误。
 * ============================================================ */
(function () {
  "use strict";
  var E = window.Engine;
  var COD = window.COD;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  var esc = COD.esc;
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  var KIND_LABEL = { start: "启动下一台", change: "切换画面", stop: "停机", ready: "回卷就绪" };
  var KIND_ORDER = { start: 0, change: 1, stop: 2, ready: 3 };
  var DEFAULT_HOTKEYS = { start: "KeyQ", change: "KeyW", stop: "KeyE", ready: "KeyR" };
  var STATUS_LABEL = {
    ready: "就绪 · 未开始",
    running: "排练中",
    paused: "已暂停",
    completed: "已完成 · 只读",
  };

  var rh = {
    list: [],          // 当前方案的排练摘要
    rec: null,         // 当前打开的完整记录
    savedPlan: null,   // 创建/改起始卷时使用的已保存方案
    raf: 0,
    captureKind: null, // 热键设置中正在捕获的动作
    compareIds: [],
    fullCache: {},     // 对比用：id -> 完整记录
  };

  /* ------------------------------------------------ 小工具 */
  function nowMs() { return Date.now(); }
  function isOpen() { return !$("#rehearsalView").hidden; }
  function hotkeys() { return (rh.rec && rh.rec.hotkeys) || DEFAULT_HOTKEYS; }

  function keyLabel(code) {
    if (!code) return "未设";
    var map = {
      Space: "空格", Enter: "回车", ArrowUp: "↑", ArrowDown: "↓",
      ArrowLeft: "←", ArrowRight: "→", ShiftLeft: "左Shift", ShiftRight: "右Shift",
    };
    if (map[code]) return map[code];
    return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "小键盘 ");
  }

  function fmtWall(ms) {
    return ms ? new Date(ms).toLocaleString() : "—";
  }

  /* ------------------------------------------------ 排练时钟
   * 计划时刻 = timeOffset + (墙钟 - 启动墙钟 - 累计暂停) / 1000
   * 暂停只累积 accumPausedMs，继续后时间基准不变。 */
  function planTime() {
    var rec = rh.rec;
    if (!rec || !rec.frozen) return 0;
    var off = rec.frozen.timeOffset || 0;
    if (rec.status === "running") {
      return off + (nowMs() - rec.startedAt - (rec.accumPausedMs || 0)) / 1000;
    }
    if (rec.status === "paused") {
      return off + ((rec.pausedAt || nowMs()) - rec.startedAt - (rec.accumPausedMs || 0)) / 1000;
    }
    if (rec.status === "completed" && rec.startedAt) {
      return off + ((rec.completedAt || nowMs()) - rec.startedAt - (rec.accumPausedMs || 0)) / 1000;
    }
    return off;
  }

  /* ------------------------------------------------ 冻结计划 */
  function mkAction(kind, c, t, label, win, cueReelId) {
    return {
      seq: -1, kind: kind, reelId: c.reel.id, reelTitle: c.reel.title,
      projector: c.reel.projector, t: t, label: label,
      window: win || null, cueReelId: cueReelId || null,
    };
  }

  function buildFrozen(plan, startReelIdx) {
    var analysis = E.analyzePlan(plan);
    var comps = analysis.computed;
    var s = analysis.settings;
    startReelIdx = clamp(startReelIdx || 0, 0, Math.max(0, comps.length - 1));
    function projName(c) { return c.reel.projector === "A" ? "甲机" : "乙机"; }

    var reels = [];
    var i, c;
    for (i = startReelIdx; i < comps.length; i++) {
      c = comps[i];
      reels.push({
        id: c.reel.id, title: c.reel.title, projector: c.reel.projector, order: i,
        pictureStart: c.pictureStart, picSec: c.picSec,
        motorStart: c.motorStart, changeCueT: c.changeCueT, stopTime: c.stopTime,
        threadedFor: i < comps.length - 1 ? c.threadedFor : null,
      });
    }

    var actions = [];
    for (i = startReelIdx; i < comps.length; i++) {
      c = comps[i];
      var prev = comps[i - 1] || null;
      if (i === startReelIdx) {
        actions.push(mkAction("start", c, c.motorStart,
          "手动启动" + projName(c) + "《" + c.reel.title + "》", null, null));
      } else {
        // 启动下一台：听上一卷马达提示；存疑时按提示范围给时间窗口
        var mw = prev.motor.uncertain ? [prev.motorCueMin, prev.motorCueMax] : null;
        actions.push(mkAction("start", c, prev.motorCueT,
          "启动" + projName(c) + "《" + c.reel.title + "》（听《" + prev.reel.title + "》马达提示）",
          mw, prev.reel.id));
      }
      var cw = c.change.uncertain ? [c.changeCueMin, c.changeCueMax] : null;
      actions.push(mkAction("change", c, c.changeCueT,
        i === comps.length - 1
          ? "终场切灯（《" + c.reel.title + "》切换提示）"
          : "切到" + projName(comps[i + 1]) + "《" + comps[i + 1].reel.title + "》",
        cw, null));
      // 停机 / 回卷就绪由切换提示推出，切换存疑则窗口同步平移
      var sw = c.change.uncertain
        ? [c.stopTime + (c.changeCueMin - c.changeCueT), c.stopTime + (c.changeCueMax - c.changeCueT)]
        : null;
      actions.push(mkAction("stop", c, c.stopTime,
        "停" + projName(c) + "《" + c.reel.title + "》", sw, null));
      if (i < comps.length - 1) {
        var rw = c.change.uncertain
          ? [c.threadedFor + (c.changeCueMin - c.changeCueT), c.threadedFor + (c.changeCueMax - c.changeCueT)]
          : null;
        actions.push(mkAction("ready", c, c.threadedFor,
          projName(c) + " 回卷挂片就绪（《" + c.reel.title + "》之后）", rw, null));
      }
    }
    actions.sort(function (a, b) {
      return a.t - b.t || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    });
    actions.forEach(function (a, idx) { a.seq = idx; });

    return {
      planId: plan.id,
      planName: plan.name,
      planUpdatedAt: plan.updatedAt || null,
      frozenAt: nowMs(),
      settings: {
        fps: s.fps, gapToleranceSec: s.gapToleranceSec,
        tailRunoffSec: s.tailRunoffSec, cueRef: s.cueRef,
      },
      startReelIdx: startReelIdx,
      timeOffset: comps.length ? comps[startReelIdx].motorStart : 0,
      showEnd: actions.length ? actions[actions.length - 1].t : 0,
      reels: reels,
      actions: actions,
    };
  }

  /* ------------------------------------------------ 匹配与偏差 */
  function matchedSeqs(rec) {
    var out = {};
    (rec.marks || []).forEach(function (m) {
      if (m.matchedSeq != null) out[m.matchedSeq] = m;
    });
    return out;
  }
  function actionBySeq(rec, seq) {
    return rec.frozen.actions.filter(function (a) { return a.seq === seq; })[0] || null;
  }
  function nextAction(rec) {
    var matched = matchedSeqs(rec);
    return rec.frozen.actions.filter(function (a) { return !matched[a.seq]; })[0] || null;
  }
  function nextActionOfKind(rec, kind) {
    var matched = matchedSeqs(rec);
    return rec.frozen.actions.filter(function (a) {
      return a.kind === kind && !matched[a.seq];
    })[0] || null;
  }

  /* 存疑窗口：窗口内不算超前或延误；出窗按最近窗沿计偏差 */
  function evalDeviation(action, t) {
    var w = action.window;
    if (w && w.length === 2) {
      if (t >= w[0] && t <= w[1]) return { dev: 0, inWindow: true };
      if (t < w[0]) return { dev: t - w[0], inWindow: false };
      return { dev: t - w[1], inWindow: false };
    }
    return { dev: t - action.t, inWindow: false };
  }

  function devText(dev, inWindow) {
    if (inWindow) return "窗口内";
    if (dev == null) return "—";
    var a = Math.abs(dev);
    if (a < 0.05) return "准点";
    return (dev > 0 ? "延误 " : "超前 ") + a.toFixed(1) + "″";
  }
  function devShort(dev, inWindow) {
    if (inWindow) return "0(窗)";
    if (dev == null) return "—";
    return (dev > 0 ? "+" : "−") + Math.abs(dev).toFixed(1);
  }
  function devClass(dev, inWindow) {
    if (inWindow) return "dev-ok";
    var a = Math.abs(dev == null ? 0 : dev);
    if (a <= 1) return "dev-ok";
    if (a <= 3) return "dev-warn";
    return "dev-bad";
  }

  /* 漏记/重复/乱序：只标出问题，不自行补录 */
  function liveFlags(rec) {
    var matched = matchedSeqs(rec);
    var maxMatched = -1;
    (rec.marks || []).forEach(function (m) {
      if (m.matchedSeq != null && m.matchedSeq > maxMatched) maxMatched = m.matchedSeq;
    });
    var missed = rec.frozen.actions.filter(function (a) {
      // 完成后全部未记动作算漏记；进行中只把「已被后续记录越过」的标为疑漏记
      return !matched[a.seq] && (rec.status === "completed" || a.seq < maxMatched);
    });
    var dup = 0, ooo = 0;
    (rec.marks || []).forEach(function (m) {
      if (m.flags.indexOf("duplicate") >= 0) dup++;
      if (m.flags.indexOf("out-of-order") >= 0) ooo++;
    });
    return { missed: missed, dup: dup, ooo: ooo };
  }

  function recStats(rec) {
    var devs = (rec.marks || []).filter(function (m) { return m.dev != null; })
      .map(function (m) { return Math.abs(m.dev); });
    var fl = liveFlags(rec);
    return {
      matched: devs.length,
      meanAbs: devs.length ? devs.reduce(function (a, b) { return a + b; }, 0) / devs.length : null,
      maxAbs: devs.length ? Math.max.apply(null, devs) : null,
      missed: fl.missed.length, dup: fl.dup, ooo: fl.ooo,
    };
  }

  /* ------------------------------------------------ 记录操作 */
  function recordMark(kind) {
    var rec = rh.rec;
    if (!rec || rec.status !== "running") return;
    var t = planTime();
    var matched = matchedSeqs(rec);
    var action = null;
    for (var i = 0; i < rec.frozen.actions.length; i++) {
      var a = rec.frozen.actions[i];
      if (a.kind === kind && !matched[a.seq]) { action = a; break; }
    }
    var flags = [];
    var mark = {
      id: E.uid("mark"), kind: kind, t: t, wallMs: nowMs(),
      matchedSeq: null, reelId: null, plannedT: null,
      dev: null, inWindow: false, flags: flags,
    };
    if (!action) {
      flags.push("duplicate"); // 该类动作已全部记录，疑重复
    } else {
      var skipped = rec.frozen.actions.some(function (a) {
        return a.seq < action.seq && !matched[a.seq];
      });
      if (skipped) flags.push("out-of-order"); // 前面还有未记录动作
      var ev = evalDeviation(action, t);
      mark.matchedSeq = action.seq;
      mark.reelId = action.reelId;
      mark.plannedT = action.t;
      mark.dev = ev.dev;
      mark.inWindow = ev.inWindow;
    }
    rec.marks.push(mark);
    saveRec();
    renderAll();
  }

  function undoMark() {
    var rec = rh.rec;
    if (!rec || (rec.status !== "running" && rec.status !== "paused")) return;
    if (!rec.marks.length) return;
    rec.marks.pop();
    saveRec();
    renderAll();
  }

  function startRehearsal() {
    var rec = rh.rec;
    if (!rec || rec.status !== "ready") return;
    if (!rec.frozen.actions.length) { alert("方案没有可排练的动作，请先在方案中添加胶片卷。"); return; }
    rec.status = "running";
    rec.startedAt = nowMs();
    rec.accumPausedMs = 0;
    rec.pausedAt = null;
    saveRec();
    renderAll();
  }

  function togglePause() {
    var rec = rh.rec;
    if (!rec) return;
    if (rec.status === "running") {
      rec.status = "paused";
      rec.pausedAt = nowMs();
    } else if (rec.status === "paused") {
      // 继续：暂停时长并入累计，时间基准不变
      rec.accumPausedMs = (rec.accumPausedMs || 0) + (nowMs() - (rec.pausedAt || nowMs()));
      rec.pausedAt = null;
      rec.status = "running";
    } else {
      return;
    }
    saveRec();
    renderAll();
  }

  function completeRehearsal() {
    var rec = rh.rec;
    if (!rec || (rec.status !== "running" && rec.status !== "paused")) return;
    var st = recStats(rec);
    var msg = "完成排练？完成后记录不可改写。\n\n已记录 " + rec.marks.length +
      " 笔，漏记 " + (rec.frozen.actions.length - Object.keys(matchedSeqs(rec)).length) +
      " 项，重复 " + st.dup + " 笔，乱序 " + st.ooo + " 笔。";
    if (!confirm(msg)) return;
    if (rec.status === "paused") {
      rec.accumPausedMs = (rec.accumPausedMs || 0) + (nowMs() - (rec.pausedAt || nowMs()));
      rec.pausedAt = null;
    }
    rec.status = "completed";
    rec.completedAt = nowMs();
    var matched = matchedSeqs(rec);
    var missed = rec.frozen.actions.filter(function (a) { return !matched[a.seq]; })
      .map(function (a) {
        return { seq: a.seq, kind: a.kind, reelId: a.reelId, label: a.label, t: a.t };
      });
    rec.flags = {
      missedCount: missed.length,
      duplicateCount: st.dup,
      outOfOrderCount: st.ooo,
      missed: missed,
    };
    saveRec();
    renderAll();
  }

  /* ------------------------------------------------ 与后端同步 */
  function saveRec() {
    if (!rh.rec) return;
    COD.api("/api/rehearsals/" + rh.rec.id, COD.jsonOpts("PUT", rh.rec))
      .then(function (saved) {
        rh.rec.createdAt = saved.createdAt;
        rh.rec.updatedAt = saved.updatedAt;
        refreshListRow(saved);
      })
      .catch(function (err) {
        alert("排练记录保存失败：" + err.message);
        loadRehearsal(rh.rec.id); // 可能被服务端拒绝（如已完成），重新拉取对齐
      });
  }

  function refreshListRow(saved) {
    for (var i = 0; i < rh.list.length; i++) {
      if (rh.list[i].id === saved.id) {
        rh.list[i].name = saved.name;
        rh.list[i].status = saved.status;
        rh.list[i].markCount = (saved.marks || []).length;
        rh.list[i].updatedAt = saved.updatedAt;
        break;
      }
    }
    renderSelect();
  }

  function loadList(selectId) {
    var plan = COD.getPlan();
    if (!plan) return Promise.resolve();
    return COD.api("/api/rehearsals?planId=" + encodeURIComponent(plan.id))
      .then(function (list) {
        rh.list = list;
        if (!list.length) return createRehearsal(0); // 首次打开自动建一条 ready 记录
        var id = selectId || (rh.rec && rh.rec.id);
        if (!id || !list.some(function (r) { return r.id === id; })) id = list[list.length - 1].id;
        return loadRehearsal(id);
      })
      .catch(function (err) { alert("读取排练记录失败：" + err.message); });
  }

  function loadRehearsal(id) {
    return COD.api("/api/rehearsals/" + encodeURIComponent(id)).then(function (rec) {
      rh.rec = rec;
      rh.fullCache[rec.id] = rec;
      rh.savedPlan = null; // ready 状态下改起始卷时重新拉取
      renderAll();
    });
  }

  function createRehearsal(startReelIdx) {
    var plan = COD.getPlan();
    if (!plan) return Promise.resolve();
    // 冻结以「已保存」方案为准：先落盘再重新读取
    return COD.flushSave()
      .then(function () { return COD.api("/api/plans/" + plan.id); })
      .then(function (saved) {
        rh.savedPlan = saved;
        if (!saved.reels.length) {
          alert("方案还没有胶片卷，无法开始排练。");
          renderAll();
          return null;
        }
        var frozen = buildFrozen(saved, startReelIdx || 0);
        var rec = {
          id: E.uid("reh"),
          planId: saved.id,
          name: "排练 " + new Date().toLocaleString(),
          status: "ready",
          startReelIdx: frozen.startReelIdx,
          hotkeys: Object.assign({}, DEFAULT_HOTKEYS),
          frozen: frozen,
          startedAt: null, accumPausedMs: 0, pausedAt: null, completedAt: null,
          marks: [], flags: {},
        };
        return COD.api("/api/rehearsals", COD.jsonOpts("POST", rec));
      })
      .then(function (saved) {
        if (!saved) return;
        return loadList(saved.id);
      });
  }

  function deleteRehearsal() {
    var rec = rh.rec;
    if (!rec) return;
    if (rec.status === "completed") { alert("已完成的排练记录不可删除。"); return; }
    if (!confirm("删除本次排练记录「" + rec.name + "」？此操作不可恢复。")) return;
    COD.api("/api/rehearsals/" + rec.id, { method: "DELETE" })
      .then(function () { rh.rec = null; return loadList(); })
      .catch(function (err) { alert(err.message); });
  }

  /* ------------------------------------------------ 视图开关 */
  function openView() {
    if (!COD.getPlan()) return;
    document.body.classList.add("rehearsal-open");
    $("#rehearsalView").hidden = false;
    loadList();
  }
  function closeView() {
    document.body.classList.remove("rehearsal-open");
    $("#rehearsalView").hidden = true;
    stopTick();
    rh.rec = null;
  }

  /* ------------------------------------------------ 渲染：总 */
  function renderAll() {
    if (!isOpen()) return;
    renderSelect();
    if (!rh.rec) {
      $("#rhStatus").textContent = "—";
      $("#rhStatus").className = "rh-status";
      return;
    }
    renderStatus();
    renderSetup();
    renderNext();
    renderLastDev();
    renderFlags();
    renderTable();
    renderTimeline();
    renderHotkeyKeys();
    ensureTick();
  }

  function renderSelect() {
    var sel = $("#rhSelect");
    sel.innerHTML = rh.list.map(function (r) {
      return '<option value="' + esc(r.id) + '"' +
        (rh.rec && r.id === rh.rec.id ? " selected" : "") + ">" +
        esc(r.name) + "（" + (STATUS_LABEL[r.status] || r.status).split(" ")[0] + "）" +
        "</option>";
    }).join("");
  }

  function renderStatus() {
    var rec = rh.rec;
    var st = $("#rhStatus");
    st.textContent = STATUS_LABEL[rec.status] || rec.status;
    st.className = "rh-status " + rec.status;
    var ready = rec.status === "ready";
    var running = rec.status === "running";
    var paused = rec.status === "paused";
    var completed = rec.status === "completed";
    $("#rhName").value = rec.name;
    $("#rhName").disabled = completed;
    $("#rhStart").hidden = !ready;
    $("#rhPause").hidden = !(running || paused);
    $("#rhPause").textContent = paused ? "▶ 继续" : "⏸ 暂停";
    $("#rhUndo").hidden = !(running || paused);
    $("#rhComplete").hidden = !(running || paused);
    $("#rhSetup").style.display = ready ? "" : "none";
    $("#rhDelete").style.display = completed ? "none" : "";
    $$(".rh-rec").forEach(function (b) { b.disabled = !running; });
    var sub = {
      ready: "尚未开始 · 目标 " + rec.frozen.actions.length + " 个动作",
      running: "已进行 " + E.fmtDuration(Math.max(0, planTime() - rec.frozen.timeOffset)) +
        " · 暂停累计 " + E.fmtDuration((rec.accumPausedMs || 0) / 1000),
      paused: "已暂停 · 继续后时间基准不变",
      completed: "已完成 " + fmtWall(rec.completedAt) + " · 记录已封存",
    };
    $("#rhClockSub").textContent = sub[rec.status] || "";
    $("#rhClock").textContent = E.fmtClock(planTime());
  }

  function renderSetup() {
    var rec = rh.rec;
    if (rec.status !== "ready") return;
    var plan = COD.getPlan();
    var sel = $("#rhStartReel");
    var reels = (rh.savedPlan && rh.savedPlan.reels) || (plan ? plan.reels : []);
    sel.innerHTML = reels.map(function (r, i) {
      return '<option value="' + i + '"' + (i === rec.startReelIdx ? " selected" : "") + ">" +
        (i === 0 ? "从片头开始" : "从第 " + (i + 1) + " 卷开始（" + esc(r.title || ("第 " + (i + 1) + " 卷")) + "）") +
        "</option>";
    }).join("");
  }

  function renderNext() {
    var rec = rh.rec;
    var na = nextAction(rec);
    $("#rhNextAction").textContent = na ? na.label
      : (rec.status === "completed" ? "排练已完成" : "全部动作已记录");
    ["start", "change", "stop", "ready"].forEach(function (k) {
      var a = nextActionOfKind(rec, k);
      var el = $('[data-rh-next="' + k + '"]');
      el.textContent = a ? E.fmtClock(a.t) + " · " + a.reelTitle : "已全部记录";
    });
  }

  function renderLastDev() {
    var rec = rh.rec;
    var last = null;
    (rec.marks || []).forEach(function (m) { if (m.matchedSeq != null) last = m; });
    var box = $("#rhLastDev");
    if (!last) { box.textContent = "—"; return; }
    var a = actionBySeq(rec, last.matchedSeq);
    box.innerHTML = '<span class="' + devClass(last.dev, last.inWindow) + '">' +
      devText(last.dev, last.inWindow) + "</span>" +
      '<div class="rh-card-sub">' + esc(a ? a.label : "") + "</div>";
  }

  function renderFlags() {
    var rec = rh.rec;
    var fl = liveFlags(rec);
    var chips = [];
    if (fl.missed.length) {
      chips.push('<span class="flag-chip flag-missed">' +
        (rec.status === "completed" ? "漏记 " : "疑漏记 ") + fl.missed.length + " 项</span>");
    }
    if (fl.dup) chips.push('<span class="flag-chip flag-dup">重复 ' + fl.dup + " 笔</span>");
    if (fl.ooo) chips.push('<span class="flag-chip flag-ooo">乱序 ' + fl.ooo + " 笔</span>");
    $("#rhFlags").innerHTML = chips.length
      ? '<div class="rh-flags-title">问题标记（只提示，不补录）</div>' + chips.join("")
      : '<span class="rh-flags-ok">记录未见异常</span>';
  }

  /* ------------------------------------------------ 渲染：复盘表 */
  function renderTable() {
    var rec = rh.rec;
    var matched = matchedSeqs(rec);
    var fl = liveFlags(rec);
    var missedSeqs = {};
    fl.missed.forEach(function (a) { missedSeqs[a.seq] = true; });
    var rows = rec.frozen.actions.map(function (a, i) {
      var m = matched[a.seq];
      var missed = !!missedSeqs[a.seq];
      var problems = [];
      if (m) {
        if (m.flags.indexOf("out-of-order") >= 0)
          problems.push('<span class="flag-chip flag-ooo">乱序</span>');
        if (m.inWindow)
          problems.push('<span class="flag-chip flag-window">存疑窗口内</span>');
      } else if (missed) {
        problems.push('<span class="flag-chip flag-missed">' +
          (rec.status === "completed" ? "漏记" : "疑漏记") + "</span>");
      }
      var win = a.window
        ? '<div class="rh-win">窗口 ' + E.fmtClock(a.window[0]) + "～" + E.fmtClock(a.window[1]) + "</div>"
        : "";
      return '<tr class="' + (missed ? "rh-row-missed" : "") + '">' +
        "<td>" + (i + 1) + "</td>" +
        "<td>" + KIND_LABEL[a.kind] + "</td>" +
        "<td>" + esc(a.reelTitle) + (a.cueReelId ? '<div class="rh-win">信号来自上一卷</div>' : "") + "</td>" +
        '<td class="num">' + E.fmtClock(a.t) + win + "</td>" +
        '<td class="num">' + (m ? E.fmtClock(m.t) : "—") + "</td>" +
        '<td class="num ' + (m ? devClass(m.dev, m.inWindow) : (missed ? "dev-bad" : "")) + '">' +
          (m ? devText(m.dev, m.inWindow) : (missed ? "漏记" : "—")) + "</td>" +
        "<td>" + problems.join("") + "</td>" +
        "</tr>";
    });
    (rec.marks || []).forEach(function (m) {
      if (m.matchedSeq != null) return;
      rows.push('<tr class="rh-row-dup"><td>—</td><td>' + KIND_LABEL[m.kind] + "</td>" +
        "<td>（无对应计划动作）</td>" + '<td class="num">—</td>' +
        '<td class="num">' + E.fmtClock(m.t) + "</td>" + '<td class="num">—</td>' +
        '<td><span class="flag-chip flag-dup">重复</span></td></tr>');
    });
    $("#rhTable").innerHTML =
      "<thead><tr><th>序</th><th>动作</th><th>关联卷</th><th>计划时刻</th>" +
      "<th>实际时刻</th><th>偏差</th><th>问题</th></tr></thead><tbody>" +
      rows.join("") + "</tbody>";
  }

  /* ------------------------------------------------ 渲染：时间轴 */
  var RH_GEO = { rulerH: 22, unmatchedH: 26, rowH: 36, labelW: 150, padSec: 12 };
  var tl = { px: 10, t0: 0 };

  function rhBounds() {
    var f = rh.rec.frozen;
    return {
      t0: f.timeOffset - RH_GEO.padSec,
      t1: Math.max(f.showEnd + RH_GEO.padSec, f.timeOffset + 60),
    };
  }
  function rhX(t) { return RH_GEO.labelW + (t - tl.t0) * tl.px; }

  function shapeSvg(kind, x, y, size, color, filled) {
    var fill = filled ? color : "none";
    var stroke = 'stroke="' + color + '" stroke-width="1.4"';
    if (kind === "start") {
      return '<polygon points="' + x + "," + (y - size) + " " + (x - size) + "," + (y + size) +
        " " + (x + size) + "," + (y + size) + '" fill="' + fill + '" ' + stroke + "/>";
    }
    if (kind === "change") {
      return '<polygon points="' + x + "," + (y + size) + " " + (x - size) + "," + (y - size) +
        " " + (x + size) + "," + (y - size) + '" fill="' + fill + '" ' + stroke + "/>";
    }
    if (kind === "stop") {
      return '<rect x="' + (x - size * 0.8) + '" y="' + (y - size * 0.8) + '" width="' + size * 1.6 +
        '" height="' + size * 1.6 + '" fill="' + fill + '" ' + stroke + "/>";
    }
    return '<circle cx="' + x + '" cy="' + y + '" r="' + size * 0.85 + '" fill="' + fill + '" ' + stroke + "/>";
  }
  var KIND_COLOR = { start: "#e8a33d", change: "#e05d5d", stop: "#4fc3b0", ready: "#6aa6e0" };

  function renderTimeline() {
    var rec = rh.rec;
    var svg = $("#rhTimeline");
    var scrollEl = $("#rhTimelineScroll");
    if (!rec) { svg.innerHTML = ""; return; }
    var f = rec.frozen;
    var b = rhBounds();
    tl.t0 = b.t0;
    var avail = Math.max(300, scrollEl.clientWidth - RH_GEO.labelW - 24);
    tl.px = clamp(avail / (b.t1 - b.t0), 1.2, 100);
    var W = Math.max(scrollEl.clientWidth, RH_GEO.labelW + (b.t1 - b.t0) * tl.px + 16);
    var rows = f.reels;
    var top = RH_GEO.rulerH + RH_GEO.unmatchedH;
    var H = top + rows.length * RH_GEO.rowH + 14;
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    var html = [];
    html.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#14161a"/>');

    // 刻度
    var steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    var step = 3600;
    for (var si = 0; si < steps.length; si++) {
      if (steps[si] * tl.px >= 110) { step = steps[si]; break; }
    }
    for (var k = Math.floor(b.t0 / step); k <= Math.ceil(b.t1 / step); k++) {
      var tx = rhX(k * step);
      html.push('<line x1="' + tx + '" y1="' + RH_GEO.rulerH + '" x2="' + tx + '" y2="' + H +
        '" stroke="#24282f" stroke-width="1"/>');
      html.push('<text x="' + (tx + 4) + '" y="' + (RH_GEO.rulerH - 7) +
        '" fill="#7b828c" font-size="10" font-variant-numeric="tabular-nums">' +
        E.fmtClock(k * step, step >= 60) + "</text>");
    }

    // 未匹配实录道
    var umY = RH_GEO.rulerH + RH_GEO.unmatchedH / 2;
    html.push('<text x="8" y="' + (umY + 3) + '" fill="#6b7280" font-size="9.5">未匹配实录</text>');
    html.push('<line x1="' + RH_GEO.labelW + '" y1="' + (RH_GEO.rulerH + RH_GEO.unmatchedH) +
      '" x2="' + W + '" y2="' + (RH_GEO.rulerH + RH_GEO.unmatchedH) + '" stroke="#23272f"/>');

    var matched = matchedSeqs(rec);

    // 每卷一行
    rows.forEach(function (reel, ri) {
      var y = top + ri * RH_GEO.rowH + RH_GEO.rowH / 2;
      if (ri % 2 === 0) {
        html.push('<rect x="0" y="' + (y - RH_GEO.rowH / 2) + '" width="' + W +
          '" height="' + RH_GEO.rowH + '" fill="rgba(255,255,255,.015)"/>');
      }
      var projCol = reel.projector === "A" ? "#5b9bd5" : "#d88c5b";
      html.push('<text x="8" y="' + (y + 3) + '" fill="' + projCol +
        '" font-size="10.5" font-weight="600">' + esc(reel.order + 1 + " · " +
        (reel.projector === "A" ? "甲" : "乙") + " " + reel.title) + "</text>");
      // 画面段
      html.push('<rect x="' + rhX(reel.pictureStart) + '" y="' + (y - 7) + '" width="' +
        Math.max(2, reel.picSec * tl.px) + '" height="14" fill="rgba(79,195,176,.16)" rx="2"/>');
      // 存疑窗口
      f.actions.forEach(function (a) {
        if (a.reelId !== reel.id || !a.window) return;
        html.push('<rect x="' + rhX(a.window[0]) + '" y="' + (y - 9) + '" width="' +
          Math.max(2, (a.window[1] - a.window[0]) * tl.px) + '" height="18" rx="2"' +
          ' fill="rgba(216,180,74,.13)" stroke="#6b5a23" stroke-width="0.7" stroke-dasharray="3 2"/>');
      });
      // 计划动作（空心）
      f.actions.forEach(function (a) {
        if (a.reelId !== reel.id) return;
        var done = !!matched[a.seq];
        html.push(shapeSvg(a.kind, rhX(a.t), y, 5.5,
          done ? "#4a5160" : KIND_COLOR[a.kind], false));
      });
    });

    // 实录标记（实心）+ 与计划的连线
    (rec.marks || []).forEach(function (m) {
      if (m.matchedSeq == null) {
        html.push(shapeSvg(m.kind, rhX(m.t), umY, 5, "#e05d5d", true));
        html.push('<line x1="' + (rhX(m.t) - 4) + '" y1="' + (umY - 4) + '" x2="' + (rhX(m.t) + 4) +
          '" y2="' + (umY + 4) + '" stroke="#e05d5d" stroke-width="1.4"/>');
        return;
      }
      var a = actionBySeq(rec, m.matchedSeq);
      if (!a) return;
      var ri = -1;
      for (var j = 0; j < rows.length; j++) if (rows[j].id === a.reelId) ri = j;
      if (ri < 0) return;
      var y = top + ri * RH_GEO.rowH + RH_GEO.rowH / 2;
      var col = m.inWindow ? "#4fc3b0"
        : Math.abs(m.dev) <= 1 ? "#4fc3b0" : Math.abs(m.dev) <= 3 ? "#e8a33d" : "#e05d5d";
      if (Math.abs(m.t - a.t) > 0.05) {
        html.push('<line x1="' + rhX(a.t) + '" y1="' + y + '" x2="' + rhX(m.t) + '" y2="' + y +
          '" stroke="' + col + '" stroke-width="1.2" stroke-dasharray="3 2" opacity="0.8"/>');
      }
      html.push(shapeSvg(m.kind, rhX(m.t), y, 5.5, col, true));
    });

    // 图例
    var lx = RH_GEO.labelW + 6;
    ["start", "change", "stop", "ready"].forEach(function (kind) {
      html.push(shapeSvg(kind, lx, 11, 5, KIND_COLOR[kind], false));
      html.push('<text x="' + (lx + 9) + '" y="14" fill="#9aa2ad" font-size="9.5">' +
        KIND_LABEL[kind] + "</text>");
      lx += 9 + KIND_LABEL[kind].length * 9.5 + 18;
    });
    html.push('<text x="' + (lx + 4) + '" y="14" fill="#6b7280" font-size="9.5">' +
      "空心=计划 实心=实录 黄框=存疑窗口</text>");

    // 播放头层
    html.push('<g id="rhPlayhead"><line x1="0" y1="2" x2="0" y2="' + (H - 2) +
      '" stroke="#e8a33d" stroke-width="1.6"/>' +
      '<polygon points="0,2 -5,-6 5,-6" fill="#e8a33d" transform="translate(0,8)"/>' +
      '<text id="rhPlayheadTag" x="0" y="10" fill="#e8a33d" font-size="9.5" ' +
      'font-weight="700" text-anchor="middle"></text></g>');

    svg.innerHTML = html.join("");
    updatePlayhead(planTime());
  }

  function updatePlayhead(t) {
    var g = $("#rhPlayhead");
    if (!g) return;
    g.setAttribute("transform", "translate(" + rhX(t) + ",0)");
    var tag = $("#rhPlayheadTag");
    if (tag) tag.textContent = E.fmtClock(t);
    // 自动跟随
    var scrollEl = $("#rhTimelineScroll");
    var x = rhX(t);
    if (rh.rec && rh.rec.status === "running") {
      if (x - scrollEl.scrollLeft > scrollEl.clientWidth * 0.78 ||
          x < scrollEl.scrollLeft + RH_GEO.labelW + 10) {
        scrollEl.scrollLeft = Math.max(0, x - scrollEl.clientWidth * 0.3);
      }
    }
  }

  /* ------------------------------------------------ 时钟节拍 */
  function ensureTick() {
    stopTick();
    if (isOpen() && rh.rec && rh.rec.status === "running") {
      rh.raf = requestAnimationFrame(tick);
    }
  }
  function stopTick() {
    cancelAnimationFrame(rh.raf);
    rh.raf = 0;
  }
  function tick() {
    if (!isOpen() || !rh.rec) return;
    var t = planTime();
    $("#rhClock").textContent = E.fmtClock(t);
    var rec = rh.rec;
    if (rec.status === "running") {
      $("#rhClockSub").textContent =
        "已进行 " + E.fmtDuration(Math.max(0, t - rec.frozen.timeOffset)) +
        " · 暂停累计 " + E.fmtDuration((rec.accumPausedMs || 0) / 1000);
    }
    var cd = $("#rhCountdown");
    var na = nextAction(rec);
    if (na && rec.status !== "completed") {
      var d = na.t - t;
      cd.textContent = d >= 0
        ? "倒计时 " + d.toFixed(1) + " 秒（计划 " + E.fmtClock(na.t) + "）"
        : "已过 " + (-d).toFixed(1) + " 秒仍未记录";
      cd.classList.toggle("overdue", d < 0);
    } else {
      cd.textContent = "";
      cd.classList.remove("overdue");
    }
    updatePlayhead(t);
    if (rec.status === "running") rh.raf = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------ 热键 */
  function renderHotkeyKeys() {
    var hk = hotkeys();
    ["start", "change", "stop", "ready"].forEach(function (k) {
      $('[data-rh-key="' + k + '"]').textContent = keyLabel(hk[k]);
    });
  }

  function openHotkeyModal() {
    if (!rh.rec) return;
    renderHotkeyModal();
    $("#rhHotkeyModal").hidden = false;
  }
  function renderHotkeyModal() {
    var hk = hotkeys();
    $("#rhHotkeyList").innerHTML = ["start", "change", "stop", "ready"].map(function (k) {
      var cap = rh.captureKind === k;
      return '<div class="rh-hk-row"><span class="rh-hk-label">' + KIND_LABEL[k] + "</span>" +
        '<button class="btn btn-sm rh-hk-key' + (cap ? " capturing" : "") +
        '" data-hk="' + k + '">' + (cap ? "请按键…" : keyLabel(hk[k])) + "</button></div>";
    }).join("");
    $$("#rhHotkeyList [data-hk]").forEach(function (b) {
      b.onclick = function () {
        rh.captureKind = b.getAttribute("data-hk");
        renderHotkeyModal();
      };
    });
  }
  function setHotkey(kind, code) {
    if (!code || code === "Escape") return;
    var hk = Object.assign({}, hotkeys());
    for (var k in hk) {
      if (k !== kind && hk[k] === code) {
        alert("该键已分配给「" + KIND_LABEL[k] + "」，请另选一键。");
        return;
      }
    }
    hk[kind] = code;
    rh.rec.hotkeys = hk;
    saveRec();
    renderHotkeyKeys();
  }

  /* ------------------------------------------------ 对比 */
  function fetchRehearsal(id) {
    if (rh.fullCache[id]) return Promise.resolve(rh.fullCache[id]);
    return COD.api("/api/rehearsals/" + encodeURIComponent(id)).then(function (rec) {
      rh.fullCache[id] = rec;
      return rec;
    });
  }

  function openCompare() {
    if (!rh.rec) return;
    if (!rh.compareIds.length && rh.rec) rh.compareIds = [rh.rec.id];
    $("#rhComparePick").innerHTML = rh.list.map(function (r) {
      var on = rh.compareIds.indexOf(r.id) >= 0;
      return '<label class="' + (on ? "on" : "") + '"><input type="checkbox" value="' +
        esc(r.id) + '"' + (on ? " checked" : "") + ">" + esc(r.name) +
        '<span class="rh-pick-sub">' + (STATUS_LABEL[r.status] || r.status).split(" ")[0] +
        " · " + r.markCount + " 笔</span></label>";
    }).join("");
    $$("#rhComparePick input").forEach(function (cb) {
      cb.onchange = function () {
        rh.compareIds = $$("#rhComparePick input:checked").map(function (x) { return x.value; });
        cb.closest("label").classList.toggle("on", cb.checked);
        renderCompareTable();
      };
    });
    $("#rhCompareModal").hidden = false;
    renderCompareTable();
  }

  function actionCell(rec, reelId, kind) {
    var action = rec.frozen.actions.filter(function (a) {
      return a.reelId === reelId && a.kind === kind;
    })[0];
    if (!action) return null;
    var mark = (rec.marks || []).filter(function (m) { return m.matchedSeq === action.seq; })[0];
    // 只有已完成的排练才把未记录动作定性为漏记；进行中/未开始的记为待录
    if (!mark) return rec.status === "completed" ? { missed: true } : { pending: true };
    return { dev: mark.dev, inWindow: mark.inWindow };
  }

  function renderCompareTable() {
    var wrap = $("#rhCompareWrap");
    if (rh.compareIds.length < 2) {
      wrap.innerHTML = '<p class="muted">再勾选至少一次排练即可对照。</p>';
      return;
    }
    Promise.all(rh.compareIds.map(fetchRehearsal)).then(function (recs) {
      var base = recs[0].frozen;
      var rows = [];
      // 按动作
      base.reels.forEach(function (reel) {
        ["start", "change", "stop", "ready"].forEach(function (kind) {
          var cells = recs.map(function (rec) { return actionCell(rec, reel.id, kind); });
          if (cells.every(function (c) { return !c; })) return;
          rows.push({ label: esc(reel.title) + " · " + KIND_LABEL[kind], cells: cells, trans: false });
        });
      });
      // 按衔接
      for (var i = 0; i < base.reels.length - 1; i++) {
        var from = base.reels[i], to = base.reels[i + 1];
        var tcells = recs.map(function (rec) {
          var st = actionCell(rec, to.id, "start");
          var ch = actionCell(rec, from.id, "change");
          if (!st && !ch) return null;
          return { pair: { start: st, change: ch } };
        });
        if (tcells.every(function (c) { return !c; })) continue;
        rows.push({ label: "衔接 " + esc(from.title) + " → " + esc(to.title), cells: tcells, trans: true });
      }

      function cellVal(c) {
        if (!c) return null;
        if (c.pair) {
          var v = 0, any = false;
          ["start", "change"].forEach(function (k) {
            var p = c.pair[k];
            if (p && !p.missed && p.dev != null) { v += Math.abs(p.dev); any = true; }
          });
          return any ? v : null;
        }
        if (c.missed || c.dev == null) return null;
        return Math.abs(c.dev);
      }
      function cellHtml(c, isBest) {
        if (!c) return "<td>—</td>";
        if (c.pair) {
          var s = c.pair.start, ch = c.pair.change;
          var txt = "启 " + (s ? (s.missed ? "漏" : s.pending ? "·" : devShort(s.dev, s.inWindow)) : "—") +
            " · 切 " + (ch ? (ch.missed ? "漏" : ch.pending ? "·" : devShort(ch.dev, ch.inWindow)) : "—");
          var bad = (s && s.missed) || (ch && ch.missed);
          return '<td class="' + (bad ? "bad" : isBest ? "good" : "") + '">' + txt + "</td>";
        }
        if (c.missed) return '<td class="bad">漏记</td>';
        if (c.pending) return "<td>—</td>";
        return '<td class="' + (isBest ? "good " : "") + devClass(c.dev, c.inWindow) + '">' +
          devText(c.dev, c.inWindow) + "</td>";
      }

      var html = '<table class="compare-table"><thead><tr><th>动作 / 衔接</th>' +
        recs.map(function (r) {
          return "<th>" + esc(r.name) + '<br><span class="rh-th-sub">' +
            (STATUS_LABEL[r.status] || r.status).split(" ")[0] + "</span></th>";
        }).join("") + "</tr></thead><tbody>";

      rows.forEach(function (row) {
        var vals = row.cells.map(cellVal);
        var best = null;
        vals.forEach(function (v) { if (v != null && (best == null || v < best)) best = v; });
        html += "<tr" + (row.trans ? ' class="rh-trans-row"' : "") + "><td>" + row.label + "</td>" +
          row.cells.map(function (c, ci) {
            return cellHtml(c, best != null && vals[ci] === best && best > 0.049);
          }).join("") + "</tr>";
      });

      // 汇总行
      var stats = recs.map(recStats);
      function sumRow(label, fn, digits) {
        var vals = stats.map(fn);
        var best = null;
        vals.forEach(function (v) { if (v != null && (best == null || v < best)) best = v; });
        return "<tr><td>" + label + "</td>" + vals.map(function (v, i) {
          var cls = v != null && v === best && best > 0 ? "good" : "";
          return '<td class="' + cls + '">' +
            (v == null ? "—" : v.toFixed(digits)) + "</td>";
        }).join("") + "</tr>";
      }
      html += '<tr class="rh-sum-head"><td colspan="' + (recs.length + 1) + '">汇总</td></tr>';
      html += sumRow("平均 |偏差|（秒）", function (s) { return s.meanAbs; }, 2);
      html += sumRow("最大 |偏差|（秒）", function (s) { return s.maxAbs; }, 1);
      html += sumRow("漏记（项）", function (s) { return s.missed; }, 0);
      html += sumRow("重复（笔）", function (s) { return s.dup; }, 0);
      html += sumRow("乱序（笔）", function (s) { return s.ooo; }, 0);
      html += "</tbody></table>";
      wrap.innerHTML = html;
    });
  }

  function exportCompare() {
    if (rh.compareIds.length < 1) { alert("请先勾选排练。"); return; }
    Promise.all(rh.compareIds.map(fetchRehearsal)).then(function (recs) {
      var payload = {
        app: "changeover-desk", type: "rehearsals", version: 1,
        exportedAt: new Date().toISOString(),
        rehearsals: recs,
      };
      COD.downloadBlob(JSON.stringify(payload, null, 2),
        "排练对比-" + (recs[0].frozen.planName || "plan") + ".json", "application/json");
    });
  }

  /* ------------------------------------------------ 导出 / 打印 */
  function exportCurrent() {
    if (!rh.rec) return;
    var payload = {
      app: "changeover-desk", type: "rehearsal", version: 1,
      exportedAt: new Date().toISOString(),
      rehearsal: rh.rec,
    };
    COD.downloadBlob(JSON.stringify(payload, null, 2),
      (rh.rec.name || "rehearsal") + ".json", "application/json");
  }

  function printReview() {
    var rec = rh.rec;
    if (!rec) return;
    var matched = matchedSeqs(rec);
    var fl = liveFlags(rec);
    var st = recStats(rec);
    var missedSeqs = {};
    fl.missed.forEach(function (a) { missedSeqs[a.seq] = true; });

    var rows = rec.frozen.actions.map(function (a, i) {
      var m = matched[a.seq];
      var probs = [];
      if (m) {
        if (m.flags.indexOf("out-of-order") >= 0) probs.push("乱序");
        if (m.inWindow) probs.push("存疑窗口内");
      } else if (missedSeqs[a.seq]) {
        probs.push("漏记");
      }
      return "<tr><td>" + (i + 1) + "</td>" +
        "<td>" + KIND_LABEL[a.kind] + "</td>" +
        '<td class="l">' + esc(a.reelTitle) + "</td>" +
        "<td>" + E.fmtClock(a.t) + (a.window
          ? "<br><span class='tc'>窗口 " + E.fmtClock(a.window[0]) + "～" + E.fmtClock(a.window[1]) + "</span>"
          : "") + "</td>" +
        "<td>" + (m ? E.fmtClock(m.t) : "—") + "</td>" +
        "<td>" + (m ? devText(m.dev, m.inWindow) : (missedSeqs[a.seq] ? "漏记" : "—")) + "</td>" +
        '<td class="l">' + probs.join("；") + "</td></tr>";
    }).join("");
    (rec.marks || []).forEach(function (m) {
      if (m.matchedSeq != null) return;
      rows += "<tr><td>—</td><td>" + KIND_LABEL[m.kind] + "</td>" +
        '<td class="l">（无对应计划动作）</td><td>—</td><td>' + E.fmtClock(m.t) +
        "</td><td>—</td><td>重复</td></tr>";
    });

    $("#printSheet").innerHTML =
      "<h1>排练复盘单 · " + esc(rec.frozen.planName || "") + " · " + esc(rec.name) + "</h1>" +
      '<div class="ps-meta">打印时间：' + new Date().toLocaleString() +
      "　状态：" + (STATUS_LABEL[rec.status] || rec.status) +
      "　起始：" + (rec.startReelIdx === 0 ? "片头" : "第 " + (rec.startReelIdx + 1) + " 卷") +
      "　开始：" + fmtWall(rec.startedAt) + "　完成：" + fmtWall(rec.completedAt) +
      "　热键：" + ["start", "change", "stop", "ready"].map(function (k) {
        return KIND_LABEL[k] + "=" + keyLabel(hotkeys()[k]);
      }).join(" ") + "</div>" +
      '<div class="ps-warn"><b>汇总：</b>计划动作 ' + rec.frozen.actions.length +
      " 项，实录 " + rec.marks.length + " 笔" +
      (st.meanAbs != null ? "，平均 |偏差| " + st.meanAbs.toFixed(2) + " 秒" : "") +
      (st.maxAbs != null ? "，最大 |偏差| " + st.maxAbs.toFixed(1) + " 秒" : "") +
      "；漏记 " + st.missed + " 项，重复 " + st.dup + " 笔，乱序 " + st.ooo + " 笔。" +
      (fl.missed.length
        ? "<br><b>漏记明细：</b>" + fl.missed.map(function (a) {
            return "· " + esc(a.label) + "（计划 " + E.fmtClock(a.t) + "）";
          }).join("　")
        : "") +
      "</div>" +
      '<div class="ps-section-title">逐项记录（计划 / 实际 / 偏差 / 关联卷）</div>' +
      "<table><thead><tr><th>序</th><th>动作</th><th>关联卷</th><th>计划时刻</th>" +
      "<th>实际时刻</th><th>偏差</th><th>问题</th></tr></thead><tbody>" +
      rows + "</tbody></table>" +
      '<div class="ps-sign"><span>放映员</span><span>检片员</span><span>值班经理</span></div>' +
      "<style>.tc{font-size:8pt;color:#444}</style>";
    window.print();
  }

  /* ------------------------------------------------ 事件绑定 */
  function bind() {
    $("#btnRehearsal").addEventListener("click", openView);
    $("#rhClose").addEventListener("click", closeView);
    $("#rhNew").addEventListener("click", function () { createRehearsal(0); });
    $("#rhSelect").addEventListener("change", function () { loadRehearsal(this.value); });
    $("#rhStart").addEventListener("click", startRehearsal);
    $("#rhPause").addEventListener("click", togglePause);
    $("#rhUndo").addEventListener("click", undoMark);
    $("#rhComplete").addEventListener("click", completeRehearsal);
    $("#rhDelete").addEventListener("click", deleteRehearsal);
    $("#rhHotkeys").addEventListener("click", openHotkeyModal);
    $("#rhCompare").addEventListener("click", openCompare);
    $("#rhCompareExport").addEventListener("click", exportCompare);
    $("#rhExport").addEventListener("click", exportCurrent);
    $("#rhPrint").addEventListener("click", printReview);
    $("#rhName").addEventListener("change", function () {
      if (!rh.rec || rh.rec.status === "completed") return;
      rh.rec.name = this.value.trim() || rh.rec.name;
      saveRec();
      renderSelect();
    });
    $("#rhStartReel").addEventListener("change", function () {
      var rec = rh.rec;
      if (!rec || rec.status !== "ready") return;
      var idx = parseInt(this.value, 10) || 0;
      var apply = function (saved) {
        rec.startReelIdx = idx;
        rec.frozen = buildFrozen(saved, idx);
        saveRec();
        renderAll();
      };
      if (rh.savedPlan) { apply(rh.savedPlan); return; }
      COD.flushSave()
        .then(function () { return COD.api("/api/plans/" + rec.planId); })
        .then(function (saved) { rh.savedPlan = saved; apply(saved); });
    });
    $$(".rh-rec").forEach(function (b) {
      b.addEventListener("click", function () { recordMark(b.getAttribute("data-rh-kind")); });
    });
    window.addEventListener("resize", function () {
      if (isOpen() && rh.rec) renderTimeline();
    });

    document.addEventListener("keydown", function (ev) {
      // 热键捕获模式（设置弹窗）
      if (rh.captureKind) {
        ev.preventDefault();
        var kind = rh.captureKind;
        rh.captureKind = null;
        setHotkey(kind, ev.code);
        renderHotkeyModal();
        return;
      }
      if (!isOpen()) return;
      if (ev.target && /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return;
      if (!$("#rhHotkeyModal").hidden || !$("#rhCompareModal").hidden) return;
      if (!rh.rec || rh.rec.status !== "running") return;
      var hk = hotkeys();
      for (var kind2 in hk) {
        if (hk[kind2] === ev.code) {
          ev.preventDefault();
          if (!ev.repeat) recordMark(kind2);
          return;
        }
      }
    });
  }

  bind();
})();
