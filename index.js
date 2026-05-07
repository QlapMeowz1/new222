require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
const play = require('play-dl');
const fs = require('fs');
const path = require('path');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SOUNDCLOUD_CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;
const PREFIX = '.';
const DJ_ROLE_NAME = 'DJ';
const DATA_PATH = './data';

if (!fs.existsSync(DATA_PATH)) {
    fs.mkdirSync(DATA_PATH);
}

if (SOUNDCLOUD_CLIENT_ID) {
    play.setToken({
        soundcloud: { client_id: SOUNDCLOUD_CLIENT_ID }
    });
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
    ]
});

const queues = new Map();
const history = new Map();
const searchCache = new Map();
const queryCache = new Map(); // Cache query gốc

const filters = {
    'bassboost': 'bass=g=10', 'nightcore': 'atempo=1.3,asetrate=48000*1.25',
    'vaporwave': 'atempo=0.8', '8d': 'apulsator=hz=0.08',
    'echo': 'aecho=0.8:0.9:1000:0.3', 'karaoke': 'stereotools=mlev=0.1',
    'chipmunk': 'atempo=2,asetrate=48000*1.5', 'slow': 'atempo=0.5', 'normal': ''
};

// ============ BOT READY ============
client.once('ready', () => {
    console.log(`✅ Bot đã sẵn sàng! Đã đăng nhập với tên: ${client.user.tag}`);
    console.log(`✅ Bot đang hoạt động trên ${client.guilds.cache.size} server(s)`);
    console.log(`📌 Prefix: ${PREFIX}`);
});

// ============ VOICE STATE ============
client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.member?.id === client.user.id && !newState.channelId) {
        const queue = queues.get(oldState.guild.id);
        if (queue) { queue.songs = []; queue.player?.stop(); queue.connection?.destroy(); queues.delete(oldState.guild.id); }
    }
    if (oldState.channelId && oldState.channel?.members?.size === 1 && oldState.channel.members.first()?.id === client.user.id) {
        const queue = queues.get(oldState.guild.id);
        if (queue) {
            setTimeout(() => {
                const ch = client.channels.cache.get(oldState.channelId);
                if (ch && ch.members.size === 1 && ch.members.first()?.id === client.user.id) {
                    queue.songs = []; queue.player?.stop(); queue.connection?.destroy(); queues.delete(oldState.guild.id);
                }
            }, 60000);
        }
    }
});

