const {
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    AttachmentBuilder,
    StringSelectMenuBuilder
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { runWeeklyPipeline } = require('../../../bridge/run_weekly_pipeline');

// Path to weekly directory resolver
function getWeeklyTargetDir(target) {
    const dir = path.resolve(__dirname, '../../../../', target);
    if (fs.existsSync(dir)) {
        return dir;
    }
    const nestedDir = path.resolve(__dirname, '../../../../weekly', target);
    if (fs.existsSync(nestedDir)) {
        return nestedDir;
    }
    return dir;
}

// Gantilah URL di bawah ini dengan URL Web App dari Apps Script Anda setelah di-deploy
const APPS_SCRIPT_DRIVE_URL = "https://script.google.com/macros/s/AKfycbxmU3_gc8rAMXGyhsLGBv5RHaV-hAcFkgxG6ijF8YwpbU_LfdH6LBHFMqddaAzvmhKlwA/exec";

// Memory lock for active weekly pipeline jobs
let isWeeklyJobRunning = false;
let activeWeeklyProcess = null;

// GSheets caching specifically for weekly merchants (gid=0)
let cachedWeeklySheetData = null;
let lastWeeklyCacheTime = 0;
const WEEKLY_CACHE_DURATION = 30 * 1000; // 30 seconds cache

function resolveShopeeMerchant(outletName) {
    if (!cachedWeeklySheetData) return outletName;
    const lines = cachedWeeklySheetData.split(/\r?\n/);
    if (lines.length < 2) return outletName;

    const headers = lines[0].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(h => h.trim().replace(/^"|"$/g, ''));
    const appIdx = headers.indexOf('Aplikasi');
    const nameIdx = headers.indexOf('Nama Outlet');
    const merchantIdx = headers.indexOf('Merchant Name');

    if (appIdx === -1 || nameIdx === -1 || merchantIdx === -1) return outletName;

    const outletLower = outletName.trim().toLowerCase();
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());
        if (cols.length <= Math.max(appIdx, nameIdx, merchantIdx)) continue;

        const app = cols[appIdx].toLowerCase();
        const name = cols[nameIdx].trim().toLowerCase();
        const merchant = cols[merchantIdx].trim();

        if (app.includes('shopee') && name === outletLower && merchant && merchant !== '-' && merchant !== 'nan') {
            return merchant;
        }
    }
    return outletName;
}

function isOutletDownloaded(target, platform, startDate, endDate, outletName) {
    const WEEKLY_DIR = getWeeklyTargetDir(target);
    const outputDir = path.join(WEEKLY_DIR, 'laporan', platform, `${startDate}_to_${endDate}`);
    if (!fs.existsSync(outputDir)) return false;

    let checkName = outletName;
    if (platform === 'shopee') {
        checkName = resolveShopeeMerchant(outletName);
    }

    try {
        const files = fs.readdirSync(outputDir);
        const cleanName = checkName.trim().toLowerCase();
        return files.some(file => {
            const fLower = file.toLowerCase();
            return fLower.startsWith(cleanName + '_') && fLower.endsWith('.xlsx');
        });
    } catch (err) {
        return false;
    }
}

async function askRemainingSelection(interaction, { stepName, title, placeholder, options, allRemainingValues, fields = [], hasOutletStep = true, isAllPlatform = false }) {
    let selectedValues = new Set();

    const getComponents = () => {
        const rows = [];
        const chunks = [];
        for (let i = 0; i < options.length; i += 25) {
            chunks.push(options.slice(i, i + 25));
        }

        const safeChunks = chunks.slice(0, 3); // Limit to 3 menus
        safeChunks.forEach((chunk, index) => {
            const currentMax = Math.min(chunk.length, 25);

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`agency_remaining_menu_${index}`)
                .setPlaceholder(placeholder)
                .setMinValues(1)
                .setMaxValues(currentMax)
                .addOptions(chunk.map(opt => ({
                    label: opt.label,
                    value: opt.value,
                    default: selectedValues.has(opt.value)
                })));

            rows.push(new ActionRowBuilder().addComponents(selectMenu));
        });

        const buttonsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('agency_back_btn')
                .setLabel('⬅️ Kembali')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('agency_run_all_remaining_btn')
                .setLabel('🟢 Jalankan Semua')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('agency_continue_btn')
                .setLabel(selectedValues.size > 0 ? '➡️ Lanjutkan' : 'Pilih opsi terlebih dahulu')
                .setStyle(selectedValues.size > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(selectedValues.size === 0)
        );

        rows.push(buttonsRow);
        return rows;
    };

    const getEmbed = () => {
        const selectedArray = Array.from(selectedValues);
        let description = `Pilih outlet spesifik yang ingin dijalankan dari menu, atau klik **Jalankan Semua** untuk memproses seluruh ${allRemainingValues.length} outlet tersisa.\n\n`;
        if (selectedArray.length > 0) {
            const labelList = selectedArray.map(val => {
                const found = options.find(opt => opt.value === val);
                return found ? found.label : val;
            }).join(', ');

            const displayList = labelList.length > 300 ? labelList.substring(0, 297) + '...' : labelList;
            description += `🔹 **Pilihan saat ini:** ${displayList}`;
        } else {
            description += `⚠️ *Belum ada opsi terpilih (Gunakan dropdown atau klik Jalankan Semua)*`;
        }

        return makeProgressEmbed(stepName, title, description, fields, hasOutletStep, isAllPlatform);
    };

    await interaction.update({
        embeds: [getEmbed()],
        components: getComponents()
    });

    const message = interaction.message || await interaction.fetchReply();

    return new Promise((resolve, reject) => {
        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 300000
        });

        let latestInteraction = null;

        collector.on('collect', async i => {
            latestInteraction = i;
            if (i.customId.startsWith('agency_remaining_menu_')) {
                const menuIndex = parseInt(i.customId.split('_').pop());
                const currentChunk = options.slice(menuIndex * 25, (menuIndex + 1) * 25);

                currentChunk.forEach(opt => selectedValues.delete(opt.value));
                i.values.forEach(val => selectedValues.add(val));

                await i.update({
                    embeds: [getEmbed()],
                    components: getComponents()
                });
            } else if (i.customId === 'agency_run_all_remaining_btn') {
                collector.stop('all_remaining');
            } else if (i.customId === 'agency_continue_btn') {
                collector.stop('confirmed');
            } else if (i.customId === 'agency_back_btn') {
                collector.stop('back');
            }
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'all_remaining' && latestInteraction) {
                resolve({ status: 'next', values: allRemainingValues, lastInteraction: latestInteraction });
            } else if (reason === 'confirmed' && latestInteraction) {
                resolve({ status: 'next', values: Array.from(selectedValues), lastInteraction: latestInteraction });
            } else if (reason === 'back' && latestInteraction) {
                resolve({ status: 'back', lastInteraction: latestInteraction });
            } else {
                reject(new Error('Timeout or cancelled'));
            }
        });
    });
}

