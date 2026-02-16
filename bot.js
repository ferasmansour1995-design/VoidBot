require('dotenv').config();
const { Connection } = require('@solana/web3.js');
const axios = require('axios');

// --- CONFIGURATION ---
const CONFIG = {
    PAPER_MODE: true,
    RPC_URL: process.env.SOLANA_RPC_URL,
    
    // SCANNING
    SCAN_INTERVAL_MS: 30000,   // Scan trending every 30s
    PRICE_CHECK_MS: 3000,      // Check active trade every 3s
    
    // FILTERS (The "Survivor" Logic)
    MIN_LIQUIDITY_USD: 10000,
    MIN_FDV: 50000,
    MIN_PAIR_AGE_HOURS: 1,     // Avoid brand new rugs
    
    // TRADING
    BUY_AMOUNT_USD: 3.33,      // 1/3 of Portfolio per trade
    TAKE_PROFIT: 15.0,         // +15%
    STOP_LOSS: 10.0,           // -10%
    SIM_FEE: 0.02
};

// --- STATE ---
let wallet = { usd: 10.00, history: [] };
let activeTrade = null; // { mint, symbol, entryPrice, tokens }

// --- LOGGING ---
function log(msg, type = 'INFO') {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] [${type}] ${msg}`);
}

// --- SCANNING ---
async function scanForTarget() {
    log("Scanning DexScreener Trending...", 'SCAN');
    try {
        // Fetch Trending Pairs
        const url = `https://api.dexscreener.com/latest/dex/search?q=solana`;
        const resp = await axios.get(url, { timeout: 5000 });
        const pairs = resp.data.pairs || [];

        // Apply "Survivor" Filters
        const candidates = pairs.filter(p => {
            const liq = p.liquidity?.usd || 0;
            const fdv = p.fdv || 0;
            const ageHours = (Date.now() - p.pairCreatedAt) / (1000 * 60 * 60);
            
            // DEBUG: Log first pair to see data structure
            if (pairs.indexOf(p) === 0) {
                 log(`DEBUG Sample: ${p.baseToken.symbol} | Liq: $${liq} | Age: ${ageHours.toFixed(2)}h | Created: ${p.pairCreatedAt}`, 'DEBUG');
            }

            return (
                p.chainId === 'solana' &&
                p.quoteToken.symbol === 'SOL' &&
                liq >= CONFIG.MIN_LIQUIDITY_USD &&
                fdv >= CONFIG.MIN_FDV &&
                ageHours >= CONFIG.MIN_PAIR_AGE_HOURS
            );
        });

        if (candidates.length === 0) {
            log("No valid candidates found fitting 'Survivor' criteria.", 'WAIT');
            return null;
        }

        // Sort by Volume (Momentum)
        candidates.sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0));
        
        const best = candidates[0];
        log(`Target Found: ${best.baseToken.symbol} ($${best.priceUsd}) | Vol: $${best.volume.h1}`, 'TARGET');
        return best;

    } catch (e) {
        log(`Scan Error: ${e.message}`, 'ERR');
        return null;
    }
}

// --- TRADING ENGINE ---
async function manageTrade() {
    // 1. Get Live Price
    const mint = activeTrade.mint;
    let currentPrice = 0;
    
    try {
        // Jup v2 Price API
        const url = `https://api.jup.ag/price/v2?ids=${mint}`;
        const resp = await axios.get(url);
        currentPrice = parseFloat(resp.data.data[mint].price);
    } catch (e) {
        log(`Price check failed for ${activeTrade.symbol}, skipping tick.`, 'WARN');
        return;
    }

    if (!currentPrice) return;

    // 2. Calc PnL
    const diff = currentPrice - activeTrade.entryPrice;
    const pnlPercent = (diff / activeTrade.entryPrice) * 100;
    
    // log(`${activeTrade.symbol}: $${currentPrice} (PnL: ${pnlPercent.toFixed(2)}%)`);

    // 3. Decision Logic
    if (pnlPercent >= CONFIG.TAKE_PROFIT) {
        await executeSell(currentPrice, "TAKE PROFIT");
    } else if (pnlPercent <= -CONFIG.STOP_LOSS) {
        await executeSell(currentPrice, "STOP LOSS");
    }
}

async function executeBuy(target) {
    if (wallet.usd < CONFIG.BUY_AMOUNT_USD) {
        log("Wallet empty. Game Over.", 'END');
        process.exit(0);
    }

    const price = parseFloat(target.priceUsd);
    const cost = CONFIG.BUY_AMOUNT_USD;
    const fee = CONFIG.SIM_FEE;
    const net = cost - fee;
    const tokens = net / price;

    wallet.usd -= cost;
    
    activeTrade = {
        mint: target.baseToken.address,
        symbol: target.baseToken.symbol,
        entryPrice: price,
        tokens: tokens,
        startTime: Date.now()
    };

    log(`>>> BUY ${activeTrade.symbol} @ $${price}`, 'TRADE');
    log(`    Position: ${tokens.toFixed(2)} tokens`);
}

async function executeSell(price, reason) {
    const revenue = activeTrade.tokens * price;
    const fee = CONFIG.SIM_FEE;
    const net = revenue - fee;
    const profit = net - CONFIG.BUY_AMOUNT_USD;

    wallet.usd += net;
    
    log(`<<< SELL ${activeTrade.symbol} @ $${price} (${reason})`, 'TRADE');
    log(`    Result: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
    log(`    Wallet: $${wallet.usd.toFixed(2)}`);

    wallet.history.push({ 
        symbol: activeTrade.symbol, 
        profit: profit, 
        reason: reason 
    });
    
    activeTrade = null; // Resume Scanning
}

// --- MAIN LOOP ---
async function run() {
    log("--- HUNTER BOT STARTED ---", 'INIT');
    log(`Strategy: Survivor Scalp (Liq > $${CONFIG.MIN_LIQUIDITY_USD}, Age > ${CONFIG.MIN_PAIR_AGE_HOURS}h)`, 'CONF');
    log(`Wallet: $${wallet.usd.toFixed(2)}`, 'CONF');

    while(true) {
        if (!activeTrade) {
            // HUNT MODE
            const target = await scanForTarget();
            if (target) {
                // In a real bot, we might wait for a dip here.
                // For this simulation, we enter the best momentum candidate immediately.
                await executeBuy(target);
            } else {
                await new Promise(r => setTimeout(r, CONFIG.SCAN_INTERVAL_MS));
            }
        } else {
            // MANAGE MODE
            await manageTrade();
            await new Promise(r => setTimeout(r, CONFIG.PRICE_CHECK_MS));
        }
    }
}

run();
