const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

//xtunargotest.frpnas.tk:443
// ================= 1. 用户变量配置区 =================
const USER_VARS = {
    // Komari Agent 配置 (请确保域名带上 http:// 或 https://)
    komariEndpoint: 'https://komari.mygcp.tk', 
    komariToken: 'Q2gTdIOfrQz00t8T',      
    
    // Cloudflare Token
    cfToken: 'eyJhIjoiZGRmMDQyNTdiMmRlMTkyNDMyOGZhMDI1ODcwYWYxMmEiLCJ0IjoiNzUwZjQyYjQtZjM5Ny00NzAxLWIwZTEtM2JjMGJkMTkzMTA1IiwicyI6IlltSTBNakZqTkRZdFpHWmpOQzAwTW1Ka0xUbGxOMk10WWpFNU5qWXlPVGxpTW1abCJ9'
};

// ================= 2. 系统核心配置 =================
const CONFIG = {
    // 自动映射架构 (Node process.arch 转为标准 Linux arch)
    arch: process.arch === 'x64' ? 'amd64' : (process.arch === 'arm64' ? 'arm64' : 'amd64'),
    
    // GitHub 加速镜像列表
    mirrors: ['', 'https://mirror.ghproxy.com/', 'https://ghfast.top/'],
    
    services: {
        xtunnel: {
            bin: './x-tunnel-linux',
            url: (arch) => `https://www.baipiao.eu.org/xtunnel/x-tunnel-linux-${arch}`,
            args: ['-l', 'ws://127.0.0.1:20007', '-token', 'fxpass']
        },
        cloudflared: {
            bin: './cloudflared-linux',
            url: (arch) => `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`,
            args: ['tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', 'run', '--token', USER_VARS.cfToken]
        },
        komari: {
            bin: './komari-agent', // 统一命名为 komari-agent
            // 修正后的下载路径：必须包含 agent 字样
            url: (arch) => `https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-${arch}`,
            // 修正后的启动参数：使用 -e 指定服务端地址
            args: ['-e', USER_VARS.komariEndpoint, '-t', USER_VARS.komariToken]
        }
    },
    
    monitorPort: 20007,
    rebootInterval: 8 * 60 * 60 * 1000 // 8小时自动刷新
};

const INSTANCES = { xtunnel: null, cloudflared: null, komari: null };

// ================= 3. 增强型下载逻辑 =================

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
            
            if (!res.ok) {
                console.warn(`      - 状态码错误: ${res.status}`);
                continue;
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            
            // 确保下载的不是 404 页面或损坏文件
            if (buffer.length < 5000) throw new Error('下载文件体积异常，可能非二进制程序');
            
            fs.writeFileSync(dest, buffer);
            fs.chmodSync(dest, 0o755);
            console.log(`[✅ 成功] ${dest} 已就绪`);
            return true;
        } catch (err) { console.warn(`      - 失败: ${err.message}`); }
    }
    return false;
}

async function ensureBinaries() {
    console.log(`[🔍 系统] 检测到架构: ${CONFIG.arch}`);
    for (const key in CONFIG.services) {
        const item = CONFIG.services[key];
        if (!fs.existsSync(item.bin)) {
            console.log(`[📦 缺失] 正在获取: ${item.bin}`);
            const success = await downloadFile(item.url(CONFIG.arch), item.bin);
            if (!success) {
                console.error(`[❌ 致命] 无法下载 ${key}。15秒后重试...`);
                await new Promise(r => setTimeout(r, 15000));
                return ensureBinaries();
            }
        } else {
            fs.chmodSync(item.bin, 0o755);
            console.log(`[🆗 存在] ${item.bin} 已就绪`);
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
        console.log(`[⚠️ 警告] ${key.toUpperCase()} 已退出 (代码: ${code})，5秒后重启...`);
        setTimeout(() => startService(key), 5000);
    });
}

function stopAll() {
    console.log('\n[⏰ 周期] 执行 8 小时例行刷新...');
    for (const key in INSTANCES) {
        if (INSTANCES[key]) INSTANCES[key].kill();
    }
}

// ================= 5. 入口 =================

async function main() {
    console.log('--- 🛡️ XtunArgo 运维系统 V2.1  ---');
    await ensureBinaries();

    // 顺序启动
    const keys = Object.keys(CONFIG.services);
    for (let i = 0; i < keys.length; i++) {
        setTimeout(() => startService(keys[i]), i * 3000);
    }
    
    // 8 小时强制重启任务
    setInterval(stopAll, CONFIG.rebootInterval);
}

main().catch(err => console.error('[🔥 崩溃]', err));
setInterval(() => {}, 1000 * 60 * 60);