function fetchCSV(url) {
    return new Promise((resolve, reject) => {
        const fetchUrl = (currentUrl) => {
            https.get(currentUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return fetchUrl(res.headers.location);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP Status ${res.statusCode}`));
                }
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => resolve(data));
            }).on('error', (err) => reject(err));
        };
        fetchUrl(url + '&t=' + Date.now());
    });
}

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
            // Google Apps Script redirects with 302 Found
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = res.headers.location;
                // Follow the redirect using a GET request
                https.get(redirectUrl, (redirectRes) => {
                    let data = '';
                    redirectRes.on('data', (chunk) => data += chunk);
                    redirectRes.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            resolve(parsed);
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
                    const parsed = JSON.parse(data);
                    resolve(parsed);
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

async function getWeeklyOutlets(platform) {
    const now = Date.now();
    let csvData;
    if (cachedWeeklySheetData && (now - lastWeeklyCacheTime < WEEKLY_CACHE_DURATION)) {
        csvData = cachedWeeklySheetData;
    } else {
        const url = 'https://docs.google.com/spreadsheets/d/14eCb8DAEXhmbYj9MFj2KzC7AhkulbCbSNPltN2m-go0/export?format=csv&gid=0';
        csvData = await fetchCSV(url);
        cachedWeeklySheetData = csvData;
        lastWeeklyCacheTime = now;
    }

    const lines = csvData.split(/\r?\n/);
    if (lines.length < 2) return [];

    const headers = lines[0].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(h => h.trim().replace(/^"|"$/g, ''));
    const appIdx = headers.indexOf('Aplikasi');
    const statusIdx = headers.indexOf('Status');
    const nameIdx = headers.indexOf('Nama Outlet');
    const userIdx = headers.lastIndexOf('Nama Pengguna');
    const merchantIdx = headers.indexOf('Merchant Name');

    if (appIdx === -1 || statusIdx === -1 || nameIdx === -1) {
        console.error('[WEEKLY FETCH] Headers not found in GSheets gid=0:', headers);
        return [];
    }

    const outletsSet = new Set();

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());

        // Ensure cols has enough elements for the standard fields
        const requiredMax = Math.max(appIdx, statusIdx, nameIdx);
        if (cols.length <= requiredMax) continue;

        const app = cols[appIdx].toLowerCase();
        const status = cols[statusIdx].toLowerCase();
        const name = cols[nameIdx];

        if (!name || name === '-') continue;
        if (status !== 'live') continue;

        const userVal = userIdx !== -1 && cols[userIdx] ? cols[userIdx].trim() : '';
        const merchantVal = merchantIdx !== -1 && cols[merchantIdx] ? cols[merchantIdx].trim() : '';

        const isValidGrab = app.includes('grab') && userVal !== '' && userVal !== '-';
        const isValidShopee = app.includes('shopee') && merchantVal !== '' && merchantVal !== '-';

        const matchesPlatform =
            (platform === 'all' && (isValidGrab || isValidShopee)) ||
            (platform === 'grab' && isValidGrab) ||
            (platform === 'shopee' && isValidShopee);

        if (matchesPlatform) {
            outletsSet.add(name);
        }
    }

    return Array.from(outletsSet).sort((a, b) => a.localeCompare(b));
}

// Progress steps helper
const makeProgressEmbed = (currentStepName, title, description, fields = [], hasOutletStep = true, isAllPlatform = false) => {
    const allSteps = [
        { name: 'Aplikator', icon: '📱' },
        { name: 'Cakupan', icon: '🏢' }
    ];
    if (hasOutletStep) {
        if (isAllPlatform) {
            allSteps.push({ name: 'Outlet Grab', icon: '🏪' });
            allSteps.push({ name: 'Outlet Shopee', icon: '🏪' });
        } else {
            allSteps.push({ name: 'Outlet', icon: '🏪' });
        }
    }
    allSteps.push({ name: 'Periode', icon: '📅' });
    allSteps.push({ name: 'Konfirmasi', icon: '📋' });

    let progressStr = '';
    const currentStepIdx = allSteps.findIndex(s => s.name === currentStepName);

    for (let i = 0; i < allSteps.length; i++) {
        if (i < currentStepIdx) {
            progressStr += `✅ **${allSteps[i].name}**`;
        } else if (i === currentStepIdx) {
            progressStr += `🔵 __**${allSteps[i].name}**__`;
        } else {
            progressStr += `⚪ ${allSteps[i].name}`;
        }
        if (i < allSteps.length - 1) {
            progressStr += ' ➔ ';
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(title)
        .setDescription(`**Langkah Progres:**\n${progressStr}\n\n${description}`)
        .setFooter({ text: 'Sistem Weekly Agency Performance' })
        .setTimestamp();

    if (fields && fields.length > 0) {
        embed.addFields(fields);
    }

    return embed;
};

// Selection helper
async function askSelection(interaction, { stepName, title, placeholder, options, minValues = 1, maxValues = 1, fields = [], isFirstStep = false, hasOutletStep = true, isAllPlatform = false, showBackButton = false, initialSelections = [] }) {
    let selectedValues = new Set(initialSelections);

    const getComponents = () => {
        const rows = [];
        const chunks = [];
        for (let i = 0; i < options.length; i += 25) {
            chunks.push(options.slice(i, i + 25));
        }

        const safeChunks = chunks.slice(0, 4); // Limit to 4 select menus
        safeChunks.forEach((chunk, index) => {
            const currentMax = Math.min(maxValues, chunk.length);

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`agency_selection_menu_${index}`)
                .setPlaceholder(placeholder + (safeChunks.length > 1 ? ` (Bagian ${index + 1})` : ''))
                .setMinValues(0)
                .setMaxValues(currentMax)
                .addOptions(chunk.map(opt => ({
                    ...opt,
                    default: selectedValues.has(opt.value)
                })));

            rows.push(new ActionRowBuilder().addComponents(selectMenu));
        });

        const isDisabled = selectedValues.size < minValues;

        const buttons = [];
        if (showBackButton) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId('agency_back_btn')
                    .setLabel('⬅️ Kembali')
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        buttons.push(
            new ButtonBuilder()
                .setCustomId('agency_continue_btn')
                .setLabel(selectedValues.size >= minValues ? '➡️ Lanjutkan' : (minValues === 1 ? 'Pilih opsi terlebih dahulu' : `Pilih minimal ${minValues} opsi`))
                .setStyle(selectedValues.size >= minValues ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(isDisabled)
        );

        rows.push(new ActionRowBuilder().addComponents(buttons));
        return rows;
    };

    const getEmbed = () => {
        const selectedArray = Array.from(selectedValues);
        let description = `Silakan pilih opsi dari menu di bawah, lalu klik **Lanjutkan**.\n\n`;
        if (selectedArray.length > 0) {
            const labelList = selectedArray.map(val => {
                const found = options.find(opt => opt.value === val);
                return found ? found.label : val;
            }).join(', ');

            const displayList = labelList.length > 300 ? labelList.substring(0, 297) + '...' : labelList;
            description += `🔹 **Pilihan saat ini:** ${displayList}`;
        } else {
            description += `⚠️ *Belum ada opsi terpilih*`;
        }

        return makeProgressEmbed(stepName, title, description, fields, hasOutletStep, isAllPlatform);
    };

    if (isFirstStep) {
        await interaction.editReply({
            embeds: [getEmbed()],
            components: getComponents()
        });
    } else {
        await interaction.update({
            embeds: [getEmbed()],
            components: getComponents()
        });
    }

    const message = isFirstStep ? await interaction.fetchReply() : (interaction.message || await interaction.fetchReply());

    return new Promise((resolve, reject) => {
        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 300000
        });

        let latestInteraction = null;

        collector.on('collect', async i => {
            latestInteraction = i;
            if (i.customId.startsWith('agency_selection_menu')) {
                const menuIndex = parseInt(i.customId.split('_').pop());
                const currentChunk = options.slice(menuIndex * 25, (menuIndex + 1) * 25);

                currentChunk.forEach(opt => selectedValues.delete(opt.value));
                i.values.forEach(val => selectedValues.add(val));

                await i.update({
                    embeds: [getEmbed()],
                    components: getComponents()
                });
            } else if (i.customId === 'agency_continue_btn') {
                collector.stop('confirmed');
            } else if (i.customId === 'agency_back_btn') {
                collector.stop('back');
            }
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'confirmed' && latestInteraction) {
                resolve({ status: 'next', values: Array.from(selectedValues), lastInteraction: latestInteraction });
            } else if (reason === 'back' && latestInteraction) {
                resolve({ status: 'back', lastInteraction: latestInteraction });
            } else {
                reject(new Error('Timeout or cancelled'));
            }
        });
    });
}

// Date helpers
const parseDate = (str) => {
    const parts = str.split('-');
    if (parts.length !== 3) return null;
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;

    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        return null;
    }
    return date;
};

const toISOFormat = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('agency')
        .setDescription('Kirim formulir Laporan Transaksi Mingguan (Weekly) Agency'),

    async execute(interaction) {
        if (isWeeklyJobRunning) {
            return interaction.reply({
                content: '⚠️ **Sistem Sibuk!** Laporan Weekly Agency lain sedang berjalan. Harap tunggu hingga proses sebelumnya selesai.',
                flags: 64
            });
        }

        await interaction.deferReply({ flags: 64 });

        // Pre-fetch weekly sheet data
        try {
            await getWeeklyOutlets('all');
        } catch (err) {
            console.error('[WEEKLY FETCH] Gagal pre-fetch data sheet:', err);
        }

        try {
            const target = 'agency';
            const WEEKLY_DIR = getWeeklyTargetDir(target);

            const todayForInit = new Date();
            const dayOfWeekForInit = todayForInit.getDay();
            const daysToLastSundayForInit = dayOfWeekForInit === 0 ? 7 : dayOfWeekForInit;
            const lastSundayForInit = new Date(todayForInit);
            lastSundayForInit.setDate(todayForInit.getDate() - daysToLastSundayForInit);
            const lastMondayForInit = new Date(lastSundayForInit);
            lastMondayForInit.setDate(lastSundayForInit.getDate() - 6);

            // STEP 1: Pilih Aplikator
            let step = 'aplikator';
            let platform = null;
            let scope = null;
            let selectedOutlets = [];
            let grabResultValues = [];
            let shopeeResultValues = [];
            let lastInteraction = interaction;

            let startDate = toISOFormat(lastMondayForInit);
            let endDate = toISOFormat(lastSundayForInit);
            let finalInteraction = null;
            let skipExisting = false;

            while (true) {
                if (step === 'aplikator') {
                    const result = await askSelection(lastInteraction, {
                        stepName: 'Aplikator',
                        title: '📱 Pilih Aplikator',
                        placeholder: 'Pilih platform aplikator...',
                        options: [
                            { label: '🌟 Semua Aplikator', value: 'all', description: 'Tarik data untuk GrabFood & ShopeeFood' },
                            { label: 'GrabFood', value: 'grab', emoji: { name: '🟢' }, description: 'Hanya tarik data GrabFood' },
                            { label: 'ShopeeFood', value: 'shopee', emoji: { name: '🟠' }, description: 'Hanya tarik data ShopeeFood' }
                        ],
                        minValues: 1,
                        maxValues: 1,
                        fields: [
                            { name: 'Tipe', value: 'AGENCY', inline: true }
                        ],
                        isFirstStep: (lastInteraction === interaction),
                        hasOutletStep: true,
                        isAllPlatform: false,
                        showBackButton: false
                    });

                    platform = result.values[0];
                    lastInteraction = result.lastInteraction;
                    step = 'scope';

                } else if (step === 'period') {
                    const today = new Date();
                    const dayOfWeek = today.getDay();
                    const daysToLastSunday = dayOfWeek === 0 ? 7 : dayOfWeek;
                    const lastSunday = new Date(today);
                    lastSunday.setDate(today.getDate() - daysToLastSunday);
                    const lastMonday = new Date(lastSunday);
                    lastMonday.setDate(lastSunday.getDate() - 6);

                    const formatDateDisplay = (d) => {
                        const day = String(d.getDate()).padStart(2, '0');
                        const month = String(d.getMonth() + 1).padStart(2, '0');
                        const year = d.getFullYear();
                        return `${day}-${month}-${year}`;
                    };

                    const defaultStartDisp = formatDateDisplay(lastMonday);
                    const defaultEndDisp = formatDateDisplay(lastSunday);

                    const defaultStartISO = toISOFormat(lastMonday);
                    const defaultEndISO = toISOFormat(lastSunday);

                    const currentFields = [
                        { name: 'Tipe', value: 'AGENCY', inline: true },
                        { name: 'Platform', value: platform.toUpperCase(), inline: true },
                        {
                            name: 'Cakupan',
                            value: scope === 'all_outlets' ? 'Semua Outlet' :
                                scope === 'select_merchant' ? `Merchant Terpilih (${selectedOutlets.length})` :
                                    `Jalankan yang Belum (${selectedOutlets.length} terpilih)`,
                            inline: true
                        }
                    ];

                    let errorMsg = null;

                    const getPeriodEmbed = () => {
                        let desc = 'Silakan pilih **📅 7 Hari Penuh (Senin-Minggu)**, atau klik **⚙️ Custom Date Range** untuk menentukan rentang tanggal secara manual.';
                        if (errorMsg) {
                            desc = `❌ **Error:** ${errorMsg}\n\n` + desc;
                        }
                        return makeProgressEmbed('Periode', '📅 Pilih Periode Laporan', desc, currentFields, scope !== 'all_outlets', platform === 'all');
                    };

                    const getPeriodComponents = () => {
                        return [
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setCustomId('agency_shortcut_7_days_btn')
                                    .setLabel(`📅 7 Hari Penuh (${defaultStartDisp} s/d ${defaultEndDisp})`)
                                    .setStyle(ButtonStyle.Success),
                                new ButtonBuilder()
                                    .setCustomId('agency_open_date_modal_btn')
                                    .setLabel('⚙️ Custom Date Range')
                                    .setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder()
                                    .setCustomId('agency_back_btn')
                                    .setLabel('⬅️ Kembali')
                                    .setStyle(ButtonStyle.Secondary)
                            )
                        ];
                    };

                    await lastInteraction.update({
                        embeds: [getPeriodEmbed()],
                        components: getPeriodComponents()
                    });

                    const periodMsg = lastInteraction.message || await lastInteraction.fetchReply();

                    const getPeriodChoice = () => {
                        return new Promise((resolvePeriod, rejectPeriod) => {
                            const collector = periodMsg.createMessageComponentCollector({
                                filter: i => i.user.id === interaction.user.id && ['agency_shortcut_7_days_btn', 'agency_open_date_modal_btn', 'agency_back_btn'].includes(i.customId),
                                time: 300000
                            });

                            collector.on('collect', async i => {
                                if (i.customId === 'agency_back_btn') {
                                    collector.stop('back');
                                    resolvePeriod({
                                        status: 'back',
                                        lastInteract: i
                                    });
                                    return;
                                }

                                if (i.customId === 'agency_shortcut_7_days_btn') {
                                    collector.stop('confirmed');
                                    resolvePeriod({
                                        status: 'confirmed',
                                        start: defaultStartISO,
                                        end: defaultEndISO,
                                        lastInteract: i
                                    });
                                    return;
                                }

                                // Jika klik custom date, tampilkan modal
                                const modalId = `agency_date_modal_${Date.now()}`;
                                const dateModal = new ModalBuilder()
                                    .setCustomId(modalId)
                                    .setTitle('Rentang Tanggal Custom');

                                const startInput = new TextInputBuilder()
                                    .setCustomId('start_date_input')
                                    .setLabel('TANGGAL MULAI (DD-MM-YYYY)')
                                    .setStyle(TextInputStyle.Short)
                                    .setPlaceholder('Contoh: 01-06-2026')
                                    .setMinLength(10)
                                    .setMaxLength(10)
                                    .setRequired(true);

                                const endInput = new TextInputBuilder()
                                    .setCustomId('end_date_input')
                                    .setLabel('TANGGAL SELESAI (DD-MM-YYYY)')
                                    .setStyle(TextInputStyle.Short)
                                    .setPlaceholder('Contoh: 07-06-2026')
                                    .setMinLength(10)
                                    .setMaxLength(10)
                                    .setRequired(true);

                                dateModal.addComponents(
                                    new ActionRowBuilder().addComponents(startInput),
                                    new ActionRowBuilder().addComponents(endInput)
                                );

                                await i.showModal(dateModal);

                                try {
                                    const modalSubmit = await i.awaitModalSubmit({
                                        filter: mi => mi.user.id === interaction.user.id && mi.customId === modalId,
                                        time: 120000
                                    });

                                    const startDateStr = modalSubmit.fields.getTextInputValue('start_date_input').trim();
                                    const endDateStr = modalSubmit.fields.getTextInputValue('end_date_input').trim();

                                    const dateRegex = /^\d{2}-\d{2}-\d{4}$/;
                                    if (!dateRegex.test(startDateStr) || !dateRegex.test(endDateStr)) {
                                        errorMsg = 'Format tanggal salah. Gunakan format DD-MM-YYYY (contoh: 01-06-2026).';
                                        await modalSubmit.update({
                                            embeds: [getPeriodEmbed()],
                                            components: getPeriodComponents()
                                        });
                                        return;
                                    }

                                    const parsedStart = parseDate(startDateStr);
                                    const parsedEnd = parseDate(endDateStr);

                                    if (!parsedStart || !parsedEnd) {
                                        errorMsg = 'Tanggal tidak ada di kalender (contoh: 31 Februari).';
                                        await modalSubmit.update({
                                            embeds: [getPeriodEmbed()],
                                            components: getPeriodComponents()
                                        });
                                        return;
                                    }

                                    if (parsedStart > parsedEnd) {
                                        errorMsg = 'Tanggal mulai tidak boleh melebihi tanggal selesai.';
                                        await modalSubmit.update({
                                            embeds: [getPeriodEmbed()],
                                            components: getPeriodComponents()
                                        });
                                        return;
                                    }

                                    collector.stop('confirmed');
                                    resolvePeriod({
                                        status: 'confirmed',
                                        start: toISOFormat(parsedStart),
                                        end: toISOFormat(parsedEnd),
                                        lastInteract: modalSubmit
                                    });
                                } catch (err) {
                                    console.error('Error awaiting modal submit:', err);
                                }
                            });

                            collector.on('end', (collected, reason) => {
                                if (reason !== 'confirmed' && reason !== 'back') {
                                    rejectPeriod(new Error('Timeout atau dibatalkan'));
                                }
                            });
                        });
                    };

                    const periodResults = await getPeriodChoice();
                    if (periodResults.status === 'back') {
                        lastInteraction = periodResults.lastInteract;
                        if (scope === 'all_outlets') {
                            step = 'scope';
                        } else if (scope === 'select_merchant') {
                            step = platform === 'all' ? 'outlet_shopee' : 'outlet_single';
                        } else if (scope === 'run_remaining') {
                            step = platform === 'all' ? 'outlet_shopee_remaining' : 'outlet_single_remaining';
                        }
                        continue;
                    }

                    startDate = periodResults.start;
                    endDate = periodResults.end;
                    lastInteraction = periodResults.lastInteract;
                    step = 'confirmation';
                    continue;

                } else if (step === 'scope') {
                    const result = await askSelection(lastInteraction, {
                        stepName: 'Cakupan',
                        title: '🏢 Cakupan Outlet',
                        placeholder: 'Pilih cakupan outlet...',
                        options: [
                            { label: 'Semua Outlet', value: 'all_outlets', description: 'Tarik data untuk seluruh outlet di GSheets' },
                            { label: 'Pilih Merchant Tertentu', value: 'select_merchant', description: 'Pilih satu atau lebih outlet dari daftar' },
                            { label: 'Jalankan yang Belum', value: 'run_remaining', description: 'Hanya jalankan outlet yang laporannya belum ada di server' }
                        ],
                        minValues: 1,
                        maxValues: 1,
                        fields: [
                            { name: 'Tipe', value: 'AGENCY', inline: true },
                            { name: 'Platform', value: platform.toUpperCase(), inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: platform === 'all',
                        showBackButton: true,
                        initialSelections: scope ? [scope] : []
                    });

                    if (result.status === 'back') {
                        step = 'aplikator';
                        lastInteraction = result.lastInteraction;
                        continue;
                    }

                    scope = result.values[0];
                    lastInteraction = result.lastInteraction;

                    if (scope === 'select_merchant') {
                        if (platform === 'all') {
                            step = 'outlet_grab';
                        } else {
                            step = 'outlet_single';
                        }
                    } else if (scope === 'run_remaining') {
                        if (platform === 'all') {
                            step = 'outlet_grab_remaining';
                        } else {
                            step = 'outlet_single_remaining';
                        }
                    } else {
                        selectedOutlets = [];
                        skipExisting = false;
                        step = 'period';
                    }
                    continue;

                } else if (step === 'outlet_grab') {
                    const grabOutlets = await getWeeklyOutlets('grab');
                    if (grabOutlets.length === 0) {
                        return lastInteraction.reply({
                            content: '❌ Gagal memuat daftar outlet Grab live.',
                            flags: 64
                        });
                    }
                    const grabOptions = grabOutlets.map(name => ({
                        label: name.substring(0, 100),
                        value: name
                    }));

                    const result = await askSelection(lastInteraction, {
                        stepName: 'Outlet Grab',
                        title: '🏪 Pilih Outlet Grab',
                        placeholder: 'Pilih satu atau lebih outlet Grab...',
                        options: grabOptions,
                        minValues: 1,
                        maxValues: grabOptions.length,
                        fields: [
                            { name: 'Tipe', value: 'AGENCY', inline: true },
                            { name: 'Platform', value: 'ALL (Grab)', inline: true },
                            { name: 'Cakupan', value: 'Merchant Terpilih', inline: true },
                            { name: 'Periode', value: `${startDate} s/d ${endDate}`, inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: true,
                        showBackButton: true,
                        initialSelections: grabResultValues
                    });

                    if (result.status === 'back') {
                        step = 'period';
                        lastInteraction = result.lastInteraction;
                        continue;
                    }

                    grabResultValues = result.values;
                    lastInteraction = result.lastInteraction;
                    step = 'outlet_shopee';

                } else if (step === 'outlet_shopee') {
                    const shopeeOutlets = await getWeeklyOutlets('shopee');
                    if (shopeeOutlets.length === 0) {
                        return lastInteraction.reply({
                            content: '❌ Gagal memuat daftar outlet Shopee live.',
                            flags: 64
                        });
                    }
                    const shopeeOptions = shopeeOutlets.map(name => ({
                        label: name.substring(0, 100),
                        value: name
                    }));

                    const result = await askSelection(lastInteraction, {
                        stepName: 'Outlet Shopee',
                        title: '🏪 Pilih Outlet Shopee',
                        placeholder: 'Pilih satu atau lebih outlet Shopee...',
                        options: shopeeOptions,
                        minValues: 1,
                        maxValues: shopeeOptions.length,
                        fields: [
                            { name: 'Tipe', value: 'AGENCY', inline: true },
                            { name: 'Platform', value: 'ALL (Shopee)', inline: true },
                            { name: 'Cakupan', value: 'Merchant Terpilih', inline: true },
                            { name: 'Periode', value: `${startDate} s/d ${endDate}`, inline: true },
                            { name: 'Outlet Grab Terpilih', value: grabResultValues.length.toString(), inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: true,
                        showBackButton: true,
                        initialSelections: shopeeResultValues
                    });

                    if (result.status === 'back') {
                        step = 'outlet_grab';
                        lastInteraction = result.lastInteraction;
                        continue;
                    }

                    shopeeResultValues = result.values;
                    selectedOutlets = grabResultValues.concat(shopeeResultValues);
                    lastInteraction = result.lastInteraction;
                    step = 'period';

                } else if (step === 'outlet_single') {
                    const weeklyOutlets = await getWeeklyOutlets(platform);
                    if (weeklyOutlets.length === 0) {
                        return lastInteraction.reply({
                            content: '❌ Gagal memuat daftar outlet live untuk platform terpilih.',
                            flags: 64
                        });
                    }
                    const outletOptions = weeklyOutlets.map(name => ({
                        label: name.substring(0, 100),
                        value: name
                    }));

                    const result = await askSelection(lastInteraction, {
                        stepName: 'Outlet',
                        title: '🏪 Pilih Outlet',
                        placeholder: 'Pilih satu atau lebih outlet...',
                        options: outletOptions,
                        minValues: 1,
                        maxValues: outletOptions.length,
                        fields: [
                            { name: 'Tipe', value: 'AGENCY', inline: true },
                            { name: 'Platform', value: platform.toUpperCase(), inline: true },
                            { name: 'Cakupan', value: 'Merchant Terpilih', inline: true },
                            { name: 'Periode', value: `${startDate} s/d ${endDate}`, inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: false,
                        showBackButton: true,
                        initialSelections: selectedOutlets
                    });

                    if (result.status === 'back') {
                        step = 'scope';
                        lastInteraction = result.lastInteraction;
                        continue;
                    }

                    selectedOutlets = result.values;
                    lastInteraction = result.lastInteraction;
                    step = 'period';

                } else if (step === 'outlet_grab_remaining') {
                    const rawOutlets = await getWeeklyOutlets('grab');
                    const remainingGrab = rawOutlets.filter(name => !isOutletDownloaded('agency', 'grab', startDate, endDate, name));

                    if (remainingGrab.length === 0) {
                        grabResultValues = [];
                        step = 'outlet_shopee_remaining';
                        continue;
                    }

                    const outletOptions = remainingGrab.map(name => ({
                        label: name.substring(0, 100),
                        value: name
                    }));

                    const result = await askRemainingSelection(lastInteraction, {
                        stepName: 'Outlet Grab',
                        title: `🏪 Grab: Jalankan yang Belum (${remainingGrab.length} tersisa)`,
                        placeholder: 'Pilih satu atau lebih outlet Grab...',
                        options: outletOptions,
                        allRemainingValues: remainingGrab,
                        fields: [
                            { name: 'Tipe', value: 'AGENCY', inline: true },
                            { name: 'Platform', value: 'ALL (Grab)', inline: true },
                            { name: 'Periode', value: `${startDate} s/d ${endDate}`, inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: true
                    });

                    if (result.status === 'back') {
                        step = 'period';
                        lastInteraction = result.lastInteraction;
                        continue;
                    }

                    grabResultValues = result.values;
                    lastInteraction = result.lastInteraction;
                    step = 'outlet_shopee_remaining';

                } else if (step === 'outlet_shopee_remaining') {
                    const rawOutlets = await getWeeklyOutlets('shopee');
                    const remainingShopee = rawOutlets.filter(name => !isOutletDownloaded('agency', 'shopee', startDate, endDate, name));

                    if (remainingShopee.length === 0) {
                        if (grabResultValues.length === 0) {
                            const embed = makeProgressEmbed('Outlet Shopee', '🏪 Jalankan yang Belum', '🎉 **Semua outlet Grab & Shopee sudah terunduh/selesai diproses!**', [
                                { name: 'Tipe', value: 'AGENCY', inline: true },
                                { name: 'Platform', value: 'ALL', inline: true },
                                { name: 'Periode', value: `${startDate} s/d ${endDate}`, inline: true }
                            ], true, true);

                            const row = new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setCustomId('agency_back_btn')
                                    .setLabel('⬅️ Kembali')
                                    .setStyle(ButtonStyle.Secondary)
                            );

                            await lastInteraction.update({
                                embeds: [embed],
                                components: [row]
                            });

                            const msg = lastInteraction.message || await lastInteraction.fetchReply();
                            const i = await msg.awaitMessageComponent({
                                filter: buttonI => buttonI.user.id === interaction.user.id && buttonI.customId === 'agency_back_btn',
                                time: 300000
                            });

                            lastInteraction = i;
                            step = 'scope';
                            continue;
                        }

                        shopeeResultValues = [];
                        selectedOutlets = grabResultValues;
                        skipExisting = true;
                        step = 'period';
                        continue;
                    }

                    const outletOptions = remainingShopee.map(name => ({
                        label: name.substring(0, 100),
                        value: name
                    }));

                    const result = await askRemainingSelection(lastInteraction, {
                        stepName: 'Outlet Shopee',
                        title: `🏪 Shopee: Jalankan yang Belum (${remainingShopee.length} tersisa)`,
                        placeholder: 'Pilih satu atau lebih outlet Shopee...',
                        options: outletOptions,
                        allRemainingValues: remainingShopee,
                        fields: [
                            { name: 'Tipe', value: 'AGENCY', inline: true },
                            { name: 'Platform', value: 'ALL (Shopee)', inline: true },
                            { name: 'Periode', value: `${startDate} s/d ${endDate}`, inline: true },
                            { name: 'Outlet Grab Terpilih', value: grabResultValues.length.toString(), inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: true
                    });

                    if (result.status === 'back') {
                        step = 'outlet_grab_remaining';
                        lastInteraction = result.lastInteraction;
                        continue;
                    }

                    shopeeResultValues = result.values;
                    selectedOutlets = grabResultValues.concat(shopeeResultValues);
                    skipExisting = true;
                    lastInteraction = result.lastInteraction;
                    step = 'period';

                } else if (step === 'outlet_single_remaining') {
                    const weeklyOutlets = await getWeeklyOutlets(platform);
                    const remainingOutlets = weeklyOutlets.filter(name => !isOutletDownloaded('agency', platform, startDate, endDate, name));

                    if (remainingOutlets.length === 0) {
                        const embed = makeProgressEmbed('Outlet', '🏪 Jalankan yang Belum', '🎉 **Semua outlet sudah terunduh/selesai diproses!** Tidak ada outlet yang tersisa untuk rentang tanggal ini.', [
                            { name: 'Tipe', value: 'AGENCY', inline: true },
                            { name: 'Platform', value: platform.toUpperCase(), inline: true },
                            { name: 'Periode', value: `${startDate} s/d ${endDate}`, inline: true }
                        ], true, false);

                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('agency_back_btn')
                                .setLabel('⬅️ Kembali')
                                .setStyle(ButtonStyle.Secondary)
                        );

                        await lastInteraction.update({
                            embeds: [embed],
                            components: [row]
                        });

                        const msg = lastInteraction.message || await lastInteraction.fetchReply();
                        const i = await msg.awaitMessageComponent({
                            filter: buttonI => buttonI.user.id === interaction.user.id && buttonI.customId === 'agency_back_btn',
                            time: 300000
                        });

                        lastInteraction = i;
                        step = 'scope';
                        continue;
                    }

                    const outletOptions = remainingOutlets.map(name => ({
                        label: name.substring(0, 100),
                        value: name
                    }));

                    const result = await askRemainingSelection(lastInteraction, {
                        stepName: 'Outlet',
                        title: `🏪 Jalankan yang Belum (${remainingOutlets.length} outlet tersisa)`,
                        placeholder: 'Pilih satu atau lebih outlet yang belum...',
                        options: outletOptions,
                        allRemainingValues: remainingOutlets,
                        fields: [
                            { name: 'Tipe', value: 'AGENCY', inline: true },
                            { name: 'Platform', value: platform.toUpperCase(), inline: true },
                            { name: 'Periode', value: `${startDate} s/d ${endDate}`, inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: false
                    });

                    if (result.status === 'back') {
                        step = 'scope';
                        lastInteraction = result.lastInteraction;
                        continue;
                    }

                    selectedOutlets = result.values;
                    skipExisting = true;
                    lastInteraction = result.lastInteraction;
                    step = 'period';

                } else if (step === 'confirmation') {
                    const currentFields = [
                        { name: 'Tipe', value: 'AGENCY', inline: true },
                        { name: 'Platform', value: platform.toUpperCase(), inline: true },
                        {
                            name: 'Cakupan',
                            value: scope === 'all_outlets' ? 'Semua Outlet' :
                                scope === 'select_merchant' ? `Merchant Terpilih (${selectedOutlets.length})` :
                                    `Jalankan yang Belum (${selectedOutlets.length} terpilih)`,
                            inline: true
                        },
                        { name: 'Periode', value: `${startDate} s/d ${endDate}`, inline: true }
                    ];

                    const getConfirmEmbed = () => {
                        return makeProgressEmbed(
                            'Konfirmasi',
                            '📋 Konfirmasi Pipeline',
                            'Silakan pilih mode untuk menjalankan pipeline weekly:\n\n' +
                            '🟢 **Jalankan Semua**: Memproses ulang seluruh outlet tanpa terkecuali.\n' +
                            '🟠 **Lewati yang Sudah Ada**: Hanya memproses outlet yang belum selesai atau belum terunduh laporannya di server.',
                            currentFields,
                            (scope === 'select_merchant' || scope === 'run_remaining'),
                            platform === 'all'
                        );
                    };

                    const getConfirmComponents = () => {
                        return [
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setCustomId('agency_confirm_all_btn')
                                    .setLabel('🟢 Jalankan Semua')
                                    .setStyle(ButtonStyle.Success),
                                new ButtonBuilder()
                                    .setCustomId('agency_confirm_skip_btn')
                                    .setLabel('🟠 Lewati yang Sudah Ada')
                                    .setStyle(ButtonStyle.Primary),
                                new ButtonBuilder()
                                    .setCustomId('agency_back_btn')
                                    .setLabel('⬅️ Kembali')
                                    .setStyle(ButtonStyle.Secondary)
                            )
                        ];
                    };

                    await lastInteraction.update({
                        embeds: [getConfirmEmbed()],
                        components: getConfirmComponents()
                    });

                    const confirmMsg = lastInteraction.message || await lastInteraction.fetchReply();

                    const getConfirmChoice = () => {
                        return new Promise((resolveConfirm, rejectConfirm) => {
                            const collector = confirmMsg.createMessageComponentCollector({
                                filter: i => i.user.id === interaction.user.id && ['agency_confirm_all_btn', 'agency_confirm_skip_btn', 'agency_back_btn'].includes(i.customId),
                                time: 300000
                            });

                            collector.on('collect', async i => {
                                if (i.customId === 'agency_back_btn') {
                                    collector.stop('back');
                                    resolveConfirm({ status: 'back', lastInteract: i });
                                    return;
                                }

                                const skip = i.customId === 'agency_confirm_skip_btn';
                                collector.stop('confirmed');
                                resolveConfirm({
                                    status: 'confirmed',
                                    skipExisting: skip,
                                    lastInteract: i
                                });
                            });

                            collector.on('end', (collected, reason) => {
                                if (reason !== 'confirmed' && reason !== 'back') {
                                    rejectConfirm(new Error('Timeout atau dibatalkan'));
                                }
                            });
                        });
                    };

                    const confirmResults = await getConfirmChoice();
                    if (confirmResults.status === 'back') {
                        lastInteraction = confirmResults.lastInteract;
                        step = 'period';
                        continue;
                    }

                    skipExisting = confirmResults.skipExisting;
                    finalInteraction = confirmResults.lastInteract;
                    break;
                }
            }

            // Mulai Eksekusi Pipeline
            isWeeklyJobRunning = true;
            await finalInteraction.update({
                content: '⏳ **Menyiapkan penarikan data weekly...**',
                embeds: [],
                components: []
            });

            const startTime = Date.now();
            let currentLog = 'Memulai pipeline weekly...';
            let lastUpdate = Date.now();

            let currentPlatform = platform.toUpperCase();
            let currentMerchant = 'Menunggu...';

            const buildProgressEmbed = (progressStep = 1, extraDesc = '') => {
                let progressLabel = '';
                switch (progressStep) {
                    case 1: progressLabel = '⚙️ Initial setup & validation'; break;
                    case 2: progressLabel = '⏸️ Pausing warmer & acquiring lock'; break;
                    case 3: progressLabel = `Running weekly scraper [${currentPlatform}] (${currentMerchant})`; break;
                    case 4: progressLabel = '📦 Generating and merging Excel reports'; break;
                    case 5: progressLabel = '✅ Completed'; break;
                }

                return new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('📊 Weekly Agency')
                    .setDescription(
                        `Weekly pipeline sedang dijalankan.\n\n` +
                        `> 🏢 **Tipe:** ${target.toUpperCase()}\n` +
                        `> 📍 **Platform:** ${platform.toUpperCase()}\n` +
                        `> 📅 **Rentang:** ${startDate} s/d ${endDate}\n` +
                        `${selectedOutlets.length > 0 ? `> 🏪 **Outlet:** ${selectedOutlets.join(', ')}\n` : ''}\n` +
                        `**Status saat ini:**\n${progressLabel}\n\n` +
                        `**Log aktivitas terbaru:**\n` +
                        `\`\`\`\n${extraDesc || currentLog}\n\`\`\``
                    )
                    .setFooter({ text: 'Sistem Weekly Agency Performance' })
                    .setTimestamp();
            };

            const cancelRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('cancel_weekly_pipeline')
                    .setLabel('Batalkan Proses')
                    .setStyle(ButtonStyle.Danger)
            );

            const progressMsg = await finalInteraction.editReply({
                content: null,
                embeds: [buildProgressEmbed(1)],
                components: [cancelRow]
            });

            const outletStr = selectedOutlets.length > 0 ? selectedOutlets.join('|') : '';

            const formData = {
                target,
                platform,
                startDate,
                endDate,
                outlet: outletStr,
                branch: '',
                user: '',
                skipExisting: skipExisting,
                channelId: interaction.channelId
            };

            let currentStep = 1;
            let fallbackMessage = null;
            const pipeline = runWeeklyPipeline(formData, async (logLine) => {
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
                if (stateChanged || (now - lastUpdate > 3000)) {
                    if (now - lastUpdate > 1500) {
                        lastUpdate = now;
                        const embed = buildProgressEmbed(currentStep, currentLog);
                        if (fallbackMessage) {
                            await fallbackMessage.edit({
                                embeds: [embed],
                                components: [cancelRow]
                            }).catch(() => { });
                        } else {
                            try {
                                await finalInteraction.editReply({
                                    embeds: [embed],
                                    components: [cancelRow]
                                });
                            } catch (err) {
                                console.log('[DISCORD] Interaction expired. Switching to channel message fallback.');
                                try {
                                    fallbackMessage = await interaction.channel.send({
                                        embeds: [embed],
                                        components: [cancelRow]
                                    });
                                } catch (sendErr) {
                                    console.error('[DISCORD] Failed to send fallback message:', sendErr);
                                }
                            }
                        }
                    }
                }
            });

            activeWeeklyProcess = pipeline;

            pipeline.promise.then(async (result) => {
                isWeeklyJobRunning = false;
                activeWeeklyProcess = null;

                const isCancelled = pipeline.proc && pipeline.proc.cancelled;
                if (isCancelled) {
                    return;
                }

                const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
                const durationStr = `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;

                if (result.success) {
                    const attachments = [];
                    const uploadedFiles = [];
                    let uploadedFolderUrl = null;
                    const searchPaths = platform === 'all' ? ['grab', 'shopee'] : [platform];

                    // Update: uploading files to Google Drive
                    for (const plat of searchPaths) {
                        const dir = path.join(WEEKLY_DIR, 'laporan', plat, `${startDate}_to_${endDate}`);
                        if (fs.existsSync(dir)) {
                            const dirFiles = fs.readdirSync(dir);
                            for (const file of dirFiles) {
                                if (file.endsWith('.xlsx')) {
                                    const filePath = path.join(dir, file);
                                    const stats = fs.statSync(filePath);
                                    // Hanya upload file yang dibuat/dimodifikasi selama pipeline ini berjalan
                                    if (stats.mtimeMs >= startTime) {
                                        // Upload to Google Drive
                                        if (APPS_SCRIPT_DRIVE_URL && APPS_SCRIPT_DRIVE_URL !== "ISI_DENGAN_URL_WEB_APP_APPS_SCRIPT_ANDA") {
                                            try {
                                                const fileContent = fs.readFileSync(filePath);
                                                const base64Content = fileContent.toString('base64');

                                                console.log(`[DRIVE UPLOAD] Uploading ${file}...`);
                                                const driveRes = await uploadToDrive(APPS_SCRIPT_DRIVE_URL, {
                                                    folderId: "1AF7zvgT0fuMTzTrXV_FKwUWj1R7JeOcx",
                                                    platform: plat.toUpperCase(), // e.g. GRAB or SHOPEE
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
                                                    console.log(`[DRIVE UPLOAD] Successful! Url: ${driveRes.url}`);
                                                } else {
                                                    console.error(`[DRIVE UPLOAD] Failed for ${file}:`, driveRes ? driveRes.message : 'No response');
                                                }
                                            } catch (uploadErr) {
                                                console.error(`[DRIVE UPLOAD] Error for ${file}:`, uploadErr);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    let driveStatus = '';
                    if (APPS_SCRIPT_DRIVE_URL === "ISI_DENGAN_URL_WEB_APP_APPS_SCRIPT_ANDA") {
                        driveStatus = '⚠️ *Upload Google Drive belum dikonfigurasi (URL Apps Script belum diisi di kode).*';
                    } else if (uploadedFiles.length > 0) {
                        const folderLink = uploadedFolderUrl || "https://drive.google.com/";
                        driveStatus = `📂 **Google Drive Folder:** [Buka Folder Rentang Tanggal](${folderLink})\n` +
                            `*Berhasil mengunggah ${uploadedFiles.length} file (Master + Rincian).*`;
                    } else {
                        driveStatus = '❌ *Gagal mengunggah file laporan ke Google Drive.*';
                    }

                    const successEmbed = new EmbedBuilder()
                        .setColor(0x00C853)
                        .setTitle('✅ Weekly Pipeline Selesai!')
                        .setDescription(
                            `Pipeline weekly selesai dijalankan dengan sukses.\n\n` +
                            `> 📍 **Platform:** ${platform.toUpperCase()}\n` +
                            `> 📅 **Rentang:** ${startDate} s/d ${endDate}\n` +
                            `${selectedOutlets.length > 0 ? `> 🏪 **Outlet:** ${selectedOutlets.join(', ')}\n` : ''}` +
                            `> ⏱️ **Durasi:** ${durationStr}\n\n` +
                            `${driveStatus}`
                        )
                        .setFooter({ text: 'Sistem Weekly Agency Performance' })
                        .setTimestamp();

                    if (fallbackMessage) {
                        await fallbackMessage.edit({
                            embeds: [successEmbed],
                            files: attachments,
                            components: []
                        }).catch(async () => {
                            await interaction.channel.send({
                                content: `Berhasil menyelesaikan pipeline untuk **${platform.toUpperCase()}**!`,
                                embeds: [successEmbed],
                                files: attachments
                            }).catch(() => { });
                        });
                    } else {
                        try {
                            await finalInteraction.editReply({
                                embeds: [successEmbed],
                                files: attachments,
                                components: []
                            });
                        } catch (editErr) {
                            await interaction.channel.send({
                                content: `Berhasil menyelesaikan pipeline untuk **${platform.toUpperCase()}**!`,
                                embeds: [successEmbed],
                                files: attachments
                            }).catch(() => { });
                        }
                    }
                } else {
                    const errSnippet = result.output.slice(-600)
                        .replace(/\x1B\[[0-9;]*m/g, '')
                        .replace(/```/g, "'''");

                    const failedEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('❌ Weekly Agency Pipeline Gagal')
                        .setDescription(
                            `Weekly pipeline gagal dijalankan.\n\n` +
                            `**Exit Code:** \`${result.exitCode}\`\n` +
                            `**Log terakhir:**\n` +
                            `\`\`\`\n${errSnippet || 'Tidak ada detail error.'}\n\`\`\``
                        )
                        .setFooter({ text: 'Hubungi administrator jika masalah berlanjut.' })
                        .setTimestamp();

                    if (fallbackMessage) {
                        await fallbackMessage.edit({
                            embeds: [failedEmbed],
                            components: []
                        }).catch(async () => {
                            await interaction.channel.send({
                                content: `Pipeline **${platform.toUpperCase()}** gagal!`,
                                embeds: [failedEmbed]
                            }).catch(() => { });
                        });
                    } else {
                        try {
                            await finalInteraction.editReply({
                                embeds: [failedEmbed],
                                components: []
                            });
                        } catch (editErr) {
                            await interaction.channel.send({
                                content: `Pipeline **${platform.toUpperCase()}** gagal!`,
                                embeds: [failedEmbed]
                            }).catch(() => { });
                        }
                    }
                }
            }).catch(async (err) => {
                isWeeklyJobRunning = false;
                activeWeeklyProcess = null;

                const errorEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('❌ Error Tidak Terduga')
                    .setDescription(`\`${err.message}\``)
                    .setTimestamp();

                if (fallbackMessage) {
                    await fallbackMessage.edit({
                        embeds: [errorEmbed],
                        components: []
                    }).catch(async () => {
                        await interaction.channel.send({
                            content: `Pipeline **${platform.toUpperCase()}** mengalami error sistem!`,
                            embeds: [errorEmbed]
                        }).catch(() => { });
                    });
                } else {
                    try {
                        await finalInteraction.editReply({
                            embeds: [errorEmbed],
                            components: []
                        });
                    } catch (editErr) {
                        await interaction.channel.send({
                            content: `Pipeline **${platform.toUpperCase()}** mengalami error sistem!`,
                            embeds: [errorEmbed]
                        }).catch(() => { });
                    }
                }
            });

        } catch (err) {
            isWeeklyJobRunning = false;
            activeWeeklyProcess = null;
            console.error('Error during agency flow:', err);
            if (err.message !== 'Timeout or cancelled' && err.message !== 'Timeout atau dibatalkan') {
                await interaction.followUp({
                    content: `❌ **Terjadi kesalahan:** ${err.message}`,
                    flags: 64
                }).catch(() => { });
            }
        }
    },

    async cancelWeeklyPipeline(interaction) {
        const proc = activeWeeklyProcess ? activeWeeklyProcess.proc : null;
        if (proc && !proc.killed) {
            proc.cancelled = true;
            try {
                process.kill(-proc.pid, 'SIGKILL');
            } catch (e) {
                try { proc.kill('SIGKILL'); } catch (err) { }
            }
            activeWeeklyProcess = null;
            isWeeklyJobRunning = false;

            await interaction.update({
                content: '⏹️ **Proses Weekly Pipeline dibatalkan secara paksa.**',
                embeds: [],
                components: []
            });
            return true;
        }
        return false;
    }
};
