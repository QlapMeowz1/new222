require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');
const fs = require('fs');
const path = require('path');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SOUNDCLOUD_CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;
const PREFIX = '!';
const DJ_ROLE_NAME = 'DJ';
const DATA_PATH = './data';

// Tạo thư mục data nếu chưa có
if (!fs.existsSync(DATA_PATH)) {
    fs.mkdirSync(DATA_PATH);
}

// Cấu hình play-dl
play.setToken({
    soundcloud: {
        client_id: SOUNDCLOUD_CLIENT_ID
    }
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
    ]
});

const queues = new Map();
const history = new Map();

// Audio Filters
const filters = {
    'bassboost': 'bass=g=10',
    'nightcore': 'atempo=1.3,asetrate=48000*1.25',
    'vaporwave': 'atempo=0.8',
    '8d': 'apulsator=hz=0.08',
    'echo': 'aecho=0.8:0.9:1000:0.3',
    'karaoke': 'stereotools=mlev=0.1',
    'chipmunk': 'atempo=2,asetrate=48000*1.5',
    'slow': 'atempo=0.5',
    'normal': ''
};

// ============ BOT READY ============
client.once('ready', () => {
    console.log(`✅ Bot đã sẵn sàng! Đã đăng nhập với tên: ${client.user.tag}`);
    console.log(`✅ Bot đang hoạt động trên ${client.guilds.cache.size} server(s)`);
});

// ============ XỬ LÝ REACTION ĐIỀU KHIỂN ============
client.on('interactionCreate', async (interaction) => {
    // Xử lý Select Menu cho play và search
    if (interaction.isStringSelectMenu()) {
        // Đã được xử lý trong awaitMessageComponent, nên không cần làm gì thêm
        return;
    }
    
    // Xử lý Button
    if (!interaction.isButton()) return;
    
    const { customId, guildId, member } = interaction;
    const serverQueue = queues.get(guildId);
    
    if (!serverQueue) {
        return interaction.reply({ content: '❌ Không có nhạc đang phát!', ephemeral: true });
    }
    
    // Kiểm tra quyền DJ
    if (!member.roles.cache.some(r => r.name === DJ_ROLE_NAME) && !member.permissions.has('ManageChannels')) {
        return interaction.reply({ content: '❌ Bạn cần role DJ!', ephemeral: true });
    }
    
    switch(customId) {
        case 'pause_btn':
            serverQueue.player.pause();
            await interaction.reply({ content: '⏸️ Đã tạm dừng!', ephemeral: true });
            break;
        case 'resume_btn':
            serverQueue.player.unpause();
            await interaction.reply({ content: '▶️ Đã tiếp tục!', ephemeral: true });
            break;
        case 'skip_btn':
            serverQueue.player.stop();
            await interaction.reply({ content: '⏭️ Đã skip!', ephemeral: true });
            break;
        case 'stop_btn':
            serverQueue.songs = [];
            serverQueue.player.stop();
            serverQueue.connection.destroy();
            queues.delete(guildId);
            await interaction.reply({ content: '⏹️ Đã dừng!', ephemeral: true });
            break;
        case 'loop_btn':
            serverQueue.loop = !serverQueue.loop;
            await interaction.reply({ content: `🔁 Loop: ${serverQueue.loop ? 'BẬT' : 'TẮT'}`, ephemeral: true });
            break;
        case 'shuffle_btn':
            const current = serverQueue.songs.shift();
            for (let i = serverQueue.songs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [serverQueue.songs[i], serverQueue.songs[j]] = [serverQueue.songs[j], serverQueue.songs[i]];
            }
            serverQueue.songs.unshift(current);
            await interaction.reply({ content: '🔀 Đã trộn danh sách!', ephemeral: true });
            break;
        case 'queue_btn':
            const queueEmbed = createQueueEmbed(serverQueue);
            await interaction.reply({ embeds: [queueEmbed], ephemeral: true });
            break;
        case 'np_btn':
            const npEmbed = createNPEmbed(serverQueue);
            await interaction.reply({ embeds: [npEmbed], ephemeral: true });
            break;
    }
});

