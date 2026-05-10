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

// --- 2. BITGET KRIPTO (TON narxi juda muhim) ---
async function getPrice(symbol) {
    const sym = symbol.toUpperCase();
    try {
        const res = await axios.get(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}USDT`);
        if (res.data.code === '00000' && res.data.data?.[0]) {
            const t = res.data.data[0];
            return { price: parseFloat(t.lastPr), change: parseFloat(t.change24h) * 100 };
        }
    } catch (e) { return null; }
}

// --- 3. FRAGMENT SCRAPER (Stars & Premium) ---
async function fetchFragmentData() {
    try {
        const tonData = await getPrice('TON');
        if (!tonData) return;

        // STARS NARXI
        const starsPage = await axios.get('https://fragment.com/stars/buy?quantity=100', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const $s = cheerio.load(starsPage.data);
        // Fragment narxni ko'pincha .tm-stars-buy-total ichida saqlaydi
        const starsTonRaw = $('.tm-stars-buy-total').first().text() || $('button .tm-button-label').text();
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
            const premTonRaw = $('.tm-stars-buy-total').first().text() || $('.tm-button-label').text();
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
    if (s === "USD") return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return val.toFixed(8).replace(/\.?0+$/, "");
}

async function getVal(s) {
    const sym = s.toUpperCase();
    if (sym === "USD") return 1.0;
    if (sym === "UZS") return 1 / state.uzs;
    if (sym === "RUB") return 1 / state.rub;
    if (sym === "STARS") return state.stars_usd;
    const d = await getPrice(sym);
    return d ? d.price : null;
}

async function getExtras(usdVal, exclude = "") {
    const exc = exclude.toUpperCase();
    const tonD = await getPrice('TON');
    const lines = [];
    if (exc !== "UZS") lines.push(`🇺🇿 \`${fmt(usdVal * state.uzs, 'UZS')} UZS\``);
    if (exc !== "USD") lines.push(`🇺🇸 \`$${fmt(usdVal, 'USD')}\``);
    if (exc !== "RUB") lines.push(`🇷🇺 \`${fmt(usdVal * state.rub, 'RUB')} RUB\``);
    if (exc !== "STARS") lines.push(`⭐ \`${fmt(usdVal / state.stars_usd, 'STARS')} Stars\``);
    if (tonD) lines.push(`💎 \`${(usdVal / tonD.price).toFixed(3)} TON\``);
    return lines.join("\n");
}

// --- 5. BOT HANDLERLARI ---

bot.start((ctx) => ctx.replyWithMarkdown(`👋 **CoinSnap Botga xush kelibsiz!**\n\nBuyruqlar qo'llanmasi: /help`));

