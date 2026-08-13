// 管理界面。单文件 HTML，不引任何前端框架、不需要构建步骤。
//
// # 品牌
// CursorAPI（配置键前缀 CURSOR_），Cursor 转 API 的网关。
// 视觉全面对齐 windsurf/src/dashboard/index.html：KiroStudio 冷色调 +
// 陶土橙 accent（#d97757），暗色默认，login-overlay 居中渐变遮罩登录，
// credentials 凭证热更区、checkbox/select/cs 下拉组件、批量勾选条、
// 行展开详情、KPI 卡 + 趋势图，全部照搬那套形态与动效。
//
// # 分区
// CSS / 图标 / BODY 骨架 / 客户端脚本 四段，段与段之间只通过 id 和 class 名耦合。
//
// # 沙箱约束（test-ui.mjs 的 makeEl 很薄）
// 前端 JS 只用 className 拼接 + onclick 绑定 + style 定位 + checked 属性，
// 不用 classList / addEventListener / querySelector / getBoundingClientRect。
// JS 块是外层模板字符串：全程不用反引号与 ${}，字符串拼接用 '...'+x+'...'。
//
// # 后端契约（路径不变，见 app.mjs 头部注释）
// GET  /admin/status /admin/models /admin/config /admin/stats
// GET  /admin/logs(SSE) /admin/logs/export /admin/accounts/export
// GET  /admin/update/check /admin/update/status
// POST /admin/login /admin/logout /admin/reload /admin/accounts
// POST /admin/accounts/batch /admin/accounts/:id/probe
// POST /admin/accounts/:id/disabled /admin/update/perform
// PUT  /admin/config（部分热更；clientKeys / adminKey 热字段即时生效）
// PATCH /admin/accounts/:id   DELETE /admin/accounts/:id

// 号池快照的数据源。后端模块名已经稳定为 keys.mjs / tool-relay.mjs，
// 保留旧名兜底只为防御改名链路中间态。惰性加载：挪进函数体避免顶层
// await（esbuild 的 CJS bundle 不允许顶层 await，发布流水线会挂）。
let poolMod = null;
let toolsMod = null;
async function ensureMods() {
  if (poolMod === null) {
    try { poolMod = await import("./keys.mjs"); } catch {
      try { poolMod = await import("./pool.mjs"); } catch { poolMod = undefined; }
    }
  }
  if (toolsMod === null) {
    try { toolsMod = await import("./tool-relay.mjs"); } catch {
      try { toolsMod = await import("./tools.mjs"); } catch { toolsMod = undefined; }
    }
  }
}

// 模块加载时间 ≈ 进程启动时间（app.mjs import 本文件在 listen 之前）。
// 设置页的「运行时长」从这里算，不用再造一个启动时间源。
const STARTED_AT = Date.now();

export async function snapshot() {
  await ensureMods();
  const accounts = (poolMod && poolMod.all ? poolMod.all() : []).map((a) => (a.view ? a.view() : a));
  const totals = accounts.reduce(
    (acc, a) => ({
      runs: acc.runs + a.runs,
      inputTokens: acc.inputTokens + a.inputTokens,
      outputTokens: acc.outputTokens + a.outputTokens,
    }),
    { runs: 0, inputTokens: 0, outputTokens: 0 },
  );
  return {
    startedAt: STARTED_AT,
    total: accounts.length,
    available: accounts.filter((a) => !a.disabled).length,
    pendingToolCalls: toolsMod && toolsMod.pendingToolCalls ? toolsMod.pendingToolCalls() : 0,
    totals,
    accounts,
  };
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

:root {
  color-scheme: light;     /* native controls (scrollbars etc.) = light */
  /* ── Cool-neutral light theme (KiroStudio-style: no warm cast) ── */
  --paper:      #fafafa;   /* neutral grey-white main background */
  --paper-2:    #f4f4f5;   /* secondary surface */
  --paper-3:    #ececee;   /* faint zone base */
  --ink:        #18181b;   /* neutral near-black (zinc-900) */
  --ink-soft:   #3f3f46;
  --mid-gray:   #a1a1aa;

  --bg: var(--paper);
  --bg-elev: var(--paper);
  --surface: #ffffff;
  --surface-2: var(--paper-2);
  --surface-3: var(--paper-3);
  --border: rgba(24,24,27,.10);
  --border-strong: rgba(24,24,27,.18);
  --text: var(--ink);
  --text-muted: #71717a;
  --text-dim: #a1a1aa;

  /* Anthropic accent — signature clay orange */
  --accent: #d97757;
  --accent-hover: #c56245;
  --accent-soft: rgba(217,119,87,.14);
  --blue: #6a9bcc;
  --green: #788c5d;
  --success: #788c5d;
  --success-soft: rgba(120,140,93,.16);
  --warn: #d9a257;
  --warn-soft: rgba(217,162,87,.16);
  --error: #c65d4e;
  --error-soft: rgba(198,93,78,.14);
  --tip-bg: rgba(24,24,27,.98);
  --tip-fg: #fafafa;
  --tip-border: rgba(250,250,250,.14);
  --info: #6a9bcc;
  --info-soft: rgba(106,155,204,.16);

  /* data-viz palette */
  --chart-req:  #4c9aff;
  --chart-succ: #4a9d6a;
  --chart-err:  #e0524a;
  --chart-blue: #4c9aff;
  --grid: rgba(24,24,27,.09);

  /* modern geometry — soft, clean, no sketch */
  --radius: 12px;
  --radius-sm: 8px;
  --radius-lg: 16px;
  --shadow-sm: 0 1px 2px rgba(24,24,27,.05), 0 1px 3px rgba(24,24,27,.08);
  --shadow: 0 2px 4px rgba(24,24,27,.04), 0 4px 12px rgba(24,24,27,.06);
  --shadow-lg: 0 8px 24px rgba(24,24,27,.10), 0 2px 8px rgba(24,24,27,.06);
  --ink-shadow-soft: var(--shadow-sm);

  /* font stacks */
  --font: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  --serif: var(--font);
  --hand: var(--font);
  --mono: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}

/* ── Dark theme (toggle via [data-theme="dark"] on <html>) ── */
[data-theme="dark"] {
  color-scheme: dark;      /* native controls follow the dark theme */
  /* Cool-neutral dark theme (Vercel-style near-black, zero warm cast) */
  --paper: #0a0a0a;
  --paper-2: #141414;
  --paper-3: #1f1f1f;
  --ink: #ededed;
  --ink-soft: #c4c4c6;
  --mid-gray: #8a8a8f;
  --bg: var(--paper);
  --bg-elev: var(--paper-2);
  --surface: #141414;
  --surface-2: #1c1c1c;
  --surface-3: #262626;
  --border: rgba(255,255,255,.10);
  --border-strong: rgba(255,255,255,.18);
  --text: var(--ink);
  --text-muted: #a1a1aa;
  --text-dim: #71717a;
  --accent-soft: rgba(217,119,87,.20);
  --success-soft: rgba(120,140,93,.22);
  --warn-soft: rgba(217,162,87,.22);
  --error-soft: rgba(198,93,78,.22);
  --info-soft: rgba(106,155,204,.22);
  --grid: rgba(255,255,255,.09);
  --tip-bg: rgba(28,28,30,.98);
  --tip-fg: var(--text);
  --tip-border: rgba(255,255,255,.14);
  --shadow-sm: 0 1px 2px rgba(0,0,0,.3), 0 1px 4px rgba(0,0,0,.4);
  --shadow: 0 2px 4px rgba(0,0,0,.3), 0 4px 12px rgba(0,0,0,.4);
  --shadow-lg: 0 8px 24px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.4);
}
/* dark: top inset highlight gives cards/sections a subtle glass depth */
[data-theme="dark"] .card,
[data-theme="dark"] .section {
  box-shadow: inset 0 1px 0 rgba(255,255,255,.04), var(--shadow-sm);
}
[data-theme="dark"] .card:hover { box-shadow: inset 0 1px 0 rgba(255,255,255,.05), var(--shadow); }

*{margin:0;padding:0;box-sizing:border-box}
*::before,*::after{box-sizing:border-box}
html,body{height:100%}
body{font-family:var(--font);background-color:var(--paper);color:var(--text);font-size:14px;line-height:1.5;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;display:flex;min-height:100vh}
button,input,select,textarea{font-family:inherit;font-size:inherit;color:inherit}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--surface-3);border-radius:5px;border:2px solid var(--bg)}
::-webkit-scrollbar-thumb:hover{background:var(--border-strong)}
a{color:var(--accent);text-decoration:none}
code{font-family:var(--mono);font-size:12px;background:var(--surface-2);color:var(--text);
  padding:2px 6px;border-radius:4px;border:1px solid var(--border)}

/* ── 布局：sidebar 232px + main，.panel 切换 ──────────── */
.sidebar{width:232px;background:var(--surface);border-right:1px solid var(--border);
  position:fixed;top:0;left:0;bottom:0;display:flex;flex-direction:column;z-index:10}
.sidebar .brand{padding:20px 22px 18px;display:flex;align-items:center;gap:10px;
  border-bottom:1px solid var(--border)}
.brand-logo{width:32px;height:32px;border-radius:8px;
  background:linear-gradient(135deg,var(--accent) 0%,var(--accent-hover) 100%);
  display:flex;align-items:center;justify-content:center;
  font-weight:800;color:#fff;font-size:15px;box-shadow:0 4px 12px var(--accent-soft)}
.brand-name{font-size:15px;font-weight:600;letter-spacing:-.01em}
.brand-sub{font-size:11px;color:var(--text-dim);margin-top:1px}
.sidebar nav{flex:1;padding:12px 10px;overflow-y:auto}
.nav-group{margin-bottom:18px}
.nav-group-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--text-dim);padding:0 12px 6px;font-weight:600}
.sidebar nav a{display:flex;align-items:center;gap:10px;padding:8px 12px;
  color:var(--text-muted);font-size:13px;font-weight:500;border-radius:var(--radius-sm);
  transition:all .15s;margin-bottom:2px;cursor:pointer}
.sidebar nav a:hover{color:var(--text);background:var(--surface-2)}
.sidebar nav a.on{color:var(--text);background:var(--surface-3);box-shadow:inset 2px 0 0 var(--accent)}
.sidebar nav a svg{width:16px;height:16px;flex-shrink:0}
.sidebar .footer{padding:12px 18px;font-size:11px;color:var(--text-dim);
  border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
.footer-actions{display:flex;align-items:center;gap:8px}
.footer-meta{display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}
.sidebar .footer .btn{padding:4px 8px;font-size:11px}
.footer-icon-btn{display:inline-flex;align-items:center;justify-content:center;padding:4px 6px}
.footer-icon-btn svg{width:15px;height:15px;display:block}
.fver{font-family:var(--mono);font-size:10.5px;color:var(--text-dim)}

.main{margin-left:232px;flex:1;padding:28px 36px 40px;min-height:100vh}
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;gap:16px;flex-wrap:wrap}
.page-title{font-size:24px;font-weight:650;letter-spacing:-.02em}
.page-subtitle{font-size:11px;color:var(--text-muted);margin-top:4px;
  text-transform:uppercase;letter-spacing:.22em}

.panel{display:none;animation:fadeIn .2s ease}
.panel.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

/* ── 统计瓦片 ────────────────────────────────────────── */
.metrics-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:16px 18px;box-shadow:var(--shadow-sm);display:flex;flex-direction:column;min-height:104px;
  transition:transform .18s cubic-bezier(.16,1,.3,1),box-shadow .18s,border-color .18s}
.card:hover{transform:translateY(1px);box-shadow:var(--shadow-sm);border-color:var(--border-strong)}
.card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-height:16px}
.card-title{font-size:12px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:.12em}
.card-value{font-size:27px;font-weight:700;letter-spacing:-.02em;line-height:1.2;
  font-variant-numeric:tabular-nums;margin-top:auto}
.card-sub{font-size:12px;color:var(--text-muted);margin-top:4px;min-height:15px}
.card.success,.card.info,.card.warn,.card.accent{border-left:3px solid transparent}
.card.success{border-left-color:var(--success)}
.card.info{border-left-color:var(--info)}
.card.warn{border-left-color:var(--warn)}
.card.accent{border-left-color:var(--accent)}
.card.success .card-value{color:var(--success)}
.card.info .card-value{color:var(--info)}
.card.warn .card-value{color:var(--warn)}
.card.accent .card-value{color:var(--accent)}

/* ── 区块 ───────────────────────────────────────────── */
.section{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  margin-bottom:20px;overflow:hidden;box-shadow:var(--shadow-sm)}
.section-header{padding:16px 20px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.section-title{font-size:16px;font-weight:650;letter-spacing:-.02em}
.section-desc{font-size:12px;color:var(--text-muted);margin-top:2px;font-weight:400;letter-spacing:.02em}
.section-body{padding:20px}
.section-body.tight{padding:0}
.section-footer{padding:14px 20px;background:var(--surface-2);border-top:1px solid var(--border);
  display:flex;justify-content:flex-end}

/* ── 按钮 ────────────────────────────────────────────── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;
  font-size:13px;font-weight:500;border:1px solid transparent;border-radius:var(--radius-sm);
  cursor:pointer;transition:all .15s;background:var(--surface-2);color:var(--text);
  white-space:nowrap;line-height:1.2}
.btn:hover:not(:disabled){background:var(--surface-3);border-color:var(--border-strong)}
.btn:active:not(:disabled){transform:translateY(1px)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn svg{width:14px;height:14px}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent);box-shadow:0 1px 3px var(--accent-soft)}
.btn-primary:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}
.btn-ghost{background:transparent;border-color:transparent;color:var(--text-muted)}
.btn-ghost:hover:not(:disabled){background:var(--surface-2);color:var(--text)}
.btn-icon{padding:7px}
.btn-icon.danger{color:var(--error)}
.btn-icon.danger:hover:not(:disabled){background:var(--error-soft);color:var(--error)}
.btn-group{display:inline-flex;gap:6px;flex-wrap:wrap}
.btn.on{background:var(--surface-3);color:var(--accent);border-color:var(--border-strong)}

/* ── 开关（账号启停）────────────────────────────────── */
.switch{position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0;vertical-align:middle}
.switch input{opacity:0;width:0;height:0}
.switch-slider{position:absolute;cursor:pointer;inset:0;background:var(--surface-2);
  border:1px solid var(--border);border-radius:22px;transition:.18s}
.switch-slider::before{content:'';position:absolute;height:16px;width:16px;
  left:2px;bottom:2px;background:var(--text-muted);border-radius:50%;transition:.18s}
.switch input:checked + .switch-slider{background:var(--accent);border-color:var(--accent)}
.switch input:checked + .switch-slider::before{transform:translateX(18px);background:#fff}

/* ── 表单控件：input / select / textarea 一体样式（windsurf）── */
.input,.select,.textarea{display:block;width:100%;padding:9px 12px;font-size:13px;font-family:var(--font);
  background:var(--bg-elev);border:1px solid var(--border);border-radius:var(--radius-sm);
  color:var(--text);outline:none;transition:all .15s;line-height:1.35}
.input:hover,.select:hover,.textarea:hover{border-color:var(--border-strong)}
.input:focus,.select:focus,.textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.input::placeholder,.textarea::placeholder{color:var(--text-dim)}
.input.mono,.textarea{font-family:var(--mono);font-size:12.5px}
.textarea{min-height:150px;resize:vertical;line-height:1.65}
/* 原生 select：去默认箭头，画一个主题化的 chevron */
.select{appearance:none;-webkit-appearance:none;cursor:pointer;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");
  background-repeat:no-repeat;background-position:right 10px center;padding-right:32px}
.select option{background:var(--surface);color:var(--text)}

/* ── 自定义下拉（.cs：隐藏原生 select 存值 + 自绘 trigger/menu）── */
.cs{position:relative;display:block;width:100%}
.cs-native{position:absolute;width:1px;height:1px;padding:0;margin:-1px;
  overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;opacity:0;pointer-events:none}
.cs-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;
  width:100%;padding:9px 12px;font-size:13px;font-family:var(--font);
  background:var(--bg-elev);border:1px solid var(--border);
  border-radius:var(--radius-sm);color:var(--text);cursor:pointer;
  text-align:left;line-height:1.35;transition:border-color .15s,box-shadow .15s}
.cs-trigger:hover{border-color:var(--border-strong)}
.cs-trigger.open,.cs-trigger:focus-visible{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.cs-label{display:inline-flex;align-items:center;gap:8px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.cs-chevron{flex-shrink:0;width:12px;height:12px;color:var(--text-dim);transition:transform .15s}
.cs-trigger.open .cs-chevron{transform:rotate(180deg)}
.cs-menu{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:50;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);
  box-shadow:var(--shadow-lg);max-height:280px;overflow-y:auto;padding:4px;
  animation:fadeIn .12s ease}
.cs-opt{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;
  font-size:13px;color:var(--text-muted);cursor:pointer;transition:background .12s,color .12s}
.cs-opt:hover{background:var(--surface-2);color:var(--text)}
.cs-opt.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.cs-opt .prov-icon{width:18px;height:18px;flex:none}
.cs-opt .prov-icon svg{width:16px;height:16px}
.lvl-dot{width:8px;height:8px;border-radius:50%;background:var(--text-dim);flex:none}
.lvl-dot.dot-info{background:var(--info)}
.lvl-dot.dot-warn{background:var(--warn)}
.lvl-dot.dot-error{background:var(--error)}

/* ── checkbox：windsurf 主题化裸 checkbox + .checkbox 组件 ── */
.checkbox{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;
  color:var(--text-muted);user-select:none}
.checkbox input{position:absolute;opacity:0;pointer-events:none}
.checkbox .box{width:16px;height:16px;border:1.5px solid var(--border-strong);border-radius:4px;
  display:flex;align-items:center;justify-content:center;background:var(--bg-elev);
  transition:all .15s;flex-shrink:0}
.checkbox input:checked + .box{background:var(--accent);border-color:var(--accent)}
.checkbox input:checked + .box::after{content:'';width:4px;height:8px;border:solid #fff;
  border-width:0 2px 2px 0;transform:rotate(45deg) translateY(-1px)}
.checkbox:hover .box{border-color:var(--accent)}
/* 所有没被 .switch / .checkbox 包住的裸 checkbox/radio 一网打尽 */
input[type=checkbox]:not(.switch input):not(.checkbox input),
input[type=radio]:not(.segmented input){
  appearance:none;-webkit-appearance:none;width:16px;height:16px;margin:0;flex-shrink:0;
  vertical-align:-3px;border:1.5px solid var(--border-strong);background:var(--bg-elev);
  cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s;position:relative}
input[type=checkbox]:not(.switch input):not(.checkbox input){border-radius:4px}
input[type=radio]:not(.segmented input){border-radius:50%}
input[type=checkbox]:not(.switch input):not(.checkbox input):hover,
input[type=radio]:not(.segmented input):hover{border-color:var(--accent)}
input[type=checkbox]:not(.switch input):not(.checkbox input):checked,
input[type=radio]:not(.segmented input):checked{background:var(--accent);border-color:var(--accent)}
input[type=checkbox]:not(.switch input):not(.checkbox input):checked::after{content:'';
  position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;
  border-width:0 2px 2px 0;transform:rotate(45deg)}
input[type=radio]:not(.segmented input):checked::after{content:'';position:absolute;
  left:50%;top:50%;width:6px;height:6px;border-radius:50%;background:#fff;
  transform:translate(-50%,-50%)}
input[type=checkbox]:not(.switch input):not(.checkbox input):focus-visible,
input[type=radio]:not(.segmented input):focus-visible{outline:none;
  box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent),0 0 0 3px var(--accent-soft)}
input[type=checkbox]:not(.switch input):not(.checkbox input):disabled,
input[type=radio]:not(.segmented input):disabled{opacity:.45;cursor:not-allowed}

.field{display:flex;flex-direction:column;gap:6px;flex:1;min-width:0}
.field-label{font-size:12px;color:var(--text-muted);font-weight:500}
.field-hint{font-size:12px;color:var(--text-dim);line-height:1.5}
.field-row{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));align-items:end}
.req{color:var(--error)}
.note{border-left:2px solid var(--accent);background:var(--accent-soft);padding:9px 12px;
  border-radius:0 var(--radius-sm) var(--radius-sm) 0;font-size:12px;color:var(--text);line-height:1.65}

/* ── 账号表格 ────────────────────────────────────────── */
.table-wrap{overflow-x:auto;border-radius:var(--radius)}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{text-align:left;padding:11px 16px;font-size:11px;font-weight:600;text-transform:uppercase;
  letter-spacing:.04em;color:var(--text-muted);background:var(--surface-2);
  border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;top:0;z-index:1}
tbody td{padding:11px 16px;border-bottom:1px solid var(--border);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr{transition:background .1s;animation:in .32s cubic-bezier(.2,.7,.3,1) backwards}
tbody tr:hover td{background:var(--surface-2)}
tbody tr.selectable{position:relative}
tbody tr.selectable:hover{cursor:pointer}
.acc-name{font-weight:600}
.acc-sub{font-size:11px;color:var(--text-muted);margin-top:2px}
.cell-sub{font-size:10.5px;color:var(--text-dim);margin-top:2px;line-height:1.4}
.mono{font-family:var(--mono)}
.num{font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums}
.dim{color:var(--text-dim)}
.acts{display:flex;gap:4px;align-items:center;white-space:nowrap}
/* 行展开的 ▸（windsurf expand-chevron 形态） */
.expand-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;
  border-radius:4px;border:1px solid transparent;background:transparent;color:var(--text-dim);
  cursor:pointer;transition:all .15s;font-size:10px;margin-right:6px;vertical-align:middle}
.expand-btn:hover{color:var(--text);background:var(--surface-2);border-color:var(--border)}
.expand-btn.open{color:var(--accent);transform:rotate(90deg)}
/* 展开详情行 + 顶部渐变描边 */
.detail-row td{padding:0 !important;background:var(--paper-2);border-bottom:1px solid var(--border)}
.detail-wrap{padding:16px 20px;background:linear-gradient(180deg,var(--accent-soft),transparent 85%)}
.detail-card{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px 18px}
.kv{display:flex;flex-direction:column;gap:1px}
.kv-k{font-size:10.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em}
.kv-v{font-size:12.5px;color:var(--text);word-break:break-all}
/* 出错账号的整行说明 */
.err-row td{background:var(--error-soft);padding:8px 16px;font:400 11.5px/1.55 var(--mono);color:var(--error)}
.err-row b{color:var(--error)}
.err-row .err-raw{color:var(--text-muted)}
@keyframes in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}

/* ── 徽章 ────────────────────────────────────────────── */
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;
  font-size:11px;font-weight:600;line-height:1.5;border:1px solid transparent}
.badge::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.success{background:var(--success-soft);color:var(--success)}
.badge.error{background:var(--error-soft);color:var(--error)}
.badge.disabled{background:var(--surface-3);color:var(--text-muted)}
.badge.warn{background:var(--warn-soft);color:var(--warn)}
.badge.info{background:var(--info-soft);color:var(--info)}

