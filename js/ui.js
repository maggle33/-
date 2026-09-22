/**
 * 界面基础件：提示条、对话框、底部菜单、提醒弹窗
 * 对应小程序里的 wx.showToast / wx.showModal / wx.showActionSheet。
 */

(function (global) {
  'use strict';

  const CR = global.CR;

  /* ---------------- 提示条 ---------------- */

  let toastTimer = null;

  function toast(message, ms) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('on');
      toastTimer = null;
    }, ms || 1800);
  }

  /* ---------------- 关闭动画 ---------------- */

  /**
   * 让弹层带着退场动画再消失。
   * 逻辑上已经「关闭」了（Promise 立刻 resolve），只是视觉上让它滑回去，
   * 免得啪一下不见、像是闪退。setTimeout 是兜底：系统开了「减弱动效」时
   * animationend 不会来，不能把元素永远留在页面上。
   */
  function dismiss(el, after) {
    if (!el) return;
    el.classList.add('closing');
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      if (el.parentNode) el.parentNode.removeChild(el);
      if (after) after();
    }
    el.addEventListener('animationend', finish);
    setTimeout(finish, 400);
  }

  /* ---------------- 按下水波纹 ---------------- */

  const RIPPLE_HOST = '.btn, .quick-btn, .sheet-item, .dialog-btn, .item, .tt-block,'
    + '.chip, .tab-item, .week-nav, .notice-btn, .panel-link, .tab';

  let rippleBound = false;

  function spawnRipple(host, e) {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const size = Math.max(rect.width, rect.height) * 1.9;
    const x = (e.clientX == null ? rect.left + rect.width / 2 : e.clientX) - rect.left;
    const y = (e.clientY == null ? rect.top + rect.height / 2 : e.clientY) - rect.top;

    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = size + 'px';
    span.style.height = size + 'px';
    span.style.left = (x - size / 2) + 'px';
    span.style.top = (y - size / 2) + 'px';
    host.appendChild(span);

    let gone = false;
    function drop() {
      if (gone) return;
      gone = true;
      if (span.parentNode) span.parentNode.removeChild(span);
    }
    span.addEventListener('animationend', drop);
    setTimeout(drop, 800);
  }

  function bindRipple() {
    if (rippleBound) return;
    rippleBound = true;
    // 用捕获阶段：手指刚落下就出涟漪，不等 click
    document.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const t = e.target;
      if (!t || !t.closest) return;
      const host = t.closest(RIPPLE_HOST);
      if (!host || host.disabled) return;
      spawnRipple(host, e);
    }, true);
  }

  /* ---------------- 对话框 ---------------- */

  function dialog(opts) {
    const o = Object.assign({
      title: '',
      body: '',
      confirmText: '确定',
      cancelText: '取消',
      danger: false,
      showCancel: true
    }, opts || {});

    return new Promise(resolve => {
      const host = document.getElementById('modalRoot') || document.body;
      const wrap = document.createElement('div');
      wrap.className = 'mask on';
      wrap.innerHTML =
        '<div class="dialog" role="dialog" aria-modal="true">'
        + (o.title ? '<div class="dialog-title"></div>' : '')
        + (o.body ? '<div class="dialog-body"></div>' : '')
        + '<div class="dialog-actions">'
        + (o.showCancel ? '<button class="dialog-btn" data-act="cancel"></button>' : '')
        + '<button class="dialog-btn strong" data-act="confirm"></button>'
        + '</div></div>';

      // 用 textContent 填文字，避免内容里的尖括号被当成 HTML
      if (o.title) wrap.querySelector('.dialog-title').textContent = o.title;
      if (o.body) wrap.querySelector('.dialog-body').textContent = o.body;
      if (o.showCancel) wrap.querySelector('[data-act="cancel"]').textContent = o.cancelText;
      const okBtn = wrap.querySelector('[data-act="confirm"]');
      okBtn.textContent = o.confirmText;
      if (o.danger) okBtn.classList.add('danger');

      function close(result) {
        dismiss(wrap);
        resolve(result);
      }

      wrap.addEventListener('click', e => {
        if (wrap.classList.contains('closing')) return;   // 正在退场，别重复关
        const act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'confirm') close(true);
        else if (act === 'cancel') close(false);
        else if (e.target === wrap && o.showCancel) close(false);
      });

      host.appendChild(wrap);
    });
  }

  function alertBox(title, body) {
    return dialog({ title: title, body: body, showCancel: false, confirmText: '知道了' });
  }

  /* ---------------- 底部菜单 ---------------- */

  function sheet(items) {
    return new Promise(resolve => {
      const host = document.getElementById('sheetRoot');
      const mask = document.getElementById('maskRoot');
      const wrap = document.createElement('div');
      wrap.className = 'sheet on';
      wrap.innerHTML = '<div class="sheet-inner"></div>';
      const inner = wrap.querySelector('.sheet-inner');

      items.forEach((it, i) => {
        const b = document.createElement('button');
        b.className = 'sheet-item' + (it.danger ? ' danger' : '') + (it.primary ? ' primary' : '');
        b.textContent = it.text;
        b.addEventListener('click', () => close(i));
        inner.appendChild(b);
      });

      mask.classList.add('on');

      function close(index) {
        mask.classList.add('closing');
        mask.onclick = null;
        dismiss(wrap, () => {
          mask.classList.remove('on');
          mask.classList.remove('closing');
        });
        resolve(index);
      }

      mask.onclick = () => close(-1);
      host.appendChild(wrap);
    });
  }

  /* ---------------- 提醒弹窗 ---------------- */

  let alertOpen = false;

  function reminderAlert(item) {
    if (alertOpen) return;
    alertOpen = true;

    const host = document.getElementById('modalRoot') || document.body;
    const wrap = document.createElement('div');
    wrap.className = 'mask on';

    const remain = Number(item.remainMinutes);
    const remainText = remain > 0
      ? '还有约 ' + remain + ' 分钟'
      : (remain === 0 ? '现在开始' : '已开始 ' + Math.abs(remain) + ' 分钟');

    wrap.innerHTML =
      '<div class="alert-card">'
      + '<div class="alert-top">'
      + '<div class="alert-kicker"></div>'
      + '<div class="alert-name"></div>'
      + '<div class="alert-time"></div>'
      + '<div class="alert-note"></div>'
      + '</div>'
      + '<div class="alert-bar"></div>'
      + '<div class="dialog-actions">'
      + '<button class="dialog-btn" data-act="snooze">5 分钟后再提醒</button>'
      + '<button class="dialog-btn strong" data-act="ok">知道了</button>'
      + '</div></div>';

    wrap.querySelector('.alert-kicker').textContent =
      (item.typeText || '') + ' · ' + remainText;
    wrap.querySelector('.alert-name').textContent = item.title;
    wrap.querySelector('.alert-time').textContent =
      item.startTime + (item.endTime ? ' ~ ' + item.endTime : '') + (item.subtitle ? ' · ' + item.subtitle : '');
    const noteEl = wrap.querySelector('.alert-note');
    if (item.note) noteEl.textContent = item.note;
    else noteEl.style.display = 'none';
    wrap.querySelector('.alert-bar').style.background = item.color || '#378ADD';

    function close(snooze) {
      dismiss(wrap);
      alertOpen = false;
      if (snooze) {
        CR.reminder.snooze(item, 5);
        toast('5 分钟后再提醒你');
      }
    }

    wrap.addEventListener('click', e => {
      if (wrap.classList.contains('closing')) return;
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'ok') close(false);
      else if (act === 'snooze') close(true);
    });

    host.appendChild(wrap);

    // 震动之外再补一次视觉强调（部分设备 navigator.vibrate 不生效）
    try {
      if (navigator.vibrate && CR.store.getSettings().vibrate) navigator.vibrate([120, 60, 120]);
    } catch (e) { /* 忽略 */ }
  }

  CR.ui = {
    toast: toast,
    dialog: dialog,
    alert: alertBox,
    sheet: sheet,
    reminderAlert: reminderAlert,
    bindRipple: bindRipple
  };
})(window);
