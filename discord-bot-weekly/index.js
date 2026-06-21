require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// 1. Inisialisasi Client (Bot)
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 2. Collection untuk menyimpan data command
client.commands = new Collection();

// 3. Membaca semua file command di dalam folder src/commands/
const commandsPath = path.join(__dirname, 'src', 'commands');
const commandFolders = fs.readdirSync(commandsPath);

for (const folder of commandFolders) {
    const folderPath = path.join(commandsPath, folder);

    // Periksa apakah ini direktori (folder)
    if (fs.statSync(folderPath).isDirectory()) {
        const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            const filePath = path.join(folderPath, file);
            const command = require(filePath);

            // Set command ke dalam Collection jika ada data dan execute-nya
            if ('data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
            } else {
                console.log(`[WARNING] Command di ${filePath} tidak memiliki properti "data" atau "execute".`);
            }
        }
    }
}

// 4. Event ketika bot berhasil menyala
client.once('clientReady', () => {
    console.log(`Bot Weekly Agency online sebagai ${client.user.tag}!`);
});

// 5. Event ketika user menggunakan Slash Command atau berinteraksi dengan Menu
client.on('interactionCreate', async interaction => {
    // Jika interaksi adalah Slash Command
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);

        if (!command) return;

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            const content = 'Terjadi kesalahan saat mengeksekusi command ini!';
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: content, flags: 64 });
            } else {
                await interaction.reply({ content: content, flags: 64 });
            }
        }
    }
    // Jika interaksi adalah Button
    else if (interaction.isButton()) {
        if (interaction.customId === 'cancel_weekly_pipeline') {
            const agencyCmd = client.commands.get('agency');
            const vbCmd = client.commands.get('vb');
            let cancelled = false;
            if (agencyCmd && agencyCmd.cancelWeeklyPipeline) {
                cancelled = await agencyCmd.cancelWeeklyPipeline(interaction);
            }
            if (!cancelled && vbCmd && vbCmd.cancelWeeklyPipeline) {
                cancelled = await vbCmd.cancelWeeklyPipeline(interaction);
            }
        }
    }
});

// 6. Penanganan Error Global (Mencegah bot mati total)
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

client.on('error', error => {
    console.error('Discord client error:', error);
});

// 7. Login ke Discord dengan Fungsi Retry
const startBot = async () => {
    try {
        console.log('Sedang mencoba menghubungkan ke Discord (Weekly Agency Bot)...');
        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        console.error('Gagal login ke Discord:', error);
        console.log('Mencoba login kembali dalam 10 detik...');
        setTimeout(startBot, 10000); // Retry setiap 10 detik jika gagal
    }
};

startBot();
