import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import * as math from 'mathjs';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import express from 'express';
import { MongoClient } from 'mongodb';
import { createCanvas } from '@napi-rs/canvas';

dotenv.config();

// Eng tashqi himoya qatlami: bot.catch() faqat Telegraf'ning o'z yangilik
// qayta ishlash zanjiridagi xatoliklarni ushlaydi. Lekin setInterval orqali
// ishlaydigan kurs yangilanishi kabi joylarda chiqqan ushlanmagan xatolik ham
// xuddi shunday butun Node jarayonini qulatib qo'yishi mumkin edi. Shu sabab
// bunday xatoliklarni ham shu yerda ushlab, faqat konsolga yozamiz.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Ushlanmagan Promise xatoligi:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Ushlanmagan xatolik:', err);
});

const API_TOKEN = process.env.API_TOKEN || "";
const PORT = process.env.PORT || 5000;
// Inline rejimdagi svop-kartochka rasmi uchun ochiq (public) manzil kerak — Telegram
// serverlari shu URL orqali rasmni yuklab oladi. Render buni RENDER_EXTERNAL_URL
// nomli environment variable orqali avtomatik beradi. Agar Render'dan boshqa joyda
// (masalan lokal kompyuterda) ishlatilsa, PUBLIC_BASE_URL'ni .env'da qo'lda ko'rsating
// (masalan https://sizning-domeningiz.com), aks holda inline svop-rasmlari ko'rinmaydi.
const PUBLIC_BASE_URL = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
if (!process.env.RENDER_EXTERNAL_URL && !process.env.PUBLIC_BASE_URL) {
    console.log("ℹ️ PUBLIC_BASE_URL/RENDER_EXTERNAL_URL sozlanmagan — inline svop-rasmlari faqat serverning o'zi ochiq manzilga ega bo'lsagina ko'rinadi.");
}

// Yandex Cloud Translate (.env: YANDEX_API_KEY, YANDEX_FOLDER_ID).
// Olish yo'li: https://yandex.cloud -> Cloud konsoliga kiring (bepul/trial
// billing hisob ham yetarli) -> "Folder ID" ni nusxalang (YANDEX_FOLDER_ID) ->
// "Service accounts" bo'limida yangi xizmat hisobi yarating, unga
// "ai.translate.user" rolini bering -> shu hisob uchun API-kalit yarating
// (YANDEX_API_KEY). Sozlanmasa, tarjima faqat Google'ning zaxira usuli
// (translate.googleapis.com) orqali ishlaydi.
const YANDEX_API_KEY = process.env.YANDEX_API_KEY || "";
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || "";
if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
    console.log("ℹ️ YANDEX_API_KEY/YANDEX_FOLDER_ID sozlanmagan — tarjima faqat Google'ning zaxira usuli orqali ishlaydi.");
}

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

