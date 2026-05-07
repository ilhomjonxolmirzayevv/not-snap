# 🪙 Not Snap Bot

Not Snap — bu **XE.com** va **Bitget** birjalaridan olingan real vaqtli ma'lumotlar asosida ishlaydigan professional valyuta va kriptovalyuta konvertori. Bot foydalanuvchilarga fiat kurslarini (UZS, RUB, USD) va mashhur kriptovalyutalarni tezkor hisoblash imkonini beradi.

## 🚀 Funksiyalari

* **XE.com integratsiyasi:** Dunyodagi eng ishonchli manbadan olingan fiat valyuta kurslari (UZS, RUB).
* **Bitget narxlari:** Kriptovalyutalar narxini real vaqtda Bitget birjasidan olish.
* **Matematik hisob-kitoblar:** Bot ichida misollarni yechish (masalan: `100 + 50 ton`).
* **Komissiya kalkulyatori:** Sof foydani hisoblash (masalan: `1000 ton com 5`).
* **Avtomatik yangilanish:** Kurslar har 5 daqiqada avtomatik ravishda yangilanadi.
* **Dinamik tugmalar:** Har bir natija ostida kurs manbasiga va birjaga havolalar mavjud.

## 🛠 Texnologiyalar

* **Node.js** — server tomoni.
* **Telegraf.js** — Telegram Bot API bilan ishlash uchun.
* **Axios** — Tashqi API-larga so'rov yuborish.
* **Math.js** — Matematik ifodalarni hisoblash.
* **Express** — Render-da 24/7 onlayn turish uchun mini-server.

## 📥 O'rnatish va ishga tushirish

1.  **Loyiha klonini yuklab oling:**
    ```bash
    git clone [https://github.com/sizning_profil/coinsnap-bot.git](https://github.com/sizning_profil/coinsnap-bot.git)
    cd coinsnap-bot
    ```

2.  **Kutubxonalarni o'rnating:**
    ```bash
    npm install
    ```

3.  **.env faylini yarating va bot tokenini qo'shing:**
    ```env
    API_TOKEN=Sizning_Bot_Tokeningiz
    PORT=5000
    ```

4.  **Botni ishga tushiring:**
    ```bash
    node index.js
    ```

## ☁️ Render.com-ga yuklash (24/7 ishlatish)

1.  GitHub-ga loyihani yuklang.
2.  Render-da **Web Service** yarating.
3.  **Build Command:** `npm install`
4.  **Start Command:** `node index.js`
5.  **Environment Variables** bo'limiga `API_TOKEN` ni qo'shing.
6.  Bot uxlab qolmasligi uchun Render bergan URL manzilni **UptimeRobot**-ga `HTTP(s)` monitor qilib qo'shing.

## ⌨️ Buyruqlar va misollar

* `/start` — Botni ishga tushirish.
* `/coins` — Mashhur kriptovalyutalar narxlarini ko'rish.
* `100 usd uzs` — Dollarni so'mga aylantirish.
* `50 ton com 3` — 50 ta TON dan 3% komissiya olib tashlanganda qoladigan summani hisoblash.
* `1000000 uzs ton` — 1 million so'mga qancha TON berishini hisoblash.
* `2500 + 500 rub` — Matematik amal bajarib, natijani rublda ko'rish.

## 📜 Litsenziya

Ushbu loyiha MIT litsenziyasi ostida yaratilgan.
