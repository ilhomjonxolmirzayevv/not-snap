import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import * as math from 'mathjs';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import express from 'express';
import { MongoClient } from 'mongodb';

dotenv.config();

const API_TOKEN = process.env.API_TOKEN || "";
const PORT = process.env.PORT || 5000;

// MongoDB ulanish manzili (.env dagi MONGO_URI dan olinadi)
const MONGO_URI = process.env.MONGO_URI || "";
// MUHIM: agar MONGO_URI bo'sh bo'lsa, MongoClient yaratmaymiz — aks holda ba'zi
// versiyalarda bo'sh/notog'ri URI bilan MongoClient(...) darhol xatolik (throw)
// berib, butun botni ishga tushishidan to'sqinlik qilishi mumkin.
const mongoClient = MONGO_URI
    ? new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 })
    : null;
let stateCollection = null;

// Adminlar ro'yxati (to'g'ridan-to'g'ri kodga yozilgan)
const ADMIN_IDS = ["1228723117"];

function isAdmin(ctx) {
    return ADMIN_IDS.includes(ctx.from.id.toString());
}

const bot = new Telegraf(API_TOKEN);

// Keshlar va sozlamalar uchun in-memory xotira
const state = {
    uzs: 12850.0,
    rub: 92.5,
    stars_usd: 0.015,
    premium: { 3: 12.0, 6: 16.0, 12: 29.0 },
    last_updated: null,
    alerts: [],
    priceHistory: { GRAM: [] },   // 24s/7k trend uchun narx tarixi
    users: {},                    // userId -> { lang, currency }
    aliases: { 'ton': 'gram', 'somsa': 'gram' },   // taxallus -> asosiy belgi (admin tomonidan boshqariladi)
    adminInfo: {},                 // admin qo'ygan matnlar (masalan karta raqami): key -> matn
    wallets: {},                   // userId -> TON hamyon manzili
    pendingWallet: {}              // userId -> true (hamyon manzili kutilmoqda)
};

// --- SAQLASH VA YUKLASH (MongoDB orqali, bot qayta ishga tushganda ma'lumotlar yo'qolmasligi uchun) ---
async function connectMongo() {
    if (!MONGO_URI || !mongoClient) {
        console.error(
            "⚠️ MONGO_URI topilmadi!\n" +
            "   Agar botni Render'da ishlatayotgan bo'lsangiz: .env fayli Render'ga yuklanmaydi —\n" +
            "   MONGO_URI qiymatini Render Dashboard → sizning servisingiz → Environment →\n" +
            "   Environment Variables bo'limiga qo'lda qo'shishingiz kerak.\n" +
            "   Hozircha bot ishlaydi, lekin hech narsa saqlanmaydi/yuklanmaydi."
        );
        return;
    }
    try {
        await mongoClient.connect();
        const db = mongoClient.db(); // URI ichida ko'rsatilgan baza nomi ishlatiladi
        stateCollection = db.collection('bot_state');
        console.log(`✅ MongoDB'ga ulanildi. Baza nomi: "${db.databaseName}"`);
        if (!db.databaseName || db.databaseName === "test") {
            console.warn(
                "⚠️ Diqqat: baza nomi aniqlanmadi yoki standart \"test\" bazasi ishlatilmoqda.\n" +
                "   MONGO_URI oxirida baza nomini ko'rsating, masalan:\n" +
                "   mongodb+srv://user:pass@cluster.mongodb.net/coinsnap?retryWrites=true&w=majority"
            );
        }
    } catch (e) {
        console.error("⚠️ MongoDB'ga ulanishda xatolik:", e.message);
        console.error(
            "   Tekshiring: 1) MONGO_URI to'g'ri va to'liq ekanini (foydalanuvchi nomi/parol/baza nomi);\n" +
            "   2) MongoDB Atlas'da Network Access bo'limida 0.0.0.0/0 (yoki Render IP'lari) ruxsat berilganini;\n" +
            "   3) Atlas foydalanuvchisi shu bazaga o'qish/yozish huquqiga ega ekanini."
        );
    }
}

async function loadPersistedState() {
    if (!stateCollection) return;
    try {
        const saved = await stateCollection.findOne({ _id: 'main' });
        if (saved) {
            if (saved.aliases) state.aliases = { ...state.aliases, ...saved.aliases };
            if (saved.users) state.users = saved.users;
            if (saved.adminInfo) state.adminInfo = saved.adminInfo;
            if (saved.alerts) state.alerts = saved.alerts;
            if (saved.wallets) state.wallets = saved.wallets;
            if (saved.pendingWallet) state.pendingWallet = saved.pendingWallet;
            console.log("✅ MongoDB'dan saqlangan ma'lumotlar yuklandi.");
        } else {
            console.log("ℹ️ MongoDB'da hali saqlangan hujjat yo'q (birinchi marta ishga tushmoqda bo'lishi mumkin).");
        }
    } catch (e) {
        console.error("⚠️ MongoDB'dan o'qishda xatolik:", e.message);
    }
}

async function savePersistedState() {
    if (!stateCollection) return;
    try {
        await stateCollection.updateOne(
            { _id: 'main' },
            {
                $set: {
                    aliases: state.aliases,
                    users: state.users,
                    adminInfo: state.adminInfo,
                    alerts: state.alerts,
                    wallets: state.wallets,
                    pendingWallet: state.pendingWallet
                }
            },
            { upsert: true }
        );
    } catch (e) {
        console.error("⚠️ MongoDB'ga yozishda xatolik:", e.message);
    }
}

await connectMongo();
await loadPersistedState();

// Foydalanuvchi sozlamalarini olish (yo'q bo'lsa standart bilan yaratadi)
function getUser(userId) {
    if (!state.users[userId]) state.users[userId] = { lang: 'uz', currency: null };
    return state.users[userId];
}

