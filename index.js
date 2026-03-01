const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

// ================= 1. 用户参数与阈值配置 =================
const USER_VARS = {
    UUID: process.env.UUID || null, 
    XRAY_PATH: process.env.XRAY_PATH || "/vless",
    XTUNNEL_TOKEN: process.env.XTUNNEL_TOKEN || "fxpass", 
    ARGO_TOKEN: process.env.ARGO_TOKEN || "eyJhIjoiZGRmMDQyNTdiMmRlMTkyNDMyOGZhMDI1ODcwYWYxMmEiLCJ0IjoiM2FjYTMyMmItZGI1Ny00Nzg3LTk4OWEtMTRjODdhNDkzMDBmIiwicyI6Ik1ERm1OVFkxWVRNdE1qSmxaUzAwTURnNUxUa3dORFF0WXpNeU1URTNOakJqTVdZMiJ9",
    ARGO_DOMAIN: process.env.ARGO_DOMAIN || "katat6.frpnas.tk",

    XRAY_PORT: 8401,     
    XTUNNEL_PORT: 8405,   
    WEB_PORT: parseInt(process.env.PORT || process.env.WEB_PORT || 20359), 
    
    KOMARI_ENDPOINT: process.env.KOMARI_ENDPOINT || 'https://komari.mygcp.tk',
    KOMARI_TOKEN: process.env.KOMARI_TOKEN || 'DWSRgBhwwWE0I6BE',

    MAX_RESTARTS: 5,           // 最大连续失败重启次数
    SUCCESS_RESET_MS: 30000,    // 成功运行判定时间 (30秒)
    MAX_LOG_LINES: 100         // 网页显示的日志最大行数
};

let ACTIVE_UUID = "";
let VLESS_LINK = "";
let runningLogs = []; // 日志缓冲区

const restartTracker = {
    xray: { count: 0, resetTimer: null },
    xtunnel: { count: 0, resetTimer: null },
    cloudflared: { count: 0, resetTimer: null },
    komari: { count: 0, resetTimer: null }
};

// ================= 2. 核心辅助功能 =================

const WORK_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR);

const XRAY_CONFIG_FILE = path.join(WORK_DIR, 'xray_config.json');
const ARCH = os.arch() === 'x64' ? 'amd64' : (os.arch() === 'arm64' ? 'arm64' : 'amd64');
const X_ARCH = os.arch() === 'x64' ? '64' : 'arm64-v8a';

// 添加日志到缓冲区
function addLog(msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const formattedMsg = `[${time}] ${msg}`;
    console.log(formattedMsg); // 同时在终端打印
    runningLogs.push(formattedMsg);
    if (runningLogs.length > USER_VARS.MAX_LOG_LINES) runningLogs.shift();
}

function initUUID() {
    if (USER_VARS.UUID) { ACTIVE_UUID = USER_VARS.UUID; return; }
    if (fs.existsSync(XRAY_CONFIG_FILE)) {
        try {
            const oldConfig = JSON.parse(fs.readFileSync(XRAY_CONFIG_FILE, 'utf8'));
            ACTIVE_UUID = oldConfig.inbounds[0].settings.clients[0].id;
            if (ACTIVE_UUID) return;
        } catch (e) { }
    }
    ACTIVE_UUID = crypto.randomUUID();
}

function startService(key) {
    const item = CONFIG.services[key];
    const tracker = restartTracker[key];

    if (tracker.count >= USER_VARS.MAX_RESTARTS) {
        addLog(`[熔断] ${key} 失败次数过多，停止尝试。`);
        return;
    }

    addLog(`[启动] ${key} (尝试 #${tracker.count + 1})`);
    
    // 使用 pipe 捕获日志，以便显示在网页
    const proc = spawn(item.bin, item.args, { cwd: WORK_DIR });
    INSTANCES[key] = proc;

    proc.stdout.on('data', d => addLog(`[${key}] ${d.toString().trim()}`));
    proc.stderr.on('data', d => addLog(`[${key} 错误] ${d.toString().trim()}`));

    tracker.resetTimer = setTimeout(() => {
        if (tracker.count > 0) {
            addLog(`[状态] ${key} 已稳定运行，重置失败计数。`);
            tracker.count = 0;
        }
    }, USER_VARS.SUCCESS_RESET_MS);

    proc.on('exit', (code) => {
        INSTANCES[key] = null;
        clearTimeout(tracker.resetTimer);
        tracker.count++;
        const delay = 5000 * tracker.count;
        addLog(`[警告] ${key} 退出 (码: ${code})，将在 ${delay/1000}s 后重启...`);
        setTimeout(() => startService(key), delay);
    });
}

// ================= 3. 网页模板 =================

const HTML_STYLE = `
<style>
    body { background: #0e0e0e; color: #00ff41; font-family: 'Courier New', monospace; padding: 20px; line-height: 1.5; }
    .nav { margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid #333; }
    .nav a { color: #00ff41; text-decoration: none; margin-right: 20px; font-weight: bold; }
    .nav a:hover { text-decoration: underline; }
    .log-container { background: #000; padding: 15px; border-radius: 5px; border: 1px solid #222; overflow-y: auto; height: 70vh; }
    .sub-card { background: #1a1a1a; padding: 30px; border-radius: 10px; border: 1px solid #00ff41; max-width: 800px; margin: auto; }
    .code-box { background: #000; color: #ffcc00; padding: 15px; word-break: break-all; border-radius: 5px; border: 1px dashed #444; margin: 15px 0; }
    .footer { font-size: 12px; color: #666; margin-top: 20px; text-align: center; }
</style>
`;

