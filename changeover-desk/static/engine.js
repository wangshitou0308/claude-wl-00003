/* ============================================================
 * engine.js —— 双机换卷推演核心（纯函数，无 DOM 依赖）
 * 挂载到 window.Engine
 *
 * 时间约定（秒）：
 *   每卷在自己的机器轴上：
 *     motorStart  = pictureStart - accel            （马达提前启动）
 *     motorCue    = pictureStart + cueOffM          （马达提示绝对时刻）
 *     changeCue   = pictureStart + cueOffC          （切换提示绝对时刻）
 *     picEnd      = pictureStart + picSec
 *     stopTime    = changeCue + tailRunoff          （片尾跑完后停机）
 *     rewindEnd   = stopTime + picSec/rewindFactor  （回卷完成）
 *     threadedFor = rewindEnd + laceSec             （挂好下一卷）
 *   银幕：本卷画面在 [pictureStart, changeCue] 内由本机投射；
 *         changeCue 起切到下一卷（下一卷 pictureStart 即此刻）。
 * ============================================================ */
(function () {
  "use strict";

  // 各规格每英尺格数（标准规格）
  var FRAMES_PER_FOOT = {
    "35mm": 16,
    "16mm": 40,
    "8mm": 80,    // 标准 Regular 8
    "super8": 72, // Super 8
  };

  var SETTING_DEFAULTS = {
    fps: 24,
    gauge: "35mm",
    cueRef: "tail",          // tail=距画面末尾格数；head=距物理片头格数
    headLeaderFt: 12,        // 默认片头保护（英尺）
    tailLeaderFt: 4,         // 默认片尾保护（英尺）
    motorLeadSec: 8,         // 首卷马达提前启动秒数
    minMotorLeadSec: 7,      // 马达提示与切换提示的最小间隔（标准 12ft-1.5ft≈7秒）
    accelSec: 1,             // 马达加速稳形时间
    minHeadReserveSec: 0,    // 片头储备最小秒数（0=允许容差内的标准重叠）
    gapToleranceSec: 1,      // 空档/重叠判定容差（重叠<=容差视为标准重叠）
    tailRunoffSec: 3,        // 切换后跑完片尾再停机
    laceSec: 60,             // 回卷后挂片时间
    rewindFactor: 4,         // 回卷速度 = 放映速度 ×N
    rewindMode: "serial",    // serial=停机才回卷 / parallel=切换后立即回卷
    turnaroundBufferSec: 10, // 再次就绪距下一马达启动的最小提前量
  };

  var ISSUE_SEVERITY = {
    range: "error",       // 范围倒置
    cueOutOfRange: "error",
    cueInLeader: "warning",
    cueReverse: "error",
    leadShort: "error",
    gap: "warning",
    overlap: "error",
    reserve: "error",
    sameProjector: "error",
    turnaround: "error",
    notAlternating: "warning",
    firstHead: "warning",
  };

  var ISSUE_LABEL = {
    range: "提示范围倒置",
    cueOutOfRange: "提示位置越界",
    cueInLeader: "提示落在护片段",
    cueReverse: "马达/切换提示倒置",
    leadShort: "马达提示提前量不足",
    gap: "画面空档",
    overlap: "画面重叠",
    reserve: "片头储备不足",
    sameProjector: "相邻卷同机冲突",
    turnaround: "来不及周转",
    notAlternating: "卷序未双机交替",
    firstHead: "首卷片头储备不足",
  };

  function uid(prefix) {
    return (
      (prefix || "id") +
      "_" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function num(v, fallback) {
    var n = parseFloat(v);
    return isFinite(n) ? n : fallback === undefined ? 0 : fallback;
  }

  function positive(v, fallback) {
    var n = parseFloat(v);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function normRange(v, uncertain) {
    // 统一成 {min, max, mid, uncertain}
    if (v && typeof v === "object") {
      var lo = parseFloat(v.min);
      var hi = parseFloat(v.max);
      if (!isFinite(lo)) lo = isFinite(hi) ? hi : 0;
      if (!isFinite(hi)) hi = lo;
      if (lo > hi) { var t = lo; lo = hi; hi = t; }
      return { min: lo, max: hi, mid: (lo + hi) / 2, uncertain: !!uncertain || hi !== lo, swapped: parseFloat(v.min) > parseFloat(v.max) };
    }
    var x = parseFloat(v);
    if (!isFinite(x)) x = 0;
    return { min: x, max: x, mid: x, uncertain: !!uncertain };
  }

  function makeSettings(input) {
    var s = {}, k;
    for (k in SETTING_DEFAULTS) s[k] = SETTING_DEFAULTS[k];
    if (input) for (k in input) if (k in s) s[k] = input[k];
    // 数值字段归一
    ["fps", "headLeaderFt", "tailLeaderFt", "motorLeadSec", "minMotorLeadSec",
     "accelSec", "minHeadReserveSec", "gapToleranceSec", "tailRunoffSec",
     "laceSec", "rewindFactor", "turnaroundBufferSec"].forEach(function (f) {
      s[f] = parseFloat(s[f]);
      if (!isFinite(s[f])) s[f] = SETTING_DEFAULTS[f];
    });
    if (!(s.gauge in FRAMES_PER_FOOT)) s.gauge = "35mm";
    if (s.rewindMode !== "parallel") s.rewindMode = "serial";
    if (s.cueRef !== "head") s.cueRef = "tail";
    if (!(s.fps > 0)) s.fps = 24;
    if (!(s.rewindFactor > 0)) s.rewindFactor = 4;
    return s;
  }

  function makeReel(index) {
    return {
      id: uid("reel"),
      title: "第 " + (index + 1) + " 卷",
      fps: 24,
      gauge: "35mm",
      lengthUnit: "ft",       // ft / m / sec / frames
      lengthValue: 900,       // 画面长度数值（不含护片）
      headLeaderFt: 12,
      tailLeaderFt: 4,
      motorCue: 192,          // 距画面末尾 12ft @16格/ft
      motorCueMax: null,
      motorCueU: false,
      changeCue: 24,          // 距画面末尾 1.5ft
      changeCueMax: null,
      changeCueU: false,
      projector: index % 2 === 0 ? "A" : "B",
      locked: false,
      note: "",
    };
  }

  function reelFps(reel, settings) {
    var f = parseFloat(reel.fps);
    if (!isFinite(f) || f <= 0) f = settings.fps;
    return f;
  }

  // 画面格数
  function pictureFrames(reel, settings) {
    var fps = reelFps(reel, settings);
    var fpf = FRAMES_PER_FOOT[reel.gauge] || FRAMES_PER_FOOT[settings.gauge];
    var v = parseFloat(reel.lengthValue);
    if (!isFinite(v)) v = 0;
    switch (reel.lengthUnit) {
      case "frames": return Math.max(0, Math.round(v));
      case "sec":    return Math.max(0, Math.round(v * fps));
      case "m":      // 米 -> 英尺 -> 格
        return Math.max(0, Math.round((v / 0.3048) * fpf));
      case "ft":
      default:       return Math.max(0, Math.round(v * fpf));
    }
  }

  // 提示格数 -> 相对本卷物理片头的偏移（格）
  function cueOffsetFromHead(range, reel, picFrames, settings) {
    var headFrames = num(reel.headLeaderFt, settings.headLeaderFt) *
      (FRAMES_PER_FOOT[reel.gauge] || FRAMES_PER_FOOT[settings.gauge]);
    var out = { min: 0, max: 0, mid: 0, uncertain: range.uncertain };
    if (settings.cueRef === "head") {
      out.min = range.min;
      out.max = range.max;
    } else {
      // 距画面末尾：偏移 = 护片 + 画面 - cue
      out.min = headFrames + picFrames - range.max;
      out.max = headFrames + picFrames - range.min;
    }
    out.mid = (out.min + out.max) / 2;
    return out;
  }

  function makeIssue(spec) {
    return {
      id: uid("iss"),
      kind: spec.kind,
      severity: spec.severity || ISSUE_SEVERITY[spec.kind] || "warning",
      label: ISSUE_LABEL[spec.kind] || spec.kind,
      message: spec.message,
      reelId: spec.reelId || null,
      otherReelId: spec.otherReelId || null,
      cue: spec.cue || null,          // 'motor' | 'change' | null
      t: spec.t === undefined ? null : spec.t,
      doubtful: !!spec.doubtful,
      amount: spec.amount === undefined ? null : spec.amount, // 秒（正短/负长）
    };
  }

  /* ----------------------------------------------------------
   * analyzePlan(plan) -> 完整推演结果
   * ---------------------------------------------------------- */
  function analyzePlan(plan) {
    var settings = makeSettings(plan.settings);
    var raw = Array.isArray(plan.reels) ? plan.reels.slice() : [];
    // 卷序按数组顺序；保留序号
    var reels = raw.map(function (r, i) {
      var reel = shallowMerge(makeReel(i), r);
      reel.order = i;
      if (reel.projector !== "B") reel.projector = "A";
      return reel;
    });

    var issues = [];
    var computed = [];
    var events = [];

    // 1) 逐卷静态换算
    reels.forEach(function (reel, idx) {
      var fps = reelFps(reel, settings);
      var fpf = FRAMES_PER_FOOT[reel.gauge] || FRAMES_PER_FOOT[settings.gauge];
      var headFt = num(reel.headLeaderFt, settings.headLeaderFt);
      var tailFt = num(reel.tailLeaderFt, settings.tailLeaderFt);
      var headFrames = headFt * fpf;
      var tailFrames = tailFt * fpf;
      var pic = pictureFrames(reel, settings);
      var totalFrames = Math.round(headFrames + pic + tailFrames);
      var picSec = pic / fps;

      var motor = normRange(reel.motorCueMax != null && reel.motorCueMax !== ""
        ? { min: reel.motorCue, max: reel.motorCueMax } : reel.motorCue, reel.motorCueU);
      var change = normRange(reel.changeCueMax != null && reel.changeCueMax !== ""
        ? { min: reel.changeCue, max: reel.changeCueMax } : reel.changeCue, reel.changeCueU);

      var mOff = cueOffsetFromHead(motor, reel, pic, settings);
      var cOff = cueOffsetFromHead(change, reel, pic, settings);

      // 范围倒置
      [["motor", motor], ["change", change]].forEach(function (pair) {
        if (pair[1].swapped) {
          issues.push(makeIssue({
            kind: "range", reelId: reel.id, cue: pair[0],
            message: "《" + reel.title + "》" +
              (pair[0] === "motor" ? "马达提示" : "切换提示") +
              "范围起止倒置，已按较小值处理，需核对。",
            doubtful: false,
          }));
        }
      });

      var totalCueSpan = headFrames + pic; // 画面末尾（相对物理片头）
      function checkBound(range, off, cueName) {
        if (range.min < 0 || range.max < 0 ||
            (settings.cueRef === "tail" && (range.min > pic || range.max > pic)) ||
            (settings.cueRef === "head" && (off.min < 0 || off.max > totalFrames))) {
          issues.push(makeIssue({
            kind: "cueOutOfRange", reelId: reel.id, cue: cueName,
            message: "《" + reel.title + "》" + cueName +
              "提示超出本卷" + (settings.cueRef === "tail" ? "画面" : "全片") + "范围。",
          }));
        } else if (settings.cueRef === "head" &&
                   (off.min < headFrames || off.max < headFrames)) {
          issues.push(makeIssue({
            kind: "cueInLeader", reelId: reel.id, cue: cueName,
            message: "《" + reel.title + "》" + cueName + "提示落在片头护片段内，请确认。",
            doubtful: range.uncertain,
          }));
        } else if (settings.cueRef === "head" &&
                   (off.min > headFrames + pic || off.max > headFrames + pic)) {
          issues.push(makeIssue({
            kind: "cueInLeader", reelId: reel.id, cue: cueName,
            message: "《" + reel.title + "》" + cueName + "提示落在片尾护片段内，请确认。",
            doubtful: range.uncertain,
          }));
        }
      }
      checkBound(motor, mOff, "motor");
      checkBound(change, cOff, "change");

      // 物理偏移口径：motor 提示应早于 change 提示
      var offLeadMin = (cOff.max - mOff.max) / fps; // 最不利（间隔最小）
      var offLeadMax = (cOff.min - mOff.min) / fps; // 最有利（间隔最大）
      var reverseDef = offLeadMax < 0;
      var reverseDoubt = !reverseDef && offLeadMin < 0;
      if (reverseDef || reverseDoubt) {
        issues.push(makeIssue({
          kind: "cueReverse", reelId: reel.id,
          message: "《" + reel.title + "》马达提示晚于切换提示（倒置）" +
            (reverseDoubt ? "，范围重叠，需现场核对。" : "。"),
          doubtful: reverseDoubt,
        }));
      } else if (offLeadMax < settings.minMotorLeadSec) {
        issues.push(makeIssue({
          kind: "leadShort", reelId: reel.id, cue: "motor",
          message: "《" + reel.title + "》马达提示仅提前 " +
            fmtSigned(offLeadMax, 1) + " 秒，要求 ≥ " +
            settings.minMotorLeadSec + " 秒。",
          amount: settings.minMotorLeadSec - offLeadMax,
        }));
      } else if (offLeadMin < settings.minMotorLeadSec) {
        issues.push(makeIssue({
          kind: "leadShort", reelId: reel.id, cue: "motor", doubtful: true,
          message: "《" + reel.title + "》马达提示提前量可能不足 " +
            settings.minMotorLeadSec + " 秒（存疑范围）。",
          amount: settings.minMotorLeadSec - offLeadMin,
        }));
      }

      computed.push({
        reel: reel,
        idx: idx,
        fps: fps,
        fpf: fpf,
        headFrames: headFrames,
        tailFrames: tailFrames,
        picFrames: pic,
        totalFrames: totalFrames,
        picSec: picSec,
        totalSec: totalFrames / fps,
        motor: motor,
        change: change,
        mOff: mOff,
        cOff: cOff,
        cueLeadMin: offLeadMin,
        cueLeadMax: offLeadMax,
      });
    });

    // 2) 时刻链
    // 物理卷从物理片头开始走片；动作片头(画面开始)在 headLeader 之后。
    // 首卷：画面开始取 0（开映），开映前手动启动马达。
    // 双机衔接：上一卷切换提示触发切换；为保证切换时下一卷已稳速、
    // 且其切换标记正好到达片窗，下一卷动作片头须在切换前提前进入——
    // 即 pictureStart(i+1) = changeT(i) - 本卷切换标记距画面末尾的秒数
    // （标准 SMPTE 24 格标记 => 两卷画面在银幕重叠约 1 秒）。
    var picStart = 0;
    computed.forEach(function (c, idx) {
      c.pictureStart = picStart;
      c.headStart = picStart - c.headFrames / c.fps;
      c.motorCueT = picStart + c.mOff.mid / c.fps;
      c.changeCueT = picStart + c.cOff.mid / c.fps;
      c.motorCueMin = picStart + c.mOff.min / c.fps;
      c.motorCueMax = picStart + c.mOff.max / c.fps;
      c.changeCueMin = picStart + c.cOff.min / c.fps;
      c.changeCueMax = picStart + c.cOff.max / c.fps;
      c.picEnd = picStart + c.picSec;
      if (idx === 0) {
        // 开映前手动启动：动作片头到达片窗时已稳速，并提前 motorLeadSec
        c.motorStart = Math.min(
          picStart - settings.accelSec,
          picStart - settings.motorLeadSec
        );
      } else {
        // 上一卷的马达提示 = 本机启动信号；本机动作片头随后走片
        c.motorStart = computed[idx - 1].motorCueT - settings.accelSec;
      }
      c.stopTime = c.changeCueT + settings.tailRunoffSec;
      // 回卷所需时长（回卷画面+护片总长）
      c.rewindSec = c.totalSec / settings.rewindFactor;
      var rewindBase = settings.rewindMode === "parallel" ? c.changeCueT : c.stopTime;
      c.rewindEnd = rewindBase + c.rewindSec;
      c.threadedFor = c.rewindEnd + settings.laceSec;
      if (idx < computed.length - 1) {
        var nc2 = computed[idx + 1];
        // 衔接原则：下一卷动作片头到达片窗时，本卷正好放完画面末尾，
        // 银幕内容不中断；随后本卷仍走片尾，下一卷走自己的片头/画面，
        // 到本卷切换提示处切机（标准 SMPTE 下两机画面重叠约 1 秒）。
        picStart = c.picEnd;
      }
    });

    // 3) 银幕画面连续性、同机/周转、操作事件
    computed.forEach(function (c, idx) {
      var reel = c.reel;
      var projName = reel.projector === "A" ? "甲机" : "乙机";
      // 本卷的马达提示 = 下一台机器的启动信号
      events.push(evt(c, "start", c.motorStart,
        idx === 0 ? "开映前手动启动" + projName + "《" + reel.title + "》"
                  : projName + " 启动《" + reel.title + "》（按上一卷马达提示）"));
      if (idx < computed.length - 1) {
        var nc = computed[idx + 1];
        events.push(evt(c, "motor", c.motorCueT,
          "马达提示：启动" + (nc.reel.projector === "A" ? "甲机" : "乙机") +
          "《" + nc.reel.title + "》"));
      } else {
        events.push(evt(c, "motor", c.motorCueT,
          "末卷马达提示标记（无下一卷）"));
      }
      events.push(evt(c, "change", c.changeCueT,
        "切换至《" + reel.title + "》（切换提示）"));
      events.push(evt(c, "stop", c.stopTime,
        projName + " 停机《" + reel.title + "》"));
      if (idx < computed.length - 1) {
        events.push(evt(c, "ready", c.threadedFor,
          projName + " 回卷挂片就绪（《" + reel.title + "》之后）"));
      }

      if (idx === 0) {
        // 首卷片头储备：启动稳速后到动作片头的护片余量
        var headAvail = c.headFrames / c.fps - settings.accelSec;
        var need0 = settings.minHeadReserveSec;
        if (headAvail < need0) {
          issues.push(makeIssue({
            kind: "firstHead", reelId: reel.id,
            message: "首卷《" + reel.title + "》片头护片启动稳速后余量仅 " +
              fmtSigned(headAvail, 1) + " 秒，要求 ≥ " + fmtSigned(need0, 1) + " 秒。",
            amount: need0 - headAvail,
          }));
        }
      }

      var next = computed[idx + 1];
      if (!next) return;

      // 空档 / 重叠（两台机器画面段在银幕上的实际覆盖）：
      // 本卷画面 [pictureStart, picEnd]；下卷画面 [next.pictureStart, next.picEnd]。
      // 调度保证下卷「切换标记」落在本卷 changeCueT；但两段画面的相对位置
      // 由各自护片长度与提示位置决定：
      //   gap>0 本卷画面放完后、下卷画面才到（黑场）
      //   gap<0 两段画面在银幕同时可见（重叠）；标准 SMPTE 约 −1 秒
      var gapMid = next.pictureStart - c.picEnd;
      var nextChangeFromEndMin = (settings.cueRef === "tail"
        ? next.change.min
        : next.headFrames + next.picFrames - next.cOff.max) / next.fps;
      var nextChangeFromEndMax = (settings.cueRef === "tail"
        ? next.change.max
        : next.headFrames + next.picFrames - next.cOff.min) / next.fps;
      // next.pictureStart = c.changeCueT − 下卷 change-from-end
      var gapLo = c.changeCueMin - nextChangeFromEndMax - c.picEnd;
      var gapHi = c.changeCueMax - nextChangeFromEndMin - c.picEnd;
      var doubtfulGap = c.change.uncertain || next.change.uncertain;
      if (gapLo > settings.gapToleranceSec) {
        issues.push(makeIssue({
          kind: "gap", reelId: reel.id, otherReelId: next.reel.id, t: c.changeCueT,
          message: "《" + reel.title + "》→《" + next.reel.title +
            "》切换时银幕空档约 " + fmtSigned(gapMid, 1) + " 秒（切换点早于下一卷画面）。",
          amount: Math.max(0, gapMid - settings.gapToleranceSec),
          doubtful: doubtfulGap,
        }));
      } else if (gapHi < -settings.gapToleranceSec) {
        issues.push(makeIssue({
          kind: "overlap", reelId: reel.id, otherReelId: next.reel.id, t: c.changeCueT,
          message: "《" + reel.title + "》与《" + next.reel.title +
            "》画面在银幕重叠约 " + fmtSigned(-gapMid, 1) + " 秒，超过接片容差。",
          amount: Math.max(0, -gapMid - settings.gapToleranceSec),
          doubtful: doubtfulGap,
        }));
      } else if (gapLo > settings.gapToleranceSec || gapHi < -settings.gapToleranceSec) {
        issues.push(makeIssue({
          kind: gapLo > settings.gapToleranceSec ? "gap" : "overlap",
          reelId: reel.id, otherReelId: next.reel.id, t: c.changeCueT,
          message: "《" + reel.title + "》→《" + next.reel.title +
            "》衔接" + (gapLo > settings.gapToleranceSec ? "空档" : "重叠") +
            "落在存疑范围内，需核对提示位置。",
          amount: 0, doubtful: true,
        }));
      }

      // 片头储备：下一卷片头护片须覆盖「物理片头 → 切换标记」之间的走片
      // reserve = 护片时长 - (切换偏移 - 马达提示偏移)
      var reserveMid = next.headFrames / next.fps -
        (next.cOff.mid - next.mOff.mid) / next.fps;
      var reserveLo = next.headFrames / next.fps -
        (next.cOff.max - next.mOff.min) / next.fps;
      var reserveHi = next.headFrames / next.fps -
        (next.cOff.min - next.mOff.max) / next.fps;
      var reserveDoubt = next.change.uncertain || next.motor.uncertain;
      if (reserveHi < settings.minHeadReserveSec - settings.gapToleranceSec) {
        issues.push(makeIssue({
          kind: "reserve", reelId: next.reel.id, otherReelId: reel.id,
          cue: "motor", t: c.motorCueT,
          message: "《" + next.reel.title + "》片头储备不足：启动到切换需走过的护片比实际多 " +
            fmtSigned(-reserveMid, 1) + " 秒（须 ≤ 护片 + 容差）。",
          amount: settings.gapToleranceSec - reserveMid,
          doubtful: reserveDoubt,
        }));
      } else if (reserveLo < settings.minHeadReserveSec - settings.gapToleranceSec) {
        issues.push(makeIssue({
          kind: "reserve", reelId: next.reel.id, otherReelId: reel.id,
          cue: "motor", t: c.motorCueT, doubtful: true,
          message: "《" + next.reel.title + "》片头储备可能不足（提示存疑范围所致）。",
          amount: settings.gapToleranceSec - reserveLo,
        }));
      }

      // 同机 / 交替
      if (reel.projector === next.reel.projector) {
        issues.push(makeIssue({
          kind: "sameProjector", reelId: reel.id, otherReelId: next.reel.id,
          t: c.changeCueT,
          message: "《" + reel.title + "》与《" + next.reel.title +
            "》排在同一台（" +
            (reel.projector === "A" ? "甲机" : "乙机") +
            "），双机放映无法衔接，请换机。",
        }));
      } else if (idx > 0) {
        var prev = computed[idx - 1];
        if (prev.reel.projector === next.reel.projector) {
          // A B A 正常；这里只在非严格交替时提示
        }
      }

      // 周转：上一卷在本台机器就绪时刻 vs 下一次本台机器需要马达启动的时刻
      var deadlineReel = nextSameMachine(computed, idx);
      if (deadlineReel) {
        var deadline = deadlineReel.motorStart - settings.turnaroundBufferSec;
        var slackMin = deadline - c.threadedFor; // 用中点足够性
        // 存疑：deadline 受 motor 范围影响
        var deadlineLo = deadlineReel.motorStart -
          (deadlineReel.motorCueMax - deadlineReel.motorCueT) -
          settings.turnaroundBufferSec;
        var slackLo = deadlineLo - c.threadedFor;
        if (slackMin < 0) {
          issues.push(makeIssue({
            kind: "turnaround", reelId: reel.id, otherReelId: deadlineReel.reel.id,
            t: c.changeCueT,
            message: (reel.projector === "A" ? "甲机" : "乙机") +
              "放完《" + reel.title + "》后来不及在《" + deadlineReel.reel.title +
              "》前回卷就绪，还差约 " + fmtSigned(-slackMin, 0) + " 秒。",
            amount: -slackMin,
          }));
        } else if (slackLo < 0) {
          issues.push(makeIssue({
            kind: "turnaround", reelId: reel.id, otherReelId: deadlineReel.reel.id,
            t: c.changeCueT, doubtful: true,
            message: (reel.projector === "A" ? "甲机" : "乙机") +
              "周转余量可能不足（存疑提示范围）。",
            amount: -slackLo,
          }));
        }
        c.turnaround = {
          deadlineReelId: deadlineReel.reel.id,
          deadlineT: deadline,
          readyT: c.threadedFor,
          slack: slackMin,
        };
      }
    });

    // 非交替警告（不等于同机：用于发现 A B B A 中的模式）——已被同机覆盖，此处跳过

    // 事件排序：同时刻 start < motor < change < stop < ready
    var orderRank = { start: 0, motor: 1, change: 2, stop: 3, ready: 4 };
    events.sort(function (a, b) {
      return a.t - b.t || orderRank[a.kind] - orderRank[b.kind] || a.idx - b.idx;
    });

    // 时间域
    var tMin = computed.length ? computed[0].motorStart : -10;
    var tMax = computed.length
      ? Math.max.apply(null, computed.map(function (c) {
          return Math.max(c.picEnd, c.threadedFor, c.stopTime);
        }))
      : 60;

    var stats = buildStats(computed, issues, settings);
    return {
      settings: settings,
      reels: reels,
      computed: computed,
      issues: issues,
      events: events,
      tMin: tMin,
      tMax: tMax,
      stats: stats,
    };
  }

  function nextSameMachine(computed, idx) {
    var proj = computed[idx].reel.projector;
    for (var j = idx + 1; j < computed.length; j++) {
      if (computed[j].reel.projector === proj) return computed[j];
    }
    return null;
  }

  function evt(c, kind, t, label) {
    return {
      id: c.reel.id + "_" + kind,
      reelId: c.reel.id,
      idx: c.idx,
      projector: c.reel.projector,
      kind: kind,
      t: t,
      label: label,
    };
  }

  function buildStats(computed, issues, settings) {
    var errorN = 0, warnN = 0, doubtN = 0;
    issues.forEach(function (i) {
      if (i.severity === "error") errorN++; else warnN++;
      if (i.doubtful) doubtN++;
    });
    var gap = 0, overlap = 0, turnaroundShort = 0;
    computed.forEach(function (c, idx) {
      var next = computed[idx + 1];
      if (!next) return;
      var g = next.pictureStart - c.picEnd;
      if (g > settings.gapToleranceSec) gap += g;
      if (g < -settings.gapToleranceSec) overlap += -g;
      if (c.turnaround && c.turnaround.slack < 0)
        turnaroundShort += -c.turnaround.slack;
    });
    var showStart = computed.length ? computed[0].pictureStart : 0;
    var showEnd = computed.length
      ? computed[computed.length - 1].changeCueT + settings.tailRunoffSec : 0;
    return {
      reelCount: computed.length,
      errorCount: errorN,
      warningCount: warnN,
      doubtfulCount: doubtN,
      totalGap: gap,
      totalOverlap: overlap,
      turnaroundShort: turnaroundShort,
      showStart: showStart,
      showEnd: showEnd,
      showDuration: showEnd - showStart,
    };
  }

  function shallowMerge(base, over) {
    var out = {};
    for (var k in base) out[k] = base[k];
    if (over) for (var k2 in over) out[k2] = over[k2];
    return out;
  }

  /* ----------------------------------------------------------
   * 时间格式化
   * ---------------------------------------------------------- */
  function pad(n, w) {
    var s = Math.round(n).toString();
    while (s.length < (w || 2)) s = "0" + s;
    return s;
  }

  // 时间轴钟点：mm:ss.s（可负）
  function fmtClock(t, withFrac) {
    if (!isFinite(t)) return "--:--";
    var neg = t < 0;
    var a = Math.abs(t);
    var m = Math.floor(a / 60);
    var s = a - m * 60;
    var str = pad(m, 2) + ":" + (s < 10 ? "0" : "") + s.toFixed(withFrac === false ? 0 : 1);
    return (neg ? "−" : "") + str;
  }

  // 相对秒时长：1h02′03″
  function fmtDuration(t) {
    if (!isFinite(t)) return "--";
    var neg = t < 0;
    var a = Math.round(Math.abs(t));
    var h = Math.floor(a / 3600);
    var m = Math.floor((a % 3600) / 60);
    var s = a % 60;
    var str;
    if (h > 0) str = h + "h" + pad(m) + "′" + pad(s) + "″";
    else if (m > 0) str = m + "′" + pad(s) + "″";
    else str = s + "″";
    return neg ? "−" + str : str;
  }

  // 格:帧 风格（用于提示单），fps 给定时
  function fmtTimecode(t, fps) {
    var neg = t < 0;
    var total = Math.abs(t) * (fps || 24);
    var frames = Math.round(total);
    var f = frames % (fps || 24);
    var secs = Math.floor(frames / (fps || 24));
    var s = secs % 60;
    var m = Math.floor(secs / 60) % 60;
    var h = Math.floor(secs / 3600);
    return (neg ? "−" : "") + pad(h) + ":" + pad(m) + ":" + pad(s) + ":" + pad(f);
  }

  function fmtSigned(t, digits) {
    if (!isFinite(t)) return "-";
    return (t < 0 ? "−" : "") + Math.abs(t).toFixed(digits === undefined ? 1 : digits);
  }

  window.Engine = {
    FRAMES_PER_FOOT: FRAMES_PER_FOOT,
    SETTING_DEFAULTS: SETTING_DEFAULTS,
    ISSUE_LABEL: ISSUE_LABEL,
    uid: uid,
    num: num,
    positive: positive,
    normRange: normRange,
    makeSettings: makeSettings,
    makeReel: makeReel,
    reelFps: reelFps,
    pictureFrames: pictureFrames,
    analyzePlan: analyzePlan,
    fmtClock: fmtClock,
    fmtDuration: fmtDuration,
    fmtTimecode: fmtTimecode,
    fmtSigned: fmtSigned,
  };
})();
