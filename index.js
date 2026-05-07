import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import * as math from 'mathjs';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

// --- Konfiguratsiya ---
const API_TOKEN = process.env.API_TOKEN || "";
const PORT = process.env.PORT || 5000;
const bot = new Telegraf(API_TOKEN);

const state = {
    uzs: 12850.0,
    rub: 92.5,
    last_updated: null
};

// --- XE.com dan kursni olish (Eng aniq manba) ---
async function fetchXERate(from, to) {
    try {
        const url = `https://www.xe.com/currencyconverter/convert/?Amount=1&From=${from}&To=${to}`;
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        // Kursni sahifa ichidan qidirib topish
        const regex = new RegExp(`1 ${from} = ([0-9,.]+) ${to}`, 'i');
        const match = data.match(regex);
        
        if (match && match[1]) {
            return parseFloat(match[1].replace(/,/g, ''));
        }

        // Zaxira usul: JSON strukturasidan qidirish
        const secondMatch = data.match(new RegExp(`${to}":([\d.]+)`, 'i'));
        if (secondMatch && secondMatch[1]) {
            return parseFloat(secondMatch[1]);
        }

        return null;
    } catch (e) {
        console.error(`XE.com [${from}/${to}] xatosi:`, e.message);
        return null;
    }
}

// Kurslarni har 5 daqiqada yangilab turish
async function updateFiatRates() {
    console.log("Kurslar XE.com dan yangilanmoqda...");
    const xeUzs = await fetchXERate("USD", "UZS");
    const xeRub = await fetchXERate("USD", "RUB");

    if (xeUzs) state.uzs = xeUzs;
    if (xeRub) state.rub = xeRub;

    state.last_updated = new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
    console.log(`Yangilandi: 1$ = ${state.uzs} UZS, 1$ = ${state.rub} RUB (${state.last_updated})`);
}

setInterval(updateFiatRates, 300000); 
updateFiatRates();

// --- Bitget Birjasidan Kripto Narxlarni Olish ---
async function getBitgetPrice(symbol) {
    const url = `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${symbol.toUpperCase()}USDT`;
    try {
        const resp = await axios.get(url);
        if (resp.data.code === '00000' && resp.data.data?.[0]) {
            const ticker = resp.data.data[0];
            return {
                price: parseFloat(ticker.lastPr),
                change: parseFloat(ticker.change24h) * 100
            };
        }
    } catch (e) {
        console.warn(`Bitget error [${symbol}]:`, e.message);
    }
    return null;
}