/* ── 空态 / 骨架屏 ──────────────────────────────────── */
.panel-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  width:100%;min-height:160px;padding:28px 16px;text-align:center;color:var(--text-dim)}
.panel-empty .pe-title{font-size:13px;font-weight:600;color:var(--text-muted)}
.panel-empty .pe-sub{font-size:11px;color:var(--text-dim);max-width:320px;line-height:1.5}
.skeleton{position:relative;overflow:hidden;background:var(--surface-2);border-radius:6px;color:transparent !important}
.skeleton::after{content:"";position:absolute;inset:0;transform:translateX(-100%);
  background:linear-gradient(90deg,transparent,var(--border),transparent);
  animation:skeleton-shimmer 1.4s ease-in-out infinite}
@keyframes skeleton-shimmer{100%{transform:translateX(100%)}}
.skeleton-line{height:1em;margin:6px 0}

/* ── 接入 ─────────────────────────────────────────────── */
pre{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:14px 16px;overflow:auto;font:400 12.5px/1.75 var(--mono);color:var(--text);margin:0;box-shadow:var(--shadow-sm)}
pre .c{color:var(--text-dim)}
pre .s{color:var(--success)}
.doc h3{font:600 13.5px/1 var(--font);margin:24px 0 10px;color:var(--text)}
.doc h3:first-child{margin-top:0}
.doc p{color:var(--text-muted);font-size:13px;margin:0 0 10px}
.conn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px}
.conn-row{display:flex;align-items:center;gap:10px;margin:8px 0}
.conn-row code{flex:1;overflow-x:auto}
.conn-k{font-size:12px;color:var(--text-dim);min-width:84px;flex-shrink:0}

/* ── 弹窗 ────────────────────────────────────────────── */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);
  display:flex;align-items:center;justify-content:center;z-index:100;padding:20px;animation:fadeIn .15s ease}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);
  width:min(560px,100%);max-height:88vh;overflow:auto;box-shadow:var(--shadow-lg);
  animation:modalIn .2s cubic-bezier(.16,1,.3,1)}
@keyframes modalIn{from{opacity:0;transform:translateY(-10px) scale(.98)}to{opacity:1;transform:none}}
.modal-header{padding:18px 24px 8px}
.modal-title{font-size:16px;font-weight:600}
.modal-body{padding:14px 24px 20px;display:flex;flex-direction:column;gap:14px}
.modal-footer{padding:14px 24px;background:var(--surface-2);display:flex;justify-content:flex-end;
  gap:8px;border-top:1px solid var(--border)}

/* ── 吐司 ────────────────────────────────────────────── */
.toast-stack{position:fixed;bottom:24px;right:24px;display:flex;flex-direction:column-reverse;
  gap:10px;z-index:9999;pointer-events:none}
.toast{padding:12px 18px;border-radius:var(--radius-sm);font-size:13px;background:var(--surface);
  border:1px solid var(--border);box-shadow:var(--shadow-lg);animation:slideIn .25s ease;
  pointer-events:auto;max-width:400px;white-space:pre-line}
.toast.success{border-left:3px solid var(--success)}
.toast.error{border-left:3px solid var(--error)}
.toast.info{border-left:3px solid var(--info)}
@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.2);
  border-top-color:currentColor;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── 悬停提示：全局唯一一个绝对定位浮层 ──────────────── */
.tip{position:fixed;left:0;top:0;pointer-events:none;z-index:600;
  background:var(--tip-bg);color:var(--tip-fg);
  border:1px solid var(--tip-border);border-radius:8px;padding:8px 12px;
  font-size:12px;line-height:1.55;box-shadow:var(--shadow-lg);
  opacity:0;transition:opacity .12s ease;max-width:min(360px,calc(100vw - 24px))}
.tip.show{opacity:1}
.tip .tt-row{display:flex;align-items:baseline;gap:10px;white-space:nowrap}
.tip .tt-k{color:var(--tip-fg);opacity:.55}
.tip .tt-v{color:var(--tip-fg);font-weight:600;margin-left:auto;font-variant-numeric:tabular-nums}
.tip .tt-sep{height:1px;background:var(--tip-border);margin:6px 0}

/* ── 登录页（windsurf login-overlay 形态）────────────── */
.login-overlay{position:fixed;inset:0;
  background:radial-gradient(ellipse at center,var(--accent-soft) 0%,var(--bg) 70%);
  display:flex;align-items:center;justify-content:center;z-index:200}
.login-box{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);
  padding:36px 32px;width:min(380px,calc(100% - 32px));box-shadow:var(--shadow-lg)}
.login-box .login-logo{width:56px;height:56px;margin:0 auto 18px;border-radius:14px;
  background:linear-gradient(135deg,var(--accent) 0%,var(--accent-hover) 100%);
  display:flex;align-items:center;justify-content:center;
  font-weight:800;font-size:22px;color:#fff;box-shadow:0 10px 30px var(--accent-soft)}
.login-box h3{text-align:center;font-size:18px;margin-bottom:8px}
.login-box p{text-align:center;font-size:13px;color:var(--text-muted);margin-bottom:22px}
.login-box .field{margin-bottom:14px}
.login-box .btn{width:100%;padding:11px;font-weight:600}
.lgerr{color:var(--error);font-size:12.5px;margin-top:11px;text-align:center;min-height:18px}

/* ── 表格增强：批量条 / 工具栏 / 密度 ────────────────── */
.batch-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;margin:0 0 10px;
  background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:13px;flex-wrap:wrap}
.batch-bar b{font-variant-numeric:tabular-nums;color:var(--accent)}
.batch-bar .btn{padding:4px 10px;font-size:12px}
table.compact thead th{padding:6px 14px}
table.compact tbody td{padding:6px 14px}
.toolbar{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-bottom:16px;padding:16px;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-sm)}
.toolbar .field{min-width:130px}
.toolbar .grow{flex:1;min-width:200px}
.spacer{flex:1}

/* ── 日志 ────────────────────────────────────────────── */
.log-meta{display:flex;gap:14px;font-size:11px;color:var(--text-dim);margin:0 0 8px 2px}
.log-container{height:520px;overflow-y:auto;background:var(--paper-2);border:1px solid var(--border);
  border-radius:var(--radius);font:400 12px/1.7 var(--mono);padding:6px 0}
.log-entry{display:flex;gap:10px;padding:2px 14px;white-space:pre-wrap;word-break:break-all}
.log-entry .ts{color:var(--text-dim);flex:none}
.log-entry .lvl{width:52px;flex:none;font-weight:600}
.log-entry.error{background:var(--error-soft)}
.log-entry.error .lvl{color:var(--error)}
.log-entry.warn .lvl{color:var(--warn)}
.log-entry.info .lvl{color:var(--info)}
.log-entry.debug .lvl{color:var(--text-dim)}

/* ── 模型：厂商分组 + 模型卡片（可收缩）──────────────── */
.provider-group{margin-bottom:22px;animation:in .3s backwards}
.provider-group:last-child{margin-bottom:0}
.provider-label{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--text);
  margin-bottom:10px;letter-spacing:.01em}
.prov-icon{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center}
.prov-icon svg{width:18px;height:18px}
.prov-let{width:20px;height:20px;border-radius:6px;background:var(--surface-3);color:var(--text-muted);
  display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.pg-count{font-size:11px;color:var(--text-dim);background:var(--surface-2);border-radius:999px;padding:1px 8px}
.mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.mod{padding:13px 15px;animation:in .3s backwards;cursor:pointer;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);
  display:flex;flex-direction:column;gap:8px;transition:border-color .15s,box-shadow .15s}
.mod:hover{border-color:var(--accent)}
.mod.open{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.mod.unreachable{opacity:.5}
.mod-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.mod-id{font:500 13px/1.3 var(--mono);color:var(--accent);word-break:break-all}
.mod-badges{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;align-items:center;justify-content:flex-end}
.mod-chev{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;
  color:var(--text-dim);transition:transform .2s;font-size:10px;border-radius:4px}
.mod-chev.open{transform:rotate(90deg);color:var(--accent)}
/* 块折叠动画：grid-template-rows 0fr↔1fr，纯 CSS 过渡，双向都动 */
.mod-collapse{display:grid;grid-template-rows:0fr;overflow:hidden;
  transition:grid-template-rows .28s cubic-bezier(.16,1,.3,1)}
.mod-collapse.open{grid-template-rows:1fr}
.mod-collapse-inner{overflow:hidden;min-height:0;display:flex;flex-direction:column;gap:8px}
.mod-name{font-size:12.5px;color:var(--text-muted)}
.mod-pars{display:flex;flex-direction:column;gap:6px}
.seg-row{display:flex;align-items:center;gap:8px}
.seg-label{font-size:11px;color:var(--text-dim);flex:none;min-width:56px}
.seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.seg-btn{border:none;background:var(--surface-2);color:var(--text-muted);padding:4px 10px;
  font:400 11.5px/1.3 var(--mono);cursor:pointer;transition:background .12s,color .12s}
.seg-btn:hover{color:var(--text)}
.seg-btn.on{background:var(--accent);color:#fff}
.mod-vars{display:flex;flex-wrap:wrap;gap:5px}
.var-chip{display:inline-flex;align-items:center;gap:4px;font:400 11px/1.5 var(--mono);
  color:var(--text-muted);background:var(--surface-2);border:1px dashed var(--border-strong);
  padding:3px 8px;border-radius:5px}
.mod-detail{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);
  padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-muted)}
.mod-prev{word-break:break-all}
.mod-al{font-size:11.5px;color:var(--text-dim);word-break:break-all}
.chip-badge{font-size:10px;font-weight:600;color:var(--text-muted);background:var(--surface-3);
  border-radius:999px;padding:1px 7px;white-space:nowrap}
.chip-badge.free{color:var(--success);background:var(--success-soft)}
.chip-badge.paid{color:var(--warn);background:var(--warn-soft)}

/* ── 统计 ────────────────────────────────────────────── */
.tok-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:10px}
.tok-k{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em}
.tok-v{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:2px}
.chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
.chart-box canvas{width:100%;height:240px;display:block;margin-top:8px}
.rank-row{display:flex;align-items:center;gap:12px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12.5px}
.rank-row:last-child{border-bottom:none}
.rank-name{width:34%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--mono);color:var(--text-muted)}
.rank-bar{flex:1;height:8px;background:var(--surface-3);border-radius:4px;overflow:hidden}
.rank-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-hover));
  border-radius:4px;transition:width .5s cubic-bezier(.16,1,.3,1)}
.rank-num{width:56px;text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
.rank-sr{width:52px;text-align:right;color:var(--text-dim);font-family:var(--mono)}
/* 统计图例（图卡 header）：色点 + 名称 + 当前区间合计 */
.chart-legend{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);
  font-weight:500;white-space:nowrap}
.cl-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.cl-val{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text)}
/* 日志页最近请求表：空态/降级提示一行 */
.req-msg{padding:18px 20px;font-size:12.5px;color:var(--text-dim)}

/* ── 设置 ────────────────────────────────────────────── */
.tabs{display:inline-flex;gap:4px;background:var(--surface-2);border:1px solid var(--border);
  border-radius:var(--radius-sm);padding:4px;margin-bottom:18px}
.tab-btn{border:none;background:transparent;color:var(--text-muted);padding:6px 18px;
  border-radius:6px;font-size:13px;font-weight:500;cursor:pointer}
.tab-btn.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm)}
.cfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.cfg-hint{margin-top:14px;padding:10px 14px;background:var(--warn-soft);color:var(--text);
  border-radius:var(--radius-sm);font-size:12.5px;line-height:1.6}
.cfg-group{margin-bottom:20px}
.cfg-group:last-child{margin-bottom:0}
.cfg-group-title{display:flex;align-items:baseline;gap:8px;font-size:13px;font-weight:600;
  margin-bottom:10px;letter-spacing:.01em}
.cfg-group-desc{font-size:11px;color:var(--text-dim);font-weight:400}
/* 凭证管理（windsurf credentials 区形态） */
.cred-row{padding:12px;background:var(--surface-2);border-radius:var(--radius);display:grid;gap:8px}
.cred-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cred-head strong{font-size:13px}
.cred-head .cur{font-family:var(--mono);font-size:12px;color:var(--text-dim)}
.cred-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cred-actions .input{flex:1;min-width:220px}
.cred-actions .btn{padding:8px 14px}

/* ── 窄屏收起侧栏 ────────────────────────────────────── */
@media(max-width:820px){
  .sidebar{width:64px}
  .brand-name,.brand-sub,.sidebar nav a span,.footer-meta{display:none}
  .sidebar nav a{justify-content:center}
  .main{margin-left:64px;padding:20px 14px 50px}
  .metrics-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
}
@media(max-width:900px){.chart-grid{grid-template-columns:1fr}}

@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
  .spinner{animation-duration:.8s !important;animation-iteration-count:infinite !important}
}
`;

// 图标：只用得着这几个，没必要引图标库
const I = {
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12 15h5"/></svg>',
  cube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2.6 21 7v10l-9 4.4L3 17V7z"/><path d="m3 7 9 4.4L21 7M12 11.4v10"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="M7 16v-4"/><path d="M12 16V8"/><path d="M17 16v-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 9l5-5 5 5M12 4v12"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  rows: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
};

// 厂商 SVG 图标：lobe-icons 风格，24x24 viewBox fill="currentColor"。
// 12 家厂商的内嵌 path（assemble-ui.mjs 生成，零构建约束下单文件产物）。
const PROV = {"openai": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z\"></path></svg>", "anthropic": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z\"></path></svg>", "google": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z\"></path></svg>", "deepseek": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z\"></path></svg>", "xai": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815\"></path></svg>", "moonshot": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M1.052 16.916l9.539 2.552a21.007 21.007 0 00.06 2.033l5.956 1.593a11.997 11.997 0 01-5.586.865l-.18-.016-.044-.004-.084-.009-.094-.01a11.605 11.605 0 01-.157-.02l-.107-.014-.11-.016a11.962 11.962 0 01-.32-.051l-.042-.008-.075-.013-.107-.02-.07-.015-.093-.019-.075-.016-.095-.02-.097-.023-.094-.022-.068-.017-.088-.022-.09-.024-.095-.025-.082-.023-.109-.03-.062-.02-.084-.025-.093-.028-.105-.034-.058-.019-.08-.026-.09-.031-.066-.024a6.293 6.293 0 01-.044-.015l-.068-.025-.101-.037-.057-.022-.08-.03-.087-.035-.088-.035-.079-.032-.095-.04-.063-.028-.063-.027a5.655 5.655 0 01-.041-.018l-.066-.03-.103-.047-.052-.024-.096-.046-.062-.03-.084-.04-.086-.044-.093-.047-.052-.027-.103-.055-.057-.03-.058-.032a6.49 6.49 0 01-.046-.026l-.094-.053-.06-.034-.051-.03-.072-.041-.082-.05-.093-.056-.052-.032-.084-.053-.061-.039-.079-.05-.07-.047-.053-.035a7.785 7.785 0 01-.054-.036l-.044-.03-.044-.03a6.066 6.066 0 01-.04-.028l-.057-.04-.076-.054-.069-.05-.074-.054-.056-.042-.076-.057-.076-.059-.086-.067-.045-.035-.064-.052-.074-.06-.089-.073-.046-.039-.046-.039a7.516 7.516 0 01-.043-.037l-.045-.04-.061-.053-.07-.062-.068-.06-.062-.058-.067-.062-.053-.05-.088-.084a13.28 13.28 0 01-.099-.097l-.029-.028-.041-.042-.069-.07-.05-.051-.05-.053a6.457 6.457 0 01-.168-.179l-.08-.088-.062-.07-.071-.08-.042-.049-.053-.062-.058-.068-.046-.056a7.175 7.175 0 01-.027-.033l-.045-.055-.066-.082-.041-.052-.05-.064-.02-.025a11.99 11.99 0 01-1.44-2.402zm-1.02-5.794l11.353 3.037a20.468 20.468 0 00-.469 2.011l10.817 2.894a12.076 12.076 0 01-1.845 2.005L.657 15.923l-.016-.046-.035-.104a11.965 11.965 0 01-.05-.153l-.007-.023a11.896 11.896 0 01-.207-.741l-.03-.126-.018-.08-.021-.097-.018-.081-.018-.09-.017-.084-.018-.094c-.026-.141-.05-.283-.071-.426l-.017-.118-.011-.083-.013-.102a12.01 12.01 0 01-.019-.161l-.005-.047a12.12 12.12 0 01-.034-2.145zm1.593-5.15l11.948 3.196c-.368.605-.705 1.231-1.01 1.875l11.295 3.022c-.142.82-.368 1.612-.668 2.365l-11.55-3.09L.124 10.26l.015-.1.008-.049.01-.067.015-.087.018-.098c.026-.148.056-.295.088-.442l.028-.124.02-.085.024-.097c.022-.09.045-.18.07-.268l.028-.102.023-.083.03-.1.025-.082.03-.096.026-.082.031-.095a11.896 11.896 0 011.01-2.232zm4.442-4.4L17.352 4.59a20.77 20.77 0 00-1.688 1.721l7.823 2.093c.267.852.442 1.744.513 2.665L2.106 5.213l.045-.065.027-.04.04-.055.046-.065.055-.076.054-.072.064-.086.05-.065.057-.073.055-.07.06-.074.055-.069.065-.077.054-.066.066-.077.053-.06.072-.082.053-.06.067-.074.054-.058.073-.078.058-.06.063-.067.168-.17.1-.098.059-.056.076-.071a12.084 12.084 0 012.272-1.677zM12.017 0h.097l.082.001.069.001.054.002.068.002.046.001.076.003.047.002.06.003.054.002.087.005.105.007.144.011.088.007.044.004.077.008.082.008.047.005.102.012.05.006.108.014.081.01.042.006.065.01.207.032.07.012.065.011.14.026.092.018.11.022.046.01.075.016.041.01L14.7.3l.042.01.065.015.049.012.071.017.096.024.112.03.113.03.113.032.05.015.07.02.078.024.073.023.05.016.05.016.076.025.099.033.102.036.048.017.064.023.093.034.11.041.116.045.1.04.047.02.06.024.041.018.063.026.04.018.057.025.11.048.1.046.074.035.075.036.06.028.092.046.091.045.102.052.053.028.049.026.046.024.06.033.041.022.052.029.088.05.106.06.087.051.057.034.053.032.096.059.088.055.098.062.036.024.064.041.084.056.04.027.062.042.062.043.023.017c.054.037.108.075.161.114l.083.06.065.048.056.043.086.065.082.064.04.03.05.041.086.069.079.065.085.071c.712.6 1.353 1.283 1.909 2.031L7.222.994l.062-.027.065-.028.081-.034.086-.035c.113-.045.227-.09.341-.131l.096-.035.093-.033.084-.03.096-.031c.087-.03.176-.058.264-.085l.091-.027.086-.025.102-.03.085-.023.1-.026L9.04.37l.09-.023.091-.022.095-.022.09-.02.098-.021.091-.02.095-.018.092-.018.1-.018.091-.016.098-.017.092-.014.097-.015.092-.013.102-.013.091-.012.105-.012.09-.01.105-.01c.093-.01.186-.018.28-.024l.106-.008.09-.005.11-.006.093-.004.1-.004.097-.002.099-.002.197-.002z\"></path></svg>", "zhipu": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M9.917 2c4.906 0 10.178 3.947 8.93 10.58-.014.07-.037.14-.057.21l-.003-.277c-.083-3-1.534-8.934-8.87-8.934-3.393 0-8.137 3.054-7.93 8.158-.04 4.778 3.555 8.4 7.95 8.332l.073-.001c1.2-.033 2.763-.429 3.1-1.657.063-.031.26.534.268.598.048.256.112.369.192.34.981-.348 2.286-1.222 1.952-2.38-.176-.61-1.775-.147-1.921-.347.418-.979 2.234-.926 3.153-.716.443.102.657.38 1.012.442.29.052.981-.2.96.242C17.226 19.632 13.833 22 9.918 22 3.654 22 0 16.574 0 11.737 0 5.947 4.959 2 9.917 2zM9.9 5.3c.484 0 1.125.225 1.38.585 3.669.145 4.313 2.686 4.694 5.444.255 1.838.315 2.3.182 1.387l.083.59c.068.448.554.737.982.516.144-.075.254-.231.328-.47a.2.2 0 01.258-.13l.625.22a.2.2 0 01.124.238 2.172 2.172 0 01-.51.92c-.878.917-2.757.664-3.08-.62-.14-.554-.055-.626-.345-1.242-.292-.621-1.238-.709-1.69-.295-.345.315-.407.805-.406 1.282L12.6 15.9a.9.9 0 01-.9.9h-1.4a.9.9 0 01-.9-.9v-.65a1.15 1.15 0 10-2.3 0v.65a.9.9 0 01-.9.9H4.8a.9.9 0 01-.9-.9l.035-3.239c.012-1.884.356-3.658 2.47-4.134.2-.045.252.13.29.342.025.154.043.252.053.294.701 3.058 1.75 4.299 3.144 3.722l.66-.331.254-.13c.158-.082.25-.131.276-.15.012-.01-.165-.206-.407-.464l-1.012-1.067a8.925 8.925 0 01-.199-.216c-.047-.034-.116.068-.208.306-.074.157-.251.252-.272.326-.013.058.108.298.362.72.164.288.22.508-.31.343-1.04-.8-1.518-2.273-1.684-3.725-.004-.035-.162-1.913-.162-1.913a1.2 1.2 0 011.113-1.281L9.9 5.3zm12.994 8.68c.037.697-.403.704-1.213.591l-1.783-.276c-.265-.053-.385-.099-.313-.147.47-.315 3.268-.93 3.31-.168zm-.915-.083l-.926.042c-.85.077-1.452.24.338.336l.103.003c.815.012 1.264-.359.485-.381zm1.667-3.601h.01c.79.398.067 1.03-.65 1.393-.14.07-.491.176-1.052.315-.241.04-.457.092-.333.16l.01.005c1.952.958-3.123 1.534-2.495 1.285l.38-.148c.68-.266 1.614-.682 1.666-1.337.038-.48 1.253-.442 1.493-.968.048-.106 0-.236-.144-.389-.05-.047-.094-.094-.107-.148-.073-.305.7-.431 1.222-.168zm-2.568-.474c-.135 1.198-2.479 4.192-1.949 2.863l.017-.042c.298-.717.376-2.221 1.337-3.221.25-.26.636.035.595.4zm-7.976-.253c.02-.694 1.002-.968 1.346-.347.01-1.274-1.941-.768-1.346.347z\"></path></svg>", "qwen": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z\"></path></svg>", "meta": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M6.897 4c1.915 0 3.516.932 5.43 3.376l.282-.373c.19-.246.383-.484.58-.71l.313-.35C14.588 4.788 15.792 4 17.225 4c1.273 0 2.469.557 3.491 1.516l.218.213c1.73 1.765 2.917 4.71 3.053 8.026l.011.392.002.25c0 1.501-.28 2.759-.818 3.7l-.14.23-.108.153c-.301.42-.664.758-1.086 1.009l-.265.142-.087.04a3.493 3.493 0 01-.302.118 4.117 4.117 0 01-1.33.208c-.524 0-.996-.067-1.438-.215-.614-.204-1.163-.56-1.726-1.116l-.227-.235c-.753-.812-1.534-1.976-2.493-3.586l-1.43-2.41-.544-.895-1.766 3.13-.343.592C7.597 19.156 6.227 20 4.356 20c-1.21 0-2.205-.42-2.936-1.182l-.168-.184c-.484-.573-.837-1.311-1.043-2.189l-.067-.32a8.69 8.69 0 01-.136-1.288L0 14.468c.002-.745.06-1.49.174-2.23l.1-.573c.298-1.53.828-2.958 1.536-4.157l.209-.34c1.177-1.83 2.789-3.053 4.615-3.16L6.897 4zm-.033 2.615l-.201.01c-.83.083-1.606.673-2.252 1.577l-.138.199-.01.018c-.67 1.017-1.185 2.378-1.456 3.845l-.004.022a12.591 12.591 0 00-.207 2.254l.002.188c.004.18.017.36.04.54l.043.291c.092.503.257.908.486 1.208l.117.137c.303.323.698.492 1.17.492 1.1 0 1.796-.676 3.696-3.641l2.175-3.4.454-.701-.139-.198C9.11 7.3 8.084 6.616 6.864 6.616zm10.196-.552l-.176.007c-.635.048-1.223.359-1.82.933l-.196.198c-.439.462-.887 1.064-1.367 1.807l.266.398c.18.274.362.56.55.858l.293.475 1.396 2.335.695 1.114c.583.926 1.03 1.6 1.408 2.082l.213.262c.282.326.529.54.777.673l.102.05c.227.1.457.138.718.138.176.002.35-.023.518-.073.338-.104.61-.32.813-.637l.095-.163.077-.162c.194-.459.29-1.06.29-1.785l-.006-.449c-.08-2.871-.938-5.372-2.2-6.798l-.176-.189c-.67-.683-1.444-1.074-2.27-1.074z\"></path></svg>", "mistral": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path clip-rule=\"evenodd\" d=\"M3.428 3.4h3.429v3.428h3.429v3.429h-.002 3.431V6.828h3.427V3.4h3.43v13.714H24v3.429H13.714v-3.428h-3.428v-3.429h-3.43v3.428h3.43v3.429H0v-3.429h3.428V3.4zm10.286 13.715h3.428v-3.429h-3.427v3.429z\"></path></svg>", "aws": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M6.763 11.212c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 01-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 01-.287-.375 6.18 6.18 0 01-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.39-.384-.59-.894-.59-1.533 0-.678.24-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272-.09.04-.184.075-.28.104a.488.488 0 01-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 01.224-.167 4.577 4.577 0 011.005-.36 4.84 4.84 0 011.246-.151c.95 0 1.644.216 2.091.647.44.43.662 1.085.662 1.963v2.586h.016zm-3.24 1.214c.263 0 .534-.048.822-.144a1.78 1.78 0 00.758-.51 1.27 1.27 0 00.272-.512c.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 00-.735-.136 6.02 6.02 0 00-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 6.726a1.398 1.398 0 01-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 01.32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 01.311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 01-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 01-.303.08h-.687c-.15 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32L12.32 7.747l-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08l-.686.001zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 01-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.32.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 00.415-.758.777.777 0 00-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 01-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .36.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 01.24.2.43.43 0 01.071.263v.375c0 .168-.064.256-.184.256a.83.83 0 01-.303-.096 3.652 3.652 0 00-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.16.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926a2.157 2.157 0 01-.583.703c-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167z\"></path><path d=\"M.378 15.475c3.384 1.963 7.56 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.44-.2.814.287.383.607-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351zm23.531-.2c.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151l.175-.439c.343-.88.802-2.198.52-2.555-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399z\"></path></svg>", "microsoft": "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M11.49 2H2v9.492h9.492V2h-.002z\"></path><path d=\"M22 2h-9.492v9.492H22V2z\"></path><path d=\"M11.49 12.508H2V22h9.492v-9.492h-.002z\"></path><path d=\"M22 12.508h-9.492V22H22v-9.492z\"></path></svg>"};

const BODY = `
<aside class="sidebar">
  <div class="brand">
    <div class="brand-logo">C</div>
    <div><div class="brand-name">CursorAPI</div><div class="brand-sub">Cursor 转 API 的网关</div></div>
  </div>
  <nav>
    <div class="nav-group">
      <div class="nav-group-label">号池</div>
      <a class="on" data-v="pool" onclick="go('pool')">${I.grid}<span>概览</span></a>
      <a data-v="accounts" onclick="go('accounts')">${I.users}<span>账号管理</span></a>
    </div>
    <div class="nav-group">
      <div class="nav-group-label">观测</div>
      <a data-v="logs" onclick="go('logs')">${I.term}<span>日志</span></a>
      <a data-v="stats" onclick="go('stats')">${I.chart}<span>统计</span></a>
    </div>
    <div class="nav-group">
      <div class="nav-group-label">资源</div>
      <a data-v="models" onclick="go('models')">${I.cube}<span>模型</span></a>
      <a data-v="settings" onclick="go('settings')">${I.gear}<span>设置</span></a>
      <a data-v="conn" onclick="go('conn')">${I.plug}<span>接入信息</span></a>
    </div>
  </nav>
  <div class="footer">
    <div class="footer-meta"><span id="foot">—</span><span class="fver" id="fver"></span><span class="fver" id="upd-badge" style="display:none;color:var(--accent);cursor:pointer" onclick="go('settings')" title="发现新版本，点击到设置页更新">▲ 升级</span></div>
    <div class="footer-actions">
      <button class="btn btn-ghost footer-icon-btn" onclick="go('settings')" title="设置">${I.gear}</button>
      <button class="btn btn-ghost" onclick="logout()" title="退出登录">退出登录</button>
    </div>
  </div>