// ============ XỬ LÝ TIN NHẮN ============
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Kiểm tra quyền DJ
    const djCommands = ['play', 'skip', 'stop', 'pause', 'resume', 'volume', 'shuffle', 'remove', 'loop', 'filter'];
    if (djCommands.includes(command)) {
        if (!hasDJPermission(message)) {
            return message.reply('❌ Bạn cần role **DJ** hoặc quyền **Quản lý kênh** để dùng lệnh này!');
        }
    }

    // ========== PLAY ==========
    if (command === 'play' || command === 'p') {
        const query = args.join(' ');
        if (!query) return message.reply('❌ Vui lòng nhập tên bài hát hoặc link SoundCloud!');
        await playHandler(message, query);
    }

    // ========== SEARCH ==========
    else if (command === 'search') {
        const query = args.join(' ');
        if (!query) return message.reply('❌ Vui lòng nhập từ khóa tìm kiếm!');
        await searchHandler(message, query);
    }

    // ========== QUEUE ==========
    else if (command === 'queue' || command === 'q') {
        await queueHandler(message);
    }

    // ========== NOW PLAYING ==========
    else if (command === 'np' || command === 'nowplaying') {
        await npHandler(message);
    }

    // ========== PAUSE ==========
    else if (command === 'pause') {
        await pauseHandler(message);
    }

    // ========== RESUME ==========
    else if (command === 'resume') {
        await resumeHandler(message);
    }

    // ========== SKIP ==========
    else if (command === 'skip' || command === 's') {
        await skipHandler(message);
    }

    // ========== REMOVE ==========
    else if (command === 'remove') {
        await removeHandler(message, args[0]);
    }

    // ========== SHUFFLE ==========
    else if (command === 'shuffle') {
        await shuffleHandler(message);
    }

    // ========== LOOP ==========
    else if (command === 'loop') {
        await loopHandler(message);
    }

    // ========== VOLUME ==========
    else if (command === 'volume' || command === 'vol') {
        await volumeHandler(message, args[0]);
    }

    // ========== STOP ==========
    else if (command === 'stop') {
        await stopHandler(message);
    }

    // ========== FILTER ==========
    else if (command === 'filter') {
        await filterHandler(message, args);
    }

    // ========== SAVE QUEUE ==========
    else if (command === 'save') {
        await saveQueueHandler(message, args[0]);
    }

    // ========== LOAD QUEUE ==========
    else if (command === 'load') {
        await loadQueueHandler(message, args[0]);
    }

    // ========== LIST SAVED ==========
    else if (command === 'saved') {
        await listSavedHandler(message);
    }

    // ========== HISTORY ==========
    else if (command === 'history') {
        await historyHandler(message);
    }

    // ========== AUTOPLAY ==========
    else if (command === 'autoplay') {
        await autoplayHandler(message);
    }

    // ========== PANEL ==========
    else if (command === 'panel') {
        await panelHandler(message);
    }

    // ========== STATS ==========
    else if (command === 'stats') {
        await statsHandler(message);
    }

    // ========== HELP ==========
    else if (command === 'help') {
        await helpHandler(message);
    }
});

// ============ CÁC HÀM HANDLER ============

