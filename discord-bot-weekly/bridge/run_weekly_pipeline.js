/**
 * bridge/run_weekly_pipeline.js
 * ══════════════════════════════════════════════════════════════
 *  Jembatan Node.js → Python weekly/cli.py
 *  Dipanggil oleh agency.js setelah form Discord selesai diisi.
 * ══════════════════════════════════════════════════════════════
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Locate target weekly directory (either 'agency' or 'VB')
function getWeeklyTargetDir(target) {
    let dir = path.resolve(__dirname, '..', '..', target);
    if (fs.existsSync(dir)) {
        return dir;
    }
    dir = path.resolve(__dirname, '..', '..', 'weekly', target);
    if (fs.existsSync(dir)) {
        return dir;
    }
    return path.resolve(__dirname, '..', '..', target);
}

// Locate src directory
function getSrcDir() {
    let dir = path.resolve(__dirname, '..', '..', 'src');
    if (fs.existsSync(dir)) {
        return dir;
    }
    dir = path.resolve(__dirname, '..', '..', '..', 'src');
    if (fs.existsSync(dir)) {
        return dir;
    }
    return path.resolve(__dirname, '..', '..', 'src');
}

// OFD Job Lock
const SRC_DIR = getSrcDir();
const OFD_JOB_LOCK_PATH = path.join(
    SRC_DIR,
    'shopee-omzet-automation',
    'data',
    'ofd_job.lock'
);

function acquireJobLock(onLog = console.log) {
    try {
        fs.mkdirSync(path.dirname(OFD_JOB_LOCK_PATH), { recursive: true });
        fs.writeFileSync(
            OFD_JOB_LOCK_PATH,
            JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }),
            'utf8'
        );
        onLog(`🔒 [JOB LOCK] Acquired: ${OFD_JOB_LOCK_PATH}`);
    } catch (err) {
        onLog(`⚠️ [JOB LOCK] Gagal menulis lock file: ${err.message}`);
    }
}

function releaseJobLock(onLog = console.log) {
    try {
        if (fs.existsSync(OFD_JOB_LOCK_PATH)) {
            fs.unlinkSync(OFD_JOB_LOCK_PATH);
            onLog(`🔓 [JOB LOCK] Released: ${OFD_JOB_LOCK_PATH}`);
        }
    } catch (err) {
        onLog(`⚠️ [JOB LOCK] Gagal menghapus lock file: ${err.message}`);
    }
}

function controlWarmer(action, onLog = console.log) {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        const cmdMap = {
            'pause': 'sudo systemctl stop shopee-warmer',
            'unpause': 'sudo systemctl start shopee-warmer'
        };
        const cmd = cmdMap[action];
        if (!cmd) {
            onLog(`⚠️ [WARMER] Action tidak dikenal: ${action}`);
            return resolve(false);
        }

        onLog(`🔌 [WARMER] Executing: ${cmd}...`);
        exec(cmd, (err, stdout, stderr) => {
            if (err) {
                onLog(`⚠️ [WARMER] Gagal melakukan ${action} pada shopee-warmer.service: ${err.message}`);
                resolve(false);
            } else {
                onLog(`✅ [WARMER] Service shopee-warmer berhasil di-${action === 'pause' ? 'hentikan' : 'aktifkan kembali'}.`);
                resolve(true);
            }
        });
    });
}

/**
 * Jalankan pipeline Weekly Agency dari formData
 *
 * @param {Object}   formData
 * @param {string}   formData.platform        - "grab" | "shopee" | "all"
 * @param {string}   formData.startDate       - "YYYY-MM-DD"
 * @param {string}   formData.endDate         - "YYYY-MM-DD"
 * @param {string}   [formData.outlet]        - nama outlet
 * @param {string}   [formData.branch]        - nama cabang
 * @param {string}   [formData.user]          - user Grab
 * @param {Function} [onLog]                  - Callback(line:string) untuk live log
 * @returns {Promise<{success:boolean, exitCode:number, output:string}>}
 */