// ============ INTERACTION ============
client.on('interactionCreate', async (interaction) => {
    if (interaction.isStringSelectMenu()) {
        const { customId, guildId, user, values } = interaction;
        const cachedResults = searchCache.get(`results_${user.id}`);
        
        if (customId.startsWith('select_song_') || customId.startsWith('search_select_')) {
            if (!cachedResults) {
                return interaction.reply({ content: '❌ Phiên tìm kiếm đã hết hạn!', ephemeral: true });
            }
            
            await interaction.deferUpdate();
            
            const selectedIndex = parseInt(values[0].replace('track_', '').replace('search_track_', ''));
            const songInfo = cachedResults[selectedIndex];
            
            const vc = interaction.member?.voice?.channel;
            if (!vc) return interaction.editReply({ content: '❌ Bạn phải vào kênh thoại!', embeds: [], components: [] });
            
            const serverQueue = getOrCreateQueueFromInteraction(interaction);
            serverQueue.songs.push(songInfo);
            addToHistory(guildId, songInfo);
            
            const source = songInfo.url?.includes('soundcloud') ? '☁️ SoundCloud' : '📺 YouTube';
            const embed = new EmbedBuilder().setColor('#00FF00').setTitle('✅ Đã thêm vào hàng đợi')
                .setDescription(`[${songInfo.name || songInfo.title}](${songInfo.url})`)
                .addFields(
                    { name: '👤 Nghệ sĩ', value: songInfo.user?.name || songInfo.channel?.name || 'Unknown', inline: true },
                    { name: '⏱️', value: songInfo.durationRaw || 'N/A', inline: true },
                    { name: '📊 Vị trí', value: `#${serverQueue.songs.length}`, inline: true },
                    { name: '🔗 Nguồn', value: source, inline: true }
                );
            
            await interaction.editReply({ embeds: [embed], components: [] });
            if (!serverQueue.playing) await joinAndPlayFromInteraction(interaction, vc);
            searchCache.delete(`results_${user.id}`);
        }
        return;
    }
    
    if (!interaction.isButton()) return;
    
    const { customId, guildId, member, user } = interaction;
    
    // Xử lý nút chọn nguồn
    if (customId.startsWith('src_yt_') || customId.startsWith('src_sc_') || customId.startsWith('src_both_') ||
        customId.startsWith('search_yt_') || customId.startsWith('search_sc_') || customId.startsWith('search_both_')) {
        
        await interaction.deferUpdate();
        
        // Parse: src_yt_USERID hoặc search_sc_USERID
        const parts = customId.split('_');
        const actionType = parts[0]; // src hoặc search
        const sourceType = parts[1]; // yt, sc, both
        const userId = parts[2];
        
        // Lấy query từ cache
        const originalQuery = queryCache.get(`query_${userId}`);
        
        console.log(`🔍 Nút nhấn: action=${actionType}, source=${sourceType}, user=${userId}, query="${originalQuery}"`);
        
        if (!originalQuery) {
            return interaction.editReply({ content: '❌ Phiên tìm kiếm đã hết hạn!', embeds: [], components: [] });
        }
        
        // Tự xóa query cache sau 30 giây
        setTimeout(() => { queryCache.delete(`query_${userId}`); }, 30000);
        
        if (user.id !== userId) {
            return interaction.followUp({ content: '❌ Bạn không phải người dùng lệnh này!', ephemeral: true });
        }
        
        try {
            let searchResults = [];
            let sourceName = '';
            
            if (sourceType === 'yt') {
                searchResults = await play.search(originalQuery, { source: { youtube: "video" }, limit: 10 });
                sourceName = '📺 YouTube';
            } else if (sourceType === 'sc') {
                searchResults = await play.search(originalQuery, { source: { soundcloud: "tracks" }, limit: 10 });
                sourceName = '☁️ SoundCloud';
            } else {
                const [yt, sc] = await Promise.all([
                    play.search(originalQuery, { source: { youtube: "video" }, limit: 5 }),
                    play.search(originalQuery, { source: { soundcloud: "tracks" }, limit: 5 })
                ]);
                searchResults = [...(yt || []), ...(sc || [])];
                sourceName = '🎶 YouTube + SoundCloud';
            }
            
            console.log(`✅ Tìm thấy ${searchResults.length} kết quả cho "${originalQuery}"`);
            
            if (!searchResults || searchResults.length === 0) {
                return interaction.editReply({ content: `❌ Không tìm thấy "${originalQuery}" trên ${sourceName}!`, embeds: [], components: [] });
            }
            
            searchCache.set(`results_${user.id}`, searchResults);
            
            const selectId = actionType === 'search' ? `select_song_${user.id}` : `search_select_${user.id}`;
            
            const menu = new StringSelectMenuBuilder()
                .setCustomId(selectId)
                .setPlaceholder(`🎵 Chọn bài (${sourceName})...`)
                .addOptions(searchResults.slice(0, 10).map((t, i) => ({
                    label: (t.name || t.title || 'Unknown').substring(0, 100),
                    description: `👤 ${t.user?.name || t.channel?.name || '?'} | ⏱️ ${t.durationRaw || 'N/A'}`.substring(0, 100),
                    value: `track_${i}`, emoji: i === 0 ? '🎵' : '🎶'
                })));
            
            const row = new ActionRowBuilder().addComponents(menu);
            
            const embed = new EmbedBuilder().setColor('#FF7700')
                .setTitle(`🔍 Kết quả: "${originalQuery}" (${sourceName})`)
                .setDescription('👇 Chọn bài bên dưới (60 giây)')
                .setFooter({ text: `${searchResults.length} kết quả` });
            
            searchResults.slice(0, 10).forEach((t, i) => {
                const src = t.url?.includes('soundcloud') ? '☁️' : '📺';
                embed.addFields({ name: `${i+1}. ${t.name || t.title || '?'}`, value: `${src} | 👤 ${t.user?.name || t.channel?.name || '?'} | ⏱️ ${t.durationRaw || 'N/A'}`, inline: false });
            });
            
            await interaction.editReply({ embeds: [embed], components: [row] });
            
            setTimeout(() => { searchCache.delete(`results_${user.id}`); }, 60000);
            
        } catch (error) {
            console.error('❌ Lỗi tìm kiếm:', error);
            await interaction.editReply({ content: '❌ Lỗi: ' + error.message, embeds: [], components: [] }).catch(() => {});
        }
        return;
    }
    
    // Nút điều khiển nhạc
    const serverQueue = queues.get(guildId);
    if (!serverQueue) return interaction.reply({ content: '❌ Không có nhạc!', ephemeral: true });
    if (!member.roles.cache.some(r => r.name === DJ_ROLE_NAME) && !member.permissions.has('ManageChannels')) {
        return interaction.reply({ content: '❌ Cần role DJ!', ephemeral: true });
    }
    
    try {
        switch(customId) {
            case 'pause_btn': serverQueue.player?.pause(); await interaction.reply({ content: '⏸️ Tạm dừng!', ephemeral: true }); break;
            case 'resume_btn': serverQueue.player?.unpause(); await interaction.reply({ content: '▶️ Tiếp tục!', ephemeral: true }); break;
            case 'skip_btn': serverQueue.player?.stop(); await interaction.reply({ content: '⏭️ Skip!', ephemeral: true }); break;
            case 'stop_btn': serverQueue.songs = []; serverQueue.player?.stop(); serverQueue.connection?.destroy(); queues.delete(guildId); await interaction.reply({ content: '⏹️ Dừng!', ephemeral: true }); break;
            case 'loop_btn': serverQueue.loop = !serverQueue.loop; await interaction.reply({ content: `🔁 Loop: ${serverQueue.loop?'BẬT':'TẮT'}`, ephemeral: true }); break;
            case 'shuffle_btn':
                if (serverQueue.songs.length > 1) {
                    const c = serverQueue.songs.shift();
                    for (let i = serverQueue.songs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i+1)); [serverQueue.songs[i], serverQueue.songs[j]] = [serverQueue.songs[j], serverQueue.songs[i]]; }
                    serverQueue.songs.unshift(c);
                }
                await interaction.reply({ content: '🔀 Trộn!', ephemeral: true }); break;
            case 'queue_btn': await interaction.reply({ embeds: [createQueueEmbed(serverQueue)], ephemeral: true }); break;
            case 'np_btn': await interaction.reply({ embeds: [createNPEmbed(serverQueue)], ephemeral: true }); break;
        }
    } catch (e) { console.error(e); if (!interaction.replied) await interaction.reply({ content: '❌ Lỗi!', ephemeral: true }).catch(()=>{}); }
});

