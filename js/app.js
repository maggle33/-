/**
 * 应用主体：四个标签页 + 编辑面板
 * 行为对齐微信小程序版，界面按网页重写。
 */

(function (global) {
  'use strict';

  const CR = global.CR;
  const store = CR.store;
  const dateUtil = CR.date;
  const periods = CR.periods;
  const scheduleUtil = CR.schedule;
  const ui = CR.ui;
  const ics = CR.ics;
  const reminder = CR.reminder;

  const REMIND_VALUES = [0, 5, 10, 15, 20, 30, 60, 120];
  const REMIND_LABELS = ['不提醒', '提前 5 分钟', '提前 10 分钟', '提前 15 分钟', '提前 20 分钟', '提前 30 分钟', '提前 1 小时', '提前 2 小时'];
  const CATEGORIES = ['作业', '考试', '活动', '会议', '其他'];
  const REPEAT_KEYS = ['none', 'daily', 'weekly', 'monthly'];
  const REPEAT_LABELS = ['不重复', '每天', '每周', '每月'];
  const BACK_DAYS = 30;
  const FORWARD_DAYS = 60;

  // 版本号唯一来源。打包安卓 APK 时 tools/build-android.py 会把这一行改写成
  // 它自己的 VERSION_NAME，所以这里改了网页版生效、打包后 APK 里也一定一致。
  // eslint-disable-next-line
  const APP_VERSION = '1.0.4';

  const state = {
    tab: 'today',
    ttWeek: null,
    schTab: 'todo',
    schCategory: '全部',
    timeline: [],
    edit: null
  };

  const $ = id => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function remindLabelOf(minutes) {
    const i = REMIND_VALUES.indexOf(Number(minutes));
    if (i >= 0) return REMIND_LABELS[i];
    return '提前 ' + minutes + ' 分钟';
  }

  /* =========================================================
     今日
     ========================================================= */

  function buildToday() {
    const todayStr = dateUtil.today();
    const settings = store.getSettings();
    const weekNo = dateUtil.weekNo(settings.termStart, todayStr);
    const wd = dateUtil.weekday(todayStr);
    const nowM = dateUtil.nowMin();

    const courses = store.getCourses()
      .filter(c => Number(c.day) === wd && c.periods && c.periods.length)
      .filter(c => store.isCourseActive(c, weekNo))
      .map(c => {
        const span = periods.spanOf(c.periods);
        const startM = dateUtil.toMin(span.start);
        const endM = span.end ? dateUtil.toMin(span.end) : startM + 60;
        let status = 'wait';
        let statusText = '待上课';
        if (nowM >= endM) { status = 'done'; statusText = '已结束'; }
        else if (nowM >= startM) { status = 'ing'; statusText = '进行中'; }
        return {
          id: c.id,
          name: c.name,
          location: c.location || '',
          teacher: c.teacher || '',
          periodText: periods.label(c.periods),
          timeText: span.start + (span.end ? ' ~ ' + span.end : ' 之后'),
          startM: startM,
          endM: endM,
          color: c.color || '#378ADD',
          status: status,
          statusText: statusText,
          skipped: store.isSkipped(todayStr, c.id)
        };
      })
      .sort((a, b) => a.startM - b.startM);

    const schedules = scheduleUtil.todayList().map(s => {
      let status = 'wait';
      let statusText = s.startTime + ' 开始';
      if (s.done) { status = 'done'; statusText = '已完成'; }
      else if (s.endTime && nowM > dateUtil.toMin(s.endTime)) { status = 'past'; statusText = '已过期'; }
      else if (s.startMinutes <= nowM) { status = 'ing'; statusText = '进行中'; }
      return {
        id: s.id,
        date: s.date,
        title: s.title,
        location: s.location,
        timeText: s.timeText,
        category: s.category,
        color: s.color,
        note: s.note,
        repeatText: s.repeatText,
        done: s.done,
        status: status,
        statusText: statusText,
        startM: s.startMinutes
      };
    }).sort((a, b) => (a.done === b.done ? a.startM - b.startM : (a.done ? 1 : -1)));

    // 时间轴，供倒计时滚动使用
    const timeline = [];
    courses.forEach(c => {
      if (c.skipped || c.status === 'done') return;
      timeline.push({ kind: '课程', name: c.name, startM: c.startM, endM: c.endM, location: c.location });
    });
    schedules.forEach(s => {
      if (s.done) return;
      timeline.push({
        kind: '日程',
        name: s.title,
        startM: s.startM,
        endM: s.startM + 30,
        location: s.location
      });
    });
    timeline.sort((a, b) => a.startM - b.startM);
    state.timeline = timeline;

    return { todayStr, settings, weekNo, courses, schedules };
  }

  function countdownText() {
    const nowM = dateUtil.nowMin();
    const list = state.timeline || [];
    if (!list.length) return '今天没有更多安排，放松一下';
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (nowM >= it.startM && nowM < it.endM) {
        return '「' + it.name + '」正在进行中' + (it.location ? ' · ' + it.location : '') + '，剩余约 ' + (it.endM - nowM) + ' 分钟';
      }
      if (it.startM > nowM) {
        return '距离' + it.kind + '「' + it.name + '」还有 ' + (it.startM - nowM) + ' 分钟' + (it.location ? ' · ' + it.location : '');
      }
    }
    return '今天的安排都结束了';
  }

  function renderToday() {
    const d = buildToday();
    const notif = reminder.permission();

    let html = '';

    html += '<div class="hero">'
      + '<div class="hero-top">'
      + '<span class="hero-date">' + esc(dateUtil.friendly(d.todayStr)) + '</span>'
      + '<span class="hero-week">第 ' + d.weekNo + ' 周</span>'
      + '</div>'
      + '<div class="hero-now" id="heroNow">' + dateUtil.nowHM() + '</div>'
      + '<div class="hero-next" id="heroNext">' + esc(countdownText()) + '</div>'
      + '<div class="hero-count">今天 ' + d.courses.length + ' 门课 · ' + d.schedules.length + ' 个日程</div>'
      + '</div>';

    html += '<div class="quick">'
      + '<button class="quick-btn quick-main" data-act="add-course">'
      + '<span class="quick-plus">＋</span>添加课程</button>'
      + '<button class="quick-btn quick-alt" data-act="add-schedule">'
      + '<span class="quick-plus">＋</span>添加日程</button>'
      + '</div>';

    if (notif === 'default') {
      html += '<div class="notice notice-warn">'
        + '<div class="notice-body">开启通知后，应用打开期间到点会直接弹出系统通知</div>'
        + '<button class="notice-btn" data-act="ask-notify">开启</button>'
        + '</div>';
    } else if (notif === 'denied') {
      html += '<div class="notice notice-warn">'
        + '<div class="notice-body">通知被浏览器拒绝了。想要关掉应用也能准时提醒，用「设置 → 导出到系统日历」这条路</div>'
        + '<button class="notice-btn" data-act="go-settings">去设置</button>'
        + '</div>';
    } else if (notif === 'granted') {
      html += '<div class="notice notice-ok"><div class="notice-body">系统通知已开启。关掉应用后的提醒请用「导出到系统日历」</div></div>';
    } else if (notif === 'unsupported' && typeof window.__crIsIOS === 'function' && window.__crIsIOS()) {
      // iOS 上网页拿不到通知权限，与其什么都不显示，不如把唯一有效的
      // 「关掉也能提醒」路径直接摆到首屏，省得用户去设置里翻。
      html += '<div class="notice notice-ok">'
        + '<div class="notice-body">想让 iPhone 关掉应用也能提醒？导出到系统日历即可</div>'
        + '<button class="notice-btn" data-act="export-ics">去导出</button>'
        + '</div>';
    }

    // 今天的课
    html += '<div class="section-title">今天的课</div>';
    if (!d.courses.length) {
      html += '<div class="empty">今天没有课</div>';
    } else {
      d.courses.forEach(c => {
        const tagCls = c.status === 'done' ? 'tag-gray' : (c.status === 'ing' ? 'tag-teal' : 'tag-blue');
        html += '<div class="item' + (c.skipped ? ' is-skipped' : '') + '" data-act="edit-course" data-id="' + esc(c.id) + '">'
          + '<span class="bar" style="background:' + esc(c.color) + '"></span>'
          + '<div class="grow">'
          + '<div class="row-between"><span class="item-name">' + esc(c.name) + '</span>'
          + '<span class="tag ' + tagCls + '">' + esc(c.skipped ? '本周不上' : c.statusText) + '</span></div>'
          + '<div class="item-meta">' + esc(c.periodText + ' · ' + c.timeText
            + (c.location ? ' · ' + c.location : '')
            + (c.teacher ? ' · ' + c.teacher : '')) + '</div>'
          + '</div></div>';
      });
    }

    // 今日日程
    html += '<div class="section-title">今日日程</div>';
    if (!d.schedules.length) {
      html += '<div class="empty">今天没有日程</div>';
    } else {
      d.schedules.forEach(s => {
        const tagCls = s.status === 'done' ? 'tag-teal' : (s.status === 'past' ? 'tag-red' : (s.status === 'ing' ? 'tag-amber' : 'tag-blue'));
        html += '<div class="item' + (s.done ? ' is-done' : '') + '" data-act="schedule-menu" data-id="' + esc(s.id) + '" data-date="' + esc(s.date) + '">'
          + '<span class="bar" style="background:' + esc(s.color) + '"></span>'
          + '<div class="grow">'
          + '<div class="row-between"><span class="item-name">' + esc(s.title) + '</span>'
          + '<span class="tag ' + tagCls + '">' + esc(s.statusText) + '</span></div>'
          + '<div class="item-meta">' + esc(s.timeText + (s.location ? ' · ' + s.location : '') + (s.repeatText ? ' · ' + s.repeatText : '')) + '</div>'
          + (s.note ? '<div class="item-note">' + esc(s.note) + '</div>' : '')
          + '</div></div>';
      });
    }

    return html;
  }

  /* =========================================================
     课表
     ========================================================= */

  function renderTimetable() {
    const settings = store.getSettings();
    const termWeeks = settings.termWeeks || 20;
    const currentWeekNo = dateUtil.weekNo(settings.termStart, dateUtil.today());
    if (!state.ttWeek) state.ttWeek = currentWeekNo;
    const weekNo = Math.max(1, Math.min(termWeeks, state.ttWeek));
    state.ttWeek = weekNo;

    const todayStr = dateUtil.today();
    const todayWd = dateUtil.weekday(todayStr);
    const monday = dateUtil.addDays(dateUtil.mondayOf(settings.termStart), (weekNo - 1) * 7);

    const days = [];
    for (let i = 1; i <= 7; i++) {
      const ds = dateUtil.addDays(monday, i - 1);
      const dd = dateUtil.parse(ds);
      days.push({
        key: i,
        name: periods.WEEK_NAMES[i - 1],
        date: (dd.getMonth() + 1) + '/' + dd.getDate(),
        isToday: ds === todayStr
      });
    }

    const rows = periods.all();
    const blocks = [];
    store.getCourses().forEach(c => {
      if (!c.periods || !c.periods.length) return;
      if (!store.isCourseActive(c, weekNo)) return;
      const list = c.periods.slice().sort((a, b) => a - b);
      const minP = list[0];
      const maxP = list[list.length - 1];
      const span = periods.spanOf(list);
      blocks.push({
        id: c.id,
        name: c.name,
        location: c.location || '',
        periodText: periods.label(list),
        timeText: span.start + (span.end ? '~' + span.end : ' 之后'),
        color: c.color || '#378ADD',
        day: Number(c.day),
        minP: minP,
        spanRows: maxP - minP + 1,
        isToday: weekNo === currentWeekNo && Number(c.day) === todayWd,
        skipped: store.isSkipped(todayStr, c.id)
      });
    });

    const parts = [];
    parts.push('<div class="tt-corner" style="grid-column:1;grid-row:1"></div>');
    days.forEach((d, i) => {
      parts.push('<div class="tt-day' + (d.isToday ? ' is-today' : '') + '" style="grid-column:' + (i + 2) + ';grid-row:1">'
        + '<span>' + esc(d.name) + '</span><span class="dnum">' + esc(d.date) + '</span></div>');
    });
    rows.forEach((p, r) => {
      parts.push('<div class="tt-timecell" style="grid-column:1;grid-row:' + (r + 2) + '">'
        + '<span class="pno">' + p.index + '</span><span>' + esc(p.start) + '</span></div>');
      days.forEach((d, i) => {
        parts.push('<div class="tt-cell" data-act="cell" data-day="' + d.key + '" data-period="' + p.index + '"'
          + ' style="grid-column:' + (i + 2) + ';grid-row:' + (r + 2) + '"></div>');
      });
    });
    blocks.forEach(b => {
      parts.push('<div class="tt-block' + (b.isToday ? ' is-today' : '') + (b.skipped ? ' is-skipped' : '') + '"'
        + ' data-act="block-menu" data-id="' + esc(b.id) + '"'
        + ' style="grid-column:' + (b.day + 1) + ';grid-row:' + (b.minP + 1) + ' / span ' + b.spanRows
        + ';background:' + esc(b.color) + '">'
        + '<span class="bname">' + esc(b.name) + '</span>'
        // 只有跨 3 行以上的色块才放得下地点；短色块优先保证课名清楚
        + (b.location && b.spanRows >= 3 ? '<span class="bsub">' + esc(b.location) + '</span>' : '')
        + '</div>');
    });

    const isCurrent = weekNo === currentWeekNo;

    let html = '';
    html += '<div class="weekbar">'
      + '<button class="week-nav" data-act="prev-week"' + (weekNo <= 1 ? ' disabled' : '') + '>‹</button>'
      + '<select class="week-pick" data-act="week-pick">'
      + Array.from({ length: termWeeks }, (_, i) =>
        '<option value="' + (i + 1) + '"' + (i + 1 === weekNo ? ' selected' : '') + '>第 ' + (i + 1) + ' 周'
        + (i + 1 === currentWeekNo ? '（本周）' : '') + '</option>').join('')
      + '</select>'
      + '<button class="week-nav" data-act="next-week"' + (weekNo >= termWeeks ? ' disabled' : '') + '>›</button>'
      + (isCurrent ? '' : '<button class="week-nav" data-act="back-week" title="回到本周">◎</button>')
      + '</div>';

    html += '<button class="btn btn-primary tt-add" data-act="add-course">'
      + '<span class="btn-plus">＋</span>添加课程</button>';

    html += '<div class="card tt-card"><div class="tt-scroll"><div class="tt-grid">'
      + parts.join('') + '</div></div></div>';

    html += '<div class="section-title">本周 ' + blocks.length + ' 门课'
      + (isCurrent ? '' : ' · 正在查看第 ' + weekNo + ' 周') + '，点空白格也能快速新建</div>';

    if (blocks.length) {
      html += '<div class="card"><div class="legend">'
        + blocks.map(b => '<span class="legend-item"><i class="legend-dot" style="background:' + esc(b.color) + '"></i>'
          + esc(b.name + ' ' + b.periodText)).join('')
        + '</div></div>';
    }

    return html;
  }

  /* =========================================================
     日程
     ========================================================= */

  function renderSchedule() {
    const todayStr = dateUtil.today();
    const from = dateUtil.addDays(todayStr, -BACK_DAYS);
    const to = dateUtil.addDays(todayStr, FORWARD_DAYS);
    let list = scheduleUtil.windowList(from, to, true);

    if (state.schTab === 'todo') list = list.filter(it => !it.done);
    else if (state.schTab === 'done') list = list.filter(it => it.done);

    if (state.schCategory !== '全部') {
      list = list.filter(it => it.category === state.schCategory);
    }

    if (state.schTab === 'todo') {
      const overdue = list.filter(it => it.date < todayStr);
      const rest = list.filter(it => it.date >= todayStr);
      list = overdue.concat(rest);
    } else if (state.schTab === 'done') {
      list = list.slice().reverse();
    }

    const groups = [];
    const indexMap = {};
    list.forEach(it => {
      if (indexMap[it.date] === undefined) {
        indexMap[it.date] = groups.length;
        const friendly = dateUtil.friendly(it.date).split(' ');
        groups.push({
          date: it.date,
          dateText: dateUtil.relative(it.date),
          weekText: friendly[1] || '',
          overdue: it.date < todayStr && !it.done,
          items: []
        });
      }
      groups[indexMap[it.date]].items.push(it);
    });

    let html = '';
    html += '<div class="tabs">'
      + [['todo', '待完成'], ['done', '已完成'], ['all', '全部']].map(t =>
        '<button class="tab-item' + (state.schTab === t[0] ? ' on' : '') + '" data-act="sch-tab" data-key="' + t[0] + '">' + t[1] + '</button>'
      ).join('')
      + '</div>';

    html += '<div class="chips" style="margin-bottom:6px">'
      + ['全部'].concat(CATEGORIES).map(c =>
        '<button class="chip' + (state.schCategory === c ? ' on' : '') + '" data-act="sch-cat" data-name="' + esc(c) + '">' + esc(c) + '</button>'
      ).join('')
      + '</div>';

    if (!groups.length) {
      html += '<div class="empty">这里还没有日程</div>';
      html += '<button class="btn btn-primary" data-act="add-schedule">'
        + '<span class="btn-plus">＋</span>添加日程</button>';
      return html;
    }

    groups.forEach(g => {
      html += '<div class="group-head">'
        + '<span class="group-date">' + esc(g.dateText) + '</span>'
        + '<span class="group-week">' + esc(g.weekText) + '</span>'
        + (g.overdue ? '<span class="group-over">已过期未完成</span>' : '')
        + '</div>';
      g.items.forEach(it => {
        html += '<div class="item' + (it.done ? ' is-done' : '') + '" data-act="schedule-menu" data-id="' + esc(it.id) + '" data-date="' + esc(it.date) + '">'
          + '<span class="bar" style="background:' + esc(it.color) + '"></span>'
          + '<div class="grow">'
          + '<div class="row-between"><span class="item-name">' + esc(it.title) + '</span>'
          + '<span class="tag ' + (it.done ? 'tag-teal' : 'tag-blue') + '">' + esc(it.done ? '已完成' : it.category) + '</span></div>'
          + '<div class="item-meta">' + esc(it.timeText + (it.location ? ' · ' + it.location : '') + (it.repeatText ? ' · ' + it.repeatText : '')) + '</div>'
          + (it.note ? '<div class="item-note">' + esc(it.note) + '</div>' : '')
          + '</div></div>';
      });
    });

    html += '<div class="section-title" style="margin-top:14px">共 ' + list.length + ' 项</div>';
    html += '<button class="btn btn-primary" data-act="add-schedule">'
      + '<span class="btn-plus">＋</span>添加日程</button>';

    return html;
  }

  /* =========================================================
     设置
     ========================================================= */

  function renderSettings() {
    const settings = store.getSettings();
    const perm = reminder.permission();

    // 是否跑在安卓壳里（由 js/android.js 与安卓侧 Bridge 约定）
    const isAndroidApp = !!(window.Android && typeof window.Android.platform === 'function');

    // 是否跑在 iOS 上（由 js/ios.js 标记）。iOS 版本单独走一套文案：
    // 它既不是安卓壳（没有原生通知），也不是普通网页（能装到主屏幕当 App 用）。
    const isIOS = typeof window.__crIsIOS === 'function' && window.__crIsIOS();
    const isIOSStandalone = typeof window.__crIsStandalone === 'function' && window.__crIsStandalone();

    // iOS 上「当前环境不支持」这个说法太技术，用户看了不知道该怎么办。
    // 直接说清楚：这条路上的开关在 iPhone 上不存在，请走导出日历。
    const permText = isIOS
      ? '改用系统日历提醒'
      : ({
        granted: '已开启',
        denied: '已被拒绝',
        default: '未开启',
        unsupported: '当前环境不支持'
      }[perm] || perm);

    const periodList = periods.all();
    const last = periodList[periodList.length - 1] || null;
    const linked = periods.isLinked();

    let html = '';

    /* --- 后台提醒（导出到系统日历） --- */
    html += '<div class="card">'
      + '<div class="card-title">关掉应用也能提醒'
      + '<span class="tag ' + ((!isIOS && perm === 'granted') ? 'tag-teal' : 'tag-amber') + '">' + esc(permText) + '</span>'
      + '</div>'
      + '<div class="hint" style="margin-top:0">'
      + '应用在关闭后无法自行唤醒，这是系统的限制。把课程和日程<b>导出到手机系统日历</b>，'
      + '之后由手机负责提醒——锁屏也叫、静音也震、不需要联网、不需要任何授权。'
      + '</div>'
      + '<div class="btn btn-primary mt12" data-act="export-ics">导出到系统日历（.ics）</div>'
      + (isIOS ? '' : (perm === 'granted' ? '' : '<div class="btn btn-ghost mt8" data-act="ask-notify">开启'
        + (isAndroidApp ? '系统通知' : '浏览器通知') + '（应用打开时生效）</div>'))
      + '<div class="hint">'
      + (isAndroidApp
        ? '<b>怎么用：</b>点上面的按钮 → 文件会存到手机的「下载」文件夹，并自动问你要用哪个应用打开'
          + ' → 选你的日历应用，点「全部添加」即可。'
        : isIOS
          ? '<b>怎么用：</b>点上面的按钮 → 会弹出 iPhone 的分享面板 → 选「日历」即可直接导入'
            + '（若列表里没有「日历」，就选「存储到文件」，再到「文件」App 里点开它）。'
          : '<b>怎么用：</b>点上面的按钮下载 .ics 文件 → 在手机上点开它 → 系统会问是否导入，点「全部添加」。'
            + 'iPhone 上如果没有反应，用「分享 → 存储到文件」，再到「文件」App 里点它。')
      + (isIOS
        ? '<br><b>为什么 iOS 上没有「系统通知」开关：</b>iOS 不允许网页在应用关闭后发通知，'
          + '这是系统的硬限制而非没有实现。导出到日历后由「日历」App 提醒，反而更准时。'
        : '')
      + '<br><b>什么时候重新导出：</b>课表有改动、或者新学期开始时再导一次即可，重复导入不会产生重复项。'
      + '</div>'
      + '</div>';

    /* --- 提醒 --- */
    html += '<div class="card">'
      + '<div class="card-title">提醒</div>'
      + '<div class="field"><span class="field-label">默认提前量</span>'
      + '<div class="field-body"><select data-act="remind-select">'
      + REMIND_LABELS.map((l, i) => '<option value="' + REMIND_VALUES[i] + '"'
        + (Number(settings.remindBefore) === REMIND_VALUES[i] ? ' selected' : '') + '>' + l + '</option>').join('')
      + '</select></div></div>'
      + '<div class="field"><span class="field-label">提醒震动</span>'
      + '<div class="field-body" style="display:flex;justify-content:flex-end">'
      + '<input type="checkbox" class="switch" data-act="toggle-vibrate"' + (settings.vibrate ? ' checked' : '') + '></div></div>'
      + '<div class="field"><span class="field-label">立即测试</span>'
      + '<div class="field-body" style="display:flex;justify-content:flex-end">'
      + '<button class="btn btn-ghost btn-mini" data-act="test-reminder">弹出测试提醒</button></div></div>'
      + '<div class="field"><span class="field-label">课表自检</span>'
      + '<div class="field-body" style="display:flex;justify-content:flex-end">'
      + '<button class="btn btn-ghost btn-mini" data-act="check-conflicts">检查时间冲突</button></div></div>'
      + '<div class="hint">新添加的课程与日程默认使用这里的提前量，单条也可以单独调整。</div>'
      + '</div>';

    /* --- 学期 --- */
    html += '<div class="card">'
      + '<div class="card-title">学期</div>'
      + '<div class="field"><span class="field-label">开学第一周</span>'
      + '<div class="field-body"><input type="date" data-act="term-start" value="' + esc(settings.termStart) + '"></div></div>'
      + '<div class="field"><span class="field-label">学期周数</span>'
      + '<div class="field-body"><input type="number" min="1" max="30" data-act="term-weeks" value="' + esc(settings.termWeeks) + '"></div></div>'
      + '<div class="hint">这周是<b>第 ' + dateUtil.weekNo(settings.termStart, dateUtil.today()) + ' 周</b>。'
      + '填「开学第一周的周一」的日期，单双周与周次范围都会按它计算；填错会导致课表显示错周。</div>'
      + '</div>';

    /* --- 作息时间 --- */
    html += '<div class="card">'
      + '<div class="card-title">作息时间'
      + '<span class="tag ' + (periods.isCustom() ? 'tag-amber' : 'tag-gray') + '">'
      + (periods.isCustom() ? '已自定义' : '默认') + '</span>'
      + '</div>'
      + '<div class="plist">'
      + periodList.map((p, i) => {
        const openEnd = !!p.openEnd;
        return '<div class="prow">'
          + '<span class="prow-idx">第' + p.index + '节</span>'
          + '<input type="time" data-pfield="start" data-index="' + p.index + '" value="' + esc(p.start) + '">'
          + '<span class="prow-arrow">' + (openEnd ? '之后' : '→') + '</span>'
          + '<input type="time" data-pfield="end" data-index="' + p.index + '" value="' + esc(p.end) + '"'
          + (openEnd ? ' disabled' : '') + '>'
          + '<span class="prow-flag">' + (openEnd ? '<i class="dotmark"></i>' : '') + '</span>'
          + '</div>';
      }).join('')
      + '</div>'
      + '<div class="field" style="border-top:1px solid var(--line);margin-top:6px">'
      + '<span class="field-label" style="width:auto;flex:1">相邻节次联动<span class="muted" style="display:block;font-size:12px">'
      + (linked ? '改一个边界，相连的邻居一起走' : '每节各自独立，可以留课间空档') + '</span></span>'
      + '<input type="checkbox" class="switch" data-act="toggle-link"' + (linked ? ' checked' : '') + '>'
      + '</div>'
      + '<div class="field"><span class="field-label" style="width:auto;flex:1">最后一节无固定下课时间'
      + '<span class="muted" style="display:block;font-size:12px">对应第 12 节这种「20:20 之后」</span></span>'
      + '<input type="checkbox" class="switch" data-act="toggle-openend" data-index="' + (last ? last.index : 0) + '"'
      + (last && last.openEnd ? ' checked' : '') + '>'
      + '</div>'
      + (periods.isCustom() ? '<button class="btn btn-ghost mt12" data-act="reset-periods">恢复默认作息</button>' : '')
      + '<div class="hint">点时间直接改，改完立刻应用到课表、今日页与提醒——课程只记「第几节」，作息一变时间全部跟着变，不用重新录课。</div>'
      + '</div>';

    /* --- 数据 --- */
    html += '<div class="card">'
      + '<div class="card-title">数据</div>'
      + '<div class="row-between" style="margin-bottom:12px">'
      + '<span class="muted">课程 ' + store.getCourses().length + ' 条</span>'
      + '<span class="muted">日程 ' + store.getSchedules().length + ' 条</span>'
      + '</div>'
      + '<div class="btn btn-ghost" data-act="export-json">导出备份（JSON 文件）</div>'
      + '<div class="btn btn-ghost mt8" data-act="import-json">导入备份</div>'
      + '<div class="btn btn-danger mt8" data-act="clear-data">清空所有数据</div>'
      + '<div class="hint">所有数据都保存在这台设备上，不会上传到任何服务器。换手机前记得导出备份。</div>'
      // 只在安卓壳里出现：万一页面卡在旧版本上，不用重装也能刷到最新版
      + (isAndroidApp
        ? '<div class="btn btn-ghost mt8" data-act="reload-fresh">重新加载（清缓存）</div>'
          + '<div class="hint">更新之后发现界面还是旧的，点这个不用卸载重装就能刷到最新版。</div>'
        : '')
      + '</div>';

    /* --- 诊断信息：看本机到底有没有把数据留住 --- */
    let bornText = '';
    const born = store.bornAt();
    if (born) {
      const d = new Date(born);
      bornText = '数据初始化于 ' + dateUtil.pad(d.getMonth() + 1) + '-' + dateUtil.pad(d.getDate())
        + ' ' + dateUtil.pad(d.getHours()) + ':' + dateUtil.pad(d.getMinutes()) + '<br>'
        + '（这个时间每次打开都一样，才说明数据真的存住了）';
    }

    const edition = isAndroidApp ? '安卓版' : (isIOS ? (isIOSStandalone ? 'iOS 版（已安装）' : 'iOS 版') : '网页版');

    html += '<div class="card"><div class="hint" style="margin-top:0;text-align:center">'
      + '课程与日程提醒 · ' + edition + ' ' + APP_VERSION + '<br>'
      + bornText
      + '</div></div>';

    return html;
  }

  /* =========================================================
     编辑面板
     ========================================================= */

  function openEdit(opts) {
    const type = opts.type === 'schedule' ? 'schedule' : 'course';
    const settings = store.getSettings();
    const todayStr = dateUtil.today();

    if (type === 'course') {
      const exist = opts.id ? store.getCourse(opts.id) : (opts.copy ? store.getCourse(opts.copy) : null);
      const form = {
        id: opts.copy ? '' : (opts.id || ''),
        name: '',
        teacher: '',
        location: '',
        day: Number(opts.day) || dateUtil.weekday(todayStr),
        periods: opts.period ? [Number(opts.period)] : [],
        weekType: 'all',
        weekFrom: 1,
        weekTo: Math.max(1, (settings.termWeeks || 20) - 2),
        color: store.COLORS[0],
        remindBefore: Number(settings.remindBefore),
        note: ''
      };
      if (exist) {
        form.name = exist.name || '';
        form.teacher = exist.teacher || '';
        form.location = exist.location || '';
        form.day = Number(opts.day) || Number(exist.day) || 1;
        form.periods = (exist.periods || []).slice();
        form.weekType = (exist.weeks && exist.weeks.type) || 'all';
        form.weekFrom = (exist.weeks && exist.weeks.from) || 1;
        form.weekTo = (exist.weeks && exist.weeks.to) || Math.max(1, (settings.termWeeks || 20) - 2);
        form.color = exist.color || store.COLORS[0];
        form.remindBefore = exist.remindBefore === undefined ? Number(settings.remindBefore) : Number(exist.remindBefore);
        form.note = exist.note || '';
        form.weeks = exist.weeks;
      }
      state.edit = { type: 'course', form: form, isEdit: !!opts.id };
    } else {
      const exist = opts.id ? store.getSchedule(opts.id) : null;
      const startDefault = dateUtil.nowHM();
      const form = {
        id: '',
        title: '',
        date: todayStr,
        startTime: startDefault,
        // 新建时给个 1 小时后的结束时间，免得输入框空着像没填完
        endTime: dateUtil.fromMin(dateUtil.toMin(startDefault) + 60),
        location: '',
        category: '作业',
        color: store.COLORS[3],
        remindBefore: Number(settings.remindBefore),
        note: '',
        done: false,
        repeatType: 'none',
        until: '',
        doneDates: []
      };
      if (exist) {
        form.id = exist.id;
        form.title = exist.title || '';
        form.date = exist.date || todayStr;
        form.startTime = exist.startTime || dateUtil.nowHM();
        form.endTime = exist.endTime || '';
        form.location = exist.location || '';
        form.category = exist.category || '其他';
        form.color = exist.color || store.COLORS[3];
        form.remindBefore = (exist.remindBefore === undefined || exist.remindBefore === null)
          ? Number(settings.remindBefore) : Number(exist.remindBefore);
        form.note = exist.note || '';
        form.done = !!exist.done;
        form.repeatType = (exist.repeat && exist.repeat.type) || 'none';
        form.until = (exist.repeat && exist.repeat.until) || '';
        form.doneDates = (exist.doneDates || []).slice();
      }
      state.edit = { type: 'schedule', form: form, isEdit: !!opts.id };
    }

    renderPanel();
    $('panel').classList.add('on');
    $('panel').scrollTop = 0;
  }

  function closeEdit() {
    state.edit = null;
    $('panel').classList.remove('on');
    $('panel').innerHTML = '';
  }

  function field(label, key, opts) {
    const o = opts || {};
    const v = state.edit.form[key];
    const t = o.type || 'text';
    let control;
    if (t === 'textarea') {
      control = '<textarea rows="' + (o.rows || 3) + '" data-efield="' + key + '" placeholder="'
        + esc(o.placeholder || '') + '">' + esc(v) + '</textarea>';
    } else {
      control = '<input type="' + t + '" data-efield="' + key + '" value="' + esc(v) + '"'
        + (o.min != null ? ' min="' + o.min + '"' : '')
        + (o.max != null ? ' max="' + o.max + '"' : '')
        + ' placeholder="' + esc(o.placeholder || '') + '">';
    }
    return '<div class="field' + (t === 'textarea' ? ' field-top' : '') + '">'
      + '<span class="field-label">' + esc(label) + '</span>'
      + '<div class="field-body">' + control + '</div></div>';
  }

  function chipGroup(act, items, isOn, extra) {
    return '<div class="chips">' + items.map(it =>
      '<button class="chip' + (isOn(it) ? ' on' : '') + '" data-act="' + act + '" ' + (extra || '')
      + ' data-key="' + esc(it.key) + '">' + esc(it.text) + '</button>'
    ).join('') + '</div>';
  }

  function colorRow(key) {
    return '<div class="color-row">' + store.COLORS.map(c =>
      '<button class="color-item' + (state.edit.form[key] === c ? ' on' : '') + '"'
      + ' data-act="pick-color" data-key="' + esc(key) + '" data-color="' + esc(c) + '"'
      + ' style="background:' + esc(c) + '"></button>'
    ).join('') + '</div>';
  }

  function renderPanel() {
    if (!state.edit) return;
    const e = state.edit;
    const f = e.form;
    let html = '';

    html += '<div class="panel-head">'
      + '<button class="panel-link" data-act="close-panel">取消</button>'
      + '<span class="panel-title">' + (e.type === 'course'
        ? (e.isEdit ? '编辑课程' : '添加课程')
        : (e.isEdit ? '编辑日程' : '添加日程')) + '</span>'
      + '<button class="panel-link' + (e.isEdit ? '' : '') + '" data-act="save">保存</button>'
      + '</div>';

    html += '<div class="panel-body">';

    if (e.type === 'course') {
      html += '<div class="card">'
        + field('课程名称', 'name', { placeholder: '必填，例如 高等数学' })
        + field('上课地点', 'location', { placeholder: '例如 教三楼 305' })
        + field('授课老师', 'teacher', { placeholder: '选填' })
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">上课时间</div>'
        + '<div class="section-title" style="margin:0 0 8px 0">星期</div>'
        + chipGroup('pick-day', periods.WEEK_NAMES.map((n, i) => ({ key: i + 1, text: n })), it => Number(f.day) === Number(it.key))
        + '<div class="section-title" style="margin:14px 0 8px 0">节次（可多选，连堂一次选完）</div>'
        + '<div class="period-grid" id="periodGrid">'
        + periods.all().map(p =>
          '<button class="pchip' + (f.periods.indexOf(p.index) >= 0 ? ' on' : '') + '"'
          + ' data-act="toggle-period" data-key="' + p.index + '">'
          + '<span class="pn">' + p.index + '</span>'
          + '<span>' + esc(p.start) + '</span></button>'
        ).join('')
        + '</div>'
        + '<div id="spanBox">' + spanBoxHtml() + '</div>'
        + '<button class="btn btn-ghost btn-mini mt12" data-act="clear-periods">清空节次</button>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">周次</div>'
        + chipGroup('pick-weektype', [
          { key: 'all', text: '每周' }, { key: 'odd', text: '单周' }, { key: 'even', text: '双周' }
        ], it => f.weekType === it.key)
        + '<div class="field" style="margin-top:12px"><span class="field-label">起止周</span>'
        + '<div class="field-body row" style="gap:8px">'
        + '<select data-efield="weekFrom" style="flex:1">'
        + Array.from({ length: settingsWeeks() }, (_, i) =>
          '<option value="' + (i + 1) + '"' + (Number(f.weekFrom) === i + 1 ? ' selected' : '') + '>第 ' + (i + 1) + ' 周</option>').join('')
        + '</select>'
        + '<span class="muted">至</span>'
        + '<select data-efield="weekTo" style="flex:1">'
        + Array.from({ length: settingsWeeks() }, (_, i) =>
          '<option value="' + (i + 1) + '"' + (Number(f.weekTo) === i + 1 ? ' selected' : '') + '>第 ' + (i + 1) + ' 周</option>').join('')
        + '</select>'
        + '</div></div>'
        + '<div class="hint">单周 = 第 1、3、5… 周；双周 = 第 2、4、6… 周。'
        + '「起止周」决定这门课从第几周上到第几周。</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">颜色与提醒</div>'
        + colorRow('color')
        + '<div class="field" style="margin-top:12px"><span class="field-label">提前提醒</span>'
        + '<div class="field-body"><select data-efield="remindBefore">'
        + REMIND_LABELS.map((l, i) => '<option value="' + REMIND_VALUES[i] + '"'
          + (Number(f.remindBefore) === REMIND_VALUES[i] ? ' selected' : '') + '>' + l + '</option>').join('')
        + '</select></div></div>'
        + field('备注', 'note', { type: 'textarea', placeholder: '例如 带课本和作业本' })
        + '</div>';

      if (e.isEdit) {
        html += '<button class="btn btn-danger" data-act="remove">删除课程</button>';
      }
    } else {
      html += '<div class="card">'
        + field('标题', 'title', { placeholder: '必填，例如 交高数作业' })
        + field('日期', 'date', { type: 'date' })
        + '<div class="field"><span class="field-label">时间</span>'
        + '<div class="field-body row" style="gap:8px">'
        + '<input type="time" data-efield="startTime" value="' + esc(f.startTime) + '" style="flex:1">'
        + '<span class="muted">至</span>'
        + '<input type="time" data-efield="endTime" value="' + esc(f.endTime) + '" style="flex:1">'
        + '</div></div>'
        + field('地点', 'location', { placeholder: '选填' })
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">分类与颜色</div>'
        + chipGroup('pick-category', CATEGORIES.map(c => ({ key: c, text: c })), it => f.category === it.key)
        + '<div class="mt12">' + colorRow('color') + '</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">重复</div>'
        + chipGroup('pick-repeat', REPEAT_KEYS.map((k, i) => ({ key: k, text: REPEAT_LABELS[i] })), it => f.repeatType === it.key)
        + '<div id="untilBox">' + untilBoxHtml() + '</div>'
        + '<div class="hint">重复日程在列表里会展开成每一次安排，<b>可以只把某一次标记完成</b>（这周作业交了，后面的照常提醒）。</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">提醒</div>'
        + '<div class="field"><span class="field-label">提前提醒</span>'
        + '<div class="field-body"><select data-efield="remindBefore">'
        + REMIND_LABELS.map((l, i) => '<option value="' + REMIND_VALUES[i] + '"'
          + (Number(f.remindBefore) === REMIND_VALUES[i] ? ' selected' : '') + '>' + l + '</option>').join('')
        + '</select></div></div>'
        + field('备注', 'note', { type: 'textarea', placeholder: '选填' })
        + '</div>';

      if (e.isEdit) {
        html += '<button class="btn btn-danger" data-act="remove">删除日程</button>';
      }
    }

    html += '</div>';
    $('panel').innerHTML = '<div class="panel-inner">' + html + '</div>';
  }

  function settingsWeeks() {
    return Math.max(1, Number(store.getSettings().termWeeks) || 20);
  }

  function spanBoxHtml() {
    const f = state.edit.form;
    const list = (f.periods || []).slice().sort((a, b) => a - b);
    if (!list.length) {
      return '<div class="tip-card info" style="margin-top:12px;margin-bottom:0">还没选节次。点上面的方格选择，连堂课可以一次点亮多格。</div>';
    }
    const span = periods.spanOf(list);
    const contig = periods.isContiguous(list);
    const text = periods.label(list) + ' · ' + span.start + (span.end ? ' ~ ' + span.end : ' 之后')
      + ' · 共 ' + list.length + ' 节';
    if (contig) {
      return '<div class="tip-card ok" style="margin-top:12px;margin-bottom:0">' + esc(text) + '</div>';
    }
    return '<div class="tip-card" style="margin-top:12px;margin-bottom:0">'
      + esc(text) + '<br>注意：选中的节次不连续，课表上会显示成跨行的整块。通常连堂课选连续节次。</div>';
  }

  function untilBoxHtml() {
    const f = state.edit.form;
    if (f.repeatType === 'none') return '';
    return '<div class="field" style="margin-top:12px"><span class="field-label">重复至</span>'
      + '<div class="field-body row" style="gap:8px">'
      + '<input type="date" data-efield="until" value="' + esc(f.until) + '" style="flex:1">'
      + '<button class="btn btn-ghost btn-mini" data-act="clear-until">不设截止</button>'
      + '</div></div>'
      + '<div class="hint">留空表示一直重复。默认填的是 8 周后，可以改。</div>';
  }

  /* =========================================================
     保存
     ========================================================= */

  function saveEdit() {
    if (!state.edit) return;
    if (state.edit.type === 'course') saveCourse();
    else saveSchedule();
  }

  function saveCourse() {
    const f = state.edit.form;
    if (!String(f.name || '').trim()) { ui.toast('请填写课程名称'); return; }
    if (!f.periods || !f.periods.length) { ui.toast('请至少选择一节课'); return; }

    let from = Number(f.weekFrom) || 1;
    let to = Number(f.weekTo) || 1;
    if (from > to) { const t = from; from = to; to = t; }

    const record = {
      id: f.id || store.genId(),
      name: String(f.name).trim(),
      teacher: String(f.teacher || '').trim(),
      location: String(f.location || '').trim(),
      day: Number(f.day),
      periods: f.periods.slice().sort((a, b) => a - b),
      weeks: { type: f.weekType, from: from, to: to },
      color: f.color,
      remindBefore: Number(f.remindBefore),
      note: String(f.note || '').trim(),
      demo: false
    };

    const conflicts = store.findCourseConflicts(record);
    if (conflicts.length) {
      const desc = conflicts.map(item =>
        '「' + item.name + '」第' + item.periods.join('、') + '节' + (item.location ? '（' + item.location + '）' : '')
      ).join('\n');
      ui.dialog({
        title: '时间冲突提醒',
        body: '与已有课程时间重叠：\n' + desc + '\n\n仍然保存吗？',
        confirmText: '仍然保存',
        danger: true
      }).then(ok => {
        if (!ok) return;
        store.upsertCourse(record);
        finishSave('课程已保存');
      });
      return;
    }

    store.upsertCourse(record);
    finishSave('课程已保存');
  }

  function saveSchedule() {
    const f = state.edit.form;
    if (!String(f.title || '').trim()) { ui.toast('请填写日程标题'); return; }
    if (!f.startTime) { ui.toast('请选择开始时间'); return; }
    if (f.repeatType !== 'none' && f.until && f.until < f.date) {
      ui.toast('截止日期早于开始日期');
      return;
    }
    const record = {
      id: f.id || store.genId(),
      title: String(f.title).trim(),
      date: f.date || dateUtil.today(),
      startTime: f.startTime,
      endTime: f.endTime || '',
      location: String(f.location || '').trim(),
      category: f.category || '其他',
      color: f.color,
      remindBefore: Number(f.remindBefore),
      note: String(f.note || '').trim(),
      done: !!f.done,
      demo: false,
      repeat: { type: f.repeatType || 'none', until: f.repeatType === 'none' ? '' : (f.until || '') },
      doneDates: (f.doneDates || []).slice()
    };
    store.upsertSchedule(record);
    finishSave('日程已保存');
  }

  function finishSave(title) {
    ui.toast(title);
    closeEdit();
    render();
  }

  async function removeEditing() {
    const e = state.edit;
    if (!e || !e.isEdit) return;
    const isCourse = e.type === 'course';
    const name = isCourse ? e.form.name : e.form.title;
    const id = e.form.id;
    const isRepeat = !isCourse && e.form.repeatType !== 'none';
    const ok = await ui.dialog({
      title: isCourse ? '删除课程' : '删除日程',
      body: isRepeat
        ? '「' + name + '」是重复日程，将删除整个重复安排及其完成记录，确定吗？'
        : '确定删除「' + name + '」吗？',
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    if (isCourse) store.removeCourse(id);
    else store.removeSchedule(id);
    ui.toast('已删除');
    closeEdit();
    render();
  }

  /* =========================================================
     事件
     ========================================================= */

  function bindEvents() {
    const view = $('view');

    view.addEventListener('click', e => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.getAttribute('data-act');
      const id = el.getAttribute('data-id');
      const date = el.getAttribute('data-date');

      switch (act) {
        case 'add-course': openEdit({ type: 'course', day: dateUtil.weekday(dateUtil.today()) }); break;
        case 'add-schedule': openEdit({ type: 'schedule' }); break;
        case 'edit-course': openEdit({ type: 'course', id: id }); break;
        case 'schedule-menu': scheduleMenu(id, date, true); break;
        case 'ask-notify': askNotify(); break;
        case 'go-settings': switchTab('settings'); break;
        case 'cell': openEdit({ type: 'course', day: el.getAttribute('data-day'), period: el.getAttribute('data-period') }); break;
        case 'block-menu': blockMenu(id); break;
        case 'prev-week': state.ttWeek -= 1; render(); break;
        case 'next-week': state.ttWeek += 1; render(); break;
        case 'back-week': state.ttWeek = null; render(); break;
        case 'sch-tab': state.schTab = el.getAttribute('data-key'); render(); break;
        case 'sch-cat': state.schCategory = el.getAttribute('data-name'); render(); break;
        default: settingsAct(act, el); break;
      }
    });

    view.addEventListener('change', e => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.getAttribute('data-act');
      if (act === 'week-pick') { state.ttWeek = Number(el.value); render(); return; }
      if (act === 'remind-select') {
        store.saveSettings({ remindBefore: Number(el.value) });
        ui.toast('已保存');
        return;
      }
      if (act === 'term-start') {
        store.saveSettings({ termStart: el.value });
        ui.toast('已保存');
        render();
        return;
      }
      if (act === 'term-weeks') {
        const n = Math.max(1, Math.min(30, Number(el.value) || 20));
        el.value = n;
        store.saveSettings({ termWeeks: n });
        render();
        return;
      }
      if (act === 'toggle-vibrate') { store.saveSettings({ vibrate: el.checked }); return; }
      if (act === 'toggle-link') {
        periods.setLinked(el.checked);
        ui.toast(el.checked ? '改一边会带一边' : '每节时间各自独立');
        render();
        return;
      }
      if (act === 'toggle-openend') {
        const index = Number(el.getAttribute('data-index')) || periods.total();
        const r = periods.toggleOpenEnd(index, el.checked);
        if (!r.ok && r.message) ui.alert('改不了', r.message);
        else ui.toast(el.checked ? '该节不再设下课时间' : '该节恢复固定下课时间');
        render();
        return;
      }
      if (act === 'export-ics') return;
    });

    // 作息时间：改某一节的上课 / 下课时间
    view.addEventListener('change', e => {
      const el = e.target;
      if (!el.hasAttribute || !el.hasAttribute('data-pfield')) return;
      const index = Number(el.getAttribute('data-index'));
      const f = el.getAttribute('data-pfield');
      const r = periods.setTime(index, f, el.value);
      if (!r.ok) {
        if (r.message) ui.alert('这个时间不合适', r.message);
        render();
        return;
      }
      render();
      if (r.synced && r.synced.length) {
        const s = r.synced[0];
        ui.toast('第' + s.index + '节的' + (s.field === 'start' ? '上课' : '下课') + '时间已一起调整');
      }
    });

    view.addEventListener('input', e => {
      const el = e.target;
      if (!el.hasAttribute || !el.hasAttribute('data-pfield')) return;
      // 输入过程中不立即校验，等 change 触发
    });

    // 标签栏
    $('tabbar').addEventListener('click', e => {
      const el = e.target.closest('[data-tab]');
      if (!el) return;
      switchTab(el.getAttribute('data-tab'));
    });

    // 编辑面板
    const panel = $('panel');

    panel.addEventListener('click', e => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.getAttribute('data-act');
      const key = el.getAttribute('data-key');
      const f = state.edit ? state.edit.form : null;
      if (!f && act !== 'close-panel') return;

      switch (act) {
        case 'close-panel': closeEdit(); break;
        case 'save': saveEdit(); break;
        case 'remove': removeEditing(); break;
        case 'pick-day': f.day = Number(key); markOn(el); break;
        case 'pick-weektype':
          f.weekType = key;
          markOn(el);
          break;
        case 'pick-category': f.category = key; markOn(el); break;
        case 'pick-repeat': {
          f.repeatType = key;
          markOn(el);
          if (key !== 'none' && !f.until) {
            f.until = dateUtil.addDays(f.date || dateUtil.today(), 56);
            ui.toast('默认重复 8 周，可修改截止日期');
          }
          if (key === 'none' && f.until) f.until = '';
          const box = $('untilBox');
          if (box) box.innerHTML = untilBoxHtml();
          break;
        }
        case 'clear-until': {
          f.until = '';
          const box = $('untilBox');
          if (box) box.innerHTML = untilBoxHtml();
          break;
        }
        case 'pick-color': f[el.getAttribute('data-key')] = el.getAttribute('data-color'); markColor(el); break;
        case 'toggle-period': {
          const n = Number(key);
          const i = f.periods.indexOf(n);
          if (i >= 0) f.periods.splice(i, 1);
          else f.periods.push(n);
          el.classList.toggle('on');
          const box = $('spanBox');
          if (box) box.innerHTML = spanBoxHtml();
          break;
        }
        case 'clear-periods': {
          f.periods = [];
          panel.querySelectorAll('.pchip.on').forEach(c => c.classList.remove('on'));
          const box = $('spanBox');
          if (box) box.innerHTML = spanBoxHtml();
          break;
        }
        default: break;
      }
    });

    panel.addEventListener('change', e => {
      const el = e.target;
      if (!el.hasAttribute) return;
      const f = state.edit ? state.edit.form : null;
      if (!f) return;

      const ef = el.getAttribute('data-efield');
      if (!ef) return;

      if (ef === 'weekFrom' || ef === 'weekTo') {
        f[ef] = Number(el.value);
        // 起止周互相兜底，避免出现 5 到 3 这种区间
        if (ef === 'weekFrom' && f.weekFrom > f.weekTo) {
          f.weekTo = f.weekFrom;
          const sel = panel.querySelector('[data-efield="weekTo"]');
          if (sel) sel.value = f.weekTo;
        }
        if (ef === 'weekTo' && f.weekTo < f.weekFrom) {
          f.weekFrom = f.weekTo;
          const sel = panel.querySelector('[data-efield="weekFrom"]');
          if (sel) sel.value = f.weekFrom;
        }
        return;
      }

      if (ef === 'date') {
        f.date = el.value;
        if (f.repeatType !== 'none' && f.until && f.until < f.date) {
          f.until = dateUtil.addDays(f.date, 56);
          const box = $('untilBox');
          if (box) box.innerHTML = untilBoxHtml();
        }
        return;
      }

      if (ef === 'startTime') {
        f.startTime = el.value;
        if (!f.endTime) {
          f.endTime = dateUtil.fromMin(dateUtil.toMin(el.value) + 60);
          const endInput = panel.querySelector('[data-efield="endTime"]');
          if (endInput) endInput.value = f.endTime;
        }
        return;
      }

      if (ef === 'remindBefore') { f.remindBefore = Number(el.value); return; }

      f[ef] = el.value;
    });

    panel.addEventListener('input', e => {
      const el = e.target;
      if (!el.hasAttribute || !state.edit) return;
      const ef = el.getAttribute('data-efield');
      if (!ef) return;
      const f = state.edit.form;
      if (ef === 'remindBefore') f.remindBefore = Number(el.value);
      else if (ef === 'weekFrom' || ef === 'weekTo') f[ef] = Number(el.value);
      else f[ef] = el.value;
    });
  }

  function markOn(el) {
    const group = el.parentNode;
    if (!group) return;
    Array.prototype.forEach.call(group.children, c => c.classList.remove('on'));
    el.classList.add('on');
  }

  function markColor(el) {
    const group = el.parentNode;
    if (!group) return;
    Array.prototype.forEach.call(group.children, c => c.classList.remove('on'));
    el.classList.add('on');
  }

  /* =========================================================
     各种菜单
     ========================================================= */

  async function blockMenu(id) {
    const course = store.getCourse(id);
    if (!course) return;
    const todayStr = dateUtil.today();
    const settings = store.getSettings();
    const isCurrentWeek = state.ttWeek === dateUtil.weekNo(settings.termStart, todayStr);
    const canSkip = isCurrentWeek && Number(course.day) === dateUtil.weekday(todayStr);

    const items = [
      { text: '编辑课程' },
      { text: '复制为新课程' },
      { text: '删除课程', danger: true }
    ];
    if (canSkip) {
      items.push({ text: store.isSkipped(todayStr, id) ? '恢复本周这节课' : '本周这节课不上' });
    }

    const idx = await ui.sheet(items);
    if (idx < 0) return;
    const label = items[idx].text;

    if (label === '编辑课程') {
      openEdit({ type: 'course', id: id });
    } else if (label === '复制为新课程') {
      openEdit({ type: 'course', copy: id });
    } else if (label === '删除课程') {
      const ok = await ui.dialog({
        title: '删除课程',
        body: '确定删除「' + course.name + '」吗？',
        confirmText: '删除',
        danger: true
      });
      if (ok) { store.removeCourse(id); render(); }
    } else {
      if (store.isSkipped(todayStr, id)) store.removeSkip(todayStr, id);
      else store.addSkip(todayStr, id);
      render();
      ui.toast('已更新');
    }
  }

  async function scheduleMenu(id, date, fromToday) {
    const item = store.getSchedule(id);
    if (!item) return;
    const targetDate = date || item.date;
    const isRepeat = !!(item.repeat && item.repeat.type && item.repeat.type !== 'none');
    const doneNow = scheduleUtil.isDoneOn(item, targetDate);
    const doneLabel = isRepeat
      ? (doneNow ? '本次标记为未完成' : '本次已完成')
      : (doneNow ? '标记为未完成' : '标记为已完成');

    const items = [
      { text: doneLabel, primary: true },
      { text: '编辑' },
      { text: '删除', danger: true }
    ];

    const idx = await ui.sheet(items);
    if (idx < 0) return;

    if (idx === 0) {
      scheduleUtil.toggleDone(item, targetDate);
      store.upsertSchedule(item);
      render();
      ui.toast(doneNow ? '已恢复' : '已完成');
    } else if (idx === 1) {
      openEdit({ type: 'schedule', id: id });
    } else {
      const ok = await ui.dialog({
        title: '删除日程',
        body: isRepeat
          ? '「' + item.title + '」是重复日程，将删除整个重复安排，确定吗？'
          : '确定删除「' + item.title + '」吗？',
        confirmText: '删除',
        danger: true
      });
      if (ok) { store.removeSchedule(id); render(); }
    }
    void fromToday;
  }

  async function askNotify() {
    if (!reminder.supported()) {
      ui.alert('这个环境不支持系统通知', '可能是浏览器太旧，或者页面不是以 https / localhost 打开。'
        + '不影响「导出到系统日历」，那条路一样能准时提醒。');
      return;
    }
    const p = await reminder.requestPermission();
    if (p === 'granted') {
      ui.toast('通知已开启，测试一条看看');
      reminder.testFire();
    } else if (p === 'denied') {
      ui.alert('通知被拒绝了', '浏览器会记住这个选择。想改的话，点地址栏左边的锁形图标 → 通知 → 允许，然后刷新页面。\n\n'
        + '即使不用通知，「导出到系统日历」也能让手机在关掉应用后准时提醒你。');
    }
    render();
  }

  async function settingsAct(act, el) {
    void el;
    switch (act) {
      case 'test-reminder':
        reminder.testFire();
        break;

      // 安卓壳专用：清掉离线缓存后重载，把页面刷到包内的最新版本
      case 'reload-fresh': {
        ui.toast('正在清缓存并重新载入…');
        if (typeof window.__crReloadFresh === 'function') window.__crReloadFresh();
        else window.location.reload();
        break;
      }

      case 'check-conflicts': {
        const courses = store.getCourses();
        const seen = {};
        const problems = [];
        courses.forEach(c => {
          store.findCourseConflicts(c).forEach(cf => {
            const key = [c.id, cf.id].sort().join('_');
            if (seen[key]) return;
            seen[key] = true;
            problems.push('「' + c.name + '」与「' + cf.name + '」在' + periods.WEEK_NAMES[Number(c.day) - 1]
              + '第' + cf.periods.join('、') + '节重叠');
          });
        });
        if (!problems.length) ui.alert('课表自检', '没有发现时间冲突的课程。');
        else ui.alert('发现 ' + problems.length + ' 处冲突', problems.join('\n'));
        break;
      }

      case 'reset-periods': {
        const ok = await ui.dialog({
          title: '恢复默认作息',
          body: '将放弃当前自定义的节次时间，回到内置的 12 节作息，确定吗？',
          confirmText: '恢复默认'
        });
        if (!ok) return;
        periods.reset();
        render();
        ui.toast('已恢复默认');
        break;
      }

      case 'export-ics': {
        const choice = await ui.sheet([
          { text: '导出全部（课程 + 日程）', primary: true },
          { text: '只导出课程' },
          { text: '只导出日程' }
        ]);
        if (choice < 0) return;
        const opts = choice === 1 ? { courses: true, schedules: false }
          : (choice === 2 ? { courses: false, schedules: true } : { courses: true, schedules: true });
        const r = ics.generate(opts);
        if (!r.count) {
          ui.alert('没有可导出的内容', '先去课表或日程里添加一些内容，再来导出。');
          return;
        }
        const name = '课程与日程.ics';
        const res = await ics.save(name, r.text);
        if (res === 'cancelled') return;
        if (res === 'failed') {
          ui.alert('导出失败', '当前浏览器不允许保存文件。可以换 Chrome 或 Safari 再试。');
          return;
        }
        ui.alert('已生成 ' + r.count + ' 条日程',
          (window.Android && typeof window.Android.platform === 'function'
            ? '文件已存到手机的「下载」文件夹，并会问你用哪个应用打开——选日历应用，点「全部添加」即可。'
            : (typeof window.__crIsIOS === 'function' && window.__crIsIOS())
              ? '分享面板里选「日历」即可直接导入；若没有这一项，选「存储到文件」，再到「文件」App 里点开它。'
              : '打开下载好的 .ics 文件，手机会问是否导入日历，点「全部添加」即可。')
          + '\n\n'
          + '之后由系统负责提醒：锁屏也叫、静音也震、关掉应用照样准点，完全不需要联网。\n\n'
          + '课表有变动时重新导出一次即可，重复导入不会产生重复项。');
        break;
      }

      case 'export-json': {
        const text = JSON.stringify(store.exportAll(), null, 2);
        const stamp = dateUtil.today();
        const res = await ics.save('课程备份-' + stamp + '.json', text, 'application/json');
        if (res !== 'failed') ui.toast('备份已导出');
        break;
      }

      case 'import-json': {
        importJson();
        break;
      }

      case 'clear-data': {
        const ok = await ui.dialog({
          title: '清空所有数据',
          body: '课程与日程都会被删除，且无法恢复，确定吗？',
          confirmText: '清空',
          danger: true
        });
        if (!ok) return;
        store.clearAll();
        render();
        ui.toast('已清空');
        break;
      }

      default:
        break;
    }
    void el;
  }

  function importJson() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json,text/plain';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const text = String(reader.result || '').trim();
        const ok = await ui.dialog({
          title: '导入数据',
          body: '将用备份文件中的数据覆盖现有课程与日程，确定继续吗？',
          confirmText: '继续导入'
        });
        if (!ok) { input.remove(); return; }
        try {
          store.importAll(JSON.parse(text));
          render();
          ui.toast('导入成功');
        } catch (err) {
          ui.alert('导入失败', '这个文件不是有效的备份数据。\n\n' + (err && err.message ? err.message : ''));
        }
        input.remove();
      };
      reader.onerror = () => {
        ui.alert('读取失败', '没能读出这个文件，换一个再试。');
        input.remove();
      };
      reader.readAsText(file);
    });
    document.body.appendChild(input);
    input.click();
  }

  /* =========================================================
     渲染与启动
     ========================================================= */

  // 切页时让内容依次浮上来。只在切换底部导航时放，筛选 / 换周这类重绘不放，
  // 否则每点一下整页都在抖。
  let pageInTimer = null;

  function playPageIn() {
    const view = $('view');
    view.classList.remove('paging');
    void view.offsetWidth;            // 强制重排，动画才会重新播一遍
    view.classList.add('paging');
    if (pageInTimer) clearTimeout(pageInTimer);
    pageInTimer = setTimeout(() => view.classList.remove('paging'), 600);
  }

  function switchTab(tab) {
    const changed = state.tab !== tab;
    state.tab = tab;
    render();
    window.scrollTo(0, 0);
    if (changed) playPageIn();
  }

  function render() {
    const view = $('view');
    if (state.tab === 'today') view.innerHTML = renderToday();
    else if (state.tab === 'timetable') view.innerHTML = renderTimetable();
    else if (state.tab === 'schedule') view.innerHTML = renderSchedule();
    else view.innerHTML = renderSettings();

    Array.prototype.forEach.call($('tabbar').children, b => {
      b.classList.toggle('on', b.getAttribute('data-tab') === state.tab);
    });
  }

  function tickHero() {
    if (state.tab !== 'today') return;
    const now = $('heroNow');
    const next = $('heroNext');
    if (!now || !next) return;
    now.textContent = dateUtil.nowHM();
    next.textContent = countdownText();
  }

  function startHeroTick() {
    setInterval(tickHero, 20000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tickHero();
    });
  }

  function boot() {
    store.init();
    bindEvents();
    ui.bindRipple();          // 按下水波纹：一次绑定，之后动态生成的按钮也有效
    reminder.on(item => ui.reminderAlert(item));
    reminder.start();
    render();
    startHeroTick();

    // 让首页的倒计时立刻反映真实状态
    tickHero();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  CR.app = { render: render, switchTab: switchTab, state: state, closeEdit: closeEdit };
})(window);