function runWeeklyPipeline(formData, onLog = () => { }) {
    const pipelineObj = {
        promise: null,
        proc: null
    };
    pipelineObj.promise = new Promise(async (resolve) => {
        const { target, platform, startDate, endDate, outlet, branch, user } = formData;

        const WEEKLY_DIR = getWeeklyTargetDir(target || 'agency');
        const VENV_PY = path.join(WEEKLY_DIR, '.venv', 'bin', 'python');
        const PYTHON_EXE = fs.existsSync(VENV_PY) ? VENV_PY : 'python3';
        const CLI_PATH = path.join(WEEKLY_DIR, 'cli.py');

        // 1. Acquire job lock + Pause warmer sebelum memulai pipeline
        acquireJobLock(onLog);
        await controlWarmer('pause', onLog);

        const env = {
            ...process.env,
            OFD_DISCORD_MODE: '1',
            OFD_WEBHOOK_URL: process.env.WEBHOOK_URL || '',
            OFD_CHANNEL_ID: formData.channelId || '',
            PYTHONUNBUFFERED: '1'
        };

        // ── Argumen CLI ─────────────────────────────────────────────
        const args = [
            '-u',
            CLI_PATH,
            platform,
            '--start', startDate,
            '--end', endDate,
        ];

        if (outlet) {
            args.push('--outlet', outlet);
        }
        if (branch) {
            args.push('--branch', branch);
        }
        if (user) {
            args.push('--user', user);
        }
        if (formData.skipExisting) {
            args.push('--skip-existing');
        }

        onLog(`🚀 Menjalankan: \`${PYTHON_EXE} cli.py ${args.slice(1).join(' ')}\``);
        onLog(`📦 Platform: **${platform.toUpperCase()}** | Tanggal: **${startDate}** s/d **${endDate}**`);
        if (outlet) onLog(`📍 Outlet: **${outlet}**`);
        if (branch) onLog(`🌿 Cabang: **${branch}**`);
        if (user) onLog(`👤 User: **${user}**`);
        if (formData.skipExisting) onLog(`⏭️ Mode: **Skip Existing (Hanya yang belum)**`);

        let output = '';

        const readline = require('readline');
        
        const proc = spawn(PYTHON_EXE, args, {
            cwd: WEEKLY_DIR,
            env,
            detached: true,
        });
        pipelineObj.proc = proc;

        const rlStdout = readline.createInterface({ input: proc.stdout });
        rlStdout.on('line', (line) => {
            output += line + '\n';
            process.stdout.write(line + '\n');
            const clean = line.replace(/\x1B\[[0-9;]*m/g, '').trim();
            if (clean) onLog(clean);
        });

        const rlStderr = readline.createInterface({ input: proc.stderr });
        rlStderr.on('line', (line) => {
            output += line + '\n';
            process.stderr.write(line + '\n');
        });

        const cleanupAndResolve = async (data) => {
            await controlWarmer('unpause', onLog);
            
            if (pipelineObj.proc && pipelineObj.proc.pid) {
                try {
                    onLog(`🧹 [CLEANUP] Cleaning up process group ${pipelineObj.proc.pid}...`);
                    process.kill(-pipelineObj.proc.pid, 'SIGKILL');
                } catch (e) {
                }
            }

            releaseJobLock(onLog);
            resolve(data);
        };

        proc.on('close', async (exitCode) => {
            await cleanupAndResolve({
                success: exitCode === 0,
                exitCode: exitCode ?? -1,
                output: output.trim()
            });
        });

        proc.on('error', async (err) => {
            await cleanupAndResolve({
                success: false,
                exitCode: -1,
                output: `Gagal memulai proses: ${err.message}`,
            });
        });
    });
    return pipelineObj;
}

module.exports = { runWeeklyPipeline };