// --- KO'P TILLILIK ---
const translations = {
    uz: {
        start: "👋 **CoinSnap Botga xush kelibsiz!**\n\nBuyruqlar qo'llanmasi: /help",
        help: `📖 **Botdan foydalanish:**\n\n` +
            `🔸 **Kripto (TON va Gram teng):** \`1 gram\`, \`1 ton uzs\`, \`5k gram usd\`\n` +
            `🔸 **Stars:** \`100 stars\`, \`50 stars uzs\`\n` +
            `🔸 **Premium:** \`3 premium\`, \`6 premium usd\`, \`12 premium\`\n` +
            `🔸 **Komissiya:** \`1000 gram com 5\`\n` +
            `🔸 **Foiz:** \`15000 5%\`\n` +
            `🔸 **Matematika:** \`44*6\`, \`100/4\`\n` +
            `🔸 **Qisqartma:** \`5k\` = 5000, \`50k\` = 50000\n\n` +
            `🚨 **Alert:** \`/alert gram 7.5\` (yoki faqat \`/alert 20\` — GRAM deb hisoblanadi)\n` +
            `📋 /rates — joriy kurslar\n` +
            `🔔 /myalerts — faol alertlaringiz\n` +
            `💱 /currency — standart valyuta\n` +
            `🌐 /language — til tanlash\n` +
            `💼 /mywallet — TON hamyoningizni qo'shish/ko'rish\n` +
            `💳 /card — to'lov kartasi (agar admin saqlagan bo'lsa)\n` +
            `ℹ️ /info <kalit> — admin saqlagan boshqa ma'lumot\n` +
            `🌍 /tr en Salom — matnni tarjima qilish (yoki xabarga reply: /tr en)`,
        rates_title: "📊 **Joriy kurslar**",
        last_updated: "Oxirgi yangilanish",
        no_alerts: "🔕 Sizda faol alertlar yo'q. Qo'shish uchun: `/alert gram 7.5`",
        your_alerts: "🔔 **Sizning faol alertlaringiz:**\nO'chirish uchun bosing 👇",
        alert_deleted: "✅ Alert o'chirildi",
        alert_not_found: "⚠️ Alert topilmadi",
        alert_format: "⚠️ Format: `/alert gram 7.5` yoki `/alert 20`",
        alert_bad_number: "Iltimos to'g'ri son kiriting.",
        alert_price_unknown: (t) => `⚠️ ${t} narxini aniqlab bo'lmadi.`,
        alert_saved: (token, price, dir) => `🚨 **Alert muvaffaqiyatli saqlandi!**\n**${token}** narxi **$${price}** qiymatga ${dir === 'UP' ? 'oshganda' : 'tushganda'} sizga xabar beramiz.`,
        choose_currency: "💱 Standart valyuta tanlang (agar konvertatsiyada valyuta ko'rsatmasangiz, shu ishlatiladi):",
        currency_set: (c) => `✅ Standart valyuta: **${c}**`,
        reset: "O'chirish (USD)",
        choose_language: "🌐 Tilni tanlang / Choose language / Выберите язык:",
        language_set: "✅ Til o'zbekchaga o'zgartirildi",
        delete_btn: "🗑 O'chirish",
        trend_none: "—",
        not_admin: "⛔ Bu buyruq faqat adminlar uchun.",
        alias_usage_add: "⚠️ Format: `/addalias somsa gram`\n(birinchi so'z — yangi nom, ikkinchisi — qaysi belgiga tenglashtiriladi: gram, usd, uzs, rub, stars)",
        alias_usage_remove: "⚠️ Format: `/removealias somsa`",
        alias_added: (alias, target) => `✅ **${alias}** endi **${target}** deb qabul qilinadi.`,
        alias_removed: (alias) => `🗑 **${alias}** taxallusi o'chirildi.`,
        alias_not_found: "⚠️ Bunday taxallus topilmadi.",
        alias_list_title: "📋 **Joriy taxalluslar:**",
        alias_list_empty: "📋 Hozircha taxalluslar yo'q.",
        setinfo_usage: "⚠️ Format: `/setinfo card 9860 4535 3535 3535`\n(birinchi so'z — kalit nomi, qolgani — saqlanadigan matn)",
        delinfo_usage: "⚠️ Format: `/delinfo card`",
        info_usage: "⚠️ Format: `/info card`",
        info_saved: (key) => `✅ **${key}** saqlandi.`,
        info_deleted: (key) => `🗑 **${key}** o'chirildi.`,
        info_not_found: "⚠️ Bunday ma'lumot topilmadi.",
        info_list_title: "📋 **Saqlangan ma'lumotlar:**",
        info_list_empty: "📋 Hozircha hech narsa saqlanmagan.",
        card_title: "Karta raqami:",
        tr_usage: "⚠️ Format: `/tr en Salom dunyo`\n(tarjima qilinadigan til kodi, so'ng matn)\n\nYoki biror xabarga **reply** qilib: `/tr ru`\n\nTil kodlari: `en`, `ru`, `uz`, `tr`, `ar`, `de`, `fr`, `es`, `zh` va h.k.",
        tr_error: "⚠️ Tarjima qilib bo'lmadi. Birozdan so'ng qayta urinib ko'ring.",
        wallet_ask: "💼 Sizda hali TON hamyon qo'shilmagan.\n\nHamyon manzilingizni **shu xabarga reply qilib** yuboring 👇",
        wallet_saved: (addr) => `✅ Hamyon saqlandi!\n\`${addr}\`\n\nEndi \`/mywallet\` deb yozib balansingizni istalgan vaqtda ko'rishingiz mumkin.`,
        wallet_invalid: "⚠️ Bu TON hamyon manziliga o'xshamayapti. Iltimos, to'g'ri manzil yuboring (masalan: `EQAbc...` yoki `UQAbc...`).",
        wallet_loading: "🔎 Hamyoningiz tekshirilmoqda...",
        wallet_error: "⚠️ Hamyon ma'lumotlarini olib bo'lmadi. Birozdan so'ng qayta urinib ko'ring.",
        wallet_assets_title: "🪙 **Boshqa asetlar:**",
        wallet_no_assets: "📭 Boshqa asetlar (jetton) topilmadi."
    },
    ru: {
        start: "👋 **Добро пожаловать в CoinSnap Bot!**\n\nСписок команд: /help",
        help: `📖 **Как пользоваться ботом:**\n\n` +
            `🔸 **Крипто (TON и Gram равны):** \`1 gram\`, \`1 ton uzs\`, \`5k gram usd\`\n` +
            `🔸 **Stars:** \`100 stars\`, \`50 stars uzs\`\n` +
            `🔸 **Premium:** \`3 premium\`, \`6 premium usd\`, \`12 premium\`\n` +
            `🔸 **Комиссия:** \`1000 gram com 5\`\n` +
            `🔸 **Процент:** \`15000 5%\`\n` +
            `🔸 **Математика:** \`44*6\`, \`100/4\`\n` +
            `🔸 **Сокращение:** \`5k\` = 5000, \`50k\` = 50000\n\n` +
            `🚨 **Оповещение:** \`/alert gram 7.5\` (или просто \`/alert 20\` — по умолчанию GRAM)\n` +
            `📋 /rates — текущие курсы\n` +
            `🔔 /myalerts — ваши оповещения\n` +
            `💱 /currency — валюта по умолчанию\n` +
            `🌐 /language — выбор языка\n` +
            `💼 /mywallet — добавить/посмотреть свой TON-кошелёк\n` +
            `💳 /card — платёжная карта (если добавлена админом)\n` +
            `ℹ️ /info <ключ> — другая информация от админа\n` +
            `🌍 /tr en Привет — перевод текста (или reply на сообщение: /tr en)`,
        rates_title: "📊 **Текущие курсы**",
        last_updated: "Последнее обновление",
        no_alerts: "🔕 У вас нет активных оповещений. Добавить: `/alert gram 7.5`",
        your_alerts: "🔔 **Ваши активные оповещения:**\nНажмите, чтобы удалить 👇",
        alert_deleted: "✅ Оповещение удалено",
        alert_not_found: "⚠️ Оповещение не найдено",
        alert_format: "⚠️ Формат: `/alert gram 7.5` или `/alert 20`",
        alert_bad_number: "Введите корректное число.",
        alert_price_unknown: (t) => `⚠️ Не удалось определить цену ${t}.`,
        alert_saved: (token, price, dir) => `🚨 **Оповещение сохранено!**\nСообщим, когда **${token}** ${dir === 'UP' ? 'вырастет до' : 'упадёт до'} **$${price}**.`,
        choose_currency: "💱 Выберите валюту по умолчанию (будет использоваться, если вы не укажете валюту при конвертации):",
        currency_set: (c) => `✅ Валюта по умолчанию: **${c}**`,
        reset: "Сбросить (USD)",
        choose_language: "🌐 Tilni tanlang / Choose language / Выберите язык:",
        language_set: "✅ Язык изменён на русский",
        delete_btn: "🗑 Удалить",
        trend_none: "—",
        not_admin: "⛔ Эта команда только для админов.",
        alias_usage_add: "⚠️ Формат: `/addalias somsa gram`\n(первое слово — новое название, второе — к какому символу приравнять: gram, usd, uzs, rub, stars)",
        alias_usage_remove: "⚠️ Формат: `/removealias somsa`",
        alias_added: (alias, target) => `✅ **${alias}** теперь распознаётся как **${target}**.`,
        alias_removed: (alias) => `🗑 Псевдоним **${alias}** удалён.`,
        alias_not_found: "⚠️ Такой псевдоним не найден.",
        alias_list_title: "📋 **Текущие псевдонимы:**",
        alias_list_empty: "📋 Псевдонимов пока нет.",
        setinfo_usage: "⚠️ Формат: `/setinfo card 9860 4535 3535 3535`\n(первое слово — имя ключа, остальное — сохраняемый текст)",
        delinfo_usage: "⚠️ Формат: `/delinfo card`",
        info_usage: "⚠️ Формат: `/info card`",
        info_saved: (key) => `✅ **${key}** сохранено.`,
        info_deleted: (key) => `🗑 **${key}** удалено.`,
        info_not_found: "⚠️ Информация не найдена.",
        info_list_title: "📋 **Сохранённая информация:**",
        info_list_empty: "📋 Пока ничего не сохранено.",
        card_title: "Номер карты:",
        tr_usage: "⚠️ Формат: `/tr en Привет мир`\n(код языка перевода, затем текст)\n\nИли ответом (**reply**) на сообщение: `/tr ru`\n\nКоды языков: `en`, `ru`, `uz`, `tr`, `ar`, `de`, `fr`, `es`, `zh` и т.д.",
        tr_error: "⚠️ Не удалось перевести. Попробуйте позже.",
        wallet_ask: "💼 У вас ещё не добавлен TON-кошелёк.\n\nОтправьте адрес кошелька **ответом (reply) на это сообщение** 👇",
        wallet_saved: (addr) => `✅ Кошелёк сохранён!\n\`${addr}\`\n\nТеперь можете в любой момент написать \`/mywallet\`, чтобы увидеть баланс.`,
        wallet_invalid: "⚠️ Это не похоже на TON-адрес. Пожалуйста, отправьте корректный адрес (например: `EQAbc...` или `UQAbc...`).",
        wallet_loading: "🔎 Проверяем ваш кошелёк...",
        wallet_error: "⚠️ Не удалось получить данные кошелька. Попробуйте позже.",
        wallet_assets_title: "🪙 **Другие активы:**",
        wallet_no_assets: "📭 Других активов (жетонов) не найдено."
    },
    en: {
        start: "👋 **Welcome to CoinSnap Bot!**\n\nCommand list: /help",
        help: `📖 **How to use the bot:**\n\n` +
            `🔸 **Crypto (TON and Gram are equal):** \`1 gram\`, \`1 ton uzs\`, \`5k gram usd\`\n` +
            `🔸 **Stars:** \`100 stars\`, \`50 stars uzs\`\n` +
            `🔸 **Premium:** \`3 premium\`, \`6 premium usd\`, \`12 premium\`\n` +
            `🔸 **Commission:** \`1000 gram com 5\`\n` +
            `🔸 **Percent:** \`15000 5%\`\n` +
            `🔸 **Math:** \`44*6\`, \`100/4\`\n` +
            `🔸 **Shorthand:** \`5k\` = 5000, \`50k\` = 50000\n\n` +
            `🚨 **Alert:** \`/alert gram 7.5\` (or just \`/alert 20\` — defaults to GRAM)\n` +
            `📋 /rates — current rates\n` +
            `🔔 /myalerts — your alerts\n` +
            `💱 /currency — default currency\n` +
            `🌐 /language — choose language\n` +
            `💼 /mywallet — add/view your TON wallet\n` +
            `💳 /card — payment card (if set by admin)\n` +
            `ℹ️ /info <key> — other info set by admin\n` +
            `🌍 /tr en Hello — translate text (or reply to a message: /tr en)`,
        rates_title: "📊 **Current rates**",
        last_updated: "Last updated",
        no_alerts: "🔕 You have no active alerts. Add one: `/alert gram 7.5`",
        your_alerts: "🔔 **Your active alerts:**\nTap to delete 👇",
        alert_deleted: "✅ Alert deleted",
        alert_not_found: "⚠️ Alert not found",
        alert_format: "⚠️ Format: `/alert gram 7.5` or `/alert 20`",
        alert_bad_number: "Please enter a valid number.",
        alert_price_unknown: (t) => `⚠️ Couldn't determine the price of ${t}.`,
        alert_saved: (token, price, dir) => `🚨 **Alert saved!**\nWe'll notify you when **${token}** ${dir === 'UP' ? 'rises to' : 'drops to'} **$${price}**.`,
        choose_currency: "💱 Choose your default currency (used when you don't specify one in a conversion):",
        currency_set: (c) => `✅ Default currency: **${c}**`,
        reset: "Reset (USD)",
        choose_language: "🌐 Tilni tanlang / Choose language / Выберите язык:",
        language_set: "✅ Language switched to English",
        delete_btn: "🗑 Delete",
        trend_none: "—",
        not_admin: "⛔ This command is for admins only.",
        alias_usage_add: "⚠️ Format: `/addalias somsa gram`\n(first word — new name, second — which symbol it maps to: gram, usd, uzs, rub, stars)",
        alias_usage_remove: "⚠️ Format: `/removealias somsa`",
        alias_added: (alias, target) => `✅ **${alias}** is now recognized as **${target}**.`,
        alias_removed: (alias) => `🗑 Alias **${alias}** removed.`,
        alias_not_found: "⚠️ Alias not found.",
        alias_list_title: "📋 **Current aliases:**",
        alias_list_empty: "📋 No aliases yet.",
        setinfo_usage: "⚠️ Format: `/setinfo card 9860 4535 3535 3535`\n(first word — key name, rest — the text to save)",
        delinfo_usage: "⚠️ Format: `/delinfo card`",
        info_usage: "⚠️ Format: `/info card`",
        info_saved: (key) => `✅ **${key}** saved.`,
        info_deleted: (key) => `🗑 **${key}** deleted.`,
        info_not_found: "⚠️ Info not found.",
        info_list_title: "📋 **Saved info:**",
        info_list_empty: "📋 Nothing saved yet.",
        card_title: "Card number:",
        tr_usage: "⚠️ Format: `/tr en Hello world`\n(target language code, then text)\n\nOr reply to a message with: `/tr ru`\n\nLanguage codes: `en`, `ru`, `uz`, `tr`, `ar`, `de`, `fr`, `es`, `zh`, etc.",
        tr_error: "⚠️ Couldn't translate. Please try again shortly.",
        wallet_ask: "💼 You haven't added a TON wallet yet.\n\nSend your wallet address **as a reply to this message** 👇",
        wallet_saved: (addr) => `✅ Wallet saved!\n\`${addr}\`\n\nType \`/mywallet\` any time to check your balance.`,
        wallet_invalid: "⚠️ That doesn't look like a TON address. Please send a valid one (e.g. `EQAbc...` or `UQAbc...`).",
        wallet_loading: "🔎 Checking your wallet...",
        wallet_error: "⚠️ Couldn't fetch wallet data. Please try again shortly.",
        wallet_assets_title: "🪙 **Other assets:**",
        wallet_no_assets: "📭 No other assets (jettons) found."
    }
};