</aside>
<main class="main">
  <div class="page-header">
    <div><h1 class="page-title" id="ttl">概览</h1><div class="page-subtitle" id="sub">加载中…</div></div>
    <button class="btn btn-ghost footer-icon-btn" id="tb" onclick="toggleTheme()" title="切换主题"></button>
  </div>
  <section class="panel active" data-v="pool" id="p-pool"><div id="view-pool"></div></section>
  <section class="panel" data-v="accounts" id="p-accounts"><div id="view-accounts"></div></section>
  <section class="panel" data-v="logs" id="p-logs"><div id="view-logs"></div></section>
  <section class="panel" data-v="models" id="p-models"><div id="view-models"></div></section>
  <section class="panel" data-v="stats" id="p-stats"><div id="view-stats"></div></section>
  <section class="panel" data-v="settings" id="p-settings"><div id="view-settings"></div></section>
  <section class="panel" data-v="conn" id="p-conn"><div id="view-conn"></div></section>
</main>
<div id="modal"></div>
<div class="toast-stack" id="toast"></div>
<div id="chart-tip" style="display:none;position:fixed;z-index:120;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.25)"></div>
<div id="tip" class="tip"></div>
`;

// 客户端脚本。**全程不用模板字符串**（外层已经是模板字符串了，嵌套只会自找麻烦），
// 注释里也**不能出现反引号**（会提前截断整个 JS 块）。踩过一次。
const JS = `
// ── 主题：首帧就定好（默认暗色），避免亮色一闪 ──
// localStorage / documentElement 都写成容错形式 —— 测试沙箱里没有这两个东西。
try{ var th = localStorage.getItem("dashboard_theme") || "dark"; }catch(_){ var th = "dark"; }
if(th==="dark" && document.documentElement) document.documentElement.setAttribute("data-theme","dark");
var tb0 = document.getElementById("tb");
if(tb0) tb0.innerHTML = th==="dark" ? ICO.sun : ICO.moon;
function toggleTheme(){
  var cur = (document.documentElement && document.documentElement.getAttribute("data-theme")==="dark") ? "dark" : "light";
  var next = cur==="dark" ? "light" : "dark";
  if(document.documentElement){
    if(next==="dark") document.documentElement.setAttribute("data-theme","dark");
    else document.documentElement.removeAttribute("data-theme");
  }
  try{ localStorage.setItem("dashboard_theme", next); }catch(_){}
  var tb = document.getElementById("tb");
  if(tb) tb.innerHTML = next==="dark" ? ICO.sun : ICO.moon;
  if(view==="stats" && statsData && !statsData.error) drawCharts();
}

// 🔴 必须用绝对路径。
// 页面挂在 /admin（**没有**尾斜杠），相对路径 "status" 会被浏览器解析成 /status
// —— 那不是管理接口，直接 401，页面就永远是空的。有测试守着这条。
async function api(p, opt){
  const r = await fetch("/admin/" + p, opt);
  // 会话过期（12 小时）或被注销：接口回 401，直接刷新 —— 服务端会给登录页。
  if(r.status===401){ location.reload(); throw new Error("会话已过期，正在跳转登录"); }
  const t = await r.text();
  var d = null; try { d = t ? JSON.parse(t) : null; } catch(_) {}
  if(!r.ok){ var err=new Error((d && d.error && d.error.message) || t || ("HTTP " + r.status)); err.status=r.status; err.body=d; throw err; }
  return d;
}
async function logout(){
  try{ await fetch("/admin/logout", {method:"POST"}); }catch(_){}
  location.reload();
}
function j(body){ return { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) }; }

var esc = function(s){ return String(s==null?"":s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); };
var fmt = function(n){ n = n||0;
  return n>=1e9 ? (n/1e9).toFixed(2)+"B" : n>=1e6 ? (n/1e6).toFixed(2)+"M" : n>=1e3 ? (n/1e3).toFixed(1)+"k" : String(n); };
var ago = function(t){ if(!t) return "—";
  var s=(Date.now()-new Date(t))/1000;
  return s<60?Math.round(s)+" 秒前":s<3600?Math.round(s/60)+" 分钟前":
         s<86400?Math.round(s/3600)+" 小时前":Math.round(s/86400)+" 天前"; };
var $ = function(id){ return document.getElementById(id); };

function toast(msg, kind){
  var map={ok:"success",bad:"error"};
  var d=document.createElement("div"); d.className="toast "+(map[kind]||kind||"info"); d.textContent=msg;
  $("toast").appendChild(d);
  setTimeout(function(){ d.style.transition="opacity .3s"; d.style.opacity=0;
    setTimeout(function(){ d.remove(); }, 300); }, kind==="bad"?6000:3200);
}

// ── 悬停提示：一个绝对定位浮层（#tip），内容存 TIP 数组，hover 传下标 ──
// 不用 getBoundingClientRect —— 直接跟鼠标事件坐标走（position:fixed），
// 测试沙箱的 makeEl 上没有这个方法，这条路对沙箱零依赖。
function tipRow(k, v){
  return '<div class="tt-row"><span class="tt-k">'+esc(k)+'</span><span class="tt-v">'+esc(v)+'</span></div>';
}
function tipSep(){ return '<div class="tt-sep"></div>'; }
function tipPush(html){ TIP.push(html); return TIP.length-1; }
var tipX=0, tipY=0;
function tipShow(i){
  var t=$("tip"); if(!t) return;
  t.innerHTML=TIP[i]||"";
  t.className="tip show";
  positionTip(t);
}
function tipHide(){
  var t=$("tip"); if(!t) return;
  t.className="tip";
}
// 坐标无条件缓存：鼠标快速移进来停住时（移动全在未显示阶段），
// tipShow 也能按最后坐标定位，不会闪到视口左上角
function tipMove(ev){
  tipX=(ev&&ev.clientX)||0;
  tipY=(ev&&ev.clientY)||0;
  var t=$("tip"); if(!t || t.className.indexOf("show")===-1) return;
  positionTip(t);
}
function positionTip(t){
  var w=0, h=0;
  try{
    if(typeof window!=="undefined" && window.innerWidth) w=window.innerWidth;
    if(typeof window!=="undefined" && window.innerHeight) h=window.innerHeight;
  }catch(_){}
  // offsetWidth 在测试沙箱里没有，取个保守宽度兜底，不影响真浏览器
  var tw=t.offsetWidth||240, th=t.offsetHeight||96;
  var left=tipX+14, top=tipY+14;
  if(w && left+tw>w-8) left=tipX-tw-14;
  if(h && top+th>h-8) top=tipY-th-14;
  if(left<4) left=4;
  if(top<4) top=4;
  t.style.left=left+"px";
  t.style.top=top+"px";
}

// ── 视图调度 ───────────────────────────────────────────
var VIEWS={pool:"概览",accounts:"账号管理",logs:"日志",models:"模型",stats:"统计",settings:"设置",conn:"接入信息"};
// 从 URL 片段取初始页签：每个页签都能收藏、能用浏览器的前进后退
var view = VIEWS[String(location.hash||"").slice(1)] ? location.hash.slice(1) : "pool";
var data=null, models=null, statsData=null, cfg=null, upd=null, busy=false;
// 更新页签：updErr = 可读错误提示条（perform 失败分类后的文案）；updPrevVer = perform 前版本，失败后回滚判定用
var updErr=null, updPrevVer=null;
var sel=new Set(), exp=new Set();
var dens=false, cfgRendered=[], cfgRestart=new Set(), cfgOverrides={}, cfgMasked={};
var PAGE={pool:1, accounts:1}, PAGE_SIZE=50;
var cfgEff=[];
try{ var _ps=Number(localStorage.getItem("acc_page_size")); if(_ps>0) PAGE_SIZE=_ps; }catch(_){}
var logRing=[], logAbort=null, logStarted=false, logTimer=null;
// 最近请求表：reqData=null 未加载/失败；reqAt 上次**完成**时间（SSE 顺带刷新节流）；
// reqBusy 防止并发 in-flight；reqFailAt 失败后 10s 退避，避免故障时帧率即请求率
var reqData=null, reqAt=0, reqExp={}, reqBusy=false, reqFailAt=0;
var statsLoaded=false, cfgLoaded=false, updLoaded=false, statsAt=0;
var pageHidden=false;
// SIG：任何结构性变化（勾选/展开/密度/筛选）都自增，表格签名跟着变 → 强制重绘；
// 签名没变（纯心跳轮询）就不写 innerHTML，避免 10s 一次的全量重绘
var SIG=0;
var TIP=[], poolInfo=null;
// 模型页状态：搜索词 / 厂商筛选 / 展开的模型 / 各模型已选参数 / 当前过滤结果
var modQ="", modProv="", modOpen={}, modParams={}, modList=[];
var poolShell=false, acctShell=false, lastPoolSig=null, lastAcctSig=null;
// 自定义下拉状态：CS[id]={labels:{值:显示html},cb:回调名}；CS_IDS 用于全局关闭
var CS={}, CS_IDS=[], CS_OPEN=null;
try{ dens = localStorage.getItem("acc_density")==="1"; }catch(_){}

function go(v){
  view=v;
  if(location.hash.slice(1)!==v) location.hash=v;
  var links=document.querySelectorAll("nav a");
  for(var i=0;i<links.length;i++) links[i].className = links[i].dataset.v===v ? "on" : "";
  var panels=document.querySelectorAll(".panel");
  for(var j=0;j<panels.length;j++) panels[j].className = panels[j].dataset.v===v ? "panel active" : "panel";
  $("ttl").textContent = VIEWS[v];
  if(v==="models" && !models) loadModels();
  if(v==="logs"){ 
    if(!logStarted){ logStarted=true; startLogs(); }
    // 断流后切走再切回：logStarted 闩锁已开但没有活流（stopLogs 清了
    // abort），这里重新拉起；有重试定时器在跑就让定时器接手，不抢。
    else if(!logAbort && !logRetryTimer){ startLogs(); }
    startReqTicker();
  }
  else { stopLogs(); stopReqTicker(); }
  if(v==="stats" && !statsLoaded) loadStats();
  if(v==="settings" && !cfgLoaded) loadSettings();
  render();
}
window.addEventListener("hashchange", function(){
  var v=location.hash.slice(1);
  if(VIEWS[v] && v!==view) go(v);
});

// ── 自定义下拉组件（windsurf .cs 形态）─────────────────
// 结构：隐藏原生 <select>（存 value，供读取）+ 自绘 trigger + menu。
// 菜单选项里能放 SVG 图标（原生 option 放不了），这是厂商筛选要它的原因。
// 沙箱约束：全部走 getElementById + onclick，不加事件监听器。
function csToggle(id, ev){
  if(ev && ev.stopPropagation) ev.stopPropagation();
  var m=document.getElementById("csm-"+id);
  var t=document.getElementById("cst-"+id);
  if(!m) return;
  var open=(m.style.display!=="none");
  closeCs();
  if(!open){
    m.style.display="block";
    CS_OPEN=id;
    if(t) t.className="cs-trigger open";
  }
}
function csPick(id, v, ev){
  if(ev && ev.stopPropagation) ev.stopPropagation();
  var s=document.getElementById(id);
  if(s) s.value=v;
  var d=CS[id];
  var lb=document.getElementById("csl-"+id);
  if(lb && d && d.labels && d.labels[v]!=null) lb.innerHTML=d.labels[v];
  closeCs();
  if(d && d.cb && typeof window!=="undefined" && window[d.cb]) window[d.cb]();
}
function closeCs(){
  CS_OPEN=null;
  for(var i=0;i<CS_IDS.length;i++){
    var m=document.getElementById("csm-"+CS_IDS[i]);
    if(m) m.style.display="none";
    var t=document.getElementById("cst-"+CS_IDS[i]);
    if(t && t.className.indexOf("open")!==-1) t.className="cs-trigger";
  }
}
// 点菜单外面任意处收起（data-cs="1" 标记属于组件内部）
document.onclick = function(ev){
  if(!CS_OPEN) return;
  var t=ev && ev.target, inside=false;
  while(t && t.getAttribute){
    if(t.getAttribute("data-cs")==="1"){ inside=true; break; }
    t=t.parentNode;
  }
  if(!inside) closeCs();
};

// ── 概览（号池） ──────────────────────────────────────
function tiles(d){
  var t=d.totals;
  var accs=d.accounts||[];
  var fails=0, cool=0, cfgDis=0, autoDis=0, now=Date.now();
  for(var i=0;i<accs.length;i++){
    fails+=(accs[i].failures||0);
    var cu=accs[i].cooldownUntil;
    if(cu && new Date(cu).getTime()>now) cool++;
    if(accs[i].disabled) (accs[i].disabledBy==="config"?cfgDis++:autoDis++);
  }
  var dis=d.total-d.available;
  // failures 是尝试级计数、runs 是轮级计数，一次 run 里可能多次换号重试，
  // 差的极端情况会算出负数 —— 只展示不可能是负的成功数
  var succ=Math.max(0,t.runs-fails);
  var sr=t.runs>0?(succ/t.runs*100):null;
  TIP=[];
  var tips=[
    tipPush(tipRow("总数",d.total)+tipRow("已禁用",dis)+tipRow("冷却中",cool)),
    tipPush(tipRow("可用",d.available)+tipRow("总数",d.total)+tipRow("冷却中",cool)
      +(d.pendingToolCalls?tipRow("工具调用挂起",d.pendingToolCalls):"")),
    tipPush(tipRow("冷却中",cool)+tipRow("已禁用",dis)+tipRow("可用",d.available)),
    tipPush(tipRow("已禁用",dis)+tipRow("配置禁用",cfgDis)+tipRow("自动禁用",autoDis)),
    tipPush(tipRow("成功",succ)+tipRow("失败",fails)+tipRow("成功率",sr==null?"—":sr.toFixed(1)+"%")),
    tipPush(tipRow("成功",succ)+tipRow("总调用",t.runs)+tipRow("成功率",sr==null?"—":sr.toFixed(1)+"%")),
    tipPush(tipRow("失败",fails)+tipRow("失败率",sr==null?"—":(100-sr).toFixed(1)+"%")),
    tipPush(tipRow("挂起",d.pendingToolCalls)+tipRow("说明","工具调用中途被打断会挂起，超时自动清理")),
  ];
  return '<div class="metrics-grid">'
   + kpi("号总数",d.total,(d.pendingToolCalls?d.pendingToolCalls+" 个工具调用挂起":dis?dis+" 个已禁用":"全部在线"),"accent",tips[0])
   + kpi("可用",d.available,dis+" 个已禁用","success",tips[1])
   + kpi("冷却中",cool,"冷却结束自动放回","warn",tips[2])
   + kpi("已禁用",dis,cfgDis?"含 "+cfgDis+" 个配置禁用":"全部在线","error",tips[3])
   + '</div>'
   + '<div class="metrics-grid">'
   + kpi("累计调用",fmt(t.runs),succ+" 成功 · "+fails+" 失败","info",tips[4])
   + kpi("成功率",sr==null?"—":sr.toFixed(1)+"%",succ+" 次成功","success",tips[5])
   + kpi("失败",fmt(fails),sr==null?"—":(100-sr).toFixed(1)+"% 失败率","warn",tips[6])
   + kpi("工具挂起",d.pendingToolCalls||0,"超时自动清理","info",tips[7])
   + '</div>'
   + '<div class="metrics-grid"><div class="card" style="grid-column:1/-1"><div class="card-header"><div class="card-title">Token 明细</div></div>'
     + '<div class="tok-grid">'
       + tokBlock("输入",t.inputTokens)+tokBlock("输出",t.outputTokens)
       + tokBlock("合计",t.inputTokens+t.outputTokens)+tokBlock("调用笔数",t.runs)
     + '</div></div></div>';
}

// 上游的报错是英文的。翻译最常见的那几条，并且**把该怎么办也写上**。
// 认不出的原样透出：编一句中文解释反而会把人引向错误的方向。
function explain(e){
  var m = String(e.message||"");
  // 不要照抄 Cursor 那句「try logging out and back in」—— API Key 是无状态凭据，
  // 退出重登对它没有任何作用。实测过该错 3 小时后自愈，key 全程有效。
  if (/authentication error/i.test(m)) {
    return "Cursor 上游报了鉴权错误，但这把 key 本身是好的（探活一直通）。"
         + "实测过一次这种情况持续了 3 小时后自愈 —— 多半是 Cursor 那边的问题，"
         + "先等等看。号已暂时停用，10 分钟后会自动放回来再试一次。"
         + "若几小时都不恢复，再考虑回 Cursor 重新生成 API Key。";
  }
  if (e.status===401 || e.name==="AuthenticationError") {
    return "这把 key 无效或已被吊销（Cursor 返回 401）。重新生成一把换上。";
  }
  if (e.status===403) return "这个号没有这项权限（Cursor 返回 403），多半是订阅等级不够。";
  if (e.status===429) return "被限流了（429）。等一会儿会自己恢复，不用动它。";
  if ((e.status||0)>=500) return "Cursor 那边出错了（"+e.status+"），通常是临时的。";
  if (/idle timeout/i.test(m)) return "这一轮太久没动静，已放弃等待。";
  return "";
}