// MUHIM: bu bo'lmasa, ISTALGAN bitta xabarni yuborishda chiqqan xatolik
// (masalan noto'g'ri Markdown, Telegram API xatoligi, tarmoq muammosi)
// butun bot jarayonini qulatib qo'yadi va u BARCHA foydalanuvchilar uchun
// to'xtab qoladi (qayta ishga tushirilguncha). Shu sabab har qanday
// ushlanmagan xatolikni shu yerda ushlab, faqat konsolga yozamiz.
bot.catch((err, ctx) => {
    console.error(`⚠️ Botda ushlanmagan xatolik (update ${ctx.update?.update_id}):`, err);
});

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
    pendingWallet: {},             // userId -> true (hamyon manzili kutilmoqda)
    autoTranslateLang: 'uz'        // kanal postlari avtomatik shu tilga tarjima qilinadi (/tr st <til> orqali o'zgartiriladi)
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
            if (saved.autoTranslateLang) state.autoTranslateLang = saved.autoTranslateLang;
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
                    pendingWallet: state.pendingWallet,
                    autoTranslateLang: state.autoTranslateLang
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
        wallet_no_assets: "📭 Boshqa asetlar (jetton) topilmadi.",
        wallet_change_btn: "🔄 Hamyonni o'zgartirish",
        wallet_hide_balance_btn: "🙈 Balansni yashirish",
        wallet_show_balance_btn: "👁 Balansni ko'rsatish",
        wallet_showall_btn: "🔎 Barcha asetlarni ko'rish",
        wallet_lookup_no_reply: "⚠️ Bu buyruqni kimningdir xabariga **reply** qilib yuboring — shunda o'sha odamning hamyoni ko'rsatiladi.",
        wallet_lookup_not_found: "⚠️ Bu foydalanuvchi hali TON hamyon qo'shmagan.",
        wallet_lookup_result: (name, addr) => `💼 **${name}**ning hamyoni:\n\`${addr}\``,
        tr_set_usage: "⚠️ Format: `/tr st uz`\n(kanaldan tushgan postlar avtomatik tarjima qilinadigan standart tilni belgilaydi)",
        tr_set_saved: (lang) => `✅ Kanal postlari uchun standart tarjima tili endi: **${lang}**`
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
        wallet_no_assets: "📭 Других активов (жетонов) не найдено.",
        wallet_change_btn: "🔄 Изменить кошелёк",
        wallet_hide_balance_btn: "🙈 Скрыть баланс",
        wallet_show_balance_btn: "👁 Показать баланс",
        wallet_showall_btn: "🔎 Показать все активы",
        wallet_lookup_no_reply: "⚠️ Отправьте эту команду **ответом (reply)** на чьё-то сообщение — тогда покажется кошелёк этого человека.",
        wallet_lookup_not_found: "⚠️ Этот пользователь ещё не добавил TON-кошелёк.",
        wallet_lookup_result: (name, addr) => `💼 Кошелёк **${name}**:\n\`${addr}\``,
        tr_set_usage: "⚠️ Формат: `/tr st uz`\n(задаёт язык, на который автоматически переводятся посты из канала)",
        tr_set_saved: (lang) => `✅ Язык автоперевода постов канала теперь: **${lang}**`
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
        wallet_no_assets: "📭 No other assets (jettons) found.",
        wallet_change_btn: "🔄 Change wallet",
        wallet_hide_balance_btn: "🙈 Hide balance",
        wallet_show_balance_btn: "👁 Show balance",
        wallet_showall_btn: "🔎 Show all assets",
        wallet_lookup_no_reply: "⚠️ Send this command as a **reply** to someone's message — that person's wallet will then be shown.",
        wallet_lookup_not_found: "⚠️ This user hasn't added a TON wallet yet.",
        wallet_lookup_result: (name, addr) => `💼 **${name}**'s wallet:\n\`${addr}\``,
        tr_set_usage: "⚠️ Format: `/tr st uz`\n(sets the default language incoming channel posts get auto-translated into)",
        tr_set_saved: (lang) => `✅ Default channel auto-translate language is now: **${lang}**`
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
        axios.get(`https://tonapi.io/v2/accounts/${encodeURIComponent(address)}/jettons?currencies=usd`, { timeout: 10000 })
            .catch(() => ({ data: { balances: [] } }))
    ]);

    return {
        rawAddress: accRes.data.address,
        balanceNano: accRes.data.balance,
        isSuspended: accRes.data.is_suspended || false,
        jettons: jettonsRes.data.balances || []
    };
}

// TonAPI javobidagi turli mumkin bo'lgan joylardan jetton narxini (USD) topishga urinadi.
// Topilmasa null qaytaradi (chiqishda shunchaki USD qiymati ko'rsatilmaydi, xatolik bermaydi).
function getJettonUsdPrice(j) {
    const raw = j.price?.prices?.USD ?? j.price?.prices?.usd ?? null;
    const num = raw != null ? Number(raw) : NaN;
    return isNaN(num) ? null : num;
}

const WALLET_INTROS = {
    uz: ["🚀 Hamyoningiz mana bunday ko'rinadi:", "✨ Xazinangizni ko'rib chiqdik:", "🎉 Hamyon tekshiruvi tayyor:", "🧭 Mana natija:"],
    ru: ["🚀 Вот как выглядит ваш кошелёк:", "✨ Мы заглянули в ваши сокровища:", "🎉 Проверка кошелька готова:", "🧭 Вот результат:"],
    en: ["🚀 Here's what your wallet looks like:", "✨ We peeked into your treasure chest:", "🎉 Wallet check complete:", "🧭 Here's the result:"]
};

const WALLET_JETTONS_PREVIEW_COUNT = 3;
const MASK = '••••••';

