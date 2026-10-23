'use strict';
// Presentation only. Tutorials never create accounts, start browsers or send messages.
window.WorkspaceHeader = (() => {
  const $ = id => document.getElementById(id);
  const text = (zh, en) => window.T(zh, en);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let user = null, offset = 0, locale = '', timeFormat, dateFormat;
  let theme = 'dark';
  try { if (localStorage.getItem('wa_theme') === 'light') theme = 'light'; } catch { /* Use the default when storage is unavailable. */ }
  const icons = {
    moon:'<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>'
  };
  const icon = paths => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+paths+'</svg>';
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    const next = theme === 'dark' ? text('切换浅色模式','Switch to light mode') : text('切换深色模式','Switch to dark mode');
    $('theme-toggle').innerHTML = icon(icons[theme === 'dark' ? 'moon' : 'sun']);
    $('theme-toggle').setAttribute('aria-label', next);
    $('theme-toggle').title = next;
    $('theme-toggle').setAttribute('aria-pressed', String(theme === 'light'));
  }
  function tick() {
    const nextLocale = window.WA_LANG === 'en' ? 'en-GB' : 'zh-CN';
    if (locale !== nextLocale) {
      locale = nextLocale;
      timeFormat = new Intl.DateTimeFormat(locale, {timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
      dateFormat = new Intl.DateTimeFormat(locale, {timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'long',day:'numeric',weekday:'short'});
    }
    const now = new Date(Date.now() + offset);
    $('clock-time').textContent = timeFormat.format(now);
    $('clock-date').textContent = dateFormat.format(now);
    $('clock').dateTime = now.toISOString();
    $('clock').title = text('马来西亚时间 UTC+8','Malaysia time UTC+8');
    $('clock').setAttribute('aria-label', $('clock-time').textContent+' · '+$('clock-date').textContent+' · UTC+8');
    const noticeClock=$('notice-ticker-clock');
    if(noticeClock)noticeClock.textContent=dateFormat.format(now)+' '+timeFormat.format(now);
  }
  function personalGuide() {
    // This guide describes USER controls, including when an administrator is needed.
    return {
      title:text('WhatsApp 账号怎么使用','How to use WhatsApp accounts'),
      intro:text('USER 操作教学：先充值，再连接自己的 WhatsApp 账号，最后创建发送任务。','USER guide: top up, link your own WhatsApp account, then create a send task.'),
      steps:[
        [text('1. 确认余额','1. Check your balance'),text('打开「余额 / 充值」查看可用余额，选择已开放的充值方式。Coming soon 表示该方式暂未开放。余额不足的任务会等待充值，余额足够后自动继续。','Open Credit / top-up to check your available balance and choose an enabled top-up method. Coming soon means that method is not open yet. Tasks waiting for credit continue after a sufficient top-up.')],
        [text('2. 添加自己的账号','2. Add your own account'),text('打开「WhatsApp 账号」→「添加账号」，填写备注 / 名称，再点「保存」。系统会自动分配连接位置，每个 USER 最多添加 10 个账号。','Open WhatsApp accounts → Add account, enter a Name / note, then choose Save. The system assigns the connection slot automatically. Each USER can add up to 10 accounts.')],
        [text('3. 用手机扫码','3. Scan with your phone'),text('在账号旁点击「扫码」，二维码会在新页面打开。手机 WhatsApp → 设置（Android 点右上角 ⋮）→ 已关联设备 → 关联设备，扫描网页上的二维码。请使用要连接的 WhatsApp 手机账号扫码。','Choose Scan QR beside the account to open the QR screen in a new page. On your phone, open WhatsApp → Settings (⋮ on Android) → Linked devices → Link a device, then scan the web QR code with the account you want to link.')],
        [text('4. 等待显示「已连接」','4. Wait for Connected'),text('扫码后稍等，账号名称下方会自动显示关联号码。看到「已连接」后才创建发送任务。若显示等待连接资源，保持扫码页面打开并等待；若需要恢复，可点「启动 / 重连」。持续无法连接时请联系管理员，不要重复添加同一账号。','After scanning, wait for the linked number to appear below the account name and the status to show Connected. If waiting for connection capacity, keep the QR page open. Use Start / reconnect if recovery is needed. Contact the administrator if it stays disconnected; do not repeatedly add the same account.')],
        [text('5. 填写消息和号码','5. Enter the message and recipients'),text('进入「发送任务」→「新建任务」，选择已连接账号，填写消息和收件号码。每行一个号码，包含国家代码（马来西亚为 +60）；也可导入 TXT / CSV 号码文件。无需填写任务名称。','Open Send tasks → New task, select a connected account, and enter your message and recipients. Use one number per line with its country code (+60 for Malaysia), or import a TXT / CSV number file. A task name is not required.')],
        [text('6. 选择图片和发送间隔','6. Choose a photo and send interval'),text('照片选填，支持 JPEG / PNG / WebP，最大 5 MB；填写的文字会与照片一起发送。创建任务时可设发送间隔和每批条数：间隔 5 秒至 1 小时，每批 1 至 100 条。每批逐条发送，完成后等待间隔再发下一批。','A photo is optional: JPEG / PNG / WebP, up to 5 MB. Your text is sent as its caption. When creating the task, set an interval of 5 seconds to 1 hour and 1 to 100 messages per batch. Each batch sends sequentially, then waits for the interval before the next batch.')],
        [text('7. 点击「立刻发送」','7. Choose Send now'),text('确认号码和内容正确，勾选联系人同意接收消息，再点「立刻发送」。符合连接和余额条件后系统会开始处理，不需要管理员人工批准。提交任务不等于所有号码已发送完成；请查看进度，不要重复点击新建相同任务。','Check the recipients and content, confirm the contacts agreed to receive the message, then choose Send now. Processing starts when connection and credit requirements are met, without manual administrator approval. Submission does not mean every message has finished sending; check progress before creating the same task again.')],
        [text('8. 查看结果和处理异常','8. Check results and exceptions'),text('在「发送任务」点「明细」，或打开「发送记录」查看每个号码的状态。等待、发送成功（已提交）、已送达、已读和失败分别显示；已提交不代表已送达。失败、无效号码或结果未确认的预扣由系统自动退回；未确认的号码不会自动重发。已暂停任务的恢复、删除或修改间隔，请联系管理员。','Choose Details in Send tasks, or open Message history for each recipient’s status: Waiting, Sent successfully (submitted), Delivered, Read or Failed. Submitted does not mean delivered. Failed, invalid and unconfirmed holds are refunded automatically; unconfirmed recipients are not automatically resent. Ask the administrator to resume, delete or change the pacing of an existing task.')]
      ]
    };
  }
  function showGuide() {
    if (!user) return;
    const entry = personalGuide();
    $('guide-title').textContent = text('使用教学','Usage guides');
    $('guide-close').textContent = text('关闭','Close');
    $('guide-content').innerHTML = '<p class="guide-category">USER GUIDE</p><h3>'+escape(entry.title)+'</h3><p class="guide-intro">'+escape(entry.intro)+'</p><ol class="guide-steps">'+entry.steps.map(([title,body])=>'<li><h4>'+escape(title)+'</h4><p>'+escape(body)+'</p></li>').join('')+'</ol>';
    $('guide-open-page').textContent = text('前往 WhatsApp 账号','Open WhatsApp accounts');
    if (!$('guide-dialog').open) { $('guide-dialog').showModal(); $('guide-dialog').scrollTop = 0; }
  }
  function closeGuide() {
    $('guide-dialog').close();
    if (user) $('help-toggle').focus({preventScroll:true});
  }
  function update(nextUser, nextOffset = 0) {
    const changed = user?.id !== nextUser?.id || user?.role !== nextUser?.role;
    user = nextUser || null; offset = Number.isFinite(nextOffset) ? nextOffset : 0;
    if (changed) $('guide-dialog').close();
    const appearanceParent = user ? $('header-appearance-slot') : $('login-tools');
    if ($('appearance-controls').parentElement !== appearanceParent) appearanceParent.append($('appearance-controls'));
    $('login-tools').hidden = !!user || $('login').hidden;
    $('account-greeting').textContent = user?.username ? text('你好，','Hi, ') + user.username : '';
    $('language').value = window.WA_LANG;
    $('language').setAttribute('aria-label',text('选择语言','Choose language'));
    $('help-toggle').setAttribute('aria-label',text('使用教学','Usage guides'));
    applyTheme(); tick();
    if (!user) $('guide-content').replaceChildren();
  }
  $('theme-toggle').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark'; applyTheme();
    try { localStorage.setItem('wa_theme', theme); } catch { /* Theme still works without persistence. */ }
  });
  $('help-toggle').addEventListener('click',showGuide);
  $('guide-close').addEventListener('click',closeGuide);
  $('guide-dialog').addEventListener('cancel',event=>{event.preventDefault();closeGuide();});
  $('guide-dialog').addEventListener('close',()=>{if(user)$('help-toggle').focus();});
  $('guide-open-page').addEventListener('click',()=>{
    closeGuide();
    document.querySelector('#nav [data-page="accounts"]')?.click();
  });
  return {update,tick};
})();