// Foydalanuvchi tiliga mos matnni qaytaradi
function T(userId, key, ...args) {
    const lang = getUser(userId).lang;
    const dict = translations[lang] || translations.uz;
    const val = dict[key] !== undefined ? dict[key] : translations.uz[key];
    return typeof val === 'function' ? val(...args) : val;
}

// --- 1. XE.COM FIAT KURS ---
async function fetchXERate(from, to) {
    try {
        const url = `https://www.xe.com/currencyconverter/convert/?Amount=1&From=${from}&To=${to}`;
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const regex = new RegExp(`1 ${from} = ([0-9,.]+) ${to}`, 'i');
        const match = data.match(regex);
        return match ? parseFloat(match[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
}

// --- 2. BITGET KRIPTO KURS ---
async function getPrice(symbol) {
    let sym = symbol.toUpperCase();

    if (sym === "GRAM" || sym === "TON") sym = "GRAM";
    if (sym === "USD" || sym === "USDT") sym = "USD";

    if (sym === "USDT") return { price: 1.0, change: 0.0 };
    try {
        const res = await axios.get(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}USDT`);
        if (res.data.code === '00000' && res.data.data?.[0]) {
            const t = res.data.data[0];
            return { price: parseFloat(t.lastPr), change: parseFloat(t.change24h) * 100 };
        }
    } catch (e) { return null; }
}

// --- 2b. TON HAMYON MA'LUMOTLARI (TonAPI — TonViewer shu ma'lumotlar bazasidan foydalanadi) ---
function isValidTonAddress(addr) {
    if (!addr) return false;
    const raw = /^-?\d:[0-9a-fA-F]{64}$/;         // masalan: 0:83dfd552e6...
    const friendly = /^[A-Za-z0-9_-]{48}$/;       // masalan: EQAbc... yoki UQAbc...
    return raw.test(addr) || friendly.test(addr);
}

async function getWalletInfo(address) {
    const [accRes, jettonsRes] = await Promise.all([
        axios.get(`https://tonapi.io/v2/accounts/${encodeURIComponent(address)}`, { timeout: 10000 }),
        axios.get(`https://tonapi.io/v2/accounts/${encodeURIComponent(address)}/jettons`, { timeout: 10000 })
            .catch(() => ({ data: { balances: [] } }))
    ]);

    return {
        rawAddress: accRes.data.address,
        balanceNano: accRes.data.balance,
        isSuspended: accRes.data.is_suspended || false,
        jettons: jettonsRes.data.balances || []
    };
}

const WALLET_INTROS = {
    uz: ["🚀 Hamyoningiz mana bunday ko'rinadi:", "✨ Xazinangizni ko'rib chiqdik:", "🎉 Hamyon tekshiruvi tayyor:", "🧭 Mana natija:"],
    ru: ["🚀 Вот как выглядит ваш кошелёк:", "✨ Мы заглянули в ваши сокровища:", "🎉 Проверка кошелька готова:", "🧭 Вот результат:"],
    en: ["🚀 Here's what your wallet looks like:", "✨ We peeked into your treasure chest:", "🎉 Wallet check complete:", "🧭 Here's the result:"]
};

async function formatWalletInfo(userId, address, info) {
    const lang = getUser(userId).lang;
    const introList = WALLET_INTROS[lang] || WALLET_INTROS.uz;
    const intro = introList[Math.floor(Math.random() * introList.length)];

    const tonBalance = Number(info.balanceNano) / 1e9;
    const tonPriceData = await getPrice('TON');
    const tonUsd = tonPriceData ? tonBalance * tonPriceData.price : null;
let text = `${intro}\n\n`;

text += `💼 **Wallet**\n`;
text += `┌ Address\n`;
text += `└ \`${address}\`\n\n`;

text += `💎 **TON Balance**\n`;
text += `└ \`${tonBalance.toFixed(4)} TON\`${tonUsd ? `  •  ≈ $${tonUsd.toFixed(2)}` : ''}\n`;

const positiveJettons = (info.jettons || []).filter(
    j => Number(j.balance) > 0
);

if (positiveJettons.length > 0) {
    text += `\n📦 **Assets**\n\n`;

    for (const j of positiveJettons.slice(0, 15)) {
        const decimals = j.jetton?.decimals ?? 9;
        const bal = Number(j.balance) / Math.pow(10, decimals);
        const symbol = j.jetton?.symbol || '?';

        text += `🔹 **${symbol}**  \`${bal.toLocaleString('en-US', {
            maximumFractionDigits: 4
        })}\`\n`;
    }

    if (positiveJettons.length > 15) {
        text += `\n_… va yana ${positiveJettons.length - 15} ta asset_\n`;
    }
} else {
    text += `\n📦 **Assets**\n`;
    text += `└ ${T(userId, 'wallet_no_assets')}\n`;
}

text += `\n🔗 [View on TonViewer](https://tonviewer.com/${address})`;

return text;
}

async function updateAllRates() {
    console.log("Kurslar yangilanmoqda...");
    const xeUzs = await fetchXERate("USD", "UZS");
    const xeRub = await fetchXERate("USD", "RUB");
    if (xeUzs) state.uzs = xeUzs;
    if (xeRub) state.rub = xeRub;

    // Stars narxi (state.stars_usd) va Premium narxlari (state.premium)
    // qat'iy belgilangan qiymatlar bo'lib qoladi — birjadan yangilanmaydi.
    state.last_updated = new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });

    // GRAM/TON narx tarixini saqlash (24s va 7 kunlik trend uchun)
    const gramData = await getPrice('TON');
    if (gramData) {
        state.priceHistory.GRAM.push({ t: Date.now(), p: gramData.price });
        const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 kundan eskisini tozalash
        state.priceHistory.GRAM = state.priceHistory.GRAM.filter(e => e.t >= cutoff);
    }

    await checkAlerts();
}

