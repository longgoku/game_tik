import { TikTokLiveConnection } from 'tiktok-live-connector';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Đọc từ biến môi trường (Render/Railway sẽ inject), có fallback để chạy local ngay
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'freefirevnofficial';
const TIKTOK_SESSION_ID = process.env.TIKTOK_SESSION_ID || '04270dd289461ef47645b5f7694837df';
const PORT = process.env.PORT || 8080;

// Host free-tier (Render/Railway) chỉ mở đúng 1 cổng public -> dùng chung 1 HTTP server
// vừa serve index.html (giao diện điều khiển + canvas) vừa nâng cấp lên WebSocket.
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
    const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const filePath = path.join(__dirname, urlPath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
        res.end(data);
    });
});

const wss = new WebSocketServer({ server });

const tiktokConnection = new TikTokLiveConnection(TIKTOK_USERNAME, {
    sessionId: TIKTOK_SESSION_ID
});

// ==== CẤU HÌNH ĐIỂM / ĐIỀU KIỆN VÀO SÂN ====
const LIKE_THRESHOLD = 3;        // tim đủ 3 cái là vào sân
const LIKE_START_POINTS = 100;

const LIKE_AURA_THRESHOLD = 10;  // tim liên tục đủ 10 cái -> hào quang xanh lá
const AURA_GREEN_DURATION_MS = 4000;

const COMMENT_JOIN_KEYWORD = '1';  // bình luận đúng số "1" là vào sân ngay
const COMMENT_START_POINTS = 50;

const GIFT_START_POINTS = 200;   // donate (bất kỳ bao nhiêu xu) là vào sân
const AURA_PURPLE_MIN_DIAMONDS = 30; // donate >= 30 xu -> hào quang tím
const AURA_RED_MIN_DIAMONDS = 10;    // donate >= 10 xu -> hào quang đỏ
const AURA_DURATION_MS = 10000;      // hào quang đỏ/tím kéo dài 10s

const KILL_TIER_1_DIAMONDS = 99;   // donate >= 99 xu -> giết ngẫu nhiên 6 người
const KILL_TIER_1_COUNT = 6;
const KILL_TIER_2_DIAMONDS = 199;  // donate >= 199 xu -> giết ngẫu nhiên 10 người + cộng 2000đ
const KILL_TIER_2_COUNT = 10;
const KILL_TIER_2_BONUS = 2000;
const KILL_TIER_3_DIAMONDS = 299;  // donate >= 299 xu -> hào quang RAINBOW 15s + giết 15 người
const KILL_TIER_3_COUNT = 15;
const AURA_RAINBOW_DURATION_MS = 15000;

const userLikesProgress = {};
const userLikeAuraProgress = {};
const userLikedOnce = {};   // để chỉ đọc lời cảm ơn "đã thích phiên live" 1 LẦN duy nhất / user

function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(payload);
    });
}

function connect() {
    tiktokConnection.connect()
        .then(state => console.info(`✅ Đã kết nối TikTok Live: ${TIKTOK_USERNAME} (roomId ${state.roomId})`))
        .catch(err => {
            console.error('❌ Lỗi kết nối, thử lại sau 5s:', err.message);
            setTimeout(connect, 5000);
        });
}
connect();

tiktokConnection.on('disconnected', () => {
    console.warn('⚠️ Mất kết nối TikTok Live, đang thử kết nối lại...');
    setTimeout(connect, 5000);
});

function parseTikTokData(data) {
    const source = data.sender || data.user || data;
    const nickname = data.nickname || source.nickname || data.uniqueId || source.uniqueId || 'Người xem';
    const uniqueId = data.uniqueId || source.uniqueId || data.userId || source.userId || nickname;

    let avatar = 'https://cdn-icons-png.flaticon.com/512/847/847969.png';
    let pfp = data.profilePictureUrl || source.profilePictureUrl || data.avatarThumb || source.avatarThumb;

    if (pfp) {
        if (typeof pfp === 'string') avatar = pfp;
        else if (pfp.urls && pfp.urls.length > 0) avatar = pfp.urls[pfp.urls.length - 1];
        else if (pfp.urlList && pfp.urlList.length > 0) avatar = pfp.urlList[pfp.urlList.length - 1];
    }
    return { uniqueId, nickname, avatar };
}

const DEFAULT_AVATAR = 'https://cdn-icons-png.flaticon.com/512/847/847969.png';

