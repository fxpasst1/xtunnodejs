const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

// ================= 1. 用户参数与配置 =================
const USER_VARS = {
    UUID: process.env.UUID || null, 
    XRAY_PATH: process.env.XRAY_PATH || "/vless",
    XTUNNEL_TOKEN: process.env.XTUNNEL_TOKEN || "", 
    ARGO_TOKEN: process.env.ARGO_TOKEN || "",
    ARGO_DOMAIN: process.env.ARGO_DOMAIN || "",

    XRAY_PORT: process.env.XRAY_PORT || 8401,     
    XTUNNEL_PORT: process.env.XTUNNEL_PORT || 8405,   
    WEB_PORT: parseInt(process.env.PORT || process.env.WEB_PORT || 20359), 
    
    KOMARI_ENDPOINT: process.env.KOMARI_ENDPOINT || 'https://komari.mygcp.tk',
    KOMARI_TOKEN: process.env.KOMARI_TOKEN || '',

    MAX_RESTARTS: 5,           
    SUCCESS_RESET_MS: 30000,   
    MAX_LOG_LINES: 100         
};

let ACTIVE_UUID = "";
let VLESS_LINK = "";
let runningLogs = []; 

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

function addLog(msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const formattedMsg = `[${time}] ${msg}`;
    console.log(formattedMsg);
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
    
    const proc = spawn(item.bin, item.args, { cwd: WORK_DIR });
    INSTANCES[key] = proc;

    proc.stdout.on('data', d => addLog(`[${key}] ${d.toString().trim()}`));
    proc.stderr.on('data', d => addLog(`[${key}] ${d.toString().trim()}`));

    tracker.resetTimer = setTimeout(() => {
        if (tracker.count > 0) {
            addLog(`[状态] ${key} 已稳定运行。`);
            tracker.count = 0;
        }
    }, USER_VARS.SUCCESS_RESET_MS);

    proc.on('exit', (code) => {
        INSTANCES[key] = null;
        clearTimeout(tracker.resetTimer);
        tracker.count++;
        const delay = 5000 * tracker.count;
        addLog(`[警告] ${key} 退出，将在 ${delay/1000}s 后重启...`);
        setTimeout(() => startService(key), delay);
    });
}

// ================= 3. 网页模板 =================

const HTML_STYLE = `
<style>
    body { background: #0a0a0a; color: #00ff41; font-family: 'Segoe UI', 'Courier New', monospace; padding: 20px; line-height: 1.6; }
    .nav { margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid #1a1a1a; font-size: 1.2em; font-weight: bold; }
    .log-container { background: #000; padding: 15px; border-radius: 5px; border: 1px solid #222; overflow-y: auto; height: 75vh; white-space: pre-wrap; font-size: 0.9em; }
    .sub-card { background: #111; padding: 40px; border-radius: 12px; border: 1px solid #00ff41; max-width: 700px; margin: 40px auto; box-shadow: 0 0 20px rgba(0,255,65,0.1); }
    .code-box { background: #000; color: #ffcc00; padding: 15px; word-break: break-all; border-radius: 5px; border: 1px dashed #444; margin: 20px 0; font-family: monospace; }
    .copy-btn { background: #00ff41; color: #000; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-weight: bold; width: 100%; transition: 0.3s; }
    .copy-btn:hover { background: #00cc33; }
    .footer { font-size: 11px; color: #444; margin-top: 30px; text-align: center; letter-spacing: 1px; }
</style>
`;

function renderLogPage() {
    const logsContent = runningLogs.slice().reverse().join('\n');
    return `
    <html><head><title>System Status</title>${HTML_STYLE}<meta http-equiv="refresh" content="5"></head>
    <body>
        <div class="nav"><span>SYSTEM_MONITOR_V2.1</span></div>
        <pre class="log-container">${logsContent || 'Initializing logs...'}</pre>
        <div class="footer">DASHBOARD CORE | SECURE ENVIRONMENT</div>
    </body></html>`;
}

function renderSubPage() {
    return `
    <html><head><title>Subscription</title>${HTML_STYLE}</head>
    <body>
        <div class="sub-card">
            <h2 style="color:#00ff41; margin-top:0;">节点信息</h2>
            <div style="font-size:0.9em; color:#888;">Protocol: VLESS | Transport: WS</div>
            <div class="code-box" id="vlessLink">${VLESS_LINK}</div>
            <button class="copy-btn" id="copyBtn" onclick="copyToClipboard()">复制 VLESS 链接</button>
            <div id="tip" style="text-align:center; margin-top:10px; font-size:12px; color:#555;"></div>
        </div>
        <script>
            function copyToClipboard() {
                const text = document.getElementById('vlessLink').innerText;
                navigator.clipboard.writeText(text).then(() => {
                    const btn = document.getElementById('copyBtn');
                    const tip = document.getElementById('tip');
                    btn.innerText = '已成功复制到剪贴板';
                    btn.style.background = '#fff';
                    setTimeout(() => {
                        btn.innerText = '复制 VLESS 链接';
                        btn.style.background = '#00ff41';
                    }, 2000);
                }).catch(err => {
                    alert('复制失败，请手动选择复制');
                });
            }
        </script>
    </body></html>`;
}

// ================= 4. 主程序入口 =================

const CONFIG = {
    // 移除了 github 代理镜像，直接访问
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
    try {
        const res = await fetch(url, { headers: { 'User-Agent': ua } });
        if (!res.ok) throw new Error(`Status ${res.status}`);
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
    } catch (e) {
        addLog(`[下载错误] ${url} 失败: ${e.message}`);
        return false;
    }
}

async function main() {
    initUUID();
    
    const xrayConfig = {
        inbounds: [{
            port: USER_VARS.XRAY_PORT, listen: "127.0.0.1", protocol: "vless",
            settings: { clients: [{ id: ACTIVE_UUID }], decryption: "none" },
            streamSettings: { network: "ws", wsSettings: { path: USER_VARS.XRAY_PATH } }
        }],
        outbounds: [{ protocol: "freedom" }]
    };
    fs.writeFileSync(XRAY_CONFIG_FILE, JSON.stringify(xrayConfig, null, 2));
    
    // 节点链接生成
    VLESS_LINK = `vless://${ACTIVE_UUID}@www.visa.com.sg:443?encryption=none&security=tls&type=ws&host=${USER_VARS.ARGO_DOMAIN}&path=${USER_VARS.XRAY_PATH}#Argo_Node`;

    for (const key in CONFIG.services) {
        if (!fs.existsSync(CONFIG.services[key].bin)) {
            addLog(`[系统] 正在直接从 GitHub 下载: ${key}...`);
            await downloadFile(CONFIG.services[key].url, CONFIG.services[key].bin, CONFIG.services[key].isZip);
        }
    }

    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // 只有手动输入 /sub 路径才能看到节点信息
        if (req.url === '/sub') {
            res.end(renderSubPage());
        } else {
            res.end(renderLogPage());
        }
    }).listen(USER_VARS.WEB_PORT, '0.0.0.0');

    addLog(`[系统] 监控面板已在端口 ${USER_VARS.WEB_PORT} 就绪`);

    Object.keys(CONFIG.services).forEach((key, i) => {
        setTimeout(() => startService(key), i * 1500);
    });
}

main().catch(e => console.error(e));
setInterval(() => {}, 1000 * 60);
