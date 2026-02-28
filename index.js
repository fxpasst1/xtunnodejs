const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http'); // 新增：用于创建伪装网页服务器

// ================= 1. 用户变量配置区 (通过环境变量获取) =================
const USER_VARS = {
    // 优先级：环境变量 > 默认值
    wsPort: parseInt(process.env.WS_PORT) || 8005, 
    
    // 新增：伪装网页端口，Docker 中使用 -e WEB_PORT=80 修改
    webPort: parseInt(process.env.WEB_PORT) || 80, 

    komariEndpoint: process.env.KOMARI_ENDPOINT || 'https://komari.mygcp.tk', 
    komariToken: process.env.KOMARI_TOKEN || '6FVXncUoS8Behwz7',      
    
    cfToken: process.env.CF_TOKEN || 'eyJhIjoiZGRmMDQyNTdiMmRlMTkyNDMyOGZhMDI1ODcwYWYxMmEiLCJ0IjoiNWZhYTFjYTEtYmY4Yi00MGViLTk4MDUtZDNlMzJlOTg4YTlmIiwicyI6Ik1USXpaRGcyWW1FdE9UY3hNeTAwTXpSaUxUaGhOVEF0WldFME1EWTBNVGt6TURCaSJ9'
};

// ================= 2. 伪装网页内容 (Example.com 模板) =================
const EXAMPLE_HTML = `
<!doctype html>
<html>
<head>
    <title>Example Domain</title>
    <meta charset="utf-8" />
    <meta http-equiv="Content-type" content="text/html; charset=utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style type="text/css">
    body { background-color: #f0f0f2; margin: 0; padding: 0; font-family: -apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; }
    div { width: 600px; margin: 5em auto; padding: 2em; background-color: #fff; border-radius: 0.5em; box-shadow: 2px 3px 7px 2px rgba(0,0,0,0.02); }
    a:link, a:visited { color: #38488f; text-decoration: none; }
    @media (max-width: 700px) { div { margin: 0 auto; width: auto; } }
    </style>    
</head>
<body>
<div>
    <h1>Example Domain</h1>
    <p>This domain is for use in illustrative examples in documents. You may use this
    domain in literature without prior coordination or asking for permission.</p>
    <p><a href="https://www.iana.org/domains/example">More information...</a></p>
</div>
</body>
</html>
`;

// ================= 3. 系统核心配置 =================
const CONFIG = {
    arch: process.arch === 'x64' ? 'amd64' : (process.arch === 'arm64' ? 'arm64' : 'amd64'),
    mirrors: ['', 'https://mirror.ghproxy.com/', 'https://ghfast.top/'],
    
    services: {
        xtunnel: {
            bin: './x-tunnel-linux',
            url: (arch) => `https://www.baipiao.eu.org/xtunnel/x-tunnel-linux-${arch}`,
            args: ['-l', `ws://127.0.0.1:${USER_VARS.wsPort}`, '-token', 'fxpass']
        },
        cloudflared: {
            bin: './cloudflared-linux',
            url: (arch) => `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`,
            args: ['tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', 'run', '--token', USER_VARS.cfToken]
        },
        komari: {
            bin: './komari-agent', 
            url: (arch) => `https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-${arch}`,
            args: ['-e', USER_VARS.komariEndpoint, '-t', USER_VARS.komariToken]
        }
    },
    
    rebootInterval: (parseFloat(process.env.REBOOT_HOURS) || 8) * 60 * 60 * 1000 
};

const INSTANCES = { xtunnel: null, cloudflared: null, komari: null };

// ================= 4. 功能函数 =================

async function downloadFile(url, dest) {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    for (const mirror of CONFIG.mirrors) {
        const fullUrl = mirror + url;
        console.log(`[📥 下载尝试] 源: ${fullUrl || '直连'}`);
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000); 
            const res = await fetch(fullUrl, { headers: { 'User-Agent': ua }, signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) continue;
            const buffer = Buffer.from(await res.arrayBuffer());
            if (buffer.length < 5000) throw new Error('文件损坏');
            fs.writeFileSync(dest, buffer);
            fs.chmodSync(dest, 0o755);
            return true;
        } catch (err) { console.warn(`      - 失败: ${err.message}`); }
    }
    return false;
}

async function ensureBinaries() {
    for (const key in CONFIG.services) {
        const item = CONFIG.services[key];
        if (!fs.existsSync(item.bin)) {
            const success = await downloadFile(item.url(CONFIG.arch), item.bin);
            if (!success) {
                console.log(`[❌ 错误] ${key} 下载失败，15秒后重试...`);
                await new Promise(r => setTimeout(r, 15000));
                return ensureBinaries();
            }
        } else {
            fs.chmodSync(item.bin, 0o755);
        }
    }
}

// ================= 5. 守护与 Web 逻辑 =================

function startWebServer() {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(EXAMPLE_HTML);
    });

    server.listen(USER_VARS.webPort, '0.0.0.0', () => {
        console.log(`[🌐 伪装] 网页服务已启动: http://0.0.0.0:${USER_VARS.webPort}`);
    });

    server.on('error', (err) => {
        console.error(`[⚠️ 网页错误] 无法启动端口 ${USER_VARS.webPort}: ${err.message}`);
    });
}

function startService(key) {
    const item = CONFIG.services[key];
    if (INSTANCES[key]) return;
    console.log(`[🚀 启动] ${key.toUpperCase()}`);
    const proc = spawn(item.bin, item.args, { stdio: 'inherit' });
    INSTANCES[key] = proc;
    proc.on('exit', (code) => {
        INSTANCES[key] = null;
        console.log(`[⚠️ 警告] ${key.toUpperCase()} 已退出 (${code})，5秒后重启...`);
        setTimeout(() => startService(key), 5000);
    });
}

function stopAll() {
    console.log('\n[⏰ 周期] 执行例行刷新...');
    for (const key in INSTANCES) {
        if (INSTANCES[key]) INSTANCES[key].kill();
    }
}

// ================= 6. 入口 =================

async function main() {
    console.log('--- 🛡️ XtunArgo Docker 运维版 (含网页伪装) ---');
    console.log(`[📌 配置] WS端口: ${USER_VARS.wsPort}`);
    console.log(`[📌 配置] Web端口: ${USER_VARS.webPort}`);
    console.log(`[📌 配置] 重启周期: ${CONFIG.rebootInterval / 3600000} 小时`);
    
    // 1. 启动伪装网页
    startWebServer();

    // 2. 检查并下载二进制
    await ensureBinaries();

    // 3. 顺序启动服务
    const keys = Object.keys(CONFIG.services);
    for (let i = 0; i < keys.length; i++) {
        setTimeout(() => startService(keys[i]), i * 3000);
    }

    // 4. 设置定时重启
    setInterval(stopAll, CONFIG.rebootInterval);
}

main().catch(err => console.error('[🔥 崩溃]', err));

// 保持进程不退出
setInterval(() => {}, 1000 * 60 * 60);