// --- Sonlarni Formatlash ---
function fmt(value, symbol = "") {
    const s = symbol.toUpperCase();
    if (s === "UZS" || s === "RUB") {
        return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
    } else if (s === "USD") {
        return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else {
        let formatted = value.toFixed(8).replace(/\.?0+$/, "");
        if (formatted.includes(".")) {
            const [intPart, decPart] = formatted.split(".");
            return `${parseInt(intPart).toLocaleString()}.${decPart}`;
        }
        return parseInt(formatted).toLocaleString();
    }
}

function fmtResult(value) {
    if (value === Math.floor(value) && Math.abs(value) < 1e15) {
        return value.toLocaleString();
    }
    return fmt(value);
}

// --- Qo'shimcha valyutalar ro'yxatini shakllantirish ---
async function getExtras(usdVal, exclude = "") {
    const exc = exclude.toUpperCase();
    const tonData = await getBitgetPrice('TON');
    const btcData = await getBitgetPrice('BTC');
    const tonP = tonData?.price || 1;
    const btcP = btcData?.price || 1;

    const lines = [];
    if (exc !== "UZS") lines.push(`🇺🇿 \`${fmt(usdVal * state.uzs, 'UZS')} UZS\``);
    if (exc !== "USD") lines.push(`🇺🇸 \`$${fmt(usdVal, 'USD')} USD\``);
    if (exc !== "RUB") lines.push(`🇷🇺 \`${fmt(usdVal * state.rub, 'RUB')} RUB\``);
    if (exc !== "TON") lines.push(`💎 \`${fmt(usdVal / tonP, 'TON')} TON\``);
    if (exc !== "BTC") lines.push(`₿ \`${fmt(usdVal / btcP, 'BTC')} BTC\``);
    return lines.join("\n");
}

async function getVal(s) {
    const sym = s.toUpperCase();
    if (sym === "USD") return 1.0;
    if (sym === "UZS") return 1 / state.uzs;
    if (sym === "RUB") return 1 / state.rub;
    const d = await getBitgetPrice(sym);
    return d ? d.price : null;
}

// --- Tugmalar (Ustun shaklida) ---
function getReplyButtons(userId, symbol = null) {
    const buttons = [];
    if (symbol && !["UZS", "RUB", "USD"].includes(symbol.toUpperCase())) {
        buttons.push([Markup.button.url(`📈 ${symbol.toUpperCase()}/USDT (Bitget)`, `https://www.bitget.com/spot/${symbol.toUpperCase()}USDT`)]);
    }
    buttons.push([Markup.button.url("📊 XE.com Jonli Kurslar", `https://www.xe.com/currencyconverter/convert/?Amount=1&From=USD&To=UZS`)]);
    buttons.push([Markup.button.callback("🗑 O'chirish", `del_${userId}`)]);
    return Markup.inlineKeyboard(buttons);
}

// --- Bot Handlerlari ---

bot.start((ctx) => ctx.replyWithMarkdown(`👋 **CoinSnap botiga xush kelibsiz!**\n\nXE.com va Bitget kurslari asosida ishlayman.`));

bot.command('coins', async (ctx) => {
    const listCoins = ["BTC", "ETH", "TON", "SOL", "NOT"];
    let resText = "📊 **Jonli Narxlar:**\n\n";
    for (const c of listCoins) {
        const data = await getBitgetPrice(c);
        if (data) {
            const arrow = data.change >= 0 ? "🟢" : "🔴";
            resText += `${arrow} **${c}**: \`$${fmt(data.price, 'USD')}\` (${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}%)\n`;
        }
    }
    await ctx.replyWithMarkdown(resText, getReplyButtons(ctx.from.id));
});

bot.on('text', async (ctx) => {
    const text = ctx.message.text.toLowerCase().replace(/,/g, '.').trim();
    if (text === 'coins') return bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/coins' } });

    const num_p = "(\\d+(?:\\.\\d+)?)";
    const sym_p = "([a-z][a-z0-9]*)";
    const re_com = new RegExp(`^${num_p}\\s+${sym_p}\\s+com\\s+${num_p}$`);
    const re_uzs = new RegExp(`^${num_p}\\s+uzs\\s+${sym_p}$`);
    const re_pair = new RegExp(`^${num_p}\\s+${sym_p}\\s+${sym_p}$`);
    const re_single = new RegExp(`^${num_p}\\s+${sym_p}$`);
    const math_pattern = /^([\d\s\+\-\*\/\(\)\.]+)\s+([a-z][a-z0-9]*)$/;
    const has_op = /[\+\-\*\/]/;

    let resText = "";
    let currentSymbol = null;

    // 1. Matematik Amallar (masalan: 100+50 ton)
    const m_math_sym = text.match(math_pattern);
    if (m_math_sym && has_op.test(m_math_sym[1])) {
        try {
            const calc = math.evaluate(m_math_sym[1]);
            const symbol = m_math_sym[2].toUpperCase();
            const val = await getVal(symbol);
            if (val !== null) {
                const totalUsd = calc * val;
                const extras = await getExtras(totalUsd, symbol);
                resText = `🔢 \`${m_math_sym[1].trim()} = ${fmtResult(calc)} ${symbol}\`\n\n🪙 **${fmtResult(calc)} ${symbol}**\n\n${extras}`;
                currentSymbol = symbol;
            }
        } catch (e) { return; }
    }

    // 2. Komissiya (masalan: 1000 ton com 5)
    const m_com = text.match(re_com);
    if (m_com && !resText) {
        const amount = parseFloat(m_com[1]);
        const symbol = m_com[2].toUpperCase();
        const perc = parseFloat(m_com[3]);
        const result = amount - (amount * perc / 100);
        const rate = await getVal(symbol);
        const totalUsd = result * (rate || 0);
        const extras = await getExtras(totalUsd, symbol);
        resText = `⚖️ **Komissiya: ${perc}%**\n\n✅ **Qoladi: \`${fmt(result, symbol)} ${symbol}\`**\n\n${extras}`;
        currentSymbol = symbol;
    }

    // 3. UZS dan Kriptoga (masalan: 1000000 uzs ton)
    const m_uzs = text.match(re_uzs);
    if (m_uzs && !resText) {
        const uzsAmount = parseFloat(m_uzs[1]);
        const symbol = m_uzs[2].toUpperCase();
        const price = await getVal(symbol);
        if (price) {
            const amountUsd = uzsAmount / state.uzs;
            const extras = await getExtras(amountUsd, symbol);
            resText = `💰 **${fmt(uzsAmount, 'UZS')} UZS** ➡️ **${symbol}**\n\n🪙 \`${fmt(amountUsd / price, symbol)} ${symbol}\`\n\n${extras}`;
            currentSymbol = symbol;
        }
    }

    // 4. Juftliklar yoki Yagona (masalan: 1 btc uzs yoki 1 btc)
    const m_pair = text.match(re_pair) || text.match(re_single);
    if (m_pair && !resText) {
        const amount = parseFloat(m_pair[1]);
        const fSym = m_pair[2].toUpperCase();
        const tSym = m_pair[3]?.toUpperCase() || "USD";
        const vFrom = await getVal(fSym);
        const vTo = await getVal(tSym);
        if (vFrom && vTo) {
            const totalUsd = amount * vFrom;
            const final = totalUsd / vTo;
            const extras = await getExtras(totalUsd, tSym === "USD" ? fSym : tSym);
            resText = tSym === "USD" 
                ? `🪙 **${fmt(amount, fSym)} ${fSym}**\n\n${extras}`
                : `🔄 **${fmt(amount, fSym)} ${fSym}** ➡️ **${tSym}**\n\n🪙 \`${fmt(final, tSym)} ${tSym}\`\n\n${extras}`;
            currentSymbol = tSym === "USD" ? fSym : tSym;
        }
    }

    if (resText) {
        await ctx.replyWithMarkdown(resText, getReplyButtons(ctx.from.id, currentSymbol));
    }
});

bot.action(/del_(\d+)/, async (ctx) => {
    if (ctx.from.id.toString() === ctx.match[1]) await ctx.deleteMessage().catch(() => {});
    else await ctx.answerCbQuery("Faqat egasi o'chira oladi!");
});

// Render uchun Server
const app = express();
app.get('/', (req, res) => res.send('CoinSnap Bot is Running! Source: XE.com'));
app.listen(PORT, () => console.log(`Server: ${PORT}`));

bot.launch();