bot.help((ctx) => {
    const h = `📖 **Botdan foydalanish:**\n\n` +
        `🔸 **Kripto:** \`1 ton\`, \`1 btc uzs\`, \`1000 not\`\n` +
        `🔸 **Stars:** \`100 stars\`, \`50 stars uzs\`\n` +
        `🔸 **Premium:** \`3 premium\`, \`6 premium uzs\`, \`12 premium\`\n` +
        `🔸 **Komissiya:** \`1000 ton com 5\`\n` +
        `🔸 **Foiz:** \`15000 5%\`\n` +
        `🔸 **Matematika:** \`44*6\`, \`100/4\`\n\n` +
        `⚡️ Kurslar XE.com, Bitget va Fragment-dan real-vaqtda olinadi.`;
    ctx.replyWithMarkdown(h);
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text.toLowerCase().replace(/,/g, '.').trim();

    // A. Premium (masalan: 3 premium uzs)
    const m_prem = text.match(/^(\d+)\s+premium(?:\s+([a-z]+))?$/);
    if (m_prem) {
        const m = parseInt(m_prem[1]);
        const tSym = (m_prem[2] || "USD").toUpperCase();
        if (state.premium[m]) {
            const usdVal = state.premium[m];
            const tVal = await getVal(tSym);
            const resText = `🌟 **Telegram Premium (${m} oy)**\n\n💰 Narxi: \`${fmt(usdVal / tVal, tSym)} ${tSym}\`\n\n${await getExtras(usdVal, tSym)}`;
            return ctx.replyWithMarkdown(resText, Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]]));
        }
    }

    // B. Komissiya (1000 ton com 5)
    const m_com = text.match(/^(\d+(?:\.\d+)?)\s+([a-z0-9]+)\s+com\s+(\d+(?:\.\d+)?)$/);
    if (m_com) {
        const amt = parseFloat(m_com[1]);
        const sym = m_com[2].toUpperCase();
        const prc = parseFloat(m_com[3]);
        const res = amt - (amt * prc / 100);
        const rate = await getVal(sym);
        if (rate) {
            const resText = `⚖️ **Komissiya: ${prc}%**\n\n✅ Qoladi: \`${fmt(res, sym)} ${sym}\`\n\n${await getExtras(res * rate, sym)}`;
            return ctx.replyWithMarkdown(resText, Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]]));
        }
    }

    // C. Foiz (Masalan: 120 45% yoki 15000+500 10%)
    const m_perc = text.match(/^([\d\s\+\-\*\/\(\)\.]+)\s+(\d+(?:\.\d+)?)\s*%$/);
    if (m_perc) {
        try {
            // Birinchi qismni (son yoki amalni) hisoblab olamiz
            const baseText = m_perc[1].trim();
            const base = math.evaluate(baseText);
            const prc = parseFloat(m_perc[2]);

            // Foizni hisoblash (yaxlitlamasdan, boricha)
            const res = math.divide(math.multiply(base, prc), 100);

            const resText = `📊 **${prc}% Hisobi**\n\n` +
                `🔢 Asos: \`${fmt(base)}\`\n` +
                `🎯 Natija (${prc}%): \`${fmt(res)}\`\n` +
                `➕ Jami (+): \`${fmt(math.add(base, res))}\`\n` +
                `➖ Ayirma (-): \`${fmt(math.subtract(base, res))}\``;

            return ctx.replyWithMarkdown(resText,
                Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]])
            );
        } catch (e) {
            console.error("Foiz hisoblashda xato:", e);
        }
    }

    // D & E. Matematika + Konvertatsiya (Birlashtirilgan)
    // 10+10 ton, 5 ton uzs, 5 ton to uzs kabi so'rovlarni hammasini tutadi
    const m_pair = text.match(/^([\d\s\+\-\*\/\(\)\.]+)\s+([a-z][a-z0-9]*)(?:\s+(?:to\s+)?([a-z][a-z0-9]*))?$/);

    if (m_pair) {
        try {
            const expression = m_pair[1].trim();
            const fSym = m_pair[2].toUpperCase();
            const tSym = (m_pair[3] || "USD").toUpperCase();

            // Matematik amal bormi yoki shunchaki sonmi?
            let amt;
            if (/[\+\-\*\/]/.test(expression)) {
                amt = math.evaluate(expression);
            } else {
                amt = parseFloat(expression);
            }

            if (isNaN(amt)) return; // Agar son bo'lmasa to'xtatish

            const fVal = await getVal(fSym);
            const tVal = await getVal(tSym);
            const crypto = await getPrice(fSym);

            if (fVal && tVal) {
                const usd = math.multiply(amt, fVal);
                const res = math.divide(usd, tVal);

                let info = crypto ? `\n${crypto.change >= 0 ? '🟢' : '🔴'} 24s: \`${crypto.change >= 0 ? '+' : ''}${crypto.change.toFixed(2)}%\`` : "";

                // Sarlavha: Agar matematik amal bo'lsa natijani, son bo'lsa o'zini ko'rsatamiz
                const header = /[\+\-\*\/]/.test(expression)
                    ? `🔢 **${expression} = ${fmt(amt, fSym)} ${fSym}**`
                    : `🔄 **${fmt(amt, fSym)} ${fSym}**`;

                const resText = `${header}\n🪙 \`${fmt(res, tSym)} ${tSym}\`${info}\n\n${await getExtras(usd, tSym)}`;

                return ctx.replyWithMarkdown(resText, Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]]));
            }
        } catch (e) {
            console.error("Hisoblashda xato:", e);
        }
    }

    // F. Oddiy Matematika (Valyutasiz: 44*6)
    if (/^[0-9\+\-\*\/\(\)\.\s]+$/.test(text) && /[\+\-\*\/]/.test(text)) {
        try {
            const calc = math.evaluate(text);
            return ctx.replyWithMarkdown(`🔢 \`${text} = ${calc.toLocaleString()}\``, Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]]));
        } catch (e) { }
    }

    // Oddiy Matematika (Valyutasiz bo'lsa)
    if (/^[0-9\+\-\*\/\(\)\.\s]+$/.test(text) && /[\+\-\*\/]/.test(text)) {
        try {
            const calc = math.evaluate(text);
            return ctx.replyWithMarkdown(`\`${text} = ${calc.toLocaleString()}\``, Markup.inlineKeyboard([[Markup.button.callback("🗑 O'chirish", `del_${ctx.from.id}`)]]));
        } catch (e) { }
    }
});

bot.action(/del_(\d+)/, (ctx) => {
    if (ctx.from.id.toString() === ctx.match[1]) ctx.deleteMessage().catch(() => { });
});

const app = express();
app.get('/', (req, res) => res.send('Not Snap is Live!'));
app.listen(PORT);
bot.launch();
