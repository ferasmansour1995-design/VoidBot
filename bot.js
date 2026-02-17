require('dotenv').config();
const { Connection } = require('@solana/web3.js');
const axios = require('axios');

// --- CONFIGURATION ---
const CONFIG = {
    PAPER_MODE: true,
    RPC_URL: process.env.SOLANA_RPC_URL,
    
    // SCANNING
    SCAN_INTERVAL_MS: 60000,   // Scan trending every 60s (was 30s)
    PRICE_CHECK_MS: 5000,      // Check active trade every 5s (was 3s)
    
    // FILTERS (The "Survivor" Logic)
    MIN_LIQUIDITY_USD: 10000,
    MIN_FDV: 50000,
    MIN_PAIR_AGE_HOURS: 1,     // Avoid brand new rugs
    
    // BLACKLIST (Major tokens to skip in favor of memes)
    BLACKLIST: ['SOL', 'USDC', 'USDT', 'MSOL', 'JUP', 'WIF', 'BONK', 'RAY'], 
    
    // TRADING
    BUY_AMOUNT_USD: 3.33,      // 1/3 of Portfolio per trade
    TAKE_PROFIT: 15.0,         // +15%
    STOP_LOSS: 10.0,           // -10%
    SIM_FEE: 0.02
};

// --- STATE ---
let wallet = { usd: 10.00, history: [] };
let activeTrades = []; // Array of { mint, symbol, entryPrice, tokens, startTime }

// --- LOGGING ---
function log(msg, type = 'INFO') {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] [${type}] ${msg}`);
}

// --- SCANNING ---
async function scanForTarget() {
    // Skip scanning if wallet is empty
    if (wallet.usd < CONFIG.BUY_AMOUNT_USD) {
        // log("Wallet below buy threshold. Scanning paused.", 'WAIT');
        return null;
    }

    log("Scanning DexScreener (Multi-Source)...", 'SCAN');
    try {
        // Multi-Source Fetch to ensure we find candidates beyond just major pairs
        const sources = [
            `https://api.dexscreener.com/latest/dex/search/?q=solana`, // General Search
            `https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112`, // WSOL Pairs
            `https://api.dexscreener.com/latest/dex/tokens/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` // USDC Pairs
        ];

        const responses = await Promise.all(sources.map(url => axios.get(url, { timeout: 5000 }).catch(e => ({ data: { pairs: [] } }))));
        
        // Combine and Deduplicate
        const allPairs = responses.flatMap(r => r.data.pairs || []);
        const uniquePairs = Array.from(new Map(allPairs.map(p => [p.pairAddress, p])).values());

        // Apply "Survivor" Filters
        const candidates = uniquePairs.filter(p => {
            const liq = p.liquidity?.usd || 0;
            
            // Determine which side is the target token (not SOL/USDC)
            let targetToken = null;
            if (p.baseToken.symbol === 'SOL' || p.baseToken.symbol === 'USDC' || p.baseToken.symbol === 'USDC.s') {
                targetToken = p.quoteToken; // SOL is base, so target is quote
            } else {
                targetToken = p.baseToken; // SOL is quote, so target is base
            }

            // Simple validation to prevent errors
            if (!targetToken) return false;

            // Avoid buying same token twice
            const alreadyHolding = activeTrades.some(t => t.mint === targetToken.address);
            if (alreadyHolding) return false;

            const isSurvivor = (
                p.chainId === 'solana' &&
                liq >= CONFIG.MIN_LIQUIDITY_USD &&
                !CONFIG.BLACKLIST.includes(targetToken.symbol) &&
                !CONFIG.BLACKLIST.includes(p.baseToken.symbol) // Double check base for safety
            );

            return isSurvivor;
        });

        if (candidates.length === 0) {
            log("No valid candidates found fitting 'Survivor' criteria.", 'WAIT');
            return null;
        }

        // Sort by Volume (Momentum)
        candidates.sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0));
        
        // Pick a random candidate from the Top 3 to add variety (SOL vs Memes)
        const topN = candidates.slice(0, 3);
        const best = topN[Math.floor(Math.random() * topN.length)];
        
        log(`Target Found: ${best.baseToken.symbol} ($${best.priceUsd}) | Vol: $${best.volume.h1}`, 'TARGET');
        return best;

    } catch (e) {
        log(`Scan Error: ${e.message}`, 'ERR');
        return null;
    }
}