function renderLogPage() {
    const logsContent = runningLogs.slice().reverse().join('\n'); // 最新日志在最上面
    return `
    <html><head><title>System Logs</title>${HTML_STYLE}<meta http-equiv="refresh" content="5"></head>
    <body>
        <div class="nav"><a href="/">[ 实时日志 ]</a> <a href="/sub">[ 节点信息 ]</a></div>
        <h3>系统运行监控 (每5秒自动刷新)</h3>
        <pre class="log-container">${logsContent || '等待日志生成...'}</pre>
        <div class="footer">Argo All-in-One Dashboard v2.0</div>
    </body></html>`;
}

function renderSubPage() {
    return `
    <html><head><title>Subscription</title>${HTML_STYLE}</head>
    <body>
        <div class="nav"><a href="/">[ 实时日志 ]</a> <a href="/sub">[ 节点信息 ]</a></div>
        <div class="sub-card">
            <h2 style="color:#00ff41; margin-top:0;">VLESS 订阅信息</h2>
            <p>UUID: <span style="color:#fff;">${ACTIVE_UUID}</span></p>
            <p>传输协议: <span style="color:#fff;">WebSocket (WS)</span></p>
            <div class="code-box">${VLESS_LINK}</div>
            <p style="font-size:13px; color:#888;">提示: 如果连接失败，请检查 Cloudflare Tunnel 是否已将流量转发至 8401 端口。</p>
        </div>
    </body></html>`;
}

// ================= 4. 主程序入口 =================

const CONFIG = {
    mirrors: ['', 'https://mirror.ghproxy.com/', 'https://ghfast.top/'],
    services: {
        xray: {
            bin: path.join(WORK_DIR, 'xray'),
            url: `https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${X_ARCH}.zip`,
            isZip: true,
            args: ['run', '-config', XRAY_CONFIG_FILE]
        },
        xtunnel: {
            bin: path.join(WORK_DIR, 'x-tunnel'),
            url: `https://www.baipiao.eu.org/xtunnel/x-tunnel-linux-${ARCH}`,
            args: ['-l', `ws://127.0.0.1:${USER_VARS.XTUNNEL_PORT}`, '-token', USER_VARS.XTUNNEL_TOKEN]
        },
        cloudflared: {
            bin: path.join(WORK_DIR, 'cloudflared'),
            url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`,
            args: ['tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', 'run', '--token', USER_VARS.ARGO_TOKEN]
        },
        komari: {
            bin: path.join(WORK_DIR, 'komari-agent'),
            url: `https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-${ARCH}`,
            args: ['-e', USER_VARS.KOMARI_ENDPOINT, '-t', USER_VARS.KOMARI_TOKEN]
        }
    }
};

const INSTANCES = {};

async function downloadFile(url, dest, isZip = false) {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    for (const mirror of CONFIG.mirrors) {
        try {
            const res = await fetch(mirror + url, { headers: { 'User-Agent': ua } });
            if (!res.ok) continue;
            const buffer = Buffer.from(await res.arrayBuffer());
            if (isZip) {
                const zipPath = dest + ".zip";
                fs.writeFileSync(zipPath, buffer);
                execSync(`unzip -o "${zipPath}" -d "${WORK_DIR}" && rm "${zipPath}"`);
            } else {
                fs.writeFileSync(dest, buffer);
            }
            fs.chmodSync(dest, 0o755);
            return true;
        } catch (e) { }
    }
    return false;
}

async function main() {
    initUUID();
    
    // 生成配置
    const xrayConfig = {
        inbounds: [{
            port: USER_VARS.XRAY_PORT, listen: "127.0.0.1", protocol: "vless",
            settings: { clients: [{ id: ACTIVE_UUID }], decryption: "none" },
            streamSettings: { network: "ws", wsSettings: { path: USER_VARS.XRAY_PATH } }
        }],
        outbounds: [{ protocol: "freedom" }]
    };
    fs.writeFileSync(XRAY_CONFIG_FILE, JSON.stringify(xrayConfig, null, 2));
    VLESS_LINK = `vless://${ACTIVE_UUID}@www.visa.com.sg:443?encryption=none&security=tls&type=ws&host=${USER_VARS.ARGO_DOMAIN}&path=${USER_VARS.XRAY_PATH}#Argo_Node`;

    // 下载
    for (const key in CONFIG.services) {
        if (!fs.existsSync(CONFIG.services[key].bin)) {
            addLog(`[系统] 正在下载组件: ${key}...`);
            await downloadFile(CONFIG.services[key].url, CONFIG.services[key].bin, CONFIG.services[key].isZip);
        }
    }

    // 路由分发的 HTTP 服务
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (req.url === '/sub') {
            res.end(renderSubPage());
        } else {
            res.end(renderLogPage());
        }
    }).listen(USER_VARS.WEB_PORT, '0.0.0.0');

    addLog(`[系统] Web 服务已在端口 ${USER_VARS.WEB_PORT} 启动`);

    // 顺序启动
    Object.keys(CONFIG.services).forEach((key, i) => {
        setTimeout(() => startService(key), i * 1500);
    });
}

main().catch(e => console.error(e));
setInterval(() => {}, 1000 * 60);
