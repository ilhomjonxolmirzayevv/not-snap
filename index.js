import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import * as math from 'mathjs';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const API_TOKEN = process.env.API_TOKEN || "";
const PORT = process.env.PORT || 5000;
const bot = new Telegraf(API_TOKEN);

const state = {
    uzs: 12850.0,
    rub: 92.5,
    stars_usd: 0.015, // 1 Star ~ $0.015
    premium: { 3: 12.0, 6: 16.0, 12: 29.0 }, // O'rtacha USD narxlar (zaxira)
    last_updated: null
};

// --- 1. XE.COM FIAT ---
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

// --- 2. BITGET KRIPTO ---
async function getPrice(symbol) {
    const sym = symbol.toUpperCase();
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

        // STARS NARXI
        const starsPage = await axios.get('https://fragment.com/stars/buy?quantity=100', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const $s = cheerio.load(starsPage.data);
        const starsTonRaw = $s('.tm-stars-buy-total').first().text() || $s('button .tm-button-label').text();
        const starsTon = parseFloat(starsTonRaw.replace(/[^\d.]/g, ''));

        if (starsTon > 0) {
            state.stars_usd = (starsTon * tonData.price) / 100;
        }

        // PREMIUM NARXLARI (3, 6, 12 oy)
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
        console.log(`Fragment ma'lumotlari yangilandi. TON: $${tonData.price}`);
    } catch (e) {
        console.error("Fragment'dan ma'lumot olishda xato:", e.message);
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
}

setInterval(updateAllRates, 600000); // 10 daqiqada yangilanadi
updateAllRates();

// --- 4. FORMATLASH VA HISOB-KITOB ---
function fmt(val, sym = "") {
    const s = sym.toUpperCase();
    if (s === "UZS" || s === "RUB") return val.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (s === "USDT") return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return val.toFixed(8).replace(/\.?0+$/, "");
}

async function getVal(s) {
    const sym = s.toUpperCase();
    if (sym === "USDT") return 1.0; 
    if (sym === "UZS") return 1 / state.uzs;
    if (sym === "RUB") return 1 / state.rub;
    if (sym === "STARS") return state.stars_usd;
    const d = await getPrice(sym);
    return d ? d.price : null;
}

async function getExtras(usdVal, exclude = "") {
    const exc = exclude.toUpperCase();
    const tonD = await getPrice('TON');
    const gramD = await getPrice('GRAM');
    const lines = [];
    if (exc !== "UZS") lines.push(`🇺🇿 \`${fmt(usdVal * state.uzs, 'UZS')} UZS\``);
    if (exc !== "USDT") lines.push(`🇺🇸 \`$${fmt(usdVal, 'USDT')} USDT\``);
    if (exc !== "RUB") lines.push(`🇷🇺 \`${fmt(usdVal * state.rub, 'RUB')} RUB\``);
    if (exc !== "STARS") lines.push(`⭐ \`${fmt(usdVal / state.stars_usd, 'STARS')} Stars\``);
    if (tonD && exc !== "TON") lines.push(`💎 \`${(usdVal / tonD.price).toFixed(3)} TON\``);
    if (gramD && exc !== "GRAM") lines.push(`💎 \`${(usdVal / gramD.price).toFixed(3)} GRAM\``);
    return lines.join("\n");
}

// === [QO'SHILDI]: OFFLINE PAYTDA YOZILGAN ESKI XABARLARNI INDAMAY SKIP QILISH TIZIMI ===
bot.use(async (ctx, next) => {
    const now = Math.floor(Date.now() / 1000); // Hozirgi vaqt (saniyalarda)
    
    // Agar foydalanuvchidan oddiy xabar kelsa
    if (ctx.message) {
        const msgDate = ctx.message.date;
        // Agar xabar yozilganiga 5 soniyadan ko'p bo'lgan bo'lsa (ya'ni bot o'chgan paytda yozilgan bo'lsa)
        if (now - msgDate > 5) {
            return; // Shunchaki skip - bot indamay to'xtaydi va javob yozmaydi
        }
    }
    
    // Agar inline tugma bosilgan bo'lsa
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        const cbDate = ctx.callbackQuery.message.date;
        if (now - cbDate > 10) { 
            return; // Eski tugmalarni ham indamay tashlab ketadi
        }
    }

    await next(); // Agar xabar yangi (live) holatda kelgan bo'lsa, kod ishlashda davom etadi
});
// ==================================================================================

// --- 5. BOT HANDLERLARI ---
bot.start((ctx) => ctx.replyWithMarkdown(`👋 **CoinSnap Botga xush kelibsiz!**\n\nBuyruqlar qo'llanmasi: /help`));

bot.help((ctx) => {
    const h = `📖 **Botdan foydalanish:**\n\n` +
        `🔸 **Kripto:** \`1 gram\`, \`1 ton uzs\`, \`1000 not usdt\`\n` +
        `🔸 **Stars:** \`100 stars\`, \`50 stars uzs\`\n` +
        `🔸 **Premium:** \`3 premium\`, \`6 premium usdt\`, \`12 premium\`\n` +
        `🔸 **Komissiya:** \`1000 gram com 5\`\n` + 
        `🔸 **Foiz:** \`15000 5%\`\n` +
        `🔸 **Matematika:** \`44*6\`, \`100/4\`\n\n` +
        `⚡️ Kurslar XE.com, Bitget va Fragment-dan real-vaqtda olinadi.`;
    ctx.replyWithMarkdown(h);
});