// --- TRADING ENGINE ---
async function manageTrades() {
    if (activeTrades.length === 0) return;

    // Process all trades in parallel
    await Promise.all(activeTrades.map(async (trade) => {
        const mint = trade.mint;
        let currentPrice = 0;
        
        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
            const resp = await axios.get(url, { timeout: 5000 });
            
            if (!resp.data.pairs || resp.data.pairs.length === 0) {
                 log(`Price API returned no pairs for mint: ${mint}`, 'ERR');
                 return;
            }
            
            // Get price from the most liquid pair
            const bestPair = resp.data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            currentPrice = parseFloat(bestPair.priceUsd);
            
            log(`${trade.symbol}: $${currentPrice} (Mint: ${trade.mint})`, 'TICK');
            
        } catch (e) {
            log(`Price check failed for ${trade.symbol}: ${e.message}`, 'WARN');
            return;
        }

        if (!currentPrice) return;

        // Calc PnL
        const diff = currentPrice - trade.entryPrice;
        const pnlPercent = (diff / trade.entryPrice) * 100;
        
        // Decision Logic
        if (pnlPercent >= CONFIG.TAKE_PROFIT) {
            await executeSell(trade, currentPrice, "TAKE PROFIT");
        } else if (pnlPercent <= -CONFIG.STOP_LOSS) {
            await executeSell(trade, currentPrice, "STOP LOSS");
        }
    }));
}

async function executeBuy(target) {
    if (wallet.usd < CONFIG.BUY_AMOUNT_USD) {
        log("Wallet insufficient funds.", 'SKIP');
        return;
    }

    const price = parseFloat(target.priceUsd);
    const cost = CONFIG.BUY_AMOUNT_USD;
    const fee = CONFIG.SIM_FEE;
    const net = cost - fee;
    const tokens = net / price;

    wallet.usd -= cost;
    
    const newTrade = {
        mint: target.baseToken.address,
        symbol: target.baseToken.symbol,
        entryPrice: price,
        tokens: tokens,
        startTime: Date.now()
    };

    activeTrades.push(newTrade);

    log(`>>> BUY ${newTrade.symbol} @ $${price} (Mint: ${newTrade.mint})`, 'TRADE');
    log(`    Position: ${tokens.toFixed(2)} tokens`);
    log(`    Wallet: $${wallet.usd.toFixed(2)} (Active Trades: ${activeTrades.length})`, 'CONF');
}

async function executeSell(trade, price, reason) {
    const revenue = trade.tokens * price;
    const fee = CONFIG.SIM_FEE;
    const net = revenue - fee;
    const profit = net - CONFIG.BUY_AMOUNT_USD;

    wallet.usd += net;
    
    log(`<<< SELL ${trade.symbol} @ $${price} (${reason})`, 'TRADE');
    log(`    Result: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
    log(`    Wallet: $${wallet.usd.toFixed(2)}`);

    wallet.history.push({ 
        symbol: trade.symbol, 
        profit: profit, 
        reason: reason 
    });
    
    // Remove from active trades
    activeTrades = activeTrades.filter(t => t.mint !== trade.mint);
}

// --- MAIN LOOP ---
async function run() {
    log("--- HUNTER BOT STARTED ---", 'INIT');
    log(`Strategy: Multi-Slot Survivor Scalp (Liq > $${CONFIG.MIN_LIQUIDITY_USD}, Age > ${CONFIG.MIN_PAIR_AGE_HOURS}h)`, 'CONF');
    log(`Wallet: $${wallet.usd.toFixed(2)}`, 'CONF');

    // Run loops concurrently
    setInterval(async () => {
        const target = await scanForTarget();
        if (target) {
            await executeBuy(target);
        }
    }, CONFIG.SCAN_INTERVAL_MS);

    setInterval(async () => {
        await manageTrades();
    }, CONFIG.PRICE_CHECK_MS);
}

run();