// hidden — TON/jetton miqdorlarini "••••••" bilan yashiradi
// showAll — true bo'lsa, barcha jettonlarni ko'rsatadi; aks holda faqat dastlabki 3 tasini
async function formatWalletInfo(userId, address, info, hidden = false, showAll = false) {
    const lang = getUser(userId).lang;
    // const introList = WALLET_INTROS[lang] || WALLET_INTROS.uz;
    // const intro = introList[Math.floor(Math.random() * introList.length)];

    const tonBalance = Number(info.balanceNano) / 1e9;
    const tonPriceData = await getPrice('TON');
    const tonUsd = tonPriceData ? tonBalance * tonPriceData.price : null;

    let text = `\n\n`;
    text += `\`${address}\`\n\n`;

    const tonBalStr = hidden ? MASK : tonBalance.toFixed(4);
    const tonUsdStr = hidden ? MASK : (tonUsd ? `~$${tonUsd.toFixed(2)}` : null);
    text += `💎 **TON:** \`${tonBalStr}\`${tonUsdStr ? ` (${tonUsdStr})` : ''}\n`;

    const positiveJettons = (info.jettons || []).filter(j => Number(j.balance) > 0);
    const shownJettons = showAll ? positiveJettons : positiveJettons.slice(0, WALLET_JETTONS_PREVIEW_COUNT);

    if (positiveJettons.length > 0) {
        text += `\n${T(userId, 'wallet_assets_title')}\n`;
        for (const j of shownJettons) {
            const decimals = j.jetton?.decimals ?? 9;
            const bal = Number(j.balance) / Math.pow(10, decimals);
            const symbol = j.jetton?.symbol || '?';
            const balStr = hidden ? MASK : bal.toLocaleString('en-US', { maximumFractionDigits: 4 });

            const usdPrice = getJettonUsdPrice(j);
            const usdStr = (!hidden && usdPrice) ? ` (~$${(bal * usdPrice).toFixed(2)})` : '';

            text += `🔸 ${symbol}: \`${balStr}\`${usdStr}\n`;
        }
        if (!showAll && positiveJettons.length > WALLET_JETTONS_PREVIEW_COUNT) {
            text += `\n_… yana ${positiveJettons.length - WALLET_JETTONS_PREVIEW_COUNT} ta asest bor_\n`;
        }
    } else {
        text += `\n${T(userId, 'wallet_no_assets')}\n`;
    }

    text += `\n🔗 [TonViewer](https://tonviewer.com/${address})`;
    return text;
}