// 行展开的详情卡：key 掩码/优先级/状态/最后使用/累计调用/token/错误信息
function detailCard(a){
  var rows=[
    ["Key",esc(a.maskedKey)],
    ["优先级",a.priority!=null?String(a.priority):"—"],
    ["状态",a.disabled?(a.disabledBy==="config"?"配置禁用":"已禁用"):"可用"],
    ["最后使用",ago(a.lastUsedAt)],
    ["累计调用",String(a.runs)],
    ["Token","入 "+fmt(a.inputTokens)+" · 出 "+fmt(a.outputTokens)],
  ];
  if(a.disabledReason) rows.push(["禁用原因",esc(a.disabledReason)]);
  if(a.autoRecoverable!=null) rows.push(["自动恢复",a.autoRecoverable?"会":"不会"]);
  if(a.cooldownUntil) rows.push(["冷却",coolCdHtml(a.cooldownUntil)]);
  if(a.email) rows.push(["邮箱",esc(a.email)]);
  if(a.login) rows.push(["登录邮箱",esc(a.login)]);
  if(a.keyCreatedAt) rows.push(["Key 创建",esc(String(a.keyCreatedAt).slice(0,10))]);
  if(a.hasPassword) rows.push(["密码","已存服务器（不回显）"]);
  if(a.lastError){
    var e=a.lastError;
    rows.push(["最近错误",esc(e.name+" "+(e.status||"")+" "+(e.code||"")+" · "+(e.message||""))]);
  }
  var out='<div class="detail-card">';
  for(var i=0;i<rows.length;i++){
    out+='<div class="kv"><div class="kv-k">'+rows[i][0]+'</div><div class="kv-v">'+(rows[i][1]||"—")+'</div></div>';
  }
  return out+'</div>';
}

// 冷却倒计时单元格：渲染时算一次，之后 coolTick() 每秒刷新（只在账号页跑）。
// 悬停 title 保留绝对时间兜底。剩余 >1h 显示 H:MM:SS，否则 MM:SS。
function coolFmt(ms){
  var s=Math.max(0,Math.floor(ms/1000));
  var h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60;
  if(h>0) return h+":"+pad2(m)+":"+pad2(ss);
  return pad2(m)+":"+pad2(ss);
}
function coolCdHtml(cu){
  var rem=0, t=new Date(cu).getTime();
  if(!isNaN(t)) rem=Math.max(0,t-Date.now());
  return '<span class="cool-cd" data-cu="'+esc(String(cu))+'" title="冷却到 '+esc(String(cu).slice(0,19).replace("T"," "))+'">'
    + (rem>0 ? "冷却中 剩余 "+coolFmt(rem) : "冷却结束") + '</span>';
}

// ── Ctrl/Shift 多选（windsurf 勾选交互）────────────────
// 行点击：普通点 = 切换勾选；Ctrl/Cmd = 切换；Shift = 从锚点连选到这一行。
// 复选框 onchange 走 toggleSel；行 onclick 走 rowClick —— 复选框自身
// stopPropagation，两种入口不会互相抵消。
var lastSelId=null;
function rowClick(id, ev){
  var e=ev||{};
  if(e.ctrlKey || e.metaKey){ lastSelId=id; selToggle(id); return; }
  if(e.shiftKey){
    var ids=[];
    if(data) for(var i=0;i<data.accounts.length;i++) ids.push(data.accounts[i].id);
    var a=ids.indexOf(id), b=ids.indexOf(lastSelId);
    if(b===-1){ lastSelId=id; selToggle(id); return; }
    var lo=Math.min(a,b), hi=Math.max(a,b);
    for(var j=lo;j<=hi;j++) sel.add(ids[j]);
    lastSelId=id;
    SIG++;
    updateBatchBars();
    refreshTable();
    return;
  }
  lastSelId=id;
  selToggle(id);
}
function selToggle(id){
  if(sel.has(id)) sel.delete(id); else sel.add(id);
  SIG++;
  updateBatchBars();
  refreshTable();
}

function buildRows(rows){
  return rows.map(function(a,i){
    var e=a.lastError;
    var cn = e ? explain(e) : "";
    var raw = e ? (e.name+" "+(e.status||"")+" "+(e.code||"")+" · "+(e.message||"")) : "";
    var st = a.disabled
      ? (a.disabledBy==="config" ? '<span class="badge disabled">配置禁用</span>' : '<span class="badge error">已禁用</span>')
      : '<span class="badge success">可用</span>';
    var pri = a.priority ? '<span class="badge warn">P'+a.priority+'</span>' : '<span class="dim">—</span>';
    var open = exp.has(a.id);
    return '<tr class="selectable" style="animation-delay:'+(i*22)+'ms" onclick="rowClick(\\''+a.id+'\\',event)">'
     + '<td style="text-align:center"><input type="checkbox"'+(sel.has(a.id)?" checked":"")
       + ' onchange="toggleSel(\\''+a.id+'\\',this.checked)" onclick="event.stopPropagation()"'
       + ' title="勾选后可用批量操作"></td>'
     + '<td><button class="expand-btn'+(open?" open":"")+'" onclick="event.stopPropagation();toggleExp(\\''+a.id+'\\')" title="展开详情">▸</button>'
       + '<div class="acc-name">'+esc(a.name)+'</div>'
       + '<div class="acc-sub">'+esc(a.email||"身份未知")
       + (a.keyCreatedAt ? ' · key 建于 '+esc(String(a.keyCreatedAt).slice(0,10)) : '')
       + (a.login && a.login!==a.email ? ' · 登录 '+esc(a.login) : '')
       + (a.hasPassword ? ' · <span title="密码已记在服务器上（不回显）">有密码</span>' : '')
       + '</div></td>'
     + '<td class="mono dim" title="点击复制完整 Key" style="cursor:pointer" onclick="copyKey(\\''+a.id+'\\')">'+esc(a.maskedKey)+'</td>'
     + '<td>'+pri+'</td>'
     + '<td>'+st
       + (a.disabledReason && !e ? '<div class="cell-sub">'+esc(a.disabledReason)+'</div>' : '')
       + '</td>'
     + '<td class="num">'+a.runs+'</td>'
     + '<td class="num">'+fmt(a.inputTokens+a.outputTokens)+'<div class="cell-sub">入 '+fmt(a.inputTokens)+' · 出 '+fmt(a.outputTokens)+'</div></td>'
     + '<td class="num">'+ago(a.lastUsedAt)+'</td>'
     + '<td><div class="acts" onclick="event.stopPropagation()">'
       + '<label class="switch" title="'+(a.disabled?"启用":"禁用")+'">'
         + '<input type="checkbox"'+(a.disabled?"":" checked")+' onchange="toggle(\\''+a.id+'\\',this.checked)">'
         + '<span class="switch-slider"></span></label>'
       + '<button class="btn btn-icon btn-ghost" title="探活" onclick="probe(\\''+a.id+'\\')">'+ICO.refresh+'</button>'
       + '<button class="btn btn-icon btn-ghost" title="复制完整 Key" onclick="copyKey(\\''+a.id+'\\')">'+ICO.copy+'</button>'
       + '<button class="btn btn-icon btn-ghost" title="改名 / 改优先级" onclick="editOpen(\\''+a.id+'\\')">'+ICO.edit+'</button>'
       + '<button class="btn btn-icon btn-ghost danger" title="删除" onclick="del(\\''+a.id+'\\')">'+ICO.trash+'</button>'
       + '</div></td></tr>'
     // 展开详情行：兄弟 tr，colspan 撑满整行
     + (open ? '<tr class="detail-row"><td colspan="9"><div class="detail-wrap">'+detailCard(a)+'</div></td></tr>' : '')
     // 中文解释在上、英文原文在下：读得懂的直接看第一行就知道该干嘛
     + (raw ? '<tr class="err-row"><td colspan="9">'
         + (cn ? '<b>'+esc(cn)+'</b><br><span class="err-raw">'+esc(raw)+'</span>' : esc(raw))
         + '</td></tr>' : '');
  }).join("");
}

function tableHtml(rows, tid){
  var allsel = rows.length>0 && rows.every(function(x){ return sel.has(x.id); });
  return '<div class="table-wrap"><table'+(dens?' class="compact"':"")+'><thead><tr>'
   + '<th style="width:34px;text-align:center"><input type="checkbox"'+(allsel?" checked":"")
     + ' onchange="toggleSelectAll(this.checked)" title="全选 / 取消全选"></th>'
   + '<th>账号</th><th>Key</th><th>优先级</th><th>状态</th><th>调用</th><th>Token</th><th>最后使用</th><th>操作</th>'
   + '</tr></thead><tbody>'+buildRows(rows)+'</tbody></table></div>';
}

function emptyHtml(t, s){
  return '<div class="panel-empty"><div class="pe-title">'+t+'</div><div class="pe-sub">'+s+'</div></div>';
}

// ── 批量勾选 / 批量操作 ───────────────────────────────
function batchBarHtml(suf){
  return '<div id="abb-'+suf+'" class="batch-bar" style="display:none">'
   + '<span>已选 <b id="abbc-'+suf+'">0</b> 个</span>'
   + '<button class="btn" onclick="batchOp(\\'enable\\')">启用</button>'
   + '<button class="btn" onclick="batchOp(\\'disable\\')">禁用</button>'
   + '<button class="btn" onclick="batchOp(\\'probe\\')">探活</button>'
   + '<button class="btn btn-ghost danger" onclick="batchOp(\\'delete\\')">删除</button>'
   + '<button class="btn" onclick="exportAccounts()">'+ICO.down+'导出</button>'
   + '<button class="btn btn-ghost" onclick="clearSel()">清除选择</button></div>';
}
function updateBatchBars(){
  var n=sel.size;
  var c=$("abbc-pool"); if(c) c.textContent=n;
  var b=$("abb-pool"); if(b) b.style.display=n?"flex":"none";
  var c2=$("abbc-acct"); if(c2) c2.textContent=n;
  var b2=$("abb-acct"); if(b2) b2.style.display=n?"flex":"none";
}
function toggleSel(id, checked){
  if(checked) sel.add(id); else sel.delete(id);
  lastSelId=id;
  SIG++;
  updateBatchBars();
  refreshTable();
}
function toggleSelectAll(checked){
  if(!data) return;
  for(var i=0;i<data.accounts.length;i++){
    if(checked) sel.add(data.accounts[i].id); else sel.delete(data.accounts[i].id);
  }
  SIG++;
  updateBatchBars();
  refreshTable();
}
function clearSel(){ sel.clear(); SIG++; updateBatchBars(); refreshTable(); }
function refreshTable(){
  if(view==="pool") renderPoolTable();
  else if(view==="accounts") renderAccountsTable();
}
var OP_NAME={enable:"启用",disable:"禁用",probe:"探活",delete:"删除"};
function batchOp(op){
  var ids=[]; sel.forEach(function(x){ ids.push(x); });
  if(!ids.length){ toast("先勾选账号","bad"); return; }
  if(op==="delete"){
    askConfirm("确认删除选中的 "+ids.length+" 个号？用量记录一并丢弃。", function(){ doBatchOp(ids, op); }, true);
    return;
  }
  doBatchOp(ids, op);
}
function doBatchOp(ids, op){
  var p=act(function(){ return api("accounts/batch", j({ids:ids, op:op})); },
    function(r){
      var okn=(typeof r.ok==="number")?r.ok:(r.ok?ids.length:0);
      var f=(r&&r.failed)||0;
      return "批量"+OP_NAME[op]+"：成功 "+okn+(f?"，失败 "+f:"");
    });
  if(p && p.then) p.then(function(){ clearSel(); });
}

// ── 导出（fetch 拿内容，Blob 下载；沙箱里没有 Blob 就只吐吐司）──
function download(name, text){
  try{
    if(typeof Blob==="undefined" || !document.body){ toast("已导出（当前环境无法下载文件）","info"); return; }
    var blob=new Blob([text],{type:"application/octet-stream"});
    var a=document.createElement("a");
    if(!a || typeof a.click!=="function") return;
    if(typeof URL!=="undefined" && URL.createObjectURL) a.href=URL.createObjectURL(blob);
    else a.href="data:,"+encodeURIComponent(text);
    a.download=name;
    document.body.appendChild(a);
    a.click();
    try{ if(URL.revokeObjectURL) URL.revokeObjectURL(a.href); }catch(_){}
    try{ a.remove(); }catch(_){}
    toast("已导出 "+name,"ok");
  }catch(e){ toast("导出失败："+(e.message||e),"bad"); }
}
function today(){ return new Date().toISOString().slice(0,10); }
async function exportAccounts(){
  try{
    var r=await fetch("/admin/accounts/export");
    if(!r.ok) throw new Error("HTTP "+r.status);
    var txt=await r.text();
    download("cursorapi-accounts-"+today()+".json", txt);
  }catch(e){ toast("导出失败："+(e.message||e),"bad"); }
}

// ── 概览页 ────────────────────────────────────────────
function renderPool(){
  if(!data){
    $("sub").textContent="加载中…";
    if(!poolShell){
      poolShell=true;
      $("view-pool").innerHTML='<div class="metrics-grid">'
        + '<div class="card"><div class="skeleton skeleton-line" style="width:50%"></div><div class="skeleton skeleton-line" style="width:70%"></div></div>'
        + '<div class="card"><div class="skeleton skeleton-line" style="width:50%"></div><div class="skeleton skeleton-line" style="width:70%"></div></div>'
        + '<div class="card"><div class="skeleton skeleton-line" style="width:50%"></div><div class="skeleton skeleton-line" style="width:70%"></div></div>'
        + '<div class="card"><div class="skeleton skeleton-line" style="width:50%"></div><div class="skeleton skeleton-line" style="width:70%"></div></div>'
        + '</div>';
    }
    return;
  }
  $("sub").textContent = data.total+" 个号，"+data.available+" 个可用"
    + (data.pendingToolCalls ? "，"+data.pendingToolCalls+" 个工具调用挂起中" : "");
  // 壳只建一次；心跳轮询只刷 KPI 瓦片和表格，不整页重绘
  if(!poolShell){
    poolShell=true;
    $("view-pool").innerHTML='<div id="pool-kpis"></div>'
     + '<section class="section"><div class="section-header">'
       + '<div><div class="section-title">账号列表</div>'
         + '<div class="section-desc">'+data.total+' 个号 · 勾选后批量操作；点行或 ▸ 看详情；Ctrl/Shift 多选</div></div>'
       + '<div class="btn-group">'
         + '<button class="btn" onclick="load(1)">'+ICO.refresh+'刷新</button>'
         + '<button class="btn" onclick="reload()">'+ICO.file+'重载号池文件</button>'
         + '<button class="btn" onclick="batchOpen()">'+ICO.up+'批量导入</button>'
         + '<button class="btn btn-primary" onclick="addOpen()">'+ICO.plus+'添加账号</button>'
       + '</div></div>'
     + batchBarHtml("pool")
     + '<div class="section-body tight" id="pool-table"></div></section>'
     + '<section class="section"><div class="section-header">'
       + '<div><div class="section-title">请求趋势</div>'
         + '<div class="section-desc">近 24 小时请求量（数据来自 /admin/stats）</div></div></div>'
       + '<div class="section-body"><canvas id="ov-trend" height="170" style="width:100%;display:block"></canvas></div></section>';
  }
  var k=$("pool-kpis");
  if(k) k.innerHTML=tiles(data);
  maybeTrend();
  renderPoolTable();
}
// 概览的趋势图数据与统计页共用 /admin/stats，60 秒才拉一次（10s 心跳不吃量）
function maybeTrend(){
  if(!statsData || Date.now()-statsAt>60000){
    statsAt=Date.now();
    loadStats();
  }
}
// 增量渲染：行签名没变就不重写表格。签名含密度、版本号（勾选/展开/筛选等
// 结构性变化会自增）和每行的状态字段 —— 心跳轮询时数据没变就零 DOM 写入。
function tableSig(rows){
  var s="d"+(dens?1:0)+"v"+SIG;
  for(var i=0;i<rows.length;i++){
    var a=rows[i];
    s+="|"+a.id+(a.disabled?"D":"")+(a.disabledBy||"")+(a.disabledReason||"")
      +"|"+(a.runs||0)+"|"+(a.inputTokens||0)+"|"+(a.outputTokens||0)+"|"+(a.failures||0)
      +"|"+(a.lastUsedAt||"")+"|"+(a.priority||0)
      +"|"+(exp.has(a.id)?1:0)+(sel.has(a.id)?1:0);
  }
  return s;
}
function renderPoolTable(){
  var box=$("pool-table"); if(!box) return;
  var rows=data.accounts||[];
  var sig=tableSig(rows);
  if(box.innerHTML && sig===lastPoolSig) return;
  lastPoolSig=sig;
  box.innerHTML = rows.length
    ? tableHtml(rows, "pool")
    : emptyHtml("池子是空的","现在所有请求都会返回 503。点右上角「添加账号」把 Cursor API Key 加进来。");
}

// ── 账号管理页（独立面板：筛选 + 搜索 + 密度 + 批量）──
function filteredAccounts(){
  if(!data) return [];
  var st=$("af-st"), pr=$("af-pr"), q=$("af-q");
  var sv=st?st.value:"", pv=pr?pr.value:"", qv=(q?q.value:"").toLowerCase().trim();
  return data.accounts.filter(function(a){
    if(sv==="ok" && a.disabled) return false;
    if(sv==="disabled" && !a.disabled) return false;
    if(pv!==""){
      var p=a.priority||0;
      if(pv==="4"){ if(p<4) return false; }
      else if(p!==Number(pv)) return false;
    }
    if(qv){
      var hay=(a.name||"")+" "+(a.email||"")+" "+(a.login||"")+" "+(a.maskedKey||"")+" "+(a.id||"");
      if(hay.toLowerCase().indexOf(qv)===-1) return false;
    }
    return true;
  });
}
function renderAccounts(){
  if(!data){
    $("view-accounts").innerHTML='<div class="panel-empty"><div class="pe-title">加载中…</div></div>';
    return;
  }
  $("sub").textContent = data.total+" 个号 · 筛选、密度与批量管理";
  if(!acctShell){
    acctShell=true;
    $("view-accounts").innerHTML =
     '<div class="toolbar">'
     + '<div class="field"><label class="field-label">状态</label>'
       + '<select id="af-st" class="select" onchange="afilter()">'
         + '<option value="">全部</option><option value="ok">可用</option><option value="disabled">禁用</option></select></div>'
     + '<div class="field"><label class="field-label">优先级</label>'
       + '<select id="af-pr" class="select" onchange="afilter()">'
         + '<option value="">全部</option><option value="0">P0</option><option value="1">P1</option><option value="2">P2</option><option value="3">P3</option><option value="4">P4+</option></select></div>'
     + '<div class="field grow"><label class="field-label">搜索</label><input id="af-q" class="input" placeholder="名字 / 邮箱 / Key / ID…" onkeyup="onAcctSearch()"></div>'
     + '<div class="field"><label class="field-label">密度</label>'
       + '<button class="btn'+(dens?' on':"")+'" id="densb" onclick="toggleDensity()">'+ICO.rows+(dens?" 紧凑":" 舒适")+'</button></div>'
     + '<div class="spacer"></div>'
     + '<div class="btn-group">'
       + '<button class="btn" onclick="load(1)">'+ICO.refresh+'刷新</button>'
       + '<button class="btn" onclick="batchOpen()">'+ICO.up+'批量导入</button>'
       + '<button class="btn btn-primary" onclick="addOpen()">'+ICO.plus+'添加账号</button>'
     + '</div></div>'
     + batchBarHtml("acct")
     + '<section class="section"><div class="section-body tight" id="acct-table"></div></section>';
  }
  renderAccountsTable();
}
function afilter(){ SIG++; renderAccountsTable(); }
// 搜索防抖 200ms（同 onLogSearch 模式），防抖后自增 SIG 强制重绘
var acctTimer=null;
function onAcctSearch(){
  if(acctTimer) clearTimeout(acctTimer);
  acctTimer=setTimeout(function(){ acctTimer=null; SIG++; renderAccountsTable(); },200);
}
// 点击掩码 Key 单元格 → 复制完整 Key（管理面单号揭示端点）。
function copyKey(id){
  api("accounts/"+id+"/secret").then(function(r){
    if(!r || !r.key){ toast("无法读取 Key","bad"); return; }
    var done=function(){ toast("Key 已复制到剪贴板","ok"); };
    try{
      if(navigator && navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(r.key).then(done, function(){ fallbackCopy(r.key, done); });
      } else { fallbackCopy(r.key, done); }
    }catch(_){ fallbackCopy(r.key, done); }
  }).catch(function(e){ toast((e&&e.message)||"读取失败","bad"); });
}
function fallbackCopy(text, done){
  try{
    var ta=document.createElement("textarea");
    ta.value=text;
    ta.style.position="fixed"; ta.style.opacity="0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    var ok=document.execCommand?document.execCommand("copy"):false;
    document.body.removeChild(ta);
    if(ok){ done(); return; }
  }catch(_){}
  toast("复制失败（环境限制）","info");
}
// 通用复制（接入信息页等）：文本存 COPY_TEXTS 数组，按钮只带下标，
// 避免把含引号/换行的文本序列化进 onclick 字符串。
var COPY_TEXTS=[];
function copyText(i){
  var t=COPY_TEXTS[i];
  if(t==null){ toast("没有可复制的内容","bad"); return; }
  var done=function(){ toast("已复制到剪贴板","ok"); };
  try{
    if(navigator && navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(done, function(){ fallbackCopy(t, done); });
    } else { fallbackCopy(t, done); }
  }catch(_){ fallbackCopy(t, done); }
}
function copyBtn(i){
  return '<button class="btn btn-icon btn-ghost" title="复制" onclick="copyText('+i+')">'+ICO.copy+'</button>';
}function renderAccountsTable(){
  var box=$("acct-table"); if(!box) return;
  var rows=filteredAccounts();
  var page=pageNow();
  var pages=Math.max(1, Math.ceil(rows.length/PAGE_SIZE));
  if(page>pages) page=pages;
  var slice=rows.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
  var sig=tableSig(rows)+":"+page;
  if(box.innerHTML && sig===lastAcctSig) return;
  lastAcctSig=sig;
  box.innerHTML = rows.length
    ? tableHtml(slice, "acct") + pagerHtml(page, pages, rows.length)
    : emptyHtml("没有匹配的号","换个筛选条件试试。");
}
function pageNow(){
  var p=PAGE[view]||1;
  return p;
}
function pagerHtml(page, pages, total){
  var opts=[25,50,100,200];
  var o="";
  for(var i=0;i<opts.length;i++){
    o+='<option value="'+opts[i]+'"'+(PAGE_SIZE===opts[i]?" selected":"")+'>'+opts[i]+'</option>';
  }
  return '<div class="pager">'
   + '<span class="dim">共 '+total+' 个 · 第 '+page+'/'+pages+' 页</span>'
   + '<button class="btn btn-ghost"'+(page<=1?' disabled':'')+' onclick="pageGo(-1)">‹ 上一页</button>'
   + '<button class="btn btn-ghost"'+(page>=pages?' disabled':'')+' onclick="pageGo(1)">下一页 ›</button>'
   + '<select class="select" style="width:auto" onchange="pageSize(this.value)">'+o+'</select>'
   + '</div>';
}
function pageGo(d){
  var p=(PAGE[view]||1)+d;
  if(p<1) p=1;
  PAGE[view]=p;
  SIG++;
  renderAccountsTable();
}
function pageSize(v){
  PAGE_SIZE=Number(v)||50;
  try{ localStorage.setItem("acc_page_size", String(PAGE_SIZE)); }catch(_){}
  PAGE[view]=1;
  SIG++;
  renderAccountsTable();
}
function toggleDensity(){
  dens=!dens;
  try{ localStorage.setItem("acc_density", dens?"1":"0"); }catch(_){}
  var b=$("densb");
  if(b){ b.className="btn"+(dens?" on":""); b.innerHTML=ICO.rows+(dens?" 紧凑":" 舒适"); }
  SIG++;
  renderPoolTable(); renderAccountsTable();
}
function toggleExp(id){
  if(exp.has(id)) exp.delete(id); else exp.add(id);
  SIG++;
  refreshTable();
}