async function playHandler(message, query) {
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) return message.reply('❌ Bạn phải ở trong kênh thoại!');

    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has('Connect') || !permissions.has('Speak')) {
        return message.reply('❌ Bot cần quyền Kết nối và Nói!');
    }

    try {
        // Kiểm tra playlist
        if (query.includes('/sets/')) {
            const loadingMsg = await message.reply('🔄 Đang tải playlist...');
            const playlist = await play.soundcloud(query);
            const tracks = await playlist.all_tracks();
            
            const serverQueue = getOrCreateQueue(message);
            tracks.forEach(track => serverQueue.songs.push(track));
            
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('📋 Playlist đã thêm')
                .setDescription(`**${playlist.name}**`)
                .addFields(
                    { name: '📊 Số bài', value: `${tracks.length}`, inline: true },
                    { name: '📌 Vị trí cuối', value: `#${serverQueue.songs.length}`, inline: true }
                );
            
            await loadingMsg.edit({ content: null, embeds: [embed] });
            
            if (!serverQueue.connection) {
                joinAndPlay(message, voiceChannel);
            }
            return;
        }

        // Nếu là link SoundCloud trực tiếp
        if (query.startsWith('https://soundcloud.com/') && !query.includes('/sets/')) {
            const songInfo = await play.soundcloud(query);
            const serverQueue = getOrCreateQueue(message);
            serverQueue.songs.push(songInfo);
            addToHistory(message.guild.id, songInfo);
            
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Đã thêm vào hàng đợi')
                .setDescription(`[${songInfo.name}](${songInfo.url})`)
                .addFields(
                    { name: '👤 Nghệ sĩ', value: songInfo.user?.name || 'Unknown', inline: true },
                    { name: '⏱️ Thời lượng', value: songInfo.durationRaw || 'N/A', inline: true },
                    { name: '📊 Vị trí', value: `#${serverQueue.songs.length}`, inline: true }
                );

            message.reply({ embeds: [embed] });
            
            if (!serverQueue.connection) {
                joinAndPlay(message, voiceChannel);
            }
            return;
        }

        // Tìm kiếm bài hát
        const searchResults = await play.search(query, { 
            source: { soundcloud: "tracks" }, 
            limit: 10 
        });
        
        if (!searchResults || searchResults.length === 0) {
            return message.reply('❌ Không tìm thấy bài hát nào!');
        }

        // Tạo Select Menu
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`select_song_${message.author.id}`)
            .setPlaceholder('🎵 Chọn bài hát muốn phát...')
            .addOptions(
                searchResults.map((track, index) => ({
                    label: track.name.substring(0, 100),
                    description: `👤 ${track.user?.name || 'Unknown'} | ⏱️ ${track.durationRaw || 'N/A'}`.substring(0, 100),
                    value: `track_${index}`,
                    emoji: index === 0 ? '🎵' : '🎶'
                }))
            );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const embed = new EmbedBuilder()
            .setColor('#FF7700')
            .setTitle(`🔍 Kết quả tìm kiếm cho: "${query}"`)
            .setDescription('👇 **Chọn bài hát từ menu bên dưới** (Hết hạn sau 60 giây)')
            .addFields(
                searchResults.map((track, index) => ({
                    name: `${index + 1}. ${track.name}`,
                    value: `👤 ${track.user?.name || 'Unknown'} | ⏱️ ${track.durationRaw || 'N/A'}`,
                    inline: false
                }))
            )
            .setFooter({ text: `Tìm thấy ${searchResults.length} kết quả | Menu sẽ tự hủy sau 60s` });

        const response = await message.reply({ 
            embeds: [embed], 
            components: [row] 
        });

        // ========== SỬA #1: Chờ người dùng chọn (dùng deferUpdate) ==========
        const filter = i => i.customId === `select_song_${message.author.id}` && i.user.id === message.author.id;
        
        try {
            const interaction = await response.awaitMessageComponent({ filter, time: 60000 });
            
            // QUAN TRỌNG: Defer update để tránh lỗi "This interaction failed"
            await interaction.deferUpdate();
            
            const selectedIndex = parseInt(interaction.values[0].replace('track_', ''));
            const songInfo = searchResults[selectedIndex];

            const serverQueue = getOrCreateQueue(message);
            serverQueue.songs.push(songInfo);
            addToHistory(message.guild.id, songInfo);

            // Cập nhật message với bài đã chọn
            const updatedEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Đã thêm vào hàng đợi')
                .setDescription(`[${songInfo.name}](${songInfo.url})`)
                .addFields(
                    { name: '👤 Nghệ sĩ', value: songInfo.user?.name || 'Unknown', inline: true },
                    { name: '⏱️ Thời lượng', value: songInfo.durationRaw || 'N/A', inline: true },
                    { name: '📊 Vị trí', value: `#${serverQueue.songs.length}`, inline: true },
                    { name: '👤 Người chọn', value: interaction.user.tag, inline: true }
                )
                .setThumbnail(songInfo.thumbnail?.url || null);

            await interaction.editReply({ 
                embeds: [updatedEmbed], 
                components: [] 
            });

            if (!serverQueue.connection) {
                joinAndPlay(message, voiceChannel);
            }

        } catch (error) {
            // Hết thời gian
            const timeoutEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⏰ Hết thời gian chọn')
                .setDescription('Bạn đã không chọn bài hát trong 60 giây!')
                .setFooter({ text: 'Dùng !play <tên> để tìm kiếm lại' });

            await response.edit({ 
                embeds: [timeoutEmbed], 
                components: [] 
            }).catch(() => {});
        }

    } catch (error) {
        console.error('Lỗi play:', error);
        message.reply('❌ Lỗi: ' + error.message);
    }
}

async function searchHandler(message, query) {
    try {
        const searchResults = await play.search(query, { 
            source: { soundcloud: "tracks" }, 
            limit: 10 
        });
        
        if (!searchResults || searchResults.length === 0) {
            return message.reply('❌ Không tìm thấy bài hát nào!');
        }

        // Tạo Select Menu
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`search_select_${message.author.id}`)
            .setPlaceholder('🔍 Chọn bài hát để phát...')
            .addOptions(
                searchResults.map((track, index) => ({
                    label: track.name.substring(0, 100),
                    description: `👤 ${track.user?.name || 'Unknown'} | ⏱️ ${track.durationRaw || 'N/A'}`.substring(0, 100),
                    value: `search_track_${index}`,
                    emoji: '🎵'
                }))
            );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const embed = new EmbedBuilder()
            .setColor('#FF7700')
            .setTitle(`🔍 Kết quả tìm kiếm cho: "${query}"`)
            .setDescription('👇 **Chọn bài hát từ menu bên dưới** (Hết hạn sau 60 giây)')
            .addFields(
                searchResults.map((track, index) => ({
                    name: `${index + 1}. ${track.name}`,
                    value: `👤 ${track.user?.name || 'Unknown'} | ⏱️ ${track.durationRaw || 'N/A'} | [Link](${track.url})`,
                    inline: false
                }))
            )
            .setFooter({ text: `Tìm thấy ${searchResults.length} kết quả | Menu tự hủy sau 60s` });

        const response = await message.reply({ 
            embeds: [embed], 
            components: [row] 
        });

        // ========== SỬA #2: Chờ người dùng chọn (dùng deferUpdate) ==========
        const filter = i => i.customId === `search_select_${message.author.id}` && i.user.id === message.author.id;
        
        try {
            const interaction = await response.awaitMessageComponent({ filter, time: 60000 });
            
            // QUAN TRỌNG: Defer update để tránh lỗi
            await interaction.deferUpdate();
            
            const selectedIndex = parseInt(interaction.values[0].replace('search_track_', ''));
            const songInfo = searchResults[selectedIndex];

            const voiceChannel = message.member?.voice.channel;
            if (!voiceChannel) {
                return interaction.editReply({ 
                    content: '❌ Bạn phải vào kênh thoại trước!', 
                    embeds: [], 
                    components: [] 
                });
            }

            const serverQueue = getOrCreateQueue(message);
            serverQueue.songs.push(songInfo);
            addToHistory(message.guild.id, songInfo);

            const updatedEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Đã thêm vào hàng đợi')
                .setDescription(`[${songInfo.name}](${songInfo.url})`)
                .addFields(
                    { name: '👤 Nghệ sĩ', value: songInfo.user?.name || 'Unknown', inline: true },
                    { name: '⏱️ Thời lượng', value: songInfo.durationRaw || 'N/A', inline: true },
                    { name: '📊 Vị trí', value: `#${serverQueue.songs.length}`, inline: true },
                    { name: '👤 Người chọn', value: interaction.user.tag, inline: true }
                )
                .setThumbnail(songInfo.thumbnail?.url || null);

            await interaction.editReply({ 
                embeds: [updatedEmbed], 
                components: [] 
            });

            if (!serverQueue.connection) {
                joinAndPlay(message, voiceChannel);
            }

        } catch (error) {
            console.error('Lỗi search select:', error);
            const timeoutEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⏰ Hết thời gian chọn')
                .setDescription('Bạn đã không chọn bài hát trong 60 giây!')
                .setFooter({ text: 'Dùng !search <từ khóa> để tìm kiếm lại' });

            await response.edit({ 
                embeds: [timeoutEmbed], 
                components: [] 
            }).catch(() => {});
        }

    } catch (error) {
        console.error('Lỗi search:', error);
        message.reply('❌ Lỗi tìm kiếm: ' + error.message);
    }
}