// /mywallet uchun matn + tugmalarni birgalikda tayyorlaydi (hidden/showAll holatiga qarab)
async function buildWalletView(userId, address, hidden, showAll) {
    const info = await getWalletInfo(address);
    const text = await formatWalletInfo(userId, address, info, hidden, showAll);

    const positiveJettons = (info.jettons || []).filter(j => Number(j.balance) > 0);
    const buttons = [];

    const balBtnLabel = hidden ? T(userId, 'wallet_show_balance_btn') : T(userId, 'wallet_hide_balance_btn');
    buttons.push([Markup.button.callback(balBtnLabel, `walletview_${userId}_${hidden ? 0 : 1}_${showAll ? 1 : 0}`)]);

    if (!showAll && positiveJettons.length > WALLET_JETTONS_PREVIEW_COUNT) {
        buttons.push([Markup.button.callback(T(userId, 'wallet_showall_btn'), `walletview_${userId}_${hidden ? 1 : 0}_1`)]);
    }

    buttons.push([Markup.button.callback(T(userId, 'wallet_change_btn'), `changewallet_${userId}`)]);
    buttons.push([Markup.button.callback(T(userId, 'delete_btn'), `del_${userId}_wallet`)]);

    return { text, buttons };
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
// Eslatma: bu norasmiy Google endpointi ba'zan hosting/server IP-manzillarini
// (Render, Heroku va h.k.) bloklab qo'yishi mumkin (odatda brauzerdan ishlaydi,
// lekin serverdan 403 yoki bo'sh javob qaytarishi mumkin). Shu sababli bu yerda
// brauzerga o'xshash header qo'shilgan va ikkinchi domen zaxira sifatida sinaladi.
// Yandex Cloud Translate API v2 orqali tarjima qilishga urinadi.
// YANDEX_API_KEY/YANDEX_FOLDER_ID sozlanmagan bo'lsa, shunchaki null qaytaradi
// (chaqiruvchi funksiya keyin Google'ga o'tadi).
async function translateViaYandex(text, targetLang) {
    if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) return null;

    try {
        const { data } = await axios.post(
            'https://translate.api.cloud.yandex.net/translate/v2/translate',
            {
                folderId: YANDEX_FOLDER_ID,
                texts: [text],
                targetLanguageCode: targetLang
            },
            {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Api-Key ${YANDEX_API_KEY}`
                }
            }
        );

        const t = data?.translations?.[0];
        if (t?.text) {
            return { translated: t.text, detectedLang: t.detectedLanguageCode || null };
        }
        throw new Error(`Kutilmagan javob formati: ${JSON.stringify(data).slice(0, 200)}`);
    } catch (e) {
        const status = e.response?.status ? `HTTP ${e.response.status}` : e.message;
        const details = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : '';
        console.error('⚠️ Yandex Translate xatolik:', status, details);
        return null;
    }
}

async function translateText(text, targetLang) {
    // 1) Yandex Cloud Translate — sozlangan bo'lsa, birinchi navbatda shu ishlatiladi
    const yandexResult = await translateViaYandex(text, targetLang);
    if (yandexResult) return yandexResult;

    // 2) Zaxira: Google'ning bepul, kalitsiz endpointi
    const endpoints = [
        'https://translate.googleapis.com/translate_a/single',
        'https://translate.google.com/translate_a/single'
    ];

    let lastStatus = null;

    for (let i = 0; i < endpoints.length; i++) {
        const base = endpoints[i];

        // Agar oldingi urinish "juda ko'p so'rov" (429) bilan tugagan bo'lsa,
        // keyingi domenga darhol yugurmasdan, biroz kutib turamiz — bu bir xil
        // hisobga/IP'ga qarshi ketma-ket so'rovlarni kamaytiradi.
        if (i > 0 && lastStatus === 429) {
            await new Promise((r) => setTimeout(r, 700));
        }

        try {
            const url = `${base}?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
            const { data } = await axios.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });

            if (Array.isArray(data) && Array.isArray(data[0])) {
                const translated = data[0].map(chunk => chunk[0]).join('');
                const detectedLang = data[2] || null;
                if (translated) return { translated, detectedLang };
            }
            throw new Error(`Kutilmagan javob formati: ${JSON.stringify(data).slice(0, 200)}`);
        } catch (e) {
            lastStatus = e.response?.status || null;
            const status = lastStatus ? `HTTP ${lastStatus}` : e.message;
            console.error(`⚠️ Tarjima xatolik (${base}):`, status);
        }
    }

    // Yandex ham, Google ham muvaffaqiyatsiz bo'ldi — Render loglarida
    // yuqoridagi xatoliklarni tekshiring:
    // - Yandex uchun "HTTP 401/403" — API-kalit yoki folderId noto'g'ri,
    //   yoki xizmat hisobiga "ai.translate.user" roli berilmagan.
    // - Google uchun "HTTP 403" doimiy chiqsa: Google shu serverning
    //   IP-manzilini bloklagan (kod bilan tuzatib bo'lmaydi).
    // - Google uchun "HTTP 429" — bloklash emas, "juda ko'p so'rov" degani,
    //   vaqtincha bo'lishi mumkin.
    return null;
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

