/* ============================================================
 * engine.js —— 双机换卷推演核心（纯函数，无 DOM 依赖）
 * 挂载到 window.Engine
 *
 * 时间约定（秒）：
 *   每卷在自己的机器轴上（以下时刻均为中点值；受实测范围影响的
 *   启动/停机/就绪时刻另给 [Lo,Hi] 最早～最晚包络）：
 *     motorStart  = pictureStart - accel            （马达提前启动）
 *     motorCue    = pictureStart + cueOffM          （马达提示绝对时刻）
 *     changeCue   = pictureStart + cueOffC          （切换提示绝对时刻）
 *     picEnd      = pictureStart + picSec
 *     stopTime    = changeCue + tailRunoff          （片尾跑完后停机）
 *     rewindEnd   = stopTime + totalSec/rewindFactor（回卷完成；parallel 模式自切换点起）
 *     threadedFor = rewindEnd + rethreadSec         （挂好下一卷）
 *   银幕：本卷画面在 [pictureStart, changeCue] 内由本机投射；
 *         changeCue 起切到下一卷（下一卷 pictureStart 即此刻）。
 *
 * 设备实测性能（settings.devices.A / B，各五项，均支持 单值 / 最小～最大）：
 *   accelSec      起转稳定时间
 *   tailRunoffSec 停机拖尾（切换提示后跑完片尾才停机）
 *   rewindFactor  回卷倍率（回卷速度 = 放映速度 ×倍率）
 *   rethreadSec   重新穿片时长
 *   measuredAt    测量日期（仅记录，不参与计算）
 *   另：rewindMode serial/parallel 为方案级共用设置。
 * 范围传播：
 *   accel / tailRunoff 为加法传播（最早取最小、最晚取最大）；
 *   回卷倍率越大回卷越快（最早用最大倍率，最晚用最小倍率）；
 *   穿片时长为加法传播。提示单值沿用旧全局设置作为缺省。
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
    accelSec: 1,             // 马达加速稳形时间（旧方案缺省：设备未填实测时使用）
    minHeadReserveSec: 0,    // 片头储备最小秒数（0=允许容差内的标准重叠）
    gapToleranceSec: 1,      // 空档/重叠判定容差（重叠<=容差视为标准重叠）
    tailRunoffSec: 3,        // 切换后跑完片尾再停机（旧方案缺省）
    laceSec: 60,             // 回卷后挂片时间（旧方案缺省，设备字段名为 rethreadSec）
    rewindFactor: 4,         // 回卷速度 = 放映速度 ×N（旧方案缺省）
    rewindMode: "serial",    // serial=停机才回卷 / parallel=切换后立即回卷
    turnaroundBufferSec: 10, // 再次就绪距下一马达启动的最小提前量
  };

  // 设备实测性能字段：键 -> [中文标签, 步长, 单位, 缺省回退设置键]
  // 每个数值字段在存档中允许：number | {min, max}，对应单值或上下限。
  var DEVICE_FIELDS = {
    accelSec:      { label: "起转稳定时间", step: 0.5, unit: "秒", fallback: "accelSec" },
    tailRunoffSec: { label: "停机拖尾", step: 0.5, unit: "秒", fallback: "tailRunoffSec" },
    rewindFactor:  { label: "回卷倍率", step: 0.5, unit: "×放映速", fallback: "rewindFactor" },
    rethreadSec:   { label: "重新穿片时长", step: 5, unit: "秒", fallback: "laceSec" },
  };
  var DEVICE_FIELD_KEYS = Object.keys(DEVICE_FIELDS);

  function defaultDevice(which) {
    return {
      name: which === "B" ? "乙机" : "甲机",
      accelSec: null, accelSecMax: null,
      tailRunoffSec: null, tailRunoffSecMax: null,
      rewindFactor: null, rewindFactorMax: null,
      rethreadSec: null, rethreadSecMax: null,
      measuredAt: "",
    };
  }

  // 读取一个可能是单值 / {min,max} 的设备参数 -> {min,max,mid,hasRange,set}
  function deviceParam(raw, fallbackKey, settings) {
    var lo = num(raw, NaN), hi;
    if (raw && typeof raw === "object") {
      lo = parseFloat(raw.min);
      hi = parseFloat(raw.max);
    }
    var set = isFinite(lo);
    if (!isFinite(lo)) lo = parseFloat(settings[fallbackKey]);
    if (!isFinite(hi)) hi = lo;
    if (lo > hi) { var t = lo; lo = hi; hi = t; }
    return { min: lo, max: hi, mid: (lo + hi) / 2, hasRange: hi > lo + 1e-9, set: set };
  }

  // 归一化存档中的设备配置（保留原始单值/范围写法，缺省补 null）
  function normalizeDevice(which, input) {
    var base = defaultDevice(which);
    if (input && typeof input === "object") {
      for (var k in base) {
        if (k in input && input[k] !== undefined) base[k] = input[k];
      }
    }
    base.name = String(base.name || (which === "B" ? "乙机" : "甲机"));
    return base;
  }

  // 解析为参与计算的数值参数（未填实测时回退旧全局设置）
  function resolveDevice(which, raw, settings) {
    var out = { which: which, name: raw.name || (which === "B" ? "乙机" : "甲机"), measuredAt: raw.measuredAt || "" };
    DEVICE_FIELD_KEYS.forEach(function (k) {
      var p = deviceParam(raw[k + "Max"] != null && raw[k + "Max"] !== ""
        ? { min: raw[k], max: raw[k + "Max"] } : raw[k], DEVICE_FIELDS[k].fallback, settings);
      // 倍率上限必须为正，否则回卷耗时无意义；异常时退回缺省
      if (k === "rewindFactor" && !(p.min > 0)) {
        var fb = parseFloat(settings.rewindFactor);
        p = { min: fb, max: fb, mid: fb, hasRange: false, set: false };
      }
      out[k] = p;
    });
    return out;
  }

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
    deviceData: "warning", // 设备实测数据缺失/未填测量日期
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
    deviceData: "设备实测数据待补",
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
    if (input) for (k in input) if (k !== "devices" && k in s) s[k] = input[k];
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
    // 甲/乙机实测性能（原始存档值，单值或上下限）
    var devs = (input && input.devices) || {};
    s.devices = {
      A: normalizeDevice("A", devs.A),
      B: normalizeDevice("B", devs.B),
    };
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
    // 甲/乙机实测性能解析值（未填项回退旧全局设置）
    var dev = {
      A: resolveDevice("A", settings.devices.A, settings),
      B: resolveDevice("B", settings.devices.B, settings),
    };
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
    // 约定（换片挂片法）：下一卷按自己的马达提示位置预挂，
    // 上一卷马达提示到达片窗时启动下一台机器；下一卷从启动到自己
    // 动作片头（第一格画面）所用时间 = 本卷「马达提示→切换提示」间隔。
    // 因此标准双机（两卷提示间隔相同）切换点恰为下一卷动作片头到达点，
    // 空档/重叠为 0；提示帧不准时，差值即为银幕空档（正）或重叠（负）。
    //   画面时刻沿「马达提示链」传播；切换时刻由各卷切换提示独立决定。
    //   设备实测范围（起转稳定/停机拖尾/回卷倍率/穿片）传播到启动、
    //   停机、回卷完成与再次就绪时刻的 [Lo,Hi] 包络；中点值用于主刻点。
    var psLo = 0, psHi = 0, psMid = 0;
    computed.forEach(function (c, idx) {
      c.pictureStart = psMid;
      c.picStartLo = psLo;
      c.picStartHi = psHi;
      c.headStart = psMid - c.headFrames / c.fps;
      c.motorCueT = psMid + c.mOff.mid / c.fps;
      c.changeCueT = psMid + c.cOff.mid / c.fps;
      c.motorCueMin = psLo + c.mOff.min / c.fps;
      c.motorCueMax = psHi + c.mOff.max / c.fps;
      c.changeCueMin = psLo + c.cOff.min / c.fps;
      c.changeCueMax = psHi + c.cOff.max / c.fps;
      c.picEnd = psMid + c.picSec;

      // 本机实测性能
      var d = dev[c.reel.projector];
      c.dev = d;

      if (idx === 0) {
        c.motorStartLo = Math.min(
          psLo - d.accelSec.max,
          psLo - settings.motorLeadSec
        );
        c.motorStartHi = Math.min(
          psHi - d.accelSec.min,
          psHi - settings.motorLeadSec
        );
        c.motorStart = Math.min(
          psMid - d.accelSec.mid,
          psMid - settings.motorLeadSec
        );
      } else {
        var pc = computed[idx - 1];
        c.motorStartLo = pc.motorCueMin - d.accelSec.max;
        c.motorStartHi = pc.motorCueMax - d.accelSec.min;
        c.motorStart = pc.motorCueT - d.accelSec.mid;
      }

      // 停机拖尾（加法范围）
      c.stopLo = c.changeCueMin + d.tailRunoffSec.min;
      c.stopHi = c.changeCueMax + d.tailRunoffSec.max;
      c.stopTime = c.changeCueT + d.tailRunoffSec.mid;

      // 回卷：倍率越大越快 → 最早用最大倍率，最晚用最小倍率
      c.rewindSec = c.totalSec / d.rewindFactor.mid;
      c.rewindSecLo = c.totalSec / d.rewindFactor.max;
      c.rewindSecHi = c.totalSec / d.rewindFactor.min;
      if (settings.rewindMode === "parallel") {
        c.rewindEndLo = c.changeCueMin + c.rewindSecLo;
        c.rewindEndHi = c.changeCueMax + c.rewindSecHi;
        c.rewindEnd = c.changeCueT + c.rewindSec;
      } else {
        c.rewindEndLo = c.stopLo + c.rewindSecLo;
        c.rewindEndHi = c.stopHi + c.rewindSecHi;
        c.rewindEnd = c.stopTime + c.rewindSec;
      }
      // 重新穿片（加法范围）
      c.threadedLo = c.rewindEndLo + d.rethreadSec.min;
      c.threadedHi = c.rewindEndHi + d.rethreadSec.max;
      c.threadedFor = c.rewindEnd + d.rethreadSec.mid;

      // 下一卷动作片头（挂片约定）：上一卷马达提示 + 下一卷自身提示间隔
      if (idx < computed.length - 1) {
        var nc2 = computed[idx + 1];
        psLo = c.motorCueMin + (nc2.cOff.min - nc2.mOff.max) / nc2.fps;
        psHi = c.motorCueMax + (nc2.cOff.max - nc2.mOff.min) / nc2.fps;
        psMid = c.motorCueT + (nc2.cOff.mid - nc2.mOff.mid) / nc2.fps;
      }
    });

    // 3) 银幕画面连续性、同机/周转、操作事件
    computed.forEach(function (c, idx) {
      var reel = c.reel;
      var projName = reel.projector === "A" ? "甲机" : "乙机";
      // 本卷的马达提示 = 下一台机器的启动信号
      events.push(evt(c, "start", c.motorStart,
        idx === 0 ? "开映前手动启动" + projName + "《" + reel.title + "》"
                  : projName + " 启动《" + reel.title + "》（按上一卷马达提示）",
        null, [c.motorStartLo, c.motorStartHi]));
      if (idx < computed.length - 1) {
        var nc = computed[idx + 1];
        events.push(evt(c, "motor", c.motorCueT,
          "马达提示：启动" + (nc.reel.projector === "A" ? "甲机" : "乙机") +
          "《" + nc.reel.title + "》", nc.reel, [c.motorCueMin, c.motorCueMax]));
        events.push(evt(c, "change", c.changeCueT,
          "切换提示：切到" + (nc.reel.projector === "A" ? "甲机" : "乙机") +
          "《" + nc.reel.title + "》", nc.reel, [c.changeCueMin, c.changeCueMax]));
      } else {
        events.push(evt(c, "motor", c.motorCueT,
          "末卷马达提示标记（无下一卷）", null, [c.motorCueMin, c.motorCueMax]));
        events.push(evt(c, "change", c.changeCueT,
          "末卷切换提示：终场切灯", null, [c.changeCueMin, c.changeCueMax]));
      }
      events.push(evt(c, "stop", c.stopTime,
        projName + " 停机《" + reel.title + "》", null, [c.stopLo, c.stopHi]));
      if (idx < computed.length - 1) {
        events.push(evt(c, "ready", c.threadedFor,
          projName + " 回卷挂片就绪（《" + reel.title + "》之后）", null,
          [c.threadedLo, c.threadedHi]));
      }

      if (idx === 0) {
        // 首卷片头储备：启动稳速后到动作片头的护片余量。
        // 起转稳定越慢越不利（用最大起转时间）。
        var d0 = c.dev;
        var headAvailBest = c.headFrames / c.fps - d0.accelSec.min;
        var headAvailWorst = c.headFrames / c.fps - d0.accelSec.max;
        var need0 = settings.minHeadReserveSec;
        if (headAvailWorst < need0) {
          issues.push(makeIssue({
            kind: "firstHead", reelId: reel.id,
            message: "首卷《" + reel.title + "》片头护片按" + projName +
              "最慢起转（" + d0.accelSec.max.toFixed(1) + " 秒）余量仅 " +
              fmtSigned(headAvailWorst, 1) + " 秒，要求 ≥ " + fmtSigned(need0, 1) + " 秒。",
            amount: need0 - headAvailWorst,
            doubtful: headAvailBest >= need0,
          }));
        }
      }

      var next = computed[idx + 1];
      if (!next) return;

      // 空档 / 重叠：
      // 切换在本卷 changeCueT；下一卷动作片头在 next.pictureStart
      // （= 本卷 motorCueT + 下一卷自身提示间隔）。
      //   gap>0 切换时下一卷画面未到（黑场）
      //   gap<0 切换时两卷画面同时在银幕（重叠）
      // 用两边提示范围给出实际包络 [gapLo, gapHi]：
      //   gapLo>tol            确定性空档
      //   gapHi<-tol           确定性重叠
      //   区间跨 tol / -tol    存疑潜在空档/重叠（可能同时存在两侧风险）
      var gapMid = next.pictureStart - c.changeCueT;
      var gapLo = next.cueLeadMin - c.cueLeadMax;
      var gapHi = next.cueLeadMax - c.cueLeadMin;
      var tol = settings.gapToleranceSec;
      var doubtfulGap = c.change.uncertain || next.change.uncertain ||
                        c.motor.uncertain || next.motor.uncertain;

      function gapIssue(kind, msg, amount, doubt) {
        issues.push(makeIssue({
          kind: kind,
          reelId: reel.id, otherReelId: next.reel.id, t: c.changeCueT,
          message: msg, amount: amount, doubtful: doubt,
        }));
      }
      if (gapLo > tol) {
        gapIssue("gap",
          "《" + reel.title + "》→《" + next.reel.title +
          "》切换时银幕空档约 " + fmtSigned(gapMid, 1) + " 秒。",
          gapMid - tol, false);
      } else if (gapHi < -tol) {
        gapIssue("overlap",
          "《" + reel.title + "》与《" + next.reel.title +
          "》画面在银幕重叠约 " + fmtSigned(-gapMid, 1) + " 秒，超过接片容差。",
          -gapMid - tol, false);
      } else {
        // 包络未整体越界：检查存疑范围是否触及任一侧（越过容差才算风险）
        var gapPossible = gapHi > tol;
        var overlapPossible = gapLo < -tol;
        if (gapPossible && overlapPossible) {
          // 两卷存疑范围交叉：同一衔接的包络同时覆盖空档与重叠
          gapIssue("gap",
            "《" + reel.title + "》→《" + next.reel.title +
            "》存疑提示范围交叉：衔接包络 " + fmtSigned(gapLo, 1) + "～" +
            fmtSigned(gapHi, 1) + " 秒，可能出现最长 " + fmtSigned(gapHi, 1) +
            " 秒空档。",
            gapHi - tol, true);
          gapIssue("overlap",
            "《" + reel.title + "》→《" + next.reel.title +
            "》存疑提示范围交叉：同一衔接可能出现最长 " +
            fmtSigned(-gapLo, 1) + " 秒画面重叠，请现场核对两卷提示帧。",
            -gapLo - tol, true);
        } else if (gapPossible) {
          gapIssue("gap",
            "提示存疑时，《" + reel.title + "》→《" + next.reel.title +
            "》衔接可能出现最长 " + fmtSigned(gapHi, 1) + " 秒银幕空档。",
            gapHi - tol, true);
        } else if (overlapPossible) {
          gapIssue("overlap",
            "提示存疑时，《" + reel.title + "》与《" + next.reel.title +
            "》画面可能最长重叠 " + fmtSigned(-gapLo, 1) + " 秒。",
            -gapLo - tol, true);
        }
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

      // 周转：上一卷在本台机器就绪时刻 vs 下一次本台机器需要马达启动的时刻。
      // 最不利组合：本机就绪最晚（threadedHi）、下一台需要启动最早
      // （motorStartLo）；缓冲仍为方案级固定值。
      var deadlineReel = nextSameMachine(computed, idx);
      if (deadlineReel) {
        var deadlineMid = deadlineReel.motorStart - settings.turnaroundBufferSec;
        var deadlineLo = deadlineReel.motorStartLo - settings.turnaroundBufferSec;
        var deadlineHi = deadlineReel.motorStartHi - settings.turnaroundBufferSec;
        var slackWorst = deadlineLo - c.threadedHi;  // 最不利：就绪最晚、deadline 最早
        var slackBest = deadlineHi - c.threadedLo;   // 最有利
        var slackMin = deadlineMid - c.threadedFor;  // 中点（汇总与连线用）
        var deviceUncertain =
          c.dev.accelSec.hasRange || c.dev.tailRunoffSec.hasRange ||
          c.dev.rewindFactor.hasRange || c.dev.rethreadSec.hasRange ||
          deadlineReel.dev.accelSec.hasRange;
        if (slackBest < 0) {
          // 最有利组合仍来不及：确定性冲突
          issues.push(makeIssue({
            kind: "turnaround", reelId: reel.id, otherReelId: deadlineReel.reel.id,
            t: c.changeCueT,
            message: (reel.projector === "A" ? "甲机" : "乙机") +
              "放完《" + reel.title + "》后即使按最有利实测组合，仍来不及在《" +
              deadlineReel.reel.title + "》前回卷就绪，还差约 " +
              fmtSigned(-slackBest, 0) + " 秒（最快就绪 " + fmtClock(c.threadedLo) +
              " / 须早于 " + fmtClock(deadlineHi) + "）。",
            amount: -slackBest,
          }));
        } else if (slackWorst < 0) {
          // 最不利组合来不及、最有利来得及：取决于本次实测落点，按存疑警告
          issues.push(makeIssue({
            kind: "turnaround", severity: "warning", reelId: reel.id,
            otherReelId: deadlineReel.reel.id, t: c.changeCueT, doubtful: true,
            message: (reel.projector === "A" ? "甲机" : "乙机") +
              "周转余量随实测性能变化：最不利组合下《" + reel.title + "》→《" +
              deadlineReel.reel.title + "》还差约 " + fmtSigned(-slackWorst, 0) +
              " 秒（就绪 " + fmtClock(c.threadedLo) + "～" + fmtClock(c.threadedHi) +
              " / 须早于 " + fmtClock(deadlineLo) + "～" + fmtClock(deadlineHi) + "）。",
            amount: -slackWorst,
          }));
        }
        c.turnaround = {
          deadlineReelId: deadlineReel.reel.id,
          deadlineT: deadlineMid,
          deadlineLo: deadlineLo,
          deadlineHi: deadlineHi,
          readyT: c.threadedFor,
          readyLo: c.threadedLo,
          readyHi: c.threadedHi,
          slack: slackMin,
          slackWorst: slackWorst,
          slackBest: slackBest,
          uncertain: deviceUncertain,
        };
      }
    });

    // 设备实测数据完备性：未填测量日期只提醒（旧方案沿用全局缺省值）
    ["A", "B"].forEach(function (w) {
      var d = dev[w];
      if (!d.measuredAt) {
        var unsetCount = DEVICE_FIELD_KEYS.filter(function (k) { return !d[k].set; }).length;
        issues.push(makeIssue({
          kind: "deviceData",
          message: (w === "A" ? "甲机" : "乙机") +
            (unsetCount === DEVICE_FIELD_KEYS.length
              ? "尚未登记实测性能，时刻链使用方案设置中的缺省值。"
              : "实测性能未填写测量日期" +
                (unsetCount ? ("，另有 " + unsetCount + " 项使用缺省值") : "") + "。"),
        }));
      }
    });

    // 事件排序：同时刻 start < motor < change < stop < ready
    var orderRank = { start: 0, motor: 1, change: 2, stop: 3, ready: 4 };
    events.sort(function (a, b) {
      return a.t - b.t || orderRank[a.kind] - orderRank[b.kind] || a.idx - b.idx;
    });

    // 时间域（含设备范围包络）
    var tMin = computed.length ? computed[0].motorStartLo : -10;
    var tMax = computed.length
      ? Math.max.apply(null, computed.map(function (c) {
          return Math.max(c.picEnd, c.threadedHi, c.stopHi);
        }))
      : 60;

    var stats = buildStats(computed, issues, settings, dev);
    return {
      settings: settings,
      devices: dev,
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

  function evt(c, kind, t, label, targetReel, win) {
    var r = targetReel || c.reel;
    return {
      id: c.reel.id + "_" + kind,
      reelId: r.id,
      idx: c.idx,
      projector: r.projector,
      kind: kind,
      t: t,
      tLo: win && isFinite(win[0]) ? win[0] : t,
      tHi: win && isFinite(win[1]) ? win[1] : t,
      label: label,
    };
  }

  function buildStats(computed, issues, settings, dev) {
    var errorN = 0, warnN = 0, doubtN = 0;
    issues.forEach(function (i) {
      if (i.severity === "error") errorN++; else warnN++;
      if (i.doubtful) doubtN++;
    });
    var gap = 0, overlap = 0, gapRisk = 0, overlapRisk = 0, turnaroundShort = 0;
    var turnaroundRisk = 0;
    computed.forEach(function (c, idx) {
      var next = computed[idx + 1];
      if (!next) return;
      var tol = settings.gapToleranceSec;
      var gMid = next.pictureStart - c.changeCueT;
      var gLo = next.cueLeadMin - c.cueLeadMax;
      var gHi = next.cueLeadMax - c.cueLeadMin;
      if (gMid > tol) gap += gMid - tol;
      if (gMid < -tol) overlap += -gMid - tol;
      // 存疑包络中的潜在量（超出中点确定性部分、越过容差的量）
      if (gHi > tol) gapRisk += Math.max(0, gHi - Math.max(tol, gMid));
      if (gLo < -tol) overlapRisk += Math.max(0, Math.min(-tol, gMid) - gLo);
      if (c.turnaround) {
        // 确定性缺口：最有利组合仍来不及；潜在缺口：最不利组合
        if (c.turnaround.slackBest < 0) turnaroundShort += -c.turnaround.slackBest;
        if (c.turnaround.slackWorst < 0) turnaroundRisk += -c.turnaround.slackWorst;
      }
    });
    // 设备范围造成的时刻窗口宽度（秒，取全体卷最大值）
    function maxWin(getLo, getHi) {
      return computed.reduce(function (m, c) {
        return Math.max(m, getHi(c) - getLo(c));
      }, 0);
    }
    var startWin = maxWin(function (c) { return c.motorStartLo; }, function (c) { return c.motorStartHi; });
    var stopWin = maxWin(function (c) { return c.stopLo; }, function (c) { return c.stopHi; });
    var readyWin = maxWin(function (c) { return c.threadedLo; }, function (c) { return c.threadedHi; });
    var minSlack = computed.reduce(function (m, c) {
      return c.turnaround ? Math.min(m, c.turnaround.slackWorst) : m;
    }, Infinity);
    if (!isFinite(minSlack)) minSlack = null;
    var showStart = computed.length ? computed[0].pictureStart : 0;
    var showEnd = computed.length
      ? computed[computed.length - 1].changeCueT +
        computed[computed.length - 1].dev.tailRunoffSec.mid : 0;
    return {
      reelCount: computed.length,
      errorCount: errorN,
      warningCount: warnN,
      doubtfulCount: doubtN,
      totalGap: gap,
      totalOverlap: overlap,
      gapRisk: gapRisk,
      overlapRisk: overlapRisk,
      turnaroundShort: turnaroundShort,
      turnaroundRisk: turnaroundRisk,
      startWindow: startWin,
      stopWindow: stopWin,
      readyWindow: readyWin,
      minSlackWorst: minSlack,
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
    DEVICE_FIELDS: DEVICE_FIELDS,
    DEVICE_FIELD_KEYS: DEVICE_FIELD_KEYS,
    ISSUE_LABEL: ISSUE_LABEL,
    uid: uid,
    num: num,
    positive: positive,
    normRange: normRange,
    makeSettings: makeSettings,
    defaultDevice: defaultDevice,
    normalizeDevice: normalizeDevice,
    resolveDevice: resolveDevice,
    deviceParam: deviceParam,
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