// --- MAIN HANDLING LOGIC ---
async function handleConversion(ctx) {
    if (!ctx.message || !ctx.message.text || ctx.from?.is_bot) return;

    let text = ctx.message.text.toLowerCase().replace(/,/g, '.').trim();

    // === XATOLIKLARNI TO'G'RILASH VA TON/GRAM, USD/USDT ALOQALARI ===
    text = text.replace(/^(\d+(?:\.\d+)?)\s*(gram|ton|usd|usdt)\d*$/, '$1 $2');

    if (text.includes('ton')) {
        text = text.replace(/\bton\b/g, 'gram');
    }

    if (text.includes('usd') && !text.includes('usdt')) {
        text = text.replace(/\busd\b/g, 'usdt');
    }
    // =======================================================

    // A. Premium
    const m_prem = text.match(/^(\d+)\s+premium(?:\s+([a-z]+))?$/);
    if (m_prem) {
        const m = parseInt(m_prem[1]);
        const tSym = (m_prem[2] || "USDT").toUpperCase();
        if (state.premium[m]) {
            const usdVal = state.premium[m];
            const tVal = await getVal(tSym);
            const resText = `🌟 **Telegram Premium (${m} oy)**\n\n💰 Narxi: \`${fmt(usdVal / tVal, tSym)} ${tSym}\`\n\n${await getExtras(usdVal, tSym)}`;
            return ctx.replyWithMarkdown(resText, {
                reply_to_message_id: ctx.message.message_id,
                ...Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]])
            });
        }
    }

    // B. Komissiya
    const m_com = text.match(/^(\d+(?:\.\d+)?)\s+([a-z0-9]+)\s+com\s+(\d+(?:\.\d+)?)$/);
    if (m_com) {
        const amt = parseFloat(m_com[1]);
        const sym = m_com[2].toUpperCase();
        const prc = parseFloat(m_com[3]);
        const res = amt - (amt * prc / 100);
        const rate = await getVal(sym);
        if (rate) {
            const resText = `⚖️ **Komissiya: ${prc}%**\n\n✅ Qoladi: \`${fmt(res, sym)} ${sym}\`\n\n${await getExtras(res * rate, sym)}`;
            return ctx.replyWithMarkdown(resText, {
                reply_to_message_id: ctx.message.message_id,
                ...Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]])
            });
        }
    }

    // C. Foiz
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
                ...Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]])
            });
        } catch (e) { console.error("Foiz hisoblashda xato:", e); }
    }

    // D & E. Matematika + Konvertatsiya
    const m_pair = text.match(/^([\d\s\+\-\*\/\(\)\.]+)\s+([a-z][a-z0-9]*)(?:\s+(?:to\s+)?([a-z][a-z0-9]*))?$/);
    if (m_pair) {
        try {
            const expression = m_pair[1].trim();
            const fSym = m_pair[2].toUpperCase();
            const tSym = (m_pair[3] || "USDT").toUpperCase();

            let amt = /[\+\-\*\/]/.test(expression) ? math.evaluate(expression) : parseFloat(expression);
            if (amt === null || amt === undefined || isNaN(amt)) return;

            const fVal = await getVal(fSym);
            const tVal = await getVal(tSym);
            const crypto = await getPrice(fSym);

            if (fVal && tVal) {
                const usd = math.multiply(amt, fVal);
                const res = math.divide(usd, tVal);
                let info = crypto && fSym !== "USDT" ? `\n${crypto.change >= 0 ? '🟢' : '🔴'} 24s: \`${crypto.change >= 0 ? '+' : ''}${crypto.change.toFixed(2)}%\`` : "";

                const isMath = /[\+\-\*\/]/.test(expression);
                const header = isMath ? `🔢 \`${expression}\` **= ${fmt(amt, fSym)} ${fSym}**` : `🔄 **${fmt(amt, fSym)} ${fSym}**`;
                const resText = `${header}\n🪙 \`${fmt(res, tSym)} ${tSym}\`${info}\n\n${await getExtras(usd, tSym)}`;

                return ctx.replyWithMarkdown(resText, {
                    reply_to_message_id: ctx.message.message_id,
                    ...Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]])
                });
            }
        } catch (e) { console.error("Hisoblash xatosi:", e.message); }
    }

    // Oddiy Matematika (Valyutasiz)
    if (/^[0-9\+\-\*\/\(\)\.\s]+$/.test(text) && /[\+\-\*\/]/.test(text)) {
        try {
            const calc = math.evaluate(text);
            return ctx.replyWithMarkdown(`\`${text} = ${calc.toLocaleString()}\``, {
                reply_to_message_id: ctx.message.message_id,
                ...Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]])
            });
        } catch (e) { }
    }
}

bot.on('text', (ctx) => handleConversion(ctx));

bot.action(/del_(\d+)/, (ctx) => {
    if (ctx.from.id.toString() === ctx.match[1]) ctx.deleteMessage().catch(() => { });
});

const server = express();
server.get('/', (req, res) => res.send('Not Snap is Live!'));
server.listen(PORT);
bot.launch();
