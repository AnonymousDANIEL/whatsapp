'use strict';
// Presentation only. Tutorials never create accounts, start browsers or send messages.
window.WorkspaceHeader = (() => {
  const $ = id => document.getElementById(id);
  const text = (zh, en) => window.T(zh, en);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let user = null, offset = 0, locale = '', timeFormat, dateFormat, openMenu = null, topic = 'personal';
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
  }
  function closeMenu(restoreFocus = false) {
    if (!openMenu) return;
    const name = openMenu;
    $(name+'-menu').hidden = true;
    $(name+'-toggle').setAttribute('aria-expanded','false');
    openMenu = null;
    if (restoreFocus) $(name+'-toggle').focus();
  }
  function menuItems() { return openMenu ? [...$(openMenu+'-menu').querySelectorAll('button:not([hidden]):not(:disabled)')] : []; }
  function showMenu(name, focus = false) {
    if (!user) return;
    if (openMenu === name && !focus) return closeMenu();
    closeMenu(); openMenu = name;
    const menu = $(name+'-menu'), button = $(name+'-toggle');
    menu.hidden = false; button.setAttribute('aria-expanded','true');
    const rect = button.getBoundingClientRect();
    menu.style.left = Math.max(12, Math.min(rect.right-menu.offsetWidth, innerWidth-menu.offsetWidth-12))+'px';
    menu.style.top = Math.max(12, Math.min(rect.bottom+8, innerHeight-menu.offsetHeight-12))+'px';
    if (focus) menuItems()[0]?.focus();
  }
  function guides() {
    const owner = user?.role === 'owner';
    const commonPersonal = [
      [text('添加 WhatsApp 账号','Add a WhatsApp account'),text('打开「WhatsApp 账号」，点击「添加账号」，填写备注 / 名称并保存。','Open WhatsApp accounts, choose Add account, enter a name / note and save.')],
      [text('用手机扫码连接','Link using your phone'),text('点击账号的扫码按钮。手机 WhatsApp → 设置（Android 可点右上角 ⋮）→ 已关联设备 → 关联设备，扫描网页二维码。','Choose the account’s QR button. On your phone, open WhatsApp → Settings (or ⋮ on Android) → Linked devices → Link a device, then scan the web QR code.')],
      [text('确认显示「已连接」','Wait for Connected'),text('二维码画面会自动更新。账号显示「已连接」后再创建发送任务；若画面正在排队或恢复，先等待自动连接。','The QR screen updates automatically. Create a send task after the account shows Connected. If the screen is queued or recovering, allow it to reconnect.')],
      [text('新建发送任务','Create a send task'),text('进入「发送任务」→「新建任务」，选择已连接账号，填写消息和收件号码（每行一个，包含国家代码）。也可导入 TXT / CSV 号码文件。','Open Send tasks → New task, select a connected account and enter the message and one recipient number per line, including the country code. You can also import a TXT / CSV number file.')],
      [text('选择图片和发送节奏','Choose a photo and send pacing'),text('图片选填，支持 JPEG / PNG / WebP，最大 5 MB。设置发送间隔与每批条数，确认联系人同意接收后，点击「立刻发送」。','A photo is optional: JPEG / PNG / WebP, up to 5 MB. Set the interval and messages per batch, confirm the contacts agreed to receive your message, then choose Send now.')],
      [text('查看每个号码的发送结果','Check each recipient’s result'),text('在「发送任务」查看进度及明细，在「发送记录」查看每个号码的状态。成功提交、已送达和已读是不同状态；结果未确认时先查看记录，不要重复提交。','Use Send tasks for progress and details, and Message history for each recipient’s status. Submitted, delivered and read are different states. Check the records before resubmitting an unconfirmed message.')]
    ];
    const sharedSteps = owner ? [
      [text('打开独立共享账号区','Open the separate shared account area'),text('进入「共享 WhatsApp」，查看上方「共享运行容量」。共享账号与普通 WhatsApp 账号分别管理，使用各自的扫码名额。','Open Shared WhatsApp and check Shared running capacity. Shared and personal accounts are managed separately with their own QR slots.')],
      [text('添加并连接共享账号','Add and link a shared account'),text('点击「添加账号」，填写备注 / 名称，保留自动分配或选择有名额的共享分组并保存。然后点击「扫码连接」，用手机 WhatsApp 的「关联设备」扫码。','Choose Add account, enter a name / note, keep Automatic allocation or select an available shared group, then save. Choose Link / QR and scan through Linked devices on the phone.')],
      [text('设置服务与价格','Set availability and pricing'),text('打开「共享发送设置」，设置开关、每条价格、马来西亚各小时价格以及发送间隔 / 每批条数。需要让 USER 上传图片时，开启 USER 图片。','Open Shared sending settings to set availability, the per-message rate, Malaysia-time hourly rates, and interval / batch size. Enable USER photos when USERs may upload images.')],
      [text('确认账号可用后开放','Open the service when accounts are available'),text('确认共享账号显示「已连接」且可用，再开放给 USER ID。只有 Owner 可以添加、扫码和管理共享账号。','Confirm shared accounts are connected and available before opening the service to USER IDs. Only the Owner can add, link or manage shared accounts.')],
      [text('查看共享任务和记录','Monitor shared tasks and records'),text('「共享发送任务」和「共享发送记录」分别显示进度与结果。失败、无效号码或未确认预扣会自动退款；自动退款记录可在「余额 / 充值」查看。','Shared send tasks and Shared message history show progress and results separately. Failed, invalid and unconfirmed holds are refunded automatically; view automatic refund records in Credit / top-up.')]
    ] : [
      [text('确认余额和服务开放','Check credit and availability'),text('先到「余额 / 充值」查看余额，再打开「共享 WhatsApp」。如果显示 Coming soon，表示服务暂未开放，请等待管理员开启。','Check your balance in Credit / top-up, then open Shared WhatsApp. Coming soon means the service is not open yet; wait for the administrator to enable it.')],
      [text('使用管理员连接的共享账号','Use the shared accounts linked by the Owner'),text('共享账号由 Owner 添加和扫码。你可以直接填写消息，系统会从可用的独立共享账号中自动选择发送账号。','The Owner adds and links shared accounts. Enter your message directly; the system automatically selects an available dedicated shared sender.')],
      [text('填写消息和收件号码','Enter the message and recipients'),text('在「共享发送」填写消息内容和收件号码，每行一个，包含国家代码。请只发送给已同意接收消息的联系人。','In Shared sending, enter the message and one recipient number per line, including the country code. Send only to contacts who agreed to receive the message.')],
      [text('按需要上传图片','Add a photo when available'),text('如果页面有图片上传选项，可上传 JPEG / PNG / WebP，最大 5 MB。没有图片选项时，使用文字发送即可。','If the photo field is available, upload a JPEG / PNG / WebP up to 5 MB. Use a text message when the photo field is not available.')],
      [text('确认后点击「发送」','Confirm and choose Send'),text('勾选联系人同意接收消息，点击「发送」。共享发送节奏由管理员设定；提交后在「共享发送任务」查看进度。','Confirm the contacts agreed to receive the message and choose Send. The administrator sets shared send pacing. Track progress in Shared send tasks.')],
      [text('查看结果与余额','Check results and credit'),text('「共享发送记录」会显示每个号码的结果。失败、无效号码或未确认预扣会自动退回；余额不足时任务会等待充值，充足后自动继续。','Shared message history shows each recipient’s result. Failed, invalid and unconfirmed holds are refunded automatically. Tasks waiting for credit continue automatically after a sufficient top-up.')]
    ];
    return {
      personal:{title:text('WhatsApp 账号怎么使用','How to use WhatsApp accounts'),intro:owner?text('连接自己的账号，再创建发送任务。','Link your own account, then create a send task.'):text('先确认余额，再连接自己的 WhatsApp 账号。每个 USER 最多连接 10 个账号。','Check your credit, then link your own WhatsApp accounts. Each USER can link up to 10 accounts.'),steps:[...(!owner?[[text('先确认可用余额','Check available credit'),text('在「余额 / 充值」查看余额并通过开放的方式充值。余额不足暂停的任务，在充值足够后会自动继续。','Check your balance in Credit / top-up and use an available top-up method. Tasks waiting for credit continue after a sufficient top-up.')]]:[]),...commonPersonal]},
      shared:{title:text('共享 WhatsApp 怎么使用','How to use Shared WhatsApp'),intro:owner?text('共享账号使用独立运行容量，由你统一连接和管理。','Shared accounts use dedicated capacity and are linked and managed by you.'):text('不需要自己扫码，使用管理员提供的共享发送服务。','Use the shared sending service provided by the administrator without linking a shared account yourself.'),steps:sharedSteps}
    };
  }
  function showGuide(nextTopic) {
    if (!user || !['personal','shared'].includes(nextTopic)) return;
    topic = nextTopic; closeMenu();
    const entries = guides(), entry = entries[topic];
    $('guide-title').textContent = text('使用教学','Usage guides');
    $('guide-close').textContent = text('关闭','Close');
    $('guide-topics').innerHTML = Object.entries(entries).map(([key,value])=>'<button type="button" data-help-topic="'+key+'" aria-pressed="'+(key===topic)+'">'+escape(value.title)+'</button>').join('');
    $('guide-content').innerHTML = '<p class="guide-category">'+(topic==='personal'?'WHATSAPP':'SHARED WHATSAPP')+'</p><h3>'+escape(entry.title)+'</h3><p class="guide-intro">'+escape(entry.intro)+'</p><ol class="guide-steps">'+entry.steps.map(([title,body],i)=>'<li><span class="guide-number" aria-hidden="true">'+String(i+1).padStart(2,'0')+'</span><div><h4>'+escape(title)+'</h4><p>'+escape(body)+'</p></div></li>').join('')+'</ol>';
    $('guide-open-page').textContent = topic==='personal'?text('前往 WhatsApp 账号','Open WhatsApp accounts'):text('前往共享 WhatsApp','Open Shared WhatsApp');
    if (!$('guide-dialog').open) $('guide-dialog').showModal();
  }
  function update(nextUser, nextOffset = 0) {
    const changed = user?.id !== nextUser?.id || user?.role !== nextUser?.role;
    user = nextUser || null; offset = Number.isFinite(nextOffset) ? nextOffset : 0;
    if (changed) { closeMenu(); $('guide-dialog').close(); }
    const appearanceParent = user ? $('header-appearance-slot') : $('login-tools');
    if ($('appearance-controls').parentElement !== appearanceParent) appearanceParent.append($('appearance-controls'));
    $('login-tools').hidden = !!user;
    $('account-name').textContent = user?.username || '';
    $('account-detail-name').textContent = user?.username || '';
    $('account-greeting').textContent = text('你好，','Hi, ');
    $('account-role').textContent = user?.role === 'owner' ? 'Owner' : 'USER ID';
    $('account-toggle').setAttribute('aria-label',text('账号菜单','Account menu')+(user?' · '+user.username:''));
    $('header-password').hidden = user?.role !== 'owner';
    $('language-code').textContent = window.WA_LANG === 'en' ? 'EN' : 'CN';
    $('language').value = window.WA_LANG;
    $('language').setAttribute('aria-label',text('选择语言','Choose language'));
    $('help-toggle').setAttribute('aria-label',text('使用教学','Usage guides'));
    $('refresh').setAttribute('aria-label',text('刷新','Refresh'));
    $('refresh').title = text('刷新','Refresh');
    applyTheme(); tick();
    if (!user) { $('guide-content').replaceChildren(); $('guide-topics').replaceChildren(); }
  }
  $('theme-toggle').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark'; applyTheme();
    try { localStorage.setItem('wa_theme', theme); } catch { /* Theme still works without persistence. */ }
  });
  for (const name of ['help','account']) {
    $(name+'-toggle').addEventListener('click',()=>showMenu(name));
    $(name+'-toggle').addEventListener('keydown',event=>{
      if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); showMenu(name,true); if(event.key==='ArrowUp')menuItems().at(-1)?.focus(); }
    });
  }
  document.addEventListener('click',event=>{
    const guide = event.target.closest('[data-help-topic]');
    if (guide) return showGuide(guide.dataset.helpTopic);
    if (openMenu && !event.target.closest('#'+openMenu+'-menu,#'+openMenu+'-toggle')) closeMenu();
  });
  document.addEventListener('keydown',event=>{
    if (!openMenu) return;
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
    const items=menuItems(), index=items.indexOf(document.activeElement);
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length; items[next]?.focus();
    } else if (event.key === 'Tab') closeMenu();
  });
  window.addEventListener('resize',()=>closeMenu());
  window.addEventListener('scroll',()=>closeMenu(),{passive:true});
  $('header-logout').addEventListener('click',()=>{closeMenu();$('logout').click();});
  $('header-password').addEventListener('click',()=>{closeMenu();if(user?.role==='owner')$('password-btn').click();});
  $('guide-close').addEventListener('click',()=>$('guide-dialog').close());
  $('guide-dialog').addEventListener('close',()=>{if(user)$('help-toggle').focus();});
  $('guide-open-page').addEventListener('click',()=>{
    const target=topic==='personal'?'accounts':'shared'; $('guide-dialog').close();
    document.querySelector('#nav [data-page="'+target+'"]')?.click();
  });
  return {update,tick};
})();