// ============ MESSAGE HANDLER ============
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    const djCmds = ['play','p','search','skip','s','stop','pause','resume','volume','vol','shuffle','remove','loop','filter'];
    if (djCmds.includes(command) && !hasDJPermission(message)) return message.reply('❌ Cần role DJ!');
    
    try {
        switch(command) {
            case 'play': case 'p': 
                const q = args.join(' '); if (!q) return message.reply('❌ Nhập tên/link!'); 
                await playHandler(message, q); break;
            case 'search': 
                const sq = args.join(' '); if (!sq) return message.reply('❌ Nhập từ khóa!'); 
                await searchHandler(message, sq); break;
            case 'queue': case 'q': await queueHandler(message); break;
            case 'np': case 'nowplaying': await npHandler(message); break;
            case 'pause': await pauseHandler(message); break;
            case 'resume': await resumeHandler(message); break;
            case 'skip': case 's': await skipHandler(message); break;
            case 'remove': await removeHandler(message, args[0]); break;
            case 'shuffle': await shuffleHandler(message); break;
            case 'loop': await loopHandler(message); break;
            case 'volume': case 'vol': await volumeHandler(message, args[0]); break;
            case 'stop': await stopHandler(message); break;
            case 'filter': await filterHandler(message, args); break;
            case 'save': await saveQueueHandler(message, args[0]); break;
            case 'load': await loadQueueHandler(message, args[0]); break;
            case 'saved': await listSavedHandler(message); break;
            case 'history': await historyHandler(message); break;
            case 'autoplay': await autoplayHandler(message); break;
            case 'panel': await panelHandler(message); break;
            case 'stats': await statsHandler(message); break;
            case 'help': await helpHandler(message); break;
        }
    } catch (e) { console.error(e); message.reply('❌ Lỗi!').catch(()=>{}); }
});

