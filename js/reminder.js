/**
 * 提醒引擎
 *
 * 移植自微信小程序版 utils/reminder.js，只有「触发后的表现形式」换了实现：
 *   wx.vibrateLong        -> navigator.vibrate（安卓壳里回落原生震动）
 *   （新增）系统通知       -> 浏览器 Notification API / 安卓壳的原生通知
 *   页面内弹窗            -> 由 app.js 监听 emit 后渲染
 *
 * 能力边界（诚实说明）：这条链路只在**应用打开着**的时候有效。页面被关掉、
 * 或者系统把后台标签页/进程冻结之后，setInterval 会被节流甚至停止。
 * 想要关掉也能准时被提醒，请用「导出到系统日历」——那条路径由手机系统负责
 * 排程，不依赖本页是否运行。
 */

(function (global) {
  'use strict';

  const CR = global.CR;
  const store = CR.store;
  const dateUtil = CR.date;
  const periods = CR.periods;
  const scheduleUtil = CR.schedule;

  const CHECK_INTERVAL = 30 * 1000;   // 每 30 秒检查一次
  const EXPIRE_AFTER = 60;            // 开始时间过去 60 分钟后不再提醒

  let timer = null;
  let listeners = [];
  let notifPermission = 'default';

  function on(fn) {
    if (listeners.indexOf(fn) < 0) listeners.push(fn);
  }

  function off(fn) {
    listeners = listeners.filter(f => f !== fn);
  }

  function emit(item) {
    listeners.forEach(fn => {
      try {
        fn(item);
      } catch (e) {
        // 单个监听器出错不影响其他监听器
      }
    });
  }

  /* ---------------- 系统通知 ----------------
   * 两种环境：
   *   浏览器 → Notification API
   *   安卓壳 → window.Android.notify（WebView 里没有 Notification API，只能走原生通知）
   * 对外暴露的 supported / permission / requestPermission 语义保持一致，
   * 这样设置页不用关心自己跑在哪儿。
   */

  /** 安卓壳注入的对象（普通浏览器里为 undefined） */
  function androidBridge() {
    const a = global.Android;
    return (a && typeof a.notify === 'function') ? a : null;
  }

  function supported() {
    return !!androidBridge() || typeof global.Notification === 'function';
  }

  function permission() {
    const a = androidBridge();
    if (a) {
      try {
        return a.notificationPermission() || 'default';
      } catch (e) {
        return 'default';
      }
    }
    return typeof global.Notification === 'function' ? global.Notification.permission : 'unsupported';
  }

  /**
   * 申请通知权限。
   * 注意：必须由用户点击直接触发，否则部分浏览器会直接拒绝。
   */
  function requestPermission() {
    const a = androidBridge();
    if (a) {
      // 原生侧弹出系统授权框，结果会通过 window.__crOnNotifyPermission 回调，
      // 这里先把当前状态返回去，设置页随后会自己刷新
      try {
        const now = a.requestNotification();
        notifPermission = now || 'default';
        return Promise.resolve(notifPermission);
      } catch (e) {
        return Promise.resolve('default');
      }
    }

    if (typeof global.Notification !== 'function') return Promise.resolve('unsupported');
    if (global.Notification.permission !== 'default') {
      notifPermission = global.Notification.permission;
      return Promise.resolve(notifPermission);
    }
    try {
      const r = global.Notification.requestPermission();
      // 老版 Safari 走回调式，返回 undefined
      if (!r || typeof r.then !== 'function') {
        return new Promise(resolve => {
          global.Notification.requestPermission(p => {
            notifPermission = p;
            resolve(p);
          });
        });
      }
      return r.then(p => {
        notifPermission = p;
        return p;
      });
    } catch (e) {
      return Promise.resolve('denied');
    }
  }

  function notifySystem(item) {
    // 安卓壳：走原生通知，这样退出应用到后台也能收到
    const a = androidBridge();
    if (a) {
      try {
        const body = [item.subtitle, item.note, item.timeText].filter(Boolean).join(' · ') || '即将开始';
        a.notify(item.title, body);
      } catch (e) {
        // 忽略
      }
      return;
    }

    if (typeof global.Notification !== 'function') return;
    if (global.Notification.permission !== 'granted') return;
    try {
      const body = [item.subtitle, item.note].filter(Boolean).join('\n') || '即将开始';
      const n = new global.Notification(item.title, {
        body: body,
        tag: item.key,          // 同一条不重复弹
        renotify: false
      });
      setTimeout(() => {
        try { n.close(); } catch (e) { /* 忽略 */ }
      }, 30000);
      n.onclick = function () {
        try {
          global.focus();
          n.close();
        } catch (e) { /* 忽略 */ }
      };
    } catch (e) {
      // 部分浏览器在非 HTTPS 或页面隐藏时不允许构造通知，静默降级
    }
  }

  function vibrate(settings) {
    if (!settings || !settings.vibrate) return;
    try {
      if (navigator.vibrate) {
        navigator.vibrate([120, 60, 120]);
        return;
      }
    } catch (e) {
      // 落到原生震动
    }
    const a = androidBridge();
    if (a && typeof a.vibrate === 'function') {
      try { a.vibrate(160); } catch (e) { /* 忽略 */ }
    }
  }

  /* ---------------- 候选与判定 ---------------- */

  /** 收集今天需要提醒的课程与日程 */
  function collectToday() {
    const todayStr = dateUtil.today();
    const wd = dateUtil.weekday(todayStr);
    const settings = store.getSettings();
    const weekNo = dateUtil.weekNo(settings.termStart, todayStr);
    const items = [];

    store.getCourses().forEach(c => {
      if (Number(c.day) !== wd) return;
      if (!c.periods || !c.periods.length) return;
      if (!store.isCourseActive(c, weekNo)) return;
      if (store.isSkipped(todayStr, c.id)) return;
      const span = periods.spanOf(c.periods);
      items.push({
        key: todayStr + '_course_' + c.id,
        type: 'course',
        typeText: periods.label(c.periods),
        id: c.id,
        title: c.name,
        subtitle: [c.location, c.teacher].filter(Boolean).join(' · '),
        note: c.note || '',
        color: c.color,
        startTime: span.start,
        endTime: span.end,
        startMinutes: dateUtil.toMin(span.start),
        remindBefore: c.remindBefore === undefined || c.remindBefore === null ? settings.remindBefore : c.remindBefore
      });
    });

    scheduleUtil.todayList().forEach(s => {
      if (s.done) return;
      items.push({
        key: todayStr + '_schedule_' + s.id,
        type: 'schedule',
        typeText: s.category || '日程',
        id: s.id,
        title: s.title,
        subtitle: s.location || '',
        note: s.note || '',
        color: s.color,
        startTime: s.startTime,
        endTime: s.endTime,
        startMinutes: s.startMinutes,
        remindBefore: s.remindBefore === null ? settings.remindBefore : s.remindBefore
      });
    });

    return items.sort((a, b) => a.startMinutes - b.startMinutes);
  }

  /** 找出当前应该提醒的一条（返回 null 表示暂时没有） */
  function pickDue() {
    const nowM = dateUtil.nowMin();
    const list = collectToday();
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const remindAt = it.startMinutes - (Number(it.remindBefore) || 0);
      if (nowM < remindAt) continue;                        // 还没到提醒时间
      if (nowM > it.startMinutes + EXPIRE_AFTER) continue;  // 已经过去太久，跳过
      if (store.isNotified(it.key)) continue;               // 已经提醒过
      const until = store.snoozeUntil(it.key);
      if (until && Date.now() < until) continue;            // 用户选择了稍后提醒
      return it;
    }
    return null;
  }

  function tick() {
    let item = null;
    try {
      item = pickDue();
    } catch (e) {
      return null;
    }
    if (!item) return null;
    item.remainMinutes = item.startMinutes - dateUtil.nowMin();
    store.markNotified(item.key);
    const settings = store.getSettings();
    vibrate(settings);
    notifySystem(item);
    emit(item);
    return item;
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, CHECK_INTERVAL);
    // 手机锁屏 / 标签页切回来后立刻补检一次，避免错过
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible') tick();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible);
    }
  }

  /** 稍后提醒：清除已提醒标记，延迟 N 分钟后再提醒 */
  function snooze(item, minutes) {
    store.snooze(item.key, minutes);
  }

  /** 主动测试：立刻触发一条示例提醒 */
  function testFire() {
    const item = {
      key: 'test_' + Date.now(),
      type: 'schedule',
      typeText: '测试',
      id: 'test',
      title: '提醒功能测试',
      subtitle: '看到这条说明提醒可以正常弹出',
      note: '',
      color: '#378ADD',
      startTime: dateUtil.nowHM(),
      endTime: '',
      startMinutes: dateUtil.nowMin(),
      remindBefore: 0,
      remainMinutes: 0
    };
    vibrate(store.getSettings());
    notifySystem(item);
    emit(item);
  }

  CR.reminder = {
    on: on,
    off: off,
    start: start,
    stop: stop,
    tick: tick,
    snooze: snooze,
    testFire: testFire,
    collectToday: collectToday,
    supported: supported,
    permission: permission,
    requestPermission: requestPermission
  };
})(window);
