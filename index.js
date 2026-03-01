const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

// ================= 1. 用户参数与配置 =================
const USER_VARS = {
    UUID: process.env.UUID || null ,
    XRAY_PATH: process.env.XRAY_PATH || "/vless",
    XTUNNEL_TOKEN: process.env.XTUNNEL_TOKEN || "", 
    CF_TOKEN: process.env.CF_TOKEN || "", 
    CF_DOMAIN: process.env.CF_DOMAIN || "",
    SUB_PATH: process.env.SUB_PATH || "/sub",
    PANEL_PASS: process.env.PANEL_PASS || "",

    // 【逻辑修正】设置默认值，确保在不配置环境变量时也能按你的预期启动
    // XRAY_START: 默认 0 (关闭)
    XRAY_START: (process.env.XRAY_START || "0") === "1",
    // XTUNNEL_START: 默认 1 (开启)
    XTUNNEL_START: (process.env.XTUNNEL_START || "1") === "1",
    // KOMARI_START: 默认 1 (开启)
    KOMARI_START: (process.env.KOMARI_START || "1") === "1",
    
    CF_START: true, 

    XRAY_PORT: process.env.XRAY_PORT || 8401,     
    XTUNNEL_PORT: process.env.XTUNNEL_PORT || 8405,   
    WEB_PORT: parseInt(process.env.PORT || process.env.WEB_PORT || 20359), 
    
    KOMARI_ENDPOINT: process.env.KOMARI_ENDPOINT || 'https://komari.mygcp.tk',
    KOMARI_TOKEN: process.env.KOMARI_TOKEN || '',

    MAX_LOG_LINES: 100         
};

let ACTIVE_UUID = "";
let VLESS_LINK = "";
let runningLogs = []; 
const INSTANCES = {};

const restartTracker = {
    xray: { count: 0, manualStop: !USER_VARS.XRAY_START },
    xtunnel: { count: 0, manualStop: !USER_VARS.XTUNNEL_START },
    cloudflared: { count: 0, manualStop: false },
    komari: { count: 0, manualStop: !USER_VARS.KOMARI_START }
};

// ================= 2. 核心辅助功能 =================

const WORK_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR);

const XRAY_CONFIG_FILE = path.join(WORK_DIR, 'xray_config.json');
const ARCH = os.arch() === 'x64' ? 'amd64' : (os.arch() === 'arm64' ? 'arm64' : 'amd64');
const X_ARCH = os.arch() === 'x64' ? '64' : 'arm64-v8a';