async function queueHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
        return message.reply('📭 Hàng đợi trống!');
    }

    const embed = createQueueEmbed(serverQueue);
    message.reply({ embeds: [embed] });
}

async function npHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
        return message.reply('❌ Không có bài nào đang phát!');
    }

    const embed = createNPEmbed(serverQueue);
    message.reply({ embeds: [embed] });
}

async function pauseHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue?.player) return message.reply('❌ Không có bài nào đang phát!');
    if (serverQueue.player.state.status === 'paused') return message.reply('⏸️ Đã tạm dừng rồi!');
    
    serverQueue.player.pause();
    message.reply('⏸️ Đã tạm dừng!');
}

async function resumeHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue?.player) return message.reply('❌ Không có bài nào đang phát!');
    if (serverQueue.player.state.status !== 'paused') return message.reply('▶️ Nhạc đang phát rồi!');
    
    serverQueue.player.unpause();
    message.reply('▶️ Đã tiếp tục!');
}

async function skipHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue?.player) return message.reply('❌ Không có bài nào đang phát!');
    
    const skipped = serverQueue.songs[0];
    serverQueue.player.stop();
    
    const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('⏭️ Đã skip')
        .setDescription(`[${skipped.name}](${skipped.url})`);
    
    message.reply({ embeds: [embed] });
}

async function removeHandler(message, indexStr) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) return message.reply('❌ Hàng đợi trống!');
    
    const index = parseInt(indexStr);
    if (isNaN(index) || index < 1 || index >= serverQueue.songs.length) {
        return message.reply(`❌ Nhập số từ 1 đến ${serverQueue.songs.length - 1}!`);
    }
    
    const removed = serverQueue.songs.splice(index, 1)[0];
    message.reply(`🗑️ Đã xóa: **${removed.name}**`);
}

async function shuffleHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length < 2) return message.reply('❌ Cần ít nhất 2 bài!');
    
    const current = serverQueue.songs.shift();
    for (let i = serverQueue.songs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [serverQueue.songs[i], serverQueue.songs[j]] = [serverQueue.songs[j], serverQueue.songs[i]];
    }
    serverQueue.songs.unshift(current);
    
    message.reply('🔀 Đã trộn danh sách!');
}

async function loopHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue) return message.reply('❌ Không có bài nào đang phát!');
    
    serverQueue.loop = !serverQueue.loop;
    
    const embed = new EmbedBuilder()
        .setColor(serverQueue.loop ? '#00FF00' : '#FF0000')
        .setTitle(serverQueue.loop ? '🔁 Loop: BẬT' : '🔁 Loop: TẮT')
        .setDescription(serverQueue.loop ? 'Bài hát sẽ lặp lại' : 'Phát bình thường');
    
    message.reply({ embeds: [embed] });
}

