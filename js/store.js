/**
 * 数据层：本地存储读写与增删改查
 *
 * 从微信小程序版移植：wx.getStorageSync / wx.setStorageSync 换成 localStorage，
 * 数据模型与存储 key 完全一致，因此小程序导出的备份 JSON 可以直接导入这里。
 * 已移除「订阅消息额度（木鱼）」相关逻辑——那是微信平台特有的限制，本地应用不需要。
 */

(function (global) {
  'use strict';

  const CR = global.CR;
  const dateUtil = CR.date;
  const periods = CR.periods;

  const KEY = {
    courses: 'cr_courses',
    schedules: 'cr_schedules',
    settings: 'cr_settings',
    notified: 'cr_notified',
    snooze: 'cr_snooze',
    skips: 'cr_skips',
    seeded: 'cr_seeded',
    // 演示日程的「墓碑」：用户删过一次演示日程，就再也不自动补回来。
    // 光靠 seeded 不够稳——只要有一次误判成首次启动，删掉的演示日程
    // 又会回来，看起来就是「删不掉」。墓碑是独立的一票否决。
    demoGone: 'cr_demo_gone',
    // 首次写入示例数据的时间，写在「数据」卡片底部做诊断用：
    // 如果它每次打开都变成当前时间，说明本机根本没把数据留下来。
    bornAt: 'cr_born_at'
  };

  const COLORS = ['#378ADD', '#1D9E75', '#D85A30', '#D4537E', '#7F77DD', '#EF9F27', '#639922', '#888780'];

  /* ---------------- 底层读写 ---------------- */

  function read(key, def) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === '') return def;
      return JSON.parse(raw);
    } catch (e) {
      return def;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // 存储失败（例如隐私模式、容量满）时静默处理，避免打断用户操作
      return false;
    }
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------- 设置 ---------------- */

  function defaultSettings() {
    return {
      remindBefore: 15,          // 默认提前提醒（分钟）
      termStart: dateUtil.mondayOf(dateUtil.today()), // 开学第一周的周一
      termWeeks: 20,             // 学期总周数
      vibrate: true              // 提醒时震动
    };
  }

  function getSettings() {
    return Object.assign(defaultSettings(), read(KEY.settings, {}));
  }

  function saveSettings(patch) {
    const next = Object.assign(getSettings(), patch);
    write(KEY.settings, next);
    return next;
  }

  /* ---------------- 课程 ---------------- */

  function getCourses() {
    return read(KEY.courses, []);
  }

  function saveCourses(list) {
    write(KEY.courses, list);
  }

  function getCourse(id) {
    return getCourses().filter(c => c.id === id)[0] || null;
  }

  function upsertCourse(course) {
    const list = getCourses();
    const idx = list.findIndex(c => c.id === course.id);
    if (idx >= 0) list[idx] = course;
    else list.unshift(course);
    saveCourses(list);
    return course;
  }

  function removeCourse(id) {
    saveCourses(getCourses().filter(c => c.id !== id));
  }

  /** 该课程在第 weekNo 周是否上课 */
  function isCourseActive(course, weekNo) {
    const w = course.weeks || { type: 'all' };
    if (w.from && weekNo < w.from) return false;
    if (w.to && weekNo > w.to) return false;
    if (w.type === 'odd') return weekNo % 2 === 1;
    if (w.type === 'even') return weekNo % 2 === 0;
    return true;
  }

  /** 两个课程的周次设置是否可能在同一周撞上 */
  function weeksOverlap(a, b) {
    const A = a.weeks || { type: 'all' };
    const B = b.weeks || { type: 'all' };
    const aFrom = A.from || 1;
    const aTo = A.to || 30;
    const bFrom = B.from || 1;
    const bTo = B.to || 30;
    if (aTo < bFrom || bTo < aFrom) return false;      // 周次区间不相交
    const ta = A.type || 'all';
    const tb = B.type || 'all';
    if (ta !== 'all' && tb !== 'all' && ta !== tb) return false; // 单周与双周不会同周出现
    return true;
  }

  /** 与已有课程的时间冲突检查：同一天、周次有交集、节次有重叠 */
  function findCourseConflicts(course) {
    const result = [];
    const list = getCourses();
    const target = (course.periods || []).slice();
    list.forEach(c => {
      if (c.id === course.id) return;
      if (Number(c.day) !== Number(course.day)) return;
      if (!weeksOverlap(c, course)) return;
      const overlap = (c.periods || []).filter(p => target.indexOf(p) >= 0);
      if (!overlap.length) return;
      result.push({
        id: c.id,
        name: c.name,
        location: c.location || '',
        periods: overlap
      });
    });
    return result;
  }

  /* ---------------- 日程 ---------------- */

  function getSchedules() {
    return read(KEY.schedules, []);
  }

  function saveSchedules(list) {
    write(KEY.schedules, list);
  }

  function getSchedule(id) {
    return getSchedules().filter(s => s.id === id)[0] || null;
  }

  function upsertSchedule(item) {
    const list = getSchedules();
    const idx = list.findIndex(s => s.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
    saveSchedules(list);
    return item;
  }

  function removeSchedule(id) {
    const list = getSchedules();
    const gone = list.filter(s => s.id === id)[0];
    saveSchedules(list.filter(s => s.id !== id));
    // 删掉的是演示日程 → 立刻立墓碑，之后任何一次「补演示数据」都跳过
    if (gone && gone.demo) write(KEY.demoGone, true);
  }

  /* ---------------- 跳过某次课 ---------------- */

  function skipKey(dateStr, courseId) {
    return dateStr + '_' + courseId;
  }

  function addSkip(dateStr, courseId) {
    const list = read(KEY.skips, []);
    const k = skipKey(dateStr, courseId);
    if (list.indexOf(k) < 0) list.push(k);
    write(KEY.skips, list);
  }

  function isSkipped(dateStr, courseId) {
    return read(KEY.skips, []).indexOf(skipKey(dateStr, courseId)) >= 0;
  }

  function removeSkip(dateStr, courseId) {
    const k = skipKey(dateStr, courseId);
    write(KEY.skips, read(KEY.skips, []).filter(item => item !== k));
  }

  /* ---------------- 提醒状态 ---------------- */

  function markNotified(key) {
    const map = read(KEY.notified, {});
    map[key] = Date.now();
    // 只保留最近 3 天的记录，避免无限增长
    const limit = Date.now() - 3 * 24 * 3600 * 1000;
    Object.keys(map).forEach(k => {
      if (map[k] < limit) delete map[k];
    });
    write(KEY.notified, map);
  }

  function isNotified(key) {
    return !!read(KEY.notified, {})[key];
  }

  function snooze(key, minutes) {
    const map = read(KEY.snooze, {});
    map[key] = Date.now() + minutes * 60 * 1000;
    write(KEY.snooze, map);
  }

  function snoozeUntil(key) {
    return read(KEY.snooze, {})[key] || 0;
  }

  function clearNotifiedState() {
    write(KEY.notified, {});
    write(KEY.snooze, {});
  }

  /* ---------------- 导入导出与初始化 ---------------- */

  function exportAll() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: getSettings(),
      courses: getCourses(),
      schedules: getSchedules()
    };
  }

  function importAll(data) {
    if (!data || typeof data !== 'object') throw new Error('数据格式不正确');
    if (Array.isArray(data.courses)) saveCourses(data.courses);
    if (Array.isArray(data.schedules)) saveSchedules(data.schedules);
    if (data.settings && typeof data.settings === 'object') {
      const keepPeriod = getSettings();
      const next = Object.assign({}, data.settings);
      // 兼容：小程序版的订阅模板 ID 在本地应用里没有意义，丢掉
      delete next.subscribeTemplateId;
      delete next.muyuSound;
      saveSettings(next);
      // 作息是否自定义由 periodTimes 决定，随设置一起进来
      if (data.settings.periodTimes) {
        const merged = getSettings();
        merged.periodTimes = data.settings.periodTimes;
        saveSettings(merged);
      }
      void keepPeriod;
    }
  }

  function clearAll() {
    saveCourses([]);
    saveSchedules([]);
    clearNotifiedState();
    write(KEY.skips, []);
  }

  /** 首次启动写入一份示例数据（含一条 2 分钟后触发的演示日程，用来验证提醒） */
  function init() {
    const firstRun = !read(KEY.seeded, false);
    if (firstRun) {
      saveCourses([
        {
          id: genId(),
          name: '高等数学',
          teacher: '王老师',
          location: '教三楼 305',
          day: 1,
          periods: [1, 2],
          weeks: { type: 'all', from: 1, to: 18 },
          color: COLORS[0],
          remindBefore: 15,
          note: '带课本和作业本',
          demo: true
        },
        {
          id: genId(),
          name: '数据结构',
          teacher: '李老师',
          location: '计算机楼 A201',
          day: 3,
          periods: [6, 7, 8],
          weeks: { type: 'all', from: 1, to: 18 },
          color: COLORS[1],
          remindBefore: 15,
          note: '三节连堂',
          demo: true
        }
      ]);
      write(KEY.seeded, true);
      write(KEY.bornAt, Date.now());
    }
    // 演示日程只在首次启动创建
    refreshDemoSchedule(firstRun);
  }

  /**
   * 演示日程：还没到时间就原样保留；已经过期就顺延到 2 分钟后，方便随时体验提醒。
   *
   * createIfMissing 只在首次启动时为 true，这点很重要：以前每次启动都会在
   * 「没有演示日程」时补一条回来，用户把那条演示日程删掉、下次打开又出现，
   * 看起来就是「日程删不掉」。用户删了就该永远消失。
   */
  function refreshDemoSchedule(createIfMissing) {
    // 用户删掉的演示日程绝不复活：墓碑一旦立下，什么都不重建
    if (read(KEY.demoGone, false)) return;

    const now = Date.now();
    const list = getSchedules();
    const demo = list.filter(s => s.demo)[0];

    if (!demo) {
      if (!createIfMissing) return;
      const t0 = new Date(now + 2 * 60000);
      const e0 = new Date(now + 32 * 60000);
      list.unshift({
        id: genId(),
        title: '演示日程：小组作业讨论',
        date: dateUtil.fmt(t0),
        startTime: dateUtil.pad(t0.getHours()) + ':' + dateUtil.pad(t0.getMinutes()),
        endTime: dateUtil.pad(e0.getHours()) + ':' + dateUtil.pad(e0.getMinutes()),
        location: '图书馆 3 楼研讨间',
        category: '作业',
        color: COLORS[3],
        remindBefore: 1,
        note: '这条是自动生成的演示日程，用来验证提前提醒功能，删掉即可',
        done: false,
        demo: true
      });
      saveSchedules(list);
      return;
    }

    const start = dateUtil.parse(demo.date).getTime() + dateUtil.toMin(demo.startTime) * 60000;
    // 还没到时间、且在两小时内，保持原样即可
    if (start > now && start - now < 2 * 3600 * 1000) return;

    const t = new Date(now + 2 * 60000);
    const e = new Date(now + 32 * 60000);
    list.forEach(s => {
      if (!s.demo) return;
      s.date = dateUtil.fmt(t);
      s.startTime = dateUtil.pad(t.getHours()) + ':' + dateUtil.pad(t.getMinutes());
      s.endTime = dateUtil.pad(e.getHours()) + ':' + dateUtil.pad(e.getMinutes());
      s.remindBefore = 1;
      s.done = false;
    });
    saveSchedules(list);
  }

  CR.store = {
    KEY: KEY,
    COLORS: COLORS,
    genId: genId,
    init: init,
    read: read,
    write: write,
    /** 首次写入示例数据的时间戳（0 表示没有），用于判断本机是否真的把数据存住了 */
    bornAt: function () { return read(KEY.bornAt, 0); },
    getSettings: getSettings,
    saveSettings: saveSettings,
    getCourses: getCourses,
    saveCourses: saveCourses,
    getCourse: getCourse,
    upsertCourse: upsertCourse,
    removeCourse: removeCourse,
    isCourseActive: isCourseActive,
    weeksOverlap: weeksOverlap,
    findCourseConflicts: findCourseConflicts,
    getSchedules: getSchedules,
    saveSchedules: saveSchedules,
    getSchedule: getSchedule,
    upsertSchedule: upsertSchedule,
    removeSchedule: removeSchedule,
    addSkip: addSkip,
    isSkipped: isSkipped,
    removeSkip: removeSkip,
    markNotified: markNotified,
    isNotified: isNotified,
    snooze: snooze,
    snoozeUntil: snoozeUntil,
    clearNotifiedState: clearNotifiedState,
    exportAll: exportAll,
    importAll: importAll,
    clearAll: clearAll,
    periods: periods
  };
})(window);