// Eski xabarlarni o'tkazib yuborish (bot qayta ishga tushganda navbatda qolib ketgan eski
// matnli xabarlarni o'tkazib yuborish uchun). Tugma bosishlar (callback_query) uchun bu filtr
// qo'llanilmaydi — chunki Telegram callback_query o'zining vaqt tamg'asini bermaydi va
// ctx.callbackQuery.message.date aslida tugma joylashgan xabar YUBORILGAN payt, tugma
// BOSILGAN payt emas. Shu sabab avval "O'chirish"/"Hamyonni o'zgartirish" kabi tugmalar
// xabar yuborilgandan 10 soniya o'tgach umuman ishlamay qolgan edi.
bot.use(async (ctx, next) => {
    if (ctx.message) {
        const now = Math.floor(Date.now() / 1000);
        const msgDate = ctx.message.date;
        if (now - msgDate > 5) return;
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

// --- 6b. INLINE REJIMDA GRAFIKLI RASM (QuickChart — bepul, kalitsiz xizmat) ---
// Faqat GRAM/TON uchun ishlaydi, chunki faqat shu token uchun narx tarixi
// (state.priceHistory.GRAM) saqlanadi. QuickChart tashqi bepul xizmat bo'lgani
// uchun u vaqtincha ishlamay qolsa, rasm ko'rinmasligi mumkin — bu holatda oddiy
// matnli natija hamon ko'rsatiladi (pastdagi inline_query handleriga qarang).
function buildGramChartUrl(currentPrice, changePct) {
    const hist = [...(state.priceHistory.GRAM || [])].sort((a, b) => a.t - b.t);
    if (hist.length < 2) return null;

    const maxPoints = 60;
    const step = Math.max(1, Math.floor(hist.length / maxPoints));
    const sampled = hist.filter((_, i) => i % step === 0);

    const labels = sampled.map(e => new Date(e.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    const data = sampled.map(e => e.p);

    const up = changePct >= 0;
    const lineColor = up ? '#16a34a' : '#dc2626';
    const fillColor = up ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.15)';

    const config = {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'GRAM/USD',
                data,
                borderColor: lineColor,
                backgroundColor: fillColor,
                fill: true,
                pointRadius: 0,
                borderWidth: 2,
                tension: 0.3
            }]
        },
        options: {
            title: {
                display: true,
                text: `GRAM   $${currentPrice.toFixed(4)}   ${up ? '+' : ''}${changePct.toFixed(2)}%`
            },
            legend: { display: false },
            scales: {
                xAxes: [{ gridLines: { display: false } }],
                yAxes: [{ gridLines: { color: '#eeeeee' } }]
            }
        }
    };

    return `https://quickchart.io/chart?width=600&height=320&backgroundColor=white&c=${encodeURIComponent(JSON.stringify(config))}`;
}

// --- 6c. INLINE REJIMDA SVOP-KARTOCHKA (masalan "1 ton uzs" kabi 2 tokenli konvertatsiya uchun) ---
// Emoji shriftiga bog'liq bo'lib qolmasin uchun (ba'zi serverlarda rangli emoji
// shrifti o'rnatilmagan bo'lishi mumkin), ikonkalar oddiy rangli doira + bitta
// harf/belgi ko'rinishida chiziladi.
const TOKEN_ICON_STYLE = {
    GRAM: { char: 'T', color: '#2AABEE' },
    TON: { char: 'T', color: '#2AABEE' },
    USD: { char: '$', color: '#8E8E93' },
    USDT: { char: '$', color: '#26A17B' },
    UZS: { char: 'U', color: '#16A34A' },
    RUB: { char: '₽', color: '#DC2626' },
    STARS: { char: '★', color: '#F59E0B' }
};

function getTokenIconStyle(sym) {
    return TOKEN_ICON_STYLE[sym] || { char: (sym || '?').charAt(0).toUpperCase(), color: '#6366F1' };
}

function drawRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawSwapCardRow(ctx, x, y, w, h, sym, amountStr) {
    const icon = getTokenIconStyle(sym);
    const iconR = 22;
    const iconCx = x + 40;
    const iconCy = y + h / 2;

    ctx.beginPath();
    ctx.arc(iconCx, iconCy, iconR, 0, Math.PI * 2);
    ctx.fillStyle = icon.color;
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon.char, iconCx, iconCy + 1);

    ctx.fillStyle = '#111111';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(sym, iconCx + iconR + 16, iconCy);

    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(amountStr, x + w - 24, iconCy);
}

// PNG buferini qaytaradi — /inline-card.png endpointi shuni to'g'ridan-to'g'ri javob sifatida yuboradi
function buildSwapCardBuffer(fSym, fAmountStr, tSym, tAmountStr) {
    const width = 500, height = 300;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#17212B';
    ctx.fillRect(0, 0, width, height);

    const pad = 24;
    const cardX = pad, cardY = pad, cardW = width - pad * 2, cardH = height - pad * 2;
    drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 20);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();

    const rowH = cardH / 2;
    drawSwapCardRow(ctx, cardX, cardY, cardW, rowH, fSym, fAmountStr);
    drawSwapCardRow(ctx, cardX, cardY + rowH, cardW, rowH, tSym, tAmountStr);

    const midY = cardY + rowH;
    ctx.strokeStyle = '#EEEEEE';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cardX + 24, midY);
    ctx.lineTo(cardX + cardW - 24, midY);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cardX + cardW / 2, midY, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#E9F3FF';
    ctx.fill();
    ctx.fillStyle = '#2AABEE';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\u21C5', cardX + cardW / 2, midY + 1); // ⇅

    return canvas.toBuffer('image/png');
}

