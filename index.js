import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import * as math from 'mathjs';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const API_TOKEN = process.env.API_TOKEN || "";
const PORT = process.env.PORT || 5000;

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
    aliases: { 'ton': 'gram', 'somsa': 'gram' }   // taxallus -> asosiy belgi (admin tomonidan boshqariladi)
};

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
            `🌐 /language — til tanlash`,
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
        alias_list_empty: "📋 Hozircha taxalluslar yo'q."
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
            `🌐 /language — выбор языка`,
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
        alias_list_empty: "📋 Псевдонимов пока нет."
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
            `🌐 /language — choose language`,
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
        alias_list_empty: "📋 No aliases yet."
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
    ctx.answerCbQuery();
    ctx.editMessageText(T(userId, 'language_set'), { parse_mode: 'Markdown' });
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
    ctx.replyWithMarkdown(T(userId, 'alias_removed', alias));
});

bot.command(['aliases', 'taxalluslar'], (ctx) => {
    const userId = ctx.from.id;
    const entries = Object.entries(state.aliases);
    if (entries.length === 0) return ctx.reply(T(userId, 'alias_list_empty'));

    const list = entries.map(([a, t]) => `\`${a}\` → **${t.toUpperCase()}**`).join('\n');
    ctx.replyWithMarkdown(`${T(userId, 'alias_list_title')}\n\n${list}`);
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