// ============ PLAY HANDLER (ĐÃ SỬA - KHÔNG awaitMessageComponent) ============
async function playHandler(message, query) {
    const vc = message.member?.voice?.channel;
    if (!vc) return message.reply('❌ Vào kênh thoại!');
    
    try {
        const isSC = query.includes('soundcloud.com');
        const isYT = query.includes('youtube.com') || query.includes('youtu.be');
        
        // Playlist
        if (query.includes('/sets/') || query.includes('playlist?list=')) {
            const msg = await message.reply('🔄 Tải playlist...');
            try {
                let tracks = [], name = '', src = '';
                if (isSC) { const pl = await play.soundcloud(query); tracks = await pl.all_tracks(); name = pl.name; src = '☁️ SC'; }
                else { const pl = await play.playlist_info(query); tracks = await pl.all_tracks(); name = pl.title; src = '📺 YT'; }
                const sq = getOrCreateQueue(message);
                tracks.forEach(t => sq.songs.push(t));
                await msg.edit({ content: null, embeds: [new EmbedBuilder().setColor('#00FF00').setTitle(`📋 ${name}`).addFields({name:'📊',value:`${tracks.length} bài`,inline:true},{name:'🔗',value:src,inline:true})] });
                if (!sq.playing) await joinAndPlay(message, vc);
            } catch (e) { await msg.edit('❌ Lỗi tải playlist!'); }
            return;
        }
        
        // Link trực tiếp
        if (isSC || isYT) {
            const msg = await message.reply('🔄 Tải...');
            try {
                const info = isSC ? await play.soundcloud(query) : await play.video_info(query);
                const sq = getOrCreateQueue(message);
                sq.songs.push(info);
                addToHistory(message.guild.id, info);
                await msg.edit({ content: null, embeds: [new EmbedBuilder().setColor('#00FF00').setTitle('✅ Đã thêm').setDescription(`[${info.name||info.title}](${info.url})`).addFields({name:'👤',value:info.user?.name||info.channel?.name||'?',inline:true},{name:'⏱️',value:info.durationRaw||'N/A',inline:true})] });
                if (!sq.playing) await joinAndPlay(message, vc);
            } catch (e) { await msg.edit('❌ Lỗi!'); }
            return;
        }
        
        // Tìm kiếm - KHÔNG awaitMessageComponent
        queryCache.set(`query_${message.author.id}`, query);
        
        const embed = new EmbedBuilder().setColor('#0099FF').setTitle(`🔍 Chọn nguồn: "${query}"`).setDescription('Chọn nền tảng:').setFooter({text:'30 giây'});
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`search_yt_${message.author.id}`).setLabel('YouTube').setStyle(ButtonStyle.Danger).setEmoji('📺'),
            new ButtonBuilder().setCustomId(`search_sc_${message.author.id}`).setLabel('SoundCloud').setStyle(ButtonStyle.Primary).setEmoji('☁️'),
            new ButtonBuilder().setCustomId(`search_both_${message.author.id}`).setLabel('Cả hai').setStyle(ButtonStyle.Success).setEmoji('🎶')
        );
        
        await message.reply({ embeds: [embed], components: [row] });
        // Nút được xử lý bởi interactionCreate
        
    } catch (e) { console.error(e); message.reply('❌ Lỗi!').catch(()=>{}); }
}

// ============ SEARCH HANDLER (ĐÃ SỬA - KHÔNG awaitMessageComponent) ============
async function searchHandler(message, query) {
    queryCache.set(`query_${message.author.id}`, query);
    
    const embed = new EmbedBuilder().setColor('#0099FF').setTitle(`🔍 Chọn nguồn: "${query}"`).setFooter({text:'30 giây'});
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`src_yt_${message.author.id}`).setLabel('YouTube').setStyle(ButtonStyle.Danger).setEmoji('📺'),
        new ButtonBuilder().setCustomId(`src_sc_${message.author.id}`).setLabel('SoundCloud').setStyle(ButtonStyle.Primary).setEmoji('☁️'),
        new ButtonBuilder().setCustomId(`src_both_${message.author.id}`).setLabel('Cả hai').setStyle(ButtonStyle.Success).setEmoji('🎶')
    );
    
    await message.reply({ embeds: [embed], components: [row] });
    // Nút được xử lý bởi interactionCreate
}