// ── 日志：fetch + ReadableStream 手动切帧（不用 EventSource）──
// 认证走 cookie，fetch 天然带上去；流失败（后端未就绪）显示占位，不崩。
// 断流自动重连：指数退避 2s→30s 封顶，只在日志页可见且非手动停止时重试。
var logRetryTimer=null, logRetryDelay=0;
function scheduleLogRetry(){
  if(view!=="logs" || logRetryTimer) return;
  logRetryDelay = logRetryDelay ? Math.min(logRetryDelay*2, 30000) : 2000;
  var st=$("logst"); if(st) st.textContent="断线重连中…（"+Math.round(logRetryDelay/1000)+"s 后重试）";
  logRetryTimer=setTimeout(function(){ logRetryTimer=null; startLogs(); }, logRetryDelay);
}
function startLogs(){
  if(logAbort) return;
  var st=$("logst"); if(st) st.textContent="连接中…";
  var box=$("logc"); if(box) box.innerHTML="";
  var ac=null;
  if(typeof AbortController!=="undefined"){ ac=new AbortController(); logAbort=ac; }
  fetch("/admin/logs", ac?{signal:ac.signal}:undefined)
   .then(function(res){
     if(!res || !res.ok || !res.body || !res.body.getReader) throw new Error("nostream");
     logRetryDelay=0;                            // 连上即重置退避
     var rd=res.body.getReader();
     var dec=(typeof TextDecoder!=="undefined")?new TextDecoder():null;
     var buf="";
     if(st) st.textContent="实时日志已连接";
     function pump(){
       return rd.read().then(function(x){
         if(x.done){ if(st) st.textContent="日志流已结束"; return; }
         if(dec) buf+=dec.decode(x.value,{stream:true});
         var i;
         // SSE 帧以空行分隔，每帧一行或多行 data:
         while((i=buf.indexOf("\\n\\n"))!==-1){
           var frame=buf.slice(0,i); buf=buf.slice(i+2);
           var payload="";
           var lines=frame.split("\\n");
           for(var k=0;k<lines.length;k++){
             var L=lines[k];
             if(L.indexOf("data:")===0) payload+=(payload?"\\n":"")+L.slice(6);
           }
           if(!payload) continue;
           var e=null; try{ e=JSON.parse(payload); }catch(_){}
           if(!e) continue;
           pushLog(e);
         }
         return pump();
       });
     }
     return pump();
   })
   .catch(function(err){
     // 只清自己的 controller：手动重连时旧流的 AbortError 异步到达，
     // 无条件清会把新流的 controller 丢掉（切页签后就无法停止它）。
     if(logAbort===ac) logAbort=null;
     var nostream = err && err.message==="nostream";
     // 手动停止（stopLogs abort）不算断流 —— 切页签/点重连时旧流的
     // 取消是异步到的，不区分的话会误排一次重试并盖掉「连接中」文案
     var manual = err && (err.name==="AbortError" || err.code==="ABORT_ERR");
     if(st) st.textContent = nostream
       ? "日志流不可用（后端未实现 /admin/logs？）"
       : (manual ? "日志已停止" : "日志流断开");
     var b=$("logc");
     if(b && !b.children.length) b.innerHTML='<div class="panel-empty"><div class="pe-sub">实时日志不可用 —— 后端未实现 /admin/logs 或连接失败。可点「重连」或改用右侧导出。</div></div>';
     if(!nostream && !manual) scheduleLogRetry();
   });
}
function stopLogs(){
  if(logRetryTimer){ if(typeof clearTimeout!=="undefined") clearTimeout(logRetryTimer); logRetryTimer=null; }
  if(logAbort){ try{ logAbort.abort(); }catch(_){} logAbort=null; }
}
function reconnectLogs(){ stopLogs(); startLogs(); }

function pushLog(e){
  maybeRefreshRequests();
  logRing.push(e);
  if(logRing.length>500) logRing.shift();
  var c=$("logc"); if(!c) return;
  var lvl=e.level||"info", msg=String(e.msg==null?JSON.stringify(e):e.msg)+(e.extra?" "+e.extra:""), ts=e.ts||Date.now();
  var lf=($("loglv")&&$("loglv").value)||"";
  var sq=($("logsq")&&$("logsq").value||"").toLowerCase();
  if(lf && lvl!==lf) return;
  if(sq && msg.toLowerCase().indexOf(sq)===-1) return;
  if(c.children.length===0 && c.innerHTML!=="") c.innerHTML="";
  var d=document.createElement("div");
  d.className="log-entry "+lvl;
  var t=""; try{ t=new Date(ts).toLocaleTimeString(); }catch(_){ t=String(ts); }
  d.innerHTML='<span class="ts">'+esc(t)+'</span><span class="lvl">'+esc(String(lvl).toUpperCase())+'</span><span class="msg">'+esc(msg)+'</span>';
  c.appendChild(d);
  if(c.children.length>500 && c.removeChild) c.removeChild(c.firstChild);
  var au=$("logau");
  if(au && au.checked && c.scrollHeight) c.scrollTop=c.scrollHeight;
}

// 筛选/搜索变了就整段重画（环形缓冲里重放一遍）
function renderLogs(){
  var c=$("logc"); if(!c) return;
  c.innerHTML="";
  if(!logRing.length){ c.innerHTML='<div class="panel-empty"><div class="pe-sub">暂无日志 —— 有请求进来后这里会实时滚动。</div></div>'; return; }
  var lf=($("loglv")&&$("loglv").value)||"";
  var sq=($("logsq")&&$("logsq").value||"").toLowerCase();
  var shown=0;
  for(var i=0;i<logRing.length;i++){
    var e=logRing[i];
    var lvl=e.level||"info", msg=String(e.msg==null?JSON.stringify(e):e.msg)+(e.extra?" "+e.extra:""), ts=e.ts||Date.now();
    if(lf && lvl!==lf) continue;
    if(sq && msg.toLowerCase().indexOf(sq)===-1) continue;
    var d=document.createElement("div");
    d.className="log-entry "+lvl;
    var t=""; try{ t=new Date(ts).toLocaleTimeString(); }catch(_){ t=String(ts); }
    d.innerHTML='<span class="ts">'+esc(t)+'</span><span class="lvl">'+esc(String(lvl).toUpperCase())+'</span><span class="msg">'+esc(msg)+'</span>';
    c.appendChild(d);
    shown++;
  }
  if(shown && $("logau") && $("logau").checked && c.scrollHeight) c.scrollTop=c.scrollHeight;
}
function onLogSearch(){
  if(logTimer) clearTimeout(logTimer);
  logTimer=setTimeout(function(){ logTimer=null; renderLogs(); },200);
}
function exportLogs(fmt){
  var lv=($("loglv")&&$("loglv").value)||"";
  fetch("/admin/logs/export?format="+fmt+(lv?"&level="+lv:"")).then(function(r){
    if(!r.ok) throw new Error("HTTP "+r.status);
    return r.text();
  }).then(function(txt){ download("cursorapi-logs-"+today()+"."+fmt, txt); })
   .catch(function(e){ toast("导出失败："+(e.message||e),"bad"); });
}
// 日志级别的自定义下拉：选项带彩色圆点
function logLvOptions(){
  var lv=($("loglv")&&$("loglv").value)||"";
  CS["loglv"]={
    labels:{
      "":"<span class=\\"lvl-dot\\"></span>全部",
      debug:"<span class=\\"lvl-dot dot-info\\"></span>debug",
      info:"<span class=\\"lvl-dot dot-info\\"></span>info",
      warn:"<span class=\\"lvl-dot dot-warn\\"></span>warn",
      error:"<span class=\\"lvl-dot dot-error\\"></span>error",
    },
    cb:"renderLogs",
  };
  CS_IDS.push("loglv");
  var opts='<div class="cs-opt'+(lv===""?" on":"")+'" onclick="csPick(\\'loglv\\',\\'\\',event)"><span class="lvl-dot"></span>全部</div>';
  var labs=[["debug","debug"],["info","info"],["warn","warn"],["error","error"]];
  for(var i=0;i<labs.length;i++){
    var l=labs[i][0];
    opts+='<div class="cs-opt'+(lv===l?" on":"")+'" onclick="csPick(\\'loglv\\',\\''+l+'\\',event)">'
      + '<span class="lvl-dot dot-'+(l==="debug"?"info":l)+'"></span>'+l+'</div>';
  }
  return '<div class="cs" data-cs="1">'
   + '<select id="loglv" class="cs-native" tabindex="-1" aria-hidden="true"></select>'
   + '<button type="button" class="cs-trigger" id="cst-loglv" data-cs="1" onclick="csToggle(\\'loglv\\',event)">'
     + '<span class="cs-label" id="csl-loglv">'+CS["loglv"].labels[lv||""]+'</span>'
     + '<span class="cs-chevron">▾</span></button>'
   + '<div class="cs-menu" id="csm-loglv" data-cs="1" style="display:none">'+opts+'</div></div>';
}
// ── 最近请求：明细表（GET /admin/requests，日志页与日志流之间）──
// 数据源在后端是最近 500 条环形缓冲，这里拉 200 条。失败静默降级，
// 只显示一行占位；SSE 日志帧到达时顺带刷新（3 秒节流，完成时计时）。
function loadRequests(){
  if(reqBusy) return;                       // 任何时刻最多一个 in-flight
  reqBusy=true;
  fetch("/admin/requests?limit=200").then(function(r){
    if(!r.ok) throw new Error("HTTP "+r.status);
    return r.text();
  }).then(function(t){
    var d=null; try{ d=JSON.parse(t); }catch(_){}
    reqData=(d && Array.isArray(d.items)) ? d.items : null;
    reqAt=Date.now();                       // 完成时更新，不是开始时
    reqFailAt=0;
    reqBusy=false;
    renderReqTable();
  }).catch(function(){
    reqAt=Date.now();
    reqFailAt=Date.now();
    reqData=null;
    reqBusy=false;
    renderReqTable();
  });
}
function maybeRefreshRequests(){
  if(reqBusy) return;
  if(Date.now()-reqFailAt<10000) return;    // 失败后退避 10s，不逐帧打
  if(!reqData || Date.now()-reqAt>3000) loadRequests();
}
function reqTime(ts){
  if(ts==null) return "—";
  try{
    if(typeof ts==="number" && ts>1e11) return new Date(ts).toLocaleTimeString();
    var d=new Date(ts);
    if(!isNaN(d.getTime())) return d.toLocaleTimeString();
  }catch(_){}
  var s=String(ts);
  return s.slice(11,19)||s;
}
function reqDetail(it){
  var rows=[
    ["时间",esc(it.ts!=null?it.ts:"—")],
    ["模型",esc(it.model||"—")],
    ["账号 ID",esc(it.accountId||"—")],
    ["账号名",esc(it.accountName||"—")],
    ["结果",it.success?"成功":"失败"],
    ["耗时",it.ms!=null?(it.ms+" ms"):"—"],
  ];
  var tk=it.tokens||{};
  rows.push(["Token 输入",tk.input!=null?String(tk.input):"—"]);
  rows.push(["Token 输出",tk.output!=null?String(tk.output):"—"]);
  rows.push(["Token 缓存读",tk.cacheRead!=null?String(tk.cacheRead):"—"]);
  rows.push(["Token 缓存写",tk.cacheWrite!=null?String(tk.cacheWrite):"—"]);
  if(it.error!=null) rows.push(["错误",esc(String(it.error))]);
  var out='<div class="detail-card">';
  for(var i=0;i<rows.length;i++){
    out+='<div class="kv"><div class="kv-k">'+rows[i][0]+'</div><div class="kv-v">'+(rows[i][1]||"—")+'</div></div>';
  }
  return out+'</div>';
}
// 展开态按 ts+accountId+model 做 key（数组下标会在数据刷新后漂移）
function reqKey(it){ return String(it.ts!=null?it.ts:"")+"|"+(it.accountId!=null?String(it.accountId):"")+"|"+(it.model||""); }
function reqRowHtml(it, i){
  var acct=it.accountName
    || (it.accountId!=null ? String(it.accountId).slice(0,8) : "—");
  var res=it.success
    ? '<span class="badge success">成功</span>'
    : '<span class="badge error" title="'+esc(it.error||"")+'">失败</span>';
  var tk=it.tokens;
  var toks=tk
    ? '<span class="num">'+fmt(tk.input||0)+'</span><span class="dim" title="输入/输出">/</span><span class="num">'+fmt(tk.output||0)+'</span>'
    : '<span class="dim">—</span>';
  var open=reqExp[reqKey(it)]===true;
  return '<tr class="selectable" onclick="reqRow('+i+')">'
   + '<td class="mono dim">'+esc(reqTime(it.ts))+'</td>'
   + '<td class="mono">'+esc(it.model||"—")+'</td>'
   + '<td>'+esc(acct)+'</td>'
   + '<td>'+res+'</td>'
   + '<td class="num">'+(it.ms!=null?it.ms:"—")+'</td>'
   + '<td>'+toks+'</td></tr>'
   + (open ? '<tr class="detail-row"><td colspan="6"><div class="detail-wrap">'+reqDetail(it)+'</div></td></tr>' : "");
}
function reqRow(i){
  var it=reqData?reqData[i]:null;
  if(!it) return;
  var k=reqKey(it);
  if(reqExp[k]) delete reqExp[k]; else reqExp[k]=true;
  renderReqTable();
}
function renderReqTable(){
  var box=$("req-table"); if(!box) return;
  if(reqData===null){
    box.innerHTML=reqAt>0
      ? '<div class="req-msg">请求明细暂不可用</div>'
      : '<div class="req-msg">加载中…</div>';
    return;
  }
  if(!reqData.length){
    box.innerHTML='<div class="req-msg">暂无请求 —— 有请求进来后会在这里显示。</div>';
    return;
  }
  var h='<div class="table-wrap"><table><thead><tr>'
    + '<th>时间</th><th>模型</th><th>账号</th><th>结果</th><th>耗时</th><th>Token</th>'
    + '</tr></thead><tbody>';
  for(var i=0;i<reqData.length;i++) h+=reqRowHtml(reqData[i], i);
  box.innerHTML=h+'</tbody></table></div>';
}
function renderLogsView(){
  $("sub").textContent = "实时日志 · 500 条环形缓冲";
  $("view-logs").innerHTML =
   '<div class="toolbar">'
   + '<div class="field"><label class="field-label">级别</label>'+logLvOptions()+'</div>'
   + '<div class="field grow"><label class="field-label">搜索</label><input id="logsq" class="input" placeholder="过滤消息…" onkeyup="onLogSearch()"></div>'
   + '<div class="field" style="flex-direction:row;align-items:center;gap:10px">'
     + '<label class="checkbox"><input type="checkbox" id="logau" checked><span class="box"></span><span class="field-label">自动滚动</span></label></div>'
   + '<div class="btn-group">'
     + '<button class="btn" onclick="reconnectLogs()">'+ICO.refresh+'重连</button>'
     + '<button class="btn" onclick="exportLogs(\\'jsonl\\')">'+ICO.down+'jsonl</button>'
     + '<button class="btn" onclick="exportLogs(\\'txt\\')">'+ICO.down+'txt</button>'
   + '</div></div>'
   + '<section class="section"><div class="section-header">'
     + '<div><div class="section-title">最近请求</div>'
        + '<div class="section-desc">一个请求一行 · 最近 200 条 · 数据来自 /admin/requests</div></div></div>'
     + '<div class="section-body tight" id="req-table"></div></section>'
   + '<div class="log-meta"><span id="logst">未连接</span><span>最多保留 500 条</span></div>'
   + '<div class="log-container" id="logc"></div>';
  renderLogs();
  maybeRefreshRequests();
}

// ── 模型：按厂商分组（前端静态映射，图标内嵌）─────────
var PROV_RULES=[
  ["claude-","anthropic","Claude"],
  ["gpt-","openai","GPT"],
  ["o1","openai","GPT"],["o3","openai","GPT"],["o4","openai","GPT"],["o5","openai","GPT"],
  ["gemini-","google","Gemini"],
  ["deepseek-","deepseek","DeepSeek"],
  ["grok-","xai","Grok"],
  ["kimi-","moonshot","Kimi"],
  ["glm-","zhipu","GLM"],
  ["qwen-","qwen","Qwen"],
  ["llama-","meta","Llama"],["meta-","meta","Llama"],
  ["mistral-","mistral","Mistral"],["codestral-","mistral","Mistral"],
  ["nova-","aws","Nova"],
  ["copilot","microsoft","Copilot"],
];
function providerOf(id){
  var s=String(id);
  for(var i=0;i<PROV_RULES.length;i++){
    if(s.indexOf(PROV_RULES[i][0])===0) return {slug:PROV_RULES[i][1], label:PROV_RULES[i][2]};
  }
  return {slug:"other", label:"其他"};
}
// slug → 显示名（providerOf 按 id 前缀匹配，不能拿它查 slug）
function provLabel(slug){
  for(var i=0;i<PROV_RULES.length;i++){
    if(PROV_RULES[i][1]===slug) return PROV_RULES[i][2];
  }
  return "其他";
}
function provIcon(slug){
  var p=PROV[slug];
  if(p) return '<span class="prov-icon">'+p+'</span>';
  var ch=(slug==="other")?"?":slug.slice(0,1).toUpperCase();
  return '<span class="prov-let">'+ch+'</span>';
}
async function loadModels(){
  try{ var r = await api("models"); models=r.models; }
  catch(e){ models={error:e.message}; }
  if(view==="models") render();
}
// 参数维度归一：values 可能是字符串数组（旧契约/测试桩）也可能是
// [{value,displayName}]（SDK 原样透传），两种都认
function paramDims(m){
  return (m.parameters||[]).map(function(p){
    var vals=[];
    var vs=p.values||[];
    for(var i=0;i<vs.length;i++){
      var v=vs[i];
      if(v!=null && typeof v==="object") vals.push({value:String(v.value), label:(v.displayName||String(v.value))});
      else vals.push({value:String(v), label:String(v)});
    }
    return {id:p.id, label:(p.displayName||p.id), vals:vals};
  });
}
// 维度默认选中档：fast/thinking 这类计费敏感开关默认落到便宜档
// （对齐后端 applyCheapDefaults 的防烧钱策略），其余取第一档
function defaultDimIdx(d){
  if(d.id==="fast" || d.id==="thinking"){
    for(var i=0;i<d.vals.length;i++){ if(d.vals[i].value==="false") return i; }
  }
  return 0;
}
function modelBadges(m){
  var b="";
  if(m.price!=null) b+='<span class="chip-badge">'+esc(String(m.price))+'</span>';
  else if(m.currentlyFree===true) b+='<span class="chip-badge free">free</span>';
  else if(m.currentlyFree===false) b+='<span class="chip-badge paid">paid</span>';
  return b;
}
function modelCard(m, idx){
  var open=!!modOpen[m.id];
  var dims=paramDims(m);
  var sel=modParams[m.id]||{};
  var segs='';
  for(var i=0;i<dims.length;i++){
    var d=dims[i];
    var cur=sel[d.id];
    segs+='<div class="seg-row"><span class="seg-label">'+esc(d.label)+'</span><span class="seg">';
    for(var j=0;j<d.vals.length;j++){
      var v=d.vals[j];
      var on=(cur!==undefined)?(cur===v.value):(j===defaultDimIdx(d));
      segs+='<button type="button" class="seg-btn'+(on?" on":"")+'"'
        + ' onclick="event.stopPropagation();modParam('+idx+','+i+','+j+')">'+esc(v.label)+'</button>';
    }
    segs+='</span></div>';
  }
  var varsHtml='';
  var vv=(m.variants||[]);
  if(vv.length){
    varsHtml+='<div class="mod-vars">';
    for(var v2=0;v2<vv.length;v2++){
      var vn=vv[v2];
      varsHtml+='<span class="var-chip" title="'+esc(vn.description||"")+'">'
        + esc(vn.displayName||("变体 "+(v2+1)))
        + (vn.isDefault?' <span class="chip-badge">默认</span>':"")
        + '</span>';
    }
    varsHtml+='</div>';
  }
  var detail='';
  if(open){
    var parts=[];
    for(var p2=0;p2<dims.length;p2++){
      var d2=dims[p2];
      if(!d2.vals.length) continue;
      var cur2=(sel[d2.id]!==undefined)?sel[d2.id]:d2.vals[defaultDimIdx(d2)].value;
      parts.push(d2.id+"="+cur2);
    }
    var prev=parts.length
      ? '<div class="mod-prev">请求写法：<code>'+esc(m.id+"["+parts.join(", ")+"]")+'</code></div>'
      : "";
    var aliases=(m.aliases||[]).map(function(a){ return esc(a); }).join("、");
    detail='<div class="mod-detail">'+prev
      + (aliases?'<div class="mod-al">别名：'+aliases+'</div>':"")
      + '<div class="field-hint">'
      + (dims.length
          ? '点选维度值即更新写法；没写到的计费敏感维度（fast / thinking）默认取便宜档。'
          : '该模型没有可调参数维度，请求写法就是裸模型名。')
      + '</div></div>';
  }
  return '<div class="mod'+(open?" open":"")+(m.unreachable===false?" unreachable":"")+'" onclick="modToggle('+idx+')">'
    + '<div class="mod-head"><div class="mod-id">'+esc(m.id)+'</div>'
    + '<div class="mod-badges">'+modelBadges(m)
      + '<span class="mod-chev'+(open?" open":"")+'" id="modch-'+idx+'">▸</span></div>'
    + '</div>'
    + '<div class="mod-collapse'+(open?" open":"")+'" id="modc-'+idx+'"><div class="mod-collapse-inner">'
      + '<div class="mod-name">'+esc(m.displayName||m.name||m.id)+'</div>'
      + (segs?'<div class="mod-pars">'+segs+'</div>':"")
      + varsHtml
      + detail
    + '</div></div></div>';
}
function filterModels(){
  if(!models || !models.length) return [];
  var q=String(modQ||"").toLowerCase().trim();
  return models.filter(function(m){
    // 按原始 id 判厂商：CURSOR_PREFIX 加的前缀会打乱 claude- / gpt- 这类前缀匹配
    if(modProv && providerOf(m.rawId||m.id).slug!==modProv) return false;
    if(q){
      var id=String(m.id||"").toLowerCase();
      var dn=String(m.displayName||m.name||"").toLowerCase();
      if(id.indexOf(q)===-1 && dn.indexOf(q)===-1) return false;
    }
    return true;
  });
}
function modFilter(){
  var qi=$("mod-q"), pi=$("mod-p");
  modQ=qi?qi.value:"";
  modProv=pi?pi.value:"";
  renderModels();
}
// 收缩展开：只改 .mod-collapse 的 grid-template-rows（0fr↔1fr），
// 不整卡重绘 —— CSS transition 负责动画，收起/展开双向都平滑
function modToggle(i){
  var m=modList[i]; if(!m) return;
  modOpen[m.id]=!modOpen[m.id];
  var c=document.getElementById("modc-"+i);
  if(c) c.style.gridTemplateRows = modOpen[m.id] ? "1fr" : "0fr";
  var ch=document.getElementById("modch-"+i);
  if(ch) ch.className="mod-chev"+(modOpen[m.id]?" open":"");
}
function modParam(i, di, vi){
  var m=modList[i]; if(!m) return;
  var dims=paramDims(m); var d=dims[di]; if(!d) return;
  var v=d.vals[vi]; if(!v) return;
  var sel=modParams[m.id]||(modParams[m.id]={});
  sel[d.id]=v.value;
  renderModels();
}
// 厂商筛选的自定义下拉：选项内嵌 12 厂商 SVG 图标
function vendorCsHtml(allSlugs){
  var cur=modProv;
  var labs={ "":"<span class=\\"prov-let\\">*</span>全部厂商" };
  var opts='<div class="cs-opt'+(cur===""?" on":"")+'" onclick="csPick(\\'mod-p\\',\\'\\',event)"><span class="prov-let">*</span>全部厂商</div>';
  for(var i=0;i<allSlugs.length;i++){
    var sl=allSlugs[i];
    labs[sl]=provIcon(sl)+'<span>'+esc(provLabel(sl))+'</span>';
    opts+='<div class="cs-opt'+(cur===sl?" on":"")+'" onclick="csPick(\\'mod-p\\',\\''+sl+'\\',event)">'
      + provIcon(sl)+'<span>'+esc(provLabel(sl))+'</span></div>';
  }
  CS["mod-p"]={labels:labs, cb:"modFilter"};
  CS_IDS.push("mod-p");
  return '<div class="cs" data-cs="1">'
   + '<select id="mod-p" class="cs-native" tabindex="-1" aria-hidden="true"></select>'
   + '<button type="button" class="cs-trigger" id="cst-mod-p" data-cs="1" onclick="csToggle(\\'mod-p\\',event)">'
     + '<span class="cs-label" id="csl-mod-p">'+(labs[cur]||labs[""])+'</span>'
     + '<span class="cs-chevron">▾</span></button>'
   + '<div class="cs-menu" id="csm-mod-p" data-cs="1" style="display:none">'+opts+'</div></div>';
}
function renderModels(){
  $("sub").textContent = models && models.length
    ? models.length+" 个模型 · 搜索 / 参数选择 / 变体" : "从池里任意一个号拉取";
  if(!models){ $("view-models").innerHTML='<div class="panel-empty"><div class="pe-title">正在拉模型目录…</div></div>'; return; }
  if(models.error){ $("view-models").innerHTML='<div class="panel-empty"><div class="pe-title">拉不到模型目录</div><div class="pe-sub">'+esc(models.error)+'</div></div>'; return; }
  // 厂商下拉选项按**全量**目录出（过滤状态下也不能只剩当前厂商一项）
  var allSlugs=[], slugSeen={};
  for(var a=0;a<models.length;a++){
    var sp=providerOf(models[a].rawId||models[a].id);
    if(!slugSeen[sp.slug]){ slugSeen[sp.slug]=true; allSlugs.push(sp.slug); }
  }
  var list=filterModels();
  modList=list;
  var groups={}, order=[];
  for(var i=0;i<list.length;i++){
    var m=list[i];
    var p=providerOf(m.rawId||m.id);
    if(!groups[p.slug]){ groups[p.slug]={label:p.label, items:[]}; order.push(p.slug); }
    groups[p.slug].items.push(m);
  }
  var out='<div class="toolbar">'
   + '<div class="field grow"><label class="field-label">搜索模型</label>'
     + '<input id="mod-q" class="input" placeholder="按 id 或显示名过滤…" value="'+esc(modQ)+'" onkeyup="modFilter()"></div>'
   + '<div class="field"><label class="field-label">厂商</label>'+vendorCsHtml(allSlugs)+'</div></div>';
  if(!list.length){
    $("view-models").innerHTML=out+emptyHtml("没有匹配的模型","换个关键词或厂商试试。");
    return;
  }
  for(var g=0;g<order.length;g++){
    var grp=groups[order[g]];
    var cards='';
    for(var k=0;k<grp.items.length;k++) cards+=modelCard(grp.items[k], list.indexOf(grp.items[k]));
    out+='<div class="provider-group"><div class="provider-label">'
      + provIcon(order[g])+'<span>'+esc(grp.label)+'</span><span class="pg-count">'+grp.items.length+'</span></div>'
      + '<div class="mods">'+cards+'</div></div>';
  }
  $("view-models").innerHTML = out;
}