// ========== Hàm volumeHandler ==========
async function volumeHandler(message, volStr) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue?.player) return message.reply('❌ Không có bài nào đang phát!');
    
    const volume = parseInt(volStr);
    if (isNaN(volume) || volume < 0 || volume > 200) {
        return message.reply('❌ Vui lòng nhập âm lượng từ 0-200!');
    }
    
    serverQueue.volume = volume / 100;
    
    if (serverQueue.resource && serverQueue.resource.volume) {
        serverQueue.resource.volume.setVolume(serverQueue.volume);
    }
    
    const filledBars = Math.floor(volume / 10);
    const emptyBars = 20 - filledBars;
    
    const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('🔊 Âm lượng')
        .setDescription(`${'█'.repeat(filledBars)}${'░'.repeat(emptyBars)}`)
        .addFields({ name: 'Giá trị', value: `${volume}%`, inline: true });
    
    message.reply({ embeds: [embed] });
}

async function stopHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue?.connection) return message.reply('❌ Bot không ở trong kênh!');
    
    serverQueue.songs = [];
    serverQueue.player?.stop();
    serverQueue.connection.destroy();
    queues.delete(message.guild.id);
    message.reply('⏹️ Đã dừng và rời kênh!');
}

async function filterHandler(message, args) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue?.player) return message.reply('❌ Không có bài nào đang phát!');
    
    if (!args.length) {
        const filterList = Object.keys(filters).join(', ');
        return message.reply(`🎛️ Filters có sẵn: \`${filterList}\`\nDùng: \`!filter <tên>\` hoặc \`!filter normal\` để tắt`);
    }
    
    const filterName = args[0].toLowerCase();
    if (!filters[filterName]) {
        return message.reply('❌ Filter không tồn tại! Dùng `!filter` để xem danh sách');
    }
    
    serverQueue.filter = filterName;
    
    const embed = new EmbedBuilder()
        .setColor('#FF00FF')
        .setTitle('🎨 Audio Filter')
        .setDescription(`Filter: **${filterName}**`)
        .addFields({ name: 'FFmpeg', value: `\`${filters[filterName]}\`` });
    
    message.reply({ embeds: [embed] });
    
    if (serverQueue.player.state.status === 'playing') {
        serverQueue.player.stop();
    }
}