// ============ CÁC HANDLER CÒN LẠI (GIỮ NGUYÊN) ============
async function queueHandler(msg) { const q = queues.get(msg.guild.id); if (!q||!q.songs.length) return msg.reply('📭 Trống!'); msg.reply({embeds:[createQueueEmbed(q)]}); }
async function npHandler(msg) { const q = queues.get(msg.guild.id); if (!q||!q.songs.length) return msg.reply('❌ Không có!'); msg.reply({embeds:[createNPEmbed(q)]}); }
async function pauseHandler(msg) { const q = queues.get(msg.guild.id); if (!q?.player) return msg.reply('❌'); if (q.player.state.status==='paused') return msg.reply('⏸️ Rồi!'); q.player.pause(); msg.reply('⏸️ Tạm dừng!'); }
async function resumeHandler(msg) { const q = queues.get(msg.guild.id); if (!q?.player) return msg.reply('❌'); if (q.player.state.status!=='paused') return msg.reply('▶️ Rồi!'); q.player.unpause(); msg.reply('▶️ Tiếp tục!'); }
async function skipHandler(msg) { const q = queues.get(msg.guild.id); if (!q?.player) return msg.reply('❌'); const s = q.songs[0]; q.player.stop(); msg.reply({embeds:[new EmbedBuilder().setColor('#FFA500').setTitle('⏭️ Skip').setDescription(`[${s.name||s.title}](${s.url})`)]}); }
async function removeHandler(msg, idx) { const q = queues.get(msg.guild.id); if (!q||!q.songs.length) return msg.reply('❌'); const i = parseInt(idx); if (isNaN(i)||i<1||i>=q.songs.length) return msg.reply(`❌ 1-${q.songs.length-1}!`); const r = q.songs.splice(i,1)[0]; msg.reply(`🗑️ ${r.name||r.title}`); }
async function shuffleHandler(msg) { const q = queues.get(msg.guild.id); if (!q||q.songs.length<2) return msg.reply('❌'); const c = q.songs.shift(); for (let i=q.songs.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[q.songs[i],q.songs[j]]=[q.songs[j],q.songs[i]];} q.songs.unshift(c); msg.reply('🔀 Trộn!'); }
async function loopHandler(msg) { const q = queues.get(msg.guild.id); if (!q) return msg.reply('❌'); q.loop=!q.loop; msg.reply({embeds:[new EmbedBuilder().setColor(q.loop?'#00FF00':'#FF0000').setTitle(`🔁 Loop: ${q.loop?'BẬT':'TẮT'}`)]}); }
async function volumeHandler(msg, v) { const q = queues.get(msg.guild.id); if (!q?.player) return msg.reply('❌'); const vol=parseInt(v); if(isNaN(vol)||vol<0||vol>200) return msg.reply('❌ 0-200!'); q.volume=vol/100; try{if(q.resource?.volume)q.resource.volume.setVolume(q.volume);}catch(e){} const fb=Math.max(0,Math.floor(vol/10)), eb=Math.max(0,20-fb); msg.reply({embeds:[new EmbedBuilder().setColor('#0099FF').setTitle('🔊 Âm lượng').setDescription(`${'█'.repeat(fb)}${'░'.repeat(eb)}`).addFields({name:'Giá trị',value:`${vol}%`,inline:true})]}); }
async function stopHandler(msg) { const q = queues.get(msg.guild.id); if (!q?.connection) return msg.reply('❌'); q.songs=[]; q.player?.stop(); q.connection.destroy(); queues.delete(msg.guild.id); msg.reply('⏹️ Dừng!'); }
async function filterHandler(msg, args) { const q = queues.get(msg.guild.id); if (!q?.player) return msg.reply('❌'); if(!args.length) return msg.reply(`🎛️ Filters: ${Object.keys(filters).join(', ')}`); const fn=args[0].toLowerCase(); if(!filters[fn]&&fn!=='normal') return msg.reply('❌ Không tồn tại!'); q.filter=fn; msg.reply({embeds:[new EmbedBuilder().setColor('#FF00FF').setTitle('🎨 Filter').setDescription(`**${fn}**`)]}); }
async function saveQueueHandler(msg, name) { if(!name) return msg.reply('❌ Tên?'); const q=queues.get(msg.guild.id); if(!q||!q.songs.length) return msg.reply('❌'); const data={name,songs:q.songs.map(s=>({name:s.name||s.title,url:s.url,user:s.user?.name||s.channel?.name,duration:s.durationRaw})),filter:q.filter,volume:q.volume,loop:q.loop,savedBy:msg.author.tag,savedAt:new Date().toISOString()}; const fp=path.join(DATA_PATH,`queue_${msg.guild.id}_${name.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`); fs.writeFileSync(fp,JSON.stringify(data,null,2)); msg.reply({embeds:[new EmbedBuilder().setColor('#00FF00').setTitle('💾 Đã lưu!').addFields({name:'📝',value:name,inline:true},{name:'📊',value:`${q.songs.length} bài`,inline:true})]}); }
async function loadQueueHandler(msg, name) { if(!name) return msg.reply('❌ Tên?'); const fp=path.join(DATA_PATH,`queue_${msg.guild.id}_${name.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`); if(!fs.existsSync(fp)) return msg.reply('❌ Không tìm thấy!'); const data=JSON.parse(fs.readFileSync(fp,'utf8')); const q=getOrCreateQueue(msg); for(const s of data.songs){try{const i=s.url?.includes('soundcloud')?await play.soundcloud(s.url):await play.video_info(s.url);q.songs.push(i);}catch(e){}} q.filter=data.filter||'normal'; q.volume=data.volume||0.3; q.loop=data.loop||false; msg.reply({embeds:[new EmbedBuilder().setColor('#00FF00').setTitle('📂 Đã tải!').addFields({name:'📝',value:name,inline:true},{name:'📊',value:`${q.songs.length} bài`,inline:true})]}); if(!q.playing){const vc=msg.member?.voice?.channel; if(vc) await joinAndPlay(msg,vc);} }
async function listSavedHandler(msg) { const files=fs.readdirSync(DATA_PATH).filter(f=>f.startsWith(`queue_${msg.guild.id}_`)).map(f=>f.replace(`queue_${msg.guild.id}_`,'').replace('.json','')); if(!files.length) return msg.reply('📭'); msg.reply({embeds:[new EmbedBuilder().setColor('#0099FF').setTitle('💾 Đã lưu').setDescription(files.map((f,i)=>`**${i+1}.** ${f}`).join('\n'))]}); }
async function historyHandler(msg) { const h=history.get(msg.guild.id)||[]; if(!h.length) return msg.reply('📜 Trống!'); msg.reply({embeds:[new EmbedBuilder().setColor('#FFA500').setTitle('📜 Lịch sử').setDescription(h.slice(-20).reverse().map((s,i)=>`**${i+1}.** [${s.name}](${s.url})`).join('\n'))]}); }
async function autoplayHandler(msg) { const q=queues.get(msg.guild.id); if(!q) return msg.reply('❌'); q.autoplay=!q.autoplay; msg.reply({embeds:[new EmbedBuilder().setColor(q.autoplay?'#00FF00':'#FF0000').setTitle(`🔄 Autoplay: ${q.autoplay?'BẬT':'TẮT'}`)]}); }
async function panelHandler(msg) { const q=queues.get(msg.guild.id); const r1=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('pause_btn').setLabel('⏸️').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('resume_btn').setLabel('▶️').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('skip_btn').setLabel('⏭️').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('stop_btn').setLabel('⏹️').setStyle(ButtonStyle.Danger)); const r2=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('loop_btn').setLabel('🔁').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('shuffle_btn').setLabel('🔀').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('queue_btn').setLabel('📋').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('np_btn').setLabel('🎵').setStyle(ButtonStyle.Secondary)); const e=new EmbedBuilder().setColor('#FF0000').setTitle('🎛️ Panel'); if(q&&q.songs.length) e.addFields({name:'🎵',value:q.songs[0].name||q.songs[0].title||'?'}); msg.channel.send({embeds:[e],components:[r1,r2]}); }
async function statsHandler(msg) { const q=queues.get(msg.guild.id); const h=history.get(msg.guild.id)||[]; msg.reply({embeds:[new EmbedBuilder().setColor('#FF0000').setTitle('📊 Stats').addFields({name:'🎵',value:q?.songs[0]?.name||q?.songs[0]?.title||'Không có',inline:false},{name:'📋',value:`${q?.songs.length||0} bài`,inline:true},{name:'🔁',value:q?.loop?'Bật':'Tắt',inline:true},{name:'🔄',value:q?.autoplay?'Bật':'Tắt',inline:true},{name:'🔊',value:`${(q?.volume||0.3)*100}%`,inline:true},{name:'📜',value:`${h.length} bài`,inline:true},{name:'⏱️',value:formatUptime(process.uptime()),inline:true})]}); }
async function helpHandler(msg) { msg.reply({embeds:[new EmbedBuilder().setColor('#FF0000').setTitle('🎵 MUSIC BOT - HƯỚNG DẪN').setDescription(`Prefix: \`${PREFIX}\` | YT + SC`).addFields({name:'📌 Phát nhạc',value:`\`${PREFIX}play <tên/link>\` - Phát\n\`${PREFIX}search <từ khóa>\` - Tìm`},{name:'🎛️ Điều khiển',value:`\`${PREFIX}pause/resume/skip/stop\`\n\`${PREFIX}loop/shuffle/volume\``},{name:'💾 Lưu trữ',value:`\`${PREFIX}save/load/saved\``}).setFooter({text:'YT + SoundCloud'})]}); }