// Berilgan token uchun N soat oldingi narxga nisbatan foizli o'zgarishni hisoblaydi
function getTrend(token, hoursAgo) {
    const hist = state.priceHistory[token];
    if (!hist || hist.length === 0) return null;

    const targetTime = Date.now() - hoursAgo * 60 * 60 * 1000;
    let closest = hist[0];
    for (const e of hist) {
        if (e.t <= targetTime) closest = e; else break;
    }
    if (!closest || closest.p === 0) return null;

    const current = hist[hist.length - 1].p;
    return { change: ((current - closest.p) / closest.p) * 100, from: closest.p, to: current };
}

// Alert Tizimi
async function checkAlerts() {
    if (state.alerts.length === 0) return;
    const uniqueTokens = [...new Set(state.alerts.map(a => a.token))];
    const prices = {};

    for (const tok of uniqueTokens) {
        prices[tok] = await getVal(tok);
    }

    for (let i = state.alerts.length - 1; i >= 0; i--) {
        const alert = state.alerts[i];
        const currentPrice = prices[alert.token];

        if (!currentPrice) continue;

        let triggered = false;
        if (alert.direction === 'UP' && currentPrice >= alert.targetPrice) {
            triggered = true;
        } else if (alert.direction === 'DOWN' && currentPrice <= alert.targetPrice) {
            triggered = true;
        }

        if (triggered) {
            const dirSymbol = alert.direction === 'UP' ? '📈 O\'sish' : '📉 Tushish';
            bot.telegram.sendMessage(
                alert.chatId,
                `🚨 **ALERT BILDIRISHNOMASI!**\n\n` +
                `👤 Foydalanuvchi: ${alert.username}\n` +
                `🪙 Token: **${alert.token}**\n` +
                `🎯 Maqsadli narx: \`$${alert.targetPrice}\`\n` +
                `📊 Hozirgi narx: \`$${fmt(currentPrice, 'USD')}\` (${dirSymbol})\n\n` +
                `🔔 Narx belgilangan chegaradan o'tdi!`,
                { parse_mode: 'Markdown' }
            ).catch(() => { });

            state.alerts.splice(i, 1);
        }
    }
}