// --- 6. INLINE MODE (FAQAT SO'RALGAN KURS) ---
bot.on('inline_query', async (ctx) => {
    let query = ctx.inlineQuery.query.trim().toLowerCase();
    if (!query) return;

    query = expandK(query);
    query = normalizeSymbols(query);

    // Faqat token nomi yozilsa (masalan "gram"), narx + (GRAM uchun) grafikli
    // rasm kartochkasini qaytaramiz — @send bot uslubidagi natija.
    const bareSymbolMatch = query.match(/^([a-z][a-z0-9]*)$/);
    if (bareSymbolMatch) {
        const sym = resolveSymbol(bareSymbolMatch[1]);
        const priceData = await getPrice(sym === 'GRAM' ? 'TON' : sym);
        if (!priceData) return;

        const changeStr = `${priceData.change >= 0 ? '📈 +' : '📉 '}${priceData.change.toFixed(2)}%`;
        const results = [];

        if (sym === 'GRAM') {
            const chartUrl = buildGramChartUrl(priceData.price, priceData.change);
            if (chartUrl) {
                results.push({
                    type: 'photo',
                    id: `chart_${sym}_${Date.now()}`,
                    photo_url: chartUrl,
                    thumb_url: chartUrl,
                    photo_width: 600,
                    photo_height: 320,
                    caption: `💎 GRAM/TON = \`$${fmt(priceData.price, 'USD')}\`  (${changeStr})`,
                    parse_mode: 'Markdown'
                });
            }
        }

        results.push({
            type: 'article',
            id: `price_${sym}_${Date.now()}`,
            title: `${sym} = $${fmt(priceData.price, 'USD')}`,
            description: `24s: ${changeStr}`,
            input_message_content: {
                message_text: `💱 **${sym}** = \`$${fmt(priceData.price, 'USD')}\`  (${changeStr})`,
                parse_mode: 'Markdown'
            }
        });

        return ctx.answerInlineQuery(results, { cache_time: 60, is_personal: false });
    }

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

            const cardUrl = `${PUBLIC_BASE_URL}/inline-card.png?f=${encodeURIComponent(fSym)}&fa=${encodeURIComponent(fmt(amt, fSym))}&t=${encodeURIComponent(tSym)}&ta=${encodeURIComponent(fmt(res, tSym))}`;

            return ctx.answerInlineQuery([
                {
                    type: 'photo',
                    id: `convertcard_${ts}`,
                    photo_url: cardUrl,
                    thumb_url: cardUrl,
                    photo_width: 500,
                    photo_height: 300,
                    caption: messageText,
                    parse_mode: 'Markdown'
                },
                {
                    type: 'article',
                    id: `convert_${ts}`,
                    title: `${fmt(amt, fSym)} ${fSym} = ${fmt(res, tSym)} ${tSym}`,
                    description: `Kurs: 1 ${fSym} = ${fmt(fVal / tVal, tSym)} ${tSym}`,
                    input_message_content: {
                        message_text: messageText,
                        parse_mode: 'Markdown'
                    },
                }
            ], {
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

    // "/mywallet m" — kimningdir xabariga reply qilib yuborilsa, o'sha odamning
    // hamyon manzilini nusxa olish qulay bo'lgan (monospace) shaklda ko'rsatadi.
    // Reply qilinmagan bo'lsa (yoki botning o'z xabariga reply qilingan bo'lsa),
    // buyruqni yozgan odamning (ya'ni o'zining) hamyoni xuddi shu monospace
    // shaklda ko'rsatiladi — savdo paytida o'z manzilini tez nusxalash uchun.
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts[1] && parts[1].toLowerCase() === 'm') {
        const targetMsg = ctx.message.reply_to_message;

        let targetUser;
        if (targetMsg && targetMsg.from) {
            // Agar reply qilingan xabar botning o'zinikidan bo'lsa (masalan avvalgi
            // ogohlantirish xabariga tasodifan reply qilingan bo'lsa), botning emas,
            // shu buyruqni yozgan odamning (ya'ni o'zining) hamyonini ko'rsatamiz.
            targetUser = targetMsg.from.is_bot ? ctx.from : targetMsg.from;
        } else {
            // Reply umuman yo'q — demak o'zining hamyonini so'ramoqda.
            targetUser = ctx.from;
        }

        const targetId = targetUser.id;
        const targetWallet = state.wallets[targetId];
        if (!targetWallet) {
            return ctx.reply(T(userId, 'wallet_lookup_not_found'));
        }

        const targetName = targetUser.username ? `@${targetUser.username}` : (targetUser.first_name || `User_${targetId}`);

        await ctx.replyWithMarkdown(T(userId, 'wallet_lookup_result', targetName, targetWallet), {
            reply_to_message_id: targetMsg ? targetMsg.message_id : ctx.message.message_id
        });

        // Guruhni savdo paytida toza saqlash uchun "/mywallet m" buyrug'ining o'zini o'chiramiz.
        // ESLATMA: buni bot faqat guruhda admin bo'lib, "xabarlarni o'chirish" huquqiga ega
        // bo'lsagina bajara oladi — shaxsiy chatda yoki huquq bo'lmasa, Telegram bunga umuman
        // ruxsat bermaydi (bu kodning emas, Telegram platformasining o'z cheklovi).
        // ctx.deleteMessage().catch(() => { });
        return;
    }

    const wallet = state.wallets[userId];

    if (!wallet) {
        state.pendingWallet[userId] = true;
        savePersistedState();
        return ctx.replyWithMarkdown(T(userId, 'wallet_ask'), Markup.inlineKeyboard([
            [Markup.button.callback(T(userId, 'delete_btn'), `del_${userId}_askwallet`)]
        ]));
    }

    const loadingMsg = await ctx.replyWithMarkdown(T(userId, 'wallet_loading'));
    try {
        const { text, buttons } = await buildWalletView(userId, wallet, false, false);
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, text, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard(buttons)
        });
    } catch (e) {
        console.error('Hamyon ma\'lumotini olishda xatolik:', e.message);
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, T(userId, 'wallet_error'), {
            parse_mode: 'Markdown'
        }).catch(() => { });
    }
});