// ============ HELPER FUNCTIONS ============
function hasDJPermission(msg) { return msg.member.permissions.has('ManageChannels') || msg.member.roles.cache.some(r=>r.name===DJ_ROLE_NAME); }
function getOrCreateQueue(msg) { if(!queues.has(msg.guild.id)) queues.set(msg.guild.id,{textChannel:msg.channel,voiceChannel:msg.member.voice.channel,connection:null,player:null,resource:null,songs:[],volume:0.3,loop:false,autoplay:false,filter:'normal',playing:false}); return queues.get(msg.guild.id); }
function getOrCreateQueueFromInteraction(i) { if(!queues.has(i.guildId)) queues.set(i.guildId,{textChannel:i.channel,voiceChannel:i.member.voice.channel,connection:null,player:null,resource:null,songs:[],volume:0.3,loop:false,autoplay:false,filter:'normal',playing:false}); return queues.get(i.guildId); }
function addToHistory(gid,song) { if(!history.has(gid)) history.set(gid,[]); const h=history.get(gid); h.push({name:song.name||song.title,url:song.url,user:song.user?.name||song.channel?.name,duration:song.durationRaw,playedAt:new Date().toISOString()}); if(h.length>100) h.shift(); }
function createQueueEmbed(q) { const list=q.songs.map((s,i)=>{const p=i===0?'▶️ ':`${i}. `;const src=s.url?.includes('soundcloud')?'☁️':'📺';return `${p}${src} [${s.name||s.title||'?'}](${s.url}) | \`${s.durationRaw||'N/A'}\``;}).join('\n').substring(0,4000)||'Trống'; return new EmbedBuilder().setColor('#0099FF').setTitle('📋 Queue').setDescription(list).addFields({name:'📊',value:`${q.songs.length}`,inline:true},{name:'🔁',value:q.loop?'Bật':'Tắt',inline:true}); }
function createNPEmbed(q) { const s=q.songs[0]; if(!s) return new EmbedBuilder().setColor('#FF0000').setTitle('❌ Không có'); const src=s.url?.includes('soundcloud')?'☁️ SC':'📺 YT'; return new EmbedBuilder().setColor('#FF0000').setTitle('🎵 Đang phát').setDescription(`[${s.name||s.title||'?'}](${s.url})`).addFields({name:'👤',value:s.user?.name||s.channel?.name||'?',inline:true},{name:'⏱️',value:s.durationRaw||'N/A',inline:true},{name:'🔗',value:src,inline:true},{name:'🔊',value:`${(q.volume||0.3)*100}%`,inline:true}).setThumbnail(s.thumbnail?.url||null); }