// ── 统计：KPI + 手写 Canvas 2D + 模型排行 ─────────────
async function loadStats(){
  statsLoaded=true;
  try{ statsData=await api("stats"); }
  catch(e){ statsData={error:e.message}; }
  if(view==="stats") render();
  else if(view==="pool"||view==="accounts") renderPool();
}
function kpi(title,val,sub,kind,tip){
  var hov = (tip!=null)
    ? ' onmouseenter="tipShow('+tip+')" onmousemove="tipMove(event)" onmouseleave="tipHide()"'
    : "";
  return '<div class="card '+kind+'"'+hov+'><div class="card-header"><div class="card-title">'+title+'</div></div>'
    + '<div class="card-value">'+val+'</div><div class="card-sub">'+sub+'</div></div>';
}
function tokBlock(k,v){
  var ti=tipPush(tipRow(k,String(v||0)));
  return '<div class="tok-blk" onmouseenter="tipShow('+ti+')" onmousemove="tipMove(event)" onmouseleave="tipHide()">'
    + '<div class="tok-k">'+k+'</div><div class="tok-v">'+fmt(v||0)+'</div></div>';
}
function modelAvgMs(){
  var ms=(statsData&&statsData.models)||[];
  var sum=0,n=0;
  for(var i=0;i<ms.length;i++){ if(ms[i].avgMs!=null){ sum+=ms[i].avgMs; n++; } }
  return n?sum/n:null;
}
function renderStats(){
  $("sub").textContent = statsData && !statsData.error ? "自服务启动以来的汇总" : "数据来自 GET /admin/stats";
  if(!statsData){ $("view-stats").innerHTML='<div class="panel-empty"><div class="pe-title">正在加载统计…</div></div>'; return; }
  if(statsData.error){ $("view-stats").innerHTML='<div class="panel-empty"><div class="pe-title">统计接口不可用</div><div class="pe-sub">'+esc(statsData.error)+'</div></div>'; return; }
  var t=statsData.totals||{};
  var req=t.requests||0, suc=t.success||0, err=t.errors||0;
  var sr=req>0?(suc/req*100):null;
  var avg=t.avgMs!=null?t.avgMs:modelAvgMs();
  var tok=t.tokens||{};
  // 图例：当前区间（与图表同一窗口）的合计值
  var series=seriesInRange()||[];
  var legReq=seriesSum(series,"requests"), legSuc=seriesSum(series,"success");
  var legSr=legReq>0?(Math.round(legSuc/legReq*1000)/10)+"%":"—";
  TIP=[];
  // 错误卡明细：错误率 + 最近错误最多的 3 个模型
  var eTop=(statsData.models||[]).slice()
    .sort(function(a,b){ return (b.errors||0)-(a.errors||0); })
    .filter(function(m){ return m.errors>0; }).slice(0,3);
  var errRows=tipRow("错误数",err)+tipRow("错误率",req>0?(err/req*100).toFixed(1)+"%":"—");
  if(eTop.length){
    errRows+=tipSep();
    for(var ei=0;ei<eTop.length;ei++) errRows+=tipRow("最近错误 "+(ei+1),eTop[ei].id+"（"+eTop[ei].errors+" 次）");
  }
  // 平均延迟卡明细：模型级均值 + 请求最多的 3 个模型的 avgMs
  var aTop=(statsData.models||[]).slice()
    .sort(function(a,b){ return (b.requests||0)-(a.requests||0); })
    .filter(function(m){ return m.avgMs!=null; }).slice(0,3);
  var avgRows=tipRow("模型级均值",avg!=null?Math.round(avg)+" ms":"—");
  if(aTop.length){
    avgRows+=tipSep();
    for(var ai=0;ai<aTop.length;ai++) avgRows+=tipRow(aTop[ai].id,aTop[ai].avgMs+" ms");
  }
  $("view-stats").innerHTML =
   '<div class="metrics-grid">'
   + kpi("总请求",fmt(req),req+" 次","info",
     tipPush(tipRow("成功",suc)+tipRow("失败",err)+tipRow("成功率",sr==null?"—":sr.toFixed(1)+"%")))
   + kpi("成功率",sr==null?"—":sr.toFixed(1)+"%",suc+" 成功","success",
     tipPush(tipRow("成功",suc)+tipRow("总请求",req)+tipRow("成功率",sr==null?"—":sr.toFixed(1)+"%")))
   + kpi("错误",fmt(err),req>0?(err/req*100).toFixed(1)+"%":"—","warn",tipPush(errRows))
   + kpi("平均延迟",avg!=null?Math.round(avg)+" ms":"—","模型级 avgMs 均值","accent",tipPush(avgRows))
   + '</div>'
   + '<div class="metrics-grid"><div class="card" style="grid-column:1/-1"><div class="card-header"><div class="card-title">Token 用量</div></div>'
     + '<div class="tok-grid">'
       + tokBlock("输入",tok.input)+tokBlock("输出",tok.output)
       + tokBlock("缓存读",tok.cacheRead)+tokBlock("缓存写",tok.cacheWrite)
     + '</div></div></div>'
   + '<div class="chart-grid">'
      + '<div class="card chart-box"><div class="card-header"><div class="card-title">请求数趋势</div><div class="btn-group">'
        + legendHtml(cssVar("--chart-req","#4c9aff"), "请求", fmt(legReq), "lr-req")
        + rangeBtns() + '</div></div><canvas id="sc-req" height="240"></canvas></div>'
      + '<div class="card chart-box"><div class="card-header"><div class="card-title">成功率</div>'
        + legendHtml(cssVar("--chart-succ","#4a9d6a"), "成功率", legSr, "lr-suc")
        + '</div><canvas id="sc-suc" height="240"></canvas></div>'
   + '</div>'
   + '<section class="section"><div class="section-header">'
     + '<div><div class="section-title">模型排行</div><div class="section-desc">按请求数降序 · 悬停看精确数值</div></div></div>'
     + '<div class="section-body">'+rankHtml(statsData.models)+'</div></section>'
   + (statsData.accounts && statsData.accounts.length
     ? '<section class="section"><div class="section-header">'
       + '<div><div class="section-title">账号排行</div><div class="section-desc">按请求数降序 · 悬停看精确数值</div></div></div>'
       + '<div class="section-body">'+rankHtml(statsData.accounts)+'</div></section>'
     : "");
  drawCharts();
}
function rankName(m){
  if(m.name) return m.name;
  if(data && data.accounts && m.id){
    for(var i=0;i<data.accounts.length;i++){
      if(data.accounts[i].id===m.id) return data.accounts[i].name||data.accounts[i].email||m.id;
    }
  }
  return m.id;
}
function rankHtml(list){
  var ms=(list||[]).slice()
    .sort(function(a,b){ return (b.requests||0)-(a.requests||0); }).slice(0,8);
  if(!ms.length) return '<div class="panel-empty"><div class="pe-sub">暂无数据</div></div>';
  var max=ms[0].requests||1;
  var out="";
  for(var i=0;i<ms.length;i++){
    var m=ms[i];
    var pct=Math.round((m.requests||0)/max*100);
    var req=m.requests||0;
    var sr=req?((m.success||0)/req*100):null;
    var nm=rankName(m);
    var rows=tipRow("请求",req)+tipRow("成功",m.success||0)+tipRow("失败",m.errors||0)
      +tipRow("成功率",sr==null?"—":sr.toFixed(1)+"%");
    if(m.avgMs!=null) rows+=tipRow("平均延迟",m.avgMs+" ms");
    var ti=tipPush(rows);
    out+='<div class="rank-row" onmouseenter="tipShow('+ti+')" onmousemove="tipMove(event)" onmouseleave="tipHide()">'
      + '<div class="rank-name" title="'+esc(nm)+'">'+esc(nm)+'</div>'
      + '<div class="rank-bar"><div class="rank-fill" style="width:'+pct+'%"></div></div>'
      + '<div class="rank-num">'+fmt(req)+'</div>'
      + '<div class="rank-sr">'+(sr==null?"—":sr.toFixed(0)+"%")+'</div></div>';
  }
  return out;
}
// 契约里没给时序字段名，几种常见的都认
function seriesData(){
  if(!statsData) return null;
  var keys=["hourlyBuckets","hourly","trend","buckets","history","series","recentRequests"];
  for(var i=0;i<keys.length;i++){
    var v=statsData[keys[i]];
    if(Array.isArray(v)&&v.length) return v;
  }
  return null;
}
// 图表时间范围：6h / 24h / 7d / 30d / 全部（前端截取 hourlyBuckets）
var CHART_RANGE="24h";
var CHART_RANGES=[["6h",6],["24h",24],["7d",168],["30d",720],["all",0]];
function seriesInRange(){
  var s=seriesData();
  if(!s) return null;
  var hours=0;
  for(var i=0;i<CHART_RANGES.length;i++) if(CHART_RANGES[i][0]===CHART_RANGE) hours=CHART_RANGES[i][1];
  if(!hours || s.length<=hours) return s;
  return s.slice(s.length-hours);
}
function chartRange(r){
  CHART_RANGE=r;
  drawCharts();
  // 高亮当前按钮
  var box=$("view-stats");
  if(box){
    for(var i=0;i<CHART_RANGES.length;i++){
      var b=$("cr-"+CHART_RANGES[i][0]);
      if(b) b.className="btn"+(CHART_RANGES[i][0]===r?" on":"");
    }
  }
}
function rangeBtns(){
  var h="";
  for(var i=0;i<CHART_RANGES.length;i++){
    var r=CHART_RANGES[i][0];
    h+='<button class="btn'+(CHART_RANGE===r?" on":"")+'" id="cr-'+r+'" onclick="chartRange(\\''+r+'\\')">'+r+'</button>';
  }
  return h;
}
function drawCharts(){
  var s=seriesInRange();
  drawLine("sc-req", s, "req");
  drawLine("sc-suc", s, "suc");
  updateLegend(s);
}
// 图例合计值与图表同一窗口（共用 seriesInRange 的结果）：
// 初始渲染由 renderStats 内嵌，区间切换后由这里同步重算
function updateLegend(s){
  var e1=$("lr-req"), e2=$("lr-suc");
  if(!e1 && !e2) return;
  if(!s){ if(e1) e1.textContent="—"; if(e2) e2.textContent="—"; return; }
  var rq=seriesSum(s,"requests"), su=seriesSum(s,"success");
  if(e1) e1.textContent=fmt(rq);
  if(e2) e2.textContent=rq>0?(Math.round(su/rq*1000)/10)+"%":"—";
}
function cssVar(name, fb){
  try{
    if(typeof getComputedStyle==="undefined" || !document.documentElement) return fb;
    var cs=getComputedStyle(document.documentElement);
    if(cs && cs.getPropertyValue){ var v=cs.getPropertyValue(name).trim(); if(v) return v; }
  }catch(_){}
  return fb;
}
function hexA(color, a){
  var m=/^#([0-9a-f]{6})$/i.exec(color);
  if(m){
    var n=parseInt(m[1],16);
    return "rgba("+((n>>16)&255)+","+((n>>8)&255)+","+(n&255)+","+a+")";
  }
  return color;
}
function fmtNum(n){
  if(Math.abs(n)>=1000) return fmt(n);
  if(Math.abs(n)>=100) return String(Math.round(n));
  return String(Math.round(n*10)/10);
}
// 统计图例：色点 + 名称 + 当前区间合计值（与 drawLine 的取色一致）。
// id 让 drawCharts 在区间切换后能直接改 .cl-val 的文本（chartRange 重画同步）。
function legendHtml(color, label, val, id){
  return '<span class="chart-legend"><span class="cl-dot" style="background:'+color+'"></span>'
    + esc(label)+'<span class="cl-val"'+(id?' id="'+id+'"':"")+'>'+esc(val)+'</span></span>';
}
function seriesSum(buckets, key){
  var n=0;
  for(var i=0;i<buckets.length;i++) n+=(buckets[i][key]||0);
  return n;
}
// Y 轴顶值取整到 1/2/5×10^n，保证刻度是整数
function niceMax(v){
  if(!(v>0)) return 1;
  var p=Math.pow(10,Math.floor(Math.log(v)/Math.LN10));
  var m=v/p;
  if(m<=1) return p;
  if(m<=2) return 2*p;
  if(m<=5) return 5*p;
  return 10*p;
}
function pad2(n){ return (n<10?"0":"")+n; }
// 折线 + 渐变填充 + 网格 + DPR 适配，颜色从 CSS 变量取（主题切换后重画）
function drawLine(id, buckets, mode){
  var cv=$(id);
  if(!cv || !cv.getContext) return;
  var ctx=null; try{ ctx=cv.getContext("2d"); }catch(_){}
  if(!ctx) return;
  if(!buckets){
    var W0=cv.clientWidth||cv.width||640, H0=cv.clientHeight||cv.height||240;
    var d0=1;
    if(typeof window!=="undefined" && window.devicePixelRatio) d0=window.devicePixelRatio||1;
    cv.width=Math.round(W0*d0); cv.height=Math.round(H0*d0);
    ctx.setTransform(d0,0,0,d0,0,0);
    ctx.clearRect(0,0,W0,H0);
    ctx.fillStyle=cssVar("--text-dim","#a1a1aa");
    ctx.font="12px sans-serif"; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("无时序数据（后端未提供趋势）",W0/2,H0/2);
    return;
  }
  var W=cv.clientWidth||cv.width||640, H=cv.clientHeight||cv.height||240;
  var dpr=1;
  if(typeof window!=="undefined" && window.devicePixelRatio) dpr=window.devicePixelRatio||1;
  cv.width=Math.round(W*dpr); cv.height=Math.round(H*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  var pad={t:16,r:14,b:26,l:42};
  var cw=W-pad.l-pad.r, ch=H-pad.t-pad.b;
  var col=cssVar(mode==="suc"?"--chart-succ":"--chart-req", mode==="suc"?"#4a9d6a":"#4c9aff");
  var gridC=cssVar("--grid","rgba(128,128,128,.15)");
  var dim=cssVar("--text-dim","#a1a1aa");
  ctx.clearRect(0,0,W,H);
  ctx.lineWidth=1; ctx.strokeStyle=gridC;
  ctx.font="11px monospace"; ctx.fillStyle=dim;
  var vals=[];
  for(var i=0;i<buckets.length;i++){
    var b=buckets[i];
    vals.push(mode==="suc"
      ? (b.requests?((b.success||0)/b.requests*100):0)
      : (b.requests||0));
  }
  var maxV=Math.max.apply(null,vals), minV=Math.min.apply(null,vals);
  if(mode==="suc"){ minV=0; maxV=100; }            // 成功率固定 0-100
  else { minV=0; maxV=niceMax(maxV); }             // 请求数从 0 起，顶值 nice 取整
  if(!(maxV>minV)) maxV=minV+1;
  // 刻度：尽量 5 条；maxV 不能被 4 整除（如 50）时退到 0/½/1 三条，刻度保持整数
  var gridN=4;
  var tick=[];
  for(var g=0;g<=gridN;g++) tick.push(minV+(maxV-minV)*g/gridN);
  var frac=false;
  for(var g2=0;g2<tick.length;g2++) if(Math.abs(tick[g2]-Math.round(tick[g2]))>1e-6) frac=true;
  if(frac && gridN>2){
    gridN=2;
    tick=[];
    for(var g3=0;g3<=gridN;g3++) tick.push(minV+(maxV-minV)*g3/gridN);
  }
  for(var g=0;g<=gridN;g++){
    var gy=pad.t+ch-(g/gridN)*ch;
    ctx.beginPath(); ctx.moveTo(pad.l,gy); ctx.lineTo(pad.l+cw,gy); ctx.stroke();
    ctx.fillText(fmtNum(tick[g]),6,gy+4);
  }
  // X 轴时间标签：最多 6 个；跨度 ≥48h 显示 M/D，否则 HH:00
  var spanH=buckets.length;
  var stepX=Math.max(1,Math.ceil((spanH-1)/5));
  var xTxt=function(b){
    var tv=b.t!=null?b.t:(b.ts!=null?b.ts:(b.hour!=null?b.hour:""));
    try{
      if(typeof tv==="number" && tv>1e11){
        var dt=new Date(tv);
        if(spanH>=48) return (dt.getMonth()+1)+"/"+dt.getDate();
        return pad2(dt.getHours())+":00";
      }
      var s=String(tv);
      if(spanH>=48) return s.slice(5,10).replace("-","/")||s.slice(0,10);
      return s.slice(11,16)||s.slice(0,5)||s;
    }catch(_){ return String(tv); }
  };
  for(var xi=0;xi<spanH;xi+=stepX){
    var lx=pad.l+(spanH>1?xi/(spanH-1)*cw:cw/2);
    ctx.fillText(xTxt(buckets[xi]),lx-14,H-10);
  }
  var lastIdx=spanH-1;
  if(spanH>1 && lastIdx%stepX!==0){
    ctx.fillText(xTxt(buckets[lastIdx]),pad.l+cw-14,H-10);
  }
  var step=buckets.length>1?cw/(buckets.length-1):0;
  var px=function(j){ return pad.l+step*j; };
  var py=function(j){ return pad.t+ch-((vals[j]-minV)/(maxV-minV))*ch; };
  ctx.beginPath();
  for(var j=0;j<vals.length;j++){ if(j===0) ctx.moveTo(px(j),py(j)); else ctx.lineTo(px(j),py(j)); }
  ctx.strokeStyle=col; ctx.lineWidth=2; ctx.stroke();
  var gr=ctx.createLinearGradient(0,pad.t,0,pad.t+ch);
  gr.addColorStop(0,hexA(col,.22)); gr.addColorStop(1,hexA(col,0));
  ctx.beginPath();
  for(var k=0;k<vals.length;k++){ if(k===0) ctx.moveTo(px(k),py(k)); else ctx.lineTo(px(k),py(k)); }
  ctx.lineTo(pad.l+cw,pad.t+ch); ctx.lineTo(pad.l,pad.t+ch); ctx.closePath();
  ctx.fillStyle=gr; ctx.fill();

  // hover tooltip：吸附最近数据点显示明细（沙箱无 addEventListener，用属性绑定）
  var xStep=cw/(buckets.length>1?(buckets.length-1):1);
  cv.onmousemove=function(ev){
    try{
      var tip=$("chart-tip");
      if(!tip) return;
      var r=cv.getBoundingClientRect?cv.getBoundingClientRect():{left:0,top:0};
      var mx=(ev.clientX!=null?ev.clientX:(ev.offsetX||0))-(r.left||0);
      var my=(ev.clientY!=null?ev.clientY:(ev.offsetY||0))-(r.top||0);
      if(mx<pad.l||mx>pad.l+cw||my<pad.t||my>pad.t+ch){ tip.style.display="none"; return; }
      var idx2=Math.round((mx-pad.l)/xStep);
      if(idx2<0) idx2=0; if(idx2>=buckets.length) idx2=buckets.length-1;
      var b=buckets[idx2];
      var tv=b.t!=null?b.t:(b.ts!=null?b.ts:"");
      var lbl="";
      if(typeof tv==="number" && tv>1e12){ try{ lbl=new Date(tv).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}); }catch(_){ lbl=String(tv); } }
      else if(typeof tv==="string"){ lbl=tv.replace("T"," ").slice(0,16); }
      var detail=(mode==="suc")
        ? "成功 "+fmt(b.success||0)+" / 失败 "+fmt(b.errors||0)+" / 请求 "+fmt(b.requests||0)
        : "请求 "+fmt(b.requests||0)+" · 成功 "+fmt(b.success||0)+" · 失败 "+fmt(b.errors||0)
          + " · 成功率 "+(b.requests?(Math.round((b.success||0)/b.requests*1000)/10+"%"):"—");
      tip.innerHTML="<b>"+esc(lbl)+"</b><br>"+esc(detail);
      tip.style.display="block";
      tip.style.left=Math.round(mx+8)+"px";
      tip.style.top=Math.round(my-10)+"px";
    }catch(_){}
  };
  cv.onmouseleave=function(){ var tip=$("chart-tip"); if(tip) tip.style.display="none"; };
}

