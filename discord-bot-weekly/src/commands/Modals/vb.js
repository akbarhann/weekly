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

// GSheets caching specifically for VB merchants
let cachedVBGrabData = null;
let cachedVBShopeeData = null;
let lastVBGrabCacheTime = 0;
let lastVBShopeeCacheTime = 0;
const VB_CACHE_DURATION = 30 * 1000; // 30 seconds cache

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
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = res.headers.location;
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

async function getVBOutlets(platform) {
    const now = Date.now();
    const grabUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRYSUnKOqk29LCktTxdb0wPLbWMbRaWRP3eC_UA4AwYod1FW6zDMhtLMC5ghIvot2B8upCDfBsn-TCP/pub?gid=978201567&single=true&output=csv';
    const shopeeUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRYSUnKOqk29LCktTxdb0wPLbWMbRaWRP3eC_UA4AwYod1FW6zDMhtLMC5ghIvot2B8upCDfBsn-TCP/pub?gid=565510790&single=true&output=csv';

    let grabCsv = '';
    let shopeeCsv = '';

    if (platform === 'grab' || platform === 'all') {
        if (cachedVBGrabData && (now - lastVBGrabCacheTime < VB_CACHE_DURATION)) {
            grabCsv = cachedVBGrabData;
        } else {
            grabCsv = await fetchCSV(grabUrl);
            cachedVBGrabData = grabCsv;
            lastVBGrabCacheTime = now;
        }
    }

    if (platform === 'shopee' || platform === 'all') {
        if (cachedVBShopeeData && (now - lastVBShopeeCacheTime < VB_CACHE_DURATION)) {
            shopeeCsv = cachedVBShopeeData;
        } else {
            shopeeCsv = await fetchCSV(shopeeUrl);
            cachedVBShopeeData = shopeeCsv;
            lastVBShopeeCacheTime = now;
        }
    }

    const parsePortalNames = (csvString, targetNotesFilter = true, roleFilter = false) => {
        if (!csvString) return [];
        const lines = csvString.split(/\r?\n/);
        if (lines.length < 2) return [];

        const headers = lines[0].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(h => h.trim().replace(/^"|"$/g, ''));
        const portalIdx = headers.indexOf('Portal');
        const notesIdx = headers.indexOf('Notes');
        const roleIdx = headers.indexOf('Role');

        if (portalIdx === -1) {
            console.error('[VB FETCH] Column "Portal" not found in headers:', headers);
            return [];
        }

        const names = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());
            if (cols.length <= portalIdx) continue;

            const name = cols[portalIdx];
            if (!name || name === '-') continue;

            // Notes filter: exclude if notes contains "restricted"
            if (targetNotesFilter && notesIdx !== -1 && cols.length > notesIdx) {
                const notes = cols[notesIdx].toLowerCase();
                if (notes.includes('restricted')) continue;
            }

            // Role filter: for Shopee, must be "owner"
            if (roleFilter && roleIdx !== -1 && cols.length > roleIdx) {
                const role = cols[roleIdx].toLowerCase().trim();
                if (role !== 'owner') continue;
            }

            names.push(name);
        }
        return names;
    };

    let grabPortals = [];
    if (platform === 'grab' || platform === 'all') {
        grabPortals = parsePortalNames(grabCsv, true, false);
    }

    let shopeePortals = [];
    if (platform === 'shopee' || platform === 'all') {
        shopeePortals = parsePortalNames(shopeeCsv, true, true);
    }

    const allPortals = new Set([...grabPortals, ...shopeePortals]);
    return Array.from(allPortals).sort((a, b) => a.localeCompare(b));
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
        .setColor(0x00D0F2)
        .setTitle(title)
        .setDescription(`**Langkah Progres:**\n${progressStr}\n\n${description}`)
        .setFooter({ text: 'Sistem Weekly VB Performance' })
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
                .setCustomId(`vb_selection_menu_${index}`)
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
                    .setCustomId('vb_back_btn')
                    .setLabel('⬅️ Kembali')
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        buttons.push(
            new ButtonBuilder()
                .setCustomId('vb_continue_btn')
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
            if (i.customId.startsWith('vb_selection_menu')) {
                const menuIndex = parseInt(i.customId.split('_').pop());
                const currentChunk = options.slice(menuIndex * 25, (menuIndex + 1) * 25);

                currentChunk.forEach(opt => selectedValues.delete(opt.value));
                i.values.forEach(val => selectedValues.add(val));

                await i.update({
                    embeds: [getEmbed()],
                    components: getComponents()
                });
            } else if (i.customId === 'vb_continue_btn') {
                collector.stop('confirmed');
            } else if (i.customId === 'vb_back_btn') {
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
        .setName('vb')
        .setDescription('Kirim formulir Laporan Transaksi Mingguan (Weekly) VB'),

    async execute(interaction) {
        if (isWeeklyJobRunning) {
            return interaction.reply({
                content: '⚠️ **Sistem Sibuk!** Laporan Weekly VB lain sedang berjalan. Harap tunggu hingga proses sebelumnya selesai.',
                flags: 64
            });
        }

        await interaction.deferReply({ flags: 64 });

        // Pre-fetch weekly sheet data
        try {
            await getVBOutlets('all');
        } catch (err) {
            console.error('[VB FETCH] Gagal pre-fetch data sheet:', err);
        }

        try {
            const target = 'VB';
            const WEEKLY_DIR = getWeeklyTargetDir(target);

            // STEP 1: Pilih Aplikator
            let step = 'aplikator';
            let platform = null;
            let scope = null;
            let selectedOutlets = [];
            let grabResultValues = [];
            let shopeeResultValues = [];
            let lastInteraction = interaction;

            let startDate = '';
            let endDate = '';
            let finalInteraction = null;

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
                            { name: 'Tipe', value: 'VB', inline: true }
                        ],
                        isFirstStep: (lastInteraction === interaction),
                        hasOutletStep: true,
                        isAllPlatform: false,
                        showBackButton: false
                    });

                    platform = result.values[0];
                    lastInteraction = result.lastInteraction;
                    step = 'scope';

                } else if (step === 'scope') {
                    const result = await askSelection(lastInteraction, {
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
                            { name: 'Tipe', value: 'VB', inline: true },
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
                    } else {
                        selectedOutlets = [];
                        step = 'period';
                    }

                } else if (step === 'outlet_grab') {
                    const grabOutlets = await getVBOutlets('grab');
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
                        title: '🏪 Pilih Outlet Grab VB',
                        placeholder: 'Pilih satu atau lebih outlet Grab...',
                        options: grabOptions,
                        minValues: 1,
                        maxValues: grabOptions.length,
                        fields: [
                            { name: 'Tipe', value: 'VB', inline: true },
                            { name: 'Platform', value: 'ALL (Grab)', inline: true },
                            { name: 'Cakupan', value: 'Merchant Terpilih', inline: true }
                        ],
                        hasOutletStep: true,
                        isAllPlatform: true,
                        showBackButton: true,
                        initialSelections: grabResultValues
                    });

                    if (result.status === 'back') {
                        step = 'scope';
                        lastInteraction = result.lastInteraction;
                        continue;
                    }

                    grabResultValues = result.values;
                    lastInteraction = result.lastInteraction;
                    step = 'outlet_shopee';

                } else if (step === 'outlet_shopee') {
                    const shopeeOutlets = await getVBOutlets('shopee');
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
                        title: '🏪 Pilih Outlet Shopee VB',
                        placeholder: 'Pilih satu atau lebih outlet Shopee...',
                        options: shopeeOptions,
                        minValues: 1,
                        maxValues: shopeeOptions.length,
                        fields: [
                            { name: 'Tipe', value: 'VB', inline: true },
                            { name: 'Platform', value: 'ALL (Shopee)', inline: true },
                            { name: 'Cakupan', value: 'Merchant Terpilih', inline: true },
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
                    const weeklyOutlets = await getVBOutlets(platform);
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
                        title: '🏪 Pilih Outlet VB',
                        placeholder: 'Pilih satu atau lebih outlet...',
                        options: outletOptions,
                        minValues: 1,
                        maxValues: outletOptions.length,
                        fields: [
                            { name: 'Tipe', value: 'VB', inline: true },
                            { name: 'Platform', value: platform.toUpperCase(), inline: true },
                            { name: 'Cakupan', value: 'Merchant Terpilih', inline: true }
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
                        { name: 'Tipe', value: 'VB', inline: true },
                        { name: 'Platform', value: platform.toUpperCase(), inline: true },
                        { name: 'Cakupan', value: (scope === 'select_merchant') ? `Merchant Terpilih (${selectedOutlets.length})` : 'Semua Outlet', inline: true }
                    ];

                    let errorMsg = null;

                    const getPeriodEmbed = () => {
                        let desc = 'Silakan pilih **📅 7 Hari Penuh (Senin-Minggu)**, atau klik **⚙️ Custom Date Range** untuk menentukan rentang tanggal secara manual.';
                        if (errorMsg) {
                            desc = `❌ **Error:** ${errorMsg}\n\n` + desc;
                        }
                        return makeProgressEmbed('Periode', '📅 Pilih Periode Laporan', desc, currentFields, (scope === 'select_merchant'), platform === 'all');
                    };

                    const getPeriodComponents = () => {
                        return [
                            new ActionRowBuilder().addComponents(
                                new ButtonBuilder()
                                    .setCustomId('vb_shortcut_7_days_btn')
                                    .setLabel(`📅 7 Hari Penuh (${defaultStartDisp} s/d ${defaultEndDisp})`)
                                    .setStyle(ButtonStyle.Success),
                                new ButtonBuilder()
                                    .setCustomId('vb_open_date_modal_btn')
                                    .setLabel('⚙️ Custom Date Range')
                                    .setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder()
                                    .setCustomId('vb_back_btn')
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
                                filter: i => i.user.id === interaction.user.id && ['vb_shortcut_7_days_btn', 'vb_open_date_modal_btn', 'vb_back_btn'].includes(i.customId),
                                time: 300000
                            });

                            collector.on('collect', async i => {
                                if (i.customId === 'vb_back_btn') {
                                    collector.stop('back');
                                    resolvePeriod({
                                        status: 'back',
                                        lastInteract: i
                                    });
                                    return;
                                }

                                if (i.customId === 'vb_shortcut_7_days_btn') {
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
                                const modalId = `vb_date_modal_${Date.now()}`;
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
                        if (scope === 'select_merchant') {
                            if (platform === 'all') {
                                step = 'outlet_shopee';
                            } else {
                                step = 'outlet_single';
                            }
                        } else {
                            step = 'scope';
                        }
                        continue;
                    }

                    startDate = periodResults.start;
                    endDate = periodResults.end;
                    finalInteraction = periodResults.lastInteract;
                    break;
                }
            }

            // Mulai Eksekusi Pipeline
            isWeeklyJobRunning = true;
            await finalInteraction.update({
                content: '⏳ **Menyiapkan penarikan data weekly VB...**',
                embeds: [],
                components: []
            });

            const startTime = Date.now();
            let currentLog = 'Memulai pipeline weekly VB...';
            let lastUpdate = Date.now();

            let currentPlatform = platform.toUpperCase();
            let currentMerchant = 'Menunggu...';

            const buildProgressEmbed = (progressStep = 1, extraDesc = '') => {
                let progressLabel = '';
                switch (progressStep) {
                    case 1: progressLabel = 'Starting '; break;
                    case 2: progressLabel = '⏸️ Pausing warmer & acquiring lock'; break;
                    case 3: progressLabel = `Running weekly scraper [${currentPlatform}] (${currentMerchant})`; break;
                    case 4: progressLabel = '📦 Generating and merging Excel reports'; break;
                    case 5: progressLabel = '✅ Completed'; break;
                }

                return new EmbedBuilder()
                    .setColor(0x00D0F2)
                    .setTitle('📊 Weekly VB')
                    .setDescription(
                        `Weekly VB pipeline sedang dijalankan.\n\n` +
                        `> 🏢 **Tipe:** ${target.toUpperCase()}\n` +
                        `> 📍 **Platform:** ${platform.toUpperCase()}\n` +
                        `> 📅 **Rentang:** ${startDate} s/d ${endDate}\n` +
                        `${selectedOutlets.length > 0 ? `> 🏪 **Outlet:** ${selectedOutlets.join(', ')}\n` : ''}\n` +
                        `**Status saat ini:**\n${progressLabel}\n\n` +
                        `**Log aktivitas terbaru:**\n` +
                        `\`\`\`\n${extraDesc || currentLog}\n\`\`\``
                    )
                    .setFooter({ text: 'Sistem Weekly VB Performance' })
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
                channelId: interaction.channelId
            };

            let currentStep = 1;
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
                        await finalInteraction.editReply({
                            embeds: [buildProgressEmbed(currentStep, currentLog)],
                            components: [cancelRow]
                        }).catch(() => { });
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

                    for (const plat of searchPaths) {
                        const dir = path.join(WEEKLY_DIR, 'laporan', `${plat}_vb`, `${startDate}_to_${endDate}`);
                        if (fs.existsSync(dir)) {
                            const dirFiles = fs.readdirSync(dir);
                            for (const file of dirFiles) {
                                if (file.endsWith('.xlsx')) {
                                    const filePath = path.join(dir, file);
                                    const stats = fs.statSync(filePath);

                                    // Hanya upload file yang dibuat/dimodifikasi selama pipeline ini berjalan
                                    if (stats.mtimeMs >= startTime) {
                                        if (APPS_SCRIPT_DRIVE_URL && APPS_SCRIPT_DRIVE_URL !== "ISI_DENGAN_URL_WEB_APP_APPS_SCRIPT_ANDA") {
                                            try {
                                                const fileContent = fs.readFileSync(filePath);
                                                const base64Content = fileContent.toString('base64');

                                                console.log(`[DRIVE UPLOAD] Uploading ${file}...`);
                                                const driveRes = await uploadToDrive(APPS_SCRIPT_DRIVE_URL, {
                                                    folderId: "1AF7zvgT0fuMTzTrXV_FKwUWj1R7JeOcx",
                                                    platform: `${plat.toUpperCase()}_VB`, // e.g. GRAB_VB or SHOPEE_VB
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
                        driveStatus = '⚠️ *Upload Google Drive belum dikonfigurasi.*';
                    } else if (uploadedFiles.length > 0) {
                        const folderLink = uploadedFolderUrl || "https://drive.google.com/";
                        driveStatus = `📂 **Google Drive Folder:** [Buka Folder Rentang Tanggal](${folderLink})\n` +
                            `*Berhasil mengunggah ${uploadedFiles.length} file (Master + Rincian).*`;
                    } else {
                        driveStatus = '❌ *Gagal mengunggah file laporan ke Google Drive.*';
                    }

                    const successEmbed = new EmbedBuilder()
                        .setColor(0x00C853)
                        .setTitle('✅ Weekly VB Pipeline Selesai!')
                        .setDescription(
                            `Pipeline weekly VB selesai dijalankan dengan sukses.\n\n` +
                            `> 🏢 **Tipe:** ${target.toUpperCase()}\n` +
                            `> 📍 **Platform:** ${platform.toUpperCase()}\n` +
                            `> 📅 **Rentang:** ${startDate} s/d ${endDate}\n` +
                            `${selectedOutlets.length > 0 ? `> 🏪 **Outlet:** ${selectedOutlets.join(', ')}\n` : ''}` +
                            `> ⏱️ **Durasi:** ${durationStr}\n\n` +
                            `${driveStatus}`
                        )
                        .setFooter({ text: 'Sistem Weekly VB Performance' })
                        .setTimestamp();

                    try {
                        await finalInteraction.editReply({
                            embeds: [successEmbed],
                            files: attachments,
                            components: []
                        });
                    } catch (editErr) {
                        await interaction.channel.send({
                            content: `Berhasil menyelesaikan pipeline VB untuk **${platform.toUpperCase()}**!`,
                            embeds: [successEmbed],
                            files: attachments
                        }).catch(() => { });
                    }
                } else {
                    const errSnippet = result.output.slice(-600)
                        .replace(/\x1B\[[0-9;]*m/g, '')
                        .replace(/```/g, "'''");

                    const failedEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('❌ Weekly VB Pipeline Gagal')
                        .setDescription(
                            `Weekly VB pipeline gagal dijalankan.\n\n` +
                            `**Exit Code:** \`${result.exitCode}\`\n` +
                            `**Log terakhir:**\n` +
                            `\`\`\`\n${errSnippet || 'Tidak ada detail error.'}\n\`\`\``
                        )
                        .setFooter({ text: 'Hubungi administrator jika masalah berlanjut.' })
                        .setTimestamp();

                    try {
                        await finalInteraction.editReply({
                            embeds: [failedEmbed],
                            components: []
                        });
                    } catch (editErr) {
                        await interaction.channel.send({
                            content: `Pipeline VB **${platform.toUpperCase()}** gagal!`,
                            embeds: [failedEmbed]
                        }).catch(() => { });
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

                try {
                    await finalInteraction.editReply({
                        embeds: [errorEmbed],
                        components: []
                    });
                } catch (editErr) {
                    await interaction.channel.send({
                        content: `Pipeline VB **${platform.toUpperCase()}** mengalami error sistem!`,
                        embeds: [errorEmbed]
                    }).catch(() => { });
                }
            });

        } catch (err) {
            isWeeklyJobRunning = false;
            activeWeeklyProcess = null;
            console.error('Error during VB flow:', err);
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
                content: '⏹️ **Proses Weekly VB Pipeline dibatalkan secara paksa.**',
                embeds: [],
                components: []
            });
            return true;
        }
        return false;
    }
};