async function joinAndPlay(src, vc) { const q=queues.get(src.guild?.id||src.guildId); if(!q) return; try{q.connection=joinVoiceChannel({channelId:vc.id,guildId:vc.guild.id,adapterCreator:vc.guild.voiceAdapterCreator,selfDeaf:true}); q.playing=true; q.connection.on(VoiceConnectionStatus.Ready,()=>playSong(q.connection.joinConfig.guildId)); q.connection.on(VoiceConnectionStatus.Disconnected,async()=>{try{await Promise.race([new Promise(r=>q.connection.on(VoiceConnectionStatus.Connecting,()=>r())),new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),5000))]);}catch(e){q.playing=false;q.connection?.destroy();queues.delete(q.connection.joinConfig.guildId);}}); if(q.connection.state.status===VoiceConnectionStatus.Ready) playSong(q.connection.joinConfig.guildId); }catch(e){console.error(e);q.playing=false;queues.delete(src.guild?.id||src.guildId);} }
async function joinAndPlayFromInteraction(i, vc) { const q=queues.get(i.guildId); if(!q) return; try{q.connection=joinVoiceChannel({channelId:vc.id,guildId:vc.guild.id,adapterCreator:vc.guild.voiceAdapterCreator,selfDeaf:true}); q.playing=true; q.connection.on(VoiceConnectionStatus.Ready,()=>playSong(q.connection.joinConfig.guildId)); q.connection.on(VoiceConnectionStatus.Disconnected,async()=>{try{await Promise.race([new Promise(r=>q.connection.on(VoiceConnectionStatus.Connecting,()=>r())),new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),5000))]);}catch(e){q.playing=false;q.connection?.destroy();queues.delete(q.connection.joinConfig.guildId);}}); if(q.connection.state.status===VoiceConnectionStatus.Ready) playSong(q.connection.joinConfig.guildId); }catch(e){console.error(e);q.playing=false;queues.delete(i.guildId);} }