setInterval(updateAllRates, 300000);
updateAllRates();

// --- 4. FORMATLASH VA HISOB-KITOB ---
function fmt(val, sym = "") {
    const s = sym.toUpperCase();
    if (s === "UZS" || s === "RUB") return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (s === "USDT" || s === "USD") return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return val.toFixed(8).replace(/\.?0+$/, "");
}

// "5k" -> "5000", "1.5k" -> "1500" ko'rinishidagi qisqartmalarni sonlarga aylantiradi
function expandK(text) {
    return text.replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_, num) => {
        return (parseFloat(num) * 1000).toString();
    });
}

// --- MATN TARJIMASI (Google'ning bepul, kalitsiz endpointi orqali) ---
async function translateText(text, targetLang) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
        const { data } = await axios.get(url, { timeout: 10000 });
        const translated = data[0].map(chunk => chunk[0]).join('');
        const detectedLang = data[2] || null;
        return { translated, detectedLang };
    } catch (e) {
        return null;
    }
}

// state.aliases dagi barcha taxalluslarni (masalan "somsa" -> "gram") va "usdt" ni matnda almashtiradi
function normalizeSymbols(text) {
    let result = text.replace(/\busdt\b/g, 'usd');
    for (const [alias, target] of Object.entries(state.aliases)) {
        const re = new RegExp(`\\b${alias}\\b`, 'g');
        result = result.replace(re, target);
    }
    return result;
}

// Har qanday belgi (yoki taxallus, masalan "somsa"/"ton") ni asosiy belgiga (masalan "GRAM") aylantiradi
function resolveSymbol(sym) {
    if (!sym) return sym;
    const lower = sym.toLowerCase();
    if (state.aliases[lower]) return state.aliases[lower].toUpperCase();
    if (sym.toUpperCase() === "USDT") return "USD";
    return sym.toUpperCase();
}

async function getVal(s) {
    const sym = resolveSymbol(s);

    if (sym === "USD") return 1.0;
    if (sym === "GRAM") {
        const tonD = await getPrice('TON');
        return tonD ? tonD.price : null;
    }
    if (sym === "UZS") return 1 / state.uzs;
    if (sym === "RUB") return 1 / state.rub;
    if (sym === "STARS") return state.stars_usd;

    const d = await getPrice(sym);
    return d ? d.price : null;
}

async function getExtras(usdVal, exclude = "") {
    const exc = resolveSymbol(exclude);

    const tonD = await getPrice('TON');
    const lines = [];

    if (exc !== "UZS") lines.push(`🇺🇿 \`${fmt(usdVal * state.uzs, 'UZS')} UZS\``);
    if (exc !== "RUB") lines.push(`🇷🇺 \`${fmt(usdVal * state.rub, 'RUB')} RUB\``);
    if (exc !== "STARS") lines.push(`⭐ \`${fmt(usdVal / state.stars_usd, 'STARS')} Stars\``);

    if (exc !== "USD") lines.push(`🇺🇸 \`$${fmt(usdVal, 'USD')} USD\``);
    if (tonD && exc !== "GRAM") lines.push(`💎 \`${(usdVal / tonD.price).toFixed(3)} GRAM\``);

    return lines.join("\n");
}

// Eski xabarlarni o'tkazib yuborish
bot.use(async (ctx, next) => {
    const now = Math.floor(Date.now() / 1000);

    if (ctx.message) {
        const msgDate = ctx.message.date;
        if (now - msgDate > 5) return;
    }

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        const cbDate = ctx.callbackQuery.message.date;
        if (now - cbDate > 10) return;
    }

    await next();
});

// --- 5. BOT HANDLERLARI ---
bot.start((ctx) => ctx.replyWithMarkdown(T(ctx.from.id, 'start')));

bot.help((ctx) => ctx.replyWithMarkdown(T(ctx.from.id, 'help')));

// --- /RATES — JORIY KURSLAR ---
bot.command(['rates', 'kurslar'], async (ctx) => {
    const userId = ctx.from.id;
    const gram = await getPrice('TON');
    const trend24 = getTrend('GRAM', 24);
    const trend7d = getTrend('GRAM', 24 * 7);

    const trendStr = (tr) => {
        if (!tr) return T(userId, 'trend_none');
        const arrow = tr.change >= 0 ? '📈' : '📉';
        return `${arrow} ${tr.change >= 0 ? '+' : ''}${tr.change.toFixed(2)}%`;
    };

    const msg =
        `${T(userId, 'rates_title')}\n\n` +
        `🇺🇿 1 USD = \`${fmt(state.uzs, 'UZS')}\` UZS\n` +
        `🇷🇺 1 USD = \`${fmt(state.rub, 'RUB')}\` RUB\n` +
        `💎 GRAM/TON = \`$${gram ? fmt(gram.price, 'USD') : '—'}\`  (24s: ${trendStr(trend24)} · 7k: ${trendStr(trend7d)})\n` +
        `⭐ Stars = \`$${state.stars_usd}\`\n\n` +
        `🕐 ${T(userId, 'last_updated')}: ${state.last_updated || '—'}`;

    ctx.replyWithMarkdown(msg);
});

