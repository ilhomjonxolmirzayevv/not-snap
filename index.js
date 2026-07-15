import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import * as math from 'mathjs';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const API_TOKEN = process.env.API_TOKEN || "";
const PORT = process.env.PORT || 5000;

// Agar muhit o'zgaruvchilarida domen bo'lsa ishlatiladi, aks holda dinamik aniqlanadi
let APP_URL = process.env.APP_URL || ""; 

const bot = new Telegraf(API_TOKEN);

// Keshlar va sozlamalar uchun in-memory xotira
const state = {
    uzs: 12850.0,
    rub: 92.5,
    stars_usd: 0.015, 
    premium: { 3: 12.0, 6: 16.0, 12: 29.0 }, 
    last_updated: null,
    alerts: []
};

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

// --- 3. FRAGMENT SCRAPER ---
async function fetchFragmentData() {
    try {
        const tonData = await getPrice('TON');
        if (!tonData) return;

        // STARS
        const starsPage = await axios.get('https://fragment.com/stars/buy?quantity=100', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $s = cheerio.load(starsPage.data);
        const starsTonRaw = $s('.tm-stars-buy-total').first().text() || $s('button .tm-button-label').text();
        const starsTon = parseFloat(starsTonRaw.replace(/[^\d.]/g, '')); 

        // PREMIUM
        const months = [3, 6, 12];
        for (const m of months) {
            const premPage = await axios.get(`https://fragment.com/premium/gift?months=${m}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const $p = cheerio.load(premPage.data);
            const premTonRaw = $p('.tm-stars-buy-total').first().text() || $p('.tm-button-label').text();
            const premTon = parseFloat(premTonRaw.replace(/[^\d.]/g, ''));

            if (premTon > 0) {
                state.premium[m] = premTon * tonData.price;
            }
        }
    } catch (e) {
        console.error("Fragment xatosi:", e.message);
    }
}

async function updateAllRates() {
    console.log("Kurslar yangilanmoqda...");
    const xeUzs = await fetchXERate("USD", "UZS");
    const xeRub = await fetchXERate("USD", "RUB");
    if (xeUzs) state.uzs = xeUzs;
    if (xeRub) state.rub = xeRub;

    await fetchFragmentData();
    state.last_updated = new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });

    await checkAlerts();
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

async function getVal(s) {
    let sym = s.toUpperCase();
    
    if (sym === "USD" || sym === "USDT") sym = "USDT";
    if (sym === "GRAM" || sym === "TON") {
        const tonD = await getPrice('TON');
        return tonD ? tonD.price : null;
    }

    if (sym === "USDT") return 1.0;
    if (sym === "UZS") return 1 / state.uzs;
    if (sym === "RUB") return 1 / state.rub;
    if (sym === "STARS") return state.stars_usd;
    
    const d = await getPrice(sym);
    return d ? d.price : null;
}

async function getExtras(usdVal, exclude = "") {
    let exc = exclude.toUpperCase();
    if (exc === "USD" || exc === "USDT") exc = "USD";
    if (exc === "GRAM" || exc === "TON") exc = "GRAM";

    const tonD = await getPrice('TON');
    const lines = [];
    
    if (exc !== "UZS") lines.push(`🇺🇿 \`${fmt(usdVal * state.uzs, 'UZS')} UZS\``);
    if (exc !== "RUB") lines.push(`🇷🇺 \`${fmt(usdVal * state.rub, 'RUB')} RUB\``);
    if (exc !== "STARS") lines.push(`⭐ \`${fmt(usdVal / state.stars_usd, 'STARS')} Stars\``);
    
    if (exc !== "USD") lines.push(`💎 \`$${fmt(usdVal, 'USD')} USD\``);
    if (tonD && exc !== "GRAM") lines.push(`💎 \`${(usdVal / tonD.price).toFixed(3)} GRAM\``);
    
    return lines.join("\n");
}

function getCryptoAdvice(change) {
    let advice = "";
    if (change > 8) {
        advice = "📈 **Tahliliy Tavsiya:** Bozorda kuchli o'sish tendensiyasi kuzatilmoqda. Hozirda qisman foyda realizatsiya qilish (sotish) yoki trend barqarorlashguncha kutish oqilona bo'lishi mumkin.";
    } else if (change > 1 && change <= 8) {
        advice = "🟢 **Tahliliy Tavsiya:** Aktiv mo'tadil o'sishda. Agar uzoq muddatli investor bo'lsangiz, ushlab turish (HODL) maqsadga muvofiq.";
    } else if (change < -8) {
        advice = "🔴 **Tahliliy Tavsiya:** Keskin tushish kuzatildi. Agar fundamental ishonchingiz yuqori bo'lsa, past narxlarda sotib olish (DCA) uchun qulay fursat bo'lishi mumkin. Lekin ehtiyot bo'ling!";
    } else if (change < 0 && change >= -8) {
        advice = "📉 **Tahliliy Tavsiya:** Kichik korreksiya holati. Sarosimaga tushib sotib yuborish tavsiya etilmaydi, narx qayta tiklanishini kutish ma'qul.";
    } else {
        advice = "🟡 **Tahliliy Tavsiya:** Bozor passiv holatda (Flat). Bu paytda kutish va bozordagi keyingi harakatni kuzatish eng xavfsiz yo'ldir.";
    }
    return advice + "\n*(Bu ma'lumot faqat tahliliy tavsiya bo'lib, moliyaviy maslahat hisoblanmaydi!)*";
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
bot.start((ctx) => ctx.replyWithMarkdown(`👋 **CoinSnap Botga xush kelibsiz!**\n\nBuyruqlar qo'llanmasi: /help`));

bot.help((ctx) => {
    const h = `📖 **Botdan foydalanish:**\n\n` +
        `🔸 **Kripto (TON va Gram teng):** \`1 gram\`, \`1 ton uzs\`, \`1000 not usd\`\n` +
        `🔸 **Stars:** \`100 stars\`, \`50 stars uzs\`\n` +
        `🔸 **Premium:** \`3 premium\`, \`6 premium usd\`, \`12 premium\`\n` +
        `🔸 **Komissiya:** \`1000 gram com 5\`\n` + 
        `🔸 **Foiz:** \`15000 5%\`\n` +
        `🔸 **Matematika:** \`44*6\`, \`100/4\`\n\n` +
        `🚨 **Narxga alert qo'yish imkoniyati:**\n` +
        `🔸 \`/alert gram 7.5\`\n` +
        `*(Faqat bitta son yozsangiz GRAM deb hisoblanadi: \`/alert 20\`)*\n\n` +
        `⚡️ Kurslar XE.com, Bitget va Fragment-dan real-vaqtda olinadi.`;
    ctx.replyWithMarkdown(h);
});

// --- 6. INLINE MODE (RASMLI KARTA CHIQARISH) ---
bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query.trim().toLowerCase();
    if (!query) return;

    const match = query.match(/^([\d\s\+\-\*\/\(\)\.]+)\s+([a-z][a-z0-9]*)(?:\s+(?:to\s+)?([a-z][a-z0-9]*))?$/);
    if (!match) return;

    try {
        const expression = match[1].trim();
        let fSym = match[2].toUpperCase();
        let tSym = (match[3] || "USD").toUpperCase();

        if (fSym === "TON") fSym = "GRAM";
        if (fSym === "USDT") fSym = "USD";
        if (tSym === "TON") tSym = "GRAM";
        if (tSym === "USDT") tSym = "USD";

        let amt = /[\+\-\*\/]/.test(expression) ? math.evaluate(expression) : parseFloat(expression);
        if (isNaN(amt)) return;

        const fVal = await getVal(fSym);
        const tVal = await getVal(tSym);
        
        if (fVal && tVal) {
            const usd = math.multiply(amt, fVal);
            const res = math.divide(usd, tVal);

            // Agar APP_URL konfiguratsiya qilinmagan bo'lsa, xost nomini dinamik olishga harakat qilamiz
            const baseDomain = APP_URL || "https://sizning-bot-domeningiz.render.com";
            
            // Telegram keshlab olmasligi uchun unikal timestamp qo'shamiz
            const ts = Date.now();
            const cardImageUrl = `${baseDomain}/generate-card?amt=${encodeURIComponent(fmt(amt, fSym))}&from=${fSym}&to=${tSym}&res=${encodeURIComponent(fmt(res, tSym))}&v=${ts}`;

            return ctx.answerInlineQuery([{
                type: 'photo',
                id: `convert_${ts}`,
                title: `${fmt(amt, fSym)} ${fSym} = ${fmt(res, tSym)} ${tSym}`,
                description: "Rasmli chiroyli karta ko'rinishida yuborish",
                photo_url: cardImageUrl,
                thumbnail_url: cardImageUrl,
                input_message_content: {
                    message_text: `🪙 **${fmt(amt, fSym)} ${fSym} = ${fmt(res, tSym)} ${tSym}**`,
                    parse_mode: 'Markdown'
                }
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
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
        return ctx.replyWithMarkdown("⚠️ Format: `/alert gram 7.5` yoki `/alert 20` ");
    }
    
    let token = 'GRAM';
    let targetPrice;

    if (parts.length === 2) {
        targetPrice = parseFloat(parts[1]);
    } else if (parts.length >= 3) {
        token = parts[1].toUpperCase();
        targetPrice = parseFloat(parts[2]);
    }

    if (token === "TON") token = "GRAM";
    if (token === "USDT") token = "USD";

    if (isNaN(targetPrice)) return ctx.reply("Iltimos to'g'ri son kiriting.");

    const currentPrice = await getVal(token);
    if (!currentPrice) return ctx.reply(`⚠️ ${token} narxini aniqlab bo'lmadi.`);

    const direction = currentPrice <= targetPrice ? 'UP' : 'DOWN';

    state.alerts.push({
        chatId: ctx.chat.id,
        username: ctx.from.username ? `@${ctx.from.username}` : `User_${ctx.from.id}`,
        token,
        targetPrice,
        direction
    });

    const dirMsg = direction === 'UP' ? "oshganda" : "tushganda";
    ctx.replyWithMarkdown(`🚨 **Alert muvaffaqiyatli saqlandi!**\n**${token}** narxi **$${targetPrice}** qiymatga ${dirMsg} sizga xabar beramiz.`);
});

// --- 8. MATNLARNI QAYTA ISHLASH (MAIN HANDLER) ---
async function handleConversion(ctx) {
    if (!ctx.message || !ctx.message.text || ctx.from?.is_bot) return;

    let text = ctx.message.text.toLowerCase().replace(/,/g, '.').trim();

    // Gram va USD o'zgartirishlarini aniq regex bilan bajarish (yopishib qolmasligi uchun)
    text = text.replace(/\bton\b/g, 'gram');
    text = text.replace(/\busdt\b/g, 'usd');

    // Premium hisob-kitobi
    const m_prem = text.match(/^(\d+)\s+premium(?:\s+([a-z]+))?$/);
    if (m_prem) {
        const m = parseInt(m_prem[1]);
        let tSym = (m_prem[2] || "USD").toUpperCase();
        if (tSym === "USDT") tSym = "USD";
        if (tSym === "TON") tSym = "GRAM";

        if (state.premium[m]) {
            const usdVal = state.premium[m];
            const tVal = await getVal(tSym);
            const resText = `🌟 **Telegram Premium (${m} oy)**\n\n💰 Narxi: \`${fmt(usdVal / tVal, tSym)} ${tSym}\`\n\n${await getExtras(usdVal, tSym)}`;
            return ctx.replyWithMarkdown(resText, {
                reply_to_message_id: ctx.message.message_id,
                ...Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}_${ctx.message.message_id}`)]])
            });
        }
    }

    // Komissiya hisob-kitobi
    const m_com = text.match(/^(\d+(?:\.\d+)?)\s+([a-z0-9]+)\s+com\s+(\d+(?:\.\d+)?)$/);
    if (m_com) {
        const amt = parseFloat(m_com[1]);
        let sym = m_com[2].toUpperCase();
        if (sym === "TON") sym = "GRAM";
        if (sym === "USDT") sym = "USD";

        const prc = parseFloat(m_com[3]);
        const res = amt - (amt * prc / 100);
        const rate = await getVal(sym);
        if (rate) {
            const resText = `⚖️ **Komissiya: ${prc}%**\n\n✅ Qoladi: \`${fmt(res, sym)} ${sym}\`\n\n${await getExtras(res * rate, sym)}`;
            return ctx.replyWithMarkdown(resText, {
                reply_to_message_id: ctx.message.message_id,
                ...Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}_${ctx.message.message_id}`)]])
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

            const resText = `📊 **${prc}% Hisobi**\n\n` +
                `🔢 Asos: \`${fmt(base)}\`\n` +
                `🎯 Natija (${prc}%): \`${fmt(res)}\`\n` +
                `➕ Jami (+): \`${fmt(math.add(base, res))}\`\n` +
                `➖ Ayirma (-): \`${fmt(math.subtract(base, res))}\``;

            return ctx.replyWithMarkdown(resText, {
                reply_to_message_id: ctx.message.message_id,
                ...Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}_${ctx.message.message_id}`)]])
            });
        } catch (e) { }
    }

    // Matematika va Kurs Konvertatsiyasi
    const m_pair = text.match(/^([\d\s\+\-\*\/\(\)\.]+)\s+([a-z][a-z0-9]*)(?:\s+(?:to\s+)?([a-z][a-z0-9]*))?$/);
    if (m_pair) {
        try {
            const expression = m_pair[1].trim();
            let fSym = m_pair[2].toUpperCase();
            let tSym = (m_pair[3] || "USD").toUpperCase();

            if (fSym === "TON") fSym = "GRAM";
            if (fSym === "USDT") fSym = "USD";
            if (tSym === "TON") tSym = "GRAM";
            if (tSym === "USDT") tSym = "USD";

            let amt = /[\+\-\*\/]/.test(expression) ? math.evaluate(expression) : parseFloat(expression);
            if (isNaN(amt)) return;

            const fVal = await getVal(fSym);
            const tVal = await getVal(tSym);
            const crypto = await getPrice(fSym);

            if (fVal && tVal) {
                const usd = math.multiply(amt, fVal);
                const res = math.divide(usd, tVal);
                let info = crypto && fSym !== "USD" ? `\n${crypto.change >= 0 ? '🟢' : '🔴'} 24s: \`${crypto.change >= 0 ? '+' : ''}${crypto.change.toFixed(2)}%\`` : "";

                let adviceText = crypto && fSym !== "USD" ? `\n\n${getCryptoAdvice(crypto.change)}` : "";
                const isMath = /[\+\-\*\/]/.test(expression);
                const header = isMath ? `🔢 \`${expression}\` **= ${fmt(amt, fSym)} ${fSym}**` : `🔄 **${fmt(amt, fSym)} ${fSym}**`;
                
                const resText = `${header}\n🪙 \`${fmt(res, tSym)} ${tSym}\`${info}\n\n${await getExtras(usd, tSym)}${adviceText}`;

                return ctx.replyWithMarkdown(resText, {
                    reply_to_message_id: ctx.message.message_id,
                    ...Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}_${ctx.message.message_id}`)]])
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
                ...Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}_${ctx.message.message_id}`)]])
            });
        } catch (e) { }
    }
}

bot.on('text', (ctx) => handleConversion(ctx));

// --- 9. MUKAMMAL O'CHIRISH (DELETE) ---
bot.action(/del_(\d+)_(\d+)/, async (ctx) => {
    const creatorId = ctx.match[1];
    const triggerMessageId = parseInt(ctx.match[2]);
    const clickedUserId = ctx.from.id.toString();

    if (clickedUserId !== creatorId) {
        return ctx.answerCallbackQuery({
            text: "⚠️ Bu natijani faqat uni so'ragan foydalanuvchi o'chira oladi!",
            show_alert: true
        }).catch(() => {});
    }

    try {
        await ctx.answerCallbackQuery({ text: "Tozalanmoqda..." }).catch(() => {});
        await ctx.deleteMessage().catch(() => {});
        if (triggerMessageId) {
            await ctx.telegram.deleteMessage(ctx.chat.id, triggerMessageId).catch(() => {});
        }
    } catch (e) { }
});

// --- 10. DINAMIK PNG / SVG KARTA GENERATORI ---
const server = express();

server.get('/generate-card', (req, res) => {
    // Agar bot.env ichida APP_URL belgilanmagan bo'lsa, xostni so'rovdan dinamik aniqlaymiz
    if (!APP_URL && req.headers.host) {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        APP_URL = `${protocol}://${req.headers.host}`;
    }

    const amt = req.query.amt || "1";
    const from = (req.query.from || "GRAM").toUpperCase();
    const to = (req.query.to || "UZS").toUpperCase();
    const resultVal = req.query.res || "0";

    // Kiruvchi belgilar
    let fromIcon = `<path d="M 25 5 L 45 20 L 25 45 L 5 20 Z" fill="#3b9df8"/><path d="M 25 5 L 35 20 L 25 45 L 15 20 Z" fill="#76beff"/><polygon points="25,5 25,45 25,20" stroke="#ffffff" stroke-width="1" opacity="0.3"/>`;
    if (from === "UZS") {
        fromIcon = `<circle cx="25" cy="25" r="22" fill="#a0a5ab"/><text x="25" y="31" font-family="Arial, sans-serif" font-size="15" font-weight="bold" fill="#ffffff" text-anchor="middle">сўм</text>`;
    } else if (from === "USD" || from === "USDT") {
        fromIcon = `<circle cx="25" cy="25" r="22" fill="#2ecc71"/><text x="25" y="32" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#ffffff" text-anchor="middle">$</text>`;
    }

    // Chiquvchi belgilar
    let toIcon = `<circle cx="25" cy="25" r="22" fill="#a0a5ab"/><text x="25" y="31" font-family="Arial, sans-serif" font-size="15" font-weight="bold" fill="#ffffff" text-anchor="middle">сўм</text>`;
    if (to === "GRAM" || to === "TON") {
        toIcon = `<g transform="translate(0, 0)"><path d="M 25 5 L 45 20 L 25 45 L 5 20 Z" fill="#3b9df8"/><path d="M 25 5 L 35 20 L 25 45 L 15 20 Z" fill="#76beff"/><polygon points="25,5 25,45 25,20" stroke="#ffffff" stroke-width="1" opacity="0.3"/></g>`;
    } else if (to === "USD" || to === "USDT") {
        toIcon = `<circle cx="25" cy="25" r="22" fill="#2ecc71"/><text x="25" y="32" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#ffffff" text-anchor="middle">$</text>`;
    }

    // SVG tuzilmasi
    const svg = `
    <svg width="600" height="400" viewBox="0 0 600 400" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1e355e" />
          <stop offset="100%" stop-color="#0f1a30" />
        </linearGradient>
        <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
          <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.3"/>
        </filter>
      </defs>
      
      <rect width="600" height="400" rx="16" fill="url(#bgGrad)"/>
      <rect x="50" y="50" width="500" height="300" rx="36" fill="#ffffff" filter="url(#shadow)"/>
      
      <!-- Birinchi qator -->
      <g transform="translate(90, 100)">${fromIcon}</g>
      <text x="160" y="135" font-family="Arial, sans-serif" font-size="28" font-weight="900" fill="#000000" letter-spacing="1">${from}</text>
      <text x="510" y="135" font-family="Arial, sans-serif" font-size="32" font-weight="800" fill="#000000" text-anchor="end">${amt}</text>
      
      <!-- O'tish chizig'i -->
      <line x1="90" y1="200" x2="510" y2="200" stroke="#e0e6ed" stroke-width="2"/>
      <circle cx="300" cy="200" r="22" fill="#d9ebff"/>
      <g transform="translate(300, 200) scale(1.1)">
        <path d="M -4 -8 L -4 8 M -7 -3 L -4 -8 L -1 -3" fill="none" stroke="#3b9df8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M 4 8 L 4 -8 M 1 3 L 4 8 L 7 3" fill="none" stroke="#3b9df8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      
      <!-- Ikkinchi qator -->
      <g transform="translate(90, 240)">${toIcon}</g>
      <text x="160" y="275" font-family="Arial, sans-serif" font-size="28" font-weight="900" fill="#000000" letter-spacing="1">${to}</text>
      <text x="510" y="275" font-family="Arial, sans-serif" font-size="32" font-weight="800" fill="#000000" text-anchor="end">${resultVal}</text>
    </svg>`;

    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
});

server.get('/', (req, res) => res.send('CoinSnap is Live!'));
server.listen(PORT, () => console.log(`Server portda faol: ${PORT}`));

bot.launch();