// Lấy nickname + avatar thật của 1 tài khoản TikTok bất kỳ từ @id nhập tay,
// bằng cách tải trang public của họ rồi bóc dữ liệu JSON nhúng trong HTML.
async function fetchTikTokProfile(rawInput) {
    const uniqueId = rawInput.replace(/^@/, '').trim();
    if (!uniqueId) return null;

    try {
        const res = await fetch(`https://www.tiktok.com/@${uniqueId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        if (!res.ok) {
            console.warn(`⚠️ Không tải được trang TikTok của @${uniqueId} (HTTP ${res.status})`);
            return null;
        }

        const html = await res.text();

        // Cách 1: giao diện TikTok mới, dữ liệu nằm trong script __UNIVERSAL_DATA_FOR_REHYDRATION__
        let match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
        if (match) {
            try {
                const json = JSON.parse(match[1]);
                const userInfo = json?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user;
                if (userInfo) {
                    return {
                        uniqueId: userInfo.uniqueId || uniqueId,
                        nickname: userInfo.nickname || uniqueId,
                        avatar: userInfo.avatarLarger || userInfo.avatarMedium || userInfo.avatarThumb || null
                    };
                }
            } catch (e) { /* thử cách 2 bên dưới */ }
        }

        // Cách 2: giao diện TikTok cũ hơn, dữ liệu nằm trong script SIGI_STATE
        match = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
        if (match) {
            try {
                const json = JSON.parse(match[1]);
                const users = json?.UserModule?.users;
                if (users) {
                    const key = Object.keys(users).find(k => k.toLowerCase() === uniqueId.toLowerCase()) || Object.keys(users)[0];
                    const user = users[key];
                    if (user) {
                        return {
                            uniqueId: user.uniqueId || uniqueId,
                            nickname: user.nickname || uniqueId,
                            avatar: user.avatarLarger || user.avatarMedium || user.avatarThumb || null
                        };
                    }
                }
            } catch (e) { /* fallback null bên dưới */ }
        }

        console.warn(`⚠️ Không tìm thấy dữ liệu hồ sơ của @${uniqueId} trong trang (TikTok có thể đã đổi cấu trúc)`);
        return null;
    } catch (err) {
        console.error(`❌ Lỗi khi lấy hồ sơ TikTok của @${uniqueId}:`, err.message);
        return null;
    }
}

// 💬 BÌNH LUẬN: chỉ cần comment đúng số "1" là vào sân ngay
tiktokConnection.on('chat', data => {
    try {
        const parsed = parseTikTokData(data);
        const text = (data.comment || data.text || '').trim();
        if (text === COMMENT_JOIN_KEYWORD) {
            console.log(`💬 Bình luận "1" -> cho vào sân: ${parsed.nickname}`);
            broadcast({
                type: 'join_arena',
                source: 'comment',
                uniqueId: parsed.uniqueId,
                user: parsed.nickname,
                avatar: parsed.avatar,
                startPoints: COMMENT_START_POINTS
            });
        }
    } catch (e) {
        console.error('Lỗi xử lý chat:', e);
    }
});

// ❤️ LIKE: đủ 3 tim thì được vào sân, 100 điểm
tiktokConnection.on('like', data => {
    try {
        const parsed = parseTikTokData(data);
        const uniqueId = parsed.uniqueId;
        const newLikes = data.likeCount || 1;

        console.log(`❤️ [LIKE] ${parsed.nickname} (${uniqueId}) | likeCount=${data.likeCount} totalLikeCount=${data.totalLikeCount}`);

        // 👍 Cảm ơn "đã thích phiên live" - chỉ đọc 1 LẦN DUY NHẤT cho mỗi người xem
        if (!userLikedOnce[uniqueId]) {
            userLikedOnce[uniqueId] = true;
            broadcast({
                type: 'liked_stream',
                uniqueId,
                user: parsed.nickname
            });
        }

        userLikesProgress[uniqueId] = (userLikesProgress[uniqueId] || 0) + newLikes;

        if (userLikesProgress[uniqueId] >= LIKE_THRESHOLD) {
            console.log(`🔥 Đủ ${LIKE_THRESHOLD} tim, cho vào sân: ${parsed.nickname}`);
            broadcast({
                type: 'join_arena',
                source: 'like',
                uniqueId,
                user: parsed.nickname,
                avatar: parsed.avatar,
                startPoints: LIKE_START_POINTS
            });
            userLikesProgress[uniqueId] = 0;
        }

        // Tim liên tục đủ 100 cái -> hào quang xanh lá 4s
        userLikeAuraProgress[uniqueId] = (userLikeAuraProgress[uniqueId] || 0) + newLikes;
        if (userLikeAuraProgress[uniqueId] >= LIKE_AURA_THRESHOLD) {
            console.log(`💚 ${parsed.nickname} tim liên tục đủ ${LIKE_AURA_THRESHOLD} -> hào quang xanh lá`);
            broadcast({
                type: 'apply_aura',
                uniqueId,
                auraTier: 'green',
                auraDurationMs: AURA_GREEN_DURATION_MS
            });
            userLikeAuraProgress[uniqueId] -= LIKE_AURA_THRESHOLD;
        }
    } catch (e) {
        console.error('Lỗi xử lý like:', e);
    }
});

// 🎁 GIFT/DONATE: donate bất kỳ (>=1 xu) là vào sân ngay, 200 điểm
tiktokConnection.on('gift', data => {
    try {
        const isStreakable = data.giftType === 1;
        if (isStreakable && !data.repeatEnd) return;

        const parsed = parseTikTokData(data);
        const diamondsPerGift = data.diamondCount || 1;
        const repeatCount = data.repeatCount || 1;
        const diamonds = diamondsPerGift * repeatCount;
        const giftName = data.giftName || data.gift?.name || 'quà';

        let auraTier = null;
        let auraDurationMs = 0;
        let killCount = 0;
        let bonusPoints = 0;

        if (diamonds >= KILL_TIER_3_DIAMONDS) {
            auraTier = 'rainbow';
            auraDurationMs = AURA_RAINBOW_DURATION_MS;
            killCount = KILL_TIER_3_COUNT;
        } else if (diamonds >= KILL_TIER_2_DIAMONDS) {
            auraTier = 'purple';
            auraDurationMs = AURA_DURATION_MS;
            killCount = KILL_TIER_2_COUNT;
            bonusPoints = KILL_TIER_2_BONUS;
        } else if (diamonds >= KILL_TIER_1_DIAMONDS) {
            auraTier = 'purple';
            auraDurationMs = AURA_DURATION_MS;
            killCount = KILL_TIER_1_COUNT;
        } else if (diamonds >= AURA_PURPLE_MIN_DIAMONDS) {
            auraTier = 'purple';
            auraDurationMs = AURA_DURATION_MS;
        } else if (diamonds >= AURA_RED_MIN_DIAMONDS) {
            auraTier = 'red';
            auraDurationMs = AURA_DURATION_MS;
        }

        console.log(`🎁 ${parsed.nickname} donate ${diamonds} xu (${giftName}) -> vào sân ngay${auraTier ? ' + hào quang ' + auraTier : ''}${killCount ? ' + KILL ' + killCount + ' người' : ''}${bonusPoints ? ' + cộng ' + bonusPoints + 'đ' : ''}`);

        broadcast({
            type: 'join_arena',
            source: 'gift',
            uniqueId: parsed.uniqueId,
            user: parsed.nickname,
            avatar: parsed.avatar,
            giftName,
            startPoints: GIFT_START_POINTS,
            diamonds,
            auraTier,
            auraDurationMs,
            killCount,
            bonusPoints
        });
    } catch (e) {
        console.error('Lỗi xử lý gift:', e);
    }
});

// 👥 FOLLOW: Khi có người bấm theo dõi kênh
tiktokConnection.on('follow', data => {
    try {
        const parsed = parseTikTokData(data);
        console.log(`👥 [FOLLOW] ${parsed.nickname} (@${parsed.uniqueId}) vừa follow kênh!`);
        broadcast({
            type: 'follow',
            uniqueId: parsed.uniqueId,
            user: parsed.nickname,
            avatar: parsed.avatar
        });
    } catch (e) {
        console.error('Lỗi xử lý follow:', e);
    }
});

// 🚪 VIEWER VÀO LIVE: đọc "xin chào _tên_ đã tham gia live"
tiktokConnection.on('member', data => {
    try {
        const parsed = parseTikTokData(data);
        broadcast({
            type: 'member_join',
            uniqueId: parsed.uniqueId,
            user: parsed.nickname
        });
    } catch (e) {
        console.error('Lỗi xử lý member:', e);
    }
});

// ================= WEBSOCKET SERVER =================
wss.on('connection', (client) => {
    console.log('🖥️  Có client mới xem sân đấu');

    client.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'manual_add') {
            const inputId = (msg.username || '').trim();
            if (!inputId) return;

            console.log(`🛠️ Đang tra cứu hồ sơ TikTok cho: ${inputId}...`);
            const profile = await fetchTikTokProfile(inputId);

            const uniqueId = profile?.uniqueId || inputId.replace(/^@/, '');
            const nickname = profile?.nickname || inputId.replace(/^@/, '');
            const avatar = profile?.avatar || DEFAULT_AVATAR;

            console.log(`🛠️ Thêm thủ công: ${inputId} -> uniqueId=${uniqueId}, nickname=${nickname}${profile ? '' : ' (không lấy được hồ sơ thật, dùng tạm)'}`);

            broadcast({
                type: 'join_arena',
                source: 'manual',
                uniqueId,
                user: nickname,
                avatar,
                startPoints: 100
            });
        }
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại port ${PORT}`);
});