// --- 6. INLINE MODE (FAQAT SO'RALGAN KURS) ---
bot.on('inline_query', async (ctx) => {
    let query = ctx.inlineQuery.query.trim().toLowerCase();
    if (!query) return;

    query = expandK(query);
    query = normalizeSymbols(query);

    const match = query.match(/^([\d\s\+\-\*\/\(\)\.]+)\s+([a-z][a-z0-9]*)(?:\s+(?:to\s+)?([a-z][a-z0-9]*))?$/);
    if (!match) return;

    try {
        const expression = match[1].trim();
        let fSym = resolveSymbol(match[2]);
        let tSym = resolveSymbol(match[3] || getUser(ctx.from.id).currency || "USD");

        let amt = /[\+\-\*\/]/.test(expression) ? math.evaluate(expression) : parseFloat(expression);
        if (isNaN(amt)) return;

        const fVal = await getVal(fSym);
        const tVal = await getVal(tSym);

        if (fVal && tVal) {
            const usd = math.multiply(amt, fVal);
            const res = math.divide(usd, tVal);
            const ts = Date.now();

            const messageText = `💱 ${amt} ${fSym} = ${fmt(res, tSym)} ${tSym}`;

            return ctx.answerInlineQuery([{
                type: 'article',
                id: `convert_${ts}`,
                title: `${fmt(amt, fSym)} ${fSym} = ${fmt(res, tSym)} ${tSym}`,
                description: `Kurs: 1 ${fSym} = ${fmt(fVal / tVal, tSym)} ${tSym}`,
                input_message_content: {
                    message_text: messageText,
                    parse_mode: 'Markdown'
                },
            }], {
                cache_time: 0,
                is_personal: true
            });
        }
    } catch (e) {
        console.error("Inline xatolik:", e.message);
    }
});

// --- 7. ALERT COMMAND ---
bot.command('alert', async (ctx) => {
    const userId = ctx.from.id;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
        return ctx.replyWithMarkdown(T(userId, 'alert_format'));
    }

    let token = 'GRAM';
    let targetPrice;

    if (parts.length === 2) {
        targetPrice = parseFloat(parts[1]);
    } else if (parts.length >= 3) {
        token = resolveSymbol(parts[1]);
        targetPrice = parseFloat(parts[2]);
    }

    if (isNaN(targetPrice)) return ctx.reply(T(userId, 'alert_bad_number'));

    const currentPrice = await getVal(token);
    if (!currentPrice) return ctx.reply(T(userId, 'alert_price_unknown', token));

    const direction = currentPrice <= targetPrice ? 'UP' : 'DOWN';

    state.alerts.push({
        id: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
        chatId: ctx.chat.id,
        fromId: userId,
        username: ctx.from.username ? `@${ctx.from.username}` : `User_${userId}`,
        token,
        targetPrice,
        direction
    });
    savePersistedState();

    ctx.replyWithMarkdown(T(userId, 'alert_saved', token, targetPrice, direction));
});

// --- /MYALERTS — FOYDALANUVCHI ALERTLARI RO'YXATI VA O'CHIRISH ---
bot.command(['myalerts', 'alertlarim'], async (ctx) => {
    const userId = ctx.from.id;
    const myAlerts = state.alerts.filter(a => a.fromId === userId);

    if (myAlerts.length === 0) {
        return ctx.replyWithMarkdown(T(userId, 'no_alerts'));
    }

    const buttons = myAlerts.map(a => [
        Markup.button.callback(`❌ ${a.token} → $${a.targetPrice}`, `delalert_${a.id}`)
    ]);

    ctx.replyWithMarkdown(T(userId, 'your_alerts'), Markup.inlineKeyboard(buttons));
});

// Alertni ro'yxatdan o'chirish
bot.action(/delalert_(.+)/, (ctx) => {
    const userId = ctx.from.id;
    const alertId = ctx.match[1];
    const idx = state.alerts.findIndex(a => a.id === alertId && a.fromId === userId);

    if (idx === -1) {
        return ctx.answerCbQuery(T(userId, 'alert_not_found'));
    }

    state.alerts.splice(idx, 1);
    savePersistedState();
    ctx.answerCbQuery(T(userId, 'alert_deleted'));
    ctx.deleteMessage().catch(() => { });
});

// --- /CURRENCY — STANDART VALYUTA TANLASH ---
bot.command(['currency', 'valyuta'], (ctx) => {
    const userId = ctx.from.id;
    ctx.replyWithMarkdown(T(userId, 'choose_currency'), Markup.inlineKeyboard([
        [Markup.button.callback('🇺🇿 UZS', 'setcur_UZS'), Markup.button.callback('🇷🇺 RUB', 'setcur_RUB')],
        [Markup.button.callback('🇺🇸 USD', 'setcur_USD'), Markup.button.callback('⭐ Stars', 'setcur_STARS')],
        [Markup.button.callback('💎 GRAM', 'setcur_GRAM')],
        [Markup.button.callback('↩️ ' + T(userId, 'reset'), 'setcur_NONE')]
    ]));
});

bot.action(/setcur_(.+)/, (ctx) => {
    const userId = ctx.from.id;
    const cur = ctx.match[1];
    const user = getUser(userId);
    user.currency = cur === 'NONE' ? null : cur;
    savePersistedState();

    ctx.answerCbQuery();
    ctx.editMessageText(T(userId, 'currency_set', user.currency || 'USD'), { parse_mode: 'Markdown' });
});

// --- /LANGUAGE — TIL TANLASH ---
bot.command(['language', 'til', 'язык'], (ctx) => {
    const userId = ctx.from.id;
    ctx.replyWithMarkdown(T(userId, 'choose_language'), Markup.inlineKeyboard([
        [
            Markup.button.callback("🇺🇿 O'zbek", 'setlang_uz'),
            Markup.button.callback('🇷🇺 Русский', 'setlang_ru'),
            Markup.button.callback('🇬🇧 English', 'setlang_en')
        ]
    ]));
});

bot.action(/setlang_(uz|ru|en)/, (ctx) => {
    const userId = ctx.from.id;
    getUser(userId).lang = ctx.match[1];
    savePersistedState();
    ctx.answerCbQuery();
    ctx.editMessageText(T(userId, 'language_set'), { parse_mode: 'Markdown' });
});

// --- /MYWALLET — TON HAMYONNI QO'SHISH / KO'RISH ---
bot.command(['mywallet', 'hamyonim'], async (ctx) => {
    const userId = ctx.from.id;
    const wallet = state.wallets[userId];

    if (!wallet) {
        state.pendingWallet[userId] = true;
        savePersistedState();
        return ctx.replyWithMarkdown(T(userId, 'wallet_ask'));
    }

    const loadingMsg = await ctx.replyWithMarkdown(T(userId, 'wallet_loading'));
    try {
        const info = await getWalletInfo(wallet);
        const text = await formatWalletInfo(userId, wallet, info);
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, text, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
    } catch (e) {
        console.error('Hamyon ma\'lumotini olishda xatolik:', e.message);
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, T(userId, 'wallet_error'), {
            parse_mode: 'Markdown'
        }).catch(() => { });
    }
});

