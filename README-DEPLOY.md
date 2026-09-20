# Deploy game TikTok live

## 1. Push lên GitHub
```bash
cd proj
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<username>/<repo>.git
git push -u origin main
```

## 2. Deploy lên Render (free, chạy được Node.js + WebSocket)
1. render.com → New → Web Service → connect repo vừa push
2. Build command: `npm install`
3. Start command: `npm start`
4. Vào tab **Environment** → thêm 2 biến (lấy từ `.env.example`):
   - `TIKTOK_USERNAME`
   - `TIKTOK_SESSION_ID`
5. Deploy → Render cấp domain dạng `https://<app>.onrender.com`, mở link đó là chạy game (index.html) luôn, không cần host tách riêng.

## Đã sửa để deploy được
- `server.js`: trước đây mở WebSocket ở port cứng 8080 và không serve HTML → giờ dùng chung 1 HTTP server, port lấy từ `process.env.PORT` (bắt buộc, vì Render tự cấp port). Server serve mọi file `.html` trong thư mục, nên `index.html` và `game.html` đều mở được qua domain Render (`/index.html`, `/game.html`).
- `server.js`: `TIKTOK_SESSION_ID` trước hardcode thẳng trong code (session TikTok của bạn, không nên public trên GitHub) → chuyển sang biến môi trường.
- `index.html`: WebSocket trước nối cứng `ws://localhost:8080` → giờ tự nối theo domain thật + tự chuyển `wss://` khi chạy HTTPS.
- `game.html`: trước nghe event `join`/`buff` (server không gửi loại này → không hoạt động) → đã sửa lại nghe đúng `join_arena`/`apply_aura` như server thật gửi, thêm hào quang theo tier màu (xanh lá/đỏ/tím/cầu vồng) và cơ chế kill khi donate lớn. WebSocket cũng đổi sang tự nối theo domain thật như trên.
  - Lưu ý: `game.html` chỉ là canvas thuần, không có toast/giọng đọc như `index.html` nên các event `follow`, `member_join`, `liked_stream` không được xử lý ở file này (không có UI để hiện).

## Chưa đụng tới — bạn cần biết