// ── 设置：凭证热更 + 配置 + 更新 ───────────────────────
var CFG_FIELDS=[
  {k:"port",l:"端口",t:"number",r:true},
  {k:"host",l:"监听地址",t:"text",r:true},
  {k:"accountsPath",l:"号池文件",t:"text",r:true},
  {k:"workspace",l:"工作目录",t:"text",r:true},
  {k:"maxAccountAttempts",l:"换号上限",t:"number",h:"一次请求最多换几个号"},
  {k:"probeIntervalMs",l:"探活周期",t:"number",h:"毫秒；0 = 关闭自动探活"},
  {k:"showToolActivity",l:"流出工具动作",t:"checkbox"},
  {k:"turnIdleTimeoutMs",l:"回合空闲超时",t:"number",h:"毫秒；一轮多久没动静算超时"},
  {k:"toolResultTimeoutMs",l:"工具结果超时",t:"number",h:"毫秒"},
  {k:"logLevel",l:"日志级别",t:"select",o:["debug","info","warn","error"]},
  {k:"prefix",l:"模型名前缀",h:"对外暴露的模型名前缀，留空不加"},
  {k:"proxy",l:"上游代理",h:"留空 = 直连；配了走 CONNECT 隧道（重启生效）"},
];
// 分组展示：keys 的顺序就是组内顺序；组里某字段后端没给就跳过。
// clientKeys / adminKey 不进这里 —— 由「凭证管理」区单独管（windsurf credentials 形态）。
var CFG_GROUPS=[
  {g:"监听",desc:"服务监听与网络出口",keys:["host","port","proxy","workspace"]},
  {g:"号池",desc:"账号池文件与探活",keys:["accountsPath","probeIntervalMs","maxAccountAttempts"]},
  {g:"行为",desc:"模型名前缀 / 工具动作 / 超时 / 日志",keys:["prefix","showToolActivity","turnIdleTimeoutMs","toolResultTimeoutMs","logLevel"]},
];
// 后端对 secret 字段掩码显示（"…" / "***"）。掩码值绝不能原样发回 PUT，
// 否则真 key 会被掩码串覆盖 —— 发送前凡「掩码原值没动过」的一律跳过。
function isMasked(v){
  var s=String(v==null?"":v);
  return s.indexOf("…")!==-1 || /^\\*+$/.test(s);
}
async function loadSettings(){
  cfgLoaded=true;
  try{
    var r=await api("config");
    cfg=(r&&r.config)?r.config:r;
    cfgRestart=new Set((r&&(r.restartOnly||r.restartFields))||[]);
    cfgOverrides=(r&&r.overrides)||{};
    cfgEff=(r&&r.effective)||[];
    cfgMasked={};
    renderCfg();
  }catch(e){ cfg={error:e.message}; renderCfg(); }
  // 展示信息条的号池健康：单独拉一次快照（全局 data 只在概览/账号页自动刷新）
  try{ poolInfo=await api("status"); }catch(_){ poolInfo=data||null; }
  renderCfgInfo();
}
function renderSettings(){
  $("sub").textContent = "运行时配置热更新 · 应用更新";
  $("view-settings").innerHTML =
   '<div class="tabs"><button class="tab-btn on" id="tb-cfg" onclick="setTab(\\'cfg\\')">配置</button>'
   + '<button class="tab-btn" id="tb-upd" onclick="setTab(\\'upd\\')">更新</button></div>'
   + '<div id="cfg-view"></div>'
   + '<div id="upd-view" style="display:none"></div>';
  renderCfg();
}
function setTab(t){
  var c=$("cfg-view"), u=$("upd-view"), b1=$("tb-cfg"), b2=$("tb-upd");
  if(c) c.style.display=t==="cfg"?"block":"none";
  if(u) u.style.display=t==="upd"?"block":"none";
  if(b1) b1.className="tab-btn"+(t==="cfg"?" on":"");
  if(b2) b2.className="tab-btn"+(t==="upd"?" on":"");
  if(t==="upd" && !updLoaded){ updLoaded=true; checkUpdate(); }
}
// ── 凭证管理（windsurf credentials 区）：掩码展示 + 留空 = 不修改 ──
// 保存走 PUT /admin/config 单字段热更（clientKeys / adminKey 都是 hot 字段，
// 后端注册表里写了 hot:true，存盘后立即写回运行中的 config 对象）。
function credRow(kind, label, envName, cur, hint){
  return '<div class="cred-row">'
   + '<div class="cred-head"><strong>'+label+'</strong>'
     + '<span class="dim" style="font-size:12px">'+esc(envName)+'</span>'
     + '<span class="cur" id="cred-'+kind+'-mask">'+esc(cur||"未设置")+'</span></div>'
   + '<div class="cred-actions">'
     + '<input type="password" class="input" id="cred-'+kind+'-input" autocomplete="new-password"'
       + ' spellcheck="false" placeholder="新值（留空 = 不修改）">'
     + '<button class="btn" id="cred-'+kind+'-vis" onclick="toggleCredVis(\\''+kind+'\\')">显示</button>'
     + '<button class="btn btn-primary" onclick="saveCredential(\\''+kind+'\\')">保存</button>'
   + '</div>'
   + '<div class="field-hint">'+hint+'</div></div>';
}
function renderCfg(){
  var box=$("cfg-view"); if(!box) return;
  if(!cfg){ box.innerHTML='<div class="panel-empty"><div class="pe-title">加载中…</div></div>'; return; }
  if(cfg.error){ box.innerHTML='<div class="panel-empty"><div class="pe-title">配置接口不可用</div><div class="pe-sub">'+esc(cfg.error)+'</div></div>'; return; }
  cfgRendered=[];
  var groups='';
  for(var g=0;g<CFG_GROUPS.length;g++){
    var grp=CFG_GROUPS[g];
    var fields='';
    var any=false;
    for(var i=0;i<grp.keys.length;i++){
      var k=grp.keys[i];
      var f=null;
      for(var j=0;j<CFG_FIELDS.length;j++) if(CFG_FIELDS[j].k===k) f=CFG_FIELDS[j];
      if(!f || cfg[k]===undefined) continue;
      any=true;
      cfgRendered.push(k);
      var restart=(f.r||cfgRestart.has(k));
      var pending=cfgOverrides[k]!==undefined;
      var orig=Array.isArray(cfg[k])?cfg[k].join(", "):cfg[k];
      var masked=isMasked(orig);
      cfgMasked[k]=masked;
      var inp;
      if(f.t==="checkbox"){
        inp='<input id="cf-'+k+'" type="checkbox"'+(cfg[k]?" checked":"")+'>';
      }else if(f.t==="select"){
        inp='<select id="cf-'+k+'" class="select">';
        for(var o=0;o<f.o.length;o++){ inp+='<option'+(String(cfg[k])===f.o[o]?" selected":"")+'>'+f.o[o]+'</option>'; }
        inp+='</select>';
      }else if(f.t==="textarea"){
        inp='<textarea id="cf-'+k+'" class="textarea" spellcheck="false" placeholder="'+(masked?"已设置（掩码显示），留空 = 不修改":"")+'">'+(masked?"":esc(orig))+'</textarea>';
      }else{
        var ty=f.t||"text";
        inp='<input id="cf-'+k+'" class="input'+(ty==="number"?" mono":"")+'" type="'+ty+'"'
          + ' value="'+(masked?"":esc(orig))+'" placeholder="'+(masked?"已设置（掩码显示），留空 = 不修改":"")+'">';
      }
      var hint=f.h||"";
      if(restart) hint+=(hint?"；":"")+"改完需<b>重启服务</b>";
      if(pending) hint+=(hint?"；":"")+"磁盘已存新值，重启后生效";
      // 来源徽章：runtime = 有热覆盖（可清除）；env = 环境变量；default = 默认值
      var src="default";
      for(var e2=0;e2<cfgEff.length;e2++) if(cfgEff[e2].key===k) src=cfgEff[e2].source;
      var srcBadge=src==="runtime"
        ? ' <span class="badge" style="background:var(--accent)">runtime</span>'
        : (src==="env" ? ' <span class="badge info">env</span>' : ' <span class="badge" style="background:var(--border);color:var(--text-dim)">default</span>');
      var clr=src==="runtime"
        ? ' <button class="btn btn-ghost" style="font-size:11px;padding:2px 8px" onclick="clearOverride(\\''+k+'\\')">清除覆盖</button>'
        : "";
      fields+='<div class="field"><label class="field-label">'+esc(f.l)
        +srcBadge
        +(restart?' <span class="badge warn">需重启生效</span>':"")
        +(pending?' <span class="badge info">待重启</span>':"")
        +'</label>'+inp+(hint?'<div class="field-hint">'+hint+'</div>':"")+clr+'</div>';
    }
    if(!any) continue;
    groups+='<div class="cfg-group"><div class="cfg-group-title">'+esc(grp.g)
      +'<span class="cfg-group-desc">'+esc(grp.desc||"")+'</span></div>'
      + '<div class="cfg-grid">'+fields+'</div></div>';
  }
  // 凭证区：掩码展示防误覆盖；留空 = 不修改
  var cred='<div class="section"><div class="section-header">'
   + '<div><div class="section-title">凭证管理</div>'
     + '<div class="section-desc">运行时改调用方 API Key 和面板登录密码，保存后立即生效，不用重启。</div></div></div>'
   + '<div class="section-body" style="display:grid;gap:14px">'
     + credRow("apikey","调用方 API Key","CURSOR_CLIENT_KEYS",cfg.clientKeys,
       "改完所有调用方要换成新 Key；旧 Key 立即失效。")
     + credRow("adminpw","面板登录密码","CURSOR_ADMIN_KEY",cfg.adminKey,
       "留空 = 不修改；改完当前会话需要重新登录。")
   + '</div></div>';
  box.innerHTML='<div id="cfg-info"></div>'
   + cred
   + '<div class="section"><div class="section-header">'
     + '<div><div class="section-title">运行时配置</div>'
       + '<div class="section-desc">热字段即时生效；标「需重启生效」的要重启服务</div></div></div>'
   + '<div class="section-body">'+groups
     + '<div class="cfg-hint" id="cfhint" style="display:none"></div></div>'
   + '<div class="section-footer"><button class="btn btn-primary" onclick="saveCfg()">保存配置</button></div></div>';
  renderCfgInfo();
}
// 清除某字段的 runtime 覆盖（PUT {key: null}），回落到 env/default。
function clearOverride(k){
  act(function(){ return api("config", j((function(){ var o={}; o[k]=null; return o; })()), {method:"PUT"}); },
    function(r){ return "已清除 "+k+" 的覆盖"; }).then(function(){
      cfgLoaded=false;
      loadSettings();
    });
}
function toggleCredVis(kind){
  var inp=$("cred-"+kind+"-input");
  var b=$("cred-"+kind+"-vis");
  if(!inp) return;
  if(inp.type==="password"){ inp.type="text"; if(b) b.textContent="隐藏"; }
  else { inp.type="password"; if(b) b.textContent="显示"; }
}
function saveCredential(kind){
  var key = kind==="apikey" ? "clientKeys" : "adminKey";
  var inp=$("cred-"+kind+"-input");
  var v=(inp&&inp.value||"").trim();
  if(!v){ toast("留空 = 不修改，什么都没改","info"); return; }
  var body={}; body[key]=v;
  api("config",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)})
   .then(function(){
     toast(key==="clientKeys" ? "API Key 已热更，旧 Key 立即失效" : "面板密码已热更，重新登录生效","ok");
     loadSettings();
   })
   .catch(function(e){ toast(e.message,"bad"); });
}
function uptimeText(ms){
  ms=Math.max(0,ms||0);
  var s=Math.floor(ms/1000), d=Math.floor(s/86400), h=Math.floor(s%86400/3600), m=Math.floor(s%3600/60);
  if(d>0) return d+" 天 "+h+" 小时";
  if(h>0) return h+" 小时 "+m+" 分";
  if(m>0) return m+" 分 "+Math.floor(s%60)+" 秒";
  return Math.floor(s)+" 秒";
}
// 展示类信息条（Kiro Studio 风格）：运行时长 / 版本 / 代理状态 / 号池健康
function renderCfgInfo(){
  var box=$("cfg-info"); if(!box) return;
  var up="—";
  if(poolInfo && poolInfo.startedAt) up=uptimeText(Date.now()-poolInfo.startedAt);
  var ver=upd&&upd.current?upd.current:"—";
  var vermode=upd&&upd.mode?("部署模式 "+esc(upd.mode)):"检查中…";
  var proxy=cfg&&cfg.proxy;
  var cool=0;
  if(poolInfo && poolInfo.accounts){
    var now=Date.now();
    for(var i=0;i<poolInfo.accounts.length;i++){
      var cu=poolInfo.accounts[i].cooldownUntil;
      if(cu && new Date(cu).getTime()>now) cool++;
    }
  }
  var ph=(poolInfo && poolInfo.available!=null)
    ? (poolInfo.available+"/"+poolInfo.total+" 可用"+(cool?" · "+cool+" 冷却中":""))
    : "—";
  box.innerHTML='<div class="metrics-grid">'
   + kpi("运行时长",up,"自上次启动","info")
   + kpi("当前版本",esc(ver),vermode,"accent")
   + kpi("代理",proxy?"已配置":"未配置",proxy?esc(proxy):"直连",proxy?"success":"warn")
   + kpi("号池",ph,"可用 / 总数 / 冷却中","success")
   + '</div>';
}
async function saveCfg(){
  var body={};
  for(var i=0;i<cfgRendered.length;i++){
    var k=cfgRendered[i];
    var el=$("cf-"+k);
    if(!el) continue;
    var f=null;
    for(var j=0;j<CFG_FIELDS.length;j++) if(CFG_FIELDS[j].k===k) f=CFG_FIELDS[j];
    if(f && f.t==="checkbox"){ body[k]=!!el.checked; }
    else if(f && f.t==="number"){
      // 数字框清空 = 不修改（跟掩码字段一个语义），别把 0 发出去 ——
      // 后端 int 有 min 校验，一个 0 会整包 400 掉
      if(el.value==="") continue;
      var n=Number(el.value); body[k]=Number.isFinite(n)?n:el.value;
    }
    else if(f && f.t==="select"){
      // 原生 select 的值永远非空；沙箱里 value 是空串时跳过，别发空日志级别
      if(el.value==="") continue;
      body[k]=el.value;
    }
    else {
      // 掩码原值没动过（留空）就不发 —— 防止把掩码串写回覆盖真 key
      if(cfgMasked[k] && !el.value) continue;
      body[k]=el.value;
    }
  }
  if(!Object.keys(body).length){ toast("没有可保存的改动","info"); return; }
  try{
    var r=await api("config",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    toast("配置已保存","ok");
    var rf=(r&&(r.restartFields||r.restartOnly))||[];
    var hint=$("cfhint");
    if(hint){
      if(rf.length){ hint.innerHTML="以下字段需<b>重启服务</b>才能生效："+esc(rf.join("、"))+"。热字段已即时生效。"; hint.style.display="block"; }
      else { hint.innerHTML=""; hint.style.display="none"; }
    }
    loadSettings();
  }catch(e){ toast(e.message,"bad"); }
}
// ── 更新页签 ──────────────────────────────────────────
function updErrText(status,msg){
  if(status===409) return "另一个更新正在进行，请稍候重试";
  if(status===502){
    if(/sha256|校验|checksum|does not match requested tag/i.test(msg||""))
      return "下载包校验失败（哈希不匹配），已拒绝替换——可能镜像被劫持";
    return "更新源不可达（直连 GitHub 也失败）";
  }
  return msg||("HTTP "+status);
}
async function checkUpdate(){
  try{
    var r=await api("update/check");
    upd=r;
    // perform 失败后的回滚判定：版本没动 = 已回滚/未生效（check 有 60s TTL 缓存，措辞留「如已重启」的假设）
    if(updErr && updPrevVer!=null){
      if(String(r.current)===String(updPrevVer)) updErr={rollback:true};
      else updPrevVer=null;
    }
    renderUpd();
  }catch(e){ upd={error:e.message}; renderUpd(); }
}
function renderUpd(){
  var box=$("upd-view"); if(!box) return;
  if(!upd){ box.innerHTML='<div class="panel-empty"><div class="pe-title">正在检查…</div></div>'; return; }
  if(upd.error){ box.innerHTML='<div class="panel-empty"><div class="pe-title">更新接口不可用</div><div class="pe-sub">'+esc(upd.error)+'</div></div>'; return; }
  var cur=upd.current||"—", latest=upd.latest||"—", behind=upd.behind||0;
  var has=upd.hasUpdate;
  var errBar="";
  if(updErr){
    var et=updErr.rollback
      ? "更新失败，版本未变——如服务已重启且版本未变，说明已自动回滚（坏版留证 cursorapi.failed.*）"
      : updErr.msg;
    errBar='<div class="field-hint" id="upd-error"><span class="badge error">更新失败</span> '+esc(et)+'</div>';
  }
  box.innerHTML=
   '<div class="metrics-grid">'
   + kpi("当前版本",esc(cur),"运行中","info")
   + kpi("最新版本",esc(latest),has?("落后 "+behind+" 个版本"):"无需更新","accent")
   + '</div>'
   + '<div class="note">部署模式：'+esc(upd.mode||"未知")
     + '。执行更新会<b>重启服务</b>，正在进行的请求会被打断。</div>'
   + '<div class="btn-group" style="margin-top:14px">'
     + '<button class="btn" onclick="checkUpdate()">'+ICO.refresh+'检查更新</button>'
     + '<button class="btn btn-primary" id="updgo" onclick="doUpdate()">'+ICO.up+'执行更新</button>'
     + '<button class="btn" onclick="statusNow()">更新状态</button>'
   + '</div>'
   + errBar
   + '<div class="log-meta" id="updst" style="margin-top:12px"></div>';
}
async function doUpdate(){
  if(!upd || !upd.hasUpdate){ toast("当前已是最新，无需更新","info"); return; }
  askConfirm("确认执行更新？服务会重启，正在进行的请求会被打断。", function(){ doUpdateNow(); });
}
async function doUpdateNow(){
  updErr=null; updPrevVer=(upd&&upd.current)||null;
  var btn=$("updgo"), st=$("updst"), redrawn=false;
  if(btn){ btn.disabled=true; btn.innerHTML='<span class="spinner"></span>更新执行中…'; }
  if(st){ st.innerHTML='<span class="spinner"></span>正在触发更新…'; }
  try{
    await api("update/perform",{method:"POST"});
    toast("更新任务已触发","ok");
  }catch(e){
    var msg=updErrText(e.status,e.message);
    updErr={msg:msg};
    toast(msg,"bad");
    renderUpd(); // 错误条要落在重绘后的 DOM 里，按钮/状态条随重绘复位
    redrawn=true;
  }finally{
    if(!redrawn){
      if(btn){ btn.disabled=false; btn.innerHTML=ICO.up+"执行更新"; }
      if(st){ st.innerHTML=""; }
    }
  }
  setTimeout(function(){ checkUpdate(); }, 1500);
}
async function statusNow(){
  try{
    var r=await api("update/status");
    var s=$("updst");
    if(!s) return;
    var parts=[];
    if(r && r.state) parts.push("状态："+esc(r.state));
    if(r && r.healthConfirmed!=null) parts.push("健康标记："+(r.healthConfirmed?"已确认":"未确认"));
    if(r && r.rollbackPointPresent!=null) parts.push("回滚点："+(r.rollbackPointPresent?"存在":"无"));
    if(r && r.rolledBackBinaryPresent!=null) parts.push("回滚留证："+(r.rolledBackBinaryPresent?"有":"无"));
    if(r && r.healthDetail) parts.push(esc(r.healthDetail));
    if(r && r.message) parts.push(esc(r.message));
    s.innerHTML=parts.join(" · ")||"—";
  }catch(e){ toast(e.message,"bad"); }
}

// ── 接入 ──────────────────────────────────────────────
// 双协议接入信息：Anthropic /v1/messages + OpenAI /v1/chat/completions。
// 模板：协议卡片（Base URL / 认证 / 最小示例 / 生态接入）→ 模型参数 → 计费说明。
// 转义纪律：JS 字符串一律用单引号；HTML 属性用双引号；curl -d 的 JSON 不带
// shell 引号（JSON 无空格，直接写即可）；字符串内换行用反斜杠加字母 n。
function renderConn(){
  $("sub").textContent="双协议接入：Anthropic /v1 与 OpenAI /v1";
  var base = location.origin;
  // 可复制文本集中放 COPY_TEXTS，按钮只带下标（避免把引号/换行塞进 onclick）
  var cop=[];
  var pushCopy=function(t){ cop.push(t); return cop.length-1; };
  var curlA='curl '+base+'/v1/messages\\n'
    +'  -H "x-api-key: $CURSOR_CLIENT_KEY"\\n'
    +'  -H "content-type: application/json"\\n'
    +'  -d {"model":"claude-opus-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}';
  var curlO='curl '+base+'/v1/chat/completions\\n'
    +'  -H "Authorization: Bearer $CURSOR_CLIENT_KEY"\\n'
    +'  -H "content-type: application/json"\\n'
    +'  -d {"model":"claude-opus-5","messages":[{"role":"user","content":"hi"}]}';
  var envCC='ANTHROPIC_BASE_URL='+base+'/v1 ANTHROPIC_AUTH_TOKEN=$CURSOR_CLIENT_KEY';
  var iBA=pushCopy(base+"/v1");
  var iCA=pushCopy(curlA);
  var iBO=pushCopy(base+"/v1");
  var iCO=pushCopy(curlO);
  var iEC=pushCopy(envCC);
  COPY_TEXTS=cop;
  $("view-conn").innerHTML=\'<div class="doc">\'
   + \'<div class="conn-grid">\'
   + \'<div class="card"><div class="card-header"><div class="card-title">Anthropic 协议（/v1/messages）</div><span class="btn-group"><span class="badge success">Claude Code / Anthropic SDK</span>\'+copyBtn(iCA)+\'</span></div><div class="card-body">\'
   + \'<div class="conn-row"><span class="conn-k">Base URL</span><code>\'+esc(base)+\'/v1</code>\'+copyBtn(iBA)+\'</div>\'
   + \'<div class="conn-row"><span class="conn-k">认证</span><code>x-api-key: &lt;CURSOR_CLIENT_KEYS 任一把&gt;</code></div>\'
   + \'<pre><span class="c"># curl 最小示例</span>\\n\'
   + \'curl \'+esc(base)+\'/v1/messages\\n\'
   + \'  -H "x-api-key: $CURSOR_CLIENT_KEY"\\n\'
   + \'  -H "content-type: application/json"\\n\'
   + \'  -d {"model":"claude-opus-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}</pre>\'
   + \'<div class="conn-row"><span class="conn-k">Claude Code</span><code>ANTHROPIC_BASE_URL=\'+esc(base)+\'/v1 &nbsp; ANTHROPIC_AUTH_TOKEN=$CURSOR_CLIENT_KEY</code>\'+copyBtn(iEC)+\'</div>\'
   + \'<div class="field-hint">流式：Anthropic 事件序列（message_start → ping → content_block_* → message_delta → message_stop）。</div>\'
   + \'</div></div>\'
   + \'<div class="card"><div class="card-header"><div class="card-title">OpenAI 协议（/v1/chat/completions）</div><span class="btn-group"><span class="badge success">OpenAI SDK / opencode</span>\'+copyBtn(iCO)+\'</span></div><div class="card-body">\'
   + \'<div class="conn-row"><span class="conn-k">Base URL</span><code>\'+esc(base)+\'/v1</code>\'+copyBtn(iBO)+\'</div>\'
   + \'<div class="conn-row"><span class="conn-k">认证</span><code>Authorization: Bearer &lt;CURSOR_CLIENT_KEYS 任一把&gt;</code></div>\'
   + \'<pre><span class="c"># curl 最小示例</span>\\n\'
   + \'curl \'+esc(base)+\'/v1/chat/completions\\n\'
   + \'  -H "Authorization: Bearer $CURSOR_CLIENT_KEY"\\n\'
   + \'  -H "content-type: application/json"\\n\'
   + \'  -d {"model":"claude-opus-5","messages":[{"role":"user","content":"hi"}]}</pre>\'
   + \'<div class="field-hint">模型目录双格式：x-api-key → Anthropic 格式，Bearer → OpenAI 格式（GET /v1/models）。</div>\'
   + \'</div></div>\'
   + \'</div>\'
   + \'<div class="section"><div class="section-header"><div><div class="section-title">模型名后面能带参数</div><div class="section-desc">方括号里写维度值，裸词就行，不用记它属于哪一维</div></div></div>\'
   + \'<div class="section-body"><pre>claude-opus-5[1m,max]   <span class="c">→ 100 万上下文 + 最高 effort</span>\\n\'
   + \'composer-2.5[fast]      <span class="c">→ 开 fast（注意：fast 一次扣 2 个 request）</span></pre></div></div>\'
   + \'<div class="section"><div class="section-header"><div><div class="section-title">关于计费</div></div></div>\'
   + \'<div class="section-body"><p>Cursor 查不到余额——<code>Agent.getUsage()</code> 在普通账号上返回 403 feature_unavailable。所以「调用次数」是本网关自己数的 run 数，也是最接近 Cursor 计费口径的读数（它按 request 计数）。</p>\'
   + \'<p>没显式指定的计费敏感维度（fast / thinking）一律默认取便宜那一档，避免"什么都不写"落到贵档上。</p></div></div>\'
   + \'</div>\';
}

// ── 通用动作 ──────────────────────────────────────────
async function load(manual){
  try{
    var prev=data;
    data = await api("status");
    // 号池事件通知：状态跃迁（号死/恢复/冷却结束）才弹，10 分钟内同事件合并
    try{ notifyPoolDiff(prev, data); }catch(_){}
    // 侧栏那行计数在哪个页签下都得是最新的，所以放在 render 外面
    $("foot").textContent = data.available+"/"+data.total+" 可用";
    render();
    if(manual) toast("已刷新","ok");
  }catch(e){ if(manual) toast(e.message,"bad"); }
}
// diff 前后两次快照，状态变化的号 toast 通知（合并去重）。
var _notified={};
function notifyPoolDiff(prev, cur){
  if(!prev || !prev.accounts || !cur || !cur.accounts) return;
  var by={};
  for(var i=0;i<cur.accounts.length;i++) by[cur.accounts[i].id]=cur.accounts[i];
  var now=Date.now();
  for(var j=0;j<prev.accounts.length;j++){
    var p=prev.accounts[j], c=by[p.id];
    if(!c) continue;
    var pBad=p.disabled||p.cooldownUntil!=null, cBad=c.disabled||c.cooldownUntil!=null;
    if(pBad===cBad) continue;
    var key=c.id+":"+(cBad?"down":"up");
    var last=_notified[key];
    if(last && now-last<600000) continue; // 10 分钟合并
    _notified[key]=now;
    var nm=c.name||c.email||c.id;
    if(cBad){
      var why=c.disabledReason||(c.cooldownUntil?"冷却中":"状态变化");
      toast("号 "+nm+"："+why,"bad");
    } else {
      toast("号 "+nm+" 已恢复","ok");
    }
  }
}

async function act(fn, okMsg){
  if(busy) return;
  busy=true;
  try{ var r = await fn(); if(okMsg) toast(typeof okMsg==="function"?okMsg(r):okMsg,"ok"); await load(); }
  catch(e){ toast(e.message,"bad"); }
  finally{ busy=false; }
}
// 这几个都**把 act() 的 promise 返回出去**。不返回的话调用方 await 不到，
// 连点两下时第二下会撞上 busy 被静默丢掉 —— 用户看到的是"点了没反应"。
function toggle(id,d){ return act(function(){ return api("accounts/"+id+"/disabled", j({disabled:d})); }, d?"已禁用":"已启用"); }
function probe(id){ return act(function(){ return api("accounts/"+id+"/probe", {method:"POST"}); },
  function(r){ return r.ok ? "探活正常：" + (r.account.email||r.account.name) : "探活失败，看表格里的错误"; }); }
function reload(){ return act(function(){ return api("reload",{method:"POST"}); },
  function(r){ return "已重载：共 "+r.total+" 个（新增 "+r.added+"，移除 "+r.removed+"）"; }); }
function del(id){
  var a=(data.accounts||[]).filter(function(x){return x.id===id;})[0];
  askConfirm("删除「"+((a&&a.name)||id)+"」？会从号池文件里去掉，它的用量记录也一并丢弃。", function(){ delNow(id); }, true);
}
function delNow(id){
  return act(function(){ return api("accounts/"+id, {method:"DELETE"}); }, "已删除");
}

function render(){
  // 任何整页重绘都可能发生在 hover 期间：旧元素被替换，mouseleave 永远不触发，
  // 不主动收的话气泡会残留（TIP 数组又已重建，残留内容还可能错位）
  tipHide();
  if(view==="models"){ renderModels(); return; }
  if(view==="conn"){ renderConn(); return; }
  if(view==="logs"){ renderLogsView(); return; }
  if(view==="stats"){ renderStats(); return; }
  if(view==="settings"){ renderSettings(); return; }
  if(view==="accounts"){ renderAccounts(); return; }
  renderPool();
}

// ── 弹窗 ──────────────────────────────────────────────
function closeModal(){ $("modal").innerHTML=""; }
function modal(title, bodyHtml, footHtml){
  $("modal").innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">'
    + '<div class="modal"><div class="modal-header"><div class="modal-title">'+title+'</div></div>'
    + '<div class="modal-body">'+bodyHtml+'</div>'
    + '<div class="modal-footer">'+footHtml+'</div></div></div>';
}
// 自定义确认框（替代原生 confirm）：danger 红色确认 + 取消。
// 回调走全局 slot，避免把函数体序列化进 onclick 字符串。
var _confirmOk=null;
function askConfirm(msg, onOk, danger){
  _confirmOk=onOk;
  var foot='<button class="btn" onclick="closeModal()">取消</button>'
    + '<button class="btn'+(danger?' danger':" btn-primary")+'" onclick="closeModal();confirmOk()">确认</button>';
  modal("确认操作", '<div class="modal-msg">'+esc(msg)+'</div>', foot);
}
function confirmOk(){ var f=_confirmOk; _confirmOk=null; if(f) f(); }

function addOpen(){
  modal("添加账号",
    '<div class="field"><label class="field-label">Cursor API Key <b class="req">*</b></label>'
    + '<input id="ak" class="input mono" type="password" autocomplete="off" spellcheck="false" placeholder="crsr_…">'
    + '<div class="field-hint">会先拿 <code>Cursor.me()</code> 验一次再写入号池文件。验不过一个字都不写。</div></div>'
    + '<div class="field-row"><div class="field"><label class="field-label">登录邮箱</label>'
    + '<input id="ae" class="input" autocomplete="off" spellcheck="false" placeholder="留空则用 key 自带的"></div>'
    + '<div class="field"><label class="field-label">登录密码</label>'
    + '<input id="aw" class="input" type="password" autocomplete="new-password" placeholder="选填"></div></div>'
    + '<div class="note">key 会过期，到时候要回 Cursor 重新登录再生成一把 —— '
    + '记下账号密码是为了那一刻知道该登哪个号。<b>明文存在服务器上</b>（文件 0600），'
    + '介意就别填，邮箱靠 key 也能自动认出来。</div>'
    + '<div class="field-row"><div class="field"><label class="field-label">名字</label>'
    + '<input id="an" class="input" autocomplete="off" placeholder="留空则用邮箱"></div>'
    + '<div class="field"><label class="field-label">优先级</label><input id="ap" class="input mono" type="number" value="0"></div></div>'
    + '<div class="note">优先级数字越小越先用，同一档内轮转。想让某个号只做兜底，把它调大。</div>',
    '<button class="btn" onclick="closeModal()">取消</button>'
    + '<button class="btn btn-primary" id="asb" onclick="addSubmit()">验证并添加</button>');
  setTimeout(function(){ $("ak").focus(); },30);
}
async function addSubmit(){
  var k=$("ak").value.trim();
  if(!k){ toast("先把 key 粘进来","bad"); return; }
  var b=$("asb"); b.disabled=true; b.innerHTML='<span class="spinner"></span>正在向 Cursor 校验…';
  try{
    var r = await api("accounts", j({
      key:k, name:$("an").value.trim(), priority:Number($("ap").value)||0,
      login:$("ae").value.trim(), password:$("aw").value,
    }));
    closeModal(); toast("已添加 "+r.name+(r.email?"（"+r.email+"）":""),"ok"); load();
  }catch(e){ toast(e.message,"bad"); b.disabled=false; b.innerHTML="验证并添加"; }
}

function batchOpen(){
  modal("批量导入",
    '<div class="field"><label class="field-label">一行一个 key，也可以用逗号分隔</label>'
    + '<textarea id="bk" class="textarea" spellcheck="false" placeholder="crsr_xxxx\\ncrsr_yyyy\\ncrsr_zzzz"></textarea>'
    + '<div class="field-hint">每一把都会单独验一次。<b>坏的跳过，好的照加</b>——'
    + '不做整批回滚，否则你还得自己去挑哪个坏了。最多 200 个。</div></div>',
    '<button class="btn" onclick="closeModal()">取消</button>'
    + '<button class="btn btn-primary" id="bsb" onclick="batchSubmit()">开始导入</button>');
  setTimeout(function(){ $("bk").focus(); },30);
}
async function batchSubmit(){
  var keys=$("bk").value.split(/[\\s,]+/).map(function(s){return s.trim();}).filter(Boolean);
  if(!keys.length){ toast("一个 key 都没有","bad"); return; }
  var b=$("bsb"); b.disabled=true;
  b.innerHTML='<span class="spinner"></span>正在逐个校验 '+keys.length+' 个…';
  try{
    var r = await api("accounts/batch", j({ items: keys.map(function(k){ return {key:k}; }) }));
    closeModal();
    toast("导入完成：成功 "+r.added.length+"，失败 "+r.failed.length, r.failed.length?"info":"ok");
    if(r.failed.length){
      var lines = r.failed.slice(0,8).map(function(f){ return f.key+" — "+f.reason; }).join("\\n");
      if(r.failed.length>8) lines += "\\n…还有 "+(r.failed.length-8)+" 个";
      toast("失败的：\\n"+lines,"bad");
    }
    load();
  }catch(e){ toast(e.message,"bad"); b.disabled=false; b.innerHTML="开始导入"; }
}

function editOpen(id){
  var a=(data.accounts||[]).filter(function(x){return x.id===id;})[0];
  if(!a) return;
  modal("编辑 "+esc(a.name),
    '<div class="field-row"><div class="field"><label class="field-label">名字</label>'
    + '<input id="en" class="input" value="'+esc(a.name)+'"></div>'
    + '<div class="field"><label class="field-label">优先级</label><input id="ep" class="input mono" type="number" value="'+a.priority+'"></div></div>'
    + '<div class="note">key 不能改 —— 换 key 等于换一个号，请删掉再重新添加。</div>',
    '<button class="btn" onclick="closeModal()">取消</button>'
    + '<button class="btn btn-primary" onclick="editSubmit(\\''+id+'\\')">保存</button>');
}
function editSubmit(id){
  var body={ name:$("en").value, priority:Number($("ep").value)||0 };
  closeModal();
  return act(function(){ return api("accounts/"+id, { method:"PATCH",
    headers:{"content-type":"application/json"}, body:JSON.stringify(body) }); }, "已保存");
}

// ── 轮询节流：10s 心跳 + visibilitychange 暂停 ────────
// 页面不可见时暂停全部心跳；回到前台立即补一次刷新。
if(document.addEventListener){
  document.addEventListener("visibilitychange", function(){
    pageHidden = document.hidden===true;
    if(!pageHidden && !busy && (view==="pool"||view==="accounts")) load();
  });
}
// 每 10 秒自动刷新，但**弹窗开着时不刷** —— 否则你正在输入的表单会被重绘掉
setInterval(function(){ if(pageHidden) return; if((view==="pool"||view==="accounts") && !$("modal").innerHTML && !busy) load(); }, 10000);
// 统计页自己低频轮询
setInterval(function(){ if(pageHidden) return; if(view==="stats" && statsLoaded && !busy) loadStats(); }, 30000);
// 设置页信息条：运行时长每秒会变，5 秒重刷一次（配置表单不重绘，只刷这条）
setInterval(function(){ if(view==="settings" && cfgLoaded){ var el=$("cfg-info"); if(el) renderCfgInfo(); } }, 5000);

// 最近请求表独立刷新：日志流断/不可用时不至于让表格停在进入时的数据。
// 10s tick 与日志帧触发的 maybeRefreshRequests 共用 reqBusy/reqAt 守卫。
var reqTicker=null;
function startReqTicker(){
  if(reqTicker) return;
  if(typeof setInterval==="undefined") return;
  reqTicker=setInterval(function(){ maybeRefreshRequests(); }, 10000);
}
function stopReqTicker(){
  if(reqTicker){ if(typeof clearInterval!=="undefined") clearInterval(reqTicker); reqTicker=null; }
}

// ESC 退出登录：无弹窗打开时按 ESC → 确认后退出。弹窗开着时不抢，
// 先让用户处理弹窗。函数体独立出来，测试沙箱里也能直接调用。
function onKeyDown(ev){
  try{
    var e=ev||(typeof window!=="undefined"?window.event:null)||{};
    var key=e.key||e.keyCode||"";
    if(key!=="Escape" && key!==27 && key!=="Esc") return;
    // 输入框/文本域里的 ESC 是清输入，不是退出登录
    var t=e.target||null;
    if(t && (t.tagName==="INPUT" || t.tagName==="TEXTAREA" || t.isContentEditable)) return;
    if($("modal") && $("modal").innerHTML) return;
    askConfirm("确认退出登录？", function(){ logout(); }, true);
  }catch(_){}
}
if(document.addEventListener) document.addEventListener("keydown", onKeyDown);

// 冷却倒计时：账号详情展开行里的剩余时间每秒刷新。单个全局 interval
// 带可见性守卫（只在账号页 + 页面可见时干活），不随视图切换反复建/拆。
function coolTick(){
  if(typeof document==="undefined" || !document.getElementsByClassName) return;
  var els=document.getElementsByClassName("cool-cd");
  if(!els || !els.length) return;
  var now=Date.now();
  for(var i=0;i<els.length;i++){
    var el=els[i], cu=el.getAttribute ? el.getAttribute("data-cu") : null;
    if(!cu) continue;
    var t=new Date(cu).getTime();
    if(isNaN(t)) continue;
    var rem=Math.max(0,t-now);
    el.textContent = rem>0 ? "冷却中 剩余 "+coolFmt(rem) : "冷却结束";
  }
}
setInterval(function(){ if(view==="accounts" && !pageHidden) coolTick(); }, 1000);

// 侧栏版本号：后端有 /admin/update/check 就从 current 拿；没有就静默。
// 顺带把结果存进 upd，设置页的版本信息条跟它共用一份数据。
// 自动更新通知：发现新版本 → toast + 侧栏「升级」徽章，每 30 分钟静默复查一次
// （检查不自动执行，只提醒；执行仍要走设置页的手动按钮 + 二次确认）。
// 自动更新通知：发现新版本 → toast + 侧栏「升级」徽章，每 30 分钟静默复查。
// OTA 被关闭（enabled=false，CURSOR_OTA_ENABLED=0）时不推送——检查不自动
// 执行，只提醒；执行仍要走设置页的手动按钮 + 二次确认。
var _updNotified=false;
function _checkUpdateAuto(){
  api("update/check").then(function(r){
    upd=r;
    if(r && r.current){ var f=$("fver"); if(f) f.textContent="v"+r.current; }
    renderCfgInfo();
    // OTA disabled: no push notifications, badge stays hidden. The manual
    // "check" button on the settings page still works (read-only check).
    if(!r || r.enabled === false){ _updNotified=false; return; }
    if(r && r.hasUpdate && !_updNotified){
      _updNotified=true;
      toast("发现新版本 "+esc(r.latest)+"（当前 "+esc(r.current)+"），到「设置」页可一键更新","info");
      var b=$("upd-badge");
      if(b) b.style.display="inline-block";
    }
    if(r && !r.hasUpdate) _updNotified=false;
  }).catch(function(){});
}
try{ _checkUpdateAuto(); }catch(_){}
setInterval(_checkUpdateAuto, 30*60*1000).unref?.();

// 骨架里默认高亮的就是「概览」，所以只有带 hash 进来才需要切一下
if(view!=="pool") go(view);
load();
`;

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>CursorAPI 控制台</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CSS}</style></head>
<body>${BODY}
<script>var ICO=${JSON.stringify(I)};var PROV=${JSON.stringify(PROV)};${JS}</script>
</body></html>`;

// 登录页。跟主界面同一套 CSS，但**不含任何号池数据** ——
// 未登录的人拿到的这份 HTML 里没有一个字节是敏感的。
// 会话机制不动：HttpOnly cookie cursorapi_sess，POST /admin/login，失败等 penalty。
// 视觉照搬 windsurf login-overlay：居中渐变遮罩 + 品牌 logo + 密码框 + 内联错误 + Enter 提交。
const LOGIN = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>CursorAPI — 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CSS}</style></head>
<body><div class="login-overlay"><div class="login-box">
  <div class="login-logo">C</div>
  <h3>CursorAPI 控制台</h3>
  <p>Cursor 转 API 的网关 · 管理口令</p>
  <div class="field">
    <label class="field-label" for="k">管理口令</label>
    <input id="k" class="input" type="password" autocomplete="current-password" autofocus
           placeholder="CURSOR_ADMIN_KEY">
  </div>
  <button class="btn btn-primary" id="b" onclick="go()">进入</button>
  <div class="lgerr" id="e"></div>
