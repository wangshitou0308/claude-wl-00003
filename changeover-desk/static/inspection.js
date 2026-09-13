/* ============================================================
 * inspection.js —— 拷贝验片单
 *
 * 一次放映涉及的实体胶片卷逐卷验片。新建验片单时从「已保存」换卷方案
 * 冻结卷序、片长、提示帧与护片参数（frozen），之后方案再改不影响本单，
 * 只在读取时标记快照过期（snapshotStale）。
 *
 * 逐卷状态机：pending 待检查 → checking 检查中 → action 待处置
 *             → released 已放行 / returned 已退回（终态，后端拒绝改写）。
 * 放行闸：非信息级问题必须有处置且复查通过；保留待定始终算未决。
 * 处置只记录本单，绝不回写换卷方案。
 * ============================================================ */
(function () {
  "use strict";
  var E = window.Engine;
  var COD = window.COD;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  var esc = COD.esc;
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function nowMs() { return Date.now(); }
  function isOpen() { return !$("#inspectionView").hidden; }

  /* ------------------------------------------------ 常量 */
  var REEL_STATUS = ["pending", "checking", "action", "released", "returned"];
  var STATUS_LABEL = {
    pending: "待检查", checking: "检查中", action: "待处置",
    released: "已放行", returned: "已退回",
  };
  var STATUS_NEXT_HINT = {
    pending: "开始检查", checking: "发现问题，转待处置", action: "处置复查后放行或退回",
    released: "终态 · 只读", returned: "终态 · 只读",
  };

  var KINDS = ["splice", "perf", "scratch", "shrink", "headtail", "cue"];
  var KIND_LABEL = {
    splice: "接片", perf: "齿孔", scratch: "划伤",
    shrink: "缩水", headtail: "片头片尾", cue: "提示标记",
  };
  var KIND_MEASURE = {
    splice: { unit: "mm", label: "接缝宽度（毫米）", range: false },
    perf: { unit: "格", label: "连伤齿孔（格）", range: true },
    scratch: { unit: "ft", label: "划伤长度（英尺）", range: true },
    shrink: { unit: "%", label: "缩水率（%）", range: false },
    headtail: { unit: "ft", label: "缺损长度（英尺）", range: false },
    cue: { unit: "格", label: "偏差（格）", range: false },
  };
  var SEVERITIES = ["info", "minor", "major", "critical"];
  var SEVERITY_LABEL = { info: "记录", minor: "轻微", major: "较重", critical: "严重" };
  var SEVERITY_COLOR = {
    info: "#6b7280", minor: "#4fc3b0", major: "#e8a33d", critical: "#e05d5d",
  };
  var DISPOSITIONS = ["clean", "resplice", "replaceLeader", "remark", "hold"];
  var DISP_LABEL = {
    clean: "清洁", resplice: "重接", replaceLeader: "换护片",
    remark: "重做标记", hold: "保留待定",
  };
  var KIND_DISP_HINT = {
    splice: "resplice", perf: "hold", scratch: "clean",
    shrink: "hold", headtail: "replaceLeader", cue: "remark",
  };
  var ZONE_LABEL = {
    picture: "画面段", motorCue: "马达提示窗口", changeCue: "切换提示窗口",
    reserve: "片头储备范围", headLeader: "片头护片", tailLeader: "片尾护片",
    out: "全片范围外",
  };
  var CUE_TOL_FT = 1; // 提示窗口：提示帧两侧各 1 英尺

  var insp = {
    list: [],        // 当前方案的验片单摘要
    sheet: null,     // 当前打开的完整验片单
    savedPlan: null, // 创建时冻结用的已保存方案
    selectedReelId: null,
    selectedFindingId: null,
    draft: null,     // 正在登记/编辑的问题（未保存）
    rulerUnit: "ft",// ft / tc / frames
    view: { pxPerFrame: 0.18 },
    pan: null,
    fullCache: {},
    saveTimer: 0,
  };

  /* ------------------------------------------------ 冻结快照 */
  function buildFrozen(plan) {
    var analysis = E.analyzePlan(plan);
    var reels = analysis.computed.map(function (c) {
      var r = c.reel;
      return {
        id: r.id, title: r.title, projector: r.projector,
        order: c.idx, gauge: r.gauge, fps: c.fps, fpf: c.fpf,
        lengthUnit: r.lengthUnit, lengthValue: r.lengthValue,
        headLeaderFt: r.headLeaderFt, tailLeaderFt: r.tailLeaderFt,
        cueRef: analysis.settings.cueRef,
        motorCue: r.motorCue, motorCueMax: r.motorCueMax, motorCueU: !!r.motorCueU,
        changeCue: r.changeCue, changeCueMax: r.changeCueMax, changeCueU: !!r.changeCueU,
        // 冻结换算结果（自物理片头起的格数）
        headFrames: c.headFrames, tailFrames: c.tailFrames,
        picFrames: c.picFrames, totalFrames: c.totalFrames,
        motorOffMin: c.mOff.min, motorOffMax: c.mOff.max, motorOffMid: c.mOff.mid,
        motorUncertain: c.motor.uncertain,
        changeOffMin: c.cOff.min, changeOffMax: c.cOff.max, changeOffMid: c.cOff.mid,
        changeUncertain: c.change.uncertain,
      };
    });
    return {
      planId: plan.id,
      planName: plan.name,
      planUpdatedAt: plan.updatedAt || null,
      frozenAt: nowMs(),
      cueRef: analysis.settings.cueRef,
      cueTolFt: CUE_TOL_FT,
      reels: reels,
    };
  }

  /* 由冻结参数推导分区边界（全部为自物理片头起的格数） */
  function zonesOf(fr) {
    var tol = CUE_TOL_FT * fr.fpf;
    return {
      pic0: fr.headFrames, pic1: fr.headFrames + fr.picFrames,
      motorLo: fr.motorOffMin - tol, motorHi: fr.motorOffMax + tol,
      changeLo: fr.changeOffMin - tol, changeHi: fr.changeOffMax + tol,
      reserveLo: fr.motorOffMin, reserveHi: fr.changeOffMax,
    };
  }

  function classifyZone(fr, frame) {
    var z = zonesOf(fr);
    if (frame < 0 || frame > fr.totalFrames) return "out";
    if (frame >= z.motorLo && frame <= z.motorHi) return "motorCue";
    if (frame >= z.changeLo && frame <= z.changeHi) return "changeCue";
    if (frame >= z.reserveLo && frame <= z.reserveHi) return "reserve";
    if (frame >= z.pic0 && frame <= z.pic1) return "picture";
    if (frame < z.pic0) return "headLeader";
    return "tailLeader";
  }

  /* ------------------------------------------------ 定位换算 */
  function frameToFt(fr, frame) { return frame / fr.fpf; }
  function frameToTc(fr, frame) {
    // 时间码：第一格画面为 00:00:00:00，护片段为负
    return (frame - fr.headFrames) / fr.fps;
  }
  function posText(fr, frame) {
    return E.fmtClock(frameToTc(fr, frame)) + " / " +
      frameToFt(fr, frame).toFixed(2) + " ft / " + Math.round(frame) + " 格";
  }

  /* ------------------------------------------------ 单据/卷/问题工具 */
  function frozenReels() { return (insp.sheet && insp.sheet.frozen && insp.sheet.frozen.reels) || []; }
  function reelEntry(id) {
    return (insp.sheet.reels || []).filter(function (r) { return r.reelId === id; })[0] || null;
  }
  function frozenById(id) {
    return frozenReels().filter(function (r) { return r.id === id; })[0] || null;
  }
  function reelLocked(fr) {
    var e = reelEntry(fr.id);
    return e && (e.status === "released" || e.status === "returned");
  }
  function sheetSealed() {
    return (insp.sheet.reels || []).some(function (r) {
      return r.status === "released" || r.status === "returned";
    });
  }
  function editable() { return !!insp.sheet; }
  function allTerminal() {
    return !!insp.sheet && insp.sheet.reels.length > 0 &&
      insp.sheet.reels.every(function (r) {
        return r.status === "released" || r.status === "returned";
      });
  }

  function findingOpen(f) {
    if (f.severity === "info") return false;
    if (!f.disposition || f.disposition === "hold") return true;
    return !f.recheckPassed;
  }
  function openFindings(entry) {
    return (entry.findings || []).filter(findingOpen);
  }
  function reelBlockers(entry) {
    return (entry.findings || []).filter(function (f) {
      return findingOpen(f);
    });
  }
  function countsOf(entry) {
    var c = { total: (entry.findings || []).length, open: 0, critical: 0, info: 0 };
    (entry.findings || []).forEach(function (f) {
      if (f.severity === "info") c.info++;
      if (f.severity === "critical" && findingOpen(f)) c.critical++;
      if (findingOpen(f)) c.open++;
    });
    return c;
  }

  function makeFinding(fr, frame, kind) {    return {
      id: E.uid("find"),
      kind: kind || "scratch",
      severity: "minor",
      from: Math.round(clamp(frame, 0, fr.totalFrames)),
      to: Math.round(clamp(frame, 0, fr.totalFrames)),
      measure: { value: null, to: null, unit: KIND_MEASURE[kind || "scratch"].unit },
      note: "",
      disposition: "", dispositionNote: "", dispositionAt: null,
      recheckPassed: false, rechecks: [], createdAt: nowMs(),
    };
  }

  /* ------------------------------------------------ 后端同步 */
  function saveSheet() {
    if (!insp.sheet) return Promise.resolve();
    var payload = JSON.parse(JSON.stringify(insp.sheet));
    return COD.api("/api/inspections/" + insp.sheet.id, COD.jsonOpts("PUT", payload))
      .then(function (saved) {
        insp.sheet.updatedAt = saved.updatedAt;
        insp.sheet.snapshotStale = saved.snapshotStale;
        refreshListRow(saved);
      })
      .catch(function (err) {
        alert("验片单保存失败：" + err.message + "\n将重新拉取以对齐服务端状态。");
        loadSheet(insp.sheet.id);
      });
  }
  function scheduleSave() {
    clearTimeout(insp.saveTimer);
    insp.saveTimer = setTimeout(saveSheet, 500);
  }

  function refreshListRow(saved) {
    for (var i = 0; i < insp.list.length; i++) {
      if (insp.list[i].id !== saved.id) continue;
      var counts = { pending: 0, checking: 0, action: 0, released: 0, returned: 0 };
      var openN = 0;
      (saved.reels || []).forEach(function (r) {
        counts[r.status] = (counts[r.status] || 0) + 1;
        (r.findings || []).forEach(function (f) { if (findingOpen(f)) openN++; });
      });
      insp.list[i].name = saved.name;
      insp.list[i].inspector = saved.inspector;
      insp.list[i].counts = counts;
      insp.list[i].openFindings = openN;
      insp.list[i].snapshotStale = saved.snapshotStale;
      insp.list[i].updatedAt = saved.updatedAt;
      break;
    }
    renderSelect();
  }

  function loadList(selectId) {
    var plan = COD.getPlan();
    if (!plan) return Promise.resolve();
    return COD.api("/api/inspections?planId=" + encodeURIComponent(plan.id))
      .then(function (list) {
        insp.list = list;
        if (!list.length) { insp.sheet = null; renderAll(); return; }
        var id = selectId || (insp.sheet && insp.sheet.id);
        if (!id || !list.some(function (s) { return s.id === id; })) id = list[list.length - 1].id;
        return loadSheet(id);
      })
      .catch(function (err) { alert("读取验片单失败：" + err.message); });
  }

  function loadSheet(id) {
    return COD.api("/api/inspections/" + encodeURIComponent(id)).then(function (sheet) {
      insp.sheet = sheet;
      insp.fullCache[sheet.id] = sheet;
      if (!sheet.reels.some(function (r) { return r.reelId === insp.selectedReelId; }))
        insp.selectedReelId = sheet.reels.length ? sheet.reels[0].reelId : null;
      insp.draft = null;
      renderAll();
      requestAnimationFrame(function () { zoomFit(); });
    });
  }

  function createSheet() {
    var plan = COD.getPlan();
    if (!plan) return;
    return COD.flushSave()
      .then(function () { return COD.api("/api/plans/" + plan.id); })
      .then(function (saved) {
        insp.savedPlan = saved;
        if (!saved.reels.length) { alert("方案还没有胶片卷，无法建立验片单。"); return null; }
        var frozen = buildFrozen(saved);
        var sheet = {
          id: E.uid("ins"),
          planId: saved.id,
          name: "验片 " + new Date().toLocaleString(),
          inspector: "", note: "",
          frozen: frozen,
          reels: frozen.reels.map(function (fr) {
            return { reelId: fr.id, status: "pending", findings: [] };
          }),
        };
        return COD.api("/api/inspections", COD.jsonOpts("POST", sheet));
      })
      .then(function (created) { if (created) return loadList(created.id); });
  }

  function deleteSheet() {
    var s = insp.sheet;
    if (!s) return;
    if (!confirm("删除验片单「" + s.name + "」？已有放行/退回卷的单据不可删除。")) return;
    COD.api("/api/inspections/" + s.id, { method: "DELETE" })
      .then(function () { insp.sheet = null; return loadList(); })
      .catch(function (err) { alert(err.message); });
  }

  /* ------------------------------------------------ 视图开关 */
  function openView() {
    if (!COD.getPlan()) return;
    document.body.classList.add("inspection-open");
    $("#inspectionView").hidden = false;
    loadList();
  }
  function closeView() {
    document.body.classList.remove("inspection-open");
    $("#inspectionView").hidden = true;
    clearTimeout(insp.saveTimer);
    insp.sheet = null;
  }

  /* ------------------------------------------------ 状态流转 */
  function setReelStatus(entry, status) {
    if (!editable()) return;
    if (reelLocked(frozenById(entry.reelId))) return;
    if (status === "released") {
      var blockers = reelBlockers(entry);
      if (blockers.length) {
        alert("仍有 " + blockers.length + " 项未决：需完成处置并复查通过（或明确退回本卷），不能放行。");
        return;
      }
    }
    entry.status = status;
    saveSheet();
    renderAll();
  }

  function addFindingAt(fr, frame, kind) {
    if (!editable() || reelLocked(fr)) return;
    var entry = reelEntry(fr.id);
    if (entry.status === "pending") { entry.status = "checking"; saveSheet(); }
    insp.draft = makeFinding(fr, frame, kind);
    // 划伤/齿孔默认按一小段（1 英尺 / 4 格）起录
    if (kind === "scratch") insp.draft.to = Math.min(fr.totalFrames, insp.draft.from + fr.fpf);
    if (kind === "perf") insp.draft.to = Math.min(fr.totalFrames, insp.draft.from + 4);
    insp.selectedFindingId = null;
    renderAll();
    focusDraftFirst();
  }

  function commitDraft() {
    var d = insp.draft;
    if (!d) return;
    var fr = frozenById(currentReelId());
    if (!fr) { insp.draft = null; renderAll(); return; }
    if (d.to < d.from) { var t = d.from; d.from = d.to; d.to = t; }
    d.from = Math.round(clamp(d.from, 0, fr.totalFrames));
    d.to = Math.round(clamp(d.to, d.from, fr.totalFrames));
    var entry = reelEntry(fr.id);
    // 存疑提示标记允许登记在快照范围之外，其余越界给确认
    if (d.kind !== "cue" && (d.from > fr.totalFrames || d.to > fr.totalFrames)) {
      alert("位置超出本卷物理全长。");
      return;
    }
    var existing = (entry.findings || []).filter(function (f) { return f.id === d.id; })[0];
    if (existing) {
      var idx = entry.findings.indexOf(existing);
      entry.findings[idx] = d;
    } else {
      entry.findings.push(d);
    }
    if (entry.status === "checking" && findingOpen(d) && d.severity !== "info")
      entry.status = "action";
    insp.draft = null;
    insp.selectedFindingId = d.id;
    saveSheet();
    renderAll();
  }
  function cancelDraft() { insp.draft = null; renderAll(); }

  function editFinding(f) {
    var fr = frozenById(currentReelId());
    if (!fr || reelLocked(fr)) return;
    insp.draft = JSON.parse(JSON.stringify(f));
    insp.selectedFindingId = f.id;
    renderAll();
    focusDraftFirst();
  }
  function deleteFinding(f) {
    var fr = frozenById(currentReelId());
    if (!fr || reelLocked(fr)) return;
    if (!confirm("删除该项检查结果？")) return;
    var entry = reelEntry(fr.id);
    entry.findings = entry.findings.filter(function (x) { return x.id !== f.id; });
    if (insp.selectedFindingId === f.id) insp.selectedFindingId = null;
    saveSheet();
    renderAll();
  }

  function setDisposition(f, disp) {
    var fr = frozenById(currentReelId());
    if (!fr || reelLocked(fr)) return;
    f.disposition = disp;
    f.dispositionAt = nowMs();
    // 换了处置：复查结论失效，需重新复查受影响区间
    f.recheckPassed = false;
    var entry = reelEntry(fr.id);
    if (entry.status === "released" || entry.status === "returned") return;
    entry.status = "action";
    saveSheet();
    renderAll();
  }

  /* 已处置问题的位置 / 类别 / 程度 / 测量被改动：受影响区间须重新复查 */
  function invalidateRecheck(f) {
    if (insp.draft) return; // 草稿尚未保存，无复查结论可失效
    if (f.disposition && f.recheckPassed) {
      f.recheckPassed = false;
      f.rechecks.push({ at: nowMs(), passed: false, note: "参数修改后复查结论失效，需重新复查" });
    }
  }

  function recheck(f, pass) {
    var fr = frozenById(currentReelId());
    if (!fr || reelLocked(fr)) return;
    f.rechecks.push({
      at: nowMs(), passed: !!pass,
      note: pass ? "复查通过" : "复查未过，重新处置",
    });
    if (pass) {
      f.recheckPassed = true;
    } else {
      // 复查未过：处置作废，回到待处置
      f.recheckPassed = false;
      f.disposition = "hold";
      f.dispositionAt = nowMs();
    }
    var entry = reelEntry(fr.id);
    if (!reelBlockers(entry).length) entry.status = "checking";
    else entry.status = "action";
    saveSheet();
    renderAll();
  }

  function currentReelId() {
    if (insp.sheet && insp.sheet.reels.some(function (r) { return r.reelId === insp.selectedReelId; }))
      return insp.selectedReelId;
    return insp.sheet && insp.sheet.reels.length ? insp.sheet.reels[0].reelId : null;
  }

  /* ------------------------------------------------ 渲染：总览 */
  function renderAll() {
    renderTopbar();
    renderSelect();
    if (!insp.sheet) {
      ["ivStrip", "ivRight", "ivReadiness"].forEach(function (id) { $("#" + id).innerHTML = ""; });
      $("#ivRight").innerHTML = '<div class="iv-empty">本方案还没有验片单。<br>点上方「＋ 新建验片单」，从已保存方案冻结快照后开始验片。</div>';
      return;
    }
    renderReadiness();
    renderStrip();
    renderRight();
  }

  function renderTopbar() {
    var s = insp.sheet;
    var hl = allTerminal();
    $("#ivName").value = s ? s.name : "";
    $("#ivName").disabled = !s || hl;
    $("#ivInspector").value = s ? (s.inspector || "") : "";
    $("#ivInspector").disabled = !s || hl;
    ["ivCompare", "ivExport", "ivPrint", "ivDelete"].forEach(function (id) {
      $("#" + id).disabled = !s;
    });
    var stale = $("#ivStale");
    if (s && s.snapshotStale) {
      stale.hidden = false;
      stale.title = "冻结于方案更新时间 " +
        (s.frozen.planUpdatedAt ? new Date(s.frozen.planUpdatedAt).toLocaleString() : "—");
    } else stale.hidden = true;
  }

  function renderSelect() {
    var sel = $("#ivSelect");
    sel.innerHTML = insp.list.map(function (s) {
      var c = s.counts || {};
      var tag = c.released ? "已放行 " + c.released + " 卷" :
        s.openFindings ? "未决 " + s.openFindings : (s.name || "");
      return '<option value="' + esc(s.id) + '"' +
        (insp.sheet && s.id === insp.sheet.id ? " selected" : "") + ">" +
        esc(s.name) + "（" + tag + (s.snapshotStale ? " · 快照过期" : "") + "）</option>";
    }).join("");
  }

  function renderReadiness() {
    var box = $("#ivReadiness");
    var reels = frozenReels();
    box.innerHTML =
      '<div class="iv-readiness-head">开映准备 · ' + esc(insp.sheet.frozen.planName) +
      (insp.sheet.snapshotStale ? ' <span class="iv-stale-chip" title="方案或卷参数在冻结后发生变化">快照过期</span>' : "") +
      "</div>" +
      reels.map(function (fr) {
        var entry = reelEntry(fr.id);
        var st = entry ? entry.status : "pending";
        var c = entry ? countsOf(entry) : { total: 0, open: 0, critical: 0 };
        var active = fr.id === currentReelId();
        return '<button class="iv-reel-card ' + st + (active ? " active" : "") +
          '" data-reel="' + esc(fr.id) + '">' +
          '<span class="iv-reel-ord proj-' + fr.projector + '">' + (fr.order + 1) + "</span>" +
          '<span class="iv-reel-info"><b>' + esc(fr.title) + "</b>" +
          '<span class="iv-reel-meta">' + esc(STATUS_LABEL[st]) +
          (c.total ? " · 问题 " + c.total + "（未决 " + c.open + "）" : " · 无记录") +
          (c.critical ? ' <i class="iv-crit-dot">!</i>' : "") +
          "</span></span>" +
          (fr.id === insp.selectedReelId ? ' <span class="iv-reel-arrow">▶</span>' : "") +
          "</button>";
      }).join("");
    $$("#ivReadiness [data-reel]").forEach(function (b) {
      b.onclick = function () {
        insp.selectedReelId = b.getAttribute("data-reel");
        insp.draft = null;
        renderAll();
      };
    });
  }

  /* ============================================================
   * SVG 胶片带
   * ============================================================ */
  var G = {
    labelW: 150, rulerH: 30, stripH: 46, rowGap: 14,
    padX: 12, holesH: 9, stripTop: 4,
  };

  function pxPerFrame() { return insp.view.pxPerFrame; }
  function xOf(fr, frame) { return G.labelW + G.padX + frame * pxPerFrame(); }
  function frameAtX(fr, x) { return (x - G.labelW - G.padX) / pxPerFrame(); }
  function rowY(i) { return G.rulerH + i * (G.stripH + G.rowGap); }
  function rowH() { return G.stripH; }

  function stripScroll() { return $("#ivStripScroll"); }

  function renderStrip() {
    var scrollEl = stripScroll();
    var reels = frozenReels();
    var maxFrames = Math.max.apply(null, reels.map(function (fr) { return fr.totalFrames; }).concat([1]));
    var contentW = G.labelW + G.padX * 2 + maxFrames * pxPerFrame();
    var H = G.rulerH + reels.length * (G.stripH + G.rowGap) + 8;
    var W = Math.max(scrollEl.clientWidth, contentW);
    var svg = $("#ivStrip");
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    var h = [];
    h.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#14161a"/>');

    // 标签列吸顶底
    h.push('<rect x="0" y="0" width="' + G.labelW + '" height="' + H + '" fill="#14161a"/>');
    h.push('<line x1="' + (G.labelW - 1) + '" y1="0" x2="' + (G.labelW - 1) + '" y2="' + H +
      '" stroke="#333842" stroke-width="1"/>');

    reels.forEach(function (fr, i) {
      var y = rowY(i);
      if (i % 2 === 0)
        h.push('<rect x="0" y="' + y + '" width="' + W + '" height="' + G.stripH + G.rowGap +
          '" fill="rgba(255,255,255,.015)"/>');
      drawRulerForRow(h, fr, i, y);
      drawFilmRow(h, fr, i, y);
    });

    h.push('<g id="ivSticky"></g>');
    svg.innerHTML = h.join("");
    syncSticky();
    bindSvgOnce(svg);
  }

  function niceStep(minSpan) {
    var steps;
    if (insp.rulerUnit === "ft") steps = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
    else if (insp.rulerUnit === "frames") steps = [16, 40, 80, 160, 400, 800, 1600, 4000, 8000];
    else steps = (function () {
      // 时间码主刻度：1,2,5,10,15,30 秒，1,2,5,10,15,30 分…
      var out = [];
      [1, 2, 5, 10, 15, 30].forEach(function (s) { out.push(s); });
      [1, 2, 5, 10, 15, 30].forEach(function (m) { out.push(m * 60); });
      return out;
    })();
    for (var i = 0; i < steps.length; i++) if (steps[i] >= minSpan) return steps[i];
    return steps[steps.length - 1];
  }

  /* 每行自带一条以本卷物理片头为零的定位刻度 */
  function drawRulerForRow(h, fr, i, y) {
    var ppf = pxPerFrame();
    var stepFrames;
    if (insp.rulerUnit === "ft") stepFrames = niceStep(90 / ppf / fr.fpf) * fr.fpf;
    else if (insp.rulerUnit === "frames") stepFrames = niceStep(90 / ppf);
    else {
      var stepSec = niceStep(90 / ppf / fr.fps);
      stepFrames = stepSec * fr.fps;
    }
    var rulerY = y + G.stripH + 4;
    var startK = 0;
    var endK = Math.ceil(fr.totalFrames / stepFrames);
    for (var k = startK; k <= endK; k++) {
      var frame = k * stepFrames;
      if (frame < -stepFrames || frame > fr.totalFrames + stepFrames) continue;
      var x = xOf(fr, frame);
      var major = k % 1 === 0;
      h.push('<line x1="' + x + '" y1="' + rulerY + '" x2="' + x + '" y2="' + (rulerY + (major ? 6 : 3)) +
        '" stroke="#3a414d" stroke-width="1"/>');
      if (major) {
        var label;
        if (insp.rulerUnit === "ft") label = (frame / fr.fpf).toFixed(stepFrames >= fr.fpf ? 0 : 1) + "ft";
        else if (insp.rulerUnit === "frames") label = String(Math.round(frame));
        else label = E.fmtClock(frameToTc(fr, frame));
        h.push('<text x="' + (x + 2) + '" y="' + (rulerY - 2) + '" fill="#7b828c" font-size="9" ' +
          'font-variant-numeric="tabular-nums">' + label + "</text>");
      }
      // 网格竖线（淡）
      h.push('<line x1="' + x + '" y1="' + y + '" x2="' + x + '" y2="' + (y + G.stripH) +
        '" stroke="#20242b" stroke-width="1"/>');
    }
  }

  function drawFilmRow(h, fr, i, y) {
    var ppf = pxPerFrame();
    var x0 = xOf(fr, 0);
    var xHead = xOf(fr, fr.headFrames);
    var xPic = xOf(fr, fr.headFrames + fr.picFrames);
    var xEnd = xOf(fr, fr.totalFrames);
    var stripY = y + G.stripTop;
    var bodyH = G.stripH - G.stripTop * 2;
    var entry = reelEntry(fr.id);
    var status = entry ? entry.status : "pending";
    var locked = reelLocked(fr);
    var selected = fr.id === currentReelId();
    var z = zonesOf(fr);

    // 行标签（吸左由 sticky 层重绘）
    h.push('<text x="8" y="' + (y + G.stripH / 2 + 1) + '" fill="' +
      (fr.projector === "A" ? "#9fc2e8" : "#e8b98f") + '" font-size="11" font-weight="600">' +
      esc((fr.order + 1) + " · " + (fr.projector === "A" ? "甲" : "乙") + " " + fr.title) + "</text>");

    // 三段片体
    h.push('<rect x="' + x0 + '" y="' + stripY + '" width="' + Math.max(1, xHead - x0) + '" height="' + bodyH +
      '" fill="#2a2e36" stroke="#3b414b" stroke-width=".8" pointer-events="none"/>');
    h.push('<rect x="' + xHead + '" y="' + stripY + '" width="' + Math.max(1, xPic - xHead) + '" height="' + bodyH +
      '" fill="rgba(79,195,176,.15)" stroke="#2e6b60" stroke-width=".8" pointer-events="none"/>');
    h.push('<rect x="' + xPic + '" y="' + stripY + '" width="' + Math.max(1, xEnd - xPic) + '" height="' + bodyH +
      '" fill="#2a2e36" stroke="#3b414b" stroke-width=".8" pointer-events="none"/>');

    // 片头储备范围（motor→change 走片段）
    var rx1 = xOf(fr, z.reserveLo), rx2 = xOf(fr, z.reserveHi);
    h.push('<rect x="' + rx1 + '" y="' + (stripY - 3) + '" width="' + Math.max(2, rx2 - rx1) +
      '" height="' + (bodyH + 6) + '" fill="rgba(106,166,224,.10)" pointer-events="none"/>');

    // 提示窗口
    h.push(cueWindow(fr, z.motorLo, z.motorHi, stripY, bodyH, "#e8a33d", fr.motorUncertain));
    h.push(cueWindow(fr, z.changeLo, z.changeHi, stripY, bodyH, "#e05d5d", fr.changeUncertain));

    // 齿孔带（上下各一排，按可视范围抽样）
    drawSprockets(h, fr, x0, xEnd, stripY, bodyH, ppf);

    // 边界刻线：物理片头 / 画面起止
    [ [0, "#566070", "物理片头"], [fr.headFrames, "#4fc3b0", "画面起"],
      [fr.headFrames + fr.picFrames, "#4fc3b0", "画面止"] ].forEach(function (p) {
      h.push('<line x1="' + xOf(fr, p[0]) + '" y1="' + (stripY - 2) + '" x2="' + xOf(fr, p[0]) +
        '" y2="' + (stripY + bodyH + 2) + '" stroke="' + p[1] + '" stroke-width="1" pointer-events="none"/>');
    });

    // 提示帧刻线
    h.push(cueLine(fr, fr.motorOffMid, stripY, bodyH, "#e8a33d", "马达"));
    h.push(cueLine(fr, fr.changeOffMid, stripY, bodyH, "#e05d5d", "切换"));

    // 命中层（点击空白片体登记问题；先压入，使问题标记绘制在其上可点击）
    if (!locked) {
      h.push('<rect x="' + x0 + '" y="' + (stripY - 8) + '" width="' + Math.max(4, xEnd - x0) +
        '" height="' + (bodyH + 16) + '" fill="transparent" data-hit-reel="' + esc(fr.id) +
        '" style="cursor:crosshair"/>');
    }

    // 问题标记
    (entry ? entry.findings : []).forEach(function (f) {
      var fx1 = xOf(fr, f.from), fx2 = xOf(fr, f.to);
      var col = SEVERITY_COLOR[f.severity] || SEVERITY_COLOR.minor;
      var open = findingOpen(f);
      var rangeW = Math.max(3, fx2 - fx1);
      // 区间（划伤/齿孔等）
      h.push('<rect x="' + fx1 + '" y="' + (stripY - 5) + '" width="' + rangeW + '" height="6" rx="2"' +
        ' fill="' + col + '" opacity="' + (open ? 0.85 : 0.3) + '" data-fid="' + esc(f.id) +
        '" data-freel="' + esc(fr.id) + '" style="cursor:pointer"/>');
      // 主标记：三角=未决，圆=已决
      var cy = stripY + bodyH + 3;
      if (open) {
        h.push('<polygon points="' + fx1 + ',' + (cy + 6) + " " + (fx1 - 4) + "," + cy + " " +
          (fx1 + 4) + "," + cy + '" fill="' + col + '" data-fid="' + esc(f.id) +
          '" data-freel="' + esc(fr.id) + '" style="cursor:pointer"/>');
      } else {
        h.push('<circle cx="' + fx1 + '" cy="' + (cy + 2) + '" r="3.4" fill="none" stroke="' + col +
          '" stroke-width="1.4" data-fid="' + esc(f.id) + '" data-freel="' + esc(fr.id) +
          '" style="cursor:pointer"/>');
      }
    });

    // 草稿标记
    if (insp.draft) {
      var d = insp.draft;
      h.push('<line x1="' + xOf(fr, d.from) + '" y1="' + (stripY - 7) + '" x2="' + xOf(fr, d.from) +
        '" y2="' + (stripY + bodyH + 7) + '" stroke="#f3d9a6" stroke-width="1.4" stroke-dasharray="4 3" pointer-events="none"/>');
      if (d.to !== d.from)
        h.push('<rect x="' + xOf(fr, d.from) + '" y="' + (stripY - 6) +
          '" width="' + Math.max(2, xOf(fr, d.to) - xOf(fr, d.from)) + '" height="5" fill="#f3d9a6" opacity=".7" pointer-events="none"/>');
    }

    // 外框
    h.push('<rect x="' + x0 + '" y="' + stripY + '" width="' + Math.max(4, xEnd - x0) + '" height="' + bodyH +
      '" fill="none" stroke="' + (selected ? "#e8a33d" : "#454c59") +
      '" stroke-width="' + (selected ? 1.6 : 1) + '" pointer-events="none"/>');

    // 状态角标
    var badgeCol = { pending: "#6b7280", checking: "#6aa6e0", action: "#e8a33d",
      released: "#4fc3b0", returned: "#e05d5d" }[status];
    h.push('<rect x="' + (xEnd + 6) + '" y="' + (stripY - 1) + '" width="8" height="' + (bodyH + 2) +
      '" rx="2" fill="' + badgeCol + '" pointer-events="none"/>');
  }

  function cueWindow(fr, lo, hi, stripY, bodyH, col, uncertain) {
    var x1 = xOf(fr, lo), x2 = xOf(fr, hi);
    return '<rect x="' + x1 + '" y="' + (stripY - 3) + '" width="' + Math.max(2, x2 - x1) +
      '" height="' + (bodyH + 6) + '" rx="2" fill="' + col + '" opacity=".13" stroke="' + col +
      '" stroke-width=".7" stroke-dasharray="' + (uncertain ? "2 2" : "3 2") + '" pointer-events="none"/>';
  }
  function cueLine(fr, mid, stripY, bodyH, col, name) {
    var x = xOf(fr, mid);
    return '<line x1="' + x + '" y1="' + (stripY - 4) + '" x2="' + x + '" y2="' + (stripY + bodyH + 4) +
      '" stroke="' + col + '" stroke-width="1.4" pointer-events="none"/>' +
      '<text x="' + (x + 2) + '" y="' + (stripY + 9) + '" fill="' + col + '" font-size="8.5" ' +
      'pointer-events="none">' + name + "</text>";
  }

  function drawSprockets(h, fr, x0, xEnd, stripY, bodyH, ppf) {
    if (ppf < 0.05) return; // 缩得太小时不画齿孔
    var scrollEl = stripScroll();
    var viewLo = scrollEl.scrollLeft - 40, viewHi = scrollEl.scrollLeft + scrollEl.clientWidth + 40;
    var holeW = Math.max(1.2, ppf * 0.55);
    var frameStart = Math.max(0, (viewLo - G.labelW - G.padX) / ppf);
    var frameEnd = Math.min(fr.totalFrames, (viewHi - G.labelW - G.padX) / ppf);
    var stepFrames = Math.max(1, Math.round(2.2 / ppf));
    for (var fm = Math.floor(frameStart / stepFrames) * stepFrames; fm <= frameEnd; fm += stepFrames) {
      var x = xOf(fr, fm);
      h.push('<rect x="' + x + '" y="' + (stripY + 1.5) + '" width="' + holeW + '" height="3" rx=".8" fill="#0c0e11" stroke="#333842" stroke-width=".4" pointer-events="none"/>');
      h.push('<rect x="' + x + '" y="' + (stripY + bodyH - 4.5) + '" width="' + holeW + '" height="3" rx=".8" fill="#0c0e11" stroke="#333842" stroke-width=".4" pointer-events="none"/>');
    }
  }

  /* 吸左行标签：滚动时把卷名重绘到 sticky 层 */
  function syncSticky() {
    var g = $("#ivSticky");
    if (!g) return;
    var sl = stripScroll().scrollLeft;
    g.setAttribute("transform", "translate(" + sl + ",0)");
    var reels = frozenReels();
    g.innerHTML = reels.map(function (fr, i) {
      var y = rowY(i);
      var entry = reelEntry(fr.id);
      var st = entry ? entry.status : "pending";
      var col = { pending: "#6b7280", checking: "#6aa6e0", action: "#e8a33d",
        released: "#4fc3b0", returned: "#e05d5d" }[st];
      return '<rect x="2" y="' + (y + G.stripTop) + '" width="' + (G.labelW - 6) +
        '" height="' + (G.stripH - G.stripTop * 2) + '" rx="4" fill="rgba(20,22,26,.92)" stroke="' +
        col + '" stroke-width="1.2"/>' +
        '<text x="10" y="' + (y + G.stripH / 2 - 1) + '" fill="' +
        (fr.projector === "A" ? "#9fc2e8" : "#e8b98f") + '" font-size="11" font-weight="600">' +
        esc((fr.order + 1) + " · " + (fr.projector === "A" ? "甲" : "乙")) + "</text>" +
        '<text x="10" y="' + (y + G.stripH / 2 + 11) + '" fill="' + col + '" font-size="9">' +
        esc(STATUS_LABEL[st]) + "</text>";
    }).join("");
  }

  /* SVG 交互（只绑一次，靠事件委托） */
  var svgBound = false;
  function bindSvgOnce(svg) {
    if (svgBound) return;
    svgBound = true;
    var scrollEl = stripScroll();
    scrollEl.addEventListener("scroll", syncSticky);

    svg.addEventListener("pointerdown", function (ev) {
      var fidEl = ev.target.closest ? ev.target.closest("[data-fid]") : null;
      if (fidEl) return; // 点到问题标记：留给 click 选中，不启动平移
      var hit = ev.target.closest ? ev.target.closest("[data-hit-reel]") : null;
      if (!hit) return;
      var fr = frozenById(hit.getAttribute("data-hit-reel"));
      if (!fr || reelLocked(fr)) return;
      insp.pan = {
        reelId: fr.id, startX: ev.clientX, startScroll: scrollEl.scrollLeft,
        moved: false,
      };
      svg.setPointerCapture(ev.pointerId);
    });
    svg.addEventListener("pointermove", function (ev) {
      var p = insp.pan;
      if (!p) return;
      var dx = ev.clientX - p.startX;
      if (Math.abs(dx) > 5) {
        p.moved = true;
        scrollEl.scrollLeft = p.startScroll - dx;
        syncSticky();
      }
    });
    svg.addEventListener("pointerup", function (ev) {
      var p = insp.pan;
      insp.pan = null;
      if (!p) return;
      if (p.moved) return;
      var fr = frozenById(p.reelId);
      if (!fr || reelLocked(fr)) return;
      var box = svg.getBoundingClientRect();
      var contentX = ev.clientX - box.left;
      var frame = Math.round(frameAtX(fr, contentX));
      frame = clamp(frame, 0, fr.totalFrames);
      if (fr.id !== currentReelId()) insp.selectedReelId = fr.id;
      quickKindMenu(fr, frame, ev.clientX, ev.clientY);
    });
    svg.addEventListener("click", function (ev) {
      var fidEl = ev.target.closest ? ev.target.closest("[data-fid]") : null;
      if (!fidEl) return;
      var fid = fidEl.getAttribute("data-fid");
      var reelId = fidEl.getAttribute("data-freel");
      if (reelId && reelId !== currentReelId()) {
        insp.selectedReelId = reelId;
        renderAll();
      }
      var fr0 = frozenById(reelId || currentReelId());
      if (!fr0) return;
      var f = reelEntry(fr0.id).findings.filter(function (x) { return x.id === fid; })[0];
      if (!f) return;
      insp.selectedFindingId = fid;
      insp.draft = null;
      renderReadiness();
      renderRight();
      var li = $("#ivRight .iv-find-item.selected");
      if (li && li.scrollIntoView) li.scrollIntoView({ block: "nearest" });
    });

    scrollEl.addEventListener("wheel", function (ev) {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        zoomAtPx(ev.deltaY < 0 ? 1.18 : 0.85, ev.clientX - scrollEl.getBoundingClientRect().left);
      } else if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
        ev.preventDefault();
        scrollEl.scrollLeft += ev.deltaY;
        syncSticky();
      }
    }, { passive: false });
  }

  /* 点片体：先选问题类别再登记 */
  function quickKindMenu(fr, frame, cx, cy) {
    var existing = $("#ivKindPop");
    if (existing) existing.remove();
    var zone = classifyZone(fr, frame);
    var pop = document.createElement("div");
    pop.id = "ivKindPop";
    pop.className = "iv-kind-pop";
    pop.innerHTML =
      '<div class="iv-kind-head">登记检查结果 · ' + esc(ZONE_LABEL[zone]) +
      '<div class="iv-kind-pos">' + esc(posText(fr, frame)) + "</div></div>" +
      '<div class="iv-kind-grid">' + KINDS.map(function (k) {
        return '<button data-kind="' + k + '">' + KIND_LABEL[k] + "</button>";
      }).join("") + "</div>";
    pop.style.left = Math.min(cx, window.innerWidth - 250) + "px";
    pop.style.top = Math.min(cy, window.innerHeight - 150) + "px";
    document.body.appendChild(pop);
    var close = function () { pop.remove(); };
    setTimeout(function () {
      document.addEventListener("pointerdown", function once(e) {
        if (!pop.contains(e.target)) close();
      }, { once: true });
    }, 0);
    $$("button[data-kind]", pop).forEach(function (b) {
      b.onclick = function () {
        var kind = b.getAttribute("data-kind");
        close();
        addFindingAt(fr, frame, kind);
      };
    });
  }

  /* 缩放 */
  function zoomAtPx(factor, centerX) {
    var reels = frozenReels();
    if (!reels.length) return;
    var fr = frozenById(currentReelId()) || reels[0];
    var scrollEl = stripScroll();
    var frameCenter = frameAtX(fr, centerX + scrollEl.scrollLeft);
    insp.view.pxPerFrame = clamp(insp.view.pxPerFrame * factor, 0.02, 8);
    renderStrip();
    scrollEl.scrollLeft = xOf(fr, frameCenter) - centerX;
    syncSticky();
    updateZoomLabel();
  }
  function updateZoomLabel() {
    // 以 0.18 px/格（35mm 约 2.9 px/英尺）为 100%
    $("#ivZoomLabel").textContent = Math.round(insp.view.pxPerFrame / 0.18 * 100) + "%";
  }
  function zoomFit() {
    var reels = frozenReels();
    if (!reels.length) return;
    var fr = frozenById(currentReelId()) || reels[0];
    var avail = stripScroll().clientWidth - G.labelW - G.padX * 2;
    insp.view.pxPerFrame = clamp(avail / fr.totalFrames, 0.02, 8);
    renderStrip();
    updateZoomLabel();
  }
  function scrollToFrame(fr, frame) {
    stripScroll().scrollLeft = Math.max(0, xOf(fr, frame) - stripScroll().clientWidth * 0.35);
    syncSticky();
  }

  /* ============================================================
   * 右栏：流程 + 问题列表 + 编辑
   * ============================================================ */
  function renderRight() {
    var box = $("#ivRight");
    var fr = frozenById(currentReelId());
    if (!fr) { box.innerHTML = '<div class="iv-empty">没有可显示的卷。</div>'; return; }
    var entry = reelEntry(fr.id);
    var locked = reelLocked(fr);
    var blockers = reelBlockers(entry);
    var z = zonesOf(fr);

    var html = [];
    html.push('<div class="iv-reel-head ' + entry.status + '">' +
      '<div class="iv-reel-title">' + esc((fr.order + 1) + " · " + (fr.projector === "A" ? "甲机" : "乙机") +
        " " + fr.title) + "</div>" +
      '<div class="iv-reel-sub">' + esc(fr.gauge) + " · " + fr.fps + " fps · " + fr.fpf + " 格/英尺 · 全长 " +
      (fr.totalFrames / fr.fpf).toFixed(1) + " 英尺（" + fr.totalFrames + " 格）</div>" +
      '<div class="iv-reel-sub">片头护片 ' + (fr.headFrames / fr.fpf).toFixed(1) + " 英尺 · 片尾 " +
      (fr.tailFrames / fr.fpf).toFixed(1) + " 英尺 · 画面 " + (fr.picFrames / fr.fpf).toFixed(1) + " 英尺</div>" +
      "</div>");

    // 状态机操作
    html.push('<div class="iv-flow">');
    html.push('<div class="iv-flow-row">当前状态：<b class="iv-st-' + entry.status + '">' +
      STATUS_LABEL[entry.status] + "</b>" +
      (locked ? '<span class="iv-lock-tag">记录已封存</span>' : "") + "</div>");
    if (!locked) {
      var btns = [
        ["checking", "开始/继续检查"], ["action", "转待处置"],
        ["released", "✔ 放行本卷"], ["returned", "✖ 退回本卷"],
      ];
      html.push('<div class="iv-flow-btns">' + btns.map(function (b) {
        var cls = b[0] === "released" ? "btn-primary" : b[0] === "returned" ? "btn-danger" : "";
        var dis = b[0] === "released" && blockers.length ? " disabled" : "";
        return '<button class="btn btn-sm ' + cls + '" data-st="' + b[0] + '"' + dis + ">" + b[1] +
          (b[0] === "released" && blockers.length ? "（" + blockers.length + " 项未决）" : "") + "</button>";
      }).join("") + "</div>");
      if (entry.status === "pending")
        html.push('<div class="iv-hint">在左侧胶片带相应位置点击，即可登记检查结果。</div>');
    }
    html.push("</div>");

    // 问题列表
    var findings = (entry.findings || []).slice().sort(function (a, b) { return a.from - b.from; });
    html.push('<div class="iv-find-head">检查结果（' + findings.length + "）" +
      '<button class="btn btn-sm" id="ivAddHere" ' + (locked ? "disabled" : "") +
      ">＋ 在本卷登记</button></div>");
    if (!findings.length) {
      html.push('<div class="iv-find-empty">尚无记录。清洁、接片、齿孔与划伤均在胶片带上点选位置登记。</div>');
    } else {
      html.push('<ul class="iv-find-list">' + findings.map(function (f) {
        var zone = classifyZone(fr, Math.round((f.from + f.to) / 2));
        var open = findingOpen(f);
        var sel = f.id === insp.selectedFindingId ? " selected" : "";
        return '<li class="iv-find-item sev-' + f.severity + (open ? " open" : " resolved") + sel +
          '" data-fid="' + esc(f.id) + '">' +
          '<div class="iv-find-line"><b>' + KIND_LABEL[f.kind] + "</b>" +
          '<span class="iv-sev-tag" style="color:' + SEVERITY_COLOR[f.severity] + '">' +
          SEVERITY_LABEL[f.severity] + "</span>" +
          '<span class="iv-zone-tag">' + ZONE_LABEL[zone] + "</span>" +
          (open ? '<span class="iv-open-dot">未决</span>' : '<span class="iv-res-tag">已决</span>') +
          "</div>" +
          '<div class="iv-find-pos">' + (f.from === f.to
            ? Math.round(f.from) + " 格"
            : Math.round(f.from) + "–" + Math.round(f.to) + " 格") +
          " · " + frameToFt(fr, f.from).toFixed(2) + "ft · " + E.fmtClock(frameToTc(fr, f.from)) + "</div>" +
          (f.disposition ? '<div class="iv-find-disp">处置：' + DISP_LABEL[f.disposition] +
            (f.recheckPassed ? " · 已复查通过" : " · 待复查") + "</div>" : "") +
          "</li>";
      }).join("") + "</ul>");
    }

    // 编辑器：草稿或选中项
    if (insp.draft && locked === false) html.push(findingFormHtml(fr, insp.draft, true));
    else {
      var selF = findings.filter(function (f) { return f.id === insp.selectedFindingId; })[0];
      if (selF) html.push(findingFormHtml(fr, selF, false));
    }

    box.innerHTML = html.join("");
    bindRight(fr, entry, locked);
  }

  function findingFormHtml(fr, f, isDraft) {
    var locked = reelLocked(fr);
    var mspec = KIND_MEASURE[f.kind];
    var zone = classifyZone(fr, Math.round((+f.from + +f.to) / 2));
    var zoneWarn = (zone === "motorCue" || zone === "changeCue" || zone === "reserve" || zone === "picture");
    var val = f.measure || {};
    var h = [];
    h.push('<div class="iv-form' + (isDraft ? " draft" : "") + '">');
    h.push('<div class="iv-form-title">' + (isDraft ? "登记新检查结果" : "检查结果明细") +
      ' <span class="iv-zone-tag ' + (zoneWarn ? "warn" : "") + '">落在：' + ZONE_LABEL[zone] + "</span></div>");
    h.push('<div class="iv-pos-readout" id="ivPosReadout">' + esc(posText(fr, f.from)) + "</div>");

    // 类别
    h.push('<label class="iv-f-label">类别</label><div class="iv-kind-row">');
    KINDS.forEach(function (k) {
      h.push('<button class="btn btn-sm iv-kind-pick' + (f.kind === k ? " on" : "") +
        '" data-fk="kind" data-v="' + k + '"' + (locked ? " disabled" : "") + ">" + KIND_LABEL[k] + "</button>");
    });
    h.push("</div>");

    // 定位（英尺/时间码/格任一；这里同时给出三输入框，写格数为主，另两个即时换算）
    h.push('<div class="iv-loc-grid">' +
      locInput("from", "起 · 英尺", frameToFt(fr, f.from).toFixed(3), "ft", locked) +
      locInput("tc", "起 · 时间码", E.fmtClock(frameToTc(fr, f.from)), "tc", locked) +
      locInput("fromFrame", "起 · 格", Math.round(f.from), "frames", locked) +
      (mspec.range ? locInput("toFrame", "止 · 格", Math.round(f.to), "frames", locked) : "") +
      "</div>");

    // 测量值
    h.push('<label class="iv-f-label">' + esc(mspec.label) + "</label>");
    h.push('<div class="input-unit" style="margin-bottom:8px">' +
      '<input type="number" step="0.01" data-fk="measureValue" value="' +
        (val.value == null ? "" : val.value) + '" placeholder="数值"' + (locked ? " disabled" : "") + ">" +
      (mspec.range
        ? '<input type="number" step="0.01" data-fk="measureTo" value="' +
          (val.to == null ? "" : val.to) + '" placeholder="止" style="max-width:90px"' + (locked ? " disabled" : "") + ">"
        : "") +
      "<select disabled><option>" + esc(mspec.unit) + "</option></select></div>");

    // 严重程度
    h.push('<label class="iv-f-label">严重程度</label><div class="iv-sev-row">');
    SEVERITIES.forEach(function (sv) {
      h.push('<button class="btn btn-sm iv-sev-pick" data-fk="severity" data-v="' + sv + '"' +
        (f.severity === sv ? ' style="border-color:' + SEVERITY_COLOR[sv] + ';color:' + SEVERITY_COLOR[sv] + '"' : "") +
        (locked ? " disabled" : "") + ">" + SEVERITY_LABEL[sv] + "</button>");
    });
    h.push("</div>");

    // 备注
    h.push('<label class="iv-f-label">检查描述</label>' +
      '<textarea rows="2" data-fk="note" placeholder="位置、形态、对放映的影响…"' +
      (locked ? " disabled" : "") + ">" + esc(f.note) + "</textarea>");

    // 处置
    h.push('<label class="iv-f-label">处置（不自动修改换卷方案）</label><div class="iv-disp-row">');
    DISPOSITIONS.forEach(function (dp) {
      h.push('<button class="btn btn-sm iv-disp-pick' + (f.disposition === dp ? " on" : "") +
        '" data-fk="disposition" data-v="' + dp + '"' + (locked ? " disabled" : "") + ">" +
        DISP_LABEL[dp] + "</button>");
    });
    h.push("</div>");
    h.push('<textarea rows="1" data-fk="dispositionNote" placeholder="处置说明 / 用料 / 操作人…"' +
      (locked ? " disabled" : "") + " style='margin-top:6px'>" + esc(f.dispositionNote || "") + "</textarea>");
    if (f.disposition)
      h.push('<div class="iv-hint">处置时间：' + (f.dispositionAt ? new Date(f.dispositionAt).toLocaleString() : "—") +
        (f.recheckPassed ? " · 已复查通过" : " · 处置后须复查受影响区间") + "</div>");

    // 复查记录
    if (f.rechecks && f.rechecks.length) {
      h.push('<div class="iv-rechecks">' + f.rechecks.map(function (rc) {
        return '<div class="' + (rc.passed ? "ok" : "bad") + '">复查 ' +
          (rc.passed ? "通过" : "未过") + " · " + new Date(rc.at).toLocaleString() +
          (rc.note ? " · " + esc(rc.note) : "") + "</div>";
      }).join("") + "</div>");
    }

    // 按钮
    h.push('<div class="iv-form-btns">');
    if (isDraft) {
      h.push('<button class="btn btn-sm btn-primary" data-act="commit">保存登记</button>' +
        '<button class="btn btn-sm" data-act="cancelDraft">取消</button>');
    } else if (!locked) {
      var canRecheck = !!f.disposition && f.disposition !== "hold";
      h.push('<button class="btn btn-sm btn-primary" data-act="recheckOk"' + (canRecheck ? "" : " disabled") +
        ' title="完成处置后复查受影响区间">复查通过</button>' +
        '<button class="btn btn-sm" data-act="recheckBad"' + (canRecheck ? "" : " disabled") +
        '>复查未过</button>' +
        '<button class="btn btn-sm btn-danger" data-act="delFind">删除该项</button>');
    } else {
      h.push('<div class="iv-hint">本卷已' + (reelEntry(fr.id).status === "released" ? "放行" : "退回") +
        "，该记录不可改写。</div>");
    }
    h.push("</div></div>");
    return h.join("");
  }

  function locInput(key, label, value, unit, locked) {
    return '<div class="iv-loc"><label>' + label + "</label>" +
      '<input type="text" data-loc="' + key + '" value="' + esc(value) + '"' +
      (locked ? " disabled" : "") + "></div>";
  }

  function focusDraftFirst() {
    var el = $("#ivRight textarea[data-fk='note']");
    if (el) el.focus();
  }

  function bindRight(fr, entry, locked) {
    $$("#ivRight [data-st]").forEach(function (b) {
      b.onclick = function () { setReelStatus(entry, b.getAttribute("data-st")); };
    });
    var addBtn = $("#ivAddHere");
    if (addBtn) addBtn.onclick = function () {
      var frame = fr.headFrames + Math.round(fr.picFrames / 2);
      quickKindMenu(fr, frame, window.innerWidth - 340, window.innerHeight / 2);
    };
    $$("#ivRight .iv-find-item").forEach(function (li) {
      li.onclick = function () {
        insp.selectedFindingId = li.getAttribute("data-fid");
        insp.draft = null;
        renderRight();
      };
    });

    // 表单绑定：统一作用于草稿或已保存项（已保存项改动即时落盘）
    var target = insp.draft ||
      (entry.findings || []).filter(function (f) { return f.id === insp.selectedFindingId; })[0];
    if (!target) return;

    $$("#ivRight [data-fk]").forEach(function (b) {
      if (b.tagName === "BUTTON") {
        b.onclick = function () {
          var key = b.getAttribute("data-fk"), v = b.getAttribute("data-v");
          if (key === "kind") {
            target.kind = v;
            var ms = KIND_MEASURE[v];
            target.measure.unit = ms.unit;
            if (!ms.range) target.to = target.from;
            invalidateRecheck(target);
          } else if (key === "disposition") {
            if (insp.draft) { target.disposition = target.disposition === v ? "" : v; }
            else setDisposition(target, target.disposition === v ? "" : v);
            return;
          } else {
            target[key] = v;
            if (key === "severity") invalidateRecheck(target);
          }
          if (insp.draft) renderRight();
          else { saveSheet(); renderAll(); }
        };
      }
    });

    var noteEl = $("#ivRight textarea[data-fk='note']");
    if (noteEl) noteEl.oninput = function () {
      target.note = this.value;
      if (!insp.draft) scheduleSave();
    };
    var dnoteEl = $("#ivRight textarea[data-fk='dispositionNote']");
    if (dnoteEl) dnoteEl.oninput = function () {
      target.dispositionNote = this.value;
      if (!insp.draft) scheduleSave();
    };
    var mv = $("#ivRight input[data-fk='measureValue']");
    if (mv) mv.oninput = function () {
      target.measure.value = this.value === "" ? null : parseFloat(this.value);
      if (!insp.draft) { invalidateRecheck(target); scheduleSave(); }
    };
    var mt = $("#ivRight input[data-fk='measureTo']");
    if (mt) mt.oninput = function () {
      target.measure.to = this.value === "" ? null : parseFloat(this.value);
      if (!insp.draft) { invalidateRecheck(target); scheduleSave(); }
    };

    // 定位三联动
    var readout = $("#ivPosReadout");
    function syncReadout() { if (readout) readout.textContent = posText(fr, target.from); }
    var locMap = {
      from: $("[data-loc='from']"), tc: $("[data-loc='tc']"),
      fromFrame: $("[data-loc='fromFrame']"), toFrame: $("[data-loc='toFrame']"),
    };
    function fillLocs() {
      if (locMap.from) locMap.from.value = frameToFt(fr, target.from).toFixed(3);
      if (locMap.tc) locMap.tc.value = E.fmtClock(frameToTc(fr, target.from));
      if (locMap.fromFrame) locMap.fromFrame.value = Math.round(target.from);
      if (locMap.toFrame) locMap.toFrame.value = Math.round(target.to);
    }
    if (locMap.from) locMap.from.onchange = function () {
      var v = parseFloat(this.value);
      if (isFinite(v)) target.from = clamp(Math.round(v * fr.fpf), 0, fr.totalFrames);
      if (KIND_MEASURE[target.kind].range === false) target.to = target.from;
      afterLocChange();
    };
    if (locMap.fromFrame) locMap.fromFrame.onchange = function () {
      var v = parseInt(this.value, 10);
      if (isFinite(v)) target.from = clamp(v, 0, fr.totalFrames);
      if (KIND_MEASURE[target.kind].range === false) target.to = target.from;
      afterLocChange();
    };
    if (locMap.toFrame) locMap.toFrame.onchange = function () {
      var v = parseInt(this.value, 10);
      if (isFinite(v)) target.to = clamp(v, target.from, fr.totalFrames);
      afterLocChange();
    };
    if (locMap.tc) locMap.tc.onchange = function () {
      var sec = parseClock(this.value);
      if (sec == null) { fillLocs(); return; }
      target.from = clamp(Math.round(sec * fr.fps + fr.headFrames), 0, fr.totalFrames);
      if (KIND_MEASURE[target.kind].range === false) target.to = target.from;
      afterLocChange();
    };
    function afterLocChange() {
      if (insp.draft) {
        renderRight();
        renderStrip();
      } else {
        invalidateRecheck(target);
        var ent0 = reelEntry(fr.id);
        if (ent0.status === "checking" && reelBlockers(ent0).length) ent0.status = "action";
        saveSheet();
        renderAll();
        scrollToFrame(fr, target.from);
      }
    }

    $$("#ivRight [data-act]").forEach(function (b) {
      b.onclick = function () {
        switch (b.getAttribute("data-act")) {
          case "commit": commitDraft(); break;
          case "cancelDraft": cancelDraft(); break;
          case "delFind": deleteFinding(target); break;
          case "recheckOk": recheck(target, true); break;
          case "recheckBad":
            if (confirm("复查未过？将清除本次处置结论，转回「保留待定」。")) recheck(target, false);
            break;
        }
      };
    });
  }

  /* mm:ss.s / -mm:ss.s 解析（时间码定位框） */
  function parseClock(str) {
    var m = String(str).trim().match(/^(-?)(?:(\d+):)?(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    var v = (m[2] ? parseInt(m[2], 10) * 60 : 0) + parseFloat(m[3]);
    return m[1] === "-" ? -v : v;
  }

  /* ------------------------------------------------ 多次验片对比 */
  function fetchSheet(id) {
    if (insp.fullCache[id]) return Promise.resolve(insp.fullCache[id]);
    return COD.api("/api/inspections/" + encodeURIComponent(id)).then(function (s) {
      insp.fullCache[id] = s;
      return s;
    });
  }

  function openCompare() {
    if (!insp.sheet) return;
    var pre = [insp.sheet.id];
    $("#ivComparePick").innerHTML = insp.list.map(function (s) {
      var on = pre.indexOf(s.id) >= 0;
      return '<label class="' + (on ? "on" : "") + '"><input type="checkbox" value="' + esc(s.id) + '"' +
        (on ? " checked" : "") + ">" + esc(s.name) +
        '<span class="rh-pick-sub">' + new Date(s.createdAt).toLocaleDateString() +
        " · " + (s.openFindings || 0) + " 未决</span></label>";
    }).join("");
    $$("#ivComparePick input").forEach(function (cb) {
      cb.onchange = function () {
        cb.closest("label").classList.toggle("on", cb.checked);
        renderCompareTable();
      };
    });
    $("#ivCompareModal").hidden = false;
    renderCompareTable();
  }

  function compareKey(f) { return f.kind + "@" + Math.round(f.from) + "-" + Math.round(f.to); }

  function renderCompareTable() {
    var wrap = $("#ivCompareWrap");
    var ids = $$("#ivComparePick input:checked").map(function (x) { return x.value; });
    if (ids.length < 2) {
      wrap.innerHTML = '<p class="muted">再勾选至少一张验片单即可对照同一卷的变化。</p>';
      return;
    }
    Promise.all(ids.map(fetchSheet)).then(function (sheets) {
      var frozen = sheets[0].frozen;
      var html = ['<p class="muted">按卷并列；问题以「类别+起止格」匹配，对照严重程度、处置与复查状态。</p>'];
      frozen.reels.forEach(function (fr) {
        var grid = sheets.map(function (s) {
          var e = (s.reels || []).filter(function (r) { return r.reelId === fr.id; })[0];
          return { s: s, e: e, fs: (e ? e.findings : []) };
        });
        var total = grid.reduce(function (a, g) { return a + g.fs.length; }, 0);
        html.push('<div class="iv-cmp-reel">' + (fr.order + 1) + " · " + esc(fr.title) + "</div>");
        html.push('<table class="compare-table iv-cmp-table"><thead><tr><th>位置 / 类别</th>' +
          grid.map(function (g) {
            return "<th>" + esc(g.s.name) + '<br><span class="rh-th-sub">' +
              (g.e ? STATUS_LABEL[g.e.status] : "—") + "</span></th>";
          }).join("") + "</tr></thead><tbody>");

        // 收集该卷全部问题键
        var keys = {};
        grid.forEach(function (g) { g.fs.forEach(function (f) { keys[compareKey(f)] = f.kind; }); });
        Object.keys(keys).sort().forEach(function (key) {
          html.push("<tr><td>" + esc(KIND_LABEL[keys[key]] || key) + "<br><span class='rh-th-sub'>" +
            esc(key.split("@")[1]) + " 格</span></td>");
          grid.forEach(function (g) {
            var f = g.fs.filter(function (x) { return compareKey(x) === key; })[0];
            if (!f) { html.push('<td class="warn">未记录</td>'); return; }
            var open = findingOpen(f);
            html.push('<td class="' + (open ? "warn" : "good") + '">' +
              SEVERITY_LABEL[f.severity] +
              (f.disposition ? "<br>" + DISP_LABEL[f.disposition] : "") +
              (f.recheckPassed ? "<br>✓复查" : open ? "<br>未决" : "") + "</td>");
          });
          html.push("</tr>");
        });
        // 汇总
        html.push("<tr><td>未决 / 合计</td>" + grid.map(function (g) {
          var openN = g.fs.filter(findingOpen).length;
          return '<td class="' + (openN ? "bad" : "good") + '">' + openN + " / " + g.fs.length + "</td>";
        }).join("") + "</tr>");
        html.push("</tbody></table>");

        // 相邻两张单据的变化
        for (var i = 1; i < grid.length; i++) {
          var prev = grid[i - 1], cur = grid[i];
          var changes = diffFindings(prev.fs, cur.fs);
          if (changes.length) {
            html.push('<div class="iv-cmp-diff">' + esc(cur.s.name) + " 相对上一张：" +
              changes.map(function (c) {
                return '<span class="iv-diff-' + c.type + '">' + c.text + "</span>";
              }).join("　") + "</div>");
          }
        }
      });
      wrap.innerHTML = html.join("");
    });
  }

  function diffFindings(prevFs, curFs) {
    var out = [];
    function map(fs) {
      var m = {};
      fs.forEach(function (f) { m[compareKey(f)] = f; });
      return m;
    }
    var pm = map(prevFs), cm = map(curFs);
    Object.keys(pm).forEach(function (k) {
      if (!cm[k]) out.push({ type: "del", text: "撤销「" + KIND_LABEL[pm[k].kind] + "」" });
      else if (cm[k].severity !== pm[k].severity)
        out.push({ type: "chg", text: KIND_LABEL[cm[k].kind] + " " + SEVERITY_LABEL[pm[k].severity] +
          "→" + SEVERITY_LABEL[cm[k].severity] });
      else if (cm[k].disposition !== pm[k].disposition)
        out.push({ type: "chg", text: KIND_LABEL[cm[k].kind] + " 改处置：" +
          (DISP_LABEL[cm[k].disposition] || "无") });
      else if (cm[k].recheckPassed !== pm[k].recheckPassed)
        out.push({ type: "ok", text: KIND_LABEL[cm[k].kind] + (cm[k].recheckPassed ? " 已复查" : " 复查失效") });
    });
    Object.keys(cm).forEach(function (k) {
      if (!pm[k]) out.push({ type: "new", text: "新登记「" + KIND_LABEL[cm[k].kind] + "」" });
    });
    return out;
  }

  /* ------------------------------------------------ 导出 / 打印 */
  function exportCurrent() {
    if (!insp.sheet) return;
    var payload = {
      app: "changeover-desk", type: "inspection", version: 1,
      exportedAt: new Date().toISOString(),
      inspection: insp.sheet,
    };
    COD.downloadBlob(JSON.stringify(payload, null, 2),
      (insp.sheet.name || "inspection") + ".json", "application/json");
  }
  function exportCompare() {
    var ids = $$("#ivComparePick input:checked").map(function (x) { return x.value; });
    if (!ids.length) { alert("请先勾选验片单。"); return; }
    Promise.all(ids.map(fetchSheet)).then(function (sheets) {
      COD.downloadBlob(JSON.stringify({
        app: "changeover-desk", type: "inspections", version: 1,
        exportedAt: new Date().toISOString(), inspections: sheets,
      }, null, 2), "验片对比-" + (insp.sheet.frozen.planName || "plan") + ".json", "application/json");
    });
  }

  function printReleaseSheet() {
    var s = insp.sheet;
    if (!s) return;
    var frozen = s.frozen;
    var reelHtml = frozen.reels.map(function (fr) {
      var entry = reelEntry(fr.id);
      var findings = (entry.findings || []).slice().sort(function (a, b) { return a.from - b.from; });
      var rows = findings.map(function (f) {
        var zone = ZONE_LABEL[classifyZone(fr, Math.round((f.from + f.to) / 2))];
        return "<tr>" +
          "<td>" + (f.from === f.to ? Math.round(f.from) : Math.round(f.from) + "–" + Math.round(f.to)) + "</td>" +
          "<td>" + E.fmtClock(frameToTc(fr, f.from)) + "</td>" +
          "<td>" + KIND_LABEL[f.kind] + "</td>" +
          "<td>" + SEVERITY_LABEL[f.severity] + "</td>" +
          "<td>" + zone + "</td>" +
          "<td>" + measureText(f) + "</td>" +
          '<td class="l">' + esc(f.note || "") + "</td>" +
          "<td>" + (f.disposition ? DISP_LABEL[f.disposition] : "—") + "</td>" +
          "<td>" + (f.recheckPassed ? "通过" : findingOpen(f) ? "未决" : "—") + "</td>" +
          "</tr>";
      }).join("");
      if (!rows) rows = '<tr><td colspan="9" class="iv-print-empty">本卷检查未见异常</td></tr>';
      var st = entry.status;
      var stamp = st === "released" ? "放 行" : st === "returned" ? "退 回" : STATUS_LABEL[st];
      var miniRuler = printMiniRuler(fr, findings);
      return '<div class="iv-print-reel">' +
        '<div class="iv-print-reel-head"><b>' + (fr.order + 1) + " · " + esc(fr.title) +
        "（" + (fr.projector === "A" ? "甲机" : "乙机") + " · " + esc(fr.gauge) + " · " +
        (fr.totalFrames / fr.fpf).toFixed(1) + " 英尺）</b>" +
        '<span class="iv-print-stamp st-' + st + '">' + stamp + "</span></div>" +
        miniRuler +
        "<table><thead><tr>" +
        "<th>格位</th><th>时间码</th><th>类别</th><th>程度</th><th>分区</th><th>测量</th>" +
        "<th>检查描述</th><th>处置</th><th>复查</th></tr></thead><tbody>" + rows + "</tbody></table>" +
        "</div>";
    }).join("");

    var released = s.reels.filter(function (r) { return r.status === "released"; }).length;
    var returned = s.reels.filter(function (r) { return r.status === "returned"; }).length;
    var totalOpen = s.reels.reduce(function (a, r) { return a + reelBlockers(r).length; }, 0);

    $("#printSheet").innerHTML =
      "<h1>拷贝验片放行单 · " + esc(frozen.planName) + " · " + esc(s.name) + "</h1>" +
      '<div class="ps-meta">打印时间：' + new Date().toLocaleString() +
      "　验片员：" + esc(s.inspector || "＿＿＿＿") +
      "　卷数：" + frozen.reels.length + "（放行 " + released + " / 退回 " + returned + "）" +
      "　未决项：" + totalOpen +
      "　冻结时间：" + new Date(frozen.frozenAt).toLocaleString() +
      (s.snapshotStale ? "　<b>注意：方案此后修改过，本单按冻结快照验收</b>" : "") + "</div>" +
      (s.note ? '<div class="ps-meta">备注：' + esc(s.note) + "</div>" : "") +
      (totalOpen ? '<div class="ps-warn"><b>尚有 ' + totalOpen + " 项未决，未决卷不得放行。</b></div>" : "") +
      reelHtml +
      '<div class="ps-sign"><span>验片员</span><span>放映员</span><span>放映主管</span><span>日期</span></div>' +
      "<style>.iv-print-empty{color:#555;text-align:center}.iv-print-reel{page-break-inside:avoid;margin-bottom:6mm}" +
      ".iv-print-reel-head{display:flex;justify-content:space-between;align-items:center;margin:3mm 0 1.5mm;font-size:10.5pt}" +
      ".iv-print-stamp{border:2px solid #000;padding:1mm 4mm;font-weight:700;letter-spacing:4px}" +
      ".iv-print-stamp.st-released{border-color:#060;color:#060}.iv-print-stamp.st-returned{border-color:#a00;color:#a00}" +
      ".iv-ruler-svg{width:100%;height:26mm;margin-bottom:1mm}</style>";
    window.print();
  }

  function measureText(f) {
    var m = f.measure || {};
    if (m.value == null) return "—";
    var txt = m.value + (m.unit ? " " + m.unit : "");
    if (m.to != null) txt += " ～ " + m.to + (m.unit ? " " + m.unit : "");
    return esc(txt);
  }

  /* 打印用带定位刻度的微型胶片带 */
  function printMiniRuler(fr, findings) {
    var W = 760, H = 56;
    var x = function (frame) { return 40 + frame / fr.totalFrames * (W - 60); };
    var h = ['<svg class="iv-ruler-svg" viewBox="0 0 ' + W + " " + H + '" xmlns="http://www.w3.org/2000/svg">'];
    var z = zonesOf(fr);
    // 片体三段
    h.push('<rect x="' + x(0) + '" y="16" width="' + (x(fr.headFrames) - x(0)) + '" height="16" fill="#ddd" stroke="#000" stroke-width=".6"/>');
    h.push('<rect x="' + x(fr.headFrames) + '" y="16" width="' + (x(fr.headFrames + fr.picFrames) - x(fr.headFrames)) +
      '" height="16" fill="#bfe6dd" stroke="#000" stroke-width=".6"/>');
    h.push('<rect x="' + x(fr.headFrames + fr.picFrames) + '" y="16" width="' +
      (x(fr.totalFrames) - x(fr.headFrames + fr.picFrames)) + '" height="16" fill="#ddd" stroke="#000" stroke-width=".6"/>');
    // 英尺刻度
    var ftStep = fr.totalFrames / fr.fpf > 200 ? 100 : fr.totalFrames / fr.fpf > 60 ? 25 : 10;
    for (var ft = 0; ft * fr.fpf <= fr.totalFrames; ft += ftStep) {
      var xx = x(ft * fr.fpf);
      h.push('<line x1="' + xx + '" y1="32" x2="' + xx + '" y2="38" stroke="#000" stroke-width=".7"/>');
      h.push('<text x="' + xx + '" y="48" font-size="7" text-anchor="middle">' + ft + "ft</text>");
    }
    // 提示线
    h.push(cuePrintLine(x(fr.motorOffMid), "#8a5f22", "马达"));
    h.push(cuePrintLine(x(fr.changeOffMid), "#a00", "切换"));
    // 问题
    findings.forEach(function (f) {
      var col = { info: "#777", minor: "#0a7d6a", major: "#b0741a", critical: "#c00" }[f.severity] || "#333";
      h.push('<polygon points="' + x(f.from) + ",8 " + (x(f.from) - 4) + ",16 " + (x(f.from) + 4) +
        ',16" fill="' + col + '"/>');
      if (f.to > f.from)
        h.push('<line x1="' + x(f.from) + '" y1="10" x2="' + x(f.to) + '" y2="10" stroke="' + col +
          '" stroke-width="2.5"/>');
    });
    // 段标签
    h.push('<text x="' + (x(fr.headFrames) / 2 + x(0) / 2) + '" y="27" font-size="7.5" text-anchor="middle">片头护片</text>');
    h.push('<text x="' + (x(fr.headFrames) + x(fr.headFrames + fr.picFrames)) / 2 +
      '" y="27" font-size="7.5" text-anchor="middle">画面段 ' + (fr.picFrames / fr.fpf).toFixed(0) + "ft</text>");
    h.push("</svg>");
    return h.join("");
  }
  function cuePrintLine(x, col, name) {
    return '<line x1="' + x + '" y1="10" x2="' + x + '" y2="36" stroke="' + col +
      '" stroke-width="1.1" stroke-dasharray="3 2"/><text x="' + (x + 2) + '" y="12" font-size="7" fill="' +
      col + '">' + name + "</text>";
  }

  /* ------------------------------------------------ 事件绑定 */
  function bind() {
    $("#btnInspection").addEventListener("click", openView);
    $("#ivClose").addEventListener("click", closeView);
    $("#ivNew").addEventListener("click", function () { createSheet(); });
    $("#ivSelect").addEventListener("change", function () { loadSheet(this.value); });
    $("#ivDelete").addEventListener("click", deleteSheet);
    $("#ivCompare").addEventListener("click", openCompare);
    $("#ivCompareExport").addEventListener("click", exportCompare);
    $("#ivExport").addEventListener("click", exportCurrent);
    $("#ivPrint").addEventListener("click", printReleaseSheet);
    $("#ivZoomIn").addEventListener("click", function () { zoomAtPx(1.25, stripScroll().clientWidth / 2); });
    $("#ivZoomOut").addEventListener("click", function () { zoomAtPx(0.8, stripScroll().clientWidth / 2); });
    $("#ivZoomFit").addEventListener("click", zoomFit);
    $$("[data-unit]").forEach(function (b) {
      b.addEventListener("click", function () {
        insp.rulerUnit = b.getAttribute("data-unit");
        $$("[data-unit]").forEach(function (x) { x.classList.toggle("on", x === b); });
        renderStrip();
      });
    });
    $("#ivName").addEventListener("change", function () {
      if (!insp.sheet || allTerminal()) return;
      insp.sheet.name = this.value.trim() || insp.sheet.name;
      saveSheet(); renderSelect();
    });
    $("#ivInspector").addEventListener("change", function () {
      if (!insp.sheet || allTerminal()) return;
      insp.sheet.inspector = this.value.trim();
      saveSheet();
    });
    $$("[data-close]").forEach(function (b) {
      var target = b.getAttribute("data-close");
      if (target === "ivCompareModal") b.addEventListener("click", function () { $("#ivCompareModal").hidden = true; });
    });
    $("#ivCompareModal").addEventListener("pointerdown", function (ev) {
      if (ev.target === this) this.hidden = true;
    });
    window.addEventListener("resize", function () {
      if (isOpen() && insp.sheet) renderStrip();
    });
    // 主界面快捷键（空格等）在验片视图不响应：app.js 以 rehearsal-open 判断，补一个
    document.addEventListener("keydown", function (ev) {
      if (isOpen() && ev.code === "Escape") {
        var pop = $("#ivKindPop");
        if (pop) pop.remove();
        else if (insp.draft) cancelDraft();
      }
    });
  }

  bind();
})();