const CONFIG = {
    services: {
        xray: { 
            enabled: USER_VARS.XRAY_START,
            bin: path.join(WORK_DIR, 'xray'), 
            url: `https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${X_ARCH}.zip`, 
            isZip: true, 
            args: ['run', '-config', XRAY_CONFIG_FILE] 
        },
        xtunnel: { 
            enabled: USER_VARS.XTUNNEL_START,
            bin: path.join(WORK_DIR, 'x-tunnel'), 
            url: `https://www.baipiao.eu.org/xtunnel/x-tunnel-linux-${ARCH}`, 
            args: ['-l', `ws://127.0.0.1:${USER_VARS.XTUNNEL_PORT}`, '-token', USER_VARS.XTUNNEL_TOKEN] 
        },
        cloudflared: { 
            enabled: USER_VARS.CF_START,
            bin: path.join(WORK_DIR, 'cloudflared'), 
            url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`, 
            args: ['tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', 'run', '--token', USER_VARS.CF_TOKEN] 
        },
        komari: { 
            enabled: USER_VARS.KOMARI_START,
            bin: path.join(WORK_DIR, 'komari-agent'), 
            url: `https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-${ARCH}`, 
            args: ['-e', USER_VARS.KOMARI_ENDPOINT, '-t', USER_VARS.KOMARI_TOKEN] 
        }
    }
};

function addLog(msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const formattedMsg = `[${time}] ${msg}`;
    console.log(formattedMsg);
    runningLogs.push(formattedMsg);
    if (runningLogs.length > USER_VARS.MAX_LOG_LINES) runningLogs.shift();
}

async function downloadFile(key) {
    const item = CONFIG.services[key];
    if (fs.existsSync(item.bin)) {
        addLog(`[本地] 检测到 ${key} 已存在，跳过下载`);
        return true;
    }

    addLog(`[环境] 正在下载 ${key}...`);
    try {
        const res = await fetch(item.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        
        if (item.isZip) {
            const zipPath = item.bin + ".zip";
            fs.writeFileSync(zipPath, buffer);
            execSync(`unzip -o "${zipPath}" -d "${WORK_DIR}" && rm "${zipPath}"`);
        } else {
            fs.writeFileSync(item.bin, buffer);
        }
        fs.chmodSync(item.bin, 0o755);
        addLog(`[环境] ${key} 下载部署完成`);
        return true;
    } catch (err) {
        addLog(`[错误] ${key} 下载失败: ${err.message}`);
        return false;
    }
}

function startService(key) {
    const item = CONFIG.services[key];
    if (INSTANCES[key] || !fs.existsSync(item.bin)) return;

    restartTracker[key].manualStop = false;
    addLog(`[启动] 调起进程: ${key}`);
    
    const proc = spawn(item.bin, item.args, { cwd: WORK_DIR });
    INSTANCES[key] = proc;

    proc.stdout.on('data', d => addLog(`[${key}] ${d.toString().trim()}`));
    proc.stderr.on('data', d => addLog(`[${key}] ${d.toString().trim()}`));

    proc.on('exit', (code) => {
        INSTANCES[key] = null;
        if (!restartTracker[key].manualStop) {
            addLog(`[系统] ${key} 进程退出 (代码: ${code})，5秒后自动尝试恢复...`);
            setTimeout(() => { if(!restartTracker[key].manualStop) startService(key); }, 5000);
        }
    });
}

function stopService(key) {
    if (INSTANCES[key]) {
        addLog(`[停止] 手动关闭服务: ${key}`);
        restartTracker[key].manualStop = true;
        INSTANCES[key].kill();
        INSTANCES[key] = null;
    }
}

// ================= 3. UI 渲染 =================

const HTML_STYLE = `
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    :root { --main: #00ff41; --bg: #0a0a0a; --card: #161616; }
    body { background: var(--bg); color: var(--main); font-family: -apple-system, sans-serif; padding: 10px; margin: 0; }
    .header { text-align: center; border-bottom: 1px solid #333; padding: 10px 0; margin-bottom: 15px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 15px; }
    .card { background: var(--card); border: 1px solid #333; padding: 15px; border-radius: 10px; text-align: center; }
    .card.active { border-color: var(--main); }
    .btn { display: block; width: 100%; border: none; padding: 12px 0; border-radius: 6px; font-weight: bold; cursor: pointer; text-decoration: none; margin-top: 10px; box-sizing: border-box; }
    .btn-start { background: var(--main); color: #000; }
    .btn-stop { background: #333; color: #ff4141; border: 1px solid #444; }
    .log-container { background: #000; padding: 10px; border-radius: 6px; border: 1px solid #222; height: 40vh; overflow-y: auto; font-family: monospace; font-size: 11px; color: #777; line-height: 1.4; }
</style>
`;

function renderLoginPage(basePath) {
    return `<html><head><title>Auth</title>${HTML_STYLE}</head>
    <body><div style="max-width:300px;margin:80px auto;background:var(--card);padding:25px;border-radius:12px;text-align:center">
        <form action="${basePath}" method="GET">
            <input type="password" name="pass" placeholder="Password" style="width:100%;padding:12px;background:#000;border:1px solid #444;color:var(--main);margin-bottom:10px;text-align:center">
            <button class="btn btn-start" type="submit">UNLOCK</button>
        </form>
    </div></body></html>`;
}

function renderDashboard(basePath) {
    let cardsHtml = '';
    for (const s in CONFIG.services) {
        const isRunning = !!INSTANCES[s];
        cardsHtml += `
        <div class="card ${isRunning ? 'active' : ''}">
            <div style="font-size:13px; opacity:0.6; margin-bottom:5px;">${s.toUpperCase()}</div>
            <div style="font-size:12px;">${isRunning ? '🟢 Running' : '⚪ Stopped'}</div>
            <a href="${basePath}?action=${isRunning ? 'stop' : 'start'}&service=${s}" class="btn ${isRunning ? 'btn-stop' : 'btn-start'}">
                ${isRunning ? 'STOP' : 'START'}
            </a>
        </div>`;
    }

    return `<html><head><title>Dashboard</title>${HTML_STYLE}</head>
    <body>
        <div class="header"><h1 style="font-size:1.1rem;margin:0;">CONTROLLER</h1></div>
        <div class="grid">${cardsHtml}</div>
        <pre class="log-container">${runningLogs.slice().reverse().join('\n') || 'No logs...'}</pre>
        <script>setTimeout(() => { if(!window.location.search) window.location.reload(); }, 5000);</script>
    </body></html>`;
}

function renderSubPage(basePath) {
    return `<html><head>${HTML_STYLE}</head><body style="display:flex;align-items:center;justify-content:center;height:100vh">
        <div class="card" style="width:90%; max-width:400px">
            <div style="font-weight:bold;margin-bottom:10px;">VLESS CONFIG</div>
            <div style="background:#000;padding:12px;border:1px dashed #444;font-size:11px;word-break:break-all;color:#ffcc00;margin-bottom:15px">${VLESS_LINK}</div>
            <button class="btn btn-start" onclick="navigator.clipboard.writeText('${VLESS_LINK}');this.innerText='COPIED!'">COPY</button>
            <a href="${basePath}" class="btn btn-stop">BACK</a>
        </div></body></html>`;
}

// ================= 4. 主引擎 =================

async function main() {
    initUUID();

    // 启动时按配置下载并运行
    for (const key in CONFIG.services) {
        if (CONFIG.services[key].enabled) {
            const ok = await downloadFile(key);
            if (ok) startService(key);
        } else {
            addLog(`[跳过] ${key} 当前设为禁用状态`);
        }
    }

    http.createServer((req, res) => {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const basePath = urlObj.pathname; 
        const query = urlObj.searchParams;

        // 鉴权
        if (USER_VARS.PANEL_PASS) {
            const isAuth = (req.headers.cookie || "").includes(`sid=${USER_VARS.PANEL_PASS}`);
            if (query.get('pass') === USER_VARS.PANEL_PASS) {
                res.setHeader('Set-Cookie', `sid=${USER_VARS.PANEL_PASS}; Path=/; Max-Age=86400; HttpOnly`);
                res.writeHead(302, { 'Location': basePath }); 
                return res.end();
            } else if (!isAuth) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(renderLoginPage(basePath));
            }
        }

        // 接口控制
        const action = query.get('action');
        const service = query.get('service');
        if (action && service && CONFIG.services[service]) {
            if (action === 'start') {
                downloadFile(service).then(ok => { if(ok) startService(service) });
            } else {
                stopService(service);
            }
            res.writeHead(302, { 'Location': basePath }); 
            return res.end();
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (req.url.includes(USER_VARS.SUB_PATH)) {
            res.end(renderSubPage(basePath));
        } else {
            res.end(renderDashboard(basePath));
        }
    }).listen(USER_VARS.WEB_PORT, '0.0.0.0');

    addLog(`[系统] 控制面板已启动在端口: ${USER_VARS.WEB_PORT}`);
}

function initUUID() {
    ACTIVE_UUID = USER_VARS.UUID || crypto.randomUUID();
    const cfg = { inbounds: [{ port: USER_VARS.XRAY_PORT, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: ACTIVE_UUID }], decryption: "none" }, streamSettings: { network: "ws", wsSettings: { path: USER_VARS.XRAY_PATH } } }], outbounds: [{ protocol: "freedom" }] };
    fs.writeFileSync(XRAY_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    VLESS_LINK = `vless://${ACTIVE_UUID}@www.visa.com.sg:443?encryption=none&security=tls&type=ws&host=${USER_VARS.CF_DOMAIN}&path=${USER_VARS.XRAY_PATH}#Argo_Node`;
}

main();