async function playSong(guildId) {
    const q = queues.get(guildId);
    if (!q?.connection || q.connection.state.status === VoiceConnectionStatus.Destroyed || q.connection.state.status === VoiceConnectionStatus.Disconnected) {
        if (q) { q.playing = false; queues.delete(guildId); }
        return;
    }
    if (!q.songs.length) {
        if (q.autoplay) { /* giữ nguyên autoplay */ }
        if (!q.songs.length) {
            setTimeout(() => { if (q.connection && q.connection.state.status !== VoiceConnectionStatus.Destroyed && !q.songs.length) { q.playing = false; q.connection.destroy(); queues.delete(guildId); } }, 60000);
            return;
        }
    }
    const song = q.songs[0];
    try {
        let stream = null;
        let streamType = null;

        console.log(`🎵 Đang thử stream: ${song.name || song.title} - ${song.url}`);

        try {
            console.log('🎵 Cách 1: Stream trực tiếp');
            const result = await play.stream(song.url);
            if (result?.stream) {
                stream = result.stream;
                streamType = result.type;
                console.log(`✅ Cách 1 thành công! Type: ${streamType}`);
            }
        } catch (e1) {
            console.log(`❌ Cách 1 thất bại: ${e1.message}`);
        }

        if (!stream) {
            try {
                console.log(`🔍 Cách 2: Tìm kiếm "${song.name || song.title}"`);
                const searchSource = song.url?.includes('soundcloud') 
                    ? { soundcloud: "tracks" } 
                    : { youtube: "video" };
                
                const searchResults = await play.search(song.name || song.title, { 
                    source: searchSource, 
                    limit: 5 
                });
                
                if (searchResults && searchResults.length > 0) {
                    for (const result of searchResults) {
                        try {
                            console.log(`🎵 Thử stream kết quả: ${result.name || result.title} - ${result.url}`);
                            const streamResult = await play.stream(result.url);
                            if (streamResult?.stream) {
                                stream = streamResult.stream;
                                streamType = streamResult.type;
                                // Cập nhật song nếu dùng kết quả khác
                                if (result.url !== song.url) {
                                    q.songs[0] = result;
                                    console.log(`✅ Đã thay thế bằng: ${result.name || result.title}`);
                                }
                                console.log(`✅ Cách 2 thành công! Type: ${streamType}`);
                                break;
                            }
                        } catch (e) {
                            console.log(`❌ Thất bại với: ${result.name || result.title} - ${e.message}`);
                            continue;
                        }
                    }
                }
            } catch (e2) {
                console.log(`❌ Cách 2 thất bại: ${e2.message}`);
            }
        }

        if (!stream && !song.url?.includes('soundcloud')) {
            try {
                console.log('🔍 Cách 3: Thử với video_info trước');
                const videoInfo = await play.video_info(song.url).catch(() => null);
                if (videoInfo?.url) {
                    const result = await play.stream(videoInfo.url);
                    if (result?.stream) {
                        stream = result.stream;
                        streamType = result.type;
                        console.log(`✅ Cách 3 thành công! Type: ${streamType}`);
                    }
                }
            } catch (e3) {
                console.log(`❌ Cách 3 thất bại: ${e3.message}`);
            }
        }

        if (!stream && song.url?.includes('soundcloud')) {
            try {
                console.log('🔍 Cách 4: Thử với soundcloud info');
                const scInfo = await play.soundcloud(song.url).catch(() => null);
                if (scInfo?.url) {
                    const result = await play.stream(scInfo.url);
                    if (result?.stream) {
                        stream = result.stream;
                        streamType = result.type;
                        console.log(`✅ Cách 4 thành công! Type: ${streamType}`);
                    }
                }
            } catch (e4) {
                console.log(`❌ Cách 4 thất bại: ${e4.message}`);
            }
        }

        if (!stream) {
            throw new Error('Không thể stream - thử !search để tìm bản khác');
        }

        let it;
        switch(streamType) {
            case 'opus': it = StreamType.Opus; break;
            case 'ogg': case 'ogg/opus': it = StreamType.OggOpus; break;
            case 'webm': case 'webm/opus': it = StreamType.WebmOpus; break;
            case 'raw': it = StreamType.Raw; break;
            default: 
                it = StreamType.OggOpus;
                console.log(`⚠️ Stream type lạ (${streamType}), dùng OggOpus`);
        }

        console.log(`🎵 Input type: ${it}`);

        q.resource = createAudioResource(stream, { inputType: it, inlineVolume: true });
        try { if (q.resource?.volume) q.resource.volume.setVolume(q.volume || 0.3); } catch {}
        
        if (!q.player) {
            q.player = createAudioPlayer();
            q.player.on('error', (e) => { 
                console.error('❌ Player error:', e); 
                q.songs.shift(); 
                setTimeout(() => playSong(guildId), 1000); 
            });
            q.player.on('stateChange', (o, n) => { 
                if (n.status === AudioPlayerStatus.Idle && o.status !== AudioPlayerStatus.Idle) { 
                    q.loop ? q.songs.push(q.songs.shift()) : q.songs.shift(); 
                    setTimeout(() => playSong(guildId), 500); 
                } 
            });
            q.connection.subscribe(q.player);
        }
        
        q.player.play(q.resource);
        console.log('▶️ Đang phát:', song.name || song.title);
        
        const src = song.url?.includes('soundcloud') ? '☁️ SC' : '📺 YT';
        q.textChannel?.send({ 
            embeds: [new EmbedBuilder().setColor('#FF0000').setTitle('▶️ Đang phát')
                .setDescription(`[${song.name||song.title}](${song.url})`)
                .addFields(
                    {name:'👤',value:song.user?.name||song.channel?.name||'?',inline:true},
                    {name:'🔗',value:src,inline:true}
                )] 
        }).catch(()=>{});
        
        addToHistory(guildId, song);
        
    } catch (e) {
        console.error('❌ Lỗi playSong:', e.message);
        q.textChannel?.send({ 
            embeds: [new EmbedBuilder().setColor('#FF0000').setTitle('❌ Lỗi phát nhạc')
                .setDescription(`**${song.name||song.title}**`)
                .addFields(
                    {name:'📝 Lỗi',value:e.message},
                    {name:'💡 Gợi ý',value:`Dùng \`.search ${(song.name||song.title||'').split(' ').slice(0,3).join(' ')}\` để tìm bản khác`}
                )] 
        }).catch(()=>{});
        
        q.songs.shift(); 
        q.resource = null;
        setTimeout(() => { if (q.songs.length) playSong(guildId); }, 2000);
    }
}

function formatUptime(s) { const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60); return [`${d}d`,`${h}h`,`${m}m`,`${sec}s`].filter(p=>!p.startsWith('0')).join(' ')||'0s'; }

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

require('http').createServer((req,res)=>{res.writeHead(200);res.end('OK');}).listen(process.env.PORT||10000,'0.0.0.0',()=>console.log('🌐 HTTP'));

client.login(DISCORD_TOKEN).then(()=>console.log('🚀 Ready')).catch(console.error);