// Foydalanuvchi /mywallet bosgan bot xabariga hamyon manzilini reply qilib yuborsa, shu yerda ushlanadi
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.botInfo?.id;

    if (state.pendingWallet[userId] && isReplyToBot) {
        const addr = ctx.message.text.trim();

        if (isValidTonAddress(addr)) {
            state.wallets[userId] = addr;
            delete state.pendingWallet[userId];
            savePersistedState();
            return ctx.replyWithMarkdown(T(userId, 'wallet_saved', addr), {
                reply_to_message_id: ctx.message.message_id
            });
        }

        return ctx.replyWithMarkdown(T(userId, 'wallet_invalid'), {
            reply_to_message_id: ctx.message.message_id
        });
    }

    return next();
});

// --- /ADMIN: YANGI TAXALLUS QO'SHISH/O'CHIRISH ("somsa" kabi) ---
bot.command('addalias', (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(ctx)) return ctx.reply(T(userId, 'not_admin'));

    const parts = ctx.message.text.split(' ');
    if (parts.length < 3) return ctx.replyWithMarkdown(T(userId, 'alias_usage_add'));

    const alias = parts[1].toLowerCase();
    const target = parts[2].toLowerCase();

    state.aliases[alias] = target;
    savePersistedState();
    ctx.replyWithMarkdown(T(userId, 'alias_added', alias, target.toUpperCase()));
});

bot.command('removealias', (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(ctx)) return ctx.reply(T(userId, 'not_admin'));

    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.replyWithMarkdown(T(userId, 'alias_usage_remove'));

    const alias = parts[1].toLowerCase();
    if (!state.aliases[alias]) return ctx.reply(T(userId, 'alias_not_found'));

    delete state.aliases[alias];
    savePersistedState();
    ctx.replyWithMarkdown(T(userId, 'alias_removed', alias));
});

bot.command(['aliases', 'taxalluslar'], (ctx) => {
    const userId = ctx.from.id;
    const entries = Object.entries(state.aliases);
    if (entries.length === 0) return ctx.reply(T(userId, 'alias_list_empty'));

    const list = entries.map(([a, t]) => `\`${a}\` → **${t.toUpperCase()}**`).join('\n');
    ctx.replyWithMarkdown(`${T(userId, 'alias_list_title')}\n\n${list}`);
});

// --- /ADMIN: ISTALGAN MATN/RAQAM SAQLASH (masalan karta raqami) ---
// /setinfo card 9860 4535 3535 3535  ->  keyingi qismning hammasi (bo'shliqlar bilan) matn sifatida saqlanadi
bot.command('setinfo', (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(ctx)) return ctx.reply(T(userId, 'not_admin'));

    const text = ctx.message.text;
    const parts = text.split(' ');
    if (parts.length < 3) return ctx.replyWithMarkdown(T(userId, 'setinfo_usage'));

    const key = parts[1].toLowerCase();
    const value = parts.slice(2).join(' ').trim();

    state.adminInfo[key] = value;
    savePersistedState();
    ctx.replyWithMarkdown(T(userId, 'info_saved', key));
});

bot.command('delinfo', (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(ctx)) return ctx.reply(T(userId, 'not_admin'));

    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.replyWithMarkdown(T(userId, 'delinfo_usage'));

    const key = parts[1].toLowerCase();
    if (!state.adminInfo[key]) return ctx.reply(T(userId, 'info_not_found'));

    delete state.adminInfo[key];
    savePersistedState();
    ctx.replyWithMarkdown(T(userId, 'info_deleted', key));
});

// Hammaga ochiq: /info card -> admin saqlagan matnni ko'rsatadi
bot.command('info', (ctx) => {
    const userId = ctx.from.id;
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) return ctx.replyWithMarkdown(T(userId, 'info_usage'));

    const key = parts[1].toLowerCase();
    const value = state.adminInfo[key];
    if (!value) return ctx.reply(T(userId, 'info_not_found'));

    ctx.replyWithMarkdown(`ℹ️ **${key}:**\n\`${value}\``);
});

// Qulaylik uchun tezkor buyruq: /card -> state.adminInfo['card']ni to'g'ridan-to'g'ri ko'rsatadi
bot.command('card', (ctx) => {
    const userId = ctx.from.id;
    const value = state.adminInfo['card'];
    if (!value) return ctx.reply(T(userId, 'info_not_found'));

    ctx.replyWithMarkdown(`💳 ${T(userId, 'card_title')}\n\`${value}\``);
});

// Admin uchun: barcha saqlangan kalitlarni ko'rish
bot.command('infolist', (ctx) => {
    const userId = ctx.from.id;
    if (!isAdmin(ctx)) return ctx.reply(T(userId, 'not_admin'));

    const entries = Object.entries(state.adminInfo);
    if (entries.length === 0) return ctx.reply(T(userId, 'info_list_empty'));

    const list = entries.map(([k, v]) => `\`${k}\` → ${v}`).join('\n');
    ctx.replyWithMarkdown(`${T(userId, 'info_list_title')}\n\n${list}`);
});