// Balansni yashirish/ko'rsatish va "barchasini ko'rish" tugmalari
bot.action(/walletview_(\d+)_(\d)_(\d)/, async (ctx) => {
    const userId = ctx.from.id;
    if (ctx.match[1] !== userId.toString()) {
        return ctx.answerCbQuery();
    }

    const wallet = state.wallets[userId];
    if (!wallet) {
        return ctx.answerCbQuery();
    }

    const hidden = ctx.match[2] === '1';
    const showAll = ctx.match[3] === '1';

    await ctx.answerCbQuery();
    try {
        const { text, buttons } = await buildWalletView(userId, wallet, hidden, showAll);
        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard(buttons)
        });
    } catch (e) {
        console.error('Hamyon ko\'rinishini yangilashda xatolik:', e.message);
    }
});

// Hamyonni o'zgartirish tugmasi bosilganda — qayta manzil so'raladi
bot.action(/changewallet_(\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    if (ctx.match[1] !== userId.toString()) {
        return ctx.answerCbQuery();
    }
    state.pendingWallet[userId] = true;
    savePersistedState();
    await ctx.answerCbQuery();
    await ctx.replyWithMarkdown(T(userId, 'wallet_ask'), Markup.inlineKeyboard([
        [Markup.button.callback(T(userId, 'delete_btn'), `del_${userId}_askwallet`)]
    ]));
});

