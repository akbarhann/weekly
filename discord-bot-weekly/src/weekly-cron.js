/**
 * src/weekly-cron.js
 * ══════════════════════════════════════════════════════════════
 *  Automated Weekly Scraper Scheduler (Cron Job)
 *  Runs every Monday at 05:00 WIB.
 *  Sends live-updated progress embeds via Discord Webhook.
 * ══════════════════════════════════════════════════════════════
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { runWeeklyPipeline } = require('../bridge/run_weekly_pipeline');

const WEBHOOK_URL = 'https://discord.com/api/webhooks/1518503527599706193/J8XzBLRAZprmqnmpUamc5KNQtF9ABhWm66iAQnvZEkTzOy8m0GghsxCz6HVINdHCs-x8';
const APPS_SCRIPT_DRIVE_URL = 'https://script.google.com/macros/s/AKfycbxmU3_gc8rAMXGyhsLGBv5RHaV-hAcFkgxG6ijF8YwpbU_LfdH6LBHFMqddaAzvmhKlwA/exec';
const WEEKLY_DIR = path.resolve(__dirname, '..', '..');

// Helper to send Webhook messages (POST for new message, PATCH for edits)
function sendWebhook(urlStr, payload, method = 'POST') {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const postData = JSON.stringify(payload);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(data ? JSON.parse(data) : null);
                    } catch (e) {
                        resolve(null);
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.write(postData);
        req.end();
    });
}

// Helper to upload files to Google Drive (exactly like the command modals)
function uploadToDrive(url, payload) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const postData = JSON.stringify(payload);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = res.headers.location;
                https.get(redirectUrl, (redirectRes) => {
                    let data = '';
                    redirectRes.on('data', (chunk) => data += chunk);
                    redirectRes.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            reject(new Error(`Failed to parse response: ${data}`));
                        }
                    });
                }).on('error', (err) => reject(err));
                return;
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse response: ${data}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.write(postData);
        req.end();
    });
}

// Calculate start and end date of last week (Monday to Sunday) in WIB
function getPreviousWeekRange() {
    const now = new Date();
    // Convert to WIB (GMT+7) safely regardless of system timezone
    const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
    const wibTime = new Date(utcTime + 7 * 3600000);
    
    const dayOfWeek = wibTime.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const diffToLastMonday = (dayOfWeek === 0 ? 6 : dayOfWeek - 1) + 7;
    
    const lastMonday = new Date(wibTime);
    lastMonday.setDate(wibTime.getDate() - diffToLastMonday);
    
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);
    
    const formatDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };
    
    return {
        startDate: formatDate(lastMonday),
        endDate: formatDate(lastSunday)
    };
}

// Runs pipeline for a specific target (agency / vb)
async function runTargetPipeline(target, startDate, endDate) {
    const startTime = Date.now();
    let currentLog = 'Menyiapkan penarikan data...';
    let lastUpdate = 0;
    let updateTimeout = null;
    let currentStep = 1;
    let currentPlatform = 'ALL';
    let currentMerchant = 'Menunggu...';
    let messageId = null;

    const buildEmbed = (progressStep, extraLog) => {
        let progressLabel = '';
        let color = 0x5865F2; // Default blue/purple
        
        if (progressStep === 5) {
            progressLabel = '✅ Completed';
            color = 0x00C853; // Green
        } else if (progressStep === -1) {
            progressLabel = '❌ Failed / Timeout';
            color = 0xFF0000; // Red
        } else {
            switch (progressStep) {
                case 1: progressLabel = '⚙️ Initial setup & validation'; break;
                case 2: progressLabel = '⏸️ Pausing warmer & acquiring lock'; break;
                case 3: progressLabel = `Running weekly scraper [${currentPlatform}] (${currentMerchant})`; break;
                case 4: progressLabel = '📦 Generating and merging Excel reports'; break;
            }
        }

        const isVB = target.toLowerCase() === 'vb';
        const titleText = isVB ? '📊 Weekly Cron: VB Performance' : '📊 Weekly Cron: Agency Performance';
        const embedColor = isVB ? 0x00D0F2 : 0x5865F2; // Matches slash command colors

        return {
            embeds: [
                {
                    color: progressStep === 5 ? 0x00C853 : (progressStep === -1 ? 0xFF0000 : embedColor),
                    title: titleText,
                    description: 
                        `Weekly pipeline sedang dijalankan otomatis via Cron Job.\n\n` +
                        `> 🏢 **Tipe:** ${target.toUpperCase()}\n` +
                        `> 📍 **Platform:** ALL\n` +
                        `> 📅 **Rentang:** ${startDate} s/d ${endDate}\n\n` +
                        `**Status saat ini:**\n${progressLabel}\n\n` +
                        `**Log aktivitas terbaru:**\n` +
                        `\`\`\`\n${extraLog || currentLog}\n\`\`\``,
                    footer: { text: 'Sistem Weekly Automation' },
                    timestamp: new Date().toISOString()
                }
            ]
        };
    };

    const performWebhookEdit = async () => {
        if (!messageId) return;
        const payload = buildEmbed(currentStep, currentLog);
        try {
            await sendWebhook(`${WEBHOOK_URL}/messages/${messageId}`, payload, 'PATCH');
        } catch (err) {
            console.error(`[CRON-${target.toUpperCase()}] Failed to edit webhook:`, err.message);
        }
    };

    const triggerWebhookEdit = () => {
        const now = Date.now();
        const timeSinceLast = now - lastUpdate;
        if (timeSinceLast >= 2000) {
            lastUpdate = now;
            if (updateTimeout) {
                clearTimeout(updateTimeout);
                updateTimeout = null;
            }
            performWebhookEdit();
        } else {
            if (!updateTimeout) {
                updateTimeout = setTimeout(() => {
                    lastUpdate = Date.now();
                    updateTimeout = null;
                    performWebhookEdit();
                }, 2000 - timeSinceLast);
            }
        }
    };

    // Create initial Webhook Message
    try {
        console.log(`[CRON] Starting weekly pipeline for ${target}...`);
        const initPayload = buildEmbed(1);
        const res = await sendWebhook(`${WEBHOOK_URL}?wait=true`, initPayload, 'POST');
        if (res && res.id) {
            messageId = res.id;
        }
    } catch (err) {
        console.error(`[CRON-${target.toUpperCase()}] Failed to send initial webhook:`, err.message);
    }

    const formData = {
        target,
        platform: 'all',
        startDate,
        endDate,
        outlet: '',
        branch: '',
        user: '',
        skipExisting: false,
        channelId: ''
    };

    return new Promise((resolve) => {
        const pipeline = runWeeklyPipeline(formData, (logLine) => {
            const cleanLines = logLine.split('\n').map(l => l.trim()).filter(Boolean);
            let stateChanged = false;

            for (const line of cleanLines) {
                currentLog = line;

                if (line.includes('[JOB LOCK]') || line.includes('[WARMER]')) {
                    if (currentStep < 2) { currentStep = 2; stateChanged = true; }
                } else if (line.includes('Menjalankan:') || line.includes('PHASE 1') || line.includes('Starting for:') || line.includes('Processing:')) {
                    if (currentStep < 3) { currentStep = 3; stateChanged = true; }
                } else if (line.includes('PHASE 3') || line.includes('PHASE 4') || line.includes('Master Aggregation') || line.includes('Merging') || line.includes('Combining')) {
                    if (currentStep < 4) { currentStep = 4; stateChanged = true; }
                    if (currentMerchant !== 'Merging & finishing...') {
                        currentMerchant = 'Merging & finishing...';
                        stateChanged = true;
                    }
                }

                // Parse platform
                if (line.toUpperCase().includes('GRAB MULTI-PORTAL') || line.toUpperCase().includes('GRAB PIPELINE') || line.toUpperCase().includes('GRAB AUTO')) {
                    if (currentPlatform !== 'GRAB') { currentPlatform = 'GRAB'; stateChanged = true; }
                } else if (line.toUpperCase().includes('SHOPEE WEEKLY') || line.toUpperCase().includes('SHOPEE PIPELINE')) {
                    if (currentPlatform !== 'SHOPEE') { currentPlatform = 'SHOPEE'; stateChanged = true; }
                } else if (line.toUpperCase().includes('GOFOOD WEEKLY') || line.toUpperCase().includes('GOFOOD PIPELINE')) {
                    if (currentPlatform !== 'GOFOOD') { currentPlatform = 'GOFOOD'; stateChanged = true; }
                }

                // Parse merchant
                let match = line.match(/Starting for:\s*[^\s(]+\s*\(([^)]+)\)/i);
                if (match && currentMerchant !== match[1].trim()) { currentMerchant = match[1].trim(); stateChanged = true; }

                let matchRetry = line.match(/Re-running sequentially for:\s*(.*)/i);
                if (matchRetry && currentMerchant !== matchRetry[1].trim()) { currentMerchant = matchRetry[1].trim(); stateChanged = true; }

                let matchPortal = line.match(/✓\s*\[PORTAL\s*\d+\]\s*([^-—]+)/i);
                if (matchPortal && currentMerchant !== matchPortal[1].trim()) { currentMerchant = matchPortal[1].trim(); stateChanged = true; }

                let matchShopee = line.match(/Processing:\s*(.*)/i);
                if (matchShopee && currentMerchant !== matchShopee[1].trim()) { currentMerchant = matchShopee[1].trim(); stateChanged = true; }

                let matchPoll = line.match(/downloading report for\s*([^.]+)/i);
                if (matchPoll && currentMerchant !== matchPoll[1].trim()) { currentMerchant = matchPoll[1].trim(); stateChanged = true; }
            }

            const now = Date.now();
            if (stateChanged || (now - lastUpdate > 5000)) {
                triggerWebhookEdit();
            }
        });

        pipeline.promise.then(async (result) => {
            if (updateTimeout) {
                clearTimeout(updateTimeout);
                updateTimeout = null;
            }

            const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
            const durationStr = `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;

            if (result.success) {
                currentStep = 5;
                const uploadedFiles = [];
                let uploadedFolderUrl = null;
                const searchPaths = target === 'agency' ? ['grab', 'shopee', 'gofood'] : ['grab', 'shopee'];

                for (const plat of searchPaths) {
                    const platDirName = target === 'vb' ? `${plat}_vb` : plat;
                    const dir = path.join(WEEKLY_DIR, 'laporan', platDirName, `${startDate}_to_${endDate}`);
                    if (fs.existsSync(dir)) {
                        const dirFiles = fs.readdirSync(dir);
                        for (const file of dirFiles) {
                            if (file.endsWith('.xlsx')) {
                                const filePath = path.join(dir, file);
                                const stats = fs.statSync(filePath);

                                // Upload generated/modified files from this run
                                if (stats.mtimeMs >= startTime) {
                                    try {
                                        const fileContent = fs.readFileSync(filePath);
                                        const base64Content = fileContent.toString('base64');

                                        console.log(`[CRON-DRIVE] Uploading ${file} to Google Drive...`);
                                        const driveRes = await uploadToDrive(APPS_SCRIPT_DRIVE_URL, {
                                            folderId: "1AF7zvgT0fuMTzTrXV_FKwUWj1R7JeOcx",
                                            platform: target === 'vb' ? `${plat.toUpperCase()}_VB` : plat.toUpperCase(),
                                            dateRange: `${startDate}_to_${endDate}`,
                                            filename: file,
                                            content: base64Content
                                        });

                                        if (driveRes && driveRes.status === 'success') {
                                            uploadedFiles.push({
                                                name: file,
                                                url: driveRes.url
                                            });
                                            if (driveRes.folderUrl) {
                                                uploadedFolderUrl = driveRes.folderUrl;
                                            }
                                        }
                                    } catch (uploadErr) {
                                        console.error(`[CRON-DRIVE] Error uploading ${file}:`, uploadErr);
                                    }
                                }
                            }
                        }
                    }
                }

                let driveStatus = '';
                if (uploadedFiles.length > 0) {
                    const folderLink = uploadedFolderUrl || "https://drive.google.com/";
                    driveStatus = `📂 **Google Drive Folder:** [Buka Folder Rentang Tanggal](${folderLink})\n` +
                                  `*Berhasil mengunggah ${uploadedFiles.length} file (Master + Rincian).*`;
                } else {
                    driveStatus = '❌ *Gagal mengunggah file laporan ke Google Drive.*';
                }

                const successEmbed = {
                    embeds: [
                        {
                            color: 0x00C853, // Green
                            title: `✅ Weekly Cron Selesai: ${target.toUpperCase()}`,
                            description:
                                `Pipeline weekly ${target.toUpperCase()} selesai dijalankan secara otomatis.\n\n` +
                                `> 🏢 **Tipe:** ${target.toUpperCase()}\n` +
                                `> 📍 **Platform:** ALL\n` +
                                `> 📅 **Rentang:** ${startDate} s/d ${endDate}\n` +
                                `> ⏱️ **Durasi:** ${durationStr}\n\n` +
                                `${driveStatus}`,
                            footer: { text: 'Sistem Weekly Automation' },
                            timestamp: new Date().toISOString()
                        }
                    ]
                };

                if (messageId) {
                    await sendWebhook(`${WEBHOOK_URL}/messages/${messageId}`, successEmbed, 'PATCH').catch(() => {});
                }
            } else {
                currentStep = -1;
                const errSnippet = result.output.slice(-600)
                    .replace(/\x1B\[[0-9;]*m/g, '')
                    .replace(/```/g, "'''");

                const failedEmbed = {
                    embeds: [
                        {
                            color: 0xFF0000, // Red
                            title: `❌ Weekly Cron Gagal: ${target.toUpperCase()}`,
                            description:
                                `Pipeline weekly ${target.toUpperCase()} gagal dijalankan secara otomatis.\n\n` +
                                `**Exit Code:** \`${result.exitCode}\`\n` +
                                `**Log terakhir:**\n` +
                                `\`\`\`\n${errSnippet || 'Tidak ada detail error.'}\n\`\`\``,
                            footer: { text: 'Sistem Weekly Automation' },
                            timestamp: new Date().toISOString()
                        }
                    ]
                };

                if (messageId) {
                    await sendWebhook(`${WEBHOOK_URL}/messages/${messageId}`, failedEmbed, 'PATCH').catch(() => {});
                }
            }
            resolve();
        });
    });
}

// Runs both pipelines sequentially
async function runWeeklyCronJob() {
    const { startDate, endDate } = getPreviousWeekRange();
    console.log(`[CRON] Starting weekly automated job for range: ${startDate} to ${endDate}`);
    
    // 1. Run Agency Pipeline
    try {
        await runTargetPipeline('agency', startDate, endDate);
    } catch (err) {
        console.error('[CRON] Agency weekly execution error:', err);
    }

    // 2. Run VB Pipeline
    try {
        await runTargetPipeline('vb', startDate, endDate);
    } catch (err) {
        console.error('[CRON] VB weekly execution error:', err);
    }
    
    console.log('[CRON] Weekly automated job completed.');
}

// Main Cron Scheduling Loop
function scheduleNextWeeklyRun() {
    const now = new Date();
    const nowMs = now.getTime();
    
    // Calculate current WIB (GMT+7) date/time
    const wibMs = nowMs + (7 * 60 * 60 * 1000);
    const wibDate = new Date(wibMs);
    const currentWibDay = wibDate.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    
    let daysToAdd = (1 - currentWibDay + 7) % 7;
    
    const nextRunWib = new Date(wibDate);
    nextRunWib.setUTCHours(5, 0, 0, 0); // Target is 05:00:00 WIB
    
    // If today is Monday and time is >= 05:00 WIB, schedule for next week
    if (daysToAdd === 0 && wibDate.getUTCHours() >= 5) {
        daysToAdd = 7;
    }
    
    nextRunWib.setUTCDate(wibDate.getUTCDate() + daysToAdd);
    
    // Convert target WIB back to UTC milliseconds
    const nextRunMs = nextRunWib.getTime() - (7 * 60 * 60 * 1000);
    const nextRun = new Date(nextRunMs);
    
    const delay = nextRun.getTime() - now.getTime();
    console.log(`[CRON] Current WIB time: ${wibDate.toUTCString().replace('GMT', 'WIB')}`);
    console.log(`[CRON] Next weekly run scheduled for (WIB): ${nextRunWib.toUTCString().replace('GMT', 'WIB')}`);
    console.log(`[CRON] Delay to next run: ${delay} ms (${Math.floor(delay / 60000)} minutes)`);
    
    if (delay > 0) {
        setTimeout(() => {
            console.log('[CRON] Executing scheduled weekly job...');
            runWeeklyCronJob()
                .catch(err => console.error('[CRON] Error during execution:', err))
                .finally(() => {
                    scheduleNextWeeklyRun();
                });
        }, delay);
    } else {
        setTimeout(scheduleNextWeeklyRun, 60000);
    }
}

module.exports = {
    runWeeklyCronJob,
    scheduleNextWeeklyRun
};
