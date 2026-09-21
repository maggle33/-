/**
 * 导出为 iCalendar（.ics）
 *
 * 为什么需要它：网页应用无法在关闭后自行唤醒，但手机系统可以。
 * 把课程与日程写成 .ics 交给系统日历，之后由**系统**负责排程提醒——
 * 锁屏也响、静音也震、关掉浏览器照样准点，且不需要任何服务器与授权。
 *
 * 要点：
 *   - 时间用「浮动时间」（不带 Z、不含 VTIMEZONE），日历应用会按手机本地时间处理，
 *     避免时区转换把 08:00 的课变成 07:00。
 *   - 课程用 FREQ=WEEKLY 重复；单双周用 INTERVAL=2 + COUNT 表达。
 *   - 每条事件都带 VALARM，提前量取自各自的 remindBefore。
 */

(function (global) {
  'use strict';

  const CR = global.CR;
  const store = CR.store;
  const dateUtil = CR.date;
  const periods = CR.periods;
  const scheduleUtil = CR.schedule;

  const CRLF = '\r\n';

  /**
   * 是不是 iOS 设备。
   * iPadOS 13+ 的 Safari 会把自己伪装成 Mac，所以补一个触摸点判断。
   */
  const isIOS = /iPad|iPhone|iPod/.test(global.navigator.userAgent || '')
    || (global.navigator.platform === 'MacIntel' && global.navigator.maxTouchPoints > 1);

  /**
   * iOS 上的分享面板里，「日历」并不是一个总能选到的目标——
   * 取决于用户的日历账户配置。若分享面板里没有日历，也可存进「文件」，
   * 再点开该文件由系统导入。这个标记用于设置页给出更准确的说明。
   */
  const isIOSStandalone = !!(global.navigator.standalone);

  /* ---------------- 基础格式 ---------------- */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /** 'YYYY-MM-DD' + 'HH:MM' -> Date（本地时间） */
  function toDate(dateStr, timeStr) {
    const d = dateUtil.parse(dateStr);
    d.setMinutes(dateUtil.toMin(timeStr));
    return d;
  }

  /** Date -> 'YYYYMMDDTHHMMSS'（浮动时间，不带 Z） */
  function stamp(d) {
    return d.getFullYear()
      + pad2(d.getMonth() + 1)
      + pad2(d.getDate())
      + 'T'
      + pad2(d.getHours())
      + pad2(d.getMinutes())
      + pad2(d.getSeconds());
  }

  /** Date -> 'YYYYMMDD' */
  function dateStamp(d) {
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  /** iCalendar 文本值转义 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /**
   * 按 RFC 5545 折行：每行不超过 75 个八位组，续行以一个空格开头。
   * 中文按 UTF-8 计算字节数，不能按字符数算。
   */
  function fold(line) {
    const bytes = [];
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      if (code < 0x80) bytes.push([code, 1]);
      else if (code < 0x800) bytes.push([i, 2]);
      else bytes.push([i, 3]);
    }
    // 逐字符累加字节数，超过 73 就断开（留出续行前导空格）
    const out = [];
    let cur = '';
    let curBytes = 0;
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      const size = code < 0x80 ? 1 : (code < 0x800 ? 2 : 3);
      if (curBytes + size > 73) {
        out.push(cur);
        cur = ' ';
        curBytes = 1;
      }
      cur += line[i];
      curBytes += size;
    }
    out.push(cur);
    return out.join(CRLF);
  }

  function addMinutes(d, minutes) {
    const t = new Date(d.getTime());
    t.setMinutes(t.getMinutes() + Number(minutes || 0));
    return t;
  }

  function uid(prefix, id) {
    return prefix + '-' + id + '@campus-reminder';
  }

  function alarmBlock(minutes, summary) {
    if (!minutes || Number(minutes) <= 0) return '';
    return [
      'BEGIN:VALARM',
      'TRIGGER:-PT' + Number(minutes) + 'M',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + esc(summary || '即将开始'),
      'END:VALARM'
    ].join(CRLF) + CRLF;
  }

  /* ---------------- 课程 ---------------- */

  /**
   * 一门课 -> 一条重复事件
   * 周次处理：
   *   all      FREQ=WEEKLY;COUNT=周数
   *   odd/even FREQ=WEEKLY;INTERVAL=2;COUNT=符合条件的周数
   */
  function courseEvent(course, settings) {
    const weeks = course.weeks || { type: 'all' };
    const span = periods.spanOf(course.periods);
    if (!span.start) return null;

    const termMonday = dateUtil.mondayOf(settings.termStart || dateUtil.today());
    const termWeeks = Number(settings.termWeeks) || 20;
    const wFrom = Math.max(1, Number(weeks.from) || 1);
    const wTo = Math.min(termWeeks, Number(weeks.to) || termWeeks);
    if (wTo < wFrom) return null;

    const type = weeks.type || 'all';
    let firstWeek = wFrom;
    let interval = 1;

    if (type === 'odd' || type === 'even') {
      interval = 2;
      const wantOdd = (type === 'odd');
      if ((firstWeek % 2 === 1) !== wantOdd) firstWeek += 1;   // 把起始周对齐到正确的奇偶
      if (firstWeek > wTo) return null;
    }

    const count = Math.floor((wTo - firstWeek) / interval) + 1;
    if (count < 1) return null;

    const firstDate = dateUtil.addDays(termMonday, (firstWeek - 1) * 7 + (Number(course.day) - 1));
    const startAt = toDate(firstDate, span.start);

    // 第 12 节这类「无固定下课时间」的，按 55 分钟估一个时长用于日历展示
    let endAt;
    if (span.end) {
      endAt = toDate(firstDate, span.end);
      if (endAt <= startAt) endAt = addMinutes(startAt, 55);
    } else {
      endAt = addMinutes(startAt, 55);
    }

    const rrule = interval === 1
      ? 'FREQ=WEEKLY;COUNT=' + count
      : 'FREQ=WEEKLY;INTERVAL=2;COUNT=' + count;

    const summary = course.name + '（' + periods.label(course.periods) + '）';
    const lines = [
      'BEGIN:VEVENT',
      'UID:' + uid('course', course.id),
      'DTSTAMP:' + stamp(new Date()),
      'DTSTART:' + stamp(startAt),
      'DTEND:' + stamp(endAt),
      'RRULE:' + rrule,
      'SUMMARY:' + esc(summary),
      course.location ? 'LOCATION:' + esc(course.location) : '',
      course.teacher ? 'DESCRIPTION:' + esc([course.teacher, course.note].filter(Boolean).join(' · ')) : (course.note ? 'DESCRIPTION:' + esc(course.note) : ''),
      'CATEGORIES:课程',
      alarmBlock(course.remindBefore === undefined || course.remindBefore === null ? settings.remindBefore : course.remindBefore, summary),
      'END:VEVENT'
    ].filter(l => l !== '');
    return lines.join(CRLF) + CRLF;
  }

  /* ---------------- 日程 ---------------- */

  function scheduleEvent(s, settings) {
    const type = scheduleUtil.repeatType(s);
    if (type === 'none' && s.done) return null;      // 已完成的一次性日程不再导出
    if (!s.date || !s.startTime) return null;

    const startAt = toDate(s.date, s.startTime);
    const endAt = s.endTime ? toDate(s.date, s.endTime) : addMinutes(startAt, 30);

    const lines = [
      'BEGIN:VEVENT',
      'UID:' + uid('schedule', s.id),
      'DTSTAMP:' + stamp(new Date()),
      'DTSTART:' + stamp(startAt),
      'DTEND:' + stamp(endAt > startAt ? endAt : addMinutes(startAt, 30)),
      'SUMMARY:' + esc(s.title)
    ];

    if (type !== 'none') {
      const until = scheduleUtil.untilOf(s);
      let rule;
      if (type === 'daily') rule = 'FREQ=DAILY';
      else if (type === 'weekly') rule = 'FREQ=WEEKLY';
      else rule = 'FREQ=MONTHLY';

      if (until) {
        const u = dateUtil.parse(until);
        rule += ';UNTIL=' + dateStamp(u) + 'T235959';
      } else {
        // 没设截止就保守地给个上限，避免生成无限重复
        rule += ';COUNT=' + (type === 'monthly' ? 12 : 52);
      }
      lines.push('RRULE:' + rule);

      // 已标记完成的那几次用 EXDATE 排除掉
      const done = (s.doneDates || []).filter(d => d >= s.date);
      if (done.length) {
        lines.push('EXDATE:' + done.map(d => stamp(toDate(d, s.startTime))).join(','));
      }
    }

    if (s.location) lines.push('LOCATION:' + esc(s.location));
    const desc = [s.category, s.note].filter(Boolean).join(' · ');
    if (desc) lines.push('DESCRIPTION:' + esc(desc));
    lines.push('CATEGORIES:' + esc(s.category || '日程'));

    const remind = (s.remindBefore === undefined || s.remindBefore === null)
      ? settings.remindBefore
      : s.remindBefore;
    const alarm = alarmBlock(remind, s.title);
    if (alarm) lines.push(alarm.replace(/\r\n$/, ''));

    lines.push('END:VEVENT');
    return lines.filter(l => l !== '').join(CRLF) + CRLF;
  }

  /* ---------------- 组装 ---------------- */

  /**
   * 生成 .ics 文本
   * opts: { courses: bool, schedules: bool }
   */
  function generate(opts) {
    const options = Object.assign({ courses: true, schedules: true }, opts || {});
    const settings = store.getSettings();
    const events = [];

    if (options.courses) {
      store.getCourses().forEach(c => {
        if (!c.periods || !c.periods.length) return;
        const ev = courseEvent(c, settings);
        if (ev) events.push(ev);
      });
    }
    if (options.schedules) {
      store.getSchedules().forEach(s => {
        const ev = scheduleEvent(s, settings);
        if (ev) events.push(ev);
      });
    }

    const head = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Campus Reminder//Course & Schedule//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:课程与日程',
      'X-WR-TIMEZONE:Asia/Shanghai'
    ].join(CRLF) + CRLF;

    const raw = head + events.join('') + 'END:VCALENDAR' + CRLF;

    // 对外只暴露折行后的版本：符合 RFC 5545 的每行 75 字节限制，
    // 直接拿去保存即可。raw 留着便于排查问题，不要拿去写文件。
    return {
      text: raw.split(CRLF).map(fold).join(CRLF),
      raw: raw,
      count: events.length
    };
  }

  /* ---------------- 交给系统 ---------------- */

  /**
   * 保存 / 分享一个文件
   *
   * 四条路，按环境选：
   *   1. 安卓应用里 → 交给原生写进系统「下载」目录；text/calendar 还会让日历应用接手
   *      （WebView 不支持 navigator.share，而且 blob 链接的下载在 WebView 里会被丢弃）
   *   2. iOS（Safari / 已加到主屏幕）→ 系统分享面板。iOS 上这是唯一能把 .ics
   *      直接交给「日历」的途径：分享面板里选「日历」即可导入，锁屏提醒也就有了。
   *   3. 其它手机浏览器 → 系统分享面板（部分安卓支持，能直接存进「文件」或交给日历 App）
   *   4. 其余 → 普通下载
   *
   * mimeType 默认 text/calendar（导出课表）；导出 JSON 备份时传 application/json。
   * 返回 'shared' | 'saved' | 'downloaded' | 'cancelled' | 'failed'
   */
  function save(filename, text, mimeType) {
    const mime = mimeType || 'text/calendar';

    // 路径一：安卓壳
    const android = global.Android;
    if (android) {
      try {
        if (typeof android.saveFile === 'function') {
          android.saveFile(filename, mime, text);
          return Promise.resolve('saved');
        }
        if (mime === 'text/calendar' && typeof android.saveIcs === 'function') {
          android.saveIcs(filename, text);
          return Promise.resolve('saved');
        }
      } catch (e) {
        // 落到下面的网页路径
      }
    }

    const blob = new Blob([text], { type: mime + ';charset=utf-8' });

    // 路径二 / 三：系统分享（带文件）
    if (global.navigator && global.navigator.canShare && global.File) {
      try {
        const file = new global.File([blob], filename, { type: mime });
        if (global.navigator.canShare({ files: [file] })) {
          return global.navigator.share({ files: [file], title: filename })
            .then(() => 'shared')
            .catch(err => (err && err.name === 'AbortError') ? 'cancelled' : download(blob, filename));
        }
      } catch (e) {
        // 落到下载
      }
    }

    // iOS 上若不支持带文件的分享（老系统），退回文本分享：
    // 至少让用户能把 .ics 内容复制出去，而不是直接失败。
    if (isIOS && global.navigator && typeof global.navigator.share === 'function' && mime === 'text/calendar') {
      return global.navigator.share({ title: filename, text: text })
        .then(() => 'shared')
        .catch(err => (err && err.name === 'AbortError') ? 'cancelled' : download(blob, filename));
    }

    // 路径四：普通下载
    return Promise.resolve(download(blob, filename));
  }

  function download(blob, filename) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (e) { /* 忽略 */ }
      }, 1500);
      return 'downloaded';
    } catch (e) {
      return 'failed';
    }
  }

  CR.ics = {
    generate: generate,
    save: save
  };
})(window);