</div></div>
<script>
// 主题跟随主界面存的偏好（默认暗色）。沙箱里没有 localStorage / documentElement，得容错。
try{ var lt=localStorage.getItem("dashboard_theme")||"dark";
  if(lt==="dark" && document.documentElement) document.documentElement.setAttribute("data-theme","dark"); }catch(_){}
var k=document.getElementById("k"), b=document.getElementById("b"), e=document.getElementById("e");
if(k && k.addEventListener) k.addEventListener("keydown", function(ev){ if(ev.key==="Enter") go(); });
async function go(){
  var v=k.value;
  if(!v){ e.textContent="口令不能为空"; k.focus(); return; }
  b.disabled=true; e.textContent="";
  try{
    var r=await fetch("/admin/login",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({key:v})});
    if(r.ok){ location.replace("/admin"); return; }
    var d=null; try{ d=await r.json(); }catch(_){}
    // 口令错时服务端会**先等一会儿**再回（挡暴力破解），所以这里可能慢几秒
    e.textContent=(d&&d.error&&d.error.message)||("登录失败 "+r.status);
  }catch(err){ e.textContent=String(err&&err.message||err); }
  b.disabled=false;
  if(k.select) k.select();
}
</script></body></html>`;

export function page() {
  return PAGE;
}

export function loginPage() {
  return LOGIN;
}