async function saveQueueHandler(message, name) {
    if (!name) return message.reply('❌ Vui lòng đặt tên: `!save <tên>`');
    
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) {
        return message.reply('❌ Không có gì để lưu!');
    }
    
    const saveData = {
        name: name,
        songs: serverQueue.songs.map(s => ({
            name: s.name,
            url: s.url,
            user: s.user?.name,
            duration: s.durationRaw
        })),
        filter: serverQueue.filter,
        volume: serverQueue.volume,
        loop: serverQueue.loop,
        savedBy: message.author.tag,
        savedAt: new Date().toISOString()
    };
    
    const filePath = path.join(DATA_PATH, `queue_${message.guild.id}_${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(saveData, null, 2));
    
    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('💾 Đã lưu danh sách phát')
        .addFields(
            { name: '📝 Tên', value: name, inline: true },
            { name: '📊 Số bài', value: `${serverQueue.songs.length}`, inline: true },
            { name: '👤 Người lưu', value: message.author.tag, inline: true }
        );
    
    message.reply({ embeds: [embed] });
}

async function loadQueueHandler(message, name) {
    if (!name) return message.reply('❌ Vui lòng nhập tên: `!load <tên>`');
    
    const filePath = path.join(DATA_PATH, `queue_${message.guild.id}_${name}.json`);
    
    if (!fs.existsSync(filePath)) {
        return message.reply('❌ Không tìm thấy danh sách đã lưu! Dùng `!saved` để xem danh sách');
    }
    
    const saveData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const serverQueue = getOrCreateQueue(message);
    
    for (const savedSong of saveData.songs) {
        try {
            const songInfo = await play.soundcloud(savedSong.url);
            serverQueue.songs.push(songInfo);
        } catch (e) {
            console.error(`Không thể tải: ${savedSong.name}`);
        }
    }
    
    serverQueue.filter = saveData.filter || 'normal';
    serverQueue.volume = saveData.volume || 0.3;
    serverQueue.loop = saveData.loop || false;
    
    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('📂 Đã tải danh sách phát')
        .addFields(
            { name: '📝 Tên', value: name, inline: true },
            { name: '📊 Số bài', value: `${serverQueue.songs.length}`, inline: true },
            { name: '🎨 Filter', value: serverQueue.filter, inline: true }
        );
    
    message.reply({ embeds: [embed] });
    
    if (!serverQueue.connection) {
        const voiceChannel = message.member?.voice.channel;
        if (voiceChannel) {
            joinAndPlay(message, voiceChannel);
        }
    }
}

async function listSavedHandler(message) {
    const files = fs.readdirSync(DATA_PATH)
        .filter(f => f.startsWith(`queue_${message.guild.id}_`))
        .map(f => f.replace(`queue_${message.guild.id}_`, '').replace('.json', ''));
    
    if (files.length === 0) {
        return message.reply('📭 Chưa có danh sách nào được lưu!');
    }
    
    const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('💾 Danh sách đã lưu')
        .setDescription(files.map((f, i) => `**${i+1}.** ${f}`).join('\n'))
        .setFooter({ text: `Dùng !load <tên> để tải` });
    
    message.reply({ embeds: [embed] });
}

async function historyHandler(message) {
    const guildHistory = history.get(message.guild.id) || [];
    
    if (guildHistory.length === 0) {
        return message.reply('📜 Chưa có lịch sử phát!');
    }
    
    const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('📜 Lịch sử phát (20 bài gần nhất)')
        .setDescription(
            guildHistory.slice(-20).reverse().map((s, i) => 
                `**${i+1}.** [${s.name}](${s.url}) - ${s.user || 'Unknown'}`
            ).join('\n')
        );
    
    message.reply({ embeds: [embed] });
}

async function autoplayHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue) return message.reply('❌ Chưa có queue!');
    
    serverQueue.autoplay = !serverQueue.autoplay;
    
    const embed = new EmbedBuilder()
        .setColor(serverQueue.autoplay ? '#00FF00' : '#FF0000')
        .setTitle(serverQueue.autoplay ? '🔄 Autoplay: BẬT' : '🔄 Autoplay: TẮT')
        .setDescription(serverQueue.autoplay ? 'Sẽ tự động phát bài liên quan' : 'Sẽ dừng khi hết queue');
    
    message.reply({ embeds: [embed] });
}

async function panelHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('pause_btn').setLabel('⏸️ Pause').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('resume_btn').setLabel('▶️ Resume').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('skip_btn').setLabel('⏭️ Skip').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('stop_btn').setLabel('⏹️ Stop').setStyle(ButtonStyle.Danger),
        );
    
    const row2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder().setCustomId('loop_btn').setLabel('🔁 Loop').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('shuffle_btn').setLabel('🔀 Shuffle').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('queue_btn').setLabel('📋 Queue').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('np_btn').setLabel('🎵 Now Playing').setStyle(ButtonStyle.Secondary),
        );
    
    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('🎛️ Music Control Panel')
        .setDescription('Sử dụng nút bên dưới để điều khiển nhạc')
        .setFooter({ text: 'Yêu cầu role DJ để sử dụng' });
    
    if (serverQueue && serverQueue.songs.length > 0) {
        embed.addFields({ name: '🎵 Đang phát', value: serverQueue.songs[0].name });
    }
    
    message.channel.send({ embeds: [embed], components: [row1, row2] });
}

async function statsHandler(message) {
    const serverQueue = queues.get(message.guild.id);
    const guildHistory = history.get(message.guild.id) || [];
    
    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('📊 Bot Statistics')
        .addFields(
            { name: '🎵 Đang phát', value: serverQueue?.songs[0]?.name || 'Không có', inline: false },
            { name: '📋 Trong queue', value: `${serverQueue?.songs.length || 0} bài`, inline: true },
            { name: '🔁 Loop', value: serverQueue?.loop ? 'Bật' : 'Tắt', inline: true },
            { name: '🔄 Autoplay', value: serverQueue?.autoplay ? 'Bật' : 'Tắt', inline: true },
            { name: '🔊 Volume', value: `${(serverQueue?.volume || 0.3) * 100}%`, inline: true },
            { name: '🎨 Filter', value: serverQueue?.filter || 'normal', inline: true },
            { name: '📜 Lịch sử', value: `${guildHistory.length} bài`, inline: true },
            { name: '⏱️ Uptime', value: formatUptime(process.uptime()), inline: true }
        );
    
    message.reply({ embeds: [embed] });
}

async function helpHandler(message) {
    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('🎵 MUSIC BOT PRO - HƯỚNG DẪN')
        .setDescription(`Prefix: \`${PREFIX}\` | Role DJ: \`${DJ_ROLE_NAME}\``)
        .addFields(
            { name: '📌 PHÁT NHẠC', value: '`!play <tên/link>` - Phát nhạc/playlist\n`!search <từ khóa>` - Tìm kiếm', inline: false },
            { name: '📋 QUẢN LÝ', value: '`!queue` - Danh sách phát\n`!np` - Bài đang phát\n`!remove <số>` - Xóa bài\n`!history` - Lịch sử', inline: false },
            { name: '🎛️ ĐIỀU KHIỂN', value: '`!pause` - Tạm dừng\n`!resume` - Tiếp tục\n`!skip` - Bỏ qua\n`!shuffle` - Trộn\n`!loop` - Lặp\n`!stop` - Dừng', inline: false },
            { name: '🎨 HIỆU ỨNG', value: '`!filter <tên>` - Audio filter\n`!volume <0-200>` - Âm lượng', inline: false },
            { name: '💾 LƯU TRỮ', value: '`!save <tên>` - Lưu queue\n`!load <tên>` - Tải queue\n`!saved` - DS đã lưu', inline: false },
            { name: '🔄 TỰ ĐỘNG', value: '`!autoplay` - Bật/tắt tự động phát\n`!panel` - Bảng điều khiển\n`!stats` - Thống kê', inline: false }
        )
        .setFooter({ text: 'Powered by SoundCloud | Made with ❤️' });
    
    message.reply({ embeds: [embed] });
}

// ============ CÁC HÀM HỖ TRỢ ============