// --- /TR — MATNNI TARJIMA QILISH ---
// Ishlatilishi: /tr en Salom dunyo   -> matnni inglizchaga tarjima qiladi
// Yoki: biror xabarga reply qilib /tr ru  -> o'sha xabarni ruschaga tarjima qiladi
bot.command('tr', async (ctx) => {
    const userId = ctx.from.id;
    const parts = ctx.message.text.split(' ');

    if (parts.length < 2) {
        return ctx.replyWithMarkdown(T(userId, 'tr_usage'));
    }

    const targetLang = parts[1].toLowerCase();
    let textToTranslate = parts.slice(2).join(' ').trim();

    // Agar matn berilmagan bo'lsa, reply qilingan xabar matnini olamiz
    if (!textToTranslate && ctx.message.reply_to_message?.text) {
        textToTranslate = ctx.message.reply_to_message.text;
    }

    if (!textToTranslate) {
        return ctx.replyWithMarkdown(T(userId, 'tr_usage'));
    }

    const result = await translateText(textToTranslate, targetLang);
    if (!result) {
        return ctx.reply(T(userId, 'tr_error'));
    }

    ctx.reply(result.translated, {
        reply_to_message_id: ctx.message.reply_to_message
            ? ctx.message.reply_to_message.message_id
            : ctx.message.message_id
    });
});
// --- KANAL POSTLARINI AVTO-TARJIMA QILISH ---
bot.on('message', async (ctx, next) => {
    const msg = ctx.message;

    // Faqat kanaldan avtomatik guruhga tushgan postlarni ushlaymiz
    const isChannelPost = msg.is_automatic_forward || msg.sender_chat?.type === 'channel';

    if (!isChannelPost) {
        return next(); // Oddiy foydalanuvchi xabari bo'lsa, keyingi middleware'ga o'tadi
    }

    const textToTranslate = msg.text || msg.caption; // Matn yoki rasm ostidagi fel/caption
    if (!textToTranslate) return;

    // Tilni aniqlash va o'zbekcha bo'lmasa tarjima qilish
    // Eslatma: translateText funktsiyangiz `sourceLang` yoki avto-tarjimani qo'llashi kerak
    const result = await translateText(textToTranslate, 'uz');

    // Agar matn allaqachon o'zbekcha bo'lsa yoki tarjima amalga oshmagan bo'lsa to'xtaymiz
    if (!result || result.detectedLang === 'uz' || result.translated === textToTranslate) {
        return;
    }

    // Tarjima qilingan matnni post ostiga reply qilib yuborish
    try {
        await ctx.reply(`🇺🇿 **O'zbekcha tarjimasi:**\n\n${result.translated}`, {
            reply_to_message_id: msg.message_id,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error('Avto-tarjima yuborishda xatolik:', err);
    }
});

// --- 8. MATNLARNI QAYTA ISHLASH (MAIN HANDLER) ---
async function handleConversion(ctx) {
    if (!ctx.message || !ctx.message.text || ctx.from?.is_bot) return;

    let text = ctx.message.text.toLowerCase().replace(/,/g, '.').trim();

    text = expandK(text);
    text = normalizeSymbols(text);

    // Premium hisob-kitobi
    const m_prem = text.match(/^(\d+)\s+premium(?:\s+([a-z]+))?$/);
    if (m_prem) {
        const m = parseInt(m_prem[1]);
        let tSym = resolveSymbol(m_prem[2] || getUser(ctx.from.id).currency || "USD");

        if (state.premium[m]) {
            const usdVal = state.premium[m];
            const tVal = await getVal(tSym);
            const resText = `🌟 **Telegram Premium (${m} oy)**\n\n💰 Narxi: \`${fmt(usdVal / tVal, tSym)} ${tSym}\`\n\n${await getExtras(usdVal, tSym)}`;
            return ctx.replyWithMarkdown(resText, {
                reply_to_message_id: ctx.message.message_id,
                ...Markup.inlineKeyboard([[Markup.button.callback(T(ctx.from.id, 'delete_btn'), `del_${ctx.from.id}_${ctx.message.message_id}`)]])
            });
        }
    }

    // Komissiya hisob-kitobi
    const m_com = text.match(/^(\d+(?:\.\d+)?)\s+([a-z0-9]+)\s+com\s+(\d+(?:\.\d+)?)$/);
    if (m_com) {
        const amt = parseFloat(m_com[1]);
        let sym = resolveSymbol(m_com[2]);

        const prc = parseFloat(m_com[3]);
        const res = amt - (amt * prc / 100);
        const rate = await getVal(sym);
        if (rate) {
            const resText = `⚖️ **Komissiya: ${prc}%**\n\n✅ Qoladi: \`${fmt(res, sym)} ${sym}\`\n\n${await getExtras(res * rate, sym)}`;
            return ctx.replyWithMarkdown(resText, {
                reply_to_message_id: ctx.message.message_id,
                ...Markup.inlineKeyboard([[Markup.button.callback(T(ctx.from.id, 'delete_btn'), `del_${ctx.from.id}_${ctx.message.message_id}`)]])
            });
        }
    }

    // Foiz hisob-kitobi
    const m_perc = text.match(/^([\d\s\+\-\*\/\(\)\.]+)\s+(\d+(?:\.\d+)?)\s*%$/);
    if (m_perc) {
        try {
            const baseText = m_perc[1].trim();
            const base = math.evaluate(baseText);
            const prc = parseFloat(m_perc[2]);
            const res = math.divide(math.multiply(base, prc), 100);

            const resText =
                `${prc}% of ${fmt(base)} = ${fmt(res)}\n\n` +
                `+ ${fmt(math.add(base, res))}\n` +
                `- ${fmt(math.subtract(base, res))}`;

            return ctx.replyWithMarkdown(resText, {
                reply_to_message_id: ctx.message.message_id,
                ...Markup.inlineKeyboard([[Markup.button.callback(T(ctx.from.id, 'delete_btn'), `del_${ctx.from.id}_${ctx.message.message_id}`)]])
            });
        } catch (e) { }
    }

    // Matematika va Kurs Konvertatsiyasi
    const m_pair = text.match(/^([\d\s\+\-\*\/\(\)\.]+)\s+([a-z][a-z0-9]*)(?:\s+(?:to\s+)?([a-z][a-z0-9]*))?$/);
    if (m_pair) {
        try {
            const expression = m_pair[1].trim();
            let fSym = resolveSymbol(m_pair[2]);
            let tSym = resolveSymbol(m_pair[3] || getUser(ctx.from.id).currency || "USD");

            let amt = /[\+\-\*\/]/.test(expression) ? math.evaluate(expression) : parseFloat(expression);
            if (isNaN(amt)) return;

            const fVal = await getVal(fSym);
            const tVal = await getVal(tSym);
            const crypto = await getPrice(fSym);

            if (fVal && tVal) {
                const usd = math.multiply(amt, fVal);
                const res = math.divide(usd, tVal);
                let info = crypto && fSym !== "USD" ? `\n${crypto.change >= 0 ? '🟢' : '🔴'} 24s: \`${crypto.change >= 0 ? '+' : ''}${crypto.change.toFixed(2)}%\`` : "";

                const isMath = /[\+\-\*\/]/.test(expression);
                const header = isMath ? `🔢 \`${expression}\` **= ${fmt(amt, fSym)} ${fSym}**` : `🔄 **${fmt(amt, fSym)} ${fSym}**`;

                const resText = `${header}\n🪙 \`${fmt(res, tSym)} ${tSym}\`${info}\n\n${await getExtras(usd, tSym)}`;

                return ctx.replyWithMarkdown(resText, {
                    reply_to_message_id: ctx.message.message_id,
                    ...Markup.inlineKeyboard([[Markup.button.callback(T(ctx.from.id, 'delete_btn'), `del_${ctx.from.id}_${ctx.message.message_id}`)]])
                });
            }
        } catch (e) { }
    }

    // Oddiy Matematika
    if (/^[0-9\+\-\*\/\(\)\.\s]+$/.test(text) && /[\+\-\*\/]/.test(text)) {
        try {
            const calc = math.evaluate(text);
            return ctx.replyWithMarkdown(`\`${text} = ${calc.toLocaleString()}\``, {
                reply_to_message_id: ctx.message.message_id,
                ...Markup.inlineKeyboard([[Markup.button.callback(T(ctx.from.id, 'delete_btn'), `del_${ctx.from.id}_${ctx.message.message_id}`)]])
            });
        } catch (e) { }
    }
}

bot.on('text', (ctx) => handleConversion(ctx));

// --- 9. TO'LIQ VA XAVFSIZ O'CHIRISH (DELETE) ---
bot.action(/del_(\d+)/, (ctx) => {
    if (ctx.from.id.toString() === ctx.match[1]) ctx.deleteMessage().catch(() => { });
});
// --- 10. SERVER ISHGA TUSHISHI ---
const server = express();
server.get('/', (req, res) => res.send('Not Snap is Live!'));
server.listen(PORT, () => console.log(`Server portda faol: ${PORT}`));

bot.launch();
