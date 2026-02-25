const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ================= 1. 用户变量配置区 (通过环境变量获取) =================
const USER_VARS = {
    // 优先级：环境变量 > 默认值
    // Docker 中使用 -e WS_PORT=9000 来修改
    wsPort: parseInt(process.env.WS_PORT) || 8005, 

    // Docker 中使用 -e KOMARI_ENDPOINT=... 来修改
    komariEndpoint: process.env.KOMARI_ENDPOINT || 'https://komari.mygcp.tk', 
    
    // Docker 中使用 -e KOMARI_TOKEN=... 来修改
    komariToken: process.env.KOMARI_TOKEN || 'Q2gTdIOfrQz00t8T',      
    
    // Docker 中使用 -e CF_TOKEN=... 来修改
    cfToken: process.env.CF_TOKEN || 'eyJhIjoiZGRmMDQyNTdiMmRlMTkyNDMyOGZhMDI1ODcwYWYxMmEiLCJ0IjoiNzUwZjQyYjQtZjM5Ny00NzAxLWIwZTEtM2JjMGJkMTkzMTA1IiwicyI6IlltSTBNakZqTkRZdFpHWmpOQzAwTW1Ka0xUbGxOMk10WWpFNU5qWXlPVGxpTW1abCJ9'
};

// ================= 2. 系统核心配置 =================
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
    
    monitorPort: USER_VARS.wsPort,
    // 允许通过 REBOOT_HOURS 控制重启间隔，默认 8 小时
    rebootInterval: (parseFloat(process.env.REBOOT_HOURS) || 8) * 60 * 60 * 1000 
};

const INSTANCES = { xtunnel: null, cloudflared: null, komari: null };

// ... (downloadFile 和 ensureBinaries 函数保持不变) ...

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
                await new Promise(r => setTimeout(r, 15000));
                return ensureBinaries();
            }
        } else {
            fs.chmodSync(item.bin, 0o755);
        }
    }
}

// ================= 4. 守护逻辑 =================

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

// ================= 5. 入口 =================

async function main() {
    console.log('--- 🛡️ XtunArgo Docker 运维版 ---');
    console.log(`[📌 配置] 端口: ${USER_VARS.wsPort}`);
    console.log(`[📌 配置] 重启周期: ${CONFIG.rebootInterval / 3600000} 小时`);
    
    await ensureBinaries();
    const keys = Object.keys(CONFIG.services);
    for (let i = 0; i < keys.length; i++) {
        setTimeout(() => startService(keys[i]), i * 3000);
    }
    setInterval(stopAll, CONFIG.rebootInterval);
}

main().catch(err => console.error('[🔥 崩溃]', err));
setInterval(() => {}, 1000 * 60 * 60);