function hasDJPermission(message) {
    if (message.member.permissions.has('ManageChannels')) return true;
    if (message.member.roles.cache.some(r => r.name === DJ_ROLE_NAME)) return true;
    return false;
}

function getOrCreateQueue(message) {
    const guildId = message.guild.id;
    if (!queues.has(guildId)) {
        queues.set(guildId, {
            textChannel: message.channel,
            voiceChannel: message.member.voice.channel,
            connection: null,
            player: null,
            resource: null,
            songs: [],
            volume: 0.3,
            loop: false,
            autoplay: false,
            filter: 'normal'
        });
    }
    return queues.get(guildId);
}

function addToHistory(guildId, song) {
    if (!history.has(guildId)) {
        history.set(guildId, []);
    }
    const guildHistory = history.get(guildId);
    guildHistory.push({
        name: song.name,
        url: song.url,
        user: song.user?.name,
        duration: song.durationRaw,
        playedAt: new Date().toISOString()
    });
    
    if (guildHistory.length > 100) {
        guildHistory.shift();
    }
}

function createQueueEmbed(serverQueue) {
    const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('📋 Danh sách phát')
        .setDescription(
            serverQueue.songs.map((song, i) => {
                const prefix = i === 0 ? '▶️ ' : `${i}. `;
                return `${prefix}[${song.name}](${song.url}) | \`${song.durationRaw || 'N/A'}\``;
            }).join('\n').substring(0, 4000) || 'Trống'
        )
        .addFields(
            { name: '📊 Tổng số bài', value: `${serverQueue.songs.length}`, inline: true },
            { name: '🔁 Loop', value: serverQueue.loop ? 'Bật' : 'Tắt', inline: true },
            { name: '🔄 Autoplay', value: serverQueue.autoplay ? 'Bật' : 'Tắt', inline: true }
        );
    
    return embed;
}

function createNPEmbed(serverQueue) {
    const song = serverQueue.songs[0];
    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('🎵 Đang phát')
        .setDescription(`[${song.name}](${song.url})`)
        .addFields(
            { name: '👤 Nghệ sĩ', value: song.user?.name || 'Unknown', inline: true },
            { name: '⏱️ Thời lượng', value: song.durationRaw || 'N/A', inline: true },
            { name: '🔊 Volume', value: `${(serverQueue.volume || 0.3) * 100}%`, inline: true },
            { name: '🎨 Filter', value: serverQueue.filter || 'normal', inline: true },
            { name: '🔁 Loop', value: serverQueue.loop ? 'Bật' : 'Tắt', inline: true },
            { name: '🔄 Autoplay', value: serverQueue.autoplay ? 'Bật' : 'Tắt', inline: true }
        )
        .setThumbnail(song.thumbnail?.url || null);
    
    return embed;
}

// ========== SỬA #3: Hàm joinAndPlay linh hoạt hơn ==========
function joinAndPlay(source, voiceChannel) {
    const guildId = source.guild?.id || source.guildId;
    const serverQueue = queues.get(guildId);
    
    if (!serverQueue) return;
    
    try {
        serverQueue.connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guildId,
            adapterCreator: (source.guild || message?.guild)?.voiceAdapterCreator,
        });
        playSong(guildId);
    } catch (error) {
        console.error('Lỗi kết nối:', error);
        queues.delete(guildId);
        if (source.reply) {
            source.reply('❌ Không thể kết nối vào kênh thoại!').catch(() => {});
        } else if (source.channel) {
            source.channel.send('❌ Không thể kết nối vào kênh thoại!').catch(() => {});
        }
    }
}

