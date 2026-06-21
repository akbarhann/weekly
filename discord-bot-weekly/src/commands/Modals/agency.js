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
const APPS_SCRIPT_DRIVE_URL = "https://script.google.com/macros/s/AKfycby0FNvijiWhJJmgrY7GMNtw3-rOg8sBdMygOm2S1c65SArfq5RHxEdF0u0xLerUxK0S/exec";

// Memory lock for active weekly pipeline jobs
let isWeeklyJobRunning = false;
let activeWeeklyProcess = null;

// GSheets caching specifically for weekly merchants (gid=0)
let cachedWeeklySheetData = null;
let lastWeeklyCacheTime = 0;
const WEEKLY_CACHE_DURATION = 30 * 1000; // 30 seconds cache

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

    if (appIdx === -1 || statusIdx === -1 || nameIdx === -1) {
        console.error('[WEEKLY FETCH] Headers not found in GSheets gid=0:', headers);
        return [];
    }

    const outletsSet = new Set();

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());
        if (cols.length <= Math.max(appIdx, statusIdx, nameIdx)) continue;

        const app = cols[appIdx].toLowerCase();
        const status = cols[statusIdx].toLowerCase();
        const name = cols[nameIdx];

        if (!name || name === '-') continue;
        if (status !== 'live') continue;

        const matchesPlatform = 
            (platform === 'all' && (app.includes('grab') || app.includes('shopee'))) ||
            (platform === 'grab' && app.includes('grab')) ||
            (platform === 'shopee' && app.includes('shopee'));

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
async function askSelection(interaction, { stepName, title, placeholder, options, minValues = 1, maxValues = 1, fields = [], isFirstStep = false, hasOutletStep = true, isAllPlatform = false }) {
    let selectedValues = new Set();

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

        const nextButton = new ButtonBuilder()
            .setCustomId('agency_continue_btn')
            .setLabel(selectedValues.size >= minValues ? '➡️ Lanjutkan' : (minValues === 1 ? 'Pilih opsi terlebih dahulu' : `Pilih minimal ${minValues} opsi`))
            .setStyle(selectedValues.size >= minValues ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(isDisabled);

        rows.push(new ActionRowBuilder().addComponents(nextButton));
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
            }
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'confirmed' && latestInteraction) {
                resolve({ values: Array.from(selectedValues), lastInteraction: latestInteraction });
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

            // STEP 1: Pilih Aplikator
            const aplikatorResult = await askSelection(interaction, {
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
                isFirstStep: true,
                hasOutletStep: true,
                isAllPlatform: false
            });

            const platform = aplikatorResult.values[0];

            // STEP 2: Pilih Cakupan Tarikan
            const scopeResult = await askSelection(aplikatorResult.lastInteraction, {
                stepName: 'Cakupan',
                title: '🏢 Cakupan Outlet',
                placeholder: 'Pilih cakupan outlet...',
                options: [
                    { label: 'Semua Outlet', value: 'all_outlets', description: 'Tarik data untuk seluruh outlet di GSheets' },
                    { label: 'Pilih Merchant Tertentu', value: 'select_merchant', description: 'Pilih satu atau lebih outlet dari daftar' }
                ],
                minValues: 1,
                maxValues: 1,
                fields: [
                    { name: 'Tipe', value: 'AGENCY', inline: true },
                    { name: 'Platform', value: platform.toUpperCase(), inline: true }
                ],
                hasOutletStep: true,
                isAllPlatform: platform === 'all'
            });

            const scope = scopeResult.values[0];
            const hasOutletStep = scope === 'select_merchant';

            let selectedOutlets = [];
            let lastInteractionAfterOutlet = scopeResult.lastInteraction;

            // STEP 3: Pilih Outlet (Jika select_merchant)
            if (hasOutletStep) {
                if (platform === 'all') {
                    // STEP 3a: Pilih Outlet Grab
                    const grabOutlets = await getWeeklyOutlets('grab');
                    if (grabOutlets.length === 0) {
                        return lastInteractionAfterOutlet.reply({
                            content: '❌ Gagal memuat daftar outlet Grab live.',
                            flags: 64
                        });
                    }
                    const grabOptions = grabOutlets.map(name => ({
                        label: name.substring(0, 100),
                        value: name
                    }));

                    const grabResult = await askSelection(scopeResult.lastInteraction, {
                        stepName: 'Outlet Grab',
                        title: '🏪 Pilih Outlet Grab',
                        placeholder: 'Pilih satu atau lebih outlet Grab...',
                        options: grabOptions,
                        minValues: 1,
                        maxValues: grabOptions.length,
                        fields: [
                            { name: 'Tipe', value: 'AGENCY', inline: true },
                            { name: 'Platform', value: 'ALL (Grab)', inline: true },
                            { name: 'Cakupan', value: 'Merchant Terpilih', inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: true
                    });

                    selectedOutlets = selectedOutlets.concat(grabResult.values);
                    lastInteractionAfterOutlet = grabResult.lastInteraction;

                    // STEP 3b: Pilih Outlet Shopee
                    const shopeeOutlets = await getWeeklyOutlets('shopee');
                    if (shopeeOutlets.length === 0) {
                        return lastInteractionAfterOutlet.reply({
                            content: '❌ Gagal memuat daftar outlet Shopee live.',
                            flags: 64
                        });
                    }
                    const shopeeOptions = shopeeOutlets.map(name => ({
                        label: name.substring(0, 100),
                        value: name
                    }));

                    const shopeeResult = await askSelection(lastInteractionAfterOutlet, {
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
                            { name: 'Outlet Grab Terpilih', value: grabResult.values.length.toString(), inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: true
                    });

                    selectedOutlets = selectedOutlets.concat(shopeeResult.values);
                    lastInteractionAfterOutlet = shopeeResult.lastInteraction;

                } else {
                    const weeklyOutlets = await getWeeklyOutlets(platform);
                    if (weeklyOutlets.length === 0) {
                        return lastInteractionAfterOutlet.reply({
                            content: '❌ Gagal memuat daftar outlet live untuk platform terpilih.',
                            flags: 64
                        });
                    }
                    const outletOptions = weeklyOutlets.map(name => ({
                        label: name.substring(0, 100),
                        value: name
                    }));

                    const outletResult = await askSelection(scopeResult.lastInteraction, {
                        stepName: 'Outlet',
                        title: '🏪 Pilih Outlet',
                        placeholder: 'Pilih satu atau lebih outlet...',
                        options: outletOptions,
                        minValues: 1,
                        maxValues: outletOptions.length,
                        fields: [
                            { name: 'Tipe', value: 'AGENCY', inline: true },
                            { name: 'Platform', value: platform.toUpperCase(), inline: true },
                            { name: 'Cakupan', value: 'Merchant Terpilih', inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: false
                    });

                    selectedOutlets = outletResult.values;
                    lastInteractionAfterOutlet = outletResult.lastInteraction;
                }
            }

            // STEP 3: Pilih Periode (menggunakan tombol seperti /start)
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
                { name: 'Cakupan', value: hasOutletStep ? `Merchant Terpilih (${selectedOutlets.length})` : 'Semua Outlet', inline: true }
            ];

            let errorMsg = null;
            let startDate = '';
            let endDate = '';
            let finalInteraction = null;

            const getPeriodEmbed = () => {
                let desc = 'Silakan pilih **📅 7 Hari Penuh (Senin-Minggu)**, atau klik **⚙️ Custom Date Range** untuk menentukan rentang tanggal secara manual.';
                if (errorMsg) {
                    desc = `❌ **Error:** ${errorMsg}\n\n` + desc;
                }
                return makeProgressEmbed('Periode', '📅 Pilih Periode Laporan', desc, currentFields, hasOutletStep, platform === 'all');
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
                            .setStyle(ButtonStyle.Secondary)
                    )
                ];
            };

            // Update interaction to show the buttons
            await lastInteractionAfterOutlet.update({
                embeds: [getPeriodEmbed()],
                components: getPeriodComponents()
            });

            const periodMsg = lastInteractionAfterOutlet.message || await lastInteractionAfterOutlet.fetchReply();

            const getPeriodChoice = () => {
                return new Promise((resolvePeriod, rejectPeriod) => {
                    const collector = periodMsg.createMessageComponentCollector({
                        filter: i => i.user.id === interaction.user.id && ['agency_shortcut_7_days_btn', 'agency_open_date_modal_btn'].includes(i.customId),
                        time: 300000
                    });

                    collector.on('collect', async i => {
                        if (i.customId === 'agency_shortcut_7_days_btn') {
                            collector.stop('confirmed');
                            resolvePeriod({
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
                                start: toISOFormat(parsedStart),
                                end: toISOFormat(parsedEnd),
                                lastInteract: modalSubmit
                            });
                        } catch (err) {
                            console.error('Error awaiting modal submit:', err);
                        }
                    });

                    collector.on('end', (collected, reason) => {
                        if (reason !== 'confirmed') {
                            rejectPeriod(new Error('Timeout atau dibatalkan'));
                        }
                    });
                });
            };

            const periodResults = await getPeriodChoice();
            startDate = periodResults.start;
            endDate = periodResults.end;
            finalInteraction = periodResults.lastInteract;

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

            const makeProgressBar = (filledCount, totalCount = 5) => {
                const filled = '█'.repeat(filledCount);
                const empty = '░'.repeat(totalCount - filledCount);
                return `[${filled}${empty}] ${filledCount}/${totalCount}`;
            };

            const buildProgressEmbed = (progressStep = 1, extraDesc = '') => {
                let progressLabel = '';
                switch (progressStep) {
                    case 1: progressLabel = 'Initial setup & validation'; break;
                    case 2: progressLabel = 'Pausing warmer & acquiring lock'; break;
                    case 3: progressLabel = 'Running weekly scraper'; break;
                    case 4: progressLabel = 'Generating and merging Excel reports'; break;
                    case 5: progressLabel = 'Completed'; break;
                }

                return new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('📊 Progress Weekly Agency Pipeline')
                    .setDescription(
                        `Weekly pipeline sedang dijalankan.\n\n` +
                        `${makeProgressBar(progressStep)}\n` +
                        `> 🏢 **Tipe:** ${target.toUpperCase()}\n` +
                        `> 📍 **Platform CLI:** ${platform.toUpperCase()}\n` +
                        `> 📅 **Rentang:** ${startDate} s/d ${endDate}\n` +
                        `${selectedOutlets.length > 0 ? `> 🏪 **Outlet Target:** ${selectedOutlets.join(', ')}\n` : ''}\n` +
                        `> 🔍 **Platform Aktif:** \`${currentPlatform}\`\n` +
                        `> 🏪 **Proses Merchant:** \`${currentMerchant}\`\n\n` +
                        `**Status saat ini:** ${progressLabel}\n` +
                        `\`\`\`\n${extraDesc || currentLog}\n\`\`\``
                    )
                    .setFooter({ text: 'Sistem Weekly Agency Performance' })
                    .setTimestamp();
            };

            const cancelRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('cancel_weekly_pipeline')
                    .setLabel('⏹️ Batalkan Proses')
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
                channelId: interaction.channelId
            };

            let logHistory = [];
            const pipeline = runWeeklyPipeline(formData, async (logLine) => {
                const cleanLines = logLine.split('\n').map(l => l.trim()).filter(Boolean);
                for (const line of cleanLines) {
                    logHistory.push(line);

                    // Parse platform
                    if (line.toUpperCase().includes('GRAB MULTI-PORTAL') || line.toUpperCase().includes('GRAB PIPELINE') || line.toUpperCase().includes('GRAB AUTO')) {
                        currentPlatform = 'GRAB';
                    } else if (line.toUpperCase().includes('SHOPEE WEEKLY') || line.toUpperCase().includes('SHOPEE PIPELINE')) {
                        currentPlatform = 'SHOPEE';
                    }

                    // Parse merchant
                    // 1. Grab starting
                    let match = line.match(/Starting for:\s*[^\s(]+\s*\(([^)]+)\)/i);
                    if (match) {
                        currentMerchant = match[1].trim();
                    }
                    // 2. Grab retry starting
                    let matchRetry = line.match(/Re-running sequentially for:\s*(.*)/i);
                    if (matchRetry) {
                        currentMerchant = matchRetry[1].trim();
                    }
                    // 3. Grab finished portal
                    let matchPortal = line.match(/✓\s*\[PORTAL\s*\d+\]\s*([^-—]+)/i);
                    if (matchPortal) {
                        currentMerchant = matchPortal[1].trim();
                    }
                    // 4. Shopee starting/processing
                    let matchShopee = line.match(/Processing:\s*(.*)/i);
                    if (matchShopee) {
                        currentMerchant = matchShopee[1].trim();
                    }
                    // 5. Shopee polling
                    let matchPoll = line.match(/downloading report for\s*([^.]+)/i);
                    if (matchPoll) {
                        currentMerchant = matchPoll[1].trim();
                    }
                }
                if (logHistory.length > 5) {
                    logHistory = logHistory.slice(-5);
                }

                let step = 3;
                if (logLine.includes('[JOB LOCK]') || logLine.includes('[WARMER]')) {
                    step = 2;
                } else if (logLine.includes('PHASE 3') || logLine.includes('PHASE 4') || logLine.includes('Master Aggregation') || logLine.includes('Merging') || logLine.includes('Combining')) {
                    step = 4;
                    currentMerchant = 'Merging & finishing...';
                }

                if (Date.now() - lastUpdate > 2000) {
                    lastUpdate = Date.now();
                    await progressMsg.edit({
                        embeds: [buildProgressEmbed(step, logHistory.join('\n'))],
                        components: [cancelRow]
                    }).catch(() => { });
                }
            });

            activeWeeklyProcess = pipeline.proc;

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
                    const searchPaths = platform === 'all' ? ['grab', 'shopee'] : [platform];
                    
                    // Update: uploading files to Google Drive
                    for (const plat of searchPaths) {
                        const dir = path.join(WEEKLY_DIR, 'laporan', plat, `${startDate}_to_${endDate}`);
                        if (fs.existsSync(dir)) {
                            const dirFiles = fs.readdirSync(dir);
                            for (const file of dirFiles) {
                                if (file.endsWith('.xlsx') && (file.startsWith('0Master') || file.startsWith('CUSTOM_') || file.startsWith('Merged_'))) {
                                    const filePath = path.join(dir, file);
                                    const stats = fs.statSync(filePath);
                                    
                                    // Add to attachments for Discord (if < 8MB)
                                    if (stats.size < 8 * 1024 * 1024) {
                                        attachments.push(new AttachmentBuilder(filePath));
                                    }

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

                    let driveStatus = '';
                    if (APPS_SCRIPT_DRIVE_URL === "ISI_DENGAN_URL_WEB_APP_APPS_SCRIPT_ANDA") {
                        driveStatus = '⚠️ *Upload Google Drive belum dikonfigurasi (URL Apps Script belum diisi di kode).*';
                    } else if (uploadedFiles.length > 0) {
                        driveStatus = '📂 **Google Drive Uploads:**\n' + 
                            uploadedFiles.map(f => `• [${f.name}](${f.url})`).join('\n');
                    } else {
                        driveStatus = '❌ *Gagal mengunggah file laporan ke Google Drive.*';
                    }

                    const successEmbed = new EmbedBuilder()
                        .setColor(0x00C853)
                        .setTitle('✅ Weekly Pipeline Selesai!')
                        .setDescription(
                            `Pipeline weekly selesai dijalankan dengan sukses.\n\n` +
                            `> 🏢 **Tipe:** ${target.toUpperCase()}\n` +
                            `> 📍 **Platform:** ${platform.toUpperCase()}\n` +
                            `> 📅 **Rentang:** ${startDate} s/d ${endDate}\n` +
                            `${selectedOutlets.length > 0 ? `> 🏪 **Outlet:** ${selectedOutlets.join(', ')}\n` : ''}` +
                            `> ⏱️ **Durasi:** ${durationStr}\n\n` +
                            `${driveStatus}`
                        )
                        .setFooter({ text: 'Sistem Weekly Agency Performance' })
                        .setTimestamp();

                    await progressMsg.edit({
                        embeds: [successEmbed],
                        files: attachments,
                        components: []
                    });
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

                    await progressMsg.edit({
                        embeds: [failedEmbed],
                        components: []
                    });
                }
            }).catch(async (err) => {
                isWeeklyJobRunning = false;
                activeWeeklyProcess = null;
                
                const errorEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('❌ Error Tidak Terduga')
                    .setDescription(`\`${err.message}\``)
                    .setTimestamp();

                await progressMsg.edit({
                    embeds: [errorEmbed],
                    components: []
                }).catch(() => { });
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
        if (activeWeeklyProcess && !activeWeeklyProcess.killed) {
            activeWeeklyProcess.cancelled = true;
            try {
                process.kill(-activeWeeklyProcess.pid, 'SIGKILL');
            } catch (e) {
                try { activeWeeklyProcess.kill('SIGKILL'); } catch (err) { }
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