// Foydalanuvchi /mywallet bosgan bot xabariga hamyon manzilini reply qilib yuborsa, shu yerda ushlanadi
bot.on('text', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next(); // kanal postlari kabi from'siz xabarlarda xatolik bermasin

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

    // /tr st uz — kanal postlari avtomatik tarjima qilinadigan standart tilni belgilaydi (faqat admin)
    if (parts[1] && parts[1].toLowerCase() === 'st') {
        if (!isAdmin(ctx)) return ctx.reply(T(userId, 'not_admin'));

        const newLang = (parts[2] || '').toLowerCase().trim();
        if (!newLang) return ctx.replyWithMarkdown(T(userId, 'tr_set_usage'));

        state.autoTranslateLang = newLang;
        savePersistedState();
        return ctx.replyWithMarkdown(T(userId, 'tr_set_saved', newLang));
    }

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

    // Standart tarjima tili (/tr st <til> orqali admin tomonidan o'zgartiriladi)
    const targetLang = state.autoTranslateLang || 'uz';

    const result = await translateText(textToTranslate, targetLang);

    // Agar matn allaqachon shu tilda bo'lsa yoki tarjima amalga oshmagan bo'lsa to'xtaymiz
    if (!result || result.detectedLang === targetLang || result.translated === textToTranslate) {
        return;
    }

    // Tarjima qilingan matnni post ostiga reply qilib yuborish (sarlavhasiz, plain matn sifatida —
    // tarjima qilingan matn ichida * _ ` [ kabi belgilar bo'lishi mumkin va Markdown parse xatoligiga
    // olib kelib, xabar yuborilmay qolishiga sabab bo'lishi mumkin edi)
    try {
        await ctx.reply(result.translated, {
            reply_to_message_id: msg.message_id
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

    // Foiz — BARCHA amallar bilan (+, -, *, /), bazasi istalgan matematik ifoda
    // bo'lishi mumkin (qavslar, bir nechta amal bilan ham), ixtiyoriy ravishda
    // natijani boshqa valyuta/kriptoga konvertatsiya qilish bilan birga.
    // Masalan: `148 + 2%`, `1k+23%`, `1k*1%`, `1000/50%`, `(100+50)*10%`,
    // `1k +5% gram uzs` (avval 5% qo'shiladi, keyin GRAM'dan UZS'ga o'tkaziladi)
    const m_percGen = text.match(/^([\d\s\+\-\*\/\(\)\.]+?)\s*([+\-\*\/])\s*(\d+(?:\.\d+)?)\s*%(?:\s+([a-z][a-z0-9]*))?(?:\s+(?:to\s+)?([a-z][a-z0-9]*))?$/);
    if (m_percGen) {
        try {
            const baseExpr = m_percGen[1].trim();
            const op = m_percGen[2];
            const prc = parseFloat(m_percGen[3]);
            const base = math.evaluate(baseExpr);

            let result, calcLine;
            if (op === '+') {
                const multiplier = 1 + prc / 100;
                result = base * multiplier;
                calcLine = `\`${fmt(base)}*${fmt(multiplier)}\``;
            } else if (op === '-') {
                const multiplier = 1 - prc / 100;
                result = base * multiplier;
                calcLine = `\`${fmt(base)}*${fmt(multiplier)}\``;
            } else if (op === '*') {
                const multiplier = prc / 100;
                result = base * multiplier;
                calcLine = `\`${fmt(base)}*${fmt(multiplier)}\``;
            } else { // '/'
                const divisor = prc / 100;
                result = base / divisor;
                calcLine = `\`${fmt(base)}/${fmt(divisor)}\``;
            }

            if (!isFinite(result)) throw new Error('cheksiz natija');

            const fSymRaw = m_percGen[4];
            const tSymRaw = m_percGen[5];

            if (fSymRaw) {
                // Foizdan keyin valyuta/kripto konvertatsiyasi ham so'ralgan
                let fSym = resolveSymbol(fSymRaw);
                let tSym = resolveSymbol(tSymRaw || getUser(ctx.from.id).currency || "USD");

                const fVal = await getVal(fSym);
                const tVal = await getVal(tSym);

                if (fVal && tVal) {
                    const usd = math.multiply(result, fVal);
                    const conv = math.divide(usd, tVal);

                    const header = `🔢 ${calcLine} **= ${fmt(result, fSym)} ${fSym}**`;
                    const resText = `${header}\n🪙 \`${fmt(conv, tSym)} ${tSym}\`\n\n${await getExtras(usd, tSym)}`;

                    return ctx.replyWithMarkdown(resText, {
                        reply_to_message_id: ctx.message.message_id,
                        ...Markup.inlineKeyboard([[Markup.button.callback(T(ctx.from.id, 'delete_btn'), `del_${ctx.from.id}_${ctx.message.message_id}`)]])
                    });
                }
            } else {
                // Valyutasiz — faqat hisoblash natijasi
                const resText = `${calcLine} = \`${fmt(result)}\``;

                return ctx.replyWithMarkdown(resText, {
                    reply_to_message_id: ctx.message.message_id,
                    ...Markup.inlineKeyboard([[Markup.button.callback(T(ctx.from.id, 'delete_btn'), `del_${ctx.from.id}_${ctx.message.message_id}`)]])
                });
            }
        } catch (e) { }
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
    ctx.answerCbQuery().catch(() => { });
    if (ctx.from.id.toString() === ctx.match[1]) ctx.deleteMessage().catch(() => { });
});
// --- 10. SERVER ISHGA TUSHISHI ---
const server = express();
server.get('/', (req, res) => res.send('Not Snap is Live!'));

// Inline rejimdagi svop-kartochka rasmi shu yerdan generatsiya qilinadi.
// Masalan: /inline-card.png?f=TON&fa=1&t=UZS&ta=13205
server.get('/inline-card.png', (req, res) => {
    try {
        const fSym = String(req.query.f || '?').toUpperCase().slice(0, 10);
        const fAmount = String(req.query.fa || '');
        const tSym = String(req.query.t || '?').toUpperCase().slice(0, 10);
        const tAmount = String(req.query.ta || '');

        const buffer = buildSwapCardBuffer(fSym, fAmount, tSym, tAmount);
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=300');
        res.send(buffer);
    } catch (e) {
        console.error('⚠️ Inline kartochka generatsiyasida xatolik:', e.message);
        res.status(500).send('error');
    }
});

server.listen(PORT, () => console.log(`Server portda faol: ${PORT}`));

bot.launch();