async function playSong(guildId) {
    const serverQueue = queues.get(guildId);
    if (!serverQueue) return;

    if (serverQueue.songs.length === 0) {
        if (serverQueue.autoplay) {
            try {
                const guildHistory = history.get(guildId) || [];
                const lastSong = guildHistory[guildHistory.length - 1];
                
                if (lastSong) {
                    const related = await play.search(lastSong.name, { 
                        source: { soundcloud: "tracks" }, 
                        limit: 5 
                    });
                    
                    if (related && related.length > 1) {
                        const randomIndex = Math.floor(Math.random() * (related.length - 1)) + 1;
                        serverQueue.songs.push(related[randomIndex]);
                        serverQueue.textChannel.send(`🔄 Autoplay: Đã thêm **${related[randomIndex].name}**`);
                    }
                }
            } catch (e) {
                console.error('Lỗi autoplay:', e);
            }
        }
        
        if (serverQueue.songs.length === 0) {
            setTimeout(() => {
                if (serverQueue.connection && serverQueue.songs.length === 0) {
                    serverQueue.connection.destroy();
                    queues.delete(guildId);
                }
            }, 60000);
            return;
        }
    }

    const song = serverQueue.songs[0];
    
    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('▶️ Đang phát')
        .setDescription(`[${song.name}](${song.url})`)
        .addFields(
            { name: '👤 Nghệ sĩ', value: song.user?.name || 'Unknown', inline: true },
            { name: '⏱️', value: song.durationRaw || 'N/A', inline: true }
        );

    try {
        const loadingMsg = await serverQueue.textChannel.send('🔄 Đang tải nhạc...');
        
        let stream = null;
        let streamType = 0;

        // CÁCH 1
        try {
            console.log(`🎵 Thử stream URL gốc: ${song.url}`);
            
            let streamUrl = song.url;
            if (streamUrl.includes('api.soundcloud.com/tracks/soundcloud%3Atracks%3A')) {
                const trackId = streamUrl.split('%3A').pop();
                streamUrl = `https://soundcloud.com/track/${trackId}`;
                console.log(`🔄 Đã chuyển URL: ${streamUrl}`);
                
                try {
                    const trackInfo = await play.soundcloud(streamUrl);
                    stream = await play.stream(trackInfo.url);
                    streamType = stream.type;
                } catch (e) {
                    console.log('❌ Không thể stream từ URL đã chuyển đổi');
                }
            }
            
            if (!stream) {
                stream = await play.stream(song.url);
                streamType = stream.type;
            }
        } catch (e1) {
            console.log(`❌ Cách 1 thất bại: ${e1.message}`);
        }

        // CÁCH 2
        if (!stream) {
            try {
                console.log(`🔍 Cách 2: Tìm kiếm lại "${song.name}"`);
                const searchResults = await play.search(song.name, { 
                    source: { soundcloud: "tracks" }, 
                    limit: 3 
                });
                
                if (searchResults && searchResults.length > 0) {
                    for (const result of searchResults) {
                        try {
                            console.log(`🎵 Thử stream: ${result.name} - ${result.url}`);
                            stream = await play.stream(result.url);
                            streamType = stream.type;
                            if (result.url !== song.url) {
                                serverQueue.songs[0] = result;
                                console.log(`✅ Đã thay thế bằng: ${result.name}`);
                            }
                            break;
                        } catch (e) {
                            console.log(`❌ Thất bại với: ${result.name}`);
                            continue;
                        }
                    }
                }
            } catch (e2) {
                console.log(`❌ Cách 2 thất bại: ${e2.message}`);
            }
        }

        // CÁCH 3
        if (!stream) {
            try {
                console.log(`🔍 Cách 3: Thử stream với soundcloud track info`);
                const trackInfo = await play.soundcloud(song.url).catch(async () => {
                    const results = await play.search(song.name, { limit: 1, source: { soundcloud: "tracks" } });
                    return results[0];
                });
                
                if (trackInfo && trackInfo.url) {
                    stream = await play.stream(trackInfo.url);
                    streamType = stream.type;
                }
            } catch (e3) {
                console.log(`❌ Cách 3 thất bại: ${e3.message}`);
            }
        }

        await loadingMsg.delete().catch(() => {});

        if (!stream || !stream.stream) {
            throw new Error('Không thể stream bài hát này. Bài hát có thể đã bị xóa hoặc không khả dụng.');
        }

        serverQueue.resource = createAudioResource(stream.stream, { 
            inputType: streamType || 0,
            inlineVolume: true
        });
        
        if (!serverQueue.resource) {
            throw new Error('Không thể tạo audio resource');
        }

        if (serverQueue.resource.volume) {
            serverQueue.resource.volume.setVolume(serverQueue.volume || 0.3);
        }

        if (!serverQueue.player) {
            serverQueue.player = createAudioPlayer();
            
            if (!serverQueue.connection) {
                throw new Error('Không có kết nối voice channel');
            }
            
            serverQueue.connection.subscribe(serverQueue.player);
        }

        serverQueue.player.play(serverQueue.resource);
        
        await serverQueue.textChannel.send({ embeds: [embed] });
        
        addToHistory(guildId, song);

        serverQueue.player.removeAllListeners(AudioPlayerStatus.Idle);
        serverQueue.player.on(AudioPlayerStatus.Idle, () => {
            if (serverQueue.loop) {
                const currentSong = serverQueue.songs.shift();
                serverQueue.songs.push(currentSong);
            } else {
                serverQueue.songs.shift();
            }
            playSong(guildId);
        });

        serverQueue.player.on('error', (error) => {
            console.error('❌ Player error:', error);
            serverQueue.textChannel.send(`❌ Lỗi phát: \`${song.name}\``).catch(() => {});
            serverQueue.songs.shift();
            playSong(guildId);
        });

    } catch (error) {
        console.error('❌ Lỗi playSong:', error.message);
        serverQueue.textChannel.send(
            `❌ **Bỏ qua:** \`${song.name}\`\n` +
            `> 📝 Lý do: ${error.message}\n` +
            `> 💡 Mẹo: Thử \`!search ${song.name.split(' ').slice(0, 3).join(' ')}\` để tìm bản khác`
        ).catch(() => {});
        
        serverQueue.songs.shift();
        serverQueue.resource = null;
        playSong(guildId);
    }
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    
    return parts.join(' ');
}

const http = require('http');
const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!\n');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${PORT}`);
});

// Đăng nhập
client.login(DISCORD_TOKEN);
